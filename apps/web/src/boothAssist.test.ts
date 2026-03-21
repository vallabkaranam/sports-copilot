import { describe, expect, it } from 'vitest';
import {
  createEmptyLiveMatchState,
  createEmptyPreMatchState,
  createEmptyRetrievalState,
  TranscriptEntry,
} from '@sports-copilot/shared-types';
import { buildBoothAssist } from './boothAssist';
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

describe('buildBoothAssist', () => {
  it('uses live social reaction when the speaker references fan reaction', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: makeTranscript('Fans are really reacting to that save and then I lost it'),
      interimTranscript: '',
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

    expect(assist.text).toContain('fan reaction');
    expect(assist.sourceChips[0]?.source).toContain('social');
  });

  it('uses pre-match setup context when the speaker is framing the match', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: makeTranscript('I was talking about the form coming into this match'),
      interimTranscript: '',
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

    expect(assist.text).toContain('setup');
    expect(assist.sourceChips[0]?.metadata?.chunkCategory).toBe('recent-form');
  });

  it('still produces a grounded pre-match hint when retrieval is empty', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: makeTranscript('Let me reset the setup and the weather here'),
      interimTranscript: '',
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

  it('falls back to hardcoded Clasico demo facts when no API-backed data exists', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal(),
      boothTranscript: makeTranscript('Let me bring in the fan reaction around this Clasico'),
      interimTranscript: '',
      retrieval: createEmptyRetrievalState(),
      liveMatch: createEmptyLiveMatchState(),
    });

    expect(assist.type).not.toBe('none');
    expect(assist.text.toLowerCase()).toMatch(/fan reaction|social pulse/);
    expect(assist.sourceChips.length).toBeGreaterThan(0);
  });

  it('can still build a grounded assist even if visibility is gated elsewhere', () => {
    const assist = buildBoothAssist({
      boothSignal: makeSignal({ shouldSurfaceAssist: false }),
      boothTranscript: makeTranscript('steady call'),
      interimTranscript: '',
      retrieval: createEmptyRetrievalState(),
    });

    expect(assist.type).not.toBe('none');
  });
});
