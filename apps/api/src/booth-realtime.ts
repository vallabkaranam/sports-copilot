const OPENAI_REALTIME_CALLS_API_URL = 'https://api.openai.com/v1/realtime/calls';
const DEFAULT_REALTIME_TRANSCRIBE_PROMPT =
  'Live sports commentary. Preserve filler words like um, uh, you know, and i mean.';

function createRealtimeSessionConfig() {
  return {
    type: 'transcription',
    audio: {
      input: {
        noise_reduction: {
          type: process.env.OPENAI_REALTIME_NOISE_REDUCTION ?? 'near_field',
        },
        transcription: {
          model:
            process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL ??
            process.env.OPENAI_TRANSCRIBE_MODEL ??
            'gpt-4o-transcribe',
          language: process.env.OPENAI_REALTIME_TRANSCRIBE_LANGUAGE ?? 'en',
          prompt:
            process.env.OPENAI_REALTIME_TRANSCRIBE_PROMPT ??
            process.env.OPENAI_TRANSCRIBE_PROMPT ??
            DEFAULT_REALTIME_TRANSCRIBE_PROMPT,
        },
        turn_detection: {
          type: 'server_vad',
          threshold: Number(process.env.OPENAI_REALTIME_VAD_THRESHOLD ?? 0.35),
          prefix_padding_ms: Number(process.env.OPENAI_REALTIME_VAD_PREFIX_PADDING_MS ?? 300),
          silence_duration_ms: Number(process.env.OPENAI_REALTIME_VAD_SILENCE_MS ?? 450),
          create_response: false,
          interrupt_response: false,
        },
      },
    },
    include: ['item.input_audio_transcription.logprobs'],
  };
}

export async function createRealtimeBoothSdpAnswer(offerSdp: string) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  const form = new FormData();
  form.set('sdp', offerSdp);
  form.set('session', JSON.stringify(createRealtimeSessionConfig()));

  const response = await fetch(OPENAI_REALTIME_CALLS_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: form,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI realtime connect failed: ${response.status} ${errorText}`);
  }

  return response.text();
}
