import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoothFeatureSnapshot } from '@sports-copilot/shared-types';
import { interpretBoothWithOpenAI } from './booth-interpretation';

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

  it('fails fast when the interpretation path cannot authenticate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      }),
    );

    await expect(
      interpretBoothWithOpenAI(createFeatures(), {
        totalSessions: 3,
        totalSamples: 120,
        averageMaxHesitationScore: 0.38,
        averageRecoveryScore: 0.64,
        averagePauseDurationMs: 1_400,
        averageSpeechStreakMs: 4_600,
        averageFillerDensity: 0.06,
        averageRepeatedOpenings: 0.1,
        averageTranscriptStability: 0.88,
        wakePhrase: 'line',
      }),
    ).rejects.toThrow('OpenAI interpretation failed with 401');
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
            confidenceReason: 'Confidence dipped because delivery paused, but the rest of the signal is still mixed.',
            signals: [
              {
                key: 'pauseDurationMs',
                label: 'Pause after speech',
                value: 2800,
                detail: '2.8s',
              },
            ],
          }),
        }),
      }),
    );

    const interpretation = await interpretBoothWithOpenAI(createFeatures());

    expect(interpretation.source).toBe('openai');
    expect(interpretation.state).toBe('monitoring');
    expect(interpretation.shouldSurfaceAssist).toBe(false);
    expect(interpretation.signals[0]?.key).toBe('pauseDurationMs');
    expect(interpretation.confidenceReason).toContain('Confidence dipped');
    expect(interpretation.explainability?.contributingAgents.map((agent) => agent.agentName)).toEqual([
      'signal-agent',
      'recovery-agent',
    ]);
  });
});
