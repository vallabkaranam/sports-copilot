import { describe, it, expect, beforeEach } from 'vitest';
import { ReplayEngine } from './engine';
import { GameEvent } from '@sports-copilot/shared-types';

describe('ReplayEngine', () => {
  const mockEvents: GameEvent[] = [
    {
      id: 'e1',
      timestamp: 1000,
      matchTime: '00:01',
      type: 'POSSESSION',
      description: 'Test',
      highSalience: false,
      data: { team: 'RMA' },
    },
    {
      id: 'e2',
      timestamp: 2000,
      matchTime: '00:02',
      type: 'GOAL',
      description: 'Goooal',
      highSalience: true,
      data: { team: 'BAR' },
    },
  ];

  it('should not tick when paused', () => {
    const engine = new ReplayEngine({ events: mockEvents, tickRateMs: 500 });
    const events = engine.tick(500);
    expect(events).toBeNull();
    expect(engine.getStatus().clock).toBe('00:00');
  });

  it('should emit events when playing', () => {
    const engine = new ReplayEngine({ events: mockEvents, tickRateMs: 500 });
    engine.play();
    
    // Tick to 1000ms
    const e1 = engine.tick(1000);
    expect(e1).toHaveLength(1);
    expect(e1![0].id).toBe('e1');
    expect(engine.getStatus().possession).toBe('RMA');

    // Tick to 2000ms
    const e2 = engine.tick(1000);
    expect(e2).toHaveLength(1);
    expect(e2![0].id).toBe('e2');
    expect(engine.getStatus().score?.home).toBe(1);
  });

  it('should format clock correctly', () => {
    const engine = new ReplayEngine({ events: mockEvents, tickRateMs: 500 });
    engine.play();
    engine.tick(65000); // 1:05
    expect(engine.getStatus().clock).toBe('01:05');
  });

  it('should restart correctly', () => {
    const engine = new ReplayEngine({ events: mockEvents, tickRateMs: 500 });
    engine.play();
    engine.tick(2500);
    expect(engine.getStatus().score?.home).toBe(1);
    
    engine.restart();
    expect(engine.getStatus().clock).toBe('00:00');
    expect(engine.getStatus().score?.home).toBe(0);
  });
});
