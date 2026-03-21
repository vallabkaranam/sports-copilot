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
    fillerWords: [],
    repeatedPhrases: [],
    unfinishedPhrase: false,
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
        hesitationReasons: [],
      }),
    );

    expect(interpretation.state).toBe('weaning-off');
    expect(interpretation.shouldSurfaceAssist).toBe(false);
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
