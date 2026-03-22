import {
  ContextBundle,
  ContextBundleItem,
  GameEvent,
  LiveMatchState,
  MemoryTier,
  PreMatchChunkCategory,
  PreMatchState,
  RetrievalPhaseHint,
  RetrievedFact,
  RetrievalState,
  SocialPost,
  TeamSide,
  TranscriptEntry,
  UserContextChunk,
  VisionCue,
} from '@sports-copilot/shared-types';
import { buildVisionMemory } from './vision.js';

const SESSION_EVENT_WINDOW_MS = 30_000;
const SESSION_TRANSCRIPT_WINDOW_MS = 20_000;
const LIVE_MEMORY_WINDOW_MS = 45_000;
const MAX_SUPPORTING_FACTS = 5;
const LIVE_TIER_WEIGHT = 0.55;
const SESSION_TIER_WEIGHT = 0.45;
const STATIC_TIER_WEIGHT = 0.35;
const PRE_MATCH_TIER_WEIGHT = 0.41;
const USER_TIER_WEIGHT = 0.52;
const HOT_EVENT_WINDOW_MS = 12_000;
const QUIET_STRETCH_WINDOW_MS = 120_000;
const CONTEXT_LANE_LIMIT = 2;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'at',
  'for',
  'from',
  'has',
  'he',
  'her',
  'his',
  'in',
  'is',
  'it',
  'of',
  'on',
  'that',
  'the',
  'their',
  'there',
  'they',
  'this',
  'to',
  'what',
  'with',
]);

interface PlayerFixture {
  id: string;
  name: string;
  number: number;
  position: string;
  fact?: string;
}

interface TeamFixture {
  name: string;
  shortName: string;
  roster: PlayerFixture[];
}

export interface RosterFixture {
  home: TeamFixture;
  away: TeamFixture;
}

export interface NarrativeFixture {
  id: string;
  type: string;
  title: string;
  description: string;
}

interface RankableFact extends Omit<RetrievedFact, 'relevance' | 'sourceChip'> {
  tags: string[];
}

export interface RetrievalInput {
  clockMs: number;
  events: GameEvent[];
  transcript: TranscriptEntry[];
  roster: RosterFixture;
  narratives: NarrativeFixture[];
  socialPosts: SocialPost[];
  userContextChunks?: UserContextChunk[];
  visionCues?: VisionCue[];
  liveMatch?: LiveMatchState;
  preMatch?: PreMatchState;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function roundToHundredths(value: number) {
  return Number(value.toFixed(2));
}

function normalizeText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: string) {
  return normalizeText(text)
    .split(' ')
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function uniqueTokens(values: string[]) {
  return [...new Set(values)];
}

function getTierWeight(tier: MemoryTier) {
  switch (tier) {
    case 'live':
      return LIVE_TIER_WEIGHT;
    case 'pre_match':
      return PRE_MATCH_TIER_WEIGHT;
    case 'user':
      return USER_TIER_WEIGHT;
    case 'session':
      return SESSION_TIER_WEIGHT;
    case 'static':
      return STATIC_TIER_WEIGHT;
    default:
      return STATIC_TIER_WEIGHT;
  }
}

function buildSourceChip(fact: RankableFact, relevance: number) {
  return {
    id: fact.id,
    label: fact.text.length > 72 ? `${fact.text.slice(0, 69)}...` : fact.text,
    source: `${fact.tier}:${fact.source}`,
    relevance,
    metadata: fact.metadata,
  };
}

function getEventPlayer(event?: GameEvent) {
  return typeof event?.data?.player === 'string' ? event.data.player : null;
}

function getEventTeam(event?: GameEvent) {
  return typeof event?.data?.team === 'string' ? event.data.team : null;
}

function createRankableFact(
  fact: Omit<RankableFact, 'relevance' | 'sourceChip'>,
): RankableFact {
  return {
    ...fact,
    tags: uniqueTokens(fact.tags),
  };
}

function buildPreMatchMetadata(params: {
  chunkCategory: PreMatchChunkCategory;
  fixtureId?: string;
  teamSide?: TeamSide;
  phaseHints?: RetrievalPhaseHint[];
}) {
  return {
    chunkCategory: params.chunkCategory,
    fixtureId: params.fixtureId,
    teamSide: params.teamSide,
    phaseHints: params.phaseHints ?? ['general'],
  };
}

export function buildStaticMemory(
  roster: RosterFixture,
  narratives: NarrativeFixture[],
): RankableFact[] {
  const playerFacts = [roster.home, roster.away].flatMap((team) =>
    team.roster
      .filter((player) => Boolean(player.fact))
      .map((player) =>
        createRankableFact({
          id: `static-player-${player.id}`,
          tier: 'static',
          text: `${player.name}: ${player.fact}`,
          source: `roster:${team.shortName}`,
          timestamp: null,
          tags: [
            ...tokenize(player.name),
            ...tokenize(team.name),
            normalizeText(team.shortName),
            normalizeText(player.position),
            ...tokenize(player.fact ?? ''),
          ],
        }),
      ),
  );

  const narrativeFacts = narratives.map((narrative) =>
    createRankableFact({
      id: `static-narrative-${narrative.id}`,
      tier: 'static',
      text: `${narrative.title}. ${narrative.description}`,
      source: `narratives:${narrative.type.toLowerCase()}`,
      timestamp: null,
      tags: [...tokenize(narrative.title), ...tokenize(narrative.description), normalizeText(narrative.type)],
    }),
  );

  return [...playerFacts, ...narrativeFacts];
}

export function buildSessionMemory(
  clockMs: number,
  events: GameEvent[],
  transcript: TranscriptEntry[],
): RankableFact[] {
  const eventFacts = events
    .filter((event) => event.timestamp <= clockMs && clockMs - event.timestamp <= SESSION_EVENT_WINDOW_MS)
    .map((event) =>
      createRankableFact({
        id: `session-event-${event.id}`,
        tier: 'session',
        text: event.description,
        source: `event-feed:${event.type.toLowerCase()}`,
        timestamp: event.timestamp,
        tags: [
          ...tokenize(event.description),
          normalizeText(event.type),
          ...tokenize(getEventPlayer(event) ?? ''),
          normalizeText(getEventTeam(event) ?? ''),
        ],
      }),
    );

  const transcriptFacts = transcript
    .filter(
      (entry) =>
        entry.timestamp <= clockMs && clockMs - entry.timestamp <= SESSION_TRANSCRIPT_WINDOW_MS,
    )
    .map((entry, index) =>
      createRankableFact({
        id: `session-transcript-${entry.speaker}-${entry.timestamp}-${index}`,
        tier: 'session',
        text: entry.text,
        source: `transcript:${entry.speaker}`,
        timestamp: entry.timestamp,
        tags: [...tokenize(entry.text), normalizeText(entry.speaker)],
      }),
    );

  return [...eventFacts, ...transcriptFacts];
}

function normalizeSocialText(post: SocialPost) {
  return `${post.handle}: ${post.text.replace(/\s+/g, ' ').trim()}`;
}

export function ingestLiveSocialPosts(clockMs: number, socialPosts: SocialPost[]) {
  return socialPosts.filter((post) => post.timestamp <= clockMs);
}

export function buildLiveMemory(clockMs: number, socialPosts: SocialPost[]): RankableFact[] {
  return socialPosts
    .filter((post) => post.timestamp <= clockMs && clockMs - post.timestamp <= LIVE_MEMORY_WINDOW_MS)
    .map((post, index) =>
      createRankableFact({
        id: `live-social-${post.timestamp}-${index}`,
        tier: 'live',
        text: normalizeSocialText(post),
        source: `social:${post.handle}`,
        timestamp: post.timestamp,
        tags: [...tokenize(post.text), ...tokenize(post.handle), normalizeText(post.sentiment)],
      }),
    );
}

function buildLiveVisionFacts(clockMs: number, visionCues: VisionCue[]): RankableFact[] {
  return buildVisionMemory(clockMs, visionCues).map((fact) =>
    createRankableFact({
      id: fact.id,
      tier: fact.tier,
      text: fact.text,
      source: fact.source,
      timestamp: fact.timestamp,
      tags: [...tokenize(fact.text), ...tokenize(fact.source)],
    }),
  );
}

function buildLiveStatFacts(liveMatch?: LiveMatchState): RankableFact[] {
  if (!liveMatch) {
    return [];
  }

  return liveMatch.stats.map((stat, index) =>
    createRankableFact({
      id: `live-stat-${stat.teamSide}-${index}`,
      tier: 'live',
      text: `${stat.teamSide === 'home' ? liveMatch.homeTeam.name : liveMatch.awayTeam.name} ${stat.label}: ${stat.value}`,
      source: `stats:${stat.label.toLowerCase().replace(/\s+/g, '-')}`,
      timestamp: liveMatch.lastUpdatedAt,
      tags: [
        ...tokenize(stat.label),
        ...tokenize(String(stat.value)),
        ...tokenize(stat.teamSide === 'home' ? liveMatch.homeTeam.name : liveMatch.awayTeam.name),
      ],
    }),
  );
}

function buildPreMatchFacts(preMatch?: PreMatchState): RankableFact[] {
  if (!preMatch || preMatch.loadStatus === 'pending') {
    return [];
  }
  const fixtureId = 'fixtureId' in preMatch ? undefined : undefined;
  const facts: RankableFact[] = [];
  const recentForms = [preMatch.homeRecentForm, preMatch.awayRecentForm] as const;

  for (const form of recentForms) {
    const formSummary = `${form.teamName} recent form: ${form.record.wins}-${form.record.draws}-${form.record.losses} across the last ${form.lastFive.length}.`;
    facts.push(
      createRankableFact({
        id: `pre-match-form-${form.teamSide}`,
        tier: 'pre_match',
        text: formSummary,
        source: 'pre-match:recent-form',
        timestamp: preMatch.generatedAt,
        metadata: buildPreMatchMetadata({
          chunkCategory: 'recent-form',
          teamSide: form.teamSide,
          fixtureId,
          phaseHints: ['pre_kickoff', 'early_match', 'quiet_stretch'],
        }),
        tags: [...tokenize(formSummary), normalizeText(form.teamName), normalizeText(form.teamSide)],
      }),
    );

    for (const match of form.lastFive.slice(0, 3)) {
      const text = `${form.teamName} ${match.result} ${match.scoreFor}-${match.scoreAgainst} vs ${match.opponent} in their last-five run.`;
      facts.push(
        createRankableFact({
          id: `pre-match-form-match-${form.teamSide}-${match.fixtureId}`,
          tier: 'pre_match',
          text,
          source: 'pre-match:trend',
          timestamp: preMatch.generatedAt,
          metadata: buildPreMatchMetadata({
            chunkCategory: 'trend',
            teamSide: form.teamSide,
            fixtureId,
            phaseHints: ['pre_kickoff', 'early_match', 'quiet_stretch'],
          }),
          tags: [...tokenize(text), normalizeText(form.teamName), normalizeText(match.opponent)],
        }),
      );
    }
  }

  const headToHeadSummary = preMatch.headToHead.summary;
  facts.push(
    createRankableFact({
      id: 'pre-match-head-to-head-summary',
      tier: 'pre_match',
      text: headToHeadSummary,
      source: 'pre-match:head-to-head',
      timestamp: preMatch.generatedAt,
      metadata: buildPreMatchMetadata({
        chunkCategory: 'head-to-head',
        fixtureId,
        phaseHints: ['pre_kickoff', 'early_match', 'quiet_stretch'],
      }),
      tags: tokenize(headToHeadSummary),
    }),
  );

  for (const meeting of preMatch.headToHead.meetings.slice(0, 3)) {
    const text = `${preMatch.homeRecentForm.teamName} ${meeting.scoreFor}-${meeting.scoreAgainst} ${meeting.result} against ${meeting.opponent} in a recent head-to-head meeting.`;
    facts.push(
      createRankableFact({
        id: `pre-match-head-to-head-meeting-${meeting.fixtureId}`,
        tier: 'pre_match',
        text,
        source: 'pre-match:head-to-head',
        timestamp: preMatch.generatedAt,
        metadata: buildPreMatchMetadata({
          chunkCategory: 'head-to-head',
          fixtureId,
          phaseHints: ['pre_kickoff', 'early_match', 'quiet_stretch'],
        }),
        tags: tokenize(text),
      }),
    );
  }

  const venueText = `Venue: ${[preMatch.venue.name, preMatch.venue.city, preMatch.venue.country]
    .filter(Boolean)
    .join(', ')}.`;
  facts.push(
    createRankableFact({
      id: 'pre-match-venue',
      tier: 'pre_match',
      text: venueText,
      source: 'pre-match:venue',
      timestamp: preMatch.generatedAt,
      metadata: buildPreMatchMetadata({
        chunkCategory: 'venue',
        fixtureId,
        phaseHints: ['pre_kickoff', 'early_match', 'quiet_stretch'],
      }),
      tags: tokenize(venueText),
    }),
  );

  if (preMatch.weather) {
    const weatherText = `Weather: ${preMatch.weather.summary}${
      preMatch.weather.temperatureC !== null ? ` at ${Math.round(preMatch.weather.temperatureC)}C` : ''
    }.`;
    facts.push(
      createRankableFact({
        id: 'pre-match-weather',
        tier: 'pre_match',
        text: weatherText,
        source: 'pre-match:weather',
        timestamp: preMatch.generatedAt,
        metadata: buildPreMatchMetadata({
          chunkCategory: 'weather',
          fixtureId,
          phaseHints: ['pre_kickoff', 'early_match', 'quiet_stretch'],
        }),
        tags: tokenize(weatherText),
      }),
    );
  }

  facts.push(
    createRankableFact({
      id: 'pre-match-opener',
      tier: 'pre_match',
      text: preMatch.deterministicOpener,
      source: 'pre-match:opener',
      timestamp: preMatch.generatedAt,
      metadata: buildPreMatchMetadata({
        chunkCategory: 'opener',
        fixtureId,
        phaseHints: ['pre_kickoff', 'early_match', 'quiet_stretch'],
      }),
      tags: tokenize(preMatch.deterministicOpener),
    }),
  );

  return facts;
}

function buildUserContextFacts(userContextChunks: UserContextChunk[] = []): RankableFact[] {
  return userContextChunks.map((chunk) =>
    createRankableFact({
      id: `user-context-${chunk.id}`,
      tier: 'user',
      text: chunk.text,
      source: `user-context:${chunk.documentName}`,
      timestamp: null,
      metadata: {
        documentId: chunk.documentId,
        userProvided: true,
      },
      tags: tokenize(chunk.text),
    }),
  );
}

export function buildRetrievalQuery(clockMs: number, events: GameEvent[], transcript: TranscriptEntry[]) {
  const latestEvent = [...events]
    .filter((event) => event.timestamp <= clockMs)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  const latestTranscript = [...transcript]
    .filter((entry) => entry.timestamp <= clockMs)
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  return latestEvent?.description ?? latestTranscript?.text ?? 'Opening phase context';
}

function buildFocusTokens(clockMs: number, events: GameEvent[], transcript: TranscriptEntry[]) {
  const latestEvent = [...events]
    .filter((event) => event.timestamp <= clockMs)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  const latestTranscript = [...transcript]
    .filter((entry) => entry.timestamp <= clockMs)
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  return uniqueTokens([
    ...tokenize(latestEvent?.description ?? ''),
    ...tokenize(latestTranscript?.text ?? ''),
    ...tokenize(getEventPlayer(latestEvent) ?? ''),
    normalizeText(getEventTeam(latestEvent) ?? ''),
    normalizeText(latestEvent?.type ?? ''),
  ]);
}

function determineMatchPhase(clockMs: number, events: GameEvent[], liveMatch?: LiveMatchState): RetrievalPhaseHint {
  if (!liveMatch || liveMatch.status === 'not_started' || (events.length === 0 && liveMatch.minute === 0)) {
    return 'pre_kickoff';
  }

  if (liveMatch.minute > 0 && liveMatch.minute <= 15) {
    return 'early_match';
  }

  const latestEvent = [...events]
    .filter((event) => event.timestamp <= clockMs)
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  if (!latestEvent || clockMs - latestEvent.timestamp >= QUIET_STRETCH_WINDOW_MS) {
    return 'quiet_stretch';
  }

  return 'general';
}

function scoreFact(
  clockMs: number,
  fact: RankableFact,
  focusTokens: string[],
  latestEvent?: GameEvent,
  matchPhase: RetrievalPhaseHint = 'general',
) {
  let score = getTierWeight(fact.tier);
  const tagSet = new Set(fact.tags);
  const overlapCount = focusTokens.filter((token) => tagSet.has(token)).length;

  score += Math.min(0.24, overlapCount * 0.08);

  const eventPlayer = normalizeText(getEventPlayer(latestEvent) ?? '');
  if (eventPlayer && tagSet.has(eventPlayer)) {
    score += 0.18;
  }

  const eventTeam = normalizeText(getEventTeam(latestEvent) ?? '');
  if (eventTeam && tagSet.has(eventTeam)) {
    score += 0.08;
  }

  if (fact.tier === 'pre_match') {
    if (fact.metadata?.phaseHints?.includes(matchPhase)) {
      score += matchPhase === 'pre_kickoff' ? 0.22 : matchPhase === 'early_match' ? 0.16 : 0.12;
    }

    if (latestEvent && clockMs - latestEvent.timestamp <= HOT_EVENT_WINDOW_MS) {
      score -= 0.14;
    }

    if (fact.metadata?.chunkCategory === 'opener' && matchPhase === 'general') {
      score -= 0.06;
    }
  }

  if (fact.timestamp !== null) {
    const ageMs = Math.max(0, clockMs - fact.timestamp);
    const freshnessWindowMs =
      fact.tier === 'live'
        ? LIVE_MEMORY_WINDOW_MS
        : fact.tier === 'pre_match'
          ? Math.max(clockMs, 1)
          : SESSION_EVENT_WINDOW_MS;
    const freshnessWeight = fact.tier === 'live' ? 0.18 : fact.tier === 'pre_match' ? 0.04 : 0.12;
    const freshnessScore = Math.max(0, 1 - ageMs / freshnessWindowMs) * freshnessWeight;
    score += freshnessScore;
  }

  return roundToHundredths(clamp(score, 0, 1));
}

export function buildRetrievalState({
  clockMs,
  events,
  transcript,
  roster,
  narratives,
  socialPosts,
  userContextChunks = [],
  visionCues = [],
  liveMatch,
  preMatch,
}: RetrievalInput): RetrievalState {
  const query = buildRetrievalQuery(clockMs, events, transcript);
  const focusTokens = buildFocusTokens(clockMs, events, transcript);
  const matchPhase = determineMatchPhase(clockMs, events, liveMatch);
  const latestEvent = [...events]
    .filter((event) => event.timestamp <= clockMs)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  const candidateFacts = [
    ...buildLiveVisionFacts(clockMs, visionCues),
    ...buildLiveStatFacts(liveMatch),
    ...buildLiveMemory(clockMs, socialPosts),
    ...buildSessionMemory(clockMs, events, transcript),
    ...buildPreMatchFacts(preMatch),
    ...buildUserContextFacts(userContextChunks),
    ...buildStaticMemory(roster, narratives),
  ];

  const rankedFacts = candidateFacts
    .map((fact) => {
      const relevance = scoreFact(clockMs, fact, focusTokens, latestEvent, matchPhase);
      const semanticScore =
        fact.tier === 'user'
          ? clamp(
              (userContextChunks.find((chunk) => `user-context-${chunk.id}` === fact.id)?.score ?? 0) * 1.1,
              0,
              1,
            )
          : 0;
      const boostedRelevance = clamp(Math.max(relevance, semanticScore), 0, 1);
      const tierScore = getTierWeight(fact.tier);
      const freshnessScore =
        fact.timestamp === null
          ? 0
          : Math.max(
              0,
              boostedRelevance - Math.min(0.24, focusTokens.filter((token) => new Set(fact.tags).has(token)).length * 0.08) - tierScore,
            );

      return {
        id: fact.id,
        tier: fact.tier,
        text: fact.text,
        source: fact.source,
        timestamp: fact.timestamp,
        relevance: boostedRelevance,
        metadata: fact.metadata,
        scoreBreakdown: {
          lexical: relevance,
          semantic: semanticScore,
          freshness: freshnessScore,
          tier: tierScore,
          total: boostedRelevance,
        },
        usedByAgents: [],
        sourceChip: buildSourceChip(fact, boostedRelevance),
      };
    })
    .sort((left, right) => {
      if (right.relevance !== left.relevance) {
        return right.relevance - left.relevance;
      }

      if (getTierWeight(right.tier) !== getTierWeight(left.tier)) {
        return getTierWeight(right.tier) - getTierWeight(left.tier);
      }

      return (right.timestamp ?? -1) - (left.timestamp ?? -1);
    });

  const supportingFacts = rankedFacts.slice(0, MAX_SUPPORTING_FACTS);
  const usedFactIds = new Set(supportingFacts.map((fact) => fact.id));
  const unusedFacts = rankedFacts.filter((fact) => !usedFactIds.has(fact.id)).slice(0, 8);

  return {
    query,
    supportingFacts,
    unusedFacts,
  };
}

function summarizeFactText(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 108) {
    return normalized;
  }

  return `${normalized.slice(0, 105).trimEnd()}...`;
}

function pickContextLane(fact: RetrievedFact): ContextBundleItem['lane'] {
  if (fact.tier === 'pre_match') {
    return 'pre-match';
  }
  if (fact.tier === 'user') {
    return 'user-context';
  }
  if (fact.source.startsWith('social:')) {
    return 'social-pulse';
  }
  if (fact.tier === 'session') {
    return 'session-thread';
  }
  return 'live-moment';
}

function buildContextHeadline(fact: RetrievedFact) {
  if (fact.source.startsWith('social:')) {
    return 'Social pulse';
  }
  if (fact.source.startsWith('stats:')) {
    return 'Stat line';
  }
  if (fact.source.startsWith('event-feed:')) {
    return 'Live moment';
  }
  if (fact.source.startsWith('vision:')) {
    return 'Visual cue';
  }
  if (fact.tier === 'pre_match') {
    switch (fact.metadata?.chunkCategory) {
      case 'recent-form':
        return 'Form line';
      case 'head-to-head':
        return 'Head to head';
      case 'weather':
        return 'Weather';
      case 'venue':
        return 'Venue';
      case 'trend':
        return 'Trend';
      default:
        return 'Pre-match note';
    }
  }
  return 'Session thread';
}

function buildContextExpiry(clockMs: number, fact: RetrievedFact) {
  if (fact.timestamp === null) {
    return null;
  }

  const windowMs =
    fact.tier === 'pre_match'
      ? QUIET_STRETCH_WINDOW_MS
      : fact.tier === 'session'
        ? SESSION_EVENT_WINDOW_MS
        : LIVE_MEMORY_WINDOW_MS;

  return fact.timestamp + windowMs > clockMs ? fact.timestamp + windowMs : clockMs;
}

export function buildContextBundle(clockMs: number, retrieval: RetrievalState): ContextBundle {
  const laneBuckets = new Map<ContextBundleItem['lane'], ContextBundleItem[]>();

  for (const fact of retrieval.supportingFacts) {
    const lane = pickContextLane(fact);
    const item: ContextBundleItem = {
      id: fact.id,
      lane,
      headline: buildContextHeadline(fact),
      detail: summarizeFactText(fact.text),
      expiresAt: buildContextExpiry(clockMs, fact),
      salience: fact.relevance,
      sourceChip: fact.sourceChip,
    };

    const current = laneBuckets.get(lane) ?? [];
    current.push(item);
    laneBuckets.set(lane, current);
  }

  const orderedLanes: ContextBundleItem['lane'][] = [
    'live-moment',
    'social-pulse',
    'pre-match',
    'session-thread',
  ];

  const items = orderedLanes.flatMap((lane) =>
    (laneBuckets.get(lane) ?? [])
      .sort((left, right) => right.salience - left.salience)
      .slice(0, CONTEXT_LANE_LIMIT),
  );

  return {
    summary:
      items.length > 0
        ? items
            .slice(0, 4)
            .map((item) => `${item.headline}: ${item.detail}`)
            .join(' | ')
        : 'Context rack is waiting for the next live beat.',
    items,
  };
}
