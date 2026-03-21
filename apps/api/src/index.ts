import 'dotenv/config';
import fastify from 'fastify';
import {
  AppendBoothSessionSampleInputSchema,
  BoothInterpretation,
  BoothSessionsResponse,
  FinishBoothSessionInputSchema,
  InterpretBoothInputSchema,
  StartBoothSessionInputSchema,
  StartBoothSessionResponse,
  createEmptyAssistCard,
  ReplayControlState,
  WorldState,
  createDefaultReplayControlState,
  createEmptyCommentatorState,
  createEmptyNarrativeState,
  createEmptyRetrievalState,
  createEmptySessionMemory,
} from '@sports-copilot/shared-types';
import fs from 'fs/promises';
import path from 'path';
import { interpretBoothWithOpenAI } from './booth-interpretation';
import { createBoothSessionStore } from './booth-session-store';

const server = fastify({ logger: true });
const boothSessionStore = createBoothSessionStore();
const API_PORT = Number(process.env.PORT ?? 3001);
const API_HOST = process.env.HOST ?? '0.0.0.0';

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
  matchId: 'clásico-2024-demo',
  clock: '00:00',
  score: { home: 0, away: 0 },
  possession: 'BAR',
  gameStateSummary: 'El Clasico is underway and both sides are settling into shape.',
  highSalienceMoments: [],
  recentEvents: [],
  sessionMemory: createEmptySessionMemory(),
  assist: createEmptyAssistCard(),
  commentator: createEmptyCommentatorState(),
  narrative: createEmptyNarrativeState(),
  retrieval: createEmptyRetrievalState(),
  liveSignals: { social: [], vision: [] },
};

let controlState: ReplayControlState = createDefaultReplayControlState();

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
  const { playbackStatus, preferredStyleMode, forceHesitation, restart } = request.body as Partial<
    ReplayControlState
  > & {
    restart?: boolean;
  };

  if (playbackStatus) controlState.playbackStatus = playbackStatus;
  if (preferredStyleMode) controlState.preferredStyleMode = preferredStyleMode;
  if (typeof forceHesitation === 'boolean') controlState.forceHesitation = forceHesitation;
  if (restart) controlState.restartToken += 1;
  return controlState;
});

server.get('/booth-sessions', async (): Promise<BoothSessionsResponse> => {
  return {
    analytics: boothSessionStore.getAnalytics(),
    sessions: boothSessionStore.listSessions(),
  };
});

server.post('/booth/interpret', async (request, reply): Promise<BoothInterpretation | void> => {
  const parsed = InterpretBoothInputSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({ error: 'Invalid booth interpretation payload' });
    return;
  }

  return interpretBoothWithOpenAI(parsed.data.features);
});

server.post('/booth-sessions/start', async (request, reply): Promise<StartBoothSessionResponse | void> => {
  const parsed = StartBoothSessionInputSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({ error: 'Invalid booth session payload' });
    return;
  }

  return {
    session: boothSessionStore.createSession(parsed.data.clipName),
  };
});

server.post('/booth-sessions/:sessionId/sample', async (request, reply) => {
  const parsed = AppendBoothSessionSampleInputSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({ error: 'Invalid booth sample payload' });
    return;
  }

  try {
    return {
      session: boothSessionStore.appendSample(
        (request.params as { sessionId: string }).sessionId,
        parsed.data.sample,
      ),
    };
  } catch (_error) {
    reply.status(404).send({ error: 'Booth session not found' });
  }
});

server.post('/booth-sessions/:sessionId/finish', async (request, reply) => {
  const parsed = FinishBoothSessionInputSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    reply.status(400).send({ error: 'Invalid booth session finish payload' });
    return;
  }

  try {
    return {
      session: boothSessionStore.finishSession(
        (request.params as { sessionId: string }).sessionId,
        parsed.data.endedAt,
      ),
    };
  } catch (_error) {
    reply.status(404).send({ error: 'Booth session not found' });
  }
});

const start = async () => {
  try {
    const rosterPath = path.resolve(__dirname, '../../../data/demo_match/roster.json');
    const rosterData = await fs.readFile(rosterPath, 'utf8');
    const roster = JSON.parse(rosterData);
    
    console.log('Loaded Roster:', roster.home.name, 'vs', roster.away.name);

    await server.listen({ port: API_PORT, host: API_HOST });
    console.log(`API running on http://${API_HOST}:${API_PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
