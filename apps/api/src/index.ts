import 'dotenv/config';
import fastify from 'fastify';
import fsSync from 'fs';
import {
  AppendBoothSessionSampleInputSchema,
  BoothInterpretation,
  BoothSessionReview,
  BoothSessionsResponse,
  FinishBoothSessionInputSchema,
  GenerateBoothCueInputSchema,
  GenerateBoothCueResponse,
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
import { generateBoothCueWithOpenAI } from './booth-assist';
import { interpretBoothWithOpenAI } from './booth-interpretation';
import { createRealtimeBoothSdpAnswer } from './booth-realtime';
import { reviewBoothSessionWithOpenAI } from './booth-review';
import { createBoothSessionStore } from './booth-session-store';
import { transcribeBoothAudioWithOpenAI } from './booth-transcription';

const server = fastify({ logger: true });
const API_PORT = Number(process.env.PORT ?? 3001);
const API_HOST = process.env.HOST ?? '0.0.0.0';
let boothSessionStore: Awaited<ReturnType<typeof createBoothSessionStore>> | null = null;
const PRESET_FEEDS: Record<string, { filePath: string; contentType: string }> = {
  barca: {
    filePath: process.env.AND_ONE_PRESET_BARCA_PATH ?? '/Users/vallabkaranam/Desktop/barca.mov',
    contentType: 'video/quicktime',
  },
};

server.addContentTypeParser(['application/sdp', 'text/plain'], { parseAs: 'string' }, (_req, body, done) => {
  done(null, body);
});

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

server.get('/preset-feeds/:feedId', async (request, reply) => {
  const { feedId } = request.params as { feedId: string };
  const preset = PRESET_FEEDS[feedId];

  if (!preset || !fsSync.existsSync(preset.filePath)) {
    reply.status(404).send({ error: 'Preset feed not found' });
    return;
  }

  const stats = await fs.stat(preset.filePath);
  const fileSize = stats.size;
  const rangeHeader = request.headers.range;

  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', preset.contentType);
  reply.header('Cache-Control', 'no-store');

  if (rangeHeader) {
    const rangeMatch = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    const start = rangeMatch?.[1] ? Number(rangeMatch[1]) : 0;
    const requestedEnd = rangeMatch?.[2] ? Number(rangeMatch[2]) : fileSize - 1;
    const end = Math.min(requestedEnd, fileSize - 1);
    const chunkSize = end - start + 1;

    reply
      .code(206)
      .header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
      .header('Content-Length', String(chunkSize));

    return reply.send(fsSync.createReadStream(preset.filePath, { start, end }));
  }

  reply.header('Content-Length', String(fileSize));
  return reply.send(fsSync.createReadStream(preset.filePath));
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

server.get('/booth-sessions/:sessionId', async (request, reply) => {
  const sessionStore = requireBoothSessionStore();
  const session = await sessionStore.getSession((request.params as { sessionId: string }).sessionId);

  if (!session) {
    reply.status(404).send({ error: 'Booth session not found' });
    return;
  }

  return { session };
});

server.get('/booth-sessions/:sessionId/review', async (request, reply): Promise<{ review: BoothSessionReview } | void> => {
  const sessionStore = requireBoothSessionStore();
  const session = await sessionStore.getSession((request.params as { sessionId: string }).sessionId);

  if (!session) {
    reply.status(404).send({ error: 'Booth session not found' });
    return;
  }

  const profile = await sessionStore.getSpeakerProfile();
  return {
    review: await reviewBoothSessionWithOpenAI(session, profile),
  };
});

server.post('/booth/interpret', async (request, reply): Promise<BoothInterpretation | void> => {
  const sessionStore = requireBoothSessionStore();
  const parsed = InterpretBoothInputSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({ error: 'Invalid booth interpretation payload' });
    return;
  }

  const profile = parsed.data.profile ?? (await sessionStore.getSpeakerProfile());

  return interpretBoothWithOpenAI(parsed.data.features, profile);
});

server.post('/booth/generate-cue', async (request, reply): Promise<GenerateBoothCueResponse | void> => {
  const parsed = GenerateBoothCueInputSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({ error: 'Invalid booth cue payload' });
    return;
  }

  return generateBoothCueWithOpenAI({
    features: parsed.data.features,
    interpretation: parsed.data.interpretation,
    retrievalFacts: parsed.data.retrieval.supportingFacts,
    recentEvents: parsed.data.recentEvents?.map((event) => ({
      matchTime: event.matchTime,
      description: event.description,
      highSalience: event.highSalience,
    })),
    clipName: parsed.data.clipName,
    contextSummary: parsed.data.contextSummary,
    preMatchSummary: parsed.data.preMatchSummary,
    expectedTopics: parsed.data.expectedTopics,
    recentCueTexts: parsed.data.recentCueTexts,
  });
});

server.post('/booth/transcribe', async (request, reply): Promise<TranscribeBoothAudioResponse | void> => {
  const parsed = TranscribeBoothAudioInputSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({ error: 'Invalid booth transcription payload' });
    return;
  }

  return transcribeBoothAudioWithOpenAI(parsed.data.audioBase64, parsed.data.mimeType);
});

server.post('/booth/realtime-connect', async (request, reply) => {
  const offerSdp = typeof request.body === 'string' ? request.body : '';

  if (!offerSdp.trim()) {
    reply.status(400).send({ error: 'Missing SDP offer' });
    return;
  }

  try {
    const answerSdp = await createRealtimeBoothSdpAnswer(offerSdp);
    reply.header('Content-Type', 'application/sdp').send(answerSdp);
  } catch (_error) {
    reply.status(502).send({ error: 'Failed to create realtime booth session' });
  }
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
