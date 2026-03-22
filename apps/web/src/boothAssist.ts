import {
  AssistCard,
  ContextBundle,
  VisionCue,
  LiveMatchState,
  PreMatchState,
  RetrievedFact,
  RetrievalState,
  SocialPost,
  TranscriptEntry,
  GameEvent,
  createEmptyAssistCard,
} from '@sports-copilot/shared-types';
import type { BoothSignal } from './boothSignal';

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'at',
  'for',
  'from',
  'has',
  'in',
  'is',
  'it',
  'of',
  'on',
  'that',
  'the',
  'their',
  'this',
  'to',
  'was',
  'we',
  'with',
]);

const CUE_INSTRUCTION_PREFIXES = [
  'bring in the fan reaction:',
  'go back to the setup:',
  'use the rivalry context:',
  'set the scene:',
  'use the number:',
  'pick up the live moment:',
  'bring in the setup:',
  'use the reaction:',
  'use the live detail:',
  'then layer in the reaction:',
  'then connect it to the number:',
  'then tie it back to the setup:',
  'then land the follow-through:',
  'pick up from',
];

const SEMANTIC_STOP_WORDS = new Set([
  ...STOP_WORDS,
  'back',
  'bring',
  'clean',
  'connect',
  'detail',
  'fan',
  'follow',
  'go',
  'into',
  'land',
  'layer',
  'live',
  'moment',
  'next',
  'number',
  'pick',
  'reaction',
  'scene',
  'setup',
  'then',
  'tie',
  'use',
]);

function normalizeText(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(text: string) {
  return normalizeText(text)
    .split(' ')
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function semanticTokens(text: string) {
  return normalizeText(text)
    .split(' ')
    .filter((token) => token.length > 2 && !SEMANTIC_STOP_WORDS.has(token));
}

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function quoteExcerpt(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 48) {
    return `"${normalized}"`;
  }

  return `"${normalized.slice(0, 45).trimEnd()}..."`;
}

function cleanFactText(text: string) {
  return text.replace(/^@[^:]+:\s*/i, '').replace(/\s+/g, ' ').trim();
}

function stripCueInstruction(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const lowered = normalized.toLowerCase();

  for (const prefix of CUE_INSTRUCTION_PREFIXES) {
    if (lowered.startsWith(prefix)) {
      return normalized.slice(prefix.length).trim().replace(/^[:,-]\s*/, '');
    }
  }

  return normalized;
}

const TRANSCRIPT_FRESHNESS_WINDOW_MS = 7_000;
const MAX_LIVE_STAT_FACTS = 10;

type BoothIntent = 'social' | 'stats' | 'live-play' | 'setup' | 'generic';
type FactFamily = 'social' | 'stats' | 'event' | 'setup' | 'context';

function buildRecentTranscriptText(params: {
  boothTranscript: TranscriptEntry[];
  interimTranscript: string;
  currentTimestampMs: number;
  windowMs?: number;
}) {
  const { boothTranscript, interimTranscript, currentTimestampMs, windowMs = 30_000 } = params;
  const cutoff = currentTimestampMs - windowMs;
  const transcriptParts = boothTranscript
    .filter((entry) => entry.timestamp >= cutoff)
    .map((entry) => entry.text.trim())
    .filter(Boolean);

  if (interimTranscript.trim()) {
    transcriptParts.push(interimTranscript.trim());
  }

  return transcriptParts.join(' ').trim();
}

function getTokenOverlapScore(candidate: string, transcriptText: string) {
  const candidateTokens = [...new Set(semanticTokens(candidate))];
  if (candidateTokens.length === 0) {
    return 0;
  }

  const transcriptTokenSet = new Set(semanticTokens(transcriptText));
  if (transcriptTokenSet.size === 0) {
    return 0;
  }

  const overlapCount = candidateTokens.filter((token) => transcriptTokenSet.has(token)).length;
  return overlapCount / candidateTokens.length;
}

export function isCueCoveredByTranscript(params: {
  cueText: string;
  boothTranscript: TranscriptEntry[];
  interimTranscript: string;
  currentTimestampMs: number;
  windowMs?: number;
}) {
  const transcriptText = buildRecentTranscriptText(params);
  if (!transcriptText) {
    return false;
  }

  const cuePayload = stripCueInstruction(params.cueText);
  const normalizedCuePayload = normalizeText(cuePayload);
  const normalizedTranscriptText = normalizeText(transcriptText);

  if (normalizedCuePayload && normalizedTranscriptText.includes(normalizedCuePayload)) {
    return true;
  }

  return getTokenOverlapScore(cuePayload, transcriptText) >= 0.62;
}

function isFactCoveredByTranscript(params: {
  fact: RetrievedFact;
  boothTranscript: TranscriptEntry[];
  interimTranscript: string;
  currentTimestampMs: number;
  windowMs?: number;
}) {
  const transcriptText = buildRecentTranscriptText(params);
  if (!transcriptText) {
    return false;
  }

  const normalizedFactText = normalizeText(cleanFactText(params.fact.text));
  const normalizedTranscriptText = normalizeText(transcriptText);
  if (normalizedFactText && normalizedTranscriptText.includes(normalizedFactText)) {
    return true;
  }

  return getTokenOverlapScore(params.fact.text, transcriptText) >= 0.66;
}

export function deriveExcludedCueTexts(params: {
  recentCueTexts: string[];
  boothTranscript: TranscriptEntry[];
  interimTranscript: string;
  currentTimestampMs: number;
  windowMs?: number;
}) {
  return params.recentCueTexts.filter((cueText, index, collection) => {
    if (!cueText.trim() || collection.indexOf(cueText) !== index) {
      return false;
    }

    return isCueCoveredByTranscript({
      cueText,
      boothTranscript: params.boothTranscript,
      interimTranscript: params.interimTranscript,
      currentTimestampMs: params.currentTimestampMs,
      windowMs: params.windowMs,
    });
  });
}

function inferBoothIntent(query: string): BoothIntent {
  if (/\b(fans?|reaction|social|online|buzz|crowd)\b/i.test(query)) {
    return 'social';
  }

  if (/\b(stat|stats|number|numbers|possession|shots|corners|xg)\b/i.test(query)) {
    return 'stats';
  }

  if (/\b(save|chance|play|shot|sequence|move|moment|attack|counter|finish)\b/i.test(query)) {
    return 'live-play';
  }

  if (/\b(form|history|meeting|head to head|venue|weather|setup|coming in|tonight)\b/i.test(query)) {
    return 'setup';
  }

  return 'generic';
}

function hasFreshTranscript({
  boothTranscript,
  interimTranscript,
  currentTimestampMs,
}: {
  boothTranscript: TranscriptEntry[];
  interimTranscript: string;
  currentTimestampMs: number;
}) {
  if (interimTranscript.trim()) {
    return true;
  }

  const latestEntry = boothTranscript[boothTranscript.length - 1];
  if (!latestEntry) {
    return false;
  }

  return currentTimestampMs - latestEntry.timestamp <= TRANSCRIPT_FRESHNESS_WINDOW_MS;
}

function factMatchesIntent(fact: RetrievedFact, intent: BoothIntent) {
  switch (intent) {
    case 'social':
      return fact.source.includes('social:');
    case 'stats':
      return fact.source.includes('stats:');
    case 'live-play':
      return fact.source.includes('event-feed:');
    case 'setup':
      return (
        fact.metadata?.chunkCategory === 'recent-form' ||
        fact.metadata?.chunkCategory === 'trend' ||
        fact.metadata?.chunkCategory === 'head-to-head' ||
        fact.metadata?.chunkCategory === 'venue' ||
        fact.metadata?.chunkCategory === 'weather' ||
        fact.metadata?.chunkCategory === 'opener'
      );
    case 'generic':
      return true;
  }
}

function getFactFamily(fact: RetrievedFact): FactFamily {
  if (fact.source.includes('social:')) {
    return 'social';
  }

  if (fact.source.includes('stats:')) {
    return 'stats';
  }

  if (fact.source.includes('event-feed:')) {
    return 'event';
  }

  if (
    fact.metadata?.chunkCategory === 'recent-form' ||
    fact.metadata?.chunkCategory === 'trend' ||
    fact.metadata?.chunkCategory === 'head-to-head' ||
    fact.metadata?.chunkCategory === 'venue' ||
    fact.metadata?.chunkCategory === 'weather' ||
    fact.metadata?.chunkCategory === 'opener' ||
    fact.source.includes('context-bundle:pre-match')
  ) {
    return 'setup';
  }

  return 'context';
}

function dedupeFacts(facts: RetrievedFact[]) {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    if (seen.has(fact.id)) {
      return false;
    }
    seen.add(fact.id);
    return true;
  });
}

function selectGroundingFacts(rankedFacts: RetrievedFact[], intent: BoothIntent) {
  const chosen: RetrievedFact[] = [];
  const familyOrder: FactFamily[] =
    intent === 'social'
      ? ['social', 'event', 'stats', 'setup', 'context']
      : intent === 'stats'
        ? ['stats', 'event', 'social', 'setup', 'context']
        : intent === 'live-play'
          ? ['event', 'stats', 'social', 'setup', 'context']
          : intent === 'setup'
            ? ['setup', 'event', 'stats', 'social', 'context']
            : ['event', 'stats', 'social', 'setup', 'context'];

  for (const family of familyOrder) {
    const nextFact = rankedFacts.find(
      (fact) => getFactFamily(fact) === family && !chosen.some((chosenFact) => chosenFact.id === fact.id),
    );

    if (nextFact) {
      chosen.push(nextFact);
    }

    if (chosen.length >= 2) {
      break;
    }
  }

  if (chosen.length === 0) {
    return rankedFacts.slice(0, 2);
  }

  if (chosen.length === 1) {
    const backup = rankedFacts.find((fact) => !chosen.some((chosenFact) => chosenFact.id === fact.id));
    if (backup) {
      chosen.push(backup);
    }
  }

  return chosen.slice(0, 2);
}

function sentenceCase(text: string) {
  if (!text) {
    return text;
  }

  return text.charAt(0).toUpperCase() + text.slice(1);
}

function trimFactSentence(text: string) {
  return cleanFactText(text).replace(/[.]+$/, '').trim();
}

function buildGroundedFallback(params: {
  intent: BoothIntent;
  rankedFacts: RetrievedFact[];
  currentLine: string;
}) {
  const selectedFacts = selectGroundingFacts(params.rankedFacts, params.intent);
  const [primaryFact, secondaryFact] = selectedFacts;

  if (!primaryFact) {
    const lineExcerpt = params.currentLine ? quoteExcerpt(params.currentLine) : 'the last live beat';
    return {
      type: 'transition' as const,
      text: `Pick up from ${lineExcerpt} and land the next concrete detail.`,
      whyNow: 'No strong external fact is ready yet, so use the live thread you already established.',
      sourceFacts: [] as RetrievedFact[],
    };
  }

  const primaryText = trimFactSentence(primaryFact.text);
  const secondaryText = secondaryFact ? trimFactSentence(secondaryFact.text) : '';
  const primaryFamily = getFactFamily(primaryFact);
  const secondaryFamily = secondaryFact ? getFactFamily(secondaryFact) : null;

  const leadText =
    params.intent === 'stats' && primaryFamily === 'stats'
      ? `Use the number: ${primaryText}.`
      : params.intent === 'social' && primaryFamily === 'social'
        ? `Use the reaction: ${primaryText}.`
        : params.intent === 'setup' && primaryFamily === 'setup'
          ? `Bring in the setup: ${primaryText}.`
          : `Use the live detail: ${primaryText}.`;

  const supportText =
    secondaryText && secondaryFamily === 'social'
      ? `Then layer in the reaction: ${secondaryText}.`
      : secondaryText && secondaryFamily === 'stats'
        ? `Then connect it to the number: ${secondaryText}.`
        : secondaryText && secondaryFamily === 'setup'
          ? `Then tie it back to the setup: ${secondaryText}.`
          : secondaryText
            ? `Then land the follow-through: ${secondaryText}.`
            : '';

  const type: AssistCard['type'] =
    primaryFamily === 'stats'
      ? 'stat'
      : primaryFamily === 'setup' || primaryFamily === 'social'
        ? 'context'
        : 'transition';
  const whyNow = secondaryFact
    ? `This cue is grounded in the current ${primaryFamily} read and a supporting ${secondaryFamily ?? 'context'} thread.`
    : `This cue is grounded in the strongest current ${primaryFamily} detail available.`;

  return {
    type,
    text: sentenceCase([leadText, supportText].filter(Boolean).join(' ')),
    whyNow,
    sourceFacts: selectedFacts,
  };
}

export function getBoothAssistQuery({
  boothTranscript,
  interimTranscript,
}: {
  boothTranscript: TranscriptEntry[];
  interimTranscript: string;
}) {
  return interimTranscript.trim() || boothTranscript[boothTranscript.length - 1]?.text.trim() || '';
}

function createSyntheticFact(
  partial: Omit<RetrievedFact, 'sourceChip'>,
): RetrievedFact {
  return {
    ...partial,
    sourceChip: {
      id: partial.id,
      label: partial.text.length > 72 ? `${partial.text.slice(0, 69)}...` : partial.text,
      source: `${partial.tier}:${partial.source}`,
      relevance: partial.relevance,
      metadata: partial.metadata,
    },
  };
}

function normalizeStatLabel(label: string) {
  return normalizeText(label).replace(/\s+/g, '-');
}

function getStatPriority(label: string) {
  const normalized = normalizeText(label);

  if (/\b(expected goals|xg)\b/.test(normalized)) {
    return 1;
  }
  if (/\b(possession)\b/.test(normalized)) {
    return 0.98;
  }
  if (/\b(shots on target)\b/.test(normalized)) {
    return 0.96;
  }
  if (/\b(total shots|shots)\b/.test(normalized)) {
    return 0.94;
  }
  if (/\b(big chances)\b/.test(normalized)) {
    return 0.92;
  }
  if (/\b(goals)\b/.test(normalized)) {
    return 0.9;
  }
  if (/\b(passes|touches|attacks)\b/.test(normalized)) {
    return 0.78;
  }
  if (/\b(corners)\b/.test(normalized)) {
    return 0.46;
  }
  if (/\b(cards|yellow|red|fouls)\b/.test(normalized)) {
    return 0.3;
  }

  return 0.62;
}

function inferQueryTeamSide(fullQuery: string, liveMatch?: LiveMatchState) {
  if (!liveMatch) {
    return null;
  }

  const normalizedQuery = normalizeText(fullQuery);
  const homeTokens = [
    normalizeText(liveMatch.homeTeam.name),
    normalizeText(liveMatch.homeTeam.shortCode),
    'home',
  ].filter(Boolean);
  const awayTokens = [
    normalizeText(liveMatch.awayTeam.name),
    normalizeText(liveMatch.awayTeam.shortCode),
    'away',
  ].filter(Boolean);

  if (homeTokens.some((token) => token && normalizedQuery.includes(token))) {
    return 'home' as const;
  }
  if (awayTokens.some((token) => token && normalizedQuery.includes(token))) {
    return 'away' as const;
  }

  return null;
}

function isControlQuery(fullQuery: string) {
  return /\b(control|controlled|controlling|dominat|dictat|bossing|on top|ran the game|owned)\b/i.test(
    fullQuery,
  );
}

function isControlStatFact(fact: RetrievedFact) {
  if (!fact.source.includes('stats:')) {
    return false;
  }

  return /\b(possession|expected-goals|xg|shots-on-target|total-shots|shots|big-chances|goals)\b/i.test(
    fact.source,
  );
}

function isPeripheralStatFact(fact: RetrievedFact) {
  if (!fact.source.includes('stats:')) {
    return false;
  }

  return /\b(corners|yellowcards|redcards|cards|fouls|dribbles)\b/i.test(fact.source);
}

export function buildBoothAssistFacts(params: {
  retrieval: RetrievalState;
  contextBundle?: ContextBundle;
  preMatch?: PreMatchState;
  liveMatch?: LiveMatchState;
  socialPosts?: SocialPost[];
  visionCues?: VisionCue[];
  recentEvents?: GameEvent[];
}): RetrievedFact[] {
  const facts = [...params.retrieval.supportingFacts];

  if (params.preMatch && params.preMatch.loadStatus !== 'pending') {
    facts.push(
      createSyntheticFact({
        id: 'booth-pre-match-form-home',
        tier: 'pre_match',
        text: `${params.preMatch.homeRecentForm.teamName} recent form: ${params.preMatch.homeRecentForm.record.wins}-${params.preMatch.homeRecentForm.record.draws}-${params.preMatch.homeRecentForm.record.losses} across the last ${params.preMatch.homeRecentForm.lastFive.length}.`,
        source: 'pre-match:recent-form',
        timestamp: params.preMatch.generatedAt,
        relevance: 0.7,
        metadata: {
          chunkCategory: 'recent-form',
          teamSide: 'home',
          phaseHints: ['pre_kickoff', 'early_match', 'quiet_stretch'],
        },
      }),
      createSyntheticFact({
        id: 'booth-pre-match-form-away',
        tier: 'pre_match',
        text: `${params.preMatch.awayRecentForm.teamName} recent form: ${params.preMatch.awayRecentForm.record.wins}-${params.preMatch.awayRecentForm.record.draws}-${params.preMatch.awayRecentForm.record.losses} across the last ${params.preMatch.awayRecentForm.lastFive.length}.`,
        source: 'pre-match:recent-form',
        timestamp: params.preMatch.generatedAt,
        relevance: 0.7,
        metadata: {
          chunkCategory: 'recent-form',
          teamSide: 'away',
          phaseHints: ['pre_kickoff', 'early_match', 'quiet_stretch'],
        },
      }),
      createSyntheticFact({
        id: 'booth-pre-match-head-to-head',
        tier: 'pre_match',
        text: params.preMatch.headToHead.summary,
        source: 'pre-match:head-to-head',
        timestamp: params.preMatch.generatedAt,
        relevance: 0.72,
        metadata: {
          chunkCategory: 'head-to-head',
          phaseHints: ['pre_kickoff', 'early_match', 'quiet_stretch'],
        },
      }),
      createSyntheticFact({
        id: 'booth-pre-match-venue',
        tier: 'pre_match',
        text: `Venue: ${[params.preMatch.venue.name, params.preMatch.venue.city, params.preMatch.venue.country]
          .filter(Boolean)
          .join(', ')}.`,
        source: 'pre-match:venue',
        timestamp: params.preMatch.generatedAt,
        relevance: 0.62,
        metadata: {
          chunkCategory: 'venue',
          phaseHints: ['pre_kickoff', 'early_match', 'quiet_stretch'],
        },
      }),
      createSyntheticFact({
        id: 'booth-pre-match-opener',
        tier: 'pre_match',
        text: params.preMatch.aiOpener ?? params.preMatch.deterministicOpener,
        source: 'pre-match:opener',
        timestamp: params.preMatch.generatedAt,
        relevance: 0.66,
        metadata: {
          chunkCategory: 'opener',
          phaseHints: ['pre_kickoff', 'early_match', 'quiet_stretch'],
        },
      }),
    );

    if (params.preMatch.weather) {
      facts.push(
        createSyntheticFact({
          id: 'booth-pre-match-weather',
          tier: 'pre_match',
          text: `Weather: ${params.preMatch.weather.summary}${
            params.preMatch.weather.temperatureC !== null
              ? ` at ${Math.round(params.preMatch.weather.temperatureC)}C`
              : ''
          }.`,
          source: 'pre-match:weather',
          timestamp: params.preMatch.generatedAt,
          relevance: 0.61,
          metadata: {
            chunkCategory: 'weather',
            phaseHints: ['pre_kickoff', 'early_match', 'quiet_stretch'],
          },
        }),
      );
    }
  }

  if (params.liveMatch) {
    [...params.liveMatch.stats]
      .sort((left, right) => getStatPriority(right.label) - getStatPriority(left.label))
      .slice(0, MAX_LIVE_STAT_FACTS)
      .forEach((stat, index) => {
      facts.push(
        createSyntheticFact({
          id: `booth-live-stat-${stat.teamSide}-${index}`,
          tier: 'live',
          text: `${stat.teamSide === 'home' ? params.liveMatch?.homeTeam.name : params.liveMatch?.awayTeam.name} ${stat.label}: ${stat.value}`,
          source: `stats:${normalizeStatLabel(stat.label)}`,
          timestamp: params.liveMatch?.lastUpdatedAt ?? Date.now(),
          relevance: 0.69,
          metadata: {
            teamSide: stat.teamSide,
          },
        }),
      );
      });
  }

  (params.recentEvents ?? []).slice(0, 4).forEach((event) => {
    facts.push(
      createSyntheticFact({
        id: `booth-recent-event-${event.id}`,
        tier: 'session',
        text: event.description,
        source: `event-feed:${event.type.toLowerCase()}`,
        timestamp: event.timestamp,
        relevance: event.highSalience ? 0.82 : 0.64,
      }),
    );
  });

  (params.socialPosts ?? []).slice(-4).forEach((post, index) => {
    facts.push(
      createSyntheticFact({
        id: `booth-social-${post.timestamp}-${index}`,
        tier: 'live',
        text: `${post.handle}: ${post.text}`,
        source: `social:${post.handle}`,
        timestamp: post.timestamp,
        relevance: 0.74,
      }),
    );
  });

  (params.visionCues ?? []).slice(-4).forEach((cue, index) => {
    facts.push(
      createSyntheticFact({
        id: `booth-vision-${cue.timestamp}-${index}`,
        tier: 'live',
        text: `Vision cue: ${cue.label}`,
        source: `vision:${cue.tag}`,
        timestamp: cue.timestamp,
        relevance: 0.66,
      }),
    );
  });

  (params.contextBundle?.items ?? []).forEach((item, index) => {
    facts.push(
      createSyntheticFact({
        id: `booth-context-bundle-${item.id}-${index}`,
        tier: item.lane === 'pre-match' ? 'pre_match' : 'session',
        text: `${item.headline}: ${item.detail}`,
        source: `context-bundle:${item.lane}`,
        timestamp: item.expiresAt ?? Date.now(),
        relevance: item.salience,
      }),
    );
  });

  return dedupeFacts(facts);
}

function scoreFact(
  fact: RetrievedFact,
  queryTokens: string[],
  fullQuery: string,
  liveMatch?: LiveMatchState,
) {
  let score = fact.relevance;
  const factTokens = new Set(tokenize(fact.text));
  const overlap = queryTokens.filter((token) => factTokens.has(token)).length;
  const isPlayQuery = /\b(save|chance|play|shot|sequence|move|moment|attack|counter)\b/i.test(fullQuery);
  const queryTeamSide = inferQueryTeamSide(fullQuery, liveMatch);
  const controlQuery = isControlQuery(fullQuery);

  score += overlap * 0.12;

  if (fact.tier === 'live') {
    score += 0.08;
  }
  if (fact.tier === 'pre_match') {
    score += 0.04;
  }

  if (fact.source.includes('social:') && /\b(fans?|reaction|social|online|buzz)\b/i.test(fullQuery)) {
    score += 0.28;
  }
  if (
    fact.metadata?.chunkCategory &&
    /\b(form|history|meeting|head|venue|weather|setup|coming in|tonight)\b/i.test(fullQuery)
  ) {
    score += 0.24;
  }
  if (fact.source.includes('stats:') && /\b(stat|number|possession|shots|corners)\b/i.test(fullQuery)) {
    score += 0.24;
  }
  if (fact.source.includes('stats:') && queryTeamSide && fact.metadata?.teamSide === queryTeamSide) {
    score += 0.26;
  }
  if (fact.source.includes('stats:') && queryTeamSide && fact.metadata?.teamSide && fact.metadata.teamSide !== queryTeamSide) {
    score -= 0.18;
  }
  if (fact.source.includes('stats:') && controlQuery && isControlStatFact(fact)) {
    score += 0.22;
  }
  if (fact.source.includes('stats:') && controlQuery && isPeripheralStatFact(fact)) {
    score -= 0.16;
  }
  if (fact.source.includes('event-feed:') && isPlayQuery) {
    score += 0.28;
  }

  return score;
}

export function rankBoothAssistFacts({
  facts,
  boothTranscript,
  interimTranscript,
  liveMatch,
  limit = facts.length,
}: {
  facts: RetrievedFact[];
  boothTranscript: TranscriptEntry[];
  interimTranscript: string;
  liveMatch?: LiveMatchState;
  limit?: number;
}) {
  const fullQuery = getBoothAssistQuery({ boothTranscript, interimTranscript });
  const queryTokens = tokenize(fullQuery);

  return facts
    .map((fact) => ({
      fact,
      score: scoreFact(fact, queryTokens, fullQuery, liveMatch),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function buildHintFromFact(fact: RetrievedFact) {
  const cleanText = cleanFactText(fact.text);

  if (fact.source.includes('social:')) {
    return {
      type: 'context' as const,
      text: `Bring in the fan reaction: ${cleanText}.`,
      whyNow: 'You paused on a crowd-reaction angle, so use the live social pulse.',
    };
  }

  if (fact.metadata?.chunkCategory === 'recent-form' || fact.metadata?.chunkCategory === 'trend') {
    return {
      type: 'context' as const,
      text: `Go back to the setup: ${cleanText}.`,
      whyNow: 'You were leaning into the match setup and left a pause.',
    };
  }

  if (fact.metadata?.chunkCategory === 'head-to-head') {
    return {
      type: 'context' as const,
      text: `Use the rivalry context: ${cleanText}.`,
      whyNow: 'A short history note can bridge this hesitation cleanly.',
    };
  }

  if (fact.metadata?.chunkCategory === 'venue' || fact.metadata?.chunkCategory === 'weather') {
    return {
      type: 'transition' as const,
      text: `Set the scene: ${cleanText}.`,
      whyNow: 'You paused while scene-setting, so anchor the environment.',
    };
  }

  if (fact.source.includes('stats:')) {
    return {
      type: 'stat' as const,
      text: `Use the number: ${cleanText}.`,
      whyNow: 'A single stat can rescue the pause without forcing a big reset.',
    };
  }

  if (fact.source.includes('event-feed:')) {
    return {
      type: 'transition' as const,
      text: `Pick up the live moment: ${cleanText}.`,
      whyNow: 'Tie the call back to the last live action you were describing.',
    };
  }

  return {
    type: 'context' as const,
    text: cleanText,
    whyNow: 'Use the strongest grounded detail to restart the call.',
  };
}

export function buildBoothAssist(params: {
  boothSignal: BoothSignal;
  boothTranscript: TranscriptEntry[];
  interimTranscript: string;
  currentTimestampMs: number;
  retrieval: RetrievalState;
  contextBundle?: ContextBundle;
  preMatch?: PreMatchState;
  liveMatch?: LiveMatchState;
  socialPosts?: SocialPost[];
  visionCues?: VisionCue[];
  recentEvents?: GameEvent[];
}): AssistCard {
  const {
    boothSignal,
    boothTranscript,
    interimTranscript,
    currentTimestampMs,
    retrieval,
    contextBundle,
    preMatch,
    liveMatch,
    socialPosts = [],
    visionCues = [],
    recentEvents = [],
  } = params;

  if (!boothSignal.shouldSurfaceAssist) {
    return createEmptyAssistCard();
  }

  const currentLine = getBoothAssistQuery({ boothTranscript, interimTranscript });
  const hasFreshQuery = hasFreshTranscript({
    boothTranscript,
    interimTranscript,
    currentTimestampMs,
  });
  const intent = hasFreshQuery ? inferBoothIntent(currentLine) : 'generic';
  const candidateFacts = buildBoothAssistFacts({
    retrieval,
    contextBundle,
    preMatch,
    liveMatch,
    socialPosts,
    visionCues,
    recentEvents,
  });
  const rankedFacts = rankBoothAssistFacts({
    facts: candidateFacts,
    boothTranscript,
    interimTranscript,
    liveMatch,
  });
  const novelRankedFacts = rankedFacts.filter(({ fact }) => {
    return !isFactCoveredByTranscript({
      fact,
      boothTranscript,
      interimTranscript,
      currentTimestampMs,
    });
  });
  const topFact =
    novelRankedFacts.find(({ fact }) => factMatchesIntent(fact, intent))?.fact ??
    (intent === 'generic' ? novelRankedFacts[0]?.fact : undefined);

  if (!topFact) {
    const groundedFallback = buildGroundedFallback({
      intent,
      rankedFacts: novelRankedFacts.map(({ fact }) => fact),
      currentLine,
    });

    if (groundedFallback.sourceFacts.length === 0 && rankedFacts.length > 0) {
      return createEmptyAssistCard();
    }

    return {
      ...createEmptyAssistCard(),
      type: groundedFallback.type,
      text: groundedFallback.text,
      confidence: clamp(0.42 + boothSignal.hesitationScore * 0.3),
      whyNow: currentLine
        ? `${groundedFallback.whyNow} You paused after ${quoteExcerpt(currentLine)}.`
        : groundedFallback.whyNow,
      sourceChips: groundedFallback.sourceFacts.map((fact) => fact.sourceChip),
    };
  }

  const grounded = buildHintFromFact(topFact);

  return {
    ...createEmptyAssistCard(),
    type: grounded.type,
    text: grounded.text,
    confidence: clamp(0.5 + boothSignal.hesitationScore * 0.38),
    whyNow: currentLine
      ? `${grounded.whyNow} You paused after ${quoteExcerpt(currentLine)}.`
      : grounded.whyNow,
    sourceChips: novelRankedFacts.slice(0, 2).map(({ fact }) => fact.sourceChip),
  };
}
