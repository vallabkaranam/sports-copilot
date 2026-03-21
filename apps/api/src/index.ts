import fastify from 'fastify';
import {
  WorldState,
  createEmptyCommentatorState,
  createEmptyRetrievalState,
} from '@sports-copilot/shared-types';
import fs from 'fs/promises';
import path from 'path';

const server = fastify({ logger: true });

// Minimal initial state
let worldState: Partial<WorldState> = {
  matchId: 'clásico-2024-demo',
  clock: '00:00',
  score: { home: 0, away: 0 },
  possession: 'BAR',
  recentEvents: [],
  commentator: createEmptyCommentatorState(),
  narrative: {
    activeNarratives: [],
    currentSentiment: 'neutral',
    momentum: 'neutral',
  },
  retrieval: createEmptyRetrievalState(),
  liveSignals: { social: [], vision: [] },
};

let controlState = { status: 'paused' }; // 'playing' | 'paused' | 'stopped'

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
  const { status } = request.body as any;
  if (status) controlState.status = status;
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
