import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import { buildAssistCard } from './assist';
import { BlueskyPostCache, ingestBlueskySocialPosts } from './bluesky';
import { analyzeCommentary } from './commentator';
import { buildNarrativeState } from './narrative';
import { buildPreMatchContext, createDegradedPreMatchState } from './pre-match';
import {
  buildRetrievalState,
  ingestLiveSocialPosts,
  NarrativeFixture,
} from './retrieval';
import { createSessionMemoryTracker } from './session-memory';
import {
  buildLiveGameStateSummary,
  buildPossessionLabel,
  buildRosterFromLiveMatch,
  fetchSportmonksFixture,
  normalizeSportmonksFixture,
} from './sportmonks';
import { getActiveVisionCues, ingestVisionFrames } from './vision';
import {
  CommentatorState,
  GameEvent,
  ReplayControlState,
  SocialPost,
  TranscriptEntry,
  VisionCue,
  VisionFrame,
  WorldState,
  createDefaultReplayControlState,
  createEmptyAssistCard,
  createEmptyCommentatorState,
  createEmptyLiveMatchState,
  createEmptyNarrativeState,
  createEmptyPreMatchState,
  createEmptyRetrievalState,
} from '@sports-copilot/shared-types';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3001';
const API_URL = new URL(API_BASE_URL);
const API_HOSTNAME = API_URL.hostname;
const API_PORT = Number(API_URL.port || (API_URL.protocol === 'https:' ? 443 : 80));
const HEALTH_PORT = Number(process.env.PORT ?? 0);
const POLL_INTERVAL_MS = 15_000;

async function loadFixture<T>(fixturePath: string) {
  const data = await fs.readFile(fixturePath, 'utf8');
  return JSON.parse(data) as T;
}

async function loadRequiredFixture<T>(fixturePath: string, label: string) {
  try {
    return await loadFixture<T>(fixturePath);
  } catch (error) {
    throw new Error(
      `Failed to load required fixture "${label}" from ${fixturePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function loadOptionalFixture<T>(fixturePath: string, fallback: T) {
  try {
    return await loadFixture<T>(fixturePath);
  } catch (_error) {
    return fallback;
  }
}

async function syncState(state: Partial<WorldState>) {
  return new Promise<boolean>((resolve, reject) => {
    const data = JSON.stringify(state);
    const req = http.request(
      {
        hostname: API_HOSTNAME,
        port: API_PORT,
        path: `${API_URL.pathname.replace(/\/$/, '')}/internal/state`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      () => resolve(true),
    );

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getControls() {
  return new Promise<ReplayControlState>((resolve, reject) => {
    http.get(new URL(`${API_URL.pathname.replace(/\/$/, '')}/controls`, API_BASE_URL), (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve(JSON.parse(data) as ReplayControlState));
    }).on('error', reject);
  });
}

function startHealthServer() {
  if (!HEALTH_PORT) {
    return;
  }

  const healthServer = http.createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', apiBaseUrl: API_BASE_URL }));
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('Sports Copilot worker is running.\n');
  });

  healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`Worker health server listening on :${HEALTH_PORT}`);
  });
}

function applyForcedHesitation(commentator: CommentatorState, forceHesitation: boolean) {
  if (!forceHesitation) {
    return commentator;
  }

  const hesitationReasons = commentator.hesitationReasons.includes(
    'Manual demo hesitation trigger is active.',
  )
    ? commentator.hesitationReasons
    : [...commentator.hesitationReasons, 'Manual demo hesitation trigger is active.'];

  return {
    ...commentator,
    pauseDurationMs: Math.max(commentator.pauseDurationMs, 2_500),
    hesitationScore: Math.max(commentator.hesitationScore, 0.72),
    hesitationReasons,
  };
}

function toClock(minute: number, stoppageMinute: number | null) {
  const baseMinute = Math.max(0, Math.floor(minute));
  const mins = Math.floor(baseMinute / 60);
  const secs = baseMinute % 60;
  const clock = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  if (stoppageMinute && stoppageMinute > 0) {
    return `${clock}+${stoppageMinute}`;
  }

  return clock;
}

function buildDegradedState(reason: string, fixtureId: string) {
  return {
    ...createEmptyLiveMatchState(),
    fixtureId,
    isDegraded: true,
    degradedReason: reason,
    lastUpdatedAt: Date.now(),
  };
}

async function run() {
  startHealthServer();
  const fixturesDir = path.resolve(__dirname, '../../../data/demo_match');
  const [narratives, socialPosts, transcript, visionFrames] = await Promise.all([
    loadRequiredFixture<NarrativeFixture[]>(path.join(fixturesDir, 'narratives.json'), 'narratives'),
    loadOptionalFixture<SocialPost[]>(path.join(fixturesDir, 'fake_social.json'), []),
    loadOptionalFixture<TranscriptEntry[]>(path.join(fixturesDir, 'transcript_seed.json'), []),
    loadOptionalFixture<VisionFrame[]>(path.join(fixturesDir, 'vision_frames.json'), []),
  ]);
  const visionCues: VisionCue[] = ingestVisionFrames(visionFrames);
  const sessionMemory = createSessionMemoryTracker();
  let lastKnownControls = createDefaultReplayControlState();
  let lastHandledRestartToken = 0;
  let lastPreMatchFixtureId = '';
  let blueskyCache: BlueskyPostCache = {};
  let lastWorldState: Partial<WorldState> = {
    matchId: 'sportmonks-live',
    clock: '00:00',
    score: { home: 0, away: 0 },
    possession: 'LIVE',
    gameStateSummary: 'Waiting for the first live Sportmonks snapshot.',
    highSalienceMoments: [],
    recentEvents: [],
    sessionMemory: sessionMemory.getState([], []),
    commentator: createEmptyCommentatorState(),
    narrative: createEmptyNarrativeState(),
    retrieval: createEmptyRetrievalState(),
    assist: createEmptyAssistCard(),
    preMatch: createEmptyPreMatchState(),
    liveMatch: buildDegradedState('Waiting for Sportmonks data.', process.env.SPORTMONKS_FIXTURE_ID ?? ''),
    liveSignals: { social: [], vision: [] },
  };

  console.log('Live Match Worker started.');

  setInterval(async () => {
    try {
      const controls = await getControls().catch(() => lastKnownControls);
      lastKnownControls = controls;

      if (controls.restartToken > lastHandledRestartToken) {
        sessionMemory.reset();
        lastHandledRestartToken = controls.restartToken;
      }

      if (controls.playbackStatus === 'paused' && lastWorldState.liveMatch) {
        await syncState(lastWorldState);
        return;
      }

      const fixtureId = controls.activeFixtureId ?? process.env.SPORTMONKS_FIXTURE_ID ?? '';
      const apiToken = process.env.SPORTMONKS_API_TOKEN ?? '';

      if (fixtureId && fixtureId !== lastPreMatchFixtureId) {
        lastWorldState = {
          ...lastWorldState,
          preMatch: createEmptyPreMatchState(),
        };
        blueskyCache = {};
      }

      if (!fixtureId || !apiToken) {
        const degradedLiveMatch = buildDegradedState(
          'Sportmonks credentials or fixture ID are missing.',
          fixtureId,
        );
        const degradedPreMatch = createDegradedPreMatchState(
          'Sportmonks credentials or fixture ID are missing.',
        );

        lastWorldState = {
          ...lastWorldState,
          matchId: fixtureId ? `sportmonks-${fixtureId}` : 'sportmonks-live',
          preMatch: degradedPreMatch,
          liveMatch: degradedLiveMatch,
          gameStateSummary: degradedLiveMatch.degradedReason ?? 'Live data unavailable.',
        };

        await syncState(lastWorldState);
        return;
      }

      let preMatch = lastWorldState.preMatch ?? createEmptyPreMatchState();
      if (fixtureId !== lastPreMatchFixtureId || preMatch.loadStatus === 'pending') {
        try {
          preMatch = await buildPreMatchContext({
            apiToken,
            fixtureId,
            openAiApiKey: process.env.OPENAI_API_KEY,
            openAiModel: process.env.OPENAI_MODEL,
          });
          lastPreMatchFixtureId = fixtureId;
        } catch (error) {
          preMatch = createDegradedPreMatchState(
            `Pre-match context unavailable: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      const payload = await fetchSportmonksFixture({
        apiToken,
        fixtureId,
      });
      const snapshot = normalizeSportmonksFixture(payload, fixtureId);
      const clockMs = snapshot.liveMatch.minute * 60_000;
      let resolvedSocialPosts = socialPosts;

      if (process.env.BLUESKY_SOCIAL_ENABLED !== 'false') {
        try {
          const blueskyPosts = await ingestBlueskySocialPosts(
            {
              homeTeam: snapshot.liveMatch.homeTeam.name,
              awayTeam: snapshot.liveMatch.awayTeam.name,
              clockMs,
            },
            blueskyCache,
          );
          resolvedSocialPosts = [...socialPosts, ...blueskyPosts].sort(
            (left, right) => left.timestamp - right.timestamp,
          );
        } catch (error) {
          console.warn(
            'Bluesky social ingest failed:',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      const commentator = applyForcedHesitation(
        analyzeCommentary({
          clockMs,
          events: snapshot.events,
          transcript,
        }),
        controls.forceHesitation,
      );
      const narrative = buildNarrativeState({
        clockMs,
        events: snapshot.events,
        narratives,
        liveMatch: snapshot.liveMatch,
      });
      const roster = buildRosterFromLiveMatch(snapshot.liveMatch);
      const activeVisionCues = getActiveVisionCues(clockMs, visionCues);
      const retrieval = buildRetrievalState({
        clockMs,
        events: snapshot.events,
        transcript,
        roster,
        narratives,
        socialPosts: resolvedSocialPosts,
        visionCues,
        liveMatch: snapshot.liveMatch,
        preMatch,
      });
      const assist = buildAssistCard({
        clockMs,
        events: snapshot.events,
        commentator,
        narrative,
        retrieval,
        preferredStyleMode: controls.preferredStyleMode,
        forceIntervention: controls.forceHesitation,
      });

      sessionMemory.rememberAssist(assist);
      const ingestedSocialPosts = ingestLiveSocialPosts(clockMs, resolvedSocialPosts);
      const score = snapshot.score;
      const recentEvents = snapshot.events.slice(-8);
      const highSalienceMoments = snapshot.events.filter((event) => event.highSalience).slice(-4);
      const possession = buildPossessionLabel(snapshot.liveMatch, snapshot.liveMatch.stats);
      const sessionMemoryState = sessionMemory.getState(recentEvents, commentator.recentTranscript);

      lastWorldState = {
        matchId: `sportmonks-${fixtureId}`,
        clock: toClock(snapshot.liveMatch.minute, snapshot.liveMatch.stoppageMinute),
        score,
        possession,
        gameStateSummary: buildLiveGameStateSummary({
          liveMatch: snapshot.liveMatch,
          events: snapshot.events,
          score,
        }),
        highSalienceMoments,
        recentEvents,
        sessionMemory: sessionMemoryState,
        commentator,
        narrative,
        retrieval,
        assist,
        preMatch,
        liveMatch: snapshot.liveMatch,
        liveSignals: {
          social: ingestedSocialPosts,
          vision: activeVisionCues,
        },
      };

      await syncState(lastWorldState);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const previousLiveMatch = lastWorldState.liveMatch ?? createEmptyLiveMatchState();

      lastWorldState = {
        ...lastWorldState,
        liveMatch: {
          ...previousLiveMatch,
          isDegraded: true,
          degradedReason: `Sportmonks sync failed: ${message}`,
          lastUpdatedAt: Date.now(),
        },
        gameStateSummary: `Sportmonks sync failed: ${message}`,
      };

      await syncState(lastWorldState).catch(() => undefined);
      console.error('Worker loop error:', error);
    }
  }, POLL_INTERVAL_MS);
}

run().catch(console.error);
