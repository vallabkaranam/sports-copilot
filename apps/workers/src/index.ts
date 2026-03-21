import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import { buildAssistCard } from './assist';
import { analyzeCommentary } from './commentator';
import { ReplayEngine } from './engine';
import { buildNarrativeState } from './narrative';
import { buildRetrievalState, ingestLiveSocialPosts, NarrativeFixture, RosterFixture } from './retrieval';
import { createSessionMemoryTracker } from './session-memory';
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
} from '@sports-copilot/shared-types';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3001';
const API_URL = new URL(API_BASE_URL);
const API_HOSTNAME = API_URL.hostname;
const API_PORT = Number(API_URL.port || (API_URL.protocol === 'https:' ? 443 : 80));
const HEALTH_PORT = Number(process.env.PORT ?? 0);
const TICK_RATE_MS = 500;

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

async function loadOptionalFixture<T>(fixturePath: string, label: string, fallback: T) {
  try {
    return await loadFixture<T>(fixturePath);
  } catch (error) {
    console.warn(
      `Optional fixture "${label}" is unavailable. Falling back to demo-safe defaults.`,
      error,
    );
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

async function run() {
  startHealthServer();
  const fixturesDir = path.resolve(__dirname, '../../../data/demo_match');
  const [events, roster, narratives, socialPosts, transcript, visionFrames] = await Promise.all([
    loadRequiredFixture<GameEvent[]>(path.join(fixturesDir, 'events.json'), 'events'),
    loadRequiredFixture<RosterFixture>(path.join(fixturesDir, 'roster.json'), 'roster'),
    loadRequiredFixture<NarrativeFixture[]>(path.join(fixturesDir, 'narratives.json'), 'narratives'),
    loadOptionalFixture<SocialPost[]>(path.join(fixturesDir, 'fake_social.json'), 'social', []),
    loadRequiredFixture<TranscriptEntry[]>(path.join(fixturesDir, 'transcript_seed.json'), 'transcript'),
    loadOptionalFixture<VisionFrame[]>(path.join(fixturesDir, 'vision_frames.json'), 'vision', []),
  ]);
  const visionCues: VisionCue[] = ingestVisionFrames(visionFrames);

  const engine = new ReplayEngine({ events, tickRateMs: TICK_RATE_MS });
  const sessionMemory = createSessionMemoryTracker();
  let lastKnownControls = createDefaultReplayControlState();
  let lastHandledRestartToken = 0;

  console.log('Replay Worker started.');

  setInterval(async () => {
    try {
      const controls = await getControls().catch(() => lastKnownControls);
      lastKnownControls = controls;

      if (controls.restartToken > lastHandledRestartToken) {
        engine.restart();
        sessionMemory.reset();
        lastHandledRestartToken = controls.restartToken;

        if (controls.playbackStatus === 'paused') {
          engine.pause();
        }
      }

      if (controls.playbackStatus === 'playing') {
        engine.play();
      } else {
        engine.pause();
      }

      const newEvents = engine.tick(TICK_RATE_MS);
      const status = engine.getStatus();
      const clockMs = engine.getMatchClockMs();
      const rawCommentator = analyzeCommentary({
        clockMs,
        events,
        transcript,
      });
      const commentator = applyForcedHesitation(rawCommentator, controls.forceHesitation);
      const narrative = buildNarrativeState({
        clockMs,
        events,
        narratives,
      });
      const activeVisionCues = getActiveVisionCues(clockMs, visionCues);
      const retrieval = buildRetrievalState({
        clockMs,
        events,
        transcript,
        roster,
        narratives,
        socialPosts,
        visionCues,
      });
      const assist = buildAssistCard({
        clockMs,
        events,
        commentator,
        narrative,
        retrieval,
        preferredStyleMode: controls.preferredStyleMode,
        forceIntervention: controls.forceHesitation,
      });
      sessionMemory.rememberAssist(assist);
      const sessionMemoryState = sessionMemory.getState(engine, commentator.recentTranscript);
      const ingestedSocialPosts = ingestLiveSocialPosts(clockMs, socialPosts);

      await syncState({
        ...status,
        assist,
        commentator,
        narrative,
        retrieval,
        recentEvents: status.recentEvents ?? [],
        sessionMemory: sessionMemoryState,
        liveSignals: {
          social: ingestedSocialPosts,
          vision: activeVisionCues,
        },
      });

      if (newEvents) {
        console.log(`[Replay] Clock: ${status.clock} - New events: ${newEvents.length}`);
      }
    } catch (error) {
      console.error('Worker loop error:', error);
    }
  }, TICK_RATE_MS);
}

run().catch(console.error);
