import { describe, expect, it } from 'vitest';
import { buildSidekickTrace } from './sidekickTrace';
import type { BoothSignal } from './boothSignal';

function makeSignal(overrides: Partial<BoothSignal> = {}): BoothSignal {
  return {
    activeSpeaker: 'none',
    hesitationScore: 0.62,
    confidenceScore: 0.22,
    hesitationReasons: ['Long pause detected.'],
    hesitationContributors: [
      { key: 'pause', label: 'Pause', score: 0.76 },
      { key: 'filler', label: 'Fillers', score: 0.42 },
    ],
    confidenceReasons: [],
    confidenceContributors: [],
    pauseDurationMs: 2100,
    speechStreakMs: 0,
    silenceStreakMs: 2100,
    fillerCount: 2,
    fillerDensity: 0.2,
    fillerWords: ['um', 'uh'],
    repeatedOpeningCount: 0,
    repeatedPhrases: [],
    unfinishedPhrase: false,
    transcriptWordCount: 12,
    transcriptStabilityScore: 0.4,
    wordsPerMinute: 146,
    pacePressureScore: 0.28,
    repeatedIdeaCount: 0,
    repeatedIdeaPhrases: [],
    wakePhraseDetected: false,
    isSpeaking: false,
    audioLevel: 0.03,
    hasVoiceActivity: true,
    shouldSurfaceAssist: true,
    ...overrides,
  };
}

describe('buildSidekickTrace', () => {
  it('shows active signal and cue states when a grounded cue is live', () => {
    const trace = buildSidekickTrace({
      boothSignal: makeSignal(),
      effectiveRecoveryScore: 0.24,
      shouldSurfaceAssist: true,
      isAssistWeaning: false,
      activeFixtureId: '19427573',
      fixtureResolutionLabel: 'Barcelona vs Real Madrid',
      cueSource: 'openai',
      recentEventCount: 3,
      socialCount: 1,
      visionCount: 1,
      supportingFactCount: 5,
      transcriptLineCount: 2,
    });

    expect(trace.find((item) => item.id === 'signal')?.state).toBe('active');
    expect(trace.find((item) => item.id === 'cue')?.detail).toContain('OpenAI');
    expect(trace.find((item) => item.id === 'context')?.detail).toContain('Barcelona vs Real Madrid');
  });

  it('shows waiting context when fixture resolution has not happened yet', () => {
    const trace = buildSidekickTrace({
      boothSignal: makeSignal({ shouldSurfaceAssist: false, hesitationContributors: [] }),
      effectiveRecoveryScore: 0.74,
      shouldSurfaceAssist: false,
      isAssistWeaning: false,
      activeFixtureId: undefined,
      fixtureResolutionLabel: null,
      cueSource: 'none',
      recentEventCount: 0,
      socialCount: 0,
      visionCount: 0,
      supportingFactCount: 0,
      transcriptLineCount: 0,
    });

    expect(trace.find((item) => item.id === 'context')?.state).toBe('waiting');
    expect(trace.find((item) => item.id === 'recovery')?.state).toBe('ready');
  });
});
