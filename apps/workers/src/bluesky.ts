import { SocialPost } from '@sports-copilot/shared-types';

const BLUESKY_BASE_URL = process.env.BLUESKY_BASE_URL ?? 'https://public.api.bsky.app';
const DEFAULT_QUERY_LIMIT = 6;

interface BlueskySearchConfig {
  homeTeam: string;
  awayTeam: string;
  clockMs: number;
  fetchImpl?: typeof fetch;
  limitPerQuery?: number;
}

interface BlueskySearchResponse {
  posts?: Array<{
    uri?: string;
    author?: {
      handle?: string;
    };
    record?: {
      text?: string;
      createdAt?: string;
    };
    likeCount?: number;
    repostCount?: number;
    replyCount?: number;
  }>;
}

export interface BlueskyPostCache {
  [uri: string]: SocialPost;
}

function asString(value: unknown) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value);
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function inferSentiment(text: string) {
  const normalized = text.toLowerCase();

  if (/\b(goal|great|huge|massive|brilliant|class|amazing|win|leading)\b/.test(normalized)) {
    return 'positive';
  }

  if (/\b(miss|awful|terrible|bad|losing|error|red card|injury)\b/.test(normalized)) {
    return 'negative';
  }

  return 'neutral';
}

function buildQueries(homeTeam: string, awayTeam: string) {
  return [...new Set([homeTeam.trim(), awayTeam.trim()].filter((value) => value.length > 0))];
}

async function searchBlueskyPosts(
  query: string,
  limit: number,
  fetchImpl: typeof fetch,
) {
  const url = new URL('/xrpc/app.bsky.feed.searchPosts', BLUESKY_BASE_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('sort', 'latest');

  const response = await fetchImpl(url.toString(), {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Bluesky request failed with ${response.status}`);
  }

  return (await response.json()) as BlueskySearchResponse;
}

function normalizeBlueskyPosts(
  payload: BlueskySearchResponse,
  clockMs: number,
  cache: BlueskyPostCache,
) {
  const posts = payload.posts ?? [];

  for (const post of posts) {
    const uri = asString(post.uri);
    const handle = asString(post.author?.handle).trim();
    const text = normalizeText(asString(post.record?.text));

    if (!uri || !handle || !text) {
      continue;
    }

    if (cache[uri]) {
      continue;
    }

    cache[uri] = {
      timestamp: clockMs,
      handle: handle.startsWith('@') ? handle : `@${handle}`,
      text,
      sentiment: inferSentiment(text),
    };
  }
}

export async function ingestBlueskySocialPosts(
  config: BlueskySearchConfig,
  cache: BlueskyPostCache,
) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const queries = buildQueries(config.homeTeam, config.awayTeam);

  for (const query of queries) {
    const payload = await searchBlueskyPosts(
      query,
      config.limitPerQuery ?? DEFAULT_QUERY_LIMIT,
      fetchImpl,
    );
    normalizeBlueskyPosts(payload, config.clockMs, cache);
  }

  return Object.values(cache).sort((left, right) => left.timestamp - right.timestamp);
}
