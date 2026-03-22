import { describe, expect, it } from 'vitest';
import {
  createEmptyContextBundle,
  createEmptyLiveMatchState,
  createEmptyPreMatchState,
  createEmptyRetrievalState,
  RetrievedFact,
  TranscriptEntry,
} from '@sports-copilot/shared-types';
import { buildBoothAssist, deriveExcludedCueTexts, rankBoothAssistFacts } from './boothAssist';
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
    wordsPerMinute: 0,
    pacePressureScore: 0,
    repeatedIdeaCount: 0,
    repeatedIdeaPhrases: [],
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

  it('prefers the queried team control stats over the other team corners', () => {
    const liveMatch = {
      ...createEmptyLiveMatchState(),
      homeTeam: {
        id: '62',
        name: 'Rangers',
        shortCode: 'RAN',
        logoUrl: null,
      },
      awayTeam: {
        id: '273',
        name: 'Aberdeen',
        shortCode: 'ABE',
        logoUrl: null,
      },
    };

    const ranked = rankBoothAssistFacts({
      facts: [
        makeFact({
          id: 'away-corners',
          tier: 'live',
          text: 'Aberdeen Corners: 4',
          source: 'stats:corners',
          relevance: 0.84,
          metadata: {
            teamSide: 'away',
          },
        }),
        makeFact({
          id: 'home-possession',
          tier: 'live',
          text: 'Rangers Ball Possession %: 62',
          source: 'stats:ball-possession',
          relevance: 0.69,
          metadata: {
            teamSide: 'home',
          },
        }),
        makeFact({
          id: 'home-goals',
          tier: 'live',
          text: 'Rangers Goals: 4',
          source: 'stats:goals',
          relevance: 0.69,
          metadata: {
            teamSide: 'home',
          },
        }),
      ],
      boothTranscript: makeTranscript('The numbers tell you Rangers controlled this match because'),
      interimTranscript: '',
      liveMatch,
      limit: 3,
    });

    expect(ranked[0]?.fact.text).toContain('Rangers');
    expect(ranked[0]?.fact.source).not.toContain('corners');
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

  it('uses control stats for a Rangers control line instead of away corners', () => {
    const liveMatch = {
      ...createEmptyLiveMatchState(),
      homeTeam: {
        id: '62',
        name: 'Rangers',
        shortCode: 'RAN',
        logoUrl: null,
      },
      awayTeam: {
        id: '273',
        name: 'Aberdeen',
        shortCode: 'ABE',
        logoUrl: null,
      },
      stats: [
        {
          teamSide: 'away' as const,
          label: 'Corners',
          value: '4',
        },
        {
          teamSide: 'home' as const,
          label: 'Ball Possession %',
          value: '62',
        },
        {
          teamSide: 'home' as const,
          label: 'Goals',
          value: '4',
        },
      ],
    };

    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: makeTranscript('The numbers tell you Rangers controlled this match because'),
      interimTranscript: '',
      currentTimestampMs: 1000,
      retrieval: createEmptyRetrievalState(),
      liveMatch,
    });

    expect(assist.type).toBe('stat');
    expect(assist.text).toContain('Rangers');
    expect(assist.text).not.toContain('Aberdeen Corners');
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
    expect(assist.text).toMatch(/setup|scene|weather|Barcelona|Madrid/i);
    expect(assist.sourceChips.length).toBeGreaterThan(0);
  });

  it('prefers the head-to-head fact for a head-to-head setup line', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: makeTranscript('The head-to-head between Rangers and Aberdeen tells you'),
      interimTranscript: '',
      currentTimestampMs: 1000,
      retrieval: createEmptyRetrievalState(),
      preMatch: {
        ...createEmptyPreMatchState(),
        loadStatus: 'ready',
        generatedAt: 1000,
        homeRecentForm: {
          teamSide: 'home',
          teamName: 'Rangers',
          record: { wins: 3, draws: 1, losses: 1 },
          lastFive: [],
        },
        awayRecentForm: {
          teamSide: 'away',
          teamName: 'Aberdeen',
          record: { wins: 1, draws: 2, losses: 2 },
          lastFive: [],
        },
        headToHead: {
          meetings: [],
          homeWins: 3,
          awayWins: 1,
          draws: 1,
          summary: 'Rangers have had the better of the last five meetings with Aberdeen.',
        },
        venue: {
          name: 'Ibrox Stadium',
          city: 'Glasgow',
          country: 'Scotland',
          capacity: null,
          surface: null,
        },
        weather: null,
        deterministicOpener: 'Rangers and Aberdeen bring a familiar rivalry into Ibrox.',
        aiOpener: null,
        sourceMetadata: {
          provider: 'sportmonks',
          fetchedAt: 1000,
          sourceNotes: [],
          usedWeatherFallback: false,
        },
      },
      liveMatch: {
        ...createEmptyLiveMatchState(),
        stats: [{ teamSide: 'home', label: 'Possession', value: '62%' }],
      },
    });

    expect(assist.text).toMatch(/Rangers have had the better of the last five meetings/i);
    expect(assist.text).not.toMatch(/Possession/i);
  });

  it('prefers recent form for a recent-form setup line', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: makeTranscript("Coming into this match, Rangers' recent form really stands out because"),
      interimTranscript: '',
      currentTimestampMs: 1000,
      retrieval: createEmptyRetrievalState(),
      preMatch: {
        ...createEmptyPreMatchState(),
        loadStatus: 'ready',
        generatedAt: 1000,
        homeRecentForm: {
          teamSide: 'home',
          teamName: 'Rangers',
          record: { wins: 4, draws: 0, losses: 1 },
          lastFive: [],
        },
        awayRecentForm: {
          teamSide: 'away',
          teamName: 'Aberdeen',
          record: { wins: 1, draws: 2, losses: 2 },
          lastFive: [],
        },
        headToHead: {
          meetings: [],
          homeWins: 3,
          awayWins: 1,
          draws: 1,
          summary: 'Rangers have had the better of the last five meetings with Aberdeen.',
        },
        venue: {
          name: 'Ibrox Stadium',
          city: 'Glasgow',
          country: 'Scotland',
          capacity: null,
          surface: null,
        },
        weather: null,
        deterministicOpener: 'Rangers arrive in stronger recent form.',
        aiOpener: null,
        sourceMetadata: {
          provider: 'sportmonks',
          fetchedAt: 1000,
          sourceNotes: [],
          usedWeatherFallback: false,
        },
      },
      liveMatch: {
        ...createEmptyLiveMatchState(),
        stats: [{ teamSide: 'away', label: 'Corners', value: '4' }],
      },
    });

    expect(assist.text).toMatch(/Rangers recent form: 4-0-1/i);
    expect(assist.text).not.toMatch(/Corners/i);
  });

  it('uses live match stats instead of a generic stat bridge when numbers are needed', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: makeTranscript('The numbers tell you the story here'),
      interimTranscript: '',
      currentTimestampMs: 1000,
      retrieval: createEmptyRetrievalState(),
      liveMatch: {
        ...createEmptyLiveMatchState(),
        homeTeam: {
          ...createEmptyLiveMatchState().homeTeam,
          name: 'Barcelona',
          shortCode: 'BAR',
        },
        awayTeam: {
          ...createEmptyLiveMatchState().awayTeam,
          name: 'Real Madrid',
          shortCode: 'RMA',
        },
        stats: [
          { teamSide: 'home', label: 'Possession', value: '58%' },
        ],
      },
    });

    expect(assist.type).toBe('stat');
    expect(assist.text).toMatch(/Barcelona|58%|Possession/);
    expect(assist.sourceChips.length).toBeGreaterThan(0);
  });

  it('uses context-bundle live items instead of a generic live-play bridge', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: makeTranscript('That save changes the whole sequence'),
      interimTranscript: '',
      currentTimestampMs: 1000,
      retrieval: createEmptyRetrievalState(),
      contextBundle: {
        ...createEmptyContextBundle(),
        summary: 'Courtois save keeps Madrid alive.',
        items: [
          {
            id: 'bundle-save',
            lane: 'live-moment',
            headline: 'Live moment',
            detail: 'Courtois keeps Madrid alive with a sharp stop from close range.',
            expiresAt: 10_000,
            salience: 0.91,
            sourceChip: {
              id: 'bundle-save',
              label: 'Courtois stop',
              source: 'context:live-moment',
              relevance: 0.91,
            },
          },
        ],
      },
      liveMatch: createEmptyLiveMatchState(),
    });

    expect(assist.type).not.toBe('none');
    expect(assist.text).toMatch(/Courtois|Madrid|stop|save/i);
    expect(assist.sourceChips.length).toBeGreaterThan(0);
  });

  it('moves to a new grounded angle once the first cue idea has already been said', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: [
        {
          timestamp: 18_000,
          speaker: 'lead',
          text: 'Courtois keeps Madrid alive with a sharp stop from close range.',
        },
        {
          timestamp: 25_000,
          speaker: 'lead',
          text: 'Now I need the next number or angle here.',
        },
      ],
      interimTranscript: '',
      currentTimestampMs: 30_000,
      retrieval: createEmptyRetrievalState(),
      contextBundle: {
        ...createEmptyContextBundle(),
        summary: 'Save plus possession edge.',
        items: [
          {
            id: 'bundle-save',
            lane: 'live-moment',
            headline: 'Live moment',
            detail: 'Courtois keeps Madrid alive with a sharp stop from close range.',
            expiresAt: 40_000,
            salience: 0.93,
            sourceChip: {
              id: 'bundle-save',
              label: 'Courtois stop',
              source: 'context:live-moment',
              relevance: 0.93,
            },
          },
        ],
      },
      liveMatch: {
        ...createEmptyLiveMatchState(),
        homeTeam: {
          ...createEmptyLiveMatchState().homeTeam,
          name: 'Barcelona',
          shortCode: 'BAR',
        },
        awayTeam: {
          ...createEmptyLiveMatchState().awayTeam,
          name: 'Real Madrid',
          shortCode: 'RMA',
        },
        stats: [{ teamSide: 'home', label: 'Possession', value: '58%' }],
      },
    });

    expect(assist.type).toBe('stat');
    expect(assist.text).toMatch(/Barcelona|58%|Possession/);
    expect(assist.text).not.toMatch(/Courtois|sharp stop/i);
  });

  it('uses context-bundle social items instead of a generic crowd bridge', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: makeTranscript('Fans are reacting to this one'),
      interimTranscript: '',
      currentTimestampMs: 1000,
      retrieval: createEmptyRetrievalState(),
      contextBundle: {
        ...createEmptyContextBundle(),
        summary: 'Social pulse is building around the save.',
        items: [
          {
            id: 'bundle-social',
            lane: 'social-pulse',
            headline: 'Social pulse',
            detail: 'Fans are calling the save world class already.',
            expiresAt: 10_000,
            salience: 0.88,
            sourceChip: {
              id: 'bundle-social',
              label: 'Fans call it world class',
              source: 'context:social-pulse',
              relevance: 0.88,
            },
          },
        ],
      },
      liveMatch: createEmptyLiveMatchState(),
    });

    expect(assist.type).not.toBe('none');
    expect(assist.text).toMatch(/Fans|world class|reaction/i);
    expect(assist.sourceChips.length).toBeGreaterThan(0);
  });

  it('falls back to the speaker transcript only as a last resort when all context is thin', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: makeTranscript('Fans are reacting to this one'),
      interimTranscript: '',
      currentTimestampMs: 10_000,
      retrieval: createEmptyRetrievalState(),
      liveMatch: createEmptyLiveMatchState(),
    });

    expect(assist.type).toBe('transition');
    expect(assist.text).toContain('Pick up from');
    expect(assist.sourceChips).toHaveLength(0);
  });

  it('derives excluded cue texts only when the transcript has already covered them', () => {
    const excludedCueTexts = deriveExcludedCueTexts({
      recentCueTexts: [
        'Pick up the live moment: Courtois keeps Madrid alive with a sharp stop from close range.',
        'Use the number: Barcelona possession: 58%.',
      ],
      boothTranscript: [
        {
          timestamp: 11_000,
          speaker: 'lead',
          text: 'Courtois keeps Madrid alive with a sharp stop from close range.',
        },
        {
          timestamp: 22_000,
          speaker: 'lead',
          text: 'Still searching for the next layer here.',
        },
      ],
      interimTranscript: '',
      currentTimestampMs: 30_000,
    });

    expect(excludedCueTexts).toEqual([
      'Pick up the live moment: Courtois keeps Madrid alive with a sharp stop from close range.',
    ]);
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
