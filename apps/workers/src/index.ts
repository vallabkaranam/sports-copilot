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

const API_HOSTNAME = 'localhost';
const API_PORT = 3001;
const TICK_RATE_MS = 500;

async function loadFixture<T>(fixturePath: string) {
  const data = await fs.readFile(fixturePath, 'utf8');
  return JSON.parse(data) as T;
}

async function syncState(state: Partial<WorldState>) {
  return new Promise<boolean>((resolve, reject) => {
    const data = JSON.stringify(state);
    const req = http.request(
      {
        hostname: API_HOSTNAME,
        port: API_PORT,
        path: '/internal/state',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
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
    http.get(`http://${API_HOSTNAME}:${API_PORT}/controls`, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve(JSON.parse(data) as ReplayControlState));
    }).on('error', reject);
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
  const fixturesDir = path.resolve(__dirname, '../../../data/demo_match');
  const [events, roster, narratives, socialPosts, transcript, visionFrames] = await Promise.all([
    loadFixture<GameEvent[]>(path.join(fixturesDir, 'events.json')),
    loadFixture<RosterFixture>(path.join(fixturesDir, 'roster.json')),
    loadFixture<NarrativeFixture[]>(path.join(fixturesDir, 'narratives.json')),
    loadFixture<SocialPost[]>(path.join(fixturesDir, 'fake_social.json')),
    loadFixture<TranscriptEntry[]>(path.join(fixturesDir, 'transcript_seed.json')),
    loadFixture<VisionFrame[]>(path.join(fixturesDir, 'vision_frames.json')),
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
