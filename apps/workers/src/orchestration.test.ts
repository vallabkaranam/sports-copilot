import { describe, expect, it } from 'vitest';
import { createEmptyCommentatorState, createEmptyLiveMatchState, createEmptyRetrievalState } from '@sports-copilot/shared-types';
import { buildAgentWeights } from './orchestration.js';

describe('agent weighting', () => {
  it('raises live-context weight during active play', () => {
    const weights = buildAgentWeights({
      retrieval: {
        ...createEmptyRetrievalState(),
        supportingFacts: [
          {
            id: 'stream-1',
            tier: 'live',
            text: 'Live stream context says Courtois just saved it.',
            source: 'live-stream-context:event',
            timestamp: 75_000,
            relevance: 0.94,
            sourceChip: {
              id: 'stream-1',
              label: 'Courtois just saved it.',
              source: 'live:live-stream-context:event',
              relevance: 0.94,
            },
          },
        ],
      },
      liveStreamContext: {
        windowStartMs: 66_000,
        windowEndMs: 78_000,
        windowMs: 12_000,
        summary: 'Courtois stands tall to deny Barcelona. | 01:15 | 0-0',
        teams: { home: 'Barcelona', away: 'Real Madrid' },
        scoreState: { clock: '01:15', status: 'live', home: 0, away: 0 },
        momentumHint: 'RMA driving the last sequence',
        recentEvents: [
          {
            id: 'stream-1',
            timestamp: 75_000,
            source: 'event',
            headline: 'SAVE',
            detail: 'Courtois stands tall to deny Barcelona.',
            salience: 0.96,
          },
        ],
        transcriptSnippets: ['Courtois again, somehow keeping that out—'],
        signalSummary: ['1 live signal in the window', '1 transcript snippet'],
      },
      liveMatch: {
        ...createEmptyLiveMatchState(),
        status: 'live',
        minute: 75,
      },
      commentator: {
        ...createEmptyCommentatorState(),
        hesitationScore: 0.32,
      },
    });

    expect(weights.find((agent) => agent.agentName === 'live-context-agent')?.weight ?? 0).toBeGreaterThan(
      weights.find((agent) => agent.agentName === 'pre-match-agent')?.weight ?? 0,
    );
  });

  it('lets pre-match weight climb when live context is thin', () => {
    const weights = buildAgentWeights({
      retrieval: {
        ...createEmptyRetrievalState(),
        supportingFacts: [],
      },
      liveStreamContext: {
        windowStartMs: 0,
        windowEndMs: 0,
        windowMs: 12_000,
        summary: 'Live stream context is waiting for the next active beat.',
        teams: { home: '', away: '' },
        scoreState: { clock: '00:00', status: 'waiting', home: 0, away: 0 },
        momentumHint: 'Balanced',
        recentEvents: [],
        transcriptSnippets: [],
        signalSummary: [],
      },
      liveMatch: {
        ...createEmptyLiveMatchState(),
        status: 'not_started',
      },
      commentator: {
        ...createEmptyCommentatorState(),
        hesitationScore: 0.12,
      },
    });

    expect(weights.find((agent) => agent.agentName === 'pre-match-agent')?.weight ?? 0).toBeGreaterThan(0.2);
  });
});
