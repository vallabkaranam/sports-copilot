import { afterEach, describe, expect, it, vi } from 'vitest';
import { transcribeBoothAudioWithOpenAI } from './booth-transcription';

describe('booth transcription', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
  });

  it('throws when the transcription path cannot authenticate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      }),
    );

    await expect(transcribeBoothAudioWithOpenAI('dGVzdA==', 'audio/webm')).rejects.toThrow(
      'OpenAI transcription failed: 401 Unauthorized',
    );
  });

  it('parses OpenAI transcription text when available', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          text: 'um vinicius is driving forward',
        }),
      }),
    );

    const result = await transcribeBoothAudioWithOpenAI('dGVzdA==', 'audio/webm');

    expect(result).toEqual({
      transcript: 'um vinicius is driving forward',
      source: 'openai',
    });
  });
});
