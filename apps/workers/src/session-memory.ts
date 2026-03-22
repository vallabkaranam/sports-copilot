import {
  AssistCard,
  GameEvent,
  SessionMemory,
  TranscriptEntry,
  createEmptySessionMemory,
} from '@sports-copilot/shared-types';

const MAX_RECENT_EVENTS = 8;
const MAX_SURFACED_ASSISTS = 5;
const MAX_RECENT_COMMENTARY = 40; // ~2 minutes of commentary at average speech rate

export interface SessionMemoryTracker {
  rememberAssist: (assist: AssistCard) => void;
  getState: (recentEvents: GameEvent[], recentTranscript: TranscriptEntry[]) => SessionMemory;
  reset: () => void;
}

export function createSessionMemoryTracker(): SessionMemoryTracker {
  let surfacedAssists: AssistCard[] = [];
  let lastAssistSignature = '';

  return {
    rememberAssist(assist) {
      const signature = `${assist.type}:${assist.text}`;
      if (assist.type === 'none' || !assist.text.trim() || signature === lastAssistSignature) {
        return;
      }

      surfacedAssists = [...surfacedAssists, assist].slice(-MAX_SURFACED_ASSISTS);
      lastAssistSignature = signature;
    },
    getState(recentEvents, recentTranscript) {
      return {
        ...createEmptySessionMemory(),
        recentEvents: recentEvents.slice(-MAX_RECENT_EVENTS),
        surfacedAssists,
        recentCommentary: recentTranscript.slice(-MAX_RECENT_COMMENTARY),
      };
    },
    reset() {
      surfacedAssists = [];
      lastAssistSignature = '';
    },
  };
}
