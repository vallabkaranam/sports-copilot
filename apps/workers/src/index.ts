import dotenv from 'dotenv';
import fs from 'fs/promises';
import http from 'http';
import path from 'path';
import { buildAssistCard } from './assist.js';
import { BlueskyPostCache, ingestBlueskySocialPosts } from './bluesky.js';
import { analyzeCommentary } from './commentator.js';
import { buildNarrativeState } from './narrative.js';
import { buildPreMatchContext, createDegradedPreMatchState } from './pre-match.js';
import {
  buildContextBundle,
  buildRetrievalQuery,
  buildRetrievalState,
  ingestLiveSocialPosts,
  NarrativeFixture,
} from './retrieval.js';
import { createSessionMemoryTracker } from './session-memory.js';
import {
  buildLiveGameStateSummary,
  buildPossessionLabel,
  buildRosterFromLiveMatch,
  fetchSportmonksFixture,
  normalizeSportmonksFixture,
} from './sportmonks.js';
import { getActiveVisionCues, ingestVisionFrames } from './vision.js';
import {
  AgentExplainability,
  CommentatorState,
  GameEvent,
  ReplayControlState,
  RetrieveUserContextResponse,
  SocialPost,
  TranscriptEntry,
  UserContextChunk,
  VisionCue,
  VisionFrame,
  WorldState,
  createDefaultReplayControlState,
  createEmptyAssistCard,
  createEmptyCommentatorState,
  createEmptyContextBundle,
  createEmptyLiveMatchState,
  createEmptyNarrativeState,
  createEmptyPreMatchState,
  createEmptyRetrievalState,
} from '@sports-copilot/shared-types';

dotenv.config({
  path: [
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../.env.local'),
    path.resolve(process.cwd(), '../../.env'),
  ],
});
function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function assertWorkerEnv() {
  requireEnv('API_BASE_URL');
  requireEnv('SPORTMONKS_API_TOKEN');
}

assertWorkerEnv();

const API_BASE_URL = requireEnv('API_BASE_URL');
const API_URL = new URL(API_BASE_URL);
const API_HOSTNAME = API_URL.hostname;
const API_PORT = Number(API_URL.port || (API_URL.protocol === 'https:' ? 443 : 80));
const HEALTH_PORT = Number(process.env.PORT ?? 0);
const POLL_INTERVAL_MS = 15_000;
const ENABLE_BLUESKY_SOCIAL = process.env.BLUESKY_SOCIAL_ENABLED === 'true';
const BLUESKY_WARNING_COOLDOWN_MS = 5 * 60_000;

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

async function retrieveUserContext(queryText: string) {
  return new Promise<RetrieveUserContextResponse>((resolve, reject) => {
    const data = JSON.stringify({ queryText, limit: 4 });
    const req = http.request(
      new URL(`${API_URL.pathname.replace(/\/$/, '')}/context-documents/retrieve`, API_BASE_URL),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(body || `context retrieval failed with ${res.statusCode}`));
            return;
          }
          resolve(JSON.parse(body) as RetrieveUserContextResponse);
        });
      },
    );

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function buildAgentRuns(params: {
  commentator: CommentatorState;
  retrievalReasoning: string[];
  retrievalSources: WorldState['retrieval']['supportingFacts'];
  contextBundle: WorldState['contextBundle'];
  assist: WorldState['assist'];
  liveMatchResolved: boolean;
}) {
  const { commentator, retrievalReasoning, retrievalSources, contextBundle, assist, liveMatchResolved } = params;

  return [
    {
      agentName: 'signal-agent',
      output:
        commentator.hesitationScore > 0
          ? `Hesitation ${Math.round(commentator.hesitationScore * 100)}%`
          : 'Monitoring only',
      reasoningTrace:
        commentator.hesitationReasons.length > 0
          ? commentator.hesitationReasons
          : ['No strong hesitation trigger is active.'],
      sourcesUsed: [],
      state: commentator.hesitationScore >= 0.35 ? 'active' : 'quiet',
    },
    {
      agentName: 'context-agent',
      output: liveMatchResolved ? contextBundle.summary : 'Waiting for resolved fixture context',
      reasoningTrace: retrievalReasoning,
      sourcesUsed: retrievalSources.slice(0, 4).map((fact) => fact.sourceChip),
      state: liveMatchResolved ? 'ready' : 'waiting',
    },
    {
      agentName: 'cue-agent',
      output: assist.type === 'none' ? 'Standing by' : assist.text,
      reasoningTrace: [assist.whyNow],
      sourcesUsed: assist.sourceChips,
      state: assist.type === 'none' ? 'quiet' : 'active',
    },
    {
      agentName: 'recovery-agent',
      output:
        commentator.hesitationScore < 0.18
          ? 'Delivery has stabilized again'
          : 'Recovery is not established yet',
      reasoningTrace: [
        commentator.hesitationScore < 0.18
          ? 'Hesitation pressure is low enough that the desk can keep backing off.'
          : 'Hesitation pressure is still too high to treat this as a recovery window.',
      ],
      sourcesUsed: [],
      state: commentator.hesitationScore < 0.18 ? 'ready' : 'quiet',
    },
  ] satisfies AgentExplainability[];
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
  const narratives: NarrativeFixture[] = [];
  const socialPosts: SocialPost[] = [];
  const transcript: TranscriptEntry[] = [];
  const visionFrames: VisionFrame[] = [];
  const visionCues: VisionCue[] = ingestVisionFrames(visionFrames);
  const sessionMemory = createSessionMemoryTracker();
  let lastKnownControls = createDefaultReplayControlState();
  let lastHandledRestartToken = 0;
  let lastPreMatchFixtureId = '';
  let blueskyCache: BlueskyPostCache = {};
  let lastBlueskyWarningAt = 0;
  let lastBlueskyWarningMessage = '';
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
    contextBundle: createEmptyContextBundle(),
    assist: createEmptyAssistCard(),
    preMatch: createEmptyPreMatchState(),
    liveMatch: buildDegradedState('Waiting for Sportmonks data.', ''),
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

      const fixtureId = controls.activeFixtureId ?? '';
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
          !apiToken
            ? 'Sportmonks credentials are missing.'
            : 'Waiting for the live feed to resolve the current fixture.',
          fixtureId,
        );
        const degradedPreMatch = createDegradedPreMatchState(
          !apiToken
            ? 'Sportmonks credentials are missing.'
            : 'Waiting for the live feed to resolve the current fixture.',
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
            openAiModel: undefined,
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
      const retrievalQuery = buildRetrievalQuery(clockMs, snapshot.events, transcript);
      let userContextChunks: UserContextChunk[] = [];
      try {
        userContextChunks = (await retrieveUserContext(retrievalQuery)).chunks;
      } catch (_error) {
        userContextChunks = [];
      }
      let resolvedSocialPosts = socialPosts;

      if (ENABLE_BLUESKY_SOCIAL) {
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
          const message = error instanceof Error ? error.message : String(error);
          const now = Date.now();
          if (
            message !== lastBlueskyWarningMessage ||
            now - lastBlueskyWarningAt >= BLUESKY_WARNING_COOLDOWN_MS
          ) {
            console.warn('Bluesky social ingest failed:', message);
            lastBlueskyWarningAt = now;
            lastBlueskyWarningMessage = message;
          }
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
        userContextChunks,
        visionCues,
        liveMatch: snapshot.liveMatch,
        preMatch,
      });
      const contextBundle = buildContextBundle(clockMs, retrieval);
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
      const retrievalReasoning = [
        `Query: ${retrieval.query}`,
        `Selected ${retrieval.supportingFacts.length} facts and held ${retrieval.unusedFacts.length} in reserve.`,
        snapshot.liveMatch.status === 'live'
          ? `Live minute ${snapshot.liveMatch.minute} keeps live and session facts ahead of slower context.`
          : 'The desk is relying on pre-match and static context.',
        userContextChunks.length > 0
          ? `User-uploaded context supplied ${userContextChunks.length} matching chunk${userContextChunks.length === 1 ? '' : 's'}.`
          : 'No uploaded context matched this query window.',
      ];
      const agentRuns = buildAgentRuns({
        commentator,
        retrievalReasoning,
        retrievalSources: retrieval.supportingFacts,
        contextBundle,
        assist,
        liveMatchResolved: Boolean(fixtureId),
      });

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
        contextBundle,
        assist,
        preMatch,
        liveMatch: snapshot.liveMatch,
        liveSignals: {
          social: ingestedSocialPosts,
          vision: activeVisionCues,
        },
        orchestration: {
          agentRuns,
          retrievalReasoning,
          memoryState: [
            `Recent events: ${recentEvents.length}`,
            `Transcript lines: ${transcript.length}`,
            `Session assists remembered: ${sessionMemoryState.surfacedAssists.length}`,
            `Context bundle items: ${contextBundle.items.length}`,
          ],
          lastGeneration: {
            contributingAgents: agentRuns.filter((agent) =>
              ['context-agent', 'cue-agent'].includes(agent.agentName),
            ),
            reasoningTrace: [assist.whyNow, ...retrievalReasoning],
            sourcesUsed: assist.sourceChips,
          },
          confidenceReason:
            commentator.hesitationScore < 0.18
              ? 'Recovery is building because hesitation pressure has fallen back into the steady range.'
              : 'Confidence has not rebuilt yet because hesitation pressure is still elevated.',
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
