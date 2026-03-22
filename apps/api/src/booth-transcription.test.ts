import { afterEach, describe, expect, it, vi } from 'vitest';
import { transcribeBoothAudioWithOpenAI } from './booth-transcription';

describe('booth transcription', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
  });

  it('falls back cleanly when no OpenAI key is present', async () => {
    const result = await transcribeBoothAudioWithOpenAI('dGVzdA==', 'audio/webm');

    expect(result).toEqual({
      transcript: '',
      source: 'unavailable',
    });
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

  it('logs a warning when OpenAI transcription fails', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      }),
    );

    const result = await transcribeBoothAudioWithOpenAI('dGVzdA==', 'audio/webm');

    expect(result).toEqual({
      transcript: '',
      source: 'unavailable',
    });
    expect(warnSpy).toHaveBeenCalledWith('booth-transcription-openai-failed', {
      status: 503,
      statusText: 'Service Unavailable',
    });
  });
});
