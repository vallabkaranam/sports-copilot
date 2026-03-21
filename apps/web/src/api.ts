import {
  BoothFeatureSnapshot,
  BoothInterpretation,
  GenerateBoothCueInput,
  GenerateBoothCueResponse,
  BoothSessionReview,
  BoothSessionRecord,
  BoothSessionSample,
  BoothSessionsResponse,
  BoothSessionSummary,
  ReplayControlState,
  StartBoothSessionResponse,
  TranscribeBoothAudioResponse,
  WorldState,
} from '@sports-copilot/shared-types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001';

async function requestJson<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

export function fetchWorldState() {
  return requestJson<WorldState>('/world-state');
}

export function fetchControlState() {
  return requestJson<ReplayControlState>('/controls');
}

export function updateControlState(
  patch: Partial<ReplayControlState> & {
    restart?: boolean;
  },
) {
  return requestJson<ReplayControlState>('/controls', {
    method: 'POST',
    body: JSON.stringify(patch),
  });
}

export function fetchBoothSessions() {
  return requestJson<BoothSessionsResponse>('/booth-sessions');
}

export function fetchBoothSession(sessionId: string) {
  return requestJson<{ session: BoothSessionRecord }>(`/booth-sessions/${sessionId}`);
}

export function fetchBoothSessionReview(sessionId: string) {
  return requestJson<{ review: BoothSessionReview }>(`/booth-sessions/${sessionId}/review`);
}

export function startBoothSession(clipName: string) {
  return requestJson<StartBoothSessionResponse>('/booth-sessions/start', {
    method: 'POST',
    body: JSON.stringify({ clipName }),
  });
}

export function appendBoothSessionSample(sessionId: string, sample: BoothSessionSample) {
  return requestJson<{ session: BoothSessionSummary }>(`/booth-sessions/${sessionId}/sample`, {
    method: 'POST',
    body: JSON.stringify({ sample }),
  });
}

export function finishBoothSession(sessionId: string) {
  return requestJson<{ session: BoothSessionSummary }>(`/booth-sessions/${sessionId}/finish`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function interpretBooth(features: BoothFeatureSnapshot) {
  return requestJson<BoothInterpretation>('/booth/interpret', {
    method: 'POST',
    body: JSON.stringify({ features }),
  });
}

export function generateBoothCue(input: GenerateBoothCueInput) {
  return requestJson<GenerateBoothCueResponse>('/booth/generate-cue', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function transcribeBoothAudio(audioBase64: string, mimeType: string) {
  return requestJson<TranscribeBoothAudioResponse>('/booth/transcribe', {
    method: 'POST',
    body: JSON.stringify({ audioBase64, mimeType }),
  });
}

export async function connectRealtimeBoothSession(offerSdp: string) {
  const response = await fetch(`${API_BASE_URL}/booth/realtime-connect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sdp',
    },
    body: offerSdp,
  });

  if (!response.ok) {
    throw new Error(`POST /booth/realtime-connect failed with ${response.status}`);
  }

  return response.text();
}
