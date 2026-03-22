const OPENAI_REALTIME_CALLS_API_URL = 'https://api.openai.com/v1/realtime/calls';
const OPENAI_REALTIME_MODEL = 'gpt-4o-mini-realtime-preview';

function createRealtimeSessionConfig() {
  return {
    type: 'realtime',
    model: OPENAI_REALTIME_MODEL,
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
