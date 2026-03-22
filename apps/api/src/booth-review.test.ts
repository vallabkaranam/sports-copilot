import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoothSessionRecord } from '@sports-copilot/shared-types';
import { reviewBoothSessionWithOpenAI } from './booth-review';

function createSession(): BoothSessionRecord {
  return {
    id: 'session-1',
    clipName: 'test.mp4',
    startedAt: '2026-03-20T00:00:00.000Z',
    endedAt: '2026-03-20T00:01:00.000Z',
    status: 'completed',
    sampleCount: 3,
    maxHesitationScore: 0.81,
    maxConfidenceScore: 0.72,
    longestPauseMs: 4200,
    assistCount: 2,
    lastTriggerBadges: ['pause', 'filler'],
    samples: [],
  };
}

describe('booth review', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
  });

  it('throws when the review path cannot authenticate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      }),
    );

    await expect(reviewBoothSessionWithOpenAI(createSession())).rejects.toThrow(
      'OpenAI review failed: 401 Unauthorized',
    );
  });

  it('parses an OpenAI JSON review when available', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            headline: 'You recovered cleanly after the pause.',
            summary: 'The session showed one strong pause trigger and a clear recovery window.',
            strengths: ['Recovery stabilized quickly once speech resumed.'],
            watchouts: ['Pause-based hesitation is still your strongest risk.'],
            coachingNotes: ['Keep the first re-entry line short after a long silence.'],
          }),
        }),
      }),
    );

    const review = await reviewBoothSessionWithOpenAI(createSession());

    expect(review.headline).toContain('recovered cleanly');
    expect(review.strengths[0]).toContain('Recovery');
  });
});
