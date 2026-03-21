import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BoothFeatureSnapshot,
  RetrievedFact,
} from '@sports-copilot/shared-types';
import { generateBoothCueWithOpenAI } from './booth-assist';

function makeFeatures(overrides: Partial<BoothFeatureSnapshot> = {}): BoothFeatureSnapshot {
  return {
    timestamp: 1_000,
    hesitationScore: 0.74,
    confidenceScore: 0.22,
    pauseDurationMs: 2_800,
    speechStreakMs: 0,
    silenceStreakMs: 2_800,
    audioLevel: 0.02,
    isSpeaking: false,
    hasVoiceActivity: false,
    fillerCount: 2,
    fillerDensity: 0.18,
    fillerWords: ['um', 'uh'],
    repeatedOpeningCount: 1,
    repeatedPhrases: ['vinicius is'],
    unfinishedPhrase: true,
    transcriptWordCount: 11,
    transcriptStabilityScore: 0.52,
    hesitationReasons: ['You paused for 2.8s after the last thought.'],
    transcriptWindow: [
      {
        timestamp: 800,
        speaker: 'lead',
        text: 'Vinicius is...',
      },
    ],
    interimTranscript: 'uh vinicius is',
    contextSummary: 'Madrid are countering into space.',
    expectedTopics: ['Vinicius', 'transition'],
    previousState: 'step-in',
    ...overrides,
  };
}

function makeFact(): RetrievedFact {
  return {
    id: 'fact-1',
    tier: 'live',
    text: 'Courtois stands tall to keep Madrid alive during the pressure spell.',
    source: 'event-feed:save',
    timestamp: 75_000,
    relevance: 0.94,
    sourceChip: {
      id: 'fact-1',
      label: 'Courtois save',
      source: 'live:event-feed:save',
      relevance: 0.94,
    },
  };
}

describe('booth cue generation', () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    vi.unstubAllGlobals();
  });

  it('returns unavailable when the key is missing', async () => {
    const result = await generateBoothCueWithOpenAI({
      features: makeFeatures(),
      retrievalFacts: [],
    });

    expect(result.source).toBe('unavailable');
    expect(result.assist.type).toBe('none');
  });

  it('parses a generated cue from the OpenAI response path', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            type: 'context',
            text: 'Reset with the save, then bridge to Madrid in transition.',
            whyNow: 'Pause and restart signals are rising together.',
            confidence: 0.81,
            sourceFactIds: ['fact-1'],
            refreshAfterMs: 1800,
          }),
        }),
      }),
    );

    const result = await generateBoothCueWithOpenAI({
      features: makeFeatures(),
      contextBundle: {
        summary: 'Live moment: Courtois save | Social pulse: fans are calling it world class',
        items: [
          {
            id: 'fact-1',
            lane: 'live-moment',
            headline: 'Live moment',
            detail: 'Courtois stands tall to keep Madrid alive during the pressure spell.',
            expiresAt: 90_000,
            salience: 0.94,
            sourceChip: {
              id: 'fact-1',
              label: 'Courtois save',
              source: 'live:event-feed:save',
              relevance: 0.94,
            },
          },
        ],
      },
      retrievalFacts: [makeFact()],
    });

    expect(result.source).toBe('openai');
    expect(result.assist.type).toBe('context');
    expect(result.assist.text).toContain('save');
    expect(result.refreshAfterMs).toBe(1800);
    expect(result.assist.sourceChips[0]?.id).toBe('fact-1');
  });
});
