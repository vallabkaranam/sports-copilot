import { describe, expect, it } from 'vitest';
import { rankFixtureCandidates } from './fixture-resolver';

describe('fixture resolver ranking', () => {
  it('prefers the fixture whose home and away teams match the extracted hints', () => {
    const ranked = rankFixtureCandidates(
      [
        {
          id: '1',
          name: 'Barcelona vs Real Madrid',
          league: { name: 'La Liga' },
          state: { developer_name: 'live' },
          participants: [
            { name: 'Barcelona', meta: { location: 'home' } },
            { name: 'Real Madrid', meta: { location: 'away' } },
          ],
        },
        {
          id: '2',
          name: 'Barcelona vs Atletico Madrid',
          league: { name: 'La Liga' },
          state: { developer_name: 'live' },
          participants: [
            { name: 'Barcelona', meta: { location: 'home' } },
            { name: 'Atletico Madrid', meta: { location: 'away' } },
          ],
        },
      ],
      {
        homeTeam: 'Barcelona',
        awayTeam: 'Real Madrid',
        competition: 'La Liga',
        confidence: 0.88,
      },
    );

    expect(String(ranked[0]?.fixture.id)).toBe('1');
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
  });
});
