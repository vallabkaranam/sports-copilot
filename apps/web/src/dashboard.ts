import {
  AssistCard,
  WorldState,
  createEmptyAssistCard,
  createEmptyCommentatorState,
  createEmptyContextBundle,
  createEmptyLiveMatchState,
  createEmptyLiveStreamContext,
  createEmptyNarrativeState,
  createEmptyPreMatchState,
  createEmptyRetrievalState,
  createEmptySessionMemory,
} from '@sports-copilot/shared-types';

const REPLAY_DURATION_MS = 90_000;

export const TEAM_META = {
  home: {
    code: 'BAR',
    name: 'Barcelona',
  },
  away: {
    code: 'RMA',
    name: 'Real Madrid',
  },
} as const;

export function createInitialWorldState(): WorldState {
  return {
    matchId: 'sportmonks-live',
    clock: '00:00',
    score: { home: 0, away: 0 },
    possession: 'LIVE',
    gameStateSummary: 'Waiting for Sportmonks live data.',
    highSalienceMoments: [],
    recentEvents: [],
    sessionMemory: createEmptySessionMemory(),
    commentator: createEmptyCommentatorState(),
    narrative: createEmptyNarrativeState(),
    retrieval: createEmptyRetrievalState(),
    contextBundle: createEmptyContextBundle(),
    liveStreamContext: createEmptyLiveStreamContext(),
    assist: createEmptyAssistCard(),
    preMatch: createEmptyPreMatchState(),
    liveMatch: createEmptyLiveMatchState(),
    liveSignals: {
      social: [],
      vision: [],
      commentary: [],
    },
  };
}

export function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

export function formatDurationMs(durationMs: number) {
  const safeDurationMs = Math.max(0, durationMs);
  const totalSeconds = Math.floor(safeDurationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatEventType(type: string) {
  return type
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function formatAssistType(type: AssistCard['type']) {
  switch (type) {
    case 'co-host-tossup':
      return 'Co-host Toss-up';
    case 'context':
      return 'Context';
    case 'hype':
      return 'Hype';
    case 'narrative':
      return 'Narrative';
    case 'stat':
      return 'Stat';
    case 'transition':
      return 'Transition';
    case 'none':
      return 'Stand By';
  }
}

export function formatMomentum(momentum: WorldState['narrative']['momentum']) {
  switch (momentum) {
    case 'home':
      return 'Barcelona tilt';
    case 'away':
      return 'Madrid surge';
    case 'neutral':
      return 'Balanced';
  }
}

export function parseClock(clock: string) {
  const [minutes, seconds] = clock.split(':').map((segment) => Number(segment));
  return ((minutes || 0) * 60 + (seconds || 0)) * 1_000;
}

export function getReplayProgress(clock: string) {
  return Math.min(100, Math.round((parseClock(clock) / REPLAY_DURATION_MS) * 100));
}
