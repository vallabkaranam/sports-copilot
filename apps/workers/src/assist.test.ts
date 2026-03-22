import { describe, expect, it } from 'vitest';
import {
  CommentatorState,
  GameEvent,
  RetrievalState,
  SourceChip,
  createEmptyCommentatorState,
  createEmptyNarrativeState,
} from '@sports-copilot/shared-types';
import {
  MAX_ASSIST_CHARS,
  buildAssistCard,
  chooseAssistUrgency,
  chooseStyleMode,
} from './assist';

function makeSourceChip(id: string, source: string, relevance = 0.8): SourceChip {
  return {
    id,
    label: id,
    source,
    relevance,
  };
}

function makeRetrievalState(): RetrievalState {
  return {
    query: 'Courtois save',
    supportingFacts: [
      {
        id: 'session-event-save-1',
        tier: 'session',
        text: 'Courtois stands tall with a huge save.',
        source: 'event-feed:save',
        timestamp: 75_000,
        relevance: 0.94,
        sourceChip: makeSourceChip('session-event-save-1', 'session:event-feed:save', 0.94),
      },
      {
        id: 'live-social-76000-0',
        tier: 'live',
        text: '@MadridXtra: THIBAUT COURTOIS IS WORLD CLASS.',
        source: 'social:@MadridXtra',
        timestamp: 76_000,
        relevance: 0.97,
        sourceChip: makeSourceChip('live-social-76000-0', 'live:social:@MadridXtra', 0.97),
      },
      {
        id: 'static-player-p2',
        tier: 'static',
        text: 'Thibaut Courtois: Made 3 clutch saves in the last Clásico meeting.',
        source: 'roster:RMA',
        timestamp: null,
        relevance: 0.71,
        sourceChip: makeSourceChip('static-player-p2', 'static:roster:RMA', 0.71),
      },
      {
        id: 'static-narrative-n1',
        tier: 'static',
        text: 'The 256th Official Clásico. Real Madrid leads historical wins 104-100.',
        source: 'narratives:rivalry',
        timestamp: null,
        relevance: 0.64,
        sourceChip: makeSourceChip('static-narrative-n1', 'static:narratives:rivalry', 0.64),
      },
      {
        id: 'pre-match-form-home',
        tier: 'pre_match',
        text: 'Barcelona recent form: 3-1-1 across the last 5.',
        source: 'pre-match:recent-form',
        timestamp: 1_000,
        relevance: 0.72,
        metadata: {
          chunkCategory: 'recent-form',
          teamSide: 'home',
          phaseHints: ['pre_kickoff', 'early_match', 'quiet_stretch'],
        },
        sourceChip: {
          ...makeSourceChip('pre-match-form-home', 'pre_match:pre-match:recent-form', 0.72),
          metadata: {
            chunkCategory: 'recent-form',
            teamSide: 'home',
            phaseHints: ['pre_kickoff', 'early_match', 'quiet_stretch'],
          },
        },
      },
    ],
    unusedFacts: [],
  };
}

function makeEvent(): GameEvent {
  return {
    id: 'save-1',
    timestamp: 75_000,
    matchTime: '01:15',
    type: 'SAVE',
    description: 'Courtois stands tall with a huge save.',
    highSalience: true,
    data: { team: 'RMA', player: 'Thibaut Courtois' },
  };
}

function makeCommentatorState(overrides: Partial<CommentatorState> = {}): CommentatorState {
  return {
    ...createEmptyCommentatorState(),
    hesitationScore: 0.64,
    hesitationReasons: ['Lead commentator paused after a high-salience moment.'],
    pauseDurationMs: 3_000,
    ...overrides,
  };
}

describe('assist pipeline', () => {
  it('returns no assist when no intervention is needed', () => {
    const assist = buildAssistCard({
      clockMs: 20_000,
      events: [
        {
          id: 'possession-1',
          timestamp: 10_000,
          matchTime: '00:10',
          type: 'POSSESSION',
          description: 'Barcelona recycle possession.',
          highSalience: false,
          data: { team: 'BAR' },
        },
      ],
      commentator: makeCommentatorState({
        hesitationScore: 0.1,
        pauseDurationMs: 500,
        hesitationReasons: [],
      }),
      narrative: createEmptyNarrativeState(),
      retrieval: makeRetrievalState(),
    });

    expect(assist.type).toBe('none');
    expect(assist.confidence).toBe(0);
  });

  it('intervenes after a high-salience hesitation with a grounded assist', () => {
    const event = makeEvent();
    const assist = buildAssistCard({
      clockMs: 77_500,
      events: [event],
      commentator: makeCommentatorState(),
      narrative: {
        ...createEmptyNarrativeState(),
        topNarrative: 'The 256th Official Clásico',
        activeNarratives: ['The 256th Official Clásico'],
        currentSentiment: 'charged',
      },
      retrieval: makeRetrievalState(),
    });

    expect(assist.type).not.toBe('none');
    expect(assist.confidence).toBeGreaterThan(0);
    expect(assist.sourceChips.length).toBeGreaterThan(0);
  });

  it('keeps assist output under the strict length target', () => {
    const event = makeEvent();
    const assist = buildAssistCard({
      clockMs: 77_500,
      events: [event],
      commentator: makeCommentatorState({
        coHostTossUp: {
          question:
            "What did you make of Courtois's body shape and reach on that enormous reflex save under serious pressure?",
          reason: 'Recent high-salience action and lead hesitation make a co-host handoff timely.',
          confidence: 0.85,
          sourceEventId: 'save-1',
          sourceEventType: 'SAVE',
        },
      }),
      narrative: createEmptyNarrativeState(),
      retrieval: makeRetrievalState(),
    });

    expect(assist.text.length).toBeLessThanOrEqual(MAX_ASSIST_CHARS);
  });

  it('only attaches source chips that come from retrieved facts', () => {
    const retrieval = makeRetrievalState();
    const event = makeEvent();
    const assist = buildAssistCard({
      clockMs: 77_500,
      events: [event],
      commentator: makeCommentatorState(),
      narrative: createEmptyNarrativeState(),
      retrieval,
    });

    const sourceIds = new Set(retrieval.supportingFacts.map((fact) => fact.id));
    expect(assist.sourceChips.every((chip) => sourceIds.has(chip.id))).toBe(true);
  });

  it('chooses hype mode and high urgency for a hot hesitation window', () => {
    const event = makeEvent();
    const commentator = makeCommentatorState();

    expect(chooseAssistUrgency({ clockMs: 77_500, commentator, events: [event] })).toBe('high');
    expect(
      chooseStyleMode({
        clockMs: 77_500,
        commentator,
        events: [event],
        urgency: 'high',
      }),
    ).toBe('hype');
  });

  it('respects a preferred analyst mode when grounded analyst candidates are available', () => {
    const event = makeEvent();
    const assist = buildAssistCard({
      clockMs: 77_500,
      events: [event],
      commentator: makeCommentatorState({
        coHostTossUp: null,
      }),
      narrative: {
        ...createEmptyNarrativeState(),
        topNarrative: 'The 256th Official Clásico',
      },
      retrieval: makeRetrievalState(),
      preferredStyleMode: 'analyst',
    });

    expect(assist.styleMode).toBe('analyst');
  });

  it('uses pre-match context when hesitation opens without a recent live event fact', () => {
    const assist = buildAssistCard({
      clockMs: 5_000,
      events: [
        {
          id: 'opening-shape',
          timestamp: 1_000,
          matchTime: '00:01',
          type: 'POSSESSION',
          description: 'Barcelona settle into the opening shape.',
          highSalience: false,
          data: { team: 'BAR' },
        },
      ],
      commentator: makeCommentatorState({
        hesitationScore: 0.52,
        pauseDurationMs: 2_800,
      }),
      narrative: createEmptyNarrativeState(),
      retrieval: {
        query: 'opening context',
        supportingFacts: makeRetrievalState().supportingFacts.filter(
          (fact) => fact.tier === 'pre_match',
        ),
        unusedFacts: [],
      },
      preferredStyleMode: 'analyst',
      forceIntervention: true,
    });

    expect(assist.type).not.toBe('none');
    expect(assist.sourceChips.some((chip) => chip.metadata?.chunkCategory === 'recent-form')).toBe(true);
  });
});
