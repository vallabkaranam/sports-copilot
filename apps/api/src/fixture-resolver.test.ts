import { describe, expect, it, vi } from 'vitest';
import { rankFixtureCandidates, resolveFixtureFromScreenshot } from './fixture-resolver';

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

  it('queries SportMonks with both extracted teams before ranking fixtures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            homeTeam: 'Barcelona',
            awayTeam: 'Real Madrid',
            competition: 'La Liga',
            confidence: 0.88,
          }),
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
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
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
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
          ],
        }),
      });

    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENAI_API_KEY = 'test-key';

    const resolved = await resolveFixtureFromScreenshot({
      clipName: 'stadium screengrab 01',
      sportmonksApiToken: 'sportmonks-test',
    });

    expect(resolved.fixtureId).toBe('1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('participantSearch%3ABarcelona');
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('participantSearch%3AReal+Madrid');
  });

  it('returns the known Barca preset fixture without requiring OpenAI or SportMonks', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const resolved = await resolveFixtureFromScreenshot({
      clipName: 'Barca preset',
    });

    expect(resolved).toMatchObject({
      fixtureId: '19427573',
      homeTeam: 'Barcelona',
      awayTeam: 'Real Madrid',
      source: 'preset',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the known Rangers preset fixture without requiring OpenAI or SportMonks', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const resolved = await resolveFixtureFromScreenshot({
      clipName: 'Rangers preset',
    });

    expect(resolved).toMatchObject({
      fixtureId: '19428224',
      homeTeam: 'Rangers',
      awayTeam: 'Aberdeen',
      source: 'preset',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
