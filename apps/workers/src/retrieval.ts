import {
  GameEvent,
  MemoryTier,
  RetrievedFact,
  RetrievalState,
  SocialPost,
  TranscriptEntry,
} from '@sports-copilot/shared-types';

const SESSION_EVENT_WINDOW_MS = 30_000;
const SESSION_TRANSCRIPT_WINDOW_MS = 20_000;
const LIVE_MEMORY_WINDOW_MS = 45_000;
const MAX_SUPPORTING_FACTS = 5;
const LIVE_TIER_WEIGHT = 0.55;
const SESSION_TIER_WEIGHT = 0.45;
const STATIC_TIER_WEIGHT = 0.35;

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
    case 'session':
      return SESSION_TIER_WEIGHT;
    case 'static':
      return STATIC_TIER_WEIGHT;
  }
}

function buildSourceChip(fact: RankableFact, relevance: number) {
  return {
    id: fact.id,
    label: fact.text.length > 72 ? `${fact.text.slice(0, 69)}...` : fact.text,
    source: `${fact.tier}:${fact.source}`,
    relevance,
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

function buildQuery(clockMs: number, events: GameEvent[], transcript: TranscriptEntry[]) {
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

function scoreFact(
  clockMs: number,
  fact: RankableFact,
  focusTokens: string[],
  latestEvent?: GameEvent,
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

  if (fact.timestamp !== null) {
    const ageMs = Math.max(0, clockMs - fact.timestamp);
    const freshnessWindowMs = fact.tier === 'live' ? LIVE_MEMORY_WINDOW_MS : SESSION_EVENT_WINDOW_MS;
    const freshnessWeight = fact.tier === 'live' ? 0.18 : 0.12;
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
}: RetrievalInput): RetrievalState {
  const query = buildQuery(clockMs, events, transcript);
  const focusTokens = buildFocusTokens(clockMs, events, transcript);
  const latestEvent = [...events]
    .filter((event) => event.timestamp <= clockMs)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  const candidateFacts = [
    ...buildLiveMemory(clockMs, socialPosts),
    ...buildSessionMemory(clockMs, events, transcript),
    ...buildStaticMemory(roster, narratives),
  ];

  const supportingFacts = candidateFacts
    .map((fact) => {
      const relevance = scoreFact(clockMs, fact, focusTokens, latestEvent);

      return {
        id: fact.id,
        tier: fact.tier,
        text: fact.text,
        source: fact.source,
        timestamp: fact.timestamp,
        relevance,
        sourceChip: buildSourceChip(fact, relevance),
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
    })
    .slice(0, MAX_SUPPORTING_FACTS);

  return {
    query,
    supportingFacts,
  };
}
