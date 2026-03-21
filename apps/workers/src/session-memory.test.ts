import { describe, expect, it } from 'vitest';
import {
  AssistCard,
  GameEvent,
  TranscriptEntry,
  createEmptyAssistCard,
} from '@sports-copilot/shared-types';
import { createSessionMemoryTracker } from './session-memory';

const mockEvents: GameEvent[] = [
  {
    id: 'e1',
    timestamp: 1_000,
    matchTime: '00:01',
    type: 'POSSESSION',
    description: 'Barcelona build from midfield.',
    highSalience: false,
    data: { team: 'BAR', player: 'Pedri' },
  },
  {
    id: 'e2',
    timestamp: 2_000,
    matchTime: '00:02',
    type: 'SAVE',
    description: 'Courtois turns away the opener.',
    highSalience: true,
    data: { team: 'RMA', player: 'Thibaut Courtois' },
  },
];

const transcript: TranscriptEntry[] = [
  { timestamp: 1_000, speaker: 'lead', text: 'Barcelona are moving it sharply.' },
  { timestamp: 2_100, speaker: 'lead', text: 'Courtois gets there again.' },
];

function makeAssist(text: string): AssistCard {
  return {
    ...createEmptyAssistCard(),
    type: 'context',
    text,
    confidence: 0.7,
    whyNow: 'Momentum is shifting.',
  };
}

describe('session memory tracker', () => {
  it('stores rolling recent events, surfaced assists, and commentary context', () => {
    const tracker = createSessionMemoryTracker();

    tracker.rememberAssist(makeAssist('Courtois is keeping Madrid alive.'));
    tracker.rememberAssist(makeAssist('Courtois is keeping Madrid alive.'));
    tracker.rememberAssist(makeAssist('That save keeps the Clasico tense.'));

    const state = tracker.getState(mockEvents, transcript);

    expect(state.recentEvents.map((event) => event.id)).toEqual(['e1', 'e2']);
    expect(state.surfacedAssists.map((assist) => assist.text)).toEqual([
      'Courtois is keeping Madrid alive.',
      'That save keeps the Clasico tense.',
    ]);
    expect(state.recentCommentary.map((entry) => entry.text)).toEqual([
      'Barcelona are moving it sharply.',
      'Courtois gets there again.',
    ]);
  });

  it('clears stored assist history on reset', () => {
    const tracker = createSessionMemoryTracker();

    tracker.rememberAssist(makeAssist('Temporary assist.'));
    tracker.reset();

    expect(tracker.getState(mockEvents, transcript).surfacedAssists).toEqual([]);
  });
});
