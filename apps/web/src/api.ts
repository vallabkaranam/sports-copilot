import { ReplayControlState, WorldState } from '@sports-copilot/shared-types';

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
