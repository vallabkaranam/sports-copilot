const OPENAI_REALTIME_CALLS_API_URL = 'https://api.openai.com/v1/realtime/calls';
const OPENAI_REALTIME_TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
const OPENAI_REALTIME_TRANSCRIBE_LANGUAGE = 'en';
const OPENAI_REALTIME_NOISE_REDUCTION = 'near_field';
const OPENAI_REALTIME_VAD_THRESHOLD = 0.35;
const OPENAI_REALTIME_VAD_PREFIX_PADDING_MS = 300;
const OPENAI_REALTIME_VAD_SILENCE_MS = 450;
const DEFAULT_REALTIME_TRANSCRIBE_PROMPT =
  'Live sports commentary. Preserve filler words, repetitions, false starts, self-corrections, trailing thoughts, wake phrases like "line", and unfinished phrases exactly as spoken. Do not clean up ums, uhs, repeated openings, broken phrasing, or secret trigger phrases such as "line" or "but um".';

function createRealtimeSessionConfig() {
  return {
    type: 'transcription',
    audio: {
      input: {
        noise_reduction: {
          type: OPENAI_REALTIME_NOISE_REDUCTION,
        },
        transcription: {
          model: OPENAI_REALTIME_TRANSCRIBE_MODEL,
          language: OPENAI_REALTIME_TRANSCRIBE_LANGUAGE,
          prompt: DEFAULT_REALTIME_TRANSCRIBE_PROMPT,
        },
        turn_detection: {
          type: 'server_vad',
          threshold: OPENAI_REALTIME_VAD_THRESHOLD,
          prefix_padding_ms: OPENAI_REALTIME_VAD_PREFIX_PADDING_MS,
          silence_duration_ms: OPENAI_REALTIME_VAD_SILENCE_MS,
          create_response: false,
          interrupt_response: false,
        },
      },
    },
    include: ['item.input_audio_transcription.logprobs'],
  };
}

export async function createRealtimeBoothSdpAnswer(offerSdp: string) {
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
