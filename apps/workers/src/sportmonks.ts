import {
  GameEvent,
  LiveCardSummary,
  LiveLineupPlayer,
  LiveLineupTeam,
  LiveMatchState,
  LiveMatchStatus,
  LiveTeam,
  LiveTeamStat,
  LiveSubstitution,
  TeamSide,
  createEmptyLiveMatchState,
} from '@sports-copilot/shared-types';

const SPORTMONKS_BASE_URL =
  process.env.SPORTMONKS_BASE_URL ?? 'https://api.sportmonks.com/v3/football';

const CORE_INCLUDES = [
  'state',
  'participants',
  'scores',
  'events.type',
  'lineups.player',
  'lineups.position',
  'statistics.type',
].join(';');

export interface SportmonksClientConfig {
  apiToken: string;
  fixtureId: string;
  fetchImpl?: typeof fetch;
}

interface SportmonksParticipant {
  id?: number | string;
  name?: string;
  image_path?: string | null;
  meta?: {
    location?: 'home' | 'away';
  };
  short_code?: string | null;
  abbreviation?: string | null;
}

interface SportmonksScore {
  participant_id?: number | string;
  score?: {
    goals?: number;
    participant?: 'home' | 'away';
  };
  description?: string;
}

interface SportmonksEvent {
  id?: number | string;
  participant_id?: number | string;
  minute?: number;
  extra_minute?: number | null;
  result?: string | null;
  player_name?: string | null;
  related_player_name?: string | null;
  info?: string | null;
  addition?: string | null;
  type?: {
    developer_name?: string | null;
    name?: string | null;
  };
}

interface SportmonksLineup {
  id?: number | string;
  participant_id?: number | string;
  player_id?: number | string;
  jersey_number?: number | null;
  formation_position?: number | string | null;
  formation_field?: string | null;
  type_id?: number | null;
  player_name?: string | null;
  player?: {
    id?: number | string;
    display_name?: string | null;
    common_name?: string | null;
    firstname?: string | null;
    lastname?: string | null;
  };
  position?: {
    name?: string | null;
    developer_name?: string | null;
  };
  formation?: {
    formation?: string | null;
  };
}

interface SportmonksStatistic {
  participant_id?: number | string;
  data?: {
    value?: number | string | null;
  };
  value?: number | string | null;
  type?: {
    developer_name?: string | null;
    name?: string | null;
  };
}

interface SportmonksState {
  state?: string | null;
  developer_name?: string | null;
  short_name?: string | null;
  name?: string | null;
}

interface SportmonksFixtureResponse {
  data?: {
    id?: number | string;
    name?: string;
    starting_at?: string;
    state?: SportmonksState | null;
    participants?: SportmonksParticipant[];
    scores?: SportmonksScore[];
    events?: SportmonksEvent[];
    lineups?: SportmonksLineup[];
    statistics?: SportmonksStatistic[];
    periods?: Array<{
      type?: string;
      started?: string | null;
      ended?: string | null;
    }>;
  };
}

export interface NormalizedSportmonksSnapshot {
  liveMatch: LiveMatchState;
  events: GameEvent[];
  score: {
    home: number;
    away: number;
  };
}

function asString(value: unknown) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value);
}

function asNullableString(value: unknown) {
  const stringValue = asString(value).trim();
  return stringValue.length > 0 ? stringValue : null;
}

function asNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeShortCode(teamName: string, fallback: string) {
  const safeFallback = fallback.trim().toUpperCase();
  if (safeFallback) {
    return safeFallback;
  }

  return teamName
    .split(/\s+/)
    .map((token) => token[0] ?? '')
    .join('')
    .slice(0, 3)
    .toUpperCase();
}

function toClock(minute: number, stoppageMinute: number | null) {
  const safeMinute = Math.max(0, Math.floor(minute));
  const baseMinutes = Math.floor(safeMinute / 60);
  const seconds = safeMinute % 60;
  const normalClock = `${String(baseMinutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  if (stoppageMinute && stoppageMinute > 0) {
    return `${normalClock}+${stoppageMinute}`;
  }

  return normalClock;
}

function mapStatus(state?: SportmonksState | null): LiveMatchStatus {
  const value = `${state?.developer_name ?? ''} ${state?.state ?? ''} ${state?.short_name ?? ''} ${
    state?.name ?? ''
  }`
    .toLowerCase()
    .trim();

  if (!value) {
    return 'unknown';
  }
  if (value.includes('not_started') || value.includes('ns')) {
    return 'not_started';
  }
  if (value.includes('halftime') || value.includes('ht')) {
    return 'halftime';
  }
  if (value.includes('finished') || value.includes('full') || value.includes('ft')) {
    return 'full_time';
  }
  if (value.includes('postponed')) {
    return 'postponed';
  }
  if (value.includes('cancelled')) {
    return 'cancelled';
  }
  if (value.includes('paused') || value.includes('interrupted')) {
    return 'paused';
  }
  if (value.includes('inplay') || value.includes('live') || value.includes('1st') || value.includes('2nd')) {
    return 'live';
  }

  return 'unknown';
}

function getTeamSide(
  participantId: string,
  participantsById: Map<string, SportmonksParticipant>,
): TeamSide {
  const participant = participantsById.get(participantId);
  const location = participant?.meta?.location;

  if (location === 'home') {
    return 'home';
  }
  if (location === 'away') {
    return 'away';
  }

  return 'neutral';
}

function buildTeams(participants: SportmonksParticipant[]) {
  const homeParticipant =
    participants.find((participant) => participant.meta?.location === 'home') ?? participants[0];
  const awayParticipant =
    participants.find((participant) => participant.meta?.location === 'away') ?? participants[1];

  const toTeam = (participant: SportmonksParticipant | undefined, fallbackName: string, fallbackCode: string): LiveTeam => ({
    id: asString(participant?.id || fallbackCode.toLowerCase()),
    name: participant?.name?.trim() || fallbackName,
    shortCode: normalizeShortCode(
      participant?.name?.trim() || fallbackName,
      participant?.short_code ?? participant?.abbreviation ?? fallbackCode,
    ),
    logoUrl: participant?.image_path ?? null,
  });

  return {
    homeTeam: toTeam(homeParticipant, 'Home', 'HOM'),
    awayTeam: toTeam(awayParticipant, 'Away', 'AWY'),
  };
}

function buildScore(scores: SportmonksScore[], participantsById: Map<string, SportmonksParticipant>) {
  return scores.reduce(
    (accumulator, score) => {
      const participantId = asString(score.participant_id);
      const side =
        score.score?.participant ?? getTeamSide(participantId, participantsById);
      const goals = asNumber(score.score?.goals, 0);

      if (side === 'home') {
        accumulator.home = Math.max(accumulator.home, goals);
      }
      if (side === 'away') {
        accumulator.away = Math.max(accumulator.away, goals);
      }

      return accumulator;
    },
    { home: 0, away: 0 },
  );
}

function normalizeLineupPlayer(lineup: SportmonksLineup): LiveLineupPlayer {
  const playerName =
    lineup.player_name ??
    lineup.player?.display_name ??
    lineup.player?.common_name ??
    [lineup.player?.firstname, lineup.player?.lastname].filter(Boolean).join(' ') ??
    'Unknown player';

  return {
    id: asString(lineup.player_id ?? lineup.player?.id ?? lineup.id ?? playerName),
    name: playerName,
    number: lineup.jersey_number ?? null,
    position: lineup.position?.name ?? lineup.position?.developer_name ?? null,
    formationPosition:
      asNullableString(lineup.formation_field) ?? asNullableString(lineup.formation_position),
    starter: lineup.type_id === 11 || lineup.type_id === 1 || lineup.type_id === null,
  };
}

function buildLineups(
  lineups: SportmonksLineup[],
  participantsById: Map<string, SportmonksParticipant>,
  teams: { homeTeam: LiveTeam; awayTeam: LiveTeam },
): LiveLineupTeam[] {
  const buckets = new Map<TeamSide, SportmonksLineup[]>();

  for (const lineup of lineups) {
    const participantId = asString(lineup.participant_id);
    const teamSide = getTeamSide(participantId, participantsById);
    const current = buckets.get(teamSide) ?? [];
    current.push(lineup);
    buckets.set(teamSide, current);
  }

  return (['home', 'away'] as const).map((teamSide) => {
    const bucket = buckets.get(teamSide) ?? [];
    const team = teamSide === 'home' ? teams.homeTeam : teams.awayTeam;
    const players = bucket.map(normalizeLineupPlayer);

    return {
      teamSide,
      teamId: team.id,
      teamName: team.name,
      formation: bucket.find((lineup) => lineup.formation?.formation)?.formation?.formation ?? null,
      startingXI: players.filter((player) => player.starter).slice(0, 11),
      bench: players.filter((player) => !player.starter),
    };
  });
}

function buildCards(
  events: SportmonksEvent[],
  participantsById: Map<string, SportmonksParticipant>,
): LiveCardSummary[] {
  const summary: Record<'home' | 'away', LiveCardSummary> = {
    home: { teamSide: 'home', yellow: 0, red: 0 },
    away: { teamSide: 'away', yellow: 0, red: 0 },
  };

  for (const event of events) {
    const eventType = (event.type?.developer_name ?? event.type?.name ?? '').toLowerCase();
    const side = getTeamSide(asString(event.participant_id), participantsById);

    if (side !== 'home' && side !== 'away') {
      continue;
    }

    if (eventType.includes('yellow')) {
      summary[side].yellow += 1;
    }
    if (eventType.includes('red')) {
      summary[side].red += 1;
    }
  }

  return [summary.home, summary.away];
}

function buildSubstitutions(
  events: SportmonksEvent[],
  participantsById: Map<string, SportmonksParticipant>,
): LiveSubstitution[] {
  return events
    .filter((event) => {
      const eventType = (event.type?.developer_name ?? event.type?.name ?? '').toLowerCase();
      return eventType.includes('substitution');
    })
    .map((event, index) => {
      const minute = asNumber(event.minute, 0);
      const extraMinute = event.extra_minute ?? null;
      const matchTime = toClock(minute, extraMinute);

      return {
        id: asString(event.id ?? `sub-${index}`),
        timestamp: minute * 60_000,
        matchTime,
        teamSide: getTeamSide(asString(event.participant_id), participantsById),
        playerOff: event.player_name ?? 'Player off',
        playerOn: event.related_player_name ?? event.addition ?? 'Player on',
      };
    });
}

function buildStats(
  statistics: SportmonksStatistic[],
  participantsById: Map<string, SportmonksParticipant>,
): LiveTeamStat[] {
  return statistics.flatMap((statistic) => {
      const participantId = asString(statistic.participant_id);
      const side = getTeamSide(participantId, participantsById);
      const label =
        statistic.type?.name?.trim() ||
        statistic.type?.developer_name?.replace(/_/g, ' ').trim() ||
        '';
      const value = statistic.data?.value ?? statistic.value;

      if ((side !== 'home' && side !== 'away') || !label) {
        return [];
      }

      return [{
        teamSide: side,
        label,
        value: asString(value),
      } satisfies LiveTeamStat];
    });
}

function normalizeEventType(event: SportmonksEvent) {
  return (event.type?.developer_name ?? event.type?.name ?? 'EVENT')
    .replace(/\s+/g, '_')
    .toUpperCase();
}

function isHighSalience(eventType: string) {
  return ['GOAL', 'PENALTY', 'RED_CARD', 'VAR', 'SHOT_ON_TARGET', 'SAVE', 'SUBSTITUTION'].some(
    (token) => eventType.includes(token),
  );
}

function describeEvent(
  event: SportmonksEvent,
  eventType: string,
  participantsById: Map<string, SportmonksParticipant>,
) {
  const playerName = event.player_name?.trim();
  const relatedPlayerName = event.related_player_name?.trim();
  const side = getTeamSide(asString(event.participant_id), participantsById);
  const teamName =
    side === 'home'
      ? participantsById.get(asString(event.participant_id))?.name ?? 'Home side'
      : side === 'away'
        ? participantsById.get(asString(event.participant_id))?.name ?? 'Away side'
        : 'Match';
  const minute = asNumber(event.minute, 0);

  switch (eventType) {
    case 'GOAL':
      return `${playerName ?? teamName} scores for ${teamName} at ${minute}'.`;
    case 'YELLOWCARD':
    case 'YELLOW_CARD':
      return `${playerName ?? teamName} goes into the book for ${teamName}.`;
    case 'REDCARD':
    case 'RED_CARD':
      return `${playerName ?? teamName} is sent off for ${teamName}.`;
    case 'SUBSTITUTION':
      return `${teamName} bring on ${relatedPlayerName ?? 'a substitute'} for ${playerName ?? 'a teammate'}.`;
    case 'SHOT_ON_TARGET':
      return `${playerName ?? teamName} tests the keeper for ${teamName}.`;
    case 'SAVE':
      return `${playerName ?? 'The keeper'} makes the save.`;
    default:
      return `${teamName}: ${eventType.replace(/_/g, ' ').toLowerCase()}.`;
  }
}

function normalizeEvents(
  events: SportmonksEvent[],
  participantsById: Map<string, SportmonksParticipant>,
): GameEvent[] {
  return events
    .map((event, index) => {
      const minute = asNumber(event.minute, 0);
      const extraMinute = event.extra_minute ?? null;
      const type = normalizeEventType(event);
      const side = getTeamSide(asString(event.participant_id), participantsById);

      return {
        id: asString(event.id ?? `event-${index}`),
        provider: 'sportmonks',
        providerEventId: asString(event.id ?? `event-${index}`),
        timestamp: minute * 60_000,
        matchTime: toClock(minute, extraMinute),
        type,
        teamSide: side,
        description: describeEvent(event, type, participantsById),
        highSalience: isHighSalience(type),
        data: {
          participantId: asString(event.participant_id),
          player: event.player_name ?? undefined,
          relatedPlayer: event.related_player_name ?? undefined,
          minute,
          extraMinute,
          team: side === 'home' ? 'HOME' : side === 'away' ? 'AWAY' : undefined,
        },
      } satisfies GameEvent;
    })
    .sort((left, right) => left.timestamp - right.timestamp);
}

function inferPeriod(status: LiveMatchStatus, minute: number) {
  if (status === 'halftime') {
    return 'Halftime';
  }
  if (status === 'full_time') {
    return 'Full Time';
  }
  if (status === 'not_started') {
    return 'Pre-match';
  }
  if (minute >= 46) {
    return 'Second Half';
  }
  if (minute > 0) {
    return 'First Half';
  }

  return null;
}

function extractMinute(events: SportmonksEvent[]) {
  const latestMinute = events.reduce((maxMinute, event) => Math.max(maxMinute, asNumber(event.minute, 0)), 0);
  const latestExtra = events.reduce(
    (maxExtra, event) => Math.max(maxExtra, asNumber(event.extra_minute, 0)),
    0,
  );

  return {
    minute: latestMinute,
    stoppageMinute: latestExtra > 0 ? latestExtra : null,
  };
}

export async function fetchSportmonksFixture(config: SportmonksClientConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const url = new URL(`${SPORTMONKS_BASE_URL}/fixtures/${config.fixtureId}`);
  url.searchParams.set('api_token', config.apiToken);
  url.searchParams.set('include', CORE_INCLUDES);

  const response = await fetchImpl(url.toString(), {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Sportmonks request failed with ${response.status}`);
  }

  return (await response.json()) as SportmonksFixtureResponse;
}

export function normalizeSportmonksFixture(
  payload: SportmonksFixtureResponse,
  fixtureIdOverride?: string,
): NormalizedSportmonksSnapshot {
  const fixture = payload.data ?? {};
  const participants = fixture.participants ?? [];
  const participantsById = new Map(
    participants.map((participant) => [asString(participant.id), participant] as const),
  );
  const teams = buildTeams(participants);
  const scores = buildScore(fixture.scores ?? [], participantsById);
  const minuteState = extractMinute(fixture.events ?? []);
  const status = mapStatus(fixture.state);
  const liveMatch: LiveMatchState = {
    ...createEmptyLiveMatchState(),
    provider: 'sportmonks',
    fixtureId: fixtureIdOverride ?? asString(fixture.id),
    status,
    period: inferPeriod(status, minuteState.minute),
    minute: minuteState.minute,
    stoppageMinute: minuteState.stoppageMinute,
    lastUpdatedAt: Date.now(),
    homeTeam: teams.homeTeam,
    awayTeam: teams.awayTeam,
    lineups: buildLineups(fixture.lineups ?? [], participantsById, teams),
    cards: buildCards(fixture.events ?? [], participantsById),
    substitutions: buildSubstitutions(fixture.events ?? [], participantsById),
    stats: buildStats(fixture.statistics ?? [], participantsById),
  };

  const events = normalizeEvents(fixture.events ?? [], participantsById);

  return {
    liveMatch,
    events,
    score: scores,
  };
}

export function buildLiveGameStateSummary(params: {
  liveMatch: LiveMatchState;
  events: GameEvent[];
  score: { home: number; away: number };
}) {
  const { liveMatch, events, score } = params;
  const latestEvent = events[events.length - 1];

  if (liveMatch.isDegraded && liveMatch.degradedReason) {
    return liveMatch.degradedReason;
  }

  if (latestEvent?.highSalience) {
    return latestEvent.description;
  }

  if (liveMatch.status === 'not_started') {
    return `${liveMatch.homeTeam.name} vs ${liveMatch.awayTeam.name} is waiting for kickoff.`;
  }

  if (liveMatch.status === 'halftime') {
    return `${liveMatch.homeTeam.name} and ${liveMatch.awayTeam.name} head into halftime at ${score.home}-${score.away}.`;
  }

  if (liveMatch.status === 'full_time') {
    return `${liveMatch.homeTeam.name} and ${liveMatch.awayTeam.name} finish ${score.home}-${score.away}.`;
  }

  return `${liveMatch.homeTeam.name} and ${liveMatch.awayTeam.name} are live at ${score.home}-${score.away}.`;
}

export function buildPossessionLabel(liveMatch: LiveMatchState, stats: LiveTeamStat[]) {
  const possessionStats = stats.filter((stat) => stat.label.toLowerCase().includes('possession'));
  if (possessionStats.length === 0) {
    return liveMatch.minute >= 46 ? liveMatch.awayTeam.shortCode : liveMatch.homeTeam.shortCode;
  }

  const normalized = possessionStats.map((stat) => ({
    side: stat.teamSide,
    value: asNumber(String(stat.value).replace('%', ''), 0),
  }));
  const leader = normalized.sort((left, right) => right.value - left.value)[0];

  if (!leader) {
    return liveMatch.homeTeam.shortCode;
  }

  return leader.side === 'home' ? liveMatch.homeTeam.shortCode : liveMatch.awayTeam.shortCode;
}

export function buildRosterFromLiveMatch(liveMatch: LiveMatchState) {
  const toRoster = (teamSide: TeamSide, team: LiveTeam) => {
    const lineup = liveMatch.lineups.find((entry) => entry.teamSide === teamSide);
    const players = [...(lineup?.startingXI ?? []), ...(lineup?.bench ?? [])];

    return {
      name: team.name,
      shortName: team.shortCode,
      roster: players.map((player) => ({
        id: player.id,
        name: player.name,
        number: player.number ?? 0,
        position: player.position ?? 'N/A',
      })),
    };
  };

  return {
    home: toRoster('home', liveMatch.homeTeam),
    away: toRoster('away', liveMatch.awayTeam),
  };
}
