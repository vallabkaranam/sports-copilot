import { TranscribeBoothAudioResponse } from '@sports-copilot/shared-types';

const OPENAI_AUDIO_API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-4o-transcribe';
const DEFAULT_TRANSCRIBE_PROMPT =
  'Live sports commentary. Preserve filler words, repetitions, false starts, self-corrections, trailing thoughts, and unfinished phrases exactly as spoken. Do not clean up ums, uhs, repeated openings, or broken phrasing.';

function inferAudioExtension(mimeType: string) {
  if (mimeType.includes('ogg')) {
    return 'ogg';
  }

  if (mimeType.includes('mp4')) {
    return 'mp4';
  }

  if (mimeType.includes('wav')) {
    return 'wav';
  }

  return 'webm';
}

export async function transcribeBoothAudioWithOpenAI(
  audioBase64: string,
  mimeType: string,
): Promise<TranscribeBoothAudioResponse> {
  if (!process.env.OPENAI_API_KEY) {
    return {
      transcript: '',
      source: 'unavailable',
    };
  }

  const audioBuffer = Buffer.from(audioBase64, 'base64');
  const fileExtension = inferAudioExtension(mimeType);
  const form = new FormData();
  const file = new File([audioBuffer], `booth.${fileExtension}`, { type: mimeType });

  form.set('file', file);
  form.set('model', OPENAI_TRANSCRIBE_MODEL);
  form.set('language', 'en');
  form.set('prompt', process.env.OPENAI_TRANSCRIBE_PROMPT ?? DEFAULT_TRANSCRIBE_PROMPT);

  const response = await fetch(OPENAI_AUDIO_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: form,
  });

  if (!response.ok) {
    console.warn('booth-transcription-openai-failed', {
      status: response.status,
      statusText: response.statusText,
    });
    return {
      transcript: '',
      source: 'unavailable',
    };
  }

  const payload = (await response.json()) as { text?: string };

  return {
    transcript: payload.text?.trim() ?? '',
    source: 'openai',
  };
}
