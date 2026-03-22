import {
  AssistCard,
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

function normalizeText(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(text: string) {
  return normalizeText(text)
    .split(' ')
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
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

const TRANSCRIPT_FRESHNESS_WINDOW_MS = 7_000;

type BoothIntent = 'social' | 'stats' | 'live-play' | 'setup' | 'generic';

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

function buildNeutralHint(intent: BoothIntent) {
  switch (intent) {
    case 'social':
      return {
        type: 'context' as const,
        text: 'Reset with the audience angle, then land one clean reaction beat.',
        whyNow: 'You sounded like you were reaching for reaction, but the live social facts are thin.',
      };
    case 'stats':
      return {
        type: 'stat' as const,
        text: 'Reset with one number, then connect it back to the flow of the match.',
        whyNow: 'You were reaching for a stat, but there is not a strong live number to quote cleanly here.',
      };
    case 'live-play':
      return {
        type: 'transition' as const,
        text: 'Go back to the moment itself, then describe its effect in one clean line.',
        whyNow: 'You were trying to land the live play, but the freshest event detail is thin right now.',
      };
    case 'setup':
      return {
        type: 'context' as const,
        text: 'Reframe the setup in one line, then bring it back to what this moment means.',
        whyNow: 'You were scene-setting, but the supporting setup facts are thin right now.',
      };
    case 'generic':
      return {
        type: 'transition' as const,
        text: 'Reset with one clean scene line, then land a single takeaway.',
        whyNow: 'Use a short bridge to recover the flow without forcing a bigger restart.',
      };
  }
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

export function buildBoothAssistFacts(params: {
  retrieval: RetrievalState;
  preMatch?: PreMatchState;
  liveMatch?: LiveMatchState;
  socialPosts?: SocialPost[];
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
    params.liveMatch.stats.slice(0, 4).forEach((stat, index) => {
      facts.push(
        createSyntheticFact({
          id: `booth-live-stat-${stat.teamSide}-${index}`,
          tier: 'live',
          text: `${stat.teamSide === 'home' ? params.liveMatch?.homeTeam.name : params.liveMatch?.awayTeam.name} ${stat.label}: ${stat.value}`,
          source: `stats:${stat.label.toLowerCase().replace(/\s+/g, '-')}`,
          timestamp: params.liveMatch?.lastUpdatedAt ?? Date.now(),
          relevance: 0.69,
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

  return facts;
}

function scoreFact(fact: RetrievedFact, queryTokens: string[], fullQuery: string) {
  let score = fact.relevance;
  const factTokens = new Set(tokenize(fact.text));
  const overlap = queryTokens.filter((token) => factTokens.has(token)).length;
  const isPlayQuery = /\b(save|chance|play|shot|sequence|move|moment|attack|counter)\b/i.test(fullQuery);

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
  if (fact.source.includes('event-feed:') && isPlayQuery) {
    score += 0.28;
  }

  return score;
}

export function rankBoothAssistFacts({
  facts,
  boothTranscript,
  interimTranscript,
  limit = facts.length,
}: {
  facts: RetrievedFact[];
  boothTranscript: TranscriptEntry[];
  interimTranscript: string;
  limit?: number;
}) {
  const fullQuery = getBoothAssistQuery({ boothTranscript, interimTranscript });
  const queryTokens = tokenize(fullQuery);

  return facts
    .map((fact) => ({
      fact,
      score: scoreFact(fact, queryTokens, fullQuery),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function buildHintFromFact(fact: RetrievedFact) {
  const cleanText = cleanFactText(fact.text);

  if (fact.source.includes('social:')) {
    return {
      type: 'context' as const,
      text: `Bring in the fan reaction: ${cleanText}`,
      whyNow: 'You paused on a crowd-reaction angle, so use the live social pulse.',
    };
  }

  if (fact.metadata?.chunkCategory === 'recent-form' || fact.metadata?.chunkCategory === 'trend') {
    return {
      type: 'context' as const,
      text: `Go back to the setup: ${cleanText}`,
      whyNow: 'You were leaning into the match setup and left a pause.',
    };
  }

  if (fact.metadata?.chunkCategory === 'head-to-head') {
    return {
      type: 'context' as const,
      text: `Use the rivalry context: ${cleanText}`,
      whyNow: 'A short history note can bridge this hesitation cleanly.',
    };
  }

  if (fact.metadata?.chunkCategory === 'venue' || fact.metadata?.chunkCategory === 'weather') {
    return {
      type: 'transition' as const,
      text: `Set the scene: ${cleanText}`,
      whyNow: 'You paused while scene-setting, so anchor the environment.',
    };
  }

  if (fact.source.includes('stats:')) {
    return {
      type: 'stat' as const,
      text: `Use the number: ${cleanText}`,
      whyNow: 'A single stat can rescue the pause without forcing a big reset.',
    };
  }

  if (fact.source.includes('event-feed:')) {
    return {
      type: 'transition' as const,
      text: `Pick up the live moment: ${cleanText}`,
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
  preMatch?: PreMatchState;
  liveMatch?: LiveMatchState;
  socialPosts?: SocialPost[];
  recentEvents?: GameEvent[];
}): AssistCard {
  const {
    boothSignal,
    boothTranscript,
    interimTranscript,
    currentTimestampMs,
    retrieval,
    preMatch,
    liveMatch,
    socialPosts = [],
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
    preMatch,
    liveMatch,
    socialPosts,
    recentEvents,
  });
  const rankedFacts = rankBoothAssistFacts({
    facts: candidateFacts,
    boothTranscript,
    interimTranscript,
  });
  const topFact =
    rankedFacts.find(({ fact }) => factMatchesIntent(fact, intent))?.fact ??
    (intent === 'generic' ? rankedFacts[0]?.fact : undefined);

  if (!topFact) {
    const fallback = buildNeutralHint(intent);

    return {
      ...createEmptyAssistCard(),
      type: fallback.type,
      text: fallback.text,
      confidence: clamp(0.42 + boothSignal.hesitationScore * 0.3),
      whyNow: currentLine
        ? `${fallback.whyNow} You paused after ${quoteExcerpt(currentLine)}.`
        : fallback.whyNow,
      sourceChips: [],
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
    sourceChips: rankedFacts.slice(0, 2).map(({ fact }) => fact.sourceChip),
  };
}
