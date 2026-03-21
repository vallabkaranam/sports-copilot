import fastify from 'fastify';
import {
  createEmptyAssistCard,
  ReplayControlState,
  WorldState,
  createDefaultReplayControlState,
  createEmptyCommentatorState,
  createEmptyLiveMatchState,
  createEmptyNarrativeState,
  createEmptyRetrievalState,
  createEmptySessionMemory,
} from '@sports-copilot/shared-types';
import fs from 'fs/promises';
import path from 'path';

const server = fastify({ logger: true });

server.addHook('onRequest', async (request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Headers', 'Content-Type');
  reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (request.method === 'OPTIONS') {
    reply.code(204).send();
  }
});

// Minimal initial state
let worldState: Partial<WorldState> = {
  matchId: 'sportmonks-live',
  clock: '00:00',
  score: { home: 0, away: 0 },
  possession: 'LIVE',
  gameStateSummary: 'Waiting for Sportmonks live data.',
  highSalienceMoments: [],
  recentEvents: [],
  sessionMemory: createEmptySessionMemory(),
  assist: createEmptyAssistCard(),
  commentator: createEmptyCommentatorState(),
  narrative: createEmptyNarrativeState(),
  retrieval: createEmptyRetrievalState(),
  liveMatch: createEmptyLiveMatchState(),
  liveSignals: { social: [], vision: [] },
};

let controlState: ReplayControlState = createDefaultReplayControlState();
controlState.activeFixtureId = process.env.SPORTMONKS_FIXTURE_ID;

server.get('/health', async () => {
  return { status: 'ok', matchId: worldState.matchId };
});

server.get('/world-state', async () => {
  return worldState;
});

// Update state from workers
server.post('/internal/state', async (request, reply) => {
  try {
    const update = request.body as Partial<WorldState>;
    worldState = { ...worldState, ...update };
    return { success: true };
  } catch (err) {
    reply.status(400).send({ error: 'Invalid state update' });
  }
});

// Controls for the replay
server.get('/controls', async () => controlState);

server.post('/controls', async (request) => {
  const { playbackStatus, preferredStyleMode, forceHesitation, restart, activeFixtureId } = request.body as Partial<
    ReplayControlState
  > & {
    restart?: boolean;
  };

  if (playbackStatus) controlState.playbackStatus = playbackStatus;
  if (preferredStyleMode) controlState.preferredStyleMode = preferredStyleMode;
  if (typeof forceHesitation === 'boolean') controlState.forceHesitation = forceHesitation;
  if (activeFixtureId) controlState.activeFixtureId = activeFixtureId;
  if (restart) controlState.restartToken += 1;
  return controlState;
});

const start = async () => {
  try {
    const rosterPath = path.resolve(__dirname, '../../../data/demo_match/roster.json');
    const rosterData = await fs.readFile(rosterPath, 'utf8');
    const roster = JSON.parse(rosterData);
    
    console.log('Loaded Roster:', roster.home.name, 'vs', roster.away.name);

    await server.listen({ port: 3001, host: '0.0.0.0' });
    console.log('API running on http://localhost:3001');
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
