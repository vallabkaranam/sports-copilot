import { describe, expect, it, vi } from 'vitest';
import { BlueskyPostCache, ingestBlueskySocialPosts } from './bluesky';

function jsonResponse(data: unknown) {
  return Promise.resolve({
    ok: true,
    json: async () => data,
  } as Response);
}

describe('bluesky social ingest', () => {
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
                text: 'Barcelona are flying here.',
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
                text: 'Barcelona are flying here.',
                createdAt: '2026-03-21T00:00:00.000Z',
              },
            },
            {
              uri: 'at://post-2',
              author: { handle: 'analyst.bsky.social' },
              record: {
                text: 'Real Madrid need a response.',
                createdAt: '2026-03-21T00:00:10.000Z',
              },
            },
          ],
        });
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
  });
});
