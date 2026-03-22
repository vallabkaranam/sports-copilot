import { describe, expect, it, vi } from 'vitest';
import { BlueskyPostCache, buildQueries, ingestBlueskySocialPosts } from './bluesky';

function jsonResponse(data: unknown) {
  return Promise.resolve({
    ok: true,
    json: async () => data,
  } as Response);
}

describe('bluesky social ingest', () => {
  it('builds matchup-aware queries from the active home and away teams', () => {
    expect(buildQueries('Rangers', 'Aberdeen')).toEqual([
      'Rangers',
      'Aberdeen',
      'Rangers Aberdeen',
      'Rangers vs Aberdeen',
    ]);
  });

  it('normalizes public search results into social posts and dedupes by uri', async () => {
    const cache: BlueskyPostCache = {};
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('q=Barcelona')) {
        return jsonResponse({
          posts: [
            {
              uri: 'at://post-1',
              author: { handle: 'matchfan.bsky.social' },
              record: {
                text: 'Barcelona are flying in this match.',
                createdAt: '2026-03-21T00:00:00.000Z',
              },
            },
          ],
        });
      }

      if (url.includes('q=Real+Madrid')) {
        return jsonResponse({
          posts: [
            {
              uri: 'at://post-1',
              author: { handle: 'matchfan.bsky.social' },
              record: {
                text: 'Barcelona are flying in this match.',
                createdAt: '2026-03-21T00:00:00.000Z',
              },
            },
            {
              uri: 'at://post-2',
              author: { handle: 'analyst.bsky.social' },
              record: {
                text: 'Real Madrid need a response in this game.',
                createdAt: '2026-03-21T00:00:10.000Z',
              },
            },
          ],
        });
      }

      if (url.includes('q=Barcelona+Real+Madrid') || url.includes('q=Barcelona+vs+Real+Madrid')) {
        return jsonResponse({ posts: [] });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    const posts = await ingestBlueskySocialPosts(
      {
        homeTeam: 'Barcelona',
        awayTeam: 'Real Madrid',
        clockMs: 12_000,
        fetchImpl: fetchMock as typeof fetch,
      },
      cache,
    );

    expect(posts).toHaveLength(2);
    expect(posts[0]?.handle).toBe('@matchfan.bsky.social');
    expect(posts[0]?.timestamp).toBe(12_000);
    expect(posts[1]?.sentiment).toBe('neutral');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('filters out off-topic posts that match a team name but not the football fixture', async () => {
    const cache: BlueskyPostCache = {};
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('q=Rangers')) {
        return jsonResponse({
          posts: [
            {
              uri: 'at://post-1',
              author: { handle: 'fitbawfan.bsky.social' },
              record: {
                text: 'Rangers had 62 percent possession and controlled the match.',
                createdAt: '2026-03-21T00:00:00.000Z',
              },
            },
          ],
        });
      }

      if (url.includes('q=Aberdeen')) {
        return jsonResponse({
          posts: [
            {
              uri: 'at://post-2',
              author: { handle: 'localnews.bsky.social' },
              record: {
                text: 'Aberdeen hospital waiting times are up again this week.',
                createdAt: '2026-03-21T00:00:05.000Z',
              },
            },
            {
              uri: 'at://post-3',
              author: { handle: 'donsfan.bsky.social' },
              record: {
                text: 'Aberdeen need a response in this match after that Rangers goal.',
                createdAt: '2026-03-21T00:00:10.000Z',
              },
            },
          ],
        });
      }

      if (url.includes('q=Rangers+Aberdeen') || url.includes('q=Rangers+vs+Aberdeen')) {
        return jsonResponse({ posts: [] });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    const posts = await ingestBlueskySocialPosts(
      {
        homeTeam: 'Rangers',
        awayTeam: 'Aberdeen',
        clockMs: 12_000,
        fetchImpl: fetchMock as typeof fetch,
      },
      cache,
    );

    expect(posts).toHaveLength(2);
    expect(posts.some((post) => /hospital/i.test(post.text))).toBe(false);
    expect(posts.some((post) => /Rangers goal/i.test(post.text))).toBe(true);
  });
});
