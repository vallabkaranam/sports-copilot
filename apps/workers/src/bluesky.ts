import { SocialPost } from '@sports-copilot/shared-types';

const BLUESKY_BASE_URL = process.env.BLUESKY_BASE_URL ?? 'https://public.api.bsky.app';
const BLUESKY_SERVICE_URL = process.env.BLUESKY_SERVICE_URL ?? 'https://bsky.social';
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

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(fetchImpl: typeof fetch): Promise<string | null> {
  const identifier = process.env.BLUESKY_IDENTIFIER ?? '';
  const appPassword = process.env.BLUESKY_APP_PASSWORD ?? '';
  if (!identifier || !appPassword) {
    console.warn('[bluesky] no credentials in env');
    return null;
  }
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const response = await fetchImpl(`${BLUESKY_SERVICE_URL}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password: appPassword }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.warn('[bluesky] auth failed:', response.status, body);
    return null;
  }

  const data = (await response.json()) as { accessJwt: string };
  cachedToken = data.accessJwt;
  tokenExpiresAt = Date.now() + 60 * 60 * 1000; // cache for 1 hour
  console.log('[bluesky] auth success, token acquired');
  return cachedToken;
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

function normalizeQueryToken(text: string) {
  return normalizeText(text).replace(/\s+/g, ' ').trim();
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

export function buildQueries(homeTeam: string, awayTeam: string) {
  const home = normalizeQueryToken(homeTeam);
  const away = normalizeQueryToken(awayTeam);
  const candidates = [
    home,
    away,
    home && away ? `${home} ${away}` : '',
    home && away ? `${home} vs ${away}` : '',
  ];

  return [...new Set(candidates.filter((value) => value.length > 0))];
}

async function searchBlueskyPosts(
  query: string,
  limit: number,
  fetchImpl: typeof fetch,
  token: string | null,
) {
  const baseUrl = token ? BLUESKY_SERVICE_URL : BLUESKY_BASE_URL;
  const url = new URL('/xrpc/app.bsky.feed.searchPosts', baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('sort', 'latest');

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetchImpl(url.toString(), { headers });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Bluesky request failed with ${response.status}: ${body}`);
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
  const token = await getAccessToken(fetchImpl);
  const queries = buildQueries(config.homeTeam, config.awayTeam);

  if (queries.length > 0) {
    console.log('[bluesky] search queries:', JSON.stringify(queries));
  }

  for (const query of queries) {
    const payload = await searchBlueskyPosts(
      query,
      config.limitPerQuery ?? DEFAULT_QUERY_LIMIT,
      fetchImpl,
      token,
    );
    console.log(`[bluesky] query "${query}" → ${(payload.posts ?? []).length} posts`);
    normalizeBlueskyPosts(payload, config.clockMs, cache);
  }

  return Object.values(cache).sort((left, right) => left.timestamp - right.timestamp);
}
