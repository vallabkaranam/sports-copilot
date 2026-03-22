import { describe, expect, it } from 'vitest';
import {
  createEmptyLiveMatchState,
  createEmptyPreMatchState,
  createEmptyRetrievalState,
  RetrievedFact,
  TranscriptEntry,
} from '@sports-copilot/shared-types';
import { buildBoothAssist, rankBoothAssistFacts } from './boothAssist';
import type { BoothSignal } from './boothSignal';

function makeSignal(overrides: Partial<BoothSignal> = {}): BoothSignal {
  return {
    activeSpeaker: 'none',
    hesitationScore: 0.68,
    confidenceScore: 0.2,
    hesitationReasons: ['You paused.'],
    hesitationContributors: [],
    confidenceReasons: [],
    confidenceContributors: [],
    pauseDurationMs: 2600,
    speechStreakMs: 0,
    silenceStreakMs: 2600,
    fillerCount: 0,
    fillerDensity: 0,
    fillerWords: [],
    repeatedOpeningCount: 0,
    repeatedPhrases: [],
    transcriptWordCount: 0,
    transcriptStabilityScore: 0,
    unfinishedPhrase: false,
    wakePhraseDetected: false,
    isSpeaking: false,
    audioLevel: 0.02,
    hasVoiceActivity: false,
    shouldSurfaceAssist: true,
    ...overrides,
  };
}

function makeTranscript(text: string): TranscriptEntry[] {
  return [
    {
      timestamp: 1000,
      speaker: 'lead',
      text,
    },
  ];
}

function makeFact(partial: Partial<RetrievedFact> & Pick<RetrievedFact, 'id' | 'tier' | 'text' | 'source'>): RetrievedFact {
  return {
    timestamp: 1000,
    relevance: 0.7,
    sourceChip: {
      id: partial.id,
      label: partial.text,
      source: `${partial.tier}:${partial.source}`,
      relevance: partial.relevance ?? 0.7,
      metadata: partial.metadata,
    },
    ...partial,
  };
}

describe('buildBoothAssist', () => {
  it('ranks social facts first when the transcript is about fan reaction', () => {
    const ranked = rankBoothAssistFacts({
      facts: [
        makeFact({
          id: 'social',
          tier: 'live',
          text: '@matchday: Fans are calling that save unbelievable.',
          source: 'social:@matchday',
          relevance: 0.8,
        }),
        makeFact({
          id: 'stat',
          tier: 'live',
          text: 'Barcelona possession: 58%.',
          source: 'stats:possession',
          relevance: 0.8,
        }),
      ],
      boothTranscript: makeTranscript('Fans are really reacting to that save'),
      interimTranscript: '',
      limit: 2,
    });

    expect(ranked[0]?.fact.source).toContain('social');
  });

  it('ranks stats first when the transcript is about numbers', () => {
    const ranked = rankBoothAssistFacts({
      facts: [
        makeFact({
          id: 'social',
          tier: 'live',
          text: '@matchday: Fans are calling that save unbelievable.',
          source: 'social:@matchday',
          relevance: 0.8,
        }),
        makeFact({
          id: 'stat',
          tier: 'live',
          text: 'Barcelona possession: 58%.',
          source: 'stats:possession',
          relevance: 0.68,
        }),
      ],
      boothTranscript: makeTranscript('The numbers tell you Barcelona have more possession'),
      interimTranscript: '',
      limit: 2,
    });

    expect(ranked[0]?.fact.source).toContain('stats:');
  });

  it('ranks live event facts first when the transcript is about the play', () => {
    const ranked = rankBoothAssistFacts({
      facts: [
        makeFact({
          id: 'event',
          tier: 'session',
          text: 'Courtois stands tall to deny Barcelona from close range.',
          source: 'event-feed:save',
          relevance: 0.7,
        }),
        makeFact({
          id: 'form',
          tier: 'pre_match',
          text: 'Barcelona recent form: 3-1-1 across the last 5.',
          source: 'pre-match:recent-form',
          relevance: 0.72,
          metadata: {
            chunkCategory: 'recent-form',
            teamSide: 'home',
            phaseHints: ['pre_kickoff'],
          },
        }),
      ],
      boothTranscript: makeTranscript('That save changes the whole play'),
      interimTranscript: '',
      limit: 2,
    });

    expect(ranked[0]?.fact.source).toContain('event-feed:');
  });

  it('uses live social reaction when the speaker references fan reaction', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: makeTranscript('Fans are really reacting to that save and then I lost it'),
      interimTranscript: '',
      currentTimestampMs: 1000,
      retrieval: {
        ...createEmptyRetrievalState(),
        supportingFacts: [
          {
            id: 'live-social-1',
            tier: 'live',
            text: '@matchday: Fans are calling that save unbelievable.',
            source: 'social:@matchday',
            timestamp: 1000,
            relevance: 0.84,
            sourceChip: {
              id: 'live-social-1',
              label: 'Fans are calling that save unbelievable.',
              source: 'live:social:@matchday',
              relevance: 0.84,
            },
          },
        ],
      },
    });

    expect(assist.text.toLowerCase()).toMatch(/reaction|fan pulse|crowd/);
    expect(assist.sourceChips[0]?.source).toContain('social');
  });

  it('uses pre-match setup context when the speaker is framing the match', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: makeTranscript('I was talking about the form coming into this match'),
      interimTranscript: '',
      currentTimestampMs: 1000,
      retrieval: {
        ...createEmptyRetrievalState(),
        supportingFacts: [
          {
            id: 'pre-match-form-home',
            tier: 'pre_match',
            text: 'Barcelona recent form: 3-1-1 across the last 5.',
            source: 'pre-match:recent-form',
            timestamp: 1000,
            relevance: 0.72,
            metadata: {
              chunkCategory: 'recent-form',
              teamSide: 'home',
              phaseHints: ['pre_kickoff', 'early_match'],
            },
            sourceChip: {
              id: 'pre-match-form-home',
              label: 'Barcelona recent form: 3-1-1 across the last 5.',
              source: 'pre_match:pre-match:recent-form',
              relevance: 0.72,
              metadata: {
                chunkCategory: 'recent-form',
                teamSide: 'home',
                phaseHints: ['pre_kickoff', 'early_match'],
              },
            },
          },
        ],
      },
    });

    expect(assist.text.toLowerCase()).toMatch(/setup|match frame|opening thought/);
    expect(assist.sourceChips[0]?.metadata?.chunkCategory).toBe('recent-form');
  });

  it('uses stat-led wording when the speaker is reaching for numbers', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: makeTranscript('The numbers really tell the story here'),
      interimTranscript: '',
      currentTimestampMs: 1000,
      retrieval: {
        ...createEmptyRetrievalState(),
        supportingFacts: [
          {
            id: 'live-stat-1',
            tier: 'live',
            text: 'Barcelona possession: 58%.',
            source: 'stats:possession',
            timestamp: 1000,
            relevance: 0.82,
            sourceChip: {
              id: 'live-stat-1',
              label: 'Barcelona possession: 58%.',
              source: 'live:stats:possession',
              relevance: 0.82,
            },
          },
        ],
      },
    });

    expect(assist.type).toBe('stat');
    expect(assist.text.toLowerCase()).toMatch(/number|stat|metric/);
  });

  it('still produces a grounded pre-match hint when retrieval is empty', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: makeTranscript('Let me reset the setup and the weather here'),
      interimTranscript: '',
      currentTimestampMs: 1000,
      retrieval: createEmptyRetrievalState(),
      preMatch: {
        ...createEmptyPreMatchState(),
        loadStatus: 'ready',
        generatedAt: 1000,
        homeRecentForm: {
          teamSide: 'home',
          teamName: 'Barcelona',
          record: { wins: 3, draws: 1, losses: 1 },
          lastFive: [],
        },
        awayRecentForm: {
          teamSide: 'away',
          teamName: 'Real Madrid',
          record: { wins: 4, draws: 0, losses: 1 },
          lastFive: [],
        },
        headToHead: {
          meetings: [],
          homeWins: 2,
          awayWins: 2,
          draws: 1,
          summary: 'Barcelona and Real Madrid have split the last five meetings.',
        },
        venue: {
          name: 'Estadi Olimpic',
          city: 'Barcelona',
          country: 'Spain',
          capacity: null,
          surface: null,
        },
        weather: {
          summary: 'Clear skies',
          temperatureC: 18,
          windKph: 8,
          precipitationMm: 0,
          source: 'open-meteo',
          isFallback: true,
        },
        deterministicOpener: 'Barcelona arrive with form and clear weather over the stadium.',
        aiOpener: null,
        sourceMetadata: {
          provider: 'sportmonks',
          fetchedAt: 1000,
          sourceNotes: [],
          usedWeatherFallback: true,
        },
      },
      liveMatch: createEmptyLiveMatchState(),
    });

    expect(assist.type).not.toBe('none');
    expect(assist.text).not.toContain('Reset with one clean scene line');
    expect(assist.sourceChips.length).toBeGreaterThan(0);
  });

  it('uses a neutral stat bridge when the speaker wants numbers but no stat facts exist', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: makeTranscript('The numbers tell you the story here'),
      interimTranscript: '',
      currentTimestampMs: 1000,
      retrieval: createEmptyRetrievalState(),
      liveMatch: createEmptyLiveMatchState(),
    });

    expect(assist.type).toBe('stat');
    expect(assist.text.toLowerCase()).toMatch(/number/);
    expect(assist.text).not.toContain('Fans are already losing it over every Madrid counter');
    expect(assist.sourceChips).toHaveLength(0);
  });

  it('uses a neutral live-play bridge when the speaker wants the moment but no event facts exist', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: makeTranscript('That save changes the whole sequence'),
      interimTranscript: '',
      currentTimestampMs: 1000,
      retrieval: createEmptyRetrievalState(),
      liveMatch: createEmptyLiveMatchState(),
    });

    expect(assist.type).toBe('transition');
    expect(assist.text.toLowerCase()).toMatch(/moment|effect|clean line/);
    expect(assist.text).not.toContain('Fans are already losing it over every Madrid counter');
    expect(assist.sourceChips).toHaveLength(0);
  });

  it('uses a neutral crowd bridge when the speaker wants reaction but no social facts exist', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: makeTranscript('Fans are reacting to this one'),
      interimTranscript: '',
      currentTimestampMs: 1000,
      retrieval: createEmptyRetrievalState(),
      liveMatch: createEmptyLiveMatchState(),
    });

    expect(assist.type).toBe('context');
    expect(assist.text.toLowerCase()).toMatch(/audience angle|reaction beat/);
    expect(assist.text).not.toContain('Fans are already losing it over every Madrid counter');
    expect(assist.sourceChips).toHaveLength(0);
  });

  it('falls back to a generic bridge when the transcript is stale', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: makeTranscript('Fans are reacting to this one'),
      interimTranscript: '',
      currentTimestampMs: 10_000,
      retrieval: createEmptyRetrievalState(),
      liveMatch: createEmptyLiveMatchState(),
    });

    expect(assist.type).toBe('transition');
    expect(assist.text).toContain('Reset with one clean scene line');
    expect(assist.sourceChips).toHaveLength(0);
  });

  it('returns no assist when visibility is gated elsewhere', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal({ shouldSurfaceAssist: false }),
      boothTranscript: makeTranscript('steady call'),
      interimTranscript: '',
      currentTimestampMs: 1000,
      retrieval: createEmptyRetrievalState(),
    });

    expect(assist.type).toBe('none');
  });
});
