import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import { buildAssistCard } from './assist';
import { ReplayEngine } from './engine';
import { analyzeCommentary } from './commentator';
import { buildNarrativeState } from './narrative';
import { buildRetrievalState, ingestLiveSocialPosts, NarrativeFixture, RosterFixture } from './retrieval';
import {
  GameEvent,
  SocialPost,
  TranscriptEntry,
  WorldState,
} from '@sports-copilot/shared-types';

async function syncState(state: Partial<WorldState>) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(state);
    const req = http.request({
      hostname: 'localhost',
      port: 3001,
      path: '/internal/state',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    }, (res) => {
      resolve(true);
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getControls(): Promise<{ status: string }> {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:3001/controls', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function run() {
  const eventsPath = path.resolve(__dirname, '../../../data/demo_match/events.json');
  const rosterPath = path.resolve(__dirname, '../../../data/demo_match/roster.json');
  const narrativesPath = path.resolve(__dirname, '../../../data/demo_match/narratives.json');
  const socialPath = path.resolve(__dirname, '../../../data/demo_match/fake_social.json');
  const transcriptPath = path.resolve(__dirname, '../../../data/demo_match/transcript_seed.json');
  const eventsData = await fs.readFile(eventsPath, 'utf8');
  const rosterData = await fs.readFile(rosterPath, 'utf8');
  const narrativesData = await fs.readFile(narrativesPath, 'utf8');
  const socialData = await fs.readFile(socialPath, 'utf8');
  const transcriptData = await fs.readFile(transcriptPath, 'utf8');
  const events: GameEvent[] = JSON.parse(eventsData);
  const roster: RosterFixture = JSON.parse(rosterData);
  const narratives: NarrativeFixture[] = JSON.parse(narrativesData);
  const socialPosts: SocialPost[] = JSON.parse(socialData);
  const transcript: TranscriptEntry[] = JSON.parse(transcriptData);

  const engine = new ReplayEngine({ events, tickRateMs: 500 });
  engine.play();

  console.log('Replay Worker started.');

  setInterval(async () => {
    try {
      // 1. Check for control updates (play/pause)
      const controls = await getControls();
      if (controls.status === 'playing') engine.play();
      if (controls.status === 'paused') engine.pause();
      if (controls.status === 'restart') engine.restart();

      // 2. Tick engine
      const newEvents = engine.tick(500);
      const status = engine.getStatus();
      const clockMs = engine.getMatchClockMs();
      const commentator = analyzeCommentary({
        clockMs,
        events,
        transcript,
      });
      const narrative = buildNarrativeState({
        clockMs,
        events,
        narratives,
      });
      const retrieval = buildRetrievalState({
        clockMs,
        events,
        transcript,
        roster,
        narratives,
        socialPosts,
      });
      const assist = buildAssistCard({
        clockMs,
        events,
        commentator,
        narrative,
        retrieval,
      });
      const ingestedSocialPosts = ingestLiveSocialPosts(clockMs, socialPosts);

      // 3. Sync to API
      await syncState({
        ...status,
        assist,
        commentator,
        narrative,
        retrieval,
        liveSignals: {
          social: ingestedSocialPosts,
          vision: [],
        },
        recentEvents: newEvents || [],
      });
      
      if (newEvents) {
        console.log(`[Replay] Clock: ${status.clock} - New events: ${newEvents.length}`);
      }
    } catch (err) {
      console.error('Worker loop error:', err);
    }
  }, 500);
}

run().catch(console.error);
