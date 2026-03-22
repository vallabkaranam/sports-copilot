import {
  MatchResult,
  PreMatchState,
  RecentMatchSummary,
  TeamRecentForm,
  createEmptyPreMatchState,
} from '@sports-copilot/shared-types';

const SPORTMONKS_BASE_URL = 'https://api.sportmonks.com/v3/football';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_PREMATCH_MODEL = 'gpt-5.4-mini';

const FIXTURE_PREMATCH_INCLUDES = ['participants', 'venue'].join(';');
const TEAM_FIXTURE_INCLUDES = ['participants', 'scores', 'state'].join(';');

interface BuilderConfig {
  apiToken: string;
  fixtureId: string;
  openAiApiKey?: string;
  openAiModel?: string;
  fetchImpl?: typeof fetch;
}

interface SportmonksParticipant {
  id?: number | string;
  name?: string;
  meta?: {
    location?: 'home' | 'away';
    winner?: boolean | null;
  };
}

interface SportmonksScore {
  participant_id?: number | string;
  score?: {
    goals?: number;
    participant?: 'home' | 'away';
  };
  description?: string;
}

interface SportmonksFixtureRecord {
  id?: number | string;
  name?: string;
  starting_at?: string;
  participants?: SportmonksParticipant[];
  scores?: SportmonksScore[];
  venue?: {
    id?: number | string;
    name?: string | null;
    city_name?: string | null;
    city?: string | null;
    country_name?: string | null;
    country?: string | null;
    capacity?: number | null;
    surface?: string | null;
    latitude?: number | string | null;
    longitude?: number | string | null;
  } | null;
  weatherreport?:
    | {
        desc?: string | null;
        description?: string | null;
        temperature?: {
          temp?: number | string | null;
        } | null;
        temperature_celcius?: number | string | null;
        wind?: {
          speed?: number | string | null;
        } | null;
        wind_speed?: number | string | null;
        precipitation?: number | string | null;
      }
    | null;
  weather_report?: {
    desc?: string | null;
    description?: string | null;
    temperature?: {
      temp?: number | string | null;
    } | null;
    temperature_celcius?: number | string | null;
    wind?: {
      speed?: number | string | null;
    } | null;
    wind_speed?: number | string | null;
    precipitation?: number | string | null;
  } | null;
}

interface SportmonksSingleFixtureResponse {
  data?: SportmonksFixtureRecord;
}

interface SportmonksFixtureListResponse {
  data?: SportmonksFixtureRecord[];
}

interface OpenMeteoResponse {
  current?: {
    temperature_2m?: number;
    precipitation?: number;
    wind_speed_10m?: number;
    weather_code?: number;
  };
}

function asString(value: unknown) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value);
}

function asNullableString(value: unknown) {
  const normalized = asString(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function asNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildSportmonksUrl(pathname: string, apiToken: string, include?: string) {
  const url = new URL(`${SPORTMONKS_BASE_URL}${pathname}`);
  url.searchParams.set('api_token', apiToken);
  if (include) {
    url.searchParams.set('include', include);
  }
  url.searchParams.set('per_page', '50');
  return url;
}

async function fetchJson<T>(input: string, fetchImpl: typeof fetch) {
  const response = await fetchImpl(input, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

function resolveParticipants(fixture: SportmonksFixtureRecord) {
  const participants = fixture.participants ?? [];
  const home = participants.find((participant) => participant.meta?.location === 'home') ?? participants[0];
  const away = participants.find((participant) => participant.meta?.location === 'away') ?? participants[1];

  return {
    home,
    away,
  };
}

function parseFixtureDate(startingAt: string | undefined) {
  const parsed = startingAt ? new Date(startingAt.replace(' ', 'T') + 'Z') : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function buildDateRange(anchor: Date) {
  const end = new Date(anchor);
  end.setUTCDate(end.getUTCDate() + 1);

  const start = new Date(anchor);
  start.setUTCDate(start.getUTCDate() - 365);

  return {
    start: formatDate(start),
    end: formatDate(end),
  };
}

function getGoalsForSide(
  scores: SportmonksScore[],
  participantId: string,
  side: 'home' | 'away',
) {
  const exact = scores.find(
    (score) =>
      asString(score.participant_id) === participantId &&
      (score.description === 'CURRENT' || score.score?.participant === side),
  );
  if (exact?.score?.goals !== undefined) {
    return Number(exact.score.goals) || 0;
  }

  const sideScore = scores.find(
    (score) => score.description === 'CURRENT' && score.score?.participant === side,
  );

  return sideScore?.score?.goals !== undefined ? Number(sideScore.score.goals) || 0 : 0;
}

function inferMatchResult(scoreFor: number, scoreAgainst: number): MatchResult {
  if (scoreFor > scoreAgainst) {
    return 'win';
  }
  if (scoreFor < scoreAgainst) {
    return 'loss';
  }
  if (scoreFor === scoreAgainst) {
    return 'draw';
  }

  return 'unknown';
}

function normalizeRecentMatch(
  fixture: SportmonksFixtureRecord,
  teamId: string,
  teamName: string,
): RecentMatchSummary | null {
  const participants = fixture.participants ?? [];
  const subject = participants.find((participant) => asString(participant.id) === teamId);
  if (!subject) {
    return null;
  }

  const opponent = participants.find((participant) => asString(participant.id) !== teamId);
  const side =
    subject.meta?.location === 'home'
      ? 'home'
      : subject.meta?.location === 'away'
        ? 'away'
        : 'neutral';
  const scores = fixture.scores ?? [];
  const scoreFor = getGoalsForSide(scores, teamId, side === 'away' ? 'away' : 'home');
  const scoreAgainst = getGoalsForSide(
    scores,
    asString(opponent?.id),
    side === 'away' ? 'home' : 'away',
  );

  return {
    fixtureId: asString(fixture.id),
    kickoffAt: fixture.starting_at ?? '',
    opponent: opponent?.name?.trim() || `Opponent of ${teamName}`,
    venue: side,
    scoreFor,
    scoreAgainst,
    result: inferMatchResult(scoreFor, scoreAgainst),
  };
}

function buildRecentForm(teamSide: 'home' | 'away', teamName: string, matches: RecentMatchSummary[]): TeamRecentForm {
  const record = matches.reduce(
    (accumulator, match) => {
      if (match.result === 'win') {
        accumulator.wins += 1;
      } else if (match.result === 'draw') {
        accumulator.draws += 1;
      } else if (match.result === 'loss') {
        accumulator.losses += 1;
      }

      return accumulator;
    },
    { wins: 0, draws: 0, losses: 0 },
  );

  return {
    teamSide,
    teamName,
    record,
    lastFive: matches,
  };
}

function formatRecentForm(form: TeamRecentForm) {
  return `${form.teamName} ${form.record.wins}-${form.record.draws}-${form.record.losses} in the last ${form.lastFive.length}`;
}

function summarizeHeadToHead(
  meetings: RecentMatchSummary[],
  homeTeamName: string,
  awayTeamName: string,
) {
  const counters = meetings.reduce(
    (accumulator, meeting) => {
      if (meeting.result === 'win') {
        accumulator.homeWins += 1;
      } else if (meeting.result === 'loss') {
        accumulator.awayWins += 1;
      } else if (meeting.result === 'draw') {
        accumulator.draws += 1;
      }
      return accumulator;
    },
    { homeWins: 0, awayWins: 0, draws: 0 },
  );

  const summary =
    meetings.length === 0
      ? `No recent ${homeTeamName} vs ${awayTeamName} meetings were found in the accessible history.`
      : `${homeTeamName} lead the last ${meetings.length} meetings ${counters.homeWins}-${counters.awayWins} with ${counters.draws} draws.`;

  return {
    meetings,
    homeWins: counters.homeWins,
    awayWins: counters.awayWins,
    draws: counters.draws,
    summary,
  };
}

function describeWeatherCode(code?: number) {
  switch (code) {
    case 0:
      return 'Clear skies';
    case 1:
    case 2:
    case 3:
      return 'Partly cloudy';
    case 45:
    case 48:
      return 'Foggy';
    case 51:
    case 53:
    case 55:
    case 61:
    case 63:
    case 65:
      return 'Rain expected';
    case 71:
    case 73:
    case 75:
      return 'Snow in the area';
    case 95:
    case 96:
    case 99:
      return 'Thunderstorms nearby';
    default:
      return 'Weather update available';
  }
}

function buildDeterministicOpener(preMatch: Omit<PreMatchState, 'aiOpener'>) {
  const weatherLine = preMatch.weather
    ? `${preMatch.weather.summary}${preMatch.weather.temperatureC !== null ? `, ${Math.round(preMatch.weather.temperatureC)}C` : ''}.`
    : 'Weather is unavailable for this session.';

  return [
    `${formatRecentForm(preMatch.homeRecentForm)}; ${formatRecentForm(preMatch.awayRecentForm)}.`,
    preMatch.headToHead.summary,
    `${preMatch.venue.name}${preMatch.venue.city ? ` in ${preMatch.venue.city}` : ''} is the setting tonight.`,
    weatherLine,
  ].join(' ');
}

async function fetchOpenMeteoWeather(
  latitude: number,
  longitude: number,
  fetchImpl: typeof fetch,
) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(latitude));
  url.searchParams.set('longitude', String(longitude));
  url.searchParams.set('current', 'temperature_2m,precipitation,wind_speed_10m,weather_code');

  const payload = await fetchJson<OpenMeteoResponse>(url.toString(), fetchImpl);
  const current = payload.current;

  if (!current) {
    return null;
  }

  return {
    summary: describeWeatherCode(current.weather_code),
    temperatureC: current.temperature_2m ?? null,
    windKph: current.wind_speed_10m ?? null,
    precipitationMm: current.precipitation ?? null,
    source: 'open-meteo',
    isFallback: true,
  };
}

function extractProviderWeather(fixture: SportmonksFixtureRecord) {
  const weather = fixture.weatherreport ?? fixture.weather_report;

  if (!weather) {
    return null;
  }

  return {
    summary: weather.description ?? weather.desc ?? 'Provider weather update available',
    temperatureC:
      asNumber(weather.temperature?.temp) ?? asNumber(weather.temperature_celcius),
    windKph: asNumber(weather.wind?.speed) ?? asNumber(weather.wind_speed),
    precipitationMm: asNumber(weather.precipitation),
    source: 'sportmonks',
    isFallback: false,
  };
}

async function maybeGenerateAiOpener(
  preMatch: Omit<PreMatchState, 'aiOpener'>,
  apiKey: string | undefined,
  model: string | undefined,
  fetchImpl: typeof fetch,
) {
  if (!apiKey) {
    return null;
  }

  const response = await fetchImpl(`${OPENAI_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model ?? OPENAI_PREMATCH_MODEL,
      input: [
        {
          role: 'system',
          content:
            'Write a short broadcaster pre-match opener. Stay grounded in the provided facts. Do not invent details or add facts not present.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            homeRecentForm: preMatch.homeRecentForm,
            awayRecentForm: preMatch.awayRecentForm,
            headToHead: preMatch.headToHead,
            venue: preMatch.venue,
            weather: preMatch.weather,
          }),
        },
      ],
      text: {
        format: {
          type: 'text',
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    output_text?: string;
  };

  return payload.output_text?.trim() || null;
}

async function fetchFixtureRecord(
  fixtureId: string,
  apiToken: string,
  fetchImpl: typeof fetch,
) {
  const url = buildSportmonksUrl(`/fixtures/${fixtureId}`, apiToken, FIXTURE_PREMATCH_INCLUDES);
  const payload = await fetchJson<SportmonksSingleFixtureResponse>(url.toString(), fetchImpl);
  return payload.data ?? {};
}

async function fetchTeamFixtureRecords(
  teamId: string,
  anchorDate: Date,
  apiToken: string,
  fetchImpl: typeof fetch,
) {
  const dateRange = buildDateRange(anchorDate);
  const url = buildSportmonksUrl(
    `/fixtures/between/${dateRange.start}/${dateRange.end}/${teamId}`,
    apiToken,
    TEAM_FIXTURE_INCLUDES,
  );
  const payload = await fetchJson<SportmonksFixtureListResponse>(url.toString(), fetchImpl);
  return payload.data ?? [];
}

export async function buildPreMatchContext(config: BuilderConfig): Promise<PreMatchState> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const fixture = await fetchFixtureRecord(config.fixtureId, config.apiToken, fetchImpl);
  const { home, away } = resolveParticipants(fixture);
  const homeId = asString(home?.id);
  const awayId = asString(away?.id);
  const homeName = home?.name?.trim() || 'Home';
  const awayName = away?.name?.trim() || 'Away';
  const anchorDate = parseFixtureDate(fixture.starting_at);
  const [homeFixtures, awayFixtures] = await Promise.all([
    homeId ? fetchTeamFixtureRecords(homeId, anchorDate, config.apiToken, fetchImpl) : [],
    awayId ? fetchTeamFixtureRecords(awayId, anchorDate, config.apiToken, fetchImpl) : [],
  ]);

  const normalizeList = (fixtures: SportmonksFixtureRecord[], teamId: string, teamName: string) =>
    fixtures
      .filter((candidate) => asString(candidate.id) !== config.fixtureId)
      .sort(
        (left, right) =>
          parseFixtureDate(right.starting_at).getTime() - parseFixtureDate(left.starting_at).getTime(),
      )
      .map((candidate) => normalizeRecentMatch(candidate, teamId, teamName))
      .filter((candidate): candidate is RecentMatchSummary => Boolean(candidate))
      .slice(0, 5);

  const homeRecentMatches = normalizeList(homeFixtures, homeId, homeName);
  const awayRecentMatches = normalizeList(awayFixtures, awayId, awayName);
  const combinedHeadToHead = [...homeFixtures, ...awayFixtures]
    .filter((candidate, index, collection) => {
      const candidateId = asString(candidate.id);
      if (!candidateId || collection.findIndex((entry) => asString(entry.id) === candidateId) !== index) {
        return false;
      }

      const participantIds = new Set((candidate.participants ?? []).map((participant) => asString(participant.id)));
      return participantIds.has(homeId) && participantIds.has(awayId) && candidateId !== config.fixtureId;
    })
    .sort(
      (left, right) =>
        parseFixtureDate(right.starting_at).getTime() - parseFixtureDate(left.starting_at).getTime(),
    )
    .slice(0, 5)
    .map((candidate) => normalizeRecentMatch(candidate, homeId, homeName))
    .filter((candidate): candidate is RecentMatchSummary => Boolean(candidate));

  let weather = extractProviderWeather(fixture);
  const latitude = asNumber(fixture.venue?.latitude);
  const longitude = asNumber(fixture.venue?.longitude);
  const sourceNotes: string[] = [];

  if (!weather && latitude !== null && longitude !== null) {
    try {
      weather = await fetchOpenMeteoWeather(latitude, longitude, fetchImpl);
      if (weather) {
        sourceNotes.push('Weather sourced from Open-Meteo fallback.');
      }
    } catch (_error) {
      sourceNotes.push('Weather fallback failed.');
    }
  }

  const preMatchWithoutAi: Omit<PreMatchState, 'aiOpener'> = {
    loadStatus: 'ready',
    generatedAt: Date.now(),
    homeRecentForm: buildRecentForm('home', homeName, homeRecentMatches),
    awayRecentForm: buildRecentForm('away', awayName, awayRecentMatches),
    headToHead: summarizeHeadToHead(combinedHeadToHead, homeName, awayName),
    venue: {
      name: fixture.venue?.name?.trim() || 'Venue unavailable',
      city: asNullableString(fixture.venue?.city_name ?? fixture.venue?.city),
      country: asNullableString(fixture.venue?.country_name ?? fixture.venue?.country),
      capacity: fixture.venue?.capacity ?? null,
      surface: asNullableString(fixture.venue?.surface),
    },
    weather,
    deterministicOpener: '',
    sourceMetadata: {
      provider: 'sportmonks',
      fetchedAt: Date.now(),
      sourceNotes,
      usedWeatherFallback: Boolean(weather?.isFallback),
    },
  };

  preMatchWithoutAi.deterministicOpener = buildDeterministicOpener(preMatchWithoutAi);

  try {
    const aiOpener = await maybeGenerateAiOpener(
      preMatchWithoutAi,
      config.openAiApiKey,
      config.openAiModel,
      fetchImpl,
    );

    return {
      ...preMatchWithoutAi,
      aiOpener,
    };
  } catch (error) {
    return {
      ...preMatchWithoutAi,
      loadStatus: 'degraded',
      aiOpener: null,
      sourceMetadata: {
        ...preMatchWithoutAi.sourceMetadata,
        sourceNotes: [
          ...preMatchWithoutAi.sourceMetadata.sourceNotes,
          `AI opener fallback engaged: ${error instanceof Error ? error.message : String(error)}`,
        ],
      },
    };
  }
}

export function buildPreMatchRetrievalFacts(preMatch: PreMatchState) {
  if (preMatch.loadStatus === 'pending') {
    return [];
  }

  const facts = [
    `${preMatch.homeRecentForm.teamName} recent form: ${formatRecentForm(preMatch.homeRecentForm)}.`,
    `${preMatch.awayRecentForm.teamName} recent form: ${formatRecentForm(preMatch.awayRecentForm)}.`,
    preMatch.headToHead.summary,
    `Venue: ${preMatch.venue.name}${preMatch.venue.city ? `, ${preMatch.venue.city}` : ''}.`,
  ];

  if (preMatch.weather) {
    facts.push(
      `Weather: ${preMatch.weather.summary}${
        preMatch.weather.temperatureC !== null ? ` at ${Math.round(preMatch.weather.temperatureC)}C` : ''
      }.`,
    );
  }

  return facts;
}

export function createDegradedPreMatchState(reason: string) {
  return {
    ...createEmptyPreMatchState(),
    loadStatus: 'degraded' as const,
    generatedAt: Date.now(),
    deterministicOpener: reason,
    sourceMetadata: {
      provider: 'sportmonks',
      fetchedAt: Date.now(),
      sourceNotes: [reason],
      usedWeatherFallback: false,
    },
  };
}
