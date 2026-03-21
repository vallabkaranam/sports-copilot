import { describe, expect, it } from 'vitest';
import { GameEvent } from '@sports-copilot/shared-types';
import { ReplayEngine } from './engine';

const mockEvents: GameEvent[] = [
  {
    id: 'e1',
    timestamp: 1_000,
    matchTime: '00:01',
    type: 'POSSESSION',
    description: 'Real Madrid step onto the ball through Valverde.',
    highSalience: false,
    data: { team: 'RMA', player: 'Federico Valverde' },
  },
  {
    id: 'e2',
    timestamp: 2_000,
    matchTime: '00:02',
    type: 'GOAL',
    description: 'Barcelona strike first through Lewandowski.',
    highSalience: true,
    data: { team: 'BAR', player: 'Robert Lewandowski' },
  },
  {
    id: 'e3',
    timestamp: 2_500,
    matchTime: '00:02',
    type: 'POSSESSION',
    description: 'Barcelona settle the restart and keep control.',
    highSalience: false,
    data: { team: 'BAR', player: 'Pedri' },
  },
];

describe('ReplayEngine', () => {
  it('replays the event timeline deterministically and respects pause state', () => {
    const engine = new ReplayEngine({ events: mockEvents, tickRateMs: 500 });

    expect(engine.tick(500)).toBeNull();
    expect(engine.getStatus().clock).toBe('00:00');

    engine.play();

    expect(engine.tick(500)).toBeNull();
    expect(engine.getStatus().clock).toBe('00:00');

    const firstBatch = engine.tick(500);
    expect(firstBatch).toHaveLength(1);
    expect(firstBatch?.[0].id).toBe('e1');
    expect(engine.getStatus().clock).toBe('00:01');
  });

  it('tracks score, possession, recent events, and high-salience moments in world state', () => {
    const engine = new ReplayEngine({ events: mockEvents, tickRateMs: 500 });
    engine.play();

    engine.tick(2_500);

    const status = engine.getStatus();

    expect(status.score).toEqual({ home: 1, away: 0 });
    expect(status.possession).toBe('BAR');
    expect(status.recentEvents?.map((event) => event.id)).toEqual(['e1', 'e2', 'e3']);
    expect(status.highSalienceMoments?.map((event) => event.id)).toEqual(['e2']);
    expect(status.gameStateSummary).toBe('BAR in control with the score 1-0.');
  });

  it('surfaces the latest high-salience description when the moment is still hot', () => {
    const engine = new ReplayEngine({ events: mockEvents, tickRateMs: 500 });
    engine.play();

    engine.tick(2_000);

    const status = engine.getStatus();

    expect(status.gameStateSummary).toBe('Barcelona strike first through Lewandowski.');
    expect(status.highSalienceMoments?.[0].description).toContain('Lewandowski');
  });

  it('restarts cleanly and resets tracked state', () => {
    const engine = new ReplayEngine({ events: mockEvents, tickRateMs: 500 });
    engine.play();
    engine.tick(2_500);

    engine.restart();

    const status = engine.getStatus();
    expect(status.clock).toBe('00:00');
    expect(status.score).toEqual({ home: 0, away: 0 });
    expect(status.possession).toBe('BAR');
    expect(status.recentEvents).toEqual([]);
    expect(status.highSalienceMoments).toEqual([]);
  });
});
