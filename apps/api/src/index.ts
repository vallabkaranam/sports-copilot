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
  TranscribeBoothAudioInputSchema,
  TranscribeBoothAudioResponse,
  createEmptyAssistCard,
  ReplayControlState,
  WorldState,
  createDefaultReplayControlState,
  createEmptyCommentatorState,
  createEmptyLiveMatchState,
  createEmptyNarrativeState,
  createEmptyPreMatchState,
  createEmptyRetrievalState,
  createEmptySessionMemory,
} from '@sports-copilot/shared-types';
import fs from 'fs/promises';
import path from 'path';
import { interpretBoothWithOpenAI } from './booth-interpretation';
import { createBoothSessionStore } from './booth-session-store';
import { transcribeBoothAudioWithOpenAI } from './booth-transcription';

const server = fastify({ logger: true });
const API_PORT = Number(process.env.PORT ?? 3001);
const API_HOST = process.env.HOST ?? '0.0.0.0';
let boothSessionStore: Awaited<ReturnType<typeof createBoothSessionStore>> | null = null;

function requireBoothSessionStore() {
  if (!boothSessionStore) {
    throw new Error('Booth session store is not initialized yet.');
  }

  return boothSessionStore;
}

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
  preMatch: createEmptyPreMatchState(),
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

server.get('/booth-sessions', async (): Promise<BoothSessionsResponse> => {
  const sessionStore = requireBoothSessionStore();
  return {
    analytics: await sessionStore.getAnalytics(),
    sessions: await sessionStore.listSessions(),
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

server.post('/booth/transcribe', async (request, reply): Promise<TranscribeBoothAudioResponse | void> => {
  const parsed = TranscribeBoothAudioInputSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({ error: 'Invalid booth transcription payload' });
    return;
  }

  return transcribeBoothAudioWithOpenAI(parsed.data.audioBase64, parsed.data.mimeType);
});

server.post('/booth-sessions/start', async (request, reply): Promise<StartBoothSessionResponse | void> => {
  const sessionStore = requireBoothSessionStore();
  const parsed = StartBoothSessionInputSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({ error: 'Invalid booth session payload' });
    return;
  }

  return {
    session: await sessionStore.createSession(parsed.data.clipName),
  };
});

server.post('/booth-sessions/:sessionId/sample', async (request, reply) => {
  const sessionStore = requireBoothSessionStore();
  const parsed = AppendBoothSessionSampleInputSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({ error: 'Invalid booth sample payload' });
    return;
  }

  try {
    return {
      session: await sessionStore.appendSample(
        (request.params as { sessionId: string }).sessionId,
        parsed.data.sample,
      ),
    };
  } catch (_error) {
    reply.status(404).send({ error: 'Booth session not found' });
  }
});

server.post('/booth-sessions/:sessionId/finish', async (request, reply) => {
  const sessionStore = requireBoothSessionStore();
  const parsed = FinishBoothSessionInputSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    reply.status(400).send({ error: 'Invalid booth session finish payload' });
    return;
  }

  try {
    return {
      session: await sessionStore.finishSession(
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
    boothSessionStore = await createBoothSessionStore();
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
