import { describe, expect, it } from 'vitest';
import { GameEvent } from '@sports-copilot/shared-types';
import { buildNarrativeState } from './narrative';
import { NarrativeFixture } from './retrieval';

describe('narrative agent', () => {
  const narratives: NarrativeFixture[] = [
    {
      id: 'n1',
      type: 'RIVALRY',
      title: 'The 256th Official Clásico',
      description: 'The rivalry is always the backdrop here.',
    },
    {
      id: 'n2',
      type: 'PLAYER_SPOTLIGHT',
      title: "Bellingham's Impact",
      description: 'Jude Bellingham has scored in both Clásicos this season.',
    },
    {
      id: 'n3',
      type: 'MOMENTUM',
      title: "Barcelona's High Press",
      description: 'Barcelona are pinning Madrid back.',
    },
  ];

  it('surfaces momentum, defensive lapse, and rivalry after a Barcelona chance', () => {
    const events: GameEvent[] = [
      {
        id: 'e1',
        timestamp: 65_000,
        matchTime: '01:05',
        type: 'CHANCE',
        description: 'Pedri threads a needle and Lewandowski is in.',
        highSalience: true,
        data: { team: 'BAR', player: 'Pedri' },
      },
    ];

    const state = buildNarrativeState({ clockMs: 70_000, events, narratives });

    expect(state.topNarrative).toBe("Barcelona's High Press");
    expect(state.activeNarratives).toContain("Real Madrid's back line was stretched open.");
    expect(state.activeNarratives).toContain('Spotlight on Pedri.');
    expect(state.activeNarratives).toContain('The 256th Official Clásico');
    expect(state.momentum).toBe('home');
  });

  it('adds comeback pressure when a side is trailing', () => {
    const events: GameEvent[] = [
      {
        id: 'goal-1',
        timestamp: 20_000,
        matchTime: '00:20',
        type: 'GOAL',
        description: 'Real Madrid score first.',
        highSalience: true,
        data: { team: 'RMA', player: 'Jude Bellingham' },
      },
    ];

    const state = buildNarrativeState({ clockMs: 30_000, events, narratives });

    expect(state.activeNarratives).toContain('Barcelona are under comeback pressure.');
    expect(state.momentum).toBe('away');
  });
});
