import {
  AssistCard,
  SessionMemory,
  TranscriptEntry,
  createEmptySessionMemory,
} from '@sports-copilot/shared-types';
import { ReplayEngine } from './engine';

const MAX_RECENT_EVENTS = 8;
const MAX_SURFACED_ASSISTS = 5;
const MAX_RECENT_COMMENTARY = 6;

export interface SessionMemoryTracker {
  rememberAssist: (assist: AssistCard) => void;
  getState: (engine: ReplayEngine, recentTranscript: TranscriptEntry[]) => SessionMemory;
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
    getState(engine, recentTranscript) {
      return {
        ...createEmptySessionMemory(),
        recentEvents: engine.getRecentEvents(MAX_RECENT_EVENTS),
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
