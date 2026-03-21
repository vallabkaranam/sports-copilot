import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoothFeatureSnapshot } from '@sports-copilot/shared-types';
import {
  buildHeuristicBoothInterpretation,
  interpretBoothWithOpenAI,
} from './booth-interpretation';

function createFeatures(overrides: Partial<BoothFeatureSnapshot> = {}): BoothFeatureSnapshot {
  return {
    timestamp: 10_000,
    hesitationScore: 0.72,
    confidenceScore: 0.12,
    pauseDurationMs: 2_800,
    speechStreakMs: 0,
    silenceStreakMs: 2_800,
    audioLevel: 0.02,
    isSpeaking: false,
    hasVoiceActivity: false,
    fillerCount: 0,
    fillerDensity: 0,
    fillerWords: [],
    repeatedOpeningCount: 0,
    repeatedPhrases: [],
    unfinishedPhrase: false,
    transcriptWordCount: 8,
    transcriptStabilityScore: 0.92,
    hesitationReasons: ['You paused for 2.8s after the last thought.'],
    transcriptWindow: [],
    interimTranscript: '',
    ...overrides,
  };
}

describe('booth interpretation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
  });

  it('uses the heuristic fallback when no key is present', async () => {
    const interpretation = await interpretBoothWithOpenAI(createFeatures());

    expect(interpretation.source).toBe('heuristic');
    expect(interpretation.state).toBe('step-in');
    expect(interpretation.shouldSurfaceAssist).toBe(true);
  });

  it('classifies recovery as weaning off heuristically', () => {
    const interpretation = buildHeuristicBoothInterpretation(
      createFeatures({
        hesitationScore: 0.08,
        confidenceScore: 0.78,
        pauseDurationMs: 0,
        speechStreakMs: 3_600,
        silenceStreakMs: 0,
        audioLevel: 0.14,
        isSpeaking: true,
        hasVoiceActivity: true,
        transcriptStabilityScore: 0.84,
        previousState: 'step-in',
        hesitationReasons: [],
      }),
    );

    expect(interpretation.state).toBe('weaning-off');
    expect(interpretation.shouldSurfaceAssist).toBe(false);
  });

  it('steps in for transcript instability even before a long silence', () => {
    const interpretation = buildHeuristicBoothInterpretation(
      createFeatures({
        hesitationScore: 0.48,
        pauseDurationMs: 400,
        silenceStreakMs: 400,
        fillerCount: 4,
        fillerDensity: 0.28,
        fillerWords: ['um', 'uh', 'um', 'you know'],
        repeatedOpeningCount: 2,
        repeatedPhrases: ['vinicius is'],
        transcriptStabilityScore: 0.34,
        hesitationReasons: ['Fillers detected: um, uh, you know.', 'Repeated opening: "vinicius is".'],
      }),
    );

    expect(interpretation.state).toBe('step-in');
    expect(interpretation.shouldSurfaceAssist).toBe(true);
  });

  it('parses an OpenAI JSON response when available', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            state: 'monitoring',
            hesitationScore: 0.31,
            recoveryScore: 0.22,
            shouldSurfaceAssist: false,
            summary: 'Tracking the booth without stepping in.',
            reasons: ['The pause is not yet long enough to justify help.'],
          }),
        }),
      }),
    );

    const interpretation = await interpretBoothWithOpenAI(createFeatures());

    expect(interpretation.source).toBe('openai');
    expect(interpretation.state).toBe('monitoring');
    expect(interpretation.shouldSurfaceAssist).toBe(false);
  });
});
