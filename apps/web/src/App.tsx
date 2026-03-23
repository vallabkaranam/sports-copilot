import { ChangeEvent, startTransition, useEffect, useMemo, useRef, useState } from 'react';
import {
  AgentExplainability,
  BoothFeatureSnapshot,
  BoothInterpretation,
  BoothSessionRecord,
  BoothSessionReview,
  BoothSessionSummary,
  GenerateBoothCueResponse,
  ReplayControlState,
  TranscriptEntry,
  UserContextDocument,
  createEmptyAssistCard,
} from '@sports-copilot/shared-types';
import './App.css';
import {
  appendBoothSessionSample,
  connectRealtimeBoothSession,
  fetchBoothSession,
  fetchBoothSessionReview,
  fetchBoothSessions,
  fetchControlState,
  fetchWorldState,
  finishBoothSession,
  generateBoothCue,
  interpretBooth,
  listUserContextDocuments,
  publishBoothLiveSignals,
  resolveFixture,
  startBoothSession,
  transcribeBoothAudio,
  updateControlState,
  uploadUserContext,
} from './api';
import {
  buildBoothAssist,
  buildBoothAssistFacts,
  deriveExcludedCueTexts,
  getBoothAssistQuery,
  rankBoothAssistFacts,
} from './boothAssist';
import {
  LOCAL_TRANSCRIPT_LIMIT,
  LIVE_HESITATION_GATE,
  LONG_PAUSE_START_MS,
  BoothSignal,
  buildBoothSignal,
  calculateAudioLevel,
  deriveBoothActivity,
  resolveBoothGuidanceScores,
} from './boothSignal';
import {
  createInitialWorldState,
  formatDurationMs,
  formatPercent,
  parseClock,
} from './dashboard';
import {
  ProgramFeedSlotId,
  ProgramFeedSlot,
  StoredProgramFeed,
  clearProgramFeed,
  listStoredProgramFeeds,
  saveProgramFeed,
} from './feedLibrary';

type MicrophoneAvailability = 'supported' | 'degraded' | 'unsupported';
type CoachingTone = 'standby' | 'steady' | 'supporting' | 'step-in';
type AssistVisibilityPhase = 'hidden' | 'live' | 'weaning';
type AppRoute = 'live-desk' | 'analyze' | 'sidekick-console';
type SidebarAgentState = 'idle' | 'active' | 'contributing' | 'blocked';
type DeliverySource = 'live-mic' | 'synthetic-standby';
type HandoffState = 'idle' | 'preparing_sub_in' | 'subbed_in' | 'preparing_sub_back' | 'restoring_live';
type StandbyVoiceStatus = 'disabled' | 'recording' | 'processing' | 'ready' | 'failed';
type ContextScope = 'global' | 'session';
type SessionContextMode = 'inherit-global' | 'custom';
type SidebarAgent = AgentExplainability & {
  displayState: SidebarAgentState;
  origin: 'interpretation' | 'orchestration' | 'generation';
};
type LocalContextEntry = {
  id: string;
  fileName: string;
  sourceType: 'text' | 'file';
  text: string;
  createdAt: string;
  backendDocumentId?: string;
};

const AUDIO_ACTIVITY_SAMPLE_MS = 120;
const MIN_AUDIO_ACTIVITY_THRESHOLD = 0.012;
const MAX_AUDIO_ACTIVITY_THRESHOLD = 0.08;
const ASSIST_WEAN_OFF_MS = 2600;
const MIN_ASSIST_DISPLAY_MS = 2400;
const MIN_RECOVERY_COMMIT_MS = 900;
const BUFFERED_TRANSCRIPTION_CHUNK_MS = 2_500;
const BUFFERED_TRANSCRIPTION_WARNING_THRESHOLD = 3;
const BUFFERED_TRANSCRIPTION_WARNING =
  'Live transcription is not producing usable text yet. Keep speaking or check the OpenAI mic path.';
const GENERATE_CUE_FAILURE_BACKOFF_MS = 4_000;
const HANDOFF_COUNTDOWN_START = 3;
const LIVE_SIGNAL_TRANSCRIPT_DEBOUNCE_MS = 900;
const LIVE_SIGNAL_FRAME_INTERVAL_MS = 5_000;
const MIN_STANDBY_SAMPLE_MS = 4_000;
const STANDBY_SAMPLE_CAPTURE_MS = 6_000;
const SUBBED_CUE_FLOOR_MS = 3_500;
const STANDBY_VOICE_STORAGE_KEY = 'andone-standby-voice-profile';
const LOCAL_CONTEXT_LIBRARY_STORAGE_KEY = 'andone-local-context-library';
const HIDDEN_CONTEXT_DOCUMENT_IDS_STORAGE_KEY = 'andone-hidden-context-document-ids';
const PROGRAM_FEED_SLOTS: ProgramFeedSlot[] = [
  {
    id: 'program-a',
    label: 'Channel 1',
    tone: 'Preset feed',
    source: 'preset',
    presetUrl: `${import.meta.env.VITE_API_BASE_URL ?? ''}/preset-feeds/barca`,
    presetFileName: 'Barca preset',
  },
  {
    id: 'program-b',
    label: 'Channel 2',
    tone: 'Preset feed',
    source: 'preset',
    presetUrl: `${import.meta.env.VITE_API_BASE_URL ?? ''}/preset-feeds/rangers`,
    presetFileName: 'Rangers preset',
  },
  {
    id: 'program-c',
    label: 'Channel 3',
    tone: 'Backup input',
    source: 'upload',
  },
];

function createEmptyStoredProgramFeeds(): Record<ProgramFeedSlotId, StoredProgramFeed | null> {
  return {
    'program-a': null,
    'program-b': null,
    'program-c': null,
  };
}

function getAppRouteFromLocation(): AppRoute {
  if (typeof window === 'undefined') {
    return 'live-desk';
  }

  const route = window.location.hash.replace(/^#\/?/, '').trim().toLowerCase();
  if (route === 'archive' || route === 'reviews' || route === 'analyze') {
    return 'analyze';
  }
  if (route === 'debug' || route === 'sidekick-console') {
    return 'sidekick-console';
  }

  return 'live-desk';
}

function formatStandbyVoiceStatus(status: StandbyVoiceStatus) {
  switch (status) {
    case 'recording':
      return 'Recording voice';
    case 'processing':
      return 'Preparing handoff';
    case 'ready':
      return 'Handoff ready';
    case 'failed':
      return 'Handoff unavailable';
    default:
      return 'Handoff off';
  }
}

function setAppRouteHash(route: AppRoute) {
  if (typeof window === 'undefined') {
    return;
  }

  const nextHash = `#/${route}`;
  if (window.location.hash !== nextHash) {
    window.location.hash = nextHash;
  }
}

function formatSessionStartedAt(timestamp: string) {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return 'Recent run';
  }

  return new Date(parsed).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function normalizeAgentName(agentName: string) {
  return agentName.trim().toLowerCase();
}

function safeTrimText(text: string, maxLength = 220) {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

function mergeUniqueText(values: Array<string | null | undefined>, maxItems = 8) {
  const merged = values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  return [...new Set(merged)].slice(0, maxItems);
}

function mergeAgentRuns(
  agentCollections: Array<{ agents: AgentExplainability[]; origin: SidebarAgent['origin'] }>,
  options: {
    contextBlocked: boolean;
    cueBlocked: boolean;
  },
) {
  const merged = new Map<string, SidebarAgent>();
  const stateRank: Record<AgentExplainability['state'], number> = {
    quiet: 0,
    waiting: 1,
    ready: 2,
    active: 3,
  };

  for (const collection of agentCollections) {
    for (const agent of collection.agents) {
      const key = normalizeAgentName(agent.agentName);
      const existing = merged.get(key);
      const shouldPreferNext = !existing || stateRank[agent.state] >= stateRank[existing.state];
      const sourceMap = new Map<string, (typeof agent.sourcesUsed)[number]>();

      for (const chip of existing?.sourcesUsed ?? []) {
        sourceMap.set(chip.id, chip);
      }
      for (const chip of agent.sourcesUsed) {
        sourceMap.set(chip.id, chip);
      }

      const nextAgent: SidebarAgent = {
        ...(shouldPreferNext ? agent : existing!),
        output: shouldPreferNext ? agent.output : existing!.output,
        reasoningTrace: [...new Set([...(existing?.reasoningTrace ?? []), ...agent.reasoningTrace])],
        sourcesUsed: [...sourceMap.values()],
        origin: shouldPreferNext ? collection.origin : existing!.origin,
        displayState:
          options.contextBlocked && key.includes('context')
            ? 'blocked'
            : options.cueBlocked && (key.includes('cue') || key.includes('grounding'))
              ? 'blocked'
              : collection.origin === 'generation'
                ? 'contributing'
                : agent.state === 'active'
                  ? 'active'
                  : agent.state === 'ready'
                    ? 'active'
                    : 'idle',
      };

      merged.set(key, nextAgent);
    }
  }

  return [...merged.values()].sort((left, right) => {
    const displayRank: Record<SidebarAgentState, number> = {
      contributing: 3,
      active: 2,
      blocked: 1,
      idle: 0,
    };
    return displayRank[right.displayState] - displayRank[left.displayState];
  });
}

function formatSidebarAgentStateLabel(agent: SidebarAgent) {
  if (agent.displayState === 'blocked') {
    return 'Blocked';
  }

  if (agent.displayState === 'contributing') {
    return 'Driving cue';
  }

  if (agent.state === 'active') {
    return agent.origin === 'generation' ? 'Drafting' : 'Live';
  }

  if (agent.state === 'ready') {
    return 'Ready';
  }

  if (agent.state === 'waiting') {
    return 'Watching';
  }

  return 'Idle';
}

function normalizeMonitorCopy(text: string) {
  return text
    .replace(/no supporting facts were selected\.?/gi, 'Grounding is leaning on live booth state while retrieval facts are thin.')
    .replace(/falling back to the live booth state because explicit retrieval facts were thin\.?/gi, 'Grounding is leaning on live booth state while retrieval facts are thin.')
    .replace(/model .* generated the final cue from 0 selected facts\.?/gi, 'The cue was assembled from live booth state because explicit retrieval facts were thin.')
    .replace(/0 selected facts/gi, 'live booth state');
}

function supportsAudioMonitoring() {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof window.AudioContext !== 'undefined'
  );
}

function supportsSpeechSynthesis() {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance !== 'undefined'
  );
}

function getAvailableSpeechVoices() {
  if (!supportsSpeechSynthesis() || typeof window.speechSynthesis.getVoices !== 'function') {
    return [] as SpeechSynthesisVoice[];
  }

  return window.speechSynthesis.getVoices().filter((voice) => Boolean(voice?.voiceURI || voice?.name));
}

function pickStandbyVoice(voices: SpeechSynthesisVoice[]) {
  if (voices.length === 0) {
    return null;
  }

  return (
    voices.find((voice) => voice.default) ??
    voices.find((voice) => /^en(-|_|$)/i.test(voice.lang ?? '')) ??
    voices[0]
  );
}

function getSupportedRecorderMimeType() {
  if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') {
    return null;
  }

  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];

  for (const candidate of candidates) {
    if (typeof window.MediaRecorder.isTypeSupported !== 'function') {
      return candidate;
    }

    if (window.MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function encodeBlobAsBase64(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return window.btoa(binary);
}

async function captureVideoFrameAsBase64(videoElement: HTMLVideoElement) {
  const canvas = document.createElement('canvas');
  canvas.width = videoElement.videoWidth || 1280;
  canvas.height = videoElement.videoHeight || 720;
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('Video frame capture is unavailable in this browser.');
  }

  try {
    context.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
  } catch (_error) {
    throw new Error('The browser blocked frame capture for this feed.');
  }

  return new Promise<{ screenshotBase64: string; mimeType: string }>((resolve, reject) => {
    try {
      canvas.toBlob(async (blob) => {
        if (!blob) {
          reject(new Error('The current frame could not be captured.'));
          return;
        }

        try {
          const screenshotBase64 = await encodeBlobAsBase64(blob);
          resolve({
            screenshotBase64,
            mimeType: blob.type || 'image/jpeg',
          });
        } catch (error) {
          reject(error);
        }
      }, 'image/jpeg', 0.9);
    } catch (_error) {
      reject(new Error('The browser blocked frame capture for this feed.'));
    }
  });
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function readFileAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file);
  });
}

function createTranscriptEntry(timestamp: number, text: string): TranscriptEntry {
  return {
    timestamp,
    speaker: 'lead',
    text,
  };
}

function normalizeTranscriptComparison(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mergeTranscriptEntry(
  current: TranscriptEntry[],
  nextEntry: TranscriptEntry,
) {
  const nextNormalized = normalizeTranscriptComparison(nextEntry.text);
  if (!nextNormalized) {
    return current;
  }

  const lastEntry = current[current.length - 1];
  if (!lastEntry) {
    return [nextEntry].slice(-LOCAL_TRANSCRIPT_LIMIT);
  }

  const lastNormalized = normalizeTranscriptComparison(lastEntry.text);
  const timestampsAreClose = Math.abs(nextEntry.timestamp - lastEntry.timestamp) <= 3_000;
  const sameMoment =
    timestampsAreClose &&
    (nextNormalized === lastNormalized ||
      nextNormalized.includes(lastNormalized) ||
      lastNormalized.includes(nextNormalized));

  if (sameMoment) {
    const preferredText =
      nextEntry.text.length >= lastEntry.text.length ? nextEntry.text : lastEntry.text;
    return [
      ...current.slice(0, -1),
      createTranscriptEntry(Math.max(lastEntry.timestamp, nextEntry.timestamp), preferredText),
    ].slice(-LOCAL_TRANSCRIPT_LIMIT);
  }

  return [...current, nextEntry].slice(-LOCAL_TRANSCRIPT_LIMIT);
}

function shouldClearBufferedTranscriptionWarning(currentWarning: string | null) {
  return currentWarning === BUFFERED_TRANSCRIPTION_WARNING;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}

function getFixtureResolutionErrorMessage(error: unknown) {
  const message = getErrorMessage(error);

  if (message.includes('SPORTMONKS_API_TOKEN is required')) {
    return 'Match linking is unavailable until SPORTMONKS_API_TOKEN is set on the API service.';
  }

  if (message.includes('Invalid fixture resolution payload')) {
    return 'The resolver did not receive enough match hints yet.';
  }

  return `The system could not identify this match yet. ${message}`;
}

type ComparableAssistCard = Pick<GenerateBoothCueResponse['assist'], 'type' | 'text' | 'whyNow'>;

export function areAssistCardsEquivalent(
  left: ComparableAssistCard,
  right: ComparableAssistCard,
) {
  return left.type === right.type && left.text === right.text && left.whyNow === right.whyNow;
}

export function shouldHoldLockedAssist(params: {
  currentAssist: ComparableAssistCard;
  nextAssist: ComparableAssistCard | null;
  assistLockExpiresAt: number;
  nowMs: number;
}) {
  const { currentAssist, nextAssist, assistLockExpiresAt, nowMs } = params;

  if (currentAssist.type === 'none' || assistLockExpiresAt <= nowMs) {
    return false;
  }

  if (!nextAssist) {
    return true;
  }

  return !areAssistCardsEquivalent(currentAssist, nextAssist);
}

export function hasRecoveredFromAssistEpisode(params: {
  isSpeaking: boolean;
  speechStreakMs: number;
  effectiveRecoveryScore: number;
  effectiveHesitationScore: number;
  interpretationState?: BoothInterpretation['state'];
}) {
  const {
    isSpeaking,
    speechStreakMs,
    effectiveRecoveryScore,
    effectiveHesitationScore,
    interpretationState,
  } = params;

  return (
    interpretationState === 'weaning-off' ||
    (isSpeaking &&
      (speechStreakMs >= 1_200 || effectiveRecoveryScore >= 0.52) &&
      effectiveHesitationScore < LIVE_HESITATION_GATE)
  );
}

function isGroundedAssistCard(assist: GenerateBoothCueResponse['assist'] | null | undefined) {
  return Boolean(assist && assist.type !== 'none' && assist.sourceChips.length > 0);
}

function isGenericBridgeAssistText(text: string) {
  return /\b(reset with|go back to|reframe|bridge|one clean scene line|single takeaway|keep it moving|connect it back)\b/i.test(
    text,
  );
}

export function selectPreferredTriggeredAssist(params: {
  localAssist: GenerateBoothCueResponse['assist'];
  generatedAssist: GenerateBoothCueResponse['assist'] | null | undefined;
}) {
  const { localAssist, generatedAssist } = params;

  if (!generatedAssist || generatedAssist.type === 'none') {
    return localAssist;
  }

  if (localAssist.type === 'none') {
    return generatedAssist;
  }

  if (isGroundedAssistCard(localAssist) && !isGroundedAssistCard(generatedAssist)) {
    return localAssist;
  }

  if (isGroundedAssistCard(localAssist) && isGenericBridgeAssistText(generatedAssist.text)) {
    return localAssist;
  }

  return generatedAssist;
}

async function canLoadPresetFeed(url: string) {
  try {
    const response = await fetch(url, {
      headers: {
        Range: 'bytes=0-0',
      },
    });
    return response.ok;
  } catch (_error) {
    return false;
  }
}

function safelyPlayVideo(videoElement: HTMLVideoElement, onBlocked: () => void) {
  const playResult = videoElement.play();

  if (playResult && typeof playResult.catch === 'function') {
    void playResult.catch(onBlocked);
  }
}

function isMissingApiRouteError(error: unknown, path: string) {
  return error instanceof Error && error.message.includes(`${path} failed with 404`);
}

function buildContextSummary(worldState: ReturnType<typeof createInitialWorldState>) {
  const latestEvent = worldState.recentEvents[worldState.recentEvents.length - 1];
  const parts = [
    worldState.liveStreamContext.summary,
    worldState.gameStateSummary,
    worldState.narrative.topNarrative,
    latestEvent ? `${latestEvent.matchTime} ${latestEvent.description}` : null,
  ].filter(Boolean);

  return parts.join(' | ');
}

function buildExpectedTopics(worldState: ReturnType<typeof createInitialWorldState>) {
  const topics = [
    worldState.narrative.topNarrative,
    ...worldState.narrative.activeNarratives,
    ...worldState.retrieval.supportingFacts.slice(0, 3).map((fact) => fact.text),
    ...worldState.liveStreamContext.recentEvents.slice(-2).map((event) => event.detail),
    ...worldState.recentEvents.slice(-3).map((event) => event.description),
    worldState.liveMatch.homeTeam.name,
    worldState.liveMatch.awayTeam.name,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  return [...new Set(topics)].slice(0, 8);
}

function buildPreMatchCueSummary(worldState: ReturnType<typeof createInitialWorldState>) {
  const parts = [
    worldState.preMatch.aiOpener,
    worldState.preMatch.deterministicOpener,
    worldState.preMatch.headToHead.summary,
    worldState.preMatch.homeScoringTrend.summary,
    worldState.preMatch.awayScoringTrend.summary,
    worldState.preMatch.homeFirstToScore.summary,
    worldState.preMatch.awayFirstToScore.summary,
    worldState.preMatch.weather
      ? `Weather: ${worldState.preMatch.weather.summary}${
          worldState.preMatch.weather.temperatureC !== null
            ? ` at ${Math.round(worldState.preMatch.weather.temperatureC)}C`
            : ''
        }`
      : null,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  return [...new Set(parts)].join(' | ');
}

function getLocalContextPreview(entry: LocalContextEntry) {
  return safeTrimText(entry.text, 180);
}

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function derivePostSessionReview(session: BoothSessionRecord | null) {
  if (!session) {
    return null;
  }

  const snapshots = session.samples
    .map((sample) => sample.featureSnapshot as BoothFeatureSnapshot | undefined)
    .filter((snapshot): snapshot is BoothFeatureSnapshot => Boolean(snapshot));

  const fillerTotals = snapshots.flatMap((snapshot) => snapshot.fillerWords);
  const fillerCounts = new Map<string, number>();
  for (const filler of fillerTotals) {
    fillerCounts.set(filler, (fillerCounts.get(filler) ?? 0) + 1);
  }

  const topFiller = [...fillerCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  const topTriggerCounts = new Map<string, number>();
  for (const sample of session.samples) {
    for (const badge of sample.triggerBadges) {
      topTriggerCounts.set(badge, (topTriggerCounts.get(badge) ?? 0) + 1);
    }
  }

  const topTrigger =
    [...topTriggerCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 'pause';

  const recoveryMoments = session.samples.filter((sample) => {
    const interpretation = sample.interpretation as BoothInterpretation | undefined;
    return (
      interpretation?.state === 'weaning-off' ||
      (typeof interpretation?.recoveryScore === 'number' && interpretation.recoveryScore >= 0.65)
    );
  }).length;

  const averageStability = average(snapshots.map((snapshot) => snapshot.transcriptStabilityScore || 1));
  const averagePause = average(session.samples.map((sample) => sample.pauseDurationMs));
  const averageFillerDensity = average(snapshots.map((snapshot) => snapshot.fillerDensity || 0));
  const averageWordsPerMinute = average(snapshots.map((snapshot) => snapshot.wordsPerMinute || 0));
  const averagePacePressure = average(snapshots.map((snapshot) => snapshot.pacePressureScore || 0));
  const repeatedIdeaMoments = snapshots.reduce(
    (total, snapshot) => total + (snapshot.repeatedIdeaCount || 0),
    0,
  );
  const highestPacePressure = [...snapshots].sort(
    (left, right) => (right.pacePressureScore || 0) - (left.pacePressureScore || 0),
  )[0];

  const learningNotes = [
    topTrigger === 'pause'
      ? 'Long pauses are still the strongest cue. The handoff should arrive earlier as silence grows.'
      : `The booth most often reacted to ${topTrigger} moments in this session.`,
    topFiller
      ? `Your most common filler was "${topFiller}". That is now part of the personal hesitation profile.`
      : 'Filler language stayed relatively clean in this run.',
    recoveryMoments > 0
      ? `AndOne detected ${recoveryMoments} recovery moment${recoveryMoments === 1 ? '' : 's'} where it could back off.`
      : 'Recovery never stabilized long enough to trigger a confident back-off moment.',
    repeatedIdeaMoments > 0
      ? `Repeated-idea loops showed up ${repeatedIdeaMoments} time${repeatedIdeaMoments === 1 ? '' : 's'}, which is now a tracked hesitation pattern.`
      : 'The call stayed varied enough that repeated-idea loops were not a major trigger.',
    averagePacePressure >= 0.18
      ? `Delivery pace was a meaningful pressure signal in this run${highestPacePressure?.wordsPerMinute ? `, peaking around ${Math.round(highestPacePressure.wordsPerMinute)} WPM.` : '.'}`
      : 'Pace pressure stayed mostly under control, so the strongest signals came from pause and phrasing instead.',
  ];

  return {
    headline: 'Session analysis is ready.',
    summary: `Saved ${session.sampleCount} live samples and ${session.assistCount} cue${
      session.assistCount === 1 ? '' : 's'
    } for this run.`,
    metrics: [
      { label: 'Peak hesitation', value: formatPercent(session.maxHesitationScore) },
      { label: 'Longest pause', value: formatDurationMs(session.longestPauseMs) },
      { label: 'Avg live pause', value: formatDurationMs(Math.round(averagePause)) },
      { label: 'Avg transcript stability', value: formatPercent(averageStability) },
      { label: 'Avg filler density', value: formatPercent(averageFillerDensity) },
      { label: 'Avg pace', value: averageWordsPerMinute > 0 ? `${Math.round(averageWordsPerMinute)} WPM` : 'No speech' },
      { label: 'Pace pressure', value: formatPercent(averagePacePressure) },
      { label: 'Recovery moments', value: String(recoveryMoments) },
    ],
    learningNotes,
  };
}

function deriveSessionWorkspaceInsights(sessions: BoothSessionSummary[]) {
  if (sessions.length === 0) {
    return {
      averagePeakHesitation: 0,
      averageAssistRate: 0,
      averageLongestPauseMs: 0,
      hottestSession: null as BoothSessionSummary | null,
    };
  }

  const averagePeakHesitation =
    sessions.reduce((total, session) => total + session.maxHesitationScore, 0) / sessions.length;
  const averageAssistRate =
    sessions.reduce((total, session) => total + session.assistCount, 0) / sessions.length;
  const averageLongestPauseMs =
    sessions.reduce((total, session) => total + session.longestPauseMs, 0) / sessions.length;
  const hottestSession = [...sessions].sort(
    (left, right) => right.maxHesitationScore - left.maxHesitationScore,
  )[0] ?? null;

  return {
    averagePeakHesitation,
    averageAssistRate,
    averageLongestPauseMs,
    hottestSession,
  };
}

function getCoachingTone({
  hasStartedBroadcast,
  boothHasLiveInput,
  boothSignal,
  shouldSurfaceAssist,
}: {
  hasStartedBroadcast: boolean;
  boothHasLiveInput: boolean;
  boothSignal: BoothSignal;
  shouldSurfaceAssist: boolean;
}) {
  if (!hasStartedBroadcast) {
    return {
      tone: 'standby' as CoachingTone,
      label: 'Standby',
      headline: 'AndOne is standing by.',
      copy: 'Cue cards stay off-screen until you go live.',
    };
  }

  if (shouldSurfaceAssist) {
    return {
      tone: 'step-in' as CoachingTone,
      label: 'Cue live',
      headline: 'A cue card is live.',
      copy: 'AndOne is stepping in because your delivery slipped.',
    };
  }

  if (!boothHasLiveInput) {
    return {
      tone: 'standby' as CoachingTone,
      label: 'Listening',
      headline: 'Waiting for your first call.',
      copy: 'Start the commentary and AndOne will listen for hesitation.',
    };
  }

  if (boothSignal.isSpeaking && boothSignal.confidenceScore >= 0.68 && boothSignal.hesitationScore < 0.18) {
    return {
      tone: 'steady' as CoachingTone,
      label: 'Backing off',
      headline: 'You are back in rhythm.',
      copy: 'The cue card is fading because your delivery is stable again.',
    };
  }

  return {
    tone: 'supporting' as CoachingTone,
    label: 'Monitoring',
    headline: 'AndOne is following your delivery.',
    copy: 'The live feed is active, but the hesitation signal is not strong enough to surface a cue yet.',
  };
}

function App() {
  const [worldState, setWorldState] = useState(createInitialWorldState);
  const [controls, setControls] = useState<ReplayControlState>({
    playbackStatus: 'paused',
    preferredStyleMode: 'analyst',
    forceHesitation: false,
    restartToken: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);
  const [isUpdatingControls, setIsUpdatingControls] = useState(false);
  const [hasStartedBroadcast, setHasStartedBroadcast] = useState(false);
  const [recentBoothSessions, setRecentBoothSessions] = useState<BoothSessionSummary[]>([]);
  const [latestCompletedSession, setLatestCompletedSession] = useState<BoothSessionRecord | null>(null);
  const [latestCompletedSessionReview, setLatestCompletedSessionReview] =
    useState<BoothSessionReview | null>(null);
  const [selectedReviewSessionId, setSelectedReviewSessionId] = useState<string | null>(null);
  const [isLoadingReview, setIsLoadingReview] = useState(false);
  const [isFinalizingSession, setIsFinalizingSession] = useState(false);
  const [appRoute, setAppRoute] = useState<AppRoute>(() => getAppRouteFromLocation());
  const [activeBoothSessionId, setActiveBoothSessionId] = useState<string | null>(null);
  const [loadedClipName, setLoadedClipName] = useState('');
  const [loadedClipUrl, setLoadedClipUrl] = useState<string | null>(null);
  const [selectedProgramFeedId, setSelectedProgramFeedId] = useState<ProgramFeedSlotId | null>(null);
  const [storedProgramFeeds, setStoredProgramFeeds] = useState<Record<ProgramFeedSlotId, StoredProgramFeed | null>>(
    createEmptyStoredProgramFeeds,
  );
  const [clipDurationMs, setClipDurationMs] = useState(0);
  const [isClipMuted, setIsClipMuted] = useState(true);
  const [isResolvingFixture, setIsResolvingFixture] = useState(false);
  const [contextDocuments, setContextDocuments] = useState<UserContextDocument[]>([]);
  const [localContextLibrary, setLocalContextLibrary] = useState<LocalContextEntry[]>([]);
  const [hiddenContextDocumentIds, setHiddenContextDocumentIds] = useState<string[]>([]);
  const [contextUploadText, setContextUploadText] = useState('');
  const [isUploadingContext, setIsUploadingContext] = useState(false);
  const [sessionContextText, setSessionContextText] = useState('');
  const [sessionContextMode, setSessionContextMode] = useState<SessionContextMode>('inherit-global');
  const [sessionSelectedGlobalContextIds, setSessionSelectedGlobalContextIds] = useState<string[]>([]);
  const [sessionContextEntries, setSessionContextEntries] = useState<LocalContextEntry[]>([]);
  const [boothTranscript, setBoothTranscript] = useState<TranscriptEntry[]>([]);
  const [boothInterimTranscript, setBoothInterimTranscript] = useState('');
  const [boothError, setBoothError] = useState<string | null>(null);
  const [latchedAssist, setLatchedAssist] = useState(() => createEmptyAssistCard());
  const [assistVisibilityPhase, setAssistVisibilityPhase] =
    useState<AssistVisibilityPhase>('hidden');
  const [isMicListening, setIsMicListening] = useState(false);
  const [isMicPrepared, setIsMicPrepared] = useState(false);
  const [isMicPreparing, setIsMicPreparing] = useState(false);
  const [isCueEndpointAvailable, setIsCueEndpointAvailable] = useState(true);
  const [lastSpeechAtMs, setLastSpeechAtMs] = useState(-1);
  const [lastVoiceActivityAtMs, setLastVoiceActivityAtMs] = useState(-1);
  const [speechStreakStartedAtMs, setSpeechStreakStartedAtMs] = useState(-1);
  const [silenceStreakStartedAtMs, setSilenceStreakStartedAtMs] = useState(-1);
  const [audioLevel, setAudioLevel] = useState(0);
  const [boothClockMs, setBoothClockMs] = useState(() => Date.now());
  const [boothInterpretation, setBoothInterpretation] = useState<BoothInterpretation | null>(null);
  const [generatedCue, setGeneratedCue] = useState<GenerateBoothCueResponse | null>(null);
  const [generatedCueRequestedAt, setGeneratedCueRequestedAt] = useState(0);
  const [standbyVoiceEnabled, setStandbyVoiceEnabled] = useState(false);
  const [standbyVoiceStatus, setStandbyVoiceStatus] = useState<StandbyVoiceStatus>('disabled');
  const [standbyVoiceSampleDurationMs, setStandbyVoiceSampleDurationMs] = useState(0);
  const [speechVoicesReady, setSpeechVoicesReady] = useState(() => getAvailableSpeechVoices().length > 0);
  const [activeDeliverySource, setActiveDeliverySource] = useState<DeliverySource>('live-mic');
  const [handoffState, setHandoffState] = useState<HandoffState>('idle');
  const [handoffCountdown, setHandoffCountdown] = useState<number | null>(null);
  const [handoffNote, setHandoffNote] = useState<string | null>(null);
  const [subbedCue, setSubbedCue] = useState<GenerateBoothCueResponse | null>(null);
  const [subbedCueRequestedAt, setSubbedCueRequestedAt] = useState(0);
  const [isSyntheticSpeaking, setIsSyntheticSpeaking] = useState(false);
  const [assistLockExpiresAt, setAssistLockExpiresAt] = useState(0);
  const [assistEpisodeId, setAssistEpisodeId] = useState(0);
  const [isAssistEpisodeActive, setIsAssistEpisodeActive] = useState(false);
  const [latchedAssistEpisodeId, setLatchedAssistEpisodeId] = useState(0);
  const [isStageContextOpen, setIsStageContextOpen] = useState(false);
  const [microphoneAvailability, setMicrophoneAvailability] =
    useState<MicrophoneAvailability>('supported');
  const shouldKeepMicLiveRef = useRef(false);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioMonitorIntervalRef = useRef<number | null>(null);
  const realtimePeerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const realtimeDataChannelRef = useRef<RTCDataChannel | null>(null);
  const bufferedRecorderRef = useRef<MediaRecorder | null>(null);
  const bufferedRecorderSegmentTimerRef = useRef<number | null>(null);
  const transcribeEndpointAvailableRef = useRef(true);
  const bufferedTranscriptionQueueRef = useRef(Promise.resolve());
  const consecutiveBufferedTranscriptFailuresRef = useRef(0);
  const cueRetryBlockedUntilRef = useRef(0);
  const subbedCueRetryBlockedUntilRef = useRef(0);
  const realtimeTranscriptItemRef = useRef<{ itemId: string | null; text: string }>({
    itemId: null,
    text: '',
  });
  const audioNoiseFloorRef = useRef(0.004);
  const audioActivityThresholdRef = useRef(0.02);
  const lastPersistedSampleAtRef = useRef<number>(-1);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const clipObjectUrlRef = useRef<string | null>(null);
  const lastRestartTokenRef = useRef(controls.restartToken);
  const lastResolvedFeedKeyRef = useRef('');
  const standbySampleRecorderRef = useRef<MediaRecorder | null>(null);
  const standbySampleStopTimerRef = useRef<number | null>(null);
  const standbySampleChunksRef = useRef<Blob[]>([]);
  const standbySampleStartedAtRef = useRef(0);
  const channel3InputRef = useRef<HTMLInputElement | null>(null);
  const handoffTimerRef = useRef<number | null>(null);
  const syntheticUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const spokenSyntheticCueTextsRef = useRef<string[]>([]);
  const liveSignalTranscriptKeyRef = useRef('');
  const liveSignalTranscriptTimerRef = useRef<number | null>(null);
  const isPublishingLiveTranscriptRef = useRef(false);
  const liveSignalFrameTimerRef = useRef<number | null>(null);
  const isPublishingLiveFrameRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const syncRoute = () => {
      setAppRoute(getAppRouteFromLocation());
    };

    syncRoute();
    window.addEventListener('hashchange', syncRoute);
    if (!window.location.hash) {
      setAppRouteHash('live-desk');
    }

    return () => {
      window.removeEventListener('hashchange', syncRoute);
      if (window.location.hash !== '#/live-desk') {
        window.location.hash = '#/live-desk';
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const rawProfile = window.localStorage.getItem(STANDBY_VOICE_STORAGE_KEY);
      if (!rawProfile) {
        return;
      }

      const parsed = JSON.parse(rawProfile) as {
        enabled?: boolean;
        status?: StandbyVoiceStatus;
        sampleDurationMs?: number;
        readyAt?: string | null;
      };

      if (parsed.enabled && parsed.status === 'ready') {
        setStandbyVoiceEnabled(true);
        setStandbyVoiceStatus('ready');
        setStandbyVoiceSampleDurationMs(parsed.sampleDurationMs ?? 0);
      }
    } catch (_error) {
      window.localStorage.removeItem(STANDBY_VOICE_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const rawLibrary = window.localStorage.getItem(LOCAL_CONTEXT_LIBRARY_STORAGE_KEY);
      if (!rawLibrary) {
        return;
      }

      const parsed = JSON.parse(rawLibrary) as LocalContextEntry[];
      if (Array.isArray(parsed)) {
        setLocalContextLibrary(
          parsed.filter((entry) => typeof entry?.id === 'string' && typeof entry?.text === 'string'),
        );
      }
    } catch (_error) {
      window.localStorage.removeItem(LOCAL_CONTEXT_LIBRARY_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (localContextLibrary.length === 0) {
      window.localStorage.removeItem(LOCAL_CONTEXT_LIBRARY_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(LOCAL_CONTEXT_LIBRARY_STORAGE_KEY, JSON.stringify(localContextLibrary));
  }, [localContextLibrary]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const rawHiddenIds = window.localStorage.getItem(HIDDEN_CONTEXT_DOCUMENT_IDS_STORAGE_KEY);
      if (!rawHiddenIds) {
        return;
      }

      const parsed = JSON.parse(rawHiddenIds) as string[];
      if (Array.isArray(parsed)) {
        setHiddenContextDocumentIds(parsed.filter((value) => typeof value === 'string'));
      }
    } catch (_error) {
      window.localStorage.removeItem(HIDDEN_CONTEXT_DOCUMENT_IDS_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (hiddenContextDocumentIds.length === 0) {
      window.localStorage.removeItem(HIDDEN_CONTEXT_DOCUMENT_IDS_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(
      HIDDEN_CONTEXT_DOCUMENT_IDS_STORAGE_KEY,
      JSON.stringify(hiddenContextDocumentIds),
    );
  }, [hiddenContextDocumentIds]);

  useEffect(() => {
    if (!supportsSpeechSynthesis()) {
      setSpeechVoicesReady(false);
      return;
    }

    const refreshVoices = () => {
      setSpeechVoicesReady(getAvailableSpeechVoices().length > 0);
    };

    refreshVoices();
    window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);

    return () => {
      window.speechSynthesis.removeEventListener?.('voiceschanged', refreshVoices);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (handoffTimerRef.current !== null) {
        window.clearInterval(handoffTimerRef.current);
      }
      if (standbySampleStopTimerRef.current !== null) {
        window.clearTimeout(standbySampleStopTimerRef.current);
      }
      if (liveSignalTranscriptTimerRef.current !== null) {
        window.clearTimeout(liveSignalTranscriptTimerRef.current);
      }
      if (liveSignalFrameTimerRef.current !== null) {
        window.clearInterval(liveSignalFrameTimerRef.current);
      }
      if (supportsSpeechSynthesis()) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  function navigateToRoute(route: AppRoute) {
    setAppRoute(route);
    setAppRouteHash(route);
  }

  function persistStandbyVoiceProfile(nextState: {
    enabled: boolean;
    status: StandbyVoiceStatus;
    sampleDurationMs: number;
    readyAt: string | null;
  }) {
    if (typeof window === 'undefined') {
      return;
    }

    if (!nextState.enabled || nextState.status !== 'ready') {
      window.localStorage.removeItem(STANDBY_VOICE_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(STANDBY_VOICE_STORAGE_KEY, JSON.stringify(nextState));
  }

  function cancelSyntheticSpeech() {
    if (!supportsSpeechSynthesis()) {
      return;
    }

    window.speechSynthesis.cancel();
    syntheticUtteranceRef.current = null;
    setIsSyntheticSpeaking(false);
  }

  function buildStandbyFallbackText() {
    const latestCueText =
      generatedCue?.assist.type !== 'none' && generatedCue?.assist.text.trim()
        ? generatedCue.assist.text.trim()
        : activeAssist.type !== 'none' && activeAssist.text.trim()
          ? activeAssist.text.trim()
          : null;

    if (latestCueText) {
      return latestCueText;
    }

    const recentMoment = worldState.recentEvents[worldState.recentEvents.length - 1]?.description?.trim();
    if (recentMoment) {
      return `${recentMoment} Stay with the live moment and keep the call moving.`;
    }

    const contextHeadline = worldState.contextBundle.items[0]?.detail?.trim();
    if (contextHeadline) {
      return contextHeadline;
    }

    if (preMatchCueSummary.trim()) {
      return preMatchCueSummary.trim();
    }

    return null;
  }

  useEffect(() => {
    let isActive = true;

    void listStoredProgramFeeds().then(async (feeds) => {
      if (!isActive) {
        return;
      }

      const nextFeeds = createEmptyStoredProgramFeeds();

      for (const feed of feeds) {
        nextFeeds[feed.slotId] = feed;
      }

      setStoredProgramFeeds(nextFeeds);

      const presetSlots = PROGRAM_FEED_SLOTS.filter((slot) => slot.source === 'preset');
      for (const presetSlot of presetSlots) {
        if (presetSlot.presetUrl && (await canLoadPresetFeed(presetSlot.presetUrl))) {
          if (!isActive) {
            return;
          }
          setSelectedProgramFeedId(presetSlot.id);
          setLoadedClipUrl(presetSlot.presetUrl);
          setLoadedClipName(presetSlot.presetFileName ?? presetSlot.label);
          setBoothError(null);
          return;
        }
      }

      const firstUploadSlot = PROGRAM_FEED_SLOTS.find((slot) => nextFeeds[slot.id]);
      if (firstUploadSlot && nextFeeds[firstUploadSlot.id]) {
        const blob = nextFeeds[firstUploadSlot.id]?.blob;
        if (blob) {
          if (clipObjectUrlRef.current) {
            URL.revokeObjectURL(clipObjectUrlRef.current);
          }
          const nextUrl = URL.createObjectURL(blob);
          clipObjectUrlRef.current = nextUrl;
          setSelectedProgramFeedId(firstUploadSlot.id);
          setLoadedClipUrl(nextUrl);
          setLoadedClipName(nextFeeds[firstUploadSlot.id]?.fileName ?? '');
        }
      }
    });

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (sessionContextMode !== 'inherit-global') {
      return;
    }

    const nextIds = contextDocuments
      .filter((document) => !hiddenContextDocumentIds.includes(document.id))
      .map((document) => document.id);
    setSessionSelectedGlobalContextIds((current) =>
      current.length === nextIds.length && current.every((id, index) => id === nextIds[index]) ? current : nextIds,
    );
  }, [contextDocuments, hiddenContextDocumentIds, sessionContextMode]);

  useEffect(() => {
    let isActive = true;

    void listUserContextDocuments()
      .then((response) => {
        if (!isActive) {
          return;
        }
        setContextDocuments(response.documents);
      })
      .catch(() => {
        if (!isActive) {
          return;
        }
      });

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    let isActive = true;

    const syncDashboard = async () => {
      try {
        const [nextWorldState, nextControls, nextBoothSessions] = await Promise.all([
          fetchWorldState(),
          fetchControlState(),
          fetchBoothSessions(),
        ]);

        if (!isActive) {
          return;
        }

        startTransition(() => {
          setWorldState(nextWorldState);
          setControls(nextControls);
          setRecentBoothSessions(nextBoothSessions.sessions);
          setError(null);
          setIsHydrated(true);
        });
      } catch (_error) {
        if (!isActive) {
          return;
        }

        setError('Waiting for the API and worker loop to come online.');
      }
    };

    void syncDashboard();
    const intervalId = window.setInterval(() => {
      void syncDashboard();
    }, 1_000);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!isMicListening) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setBoothClockMs(Date.now());
    }, 200);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isMicListening]);

  useEffect(() => {
    if (!loadedClipUrl || !videoRef.current) {
      return;
    }

    if (hasStartedBroadcast && controls.playbackStatus === 'playing') {
      safelyPlayVideo(videoRef.current, () => {
        setBoothError('Press play on the loaded clip if the browser blocks autoplay.');
      });
      return;
    }

    videoRef.current.pause();
  }, [controls.playbackStatus, hasStartedBroadcast, loadedClipUrl]);

  useEffect(() => {
    if (!hasStartedBroadcast || controls.playbackStatus !== 'playing') {
      liveSignalTranscriptKeyRef.current = '';
      if (liveSignalTranscriptTimerRef.current !== null) {
        window.clearTimeout(liveSignalTranscriptTimerRef.current);
        liveSignalTranscriptTimerRef.current = null;
      }
      return;
    }

    const transcriptWindow = boothTranscript.slice(-6);
    if (transcriptWindow.length === 0) {
      return;
    }

    const transcriptKey = transcriptWindow
      .map((entry) => `${entry.timestamp}:${entry.speaker}:${entry.text}`)
      .join('|');

    if (transcriptKey === liveSignalTranscriptKeyRef.current || isPublishingLiveTranscriptRef.current) {
      return;
    }

    if (liveSignalTranscriptTimerRef.current !== null) {
      window.clearTimeout(liveSignalTranscriptTimerRef.current);
    }

    liveSignalTranscriptTimerRef.current = window.setTimeout(() => {
      isPublishingLiveTranscriptRef.current = true;
      void publishBoothLiveSignals({
        transcriptWindow,
        clipName: loadedClipName || undefined,
        clockMs: Math.max(0, Math.round((videoRef.current?.currentTime ?? 0) * 1_000)),
      })
        .then(() => {
          liveSignalTranscriptKeyRef.current = transcriptKey;
        })
        .catch(() => {
          // Keep the live desk moving if signal sync fails.
        })
        .finally(() => {
          isPublishingLiveTranscriptRef.current = false;
        });
    }, LIVE_SIGNAL_TRANSCRIPT_DEBOUNCE_MS);

    return () => {
      if (liveSignalTranscriptTimerRef.current !== null) {
        window.clearTimeout(liveSignalTranscriptTimerRef.current);
        liveSignalTranscriptTimerRef.current = null;
      }
    };
  }, [boothTranscript, controls.playbackStatus, hasStartedBroadcast, loadedClipName]);

  useEffect(() => {
    if (!hasStartedBroadcast || controls.playbackStatus !== 'playing' || !loadedClipUrl) {
      if (liveSignalFrameTimerRef.current !== null) {
        window.clearInterval(liveSignalFrameTimerRef.current);
        liveSignalFrameTimerRef.current = null;
      }
      return;
    }

    const publishFrame = () => {
      if (isPublishingLiveFrameRef.current || !videoRef.current || videoRef.current.readyState < 2) {
        return;
      }

      isPublishingLiveFrameRef.current = true;
      void captureVideoFrameAsBase64(videoRef.current)
        .then(({ screenshotBase64, mimeType }) =>
          publishBoothLiveSignals({
            screenshotBase64,
            mimeType,
            clipName: loadedClipName || undefined,
            clockMs: Math.max(0, Math.round((videoRef.current?.currentTime ?? 0) * 1_000)),
          }),
        )
        .catch(() => {
          // Ignore frame-analysis hiccups so playback stays smooth.
        })
        .finally(() => {
          isPublishingLiveFrameRef.current = false;
        });
    };

    publishFrame();
    liveSignalFrameTimerRef.current = window.setInterval(publishFrame, LIVE_SIGNAL_FRAME_INTERVAL_MS);

    return () => {
      if (liveSignalFrameTimerRef.current !== null) {
        window.clearInterval(liveSignalFrameTimerRef.current);
        liveSignalFrameTimerRef.current = null;
      }
    };
  }, [controls.playbackStatus, hasStartedBroadcast, loadedClipName, loadedClipUrl]);

  useEffect(() => {
    if (controls.restartToken === lastRestartTokenRef.current) {
      return;
    }

    lastRestartTokenRef.current = controls.restartToken;
    setBoothTranscript([]);
    setBoothInterimTranscript('');
    setLastSpeechAtMs(-1);
    setLastVoiceActivityAtMs(-1);
    setSpeechStreakStartedAtMs(-1);
    setSilenceStreakStartedAtMs(-1);
    setAudioLevel(0);
    setBoothClockMs(Date.now());

    if (!videoRef.current) {
      return;
    }

    videoRef.current.currentTime = 0;

    if (hasStartedBroadcast && controls.playbackStatus === 'playing') {
      safelyPlayVideo(videoRef.current, () => {
        setBoothError('Press play on the loaded clip if the browser blocks autoplay.');
      });
    }
  }, [controls.playbackStatus, controls.restartToken, hasStartedBroadcast]);

  useEffect(() => {
    return () => {
      shouldKeepMicLiveRef.current = false;
      if (audioMonitorIntervalRef.current !== null) {
        window.clearInterval(audioMonitorIntervalRef.current);
      }
      bufferedRecorderRef.current?.stop();
      realtimeDataChannelRef.current?.close();
      realtimePeerConnectionRef.current?.close();
      audioContextRef.current?.close().catch(() => undefined);
      microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());

      if (clipObjectUrlRef.current) {
        URL.revokeObjectURL(clipObjectUrlRef.current);
      }
    };
  }, []);

  async function sendControlPatch(
    patch: Partial<ReplayControlState> & {
      restart?: boolean;
    },
  ) {
    setIsUpdatingControls(true);
    setControls((current) => ({
      ...current,
      ...(patch.playbackStatus ? { playbackStatus: patch.playbackStatus } : {}),
      ...(patch.preferredStyleMode ? { preferredStyleMode: patch.preferredStyleMode } : {}),
      ...(typeof patch.forceHesitation === 'boolean'
        ? { forceHesitation: patch.forceHesitation }
        : {}),
      ...(patch.activeFixtureId ? { activeFixtureId: patch.activeFixtureId } : {}),
      restartToken: current.restartToken + (patch.restart ? 1 : 0),
    }));

    try {
      const nextControls = await updateControlState(patch);
      setControls(nextControls);
      setError(null);
    } catch (_error) {
      setError('Control update failed. The API may still be warming up.');
    } finally {
      setIsUpdatingControls(false);
    }
  }

  function getCurrentTranscriptTimestamp() {
    if (videoRef.current && Number.isFinite(videoRef.current.currentTime)) {
      return Math.round(videoRef.current.currentTime * 1_000);
    }

    return parseClock(worldState.clock);
  }

  useEffect(() => {
    if (!loadedClipUrl || !loadedClipName || hasStartedBroadcast) {
      return;
    }

    const videoElement = videoRef.current;
    if (!videoElement || clipDurationMs <= 0 || videoElement.readyState < 2) {
      return;
    }

    const feedKey = `${selectedProgramFeedId ?? 'unknown'}:${loadedClipName}:${loadedClipUrl}`;
    if (lastResolvedFeedKeyRef.current === feedKey || isResolvingFixture) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setIsResolvingFixture(true);

      void captureVideoFrameAsBase64(videoElement)
        .then(({ screenshotBase64, mimeType }) =>
          resolveFixture(screenshotBase64, mimeType, loadedClipName),
        )
        .catch((_error) => resolveFixture(undefined, undefined, loadedClipName))
        .then(async (resolvedFixture) => {
          lastResolvedFeedKeyRef.current = feedKey;

          if (controls.activeFixtureId !== resolvedFixture.fixtureId) {
            await sendControlPatch({ activeFixtureId: resolvedFixture.fixtureId });
          }

          setBoothError(null);
        })
        .catch((error) => {
          lastResolvedFeedKeyRef.current = feedKey;
          setBoothError((current) =>
            current ??
            getFixtureResolutionErrorMessage(error),
          );
        })
        .finally(() => {
          setIsResolvingFixture(false);
        });
    }, 900);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    clipDurationMs,
    controls.activeFixtureId,
    hasStartedBroadcast,
    isResolvingFixture,
    loadedClipName,
    loadedClipUrl,
    selectedProgramFeedId,
  ]);

  function clearLoadedClip() {
    if (clipObjectUrlRef.current) {
      URL.revokeObjectURL(clipObjectUrlRef.current);
      clipObjectUrlRef.current = null;
    }

    setLoadedClipName('');
    setLoadedClipUrl(null);
    setClipDurationMs(0);
    setIsClipMuted(true);
    setIsResolvingFixture(false);
    setHasStartedBroadcast(false);
    setActiveBoothSessionId(null);
    setSessionContextEntries([]);
    setSessionContextText('');
    setSessionContextMode('inherit-global');
    setIsMicPrepared(false);
    setSpeechStreakStartedAtMs(-1);
    setSilenceStreakStartedAtMs(-1);
    setSelectedProgramFeedId(null);
    lastResolvedFeedKeyRef.current = '';
    consecutiveBufferedTranscriptFailuresRef.current = 0;
    cancelSyntheticSpeech();
    setActiveDeliverySource('live-mic');
    setHandoffState('idle');
    setHandoffCountdown(null);
    setHandoffNote(null);
  }

  async function saveContextEntry(params: {
    fileName: string;
    text: string;
    sourceType: 'text' | 'file';
    scope: ContextScope;
  }) {
    const { fileName, text, sourceType, scope } = params;
    const trimmedText = text.trim();
    if (!trimmedText) {
      throw new Error('empty context');
    }

    const response = await uploadUserContext(fileName, trimmedText, sourceType);
    setContextDocuments((current) => [response.document, ...current]);

    const nextEntry: LocalContextEntry = {
      id: `${scope}-${response.document.id}`,
      fileName: response.document.fileName,
      sourceType,
      text: trimmedText,
      createdAt: response.document.createdAt,
      backendDocumentId: response.document.id,
    };

    setLocalContextLibrary((current) => [
      nextEntry,
      ...current.filter((entry) => entry.backendDocumentId !== response.document.id),
    ]);
    setHiddenContextDocumentIds((current) => current.filter((id) => id !== response.document.id));

    if (scope === 'session') {
      setSessionContextEntries((current) => [
        nextEntry,
        ...current.filter((entry) => entry.backendDocumentId !== response.document.id),
      ]);
    }

    setBoothError(null);
  }

  async function handleContextTextUpload() {
    const text = contextUploadText.trim();
    if (!text) {
      return;
    }

    setIsUploadingContext(true);
    try {
      await saveContextEntry({
        fileName: 'Global notes',
        text,
        sourceType: 'text',
        scope: 'global',
      });
      setContextUploadText('');
    } catch (_error) {
      setBoothError('User context could not be uploaded right now.');
    } finally {
      setIsUploadingContext(false);
    }
  }

  async function handleContextFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setIsUploadingContext(true);
    try {
      const text = await readFileAsText(file);
      await saveContextEntry({
        fileName: file.name,
        text,
        sourceType: 'file',
        scope: 'global',
      });
    } catch (_error) {
      setBoothError('This file could not be ingested as text context.');
    } finally {
      setIsUploadingContext(false);
      event.target.value = '';
    }
  }

  async function handleSessionContextTextUpload() {
    const text = sessionContextText.trim();
    if (!text) {
      return;
    }

    setIsUploadingContext(true);
    try {
      await saveContextEntry({
        fileName: `Session note · ${loadedClipName || 'Current feed'}`,
        text,
        sourceType: 'text',
        scope: 'session',
      });
      setSessionContextText('');
      if (sessionContextMode === 'inherit-global') {
        setSessionContextMode('custom');
      }
    } catch (_error) {
      setBoothError('This session note could not be added right now.');
    } finally {
      setIsUploadingContext(false);
    }
  }

  async function handleSessionContextFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setIsUploadingContext(true);
    try {
      const text = await readFileAsText(file);
      await saveContextEntry({
        fileName: file.name,
        text,
        sourceType: 'file',
        scope: 'session',
      });
      if (sessionContextMode === 'inherit-global') {
        setSessionContextMode('custom');
      }
    } catch (_error) {
      setBoothError('This file could not be added to the current session.');
    } finally {
      setIsUploadingContext(false);
      event.target.value = '';
    }
  }

  function removeGlobalContextDocument(documentId: string) {
    setHiddenContextDocumentIds((current) =>
      current.includes(documentId) ? current : [...current, documentId],
    );
    setSessionSelectedGlobalContextIds((current) => current.filter((id) => id !== documentId));
  }

  function editSessionContextEntry(entryId: string) {
    const existingEntry = sessionContextEntries.find((entry) => entry.id === entryId);
    if (!existingEntry) {
      return;
    }

    setSessionContextMode('custom');
    setSessionContextText(existingEntry.text);
    setSessionContextEntries((current) => current.filter((entry) => entry.id !== entryId));
  }

  function removeSessionContextEntry(entryId: string) {
    setSessionContextEntries((current) => current.filter((entry) => entry.id !== entryId));
  }

  async function refreshBoothSessions() {
    try {
      const nextBoothSessions = await fetchBoothSessions();
      setRecentBoothSessions(nextBoothSessions.sessions);
      setBoothError((current) =>
        current === 'Saved sessions could not be loaded from the API.' ? null : current,
      );
      return true;
    } catch (_error) {
      setBoothError('Saved sessions could not be loaded from the API.');
      return false;
    }
  }

  async function loadSessionReview(sessionId: string) {
    setSelectedReviewSessionId(sessionId);
    setIsLoadingReview(true);
    setBoothError(null);

    try {
      const completedSession = await fetchBoothSession(sessionId);
      setLatestCompletedSession(completedSession.session);
    } catch (_error) {
      setBoothError('The saved session could not be loaded right now.');
    }

    try {
      const review = await fetchBoothSessionReview(sessionId);
      setLatestCompletedSessionReview(review.review);
    } catch (_error) {
      setLatestCompletedSessionReview(null);
      setBoothError('The AI session analysis is still processing. Try this saved run again in a moment.');
    } finally {
      setIsLoadingReview(false);
    }
  }

  async function finalizeBoothSession() {
    if (!activeBoothSessionId) {
      return;
    }

    setIsFinalizingSession(true);
    setBoothError(null);

    try {
      const response = await finishBoothSession(activeBoothSessionId);
      setLatestCompletedSessionReview(null);
      setSelectedReviewSessionId(response.session.id);
      if ('samples' in response.session) {
        setLatestCompletedSession(response.session as BoothSessionRecord);
      }

      try {
        const completedSession = await fetchBoothSession(response.session.id);
        setLatestCompletedSession(completedSession.session);
      } catch (_error) {
        setBoothError('The live session was saved, but the saved session detail is not ready yet.');
      }

      navigateToRoute('analyze');

      try {
        const review = await fetchBoothSessionReview(response.session.id);
        setLatestCompletedSessionReview(review.review);
      } catch (_error) {
        setBoothError('The live session was saved, but the AI session analysis is still loading.');
      }

      try {
        await refreshBoothSessions();
      } catch (_error) {
        setBoothError('The live session was saved, but the session list could not refresh yet.');
      }
    } catch (_error) {
      setBoothError('The live session could not be finalized in the saved session store.');
    } finally {
      setIsFinalizingSession(false);
      setActiveBoothSessionId(null);
      lastPersistedSampleAtRef.current = -1;
    }
  }

  async function startRealtimeTranscription(stream: MediaStream) {
    if (typeof window === 'undefined' || typeof window.RTCPeerConnection === 'undefined') {
      return false;
    }

    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) {
      return false;
    }

    const peerConnection = new window.RTCPeerConnection();
    realtimePeerConnectionRef.current = peerConnection;

    const eventsChannel = peerConnection.createDataChannel('oai-events');
    realtimeDataChannelRef.current = eventsChannel;

    if (import.meta.env.DEV) {
      console.debug('booth-transcription', { stage: 'realtime-start' });
    }

    eventsChannel.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as {
          type?: string;
          item_id?: string;
          delta?: string;
          transcript?: string;
        };
        const now = Date.now();

        if (payload.type === 'input_audio_buffer.speech_started') {
          setLastVoiceActivityAtMs(now);
          setBoothClockMs(now);
          return;
        }

        if (payload.type === 'conversation.item.input_audio_transcription.delta') {
          const nextItemId = payload.item_id ?? realtimeTranscriptItemRef.current.itemId;
          const nextText =
            realtimeTranscriptItemRef.current.itemId === nextItemId
              ? `${realtimeTranscriptItemRef.current.text}${payload.delta ?? ''}`
              : payload.delta ?? '';

          realtimeTranscriptItemRef.current = {
            itemId: nextItemId ?? null,
            text: nextText,
          };
          setBoothInterimTranscript(nextText.trim());
          setLastSpeechAtMs(now);
          setLastVoiceActivityAtMs(now);
          setBoothClockMs(now);
          return;
        }

        if (payload.type === 'conversation.item.input_audio_transcription.completed') {
          const transcriptText = (payload.transcript ?? realtimeTranscriptItemRef.current.text).trim();
          realtimeTranscriptItemRef.current = { itemId: null, text: '' };

          if (!transcriptText) {
            setBoothInterimTranscript('');
            if (import.meta.env.DEV) {
              console.debug('booth-transcription', { stage: 'realtime-empty' });
            }
            return;
          }

          const baseTimestamp = getCurrentTranscriptTimestamp();
          setBoothTranscript((current) =>
            mergeTranscriptEntry(current, createTranscriptEntry(baseTimestamp, transcriptText)),
          );
          setBoothInterimTranscript('');
          consecutiveBufferedTranscriptFailuresRef.current = 0;
          setBoothError((current) =>
            shouldClearBufferedTranscriptionWarning(current) ? null : current,
          );
          setLastSpeechAtMs(now);
          setLastVoiceActivityAtMs(now);
          setBoothClockMs(now);
          if (import.meta.env.DEV) {
            console.debug('booth-transcription', {
              stage: 'realtime-commit',
              transcript: transcriptText,
            });
          }
        }
      } catch (_error) {
        // Ignore malformed realtime events and keep the booth live.
      }
    });

    peerConnection.addTrack(audioTrack, stream);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    const answerSdp = await connectRealtimeBoothSession(offer.sdp ?? '');
    await peerConnection.setRemoteDescription({
      type: 'answer',
      sdp: answerSdp,
    });

    return true;
  }

  function startBufferedTranscription(stream: MediaStream) {
    const mimeType = getSupportedRecorderMimeType();

    if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined' || !mimeType) {
      return false;
    }

    const startSegment = () => {
      if (!shouldKeepMicLiveRef.current || !transcribeEndpointAvailableRef.current) {
        return;
      }

      const recorder = new window.MediaRecorder(stream, { mimeType });
      bufferedRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0 || !transcribeEndpointAvailableRef.current) {
          return;
        }

        bufferedTranscriptionQueueRef.current = bufferedTranscriptionQueueRef.current
          .then(async () => {
            if (import.meta.env.DEV) {
              console.debug('booth-transcription', {
                stage: 'buffered-send',
                bytes: event.data.size,
              });
            }
            const audioBase64 = await encodeBlobAsBase64(event.data);
            const result = await transcribeBoothAudio(audioBase64, recorder.mimeType || mimeType);

            if (result.source !== 'openai' || !result.transcript.trim()) {
              consecutiveBufferedTranscriptFailuresRef.current += 1;
              if (import.meta.env.DEV) {
                console.debug('booth-transcription', {
                  stage: 'buffered-empty',
                  source: result.source,
                  failures: consecutiveBufferedTranscriptFailuresRef.current,
                });
              }
              if (
                consecutiveBufferedTranscriptFailuresRef.current >=
                BUFFERED_TRANSCRIPTION_WARNING_THRESHOLD
              ) {
                setBoothError((current) => current ?? BUFFERED_TRANSCRIPTION_WARNING);
              }
              return;
            }

            const transcriptText = result.transcript.trim();
            const now = Date.now();
            const baseTimestamp = getCurrentTranscriptTimestamp();

            setBoothTranscript((current) =>
              mergeTranscriptEntry(current, createTranscriptEntry(baseTimestamp, transcriptText)),
            );
            setBoothInterimTranscript('');
            consecutiveBufferedTranscriptFailuresRef.current = 0;
            setBoothError((current) =>
              shouldClearBufferedTranscriptionWarning(current) ? null : current,
            );
            setLastSpeechAtMs(now);
            setLastVoiceActivityAtMs(now);
            setBoothClockMs(now);
            if (import.meta.env.DEV) {
              console.debug('booth-transcription', {
                stage: 'buffered-commit',
                source: result.source,
                transcript: transcriptText,
              });
            }
          })
          .catch((error) => {
            if (isMissingApiRouteError(error, '/booth/transcribe')) {
              transcribeEndpointAvailableRef.current = false;
              setBoothError('Render is missing the /booth/transcribe route. Redeploy the API service.');
              return;
            }

            consecutiveBufferedTranscriptFailuresRef.current += 1;
            if (import.meta.env.DEV) {
              console.debug('booth-transcription', {
                stage: 'buffered-failed',
                failures: consecutiveBufferedTranscriptFailuresRef.current,
                message: error instanceof Error ? error.message : String(error),
              });
            }
            if (
              consecutiveBufferedTranscriptFailuresRef.current >=
              BUFFERED_TRANSCRIPTION_WARNING_THRESHOLD
            ) {
              setBoothError((current) => current ?? BUFFERED_TRANSCRIPTION_WARNING);
            }
            // Keep booth flow alive if a buffered chunk fails.
          });
      };

      recorder.onstop = () => {
        if (bufferedRecorderSegmentTimerRef.current !== null) {
          window.clearTimeout(bufferedRecorderSegmentTimerRef.current);
          bufferedRecorderSegmentTimerRef.current = null;
        }

        if (bufferedRecorderRef.current === recorder) {
          bufferedRecorderRef.current = null;
        }

        if (
          shouldKeepMicLiveRef.current &&
          transcribeEndpointAvailableRef.current &&
          stream.getAudioTracks().some((track) => track.readyState === 'live')
        ) {
          window.setTimeout(startSegment, 0);
        }
      };

      recorder.start();
      bufferedRecorderSegmentTimerRef.current = window.setTimeout(() => {
        try {
          recorder.stop();
        } catch (_error) {
          // Ignore invalid state transitions while cycling the recorder.
        }
      }, BUFFERED_TRANSCRIPTION_CHUNK_MS);
    };

    startSegment();
    return true;
  }

  async function startAudioMonitoring() {
    if (
      microphoneStreamRef.current &&
      audioContextRef.current &&
      audioMonitorIntervalRef.current !== null
    ) {
      return microphoneStreamRef.current;
    }

    if (!supportsAudioMonitoring()) {
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const audioContext = new window.AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.78;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);

    microphoneStreamRef.current = stream;
    audioContextRef.current = audioContext;

    audioMonitorIntervalRef.current = window.setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      const nextAudioLevel = calculateAudioLevel(samples);
      const currentThreshold = audioActivityThresholdRef.current;
      const isLikelyAmbient = nextAudioLevel < currentThreshold * 1.15;

      if (isLikelyAmbient) {
        audioNoiseFloorRef.current = audioNoiseFloorRef.current * 0.92 + nextAudioLevel * 0.08;
        audioActivityThresholdRef.current = Math.min(
          MAX_AUDIO_ACTIVITY_THRESHOLD,
          Math.max(MIN_AUDIO_ACTIVITY_THRESHOLD, audioNoiseFloorRef.current * 3.2),
        );
      }

      setAudioLevel(nextAudioLevel);
      setBoothClockMs(Date.now());

      if (nextAudioLevel >= audioActivityThresholdRef.current) {
        setLastVoiceActivityAtMs(Date.now());
      }
    }, AUDIO_ACTIVITY_SAMPLE_MS);

    return stream;
  }

  async function prepareMicrophone() {
    if (!supportsAudioMonitoring()) {
      setMicrophoneAvailability('unsupported');
      setBoothError('This browser cannot enable the booth microphone. Chrome or Edge work best.');
      setIsMicPrepared(false);
      return false;
    }

    setIsMicPreparing(true);
    setBoothError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      stream.getTracks().forEach((track) => track.stop());
      setMicrophoneAvailability('supported');
      setIsMicPrepared(true);
      return true;
    } catch (_error) {
      setMicrophoneAvailability('degraded');
      setBoothError('Microphone access was blocked. Allow mic access to go live.');
      setIsMicPrepared(false);
      return false;
    } finally {
      setIsMicPreparing(false);
    }
  }

  function stopAudioMonitoring() {
    if (bufferedRecorderSegmentTimerRef.current !== null) {
      window.clearTimeout(bufferedRecorderSegmentTimerRef.current);
      bufferedRecorderSegmentTimerRef.current = null;
    }
    bufferedRecorderRef.current?.stop();
    bufferedRecorderRef.current = null;
    realtimeDataChannelRef.current?.close();
    realtimeDataChannelRef.current = null;
    realtimePeerConnectionRef.current?.close();
    realtimePeerConnectionRef.current = null;
    realtimeTranscriptItemRef.current = { itemId: null, text: '' };
    if (audioMonitorIntervalRef.current !== null) {
      window.clearInterval(audioMonitorIntervalRef.current);
      audioMonitorIntervalRef.current = null;
    }

    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
    microphoneStreamRef.current = null;
    audioNoiseFloorRef.current = 0.004;
    audioActivityThresholdRef.current = 0.02;
    consecutiveBufferedTranscriptFailuresRef.current = 0;
    cueRetryBlockedUntilRef.current = 0;
    setAudioLevel(0);
    setSpeechStreakStartedAtMs(-1);
    setSilenceStreakStartedAtMs(-1);
  }

  async function loadProgramFeed(slotId: ProgramFeedSlotId, feed: StoredProgramFeed) {
    const slot = PROGRAM_FEED_SLOTS.find((candidate) => candidate.id === slotId);
    if (slot?.source === 'preset' && slot.presetUrl) {
      const presetAvailable = await canLoadPresetFeed(slot.presetUrl);
      if (!presetAvailable) {
        setBoothError('This preset feed is not reachable right now. Use Channel 3 or try the other preset.');
        return;
      }
      if (clipObjectUrlRef.current) {
        URL.revokeObjectURL(clipObjectUrlRef.current);
        clipObjectUrlRef.current = null;
      }
      setSelectedProgramFeedId(slotId);
      setLoadedClipName(slot.presetFileName ?? slot.label);
      setLoadedClipUrl(slot.presetUrl);
      setClipDurationMs(0);
      setIsClipMuted(true);
      setBoothError(null);
      return;
    }

    if (clipObjectUrlRef.current) {
      URL.revokeObjectURL(clipObjectUrlRef.current);
    }

    const nextClipUrl = URL.createObjectURL(feed.blob);
    clipObjectUrlRef.current = nextClipUrl;
    setSelectedProgramFeedId(slotId);
    setLoadedClipName(feed.fileName);
    setLoadedClipUrl(nextClipUrl);
    setClipDurationMs(0);
    setIsClipMuted(true);
    setBoothError(null);
  }

  async function handleProgramFeedChange(
    slotId: ProgramFeedSlotId,
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const inputElement = event.currentTarget;
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const savedFeed = await saveProgramFeed(slotId, file);
    if (savedFeed) {
      setStoredProgramFeeds((current) => ({
        ...current,
        [slotId]: savedFeed,
      }));
      await loadProgramFeed(slotId, savedFeed);
    } else {
      const fallbackFeed: StoredProgramFeed = {
        slotId,
        fileName: file.name,
        fileSize: file.size,
        updatedAt: new Date().toISOString(),
        blob: file,
      };
      setStoredProgramFeeds((current) => ({
        ...current,
        [slotId]: fallbackFeed,
      }));
      await loadProgramFeed(slotId, fallbackFeed);
    }
    if (inputElement) {
      inputElement.value = '';
    }
  }

  async function clearProgramFeedSlot(slotId: ProgramFeedSlotId) {
    await clearProgramFeed(slotId);
    setStoredProgramFeeds((current) => ({
      ...current,
      [slotId]: null,
    }));

    if (selectedProgramFeedId === slotId) {
      clearLoadedClip();
    }
  }

  function startMicrophone() {
    if (!supportsAudioMonitoring()) {
      setMicrophoneAvailability('unsupported');
      setBoothError(
        'This browser cannot run the live AndOne booth stack. Use a browser with getUserMedia, AudioContext, and RTCPeerConnection support.',
      );
      return;
    }

    shouldKeepMicLiveRef.current = true;
    transcribeEndpointAvailableRef.current = true;
    setIsCueEndpointAvailable(true);
    setBoothError(null);
    setIsMicListening(true);
    setBoothClockMs(Date.now());

    void startAudioMonitoring()
      .then((stream) => {
        setMicrophoneAvailability('supported');
        setIsMicPrepared(true);

        if (stream) {
          const startedBufferedShadow = startBufferedTranscription(stream);

          void startRealtimeTranscription(stream).catch(() => {
            if (import.meta.env.DEV) {
              console.debug('booth-transcription', { stage: 'realtime-failed' });
            }
            if (startedBufferedShadow) {
              setBoothError(null);
              return;
            }

            stopAudioMonitoring();
            setIsMicListening(false);
            setBoothError('OpenAI transcription could not start for the booth mic.');
          });
        }
      })
      .catch(() => {
        shouldKeepMicLiveRef.current = false;
        setMicrophoneAvailability('degraded');
        setIsMicPrepared(false);
        setBoothError(
          'Microphone access was blocked. Allow mic access to test live hesitation from your voice.',
        );
        setIsMicListening(false);
      });
  }

  function stopMicrophone() {
    shouldKeepMicLiveRef.current = false;
    stopAudioMonitoring();
    setIsMicListening(false);
    setBoothInterimTranscript('');
    setAudioLevel(0);
  }

  async function recordStandbyVoiceSample() {
    if (!supportsAudioMonitoring()) {
      setStandbyVoiceStatus('failed');
      setBoothError('This browser cannot capture a handoff voice sample.');
      return;
    }

    const mimeType = getSupportedRecorderMimeType();
    if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined' || !mimeType) {
      setStandbyVoiceStatus('failed');
      setBoothError('This browser cannot record a handoff voice sample.');
      return;
    }

    setStandbyVoiceEnabled(true);
    setStandbyVoiceStatus('recording');
    setBoothError(null);
    standbySampleChunksRef.current = [];
    standbySampleStartedAtRef.current = Date.now();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const recorder = new window.MediaRecorder(stream, { mimeType });
      standbySampleRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          standbySampleChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        if (standbySampleStopTimerRef.current !== null) {
          window.clearTimeout(standbySampleStopTimerRef.current);
          standbySampleStopTimerRef.current = null;
        }
        stream.getTracks().forEach((track) => track.stop());
        standbySampleRecorderRef.current = null;

        const sampleDurationMs = Date.now() - standbySampleStartedAtRef.current;
        setStandbyVoiceStatus('processing');

        window.setTimeout(() => {
          const sampleBytes = standbySampleChunksRef.current.reduce((total, blob) => total + blob.size, 0);
          if (sampleDurationMs < MIN_STANDBY_SAMPLE_MS || sampleBytes === 0) {
            setStandbyVoiceStatus('failed');
            setStandbyVoiceSampleDurationMs(0);
            persistStandbyVoiceProfile({
              enabled: false,
              status: 'failed',
              sampleDurationMs: 0,
              readyAt: null,
            });
            setBoothError('The handoff voice sample was too short. Record at least four seconds of clean speech.');
            return;
          }

          const readyAt = new Date().toISOString();
          setStandbyVoiceStatus('ready');
          setStandbyVoiceSampleDurationMs(sampleDurationMs);
          persistStandbyVoiceProfile({
            enabled: true,
            status: 'ready',
            sampleDurationMs,
            readyAt,
          });
        }, 900);
      };

      recorder.start();
      standbySampleStopTimerRef.current = window.setTimeout(() => {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      }, STANDBY_SAMPLE_CAPTURE_MS);
    } catch (_error) {
      setStandbyVoiceStatus('failed');
      setStandbyVoiceEnabled(false);
      setBoothError('Microphone access is required to prepare the handoff voice.');
    }
  }

  function disableStandbyVoice() {
    setStandbyVoiceEnabled(false);
    setStandbyVoiceStatus('disabled');
    setStandbyVoiceSampleDurationMs(0);
    persistStandbyVoiceProfile({
      enabled: false,
      status: 'disabled',
      sampleDurationMs: 0,
      readyAt: null,
    });
  }

  function speakStandbyNarration(text: string) {
    if (!supportsSpeechSynthesis() || !text.trim()) {
      return;
    }

    const handleSpeechFailure = () => {
      setIsSyntheticSpeaking(false);
      setActiveDeliverySource('live-mic');
      setHandoffState('idle');
      setHandoffCountdown(null);
      setHandoffNote(null);
      if (!isMicListening && isMicSupported) {
        startMicrophone();
      }
      setBoothError('Browser speech output failed during the handoff, so the call returned to your live mic.');
    };

    cancelSyntheticSpeech();
    const utterance = new window.SpeechSynthesisUtterance(text);
    const standbyVoice = pickStandbyVoice(getAvailableSpeechVoices());
    if (standbyVoice) {
      utterance.voice = standbyVoice;
      utterance.lang = standbyVoice.lang;
    }
    utterance.rate = 1.02;
    utterance.pitch = 0.96;
    utterance.onstart = () => setIsSyntheticSpeaking(true);
    utterance.onend = () => setIsSyntheticSpeaking(false);
    utterance.onerror = () => {
      handleSpeechFailure();
    };

    syntheticUtteranceRef.current = utterance;
    try {
      window.speechSynthesis.speak(utterance);
    } catch (_error) {
      handleSpeechFailure();
    }
  }

  function beginHandoff(direction: 'sub_in' | 'sub_back') {
    if (handoffTimerRef.current !== null) {
      return;
    }

    if (direction === 'sub_in') {
      if (!hasStartedBroadcast || standbyVoiceStatus !== 'ready' || activeDeliverySource !== 'live-mic') {
        return;
      }
      setHandoffState('preparing_sub_in');
      setHandoffNote('AndOne takes the call in');
    } else {
      if (!hasStartedBroadcast || activeDeliverySource !== 'synthetic-standby') {
        return;
      }
      setHandoffState('preparing_sub_back');
      setHandoffNote('You take the call back in');
    }

    let remaining = HANDOFF_COUNTDOWN_START;
    setHandoffCountdown(remaining);
    handoffTimerRef.current = window.setInterval(() => {
      remaining -= 1;

      if (remaining <= 0) {
        if (handoffTimerRef.current !== null) {
          window.clearInterval(handoffTimerRef.current);
          handoffTimerRef.current = null;
        }
        setHandoffCountdown(null);

        if (direction === 'sub_in') {
          stopMicrophone();
          setActiveDeliverySource('synthetic-standby');
          setHandoffState('subbed_in');
          setHandoffNote('AndOne has the call.');
          setSubbedCue(null);
          setSubbedCueRequestedAt(0);
          spokenSyntheticCueTextsRef.current = [];
          speakStandbyNarration('AndOne has the call. I will cover this stretch while you reset.');
        } else {
          setHandoffState('restoring_live');
          cancelSyntheticSpeech();
          setActiveDeliverySource('live-mic');
          setSubbedCue(null);
          setSubbedCueRequestedAt(0);
          if (!isMicListening && isMicSupported) {
            startMicrophone();
          }
          window.setTimeout(() => {
            setHandoffState('idle');
            setHandoffNote(null);
          }, 450);
        }

        return;
      }

      setHandoffCountdown(remaining);
    }, 1_000);
  }

  function clearBoothTranscript() {
    setBoothTranscript([]);
    setBoothInterimTranscript('');
    realtimeTranscriptItemRef.current = { itemId: null, text: '' };
    setLastSpeechAtMs(-1);
    setLastVoiceActivityAtMs(-1);
    setSpeechStreakStartedAtMs(-1);
    setSilenceStreakStartedAtMs(-1);
    setAudioLevel(0);
    setBoothClockMs(Date.now());
    consecutiveBufferedTranscriptFailuresRef.current = 0;
    setBoothError(null);
  }

  function clearLiveBoothState() {
    if (handoffTimerRef.current !== null) {
      window.clearInterval(handoffTimerRef.current);
      handoffTimerRef.current = null;
    }
    clearBoothTranscript();
    setBoothInterpretation(null);
    setGeneratedCue(null);
    setSubbedCue(null);
    setGeneratedCueRequestedAt(0);
    setSubbedCueRequestedAt(0);
    setLatchedAssist(createEmptyAssistCard());
    setAssistVisibilityPhase('hidden');
    spokenSyntheticCueTextsRef.current = [];
    cueRetryBlockedUntilRef.current = 0;
    subbedCueRetryBlockedUntilRef.current = 0;
    cancelSyntheticSpeech();
    setActiveDeliverySource('live-mic');
    setHandoffState('idle');
    setHandoffCountdown(null);
    setHandoffNote(null);
  }

  async function startBroadcast() {
    setBoothError(null);

    if (!loadedClipUrl) {
      setBoothError('Load a clip before starting the booth.');
      return;
    }

    if (!isSystemReady) {
      setBoothError('AndOne is still linking the hosted backend. Wait for the system link to turn ready before going live.');
      return;
    }

    if (isUploadingContext) {
      setBoothError('AndOne is still indexing your context notes. Wait for that upload to finish before going live.');
      return;
    }

    if (!isMicPrepared) {
      const prepared = await prepareMicrophone();
      await flushMicrotasks();
      if (!prepared) {
        setBoothError('Enable microphone access before going live.');
        return;
      }
    }

    if (!activeBoothSessionId) {
      try {
        const response = await startBoothSession(loadedClipName || 'Untitled clip');
        setActiveBoothSessionId(response.session.id);
        setBoothError(null);
      } catch (error) {
        const detail = getErrorMessage(error);
        setBoothError(`The booth session could not be created. ${detail}`);
        return;
      }

      const refreshed = await refreshBoothSessions();
      if (!refreshed && import.meta.env.DEV) {
        console.debug('booth-session-refresh-failed');
      }
    }

    setLatestCompletedSession(null);
    setLatestCompletedSessionReview(null);
    setHasStartedBroadcast(true);

    if (controls.playbackStatus !== 'playing') {
      await sendControlPatch({ playbackStatus: 'playing' });
    }

    if (!isMicListening && isMicSupported) {
      startMicrophone();
    }
  }

  async function stopBroadcast() {
    setHasStartedBroadcast(false);

    if (isMicListening) {
      stopMicrophone();
    }

    clearLiveBoothState();

    if (controls.playbackStatus !== 'paused') {
      await sendControlPatch({ playbackStatus: 'paused' });
    }

    await finalizeBoothSession();
  }

  const assist = worldState.assist;
  const isMicSupported =
    microphoneAvailability !== 'unsupported' && supportsAudioMonitoring();
  const isSystemReady = isHydrated && !error;
  const isBroadcastReady = Boolean(loadedClipUrl);
  const boothActivity = deriveBoothActivity({
    interimTranscript: boothInterimTranscript,
    isMicListening,
    lastSpeechAtMs,
    lastVoiceActivityAtMs,
    nowMs: boothClockMs,
  });
  const boothSignal = buildBoothSignal({
    boothTranscript,
    interimTranscript: boothInterimTranscript,
    isMicListening,
    lastSpeechAtMs,
    lastVoiceActivityAtMs,
    speechStreakStartedAtMs,
    silenceStreakStartedAtMs,
    audioLevel,
    nowMs: boothClockMs,
  });
  const boothHasTranscriptContext =
    boothInterimTranscript.trim().length > 0 || boothTranscript.length > 0;
  const boothHasLiveInput =
    hasStartedBroadcast &&
    (isMicListening || boothHasTranscriptContext);
  const boothAssistFacts = buildBoothAssistFacts({
    retrieval: worldState.retrieval,
    contextBundle: worldState.contextBundle,
    preMatch: worldState.preMatch,
    liveMatch: worldState.liveMatch,
    socialPosts: worldState.liveSignals.social,
    visionCues: worldState.liveSignals.vision,
    recentEvents: worldState.recentEvents,
  });
  const boothAssist = buildBoothAssist({
    boothSignal,
    boothTranscript,
    interimTranscript: boothInterimTranscript,
    currentTimestampMs: getCurrentTranscriptTimestamp(),
    retrieval: worldState.retrieval,
    contextBundle: worldState.contextBundle,
    preMatch: worldState.preMatch,
    liveMatch: worldState.liveMatch,
    socialPosts: worldState.liveSignals.social,
    visionCues: worldState.liveSignals.vision,
    recentEvents: worldState.recentEvents,
  });
  const boothAssistQuery = getBoothAssistQuery({
    boothTranscript,
    interimTranscript: boothInterimTranscript,
  });
  const recentCueTexts = useMemo(
    () =>
      [
        generatedCue?.assist.text,
        latchedAssist.type !== 'none' ? latchedAssist.text : null,
        ...worldState.sessionMemory.surfacedAssists.slice(-3).map((entry) => entry.text),
      ].filter((value, index, collection): value is string => {
        return Boolean(value?.trim()) && collection.indexOf(value) === index;
      }),
    [generatedCue?.assist.text, latchedAssist.text, latchedAssist.type, worldState.sessionMemory.surfacedAssists],
  );
  const excludedCueTexts = useMemo(
    () =>
      deriveExcludedCueTexts({
        recentCueTexts,
        boothTranscript,
        interimTranscript: boothInterimTranscript,
        currentTimestampMs: getCurrentTranscriptTimestamp(),
      }),
    [boothInterimTranscript, boothTranscript, recentCueTexts],
  );
  const rankedBoothAssistFacts = rankBoothAssistFacts({
    facts: boothAssistFacts.filter((fact) => {
      const documentId = fact.metadata?.documentId;
      return !documentId || sessionGlobalContextIdSet.has(documentId);
    }),
    boothTranscript,
    interimTranscript: boothInterimTranscript,
    liveMatch: worldState.liveMatch,
    limit: 8,
  });
  const boothCueSignature = useMemo(() => {
    const normalizedQuery = boothAssistQuery.trim().toLowerCase();
    const factIds = rankedBoothAssistFacts.slice(0, 5).map(({ fact }) => fact.id);

    return JSON.stringify({
      query: normalizedQuery,
      factIds,
      excludedCueTexts,
    });
  }, [boothAssistQuery, excludedCueTexts, rankedBoothAssistFacts]);
  const preMatchCueSummary = useMemo(() => buildPreMatchCueSummary(worldState), [worldState]);
  const mergedContextDocuments = useMemo(
    () =>
      contextDocuments.map((document) => ({
        ...document,
        localEntry:
          localContextLibrary.find((entry) => entry.backendDocumentId === document.id) ??
          localContextLibrary.find((entry) => entry.fileName === document.fileName) ??
          null,
      })),
    [contextDocuments, localContextLibrary],
  );
  const visibleContextDocuments = useMemo(
    () => mergedContextDocuments.filter((document) => !hiddenContextDocumentIds.includes(document.id)),
    [hiddenContextDocumentIds, mergedContextDocuments],
  );
  const activeGlobalContextIds =
    sessionContextMode === 'inherit-global'
      ? visibleContextDocuments.map((document) => document.id)
      : sessionSelectedGlobalContextIds;
  const sessionGlobalContextDocs = visibleContextDocuments.filter((document) =>
    activeGlobalContextIds.includes(document.id),
  );
  const sessionAutoArtifacts = useMemo(
    () =>
      [
        preMatchCueSummary.trim()
          ? {
              id: 'auto-prematch',
              title: 'Pre-match brief',
              summary: safeTrimText(preMatchCueSummary, 220),
              text: preMatchCueSummary,
              scope: 'session-auto' as const,
            }
          : null,
        buildContextSummary(worldState).trim()
          ? {
              id: 'auto-live',
              title: 'Live brief',
              summary: safeTrimText(buildContextSummary(worldState), 220),
              text: buildContextSummary(worldState),
              scope: 'session-auto' as const,
            }
          : null,
      ].filter((artifact): artifact is {
        id: string;
        title: string;
        summary: string;
        text: string;
        scope: 'session-auto';
      } => Boolean(artifact)),
    [preMatchCueSummary, worldState],
  );
  const sessionContextSummary = mergeUniqueText([
    ...sessionAutoArtifacts.map((artifact) => artifact.text),
    ...sessionGlobalContextDocs.map((document) => document.localEntry?.text ?? document.fileName),
    ...sessionContextEntries.map((entry) => entry.text),
  ], 10).join(' | ');
  const sessionExpectedTopics = mergeUniqueText([
    ...buildExpectedTopics(worldState),
    ...sessionGlobalContextDocs.map((document) => document.localEntry?.fileName ?? document.fileName),
    ...sessionContextEntries.map((entry) => entry.fileName),
    ...sessionContextEntries.map((entry) => getLocalContextPreview(entry)),
  ], 12);
  const sessionGlobalContextIdSet = useMemo(
    () => new Set(sessionGlobalContextDocs.map((document) => document.id)),
    [sessionGlobalContextDocs],
  );
  const sessionContextPreviewItems = useMemo(
    () => [
      ...sessionAutoArtifacts.map((artifact) => ({
        id: artifact.id,
        title: artifact.title,
        summary: artifact.summary,
        kind: 'Auto',
      })),
      ...sessionGlobalContextDocs.map((document) => ({
        id: `global-${document.id}`,
        title: document.fileName,
        summary: document.localEntry
          ? getLocalContextPreview(document.localEntry)
          : 'Included from the global context library.',
        kind: 'Global',
      })),
      ...sessionContextEntries.map((entry) => ({
        id: entry.id,
        title: entry.fileName,
        summary: getLocalContextPreview(entry),
        kind: 'Session',
      })),
    ],
    [sessionAutoArtifacts, sessionGlobalContextDocs, sessionContextEntries],
  );
  const cueEngineStreams = useMemo(
    () => [
      {
        id: 'pre-match',
        title: 'Pre-match report',
        status: preMatchCueSummary ? 'Ready' : 'Waiting for fixture',
        items: preMatchCueSummary ? [safeTrimText(preMatchCueSummary, 200)] : [],
      },
      {
        id: 'live-match',
        title: 'Scoreboard state',
        status:
          worldState.liveStreamContext.scoreState.clock !== '00:00' ||
          worldState.liveMatch.stats.length > 0
            ? 'Live'
            : 'Idle',
        items: [
          `${worldState.liveMatch.homeTeam.name} ${worldState.liveStreamContext.scoreState.home}-${worldState.liveStreamContext.scoreState.away} ${worldState.liveMatch.awayTeam.name}`,
          worldState.liveStreamContext.scoreState.clock
            ? `Clock ${worldState.liveStreamContext.scoreState.clock}`
            : null,
          ...worldState.liveMatch.stats.slice(0, 2).map(
            (stat) => `${stat.label}: ${stat.teamSide} ${stat.value}`,
          ),
        ].filter(Boolean) as string[],
      },
      {
        id: 'recent-events',
        title: 'Event stream',
        status: worldState.recentEvents.length > 0 ? `${worldState.recentEvents.length} events` : 'Quiet',
        items: worldState.recentEvents.slice(0, 3).map((event) => event.description),
      },
      {
        id: 'vision',
        title: 'Vision stream',
        status: worldState.liveSignals.vision.length > 0 ? `${worldState.liveSignals.vision.length} cues` : 'Quiet',
        items: worldState.liveSignals.vision.slice(0, 3).map((cue) => cue.label),
      },
      {
        id: 'social',
        title: 'Social stream',
        status: worldState.liveSignals.social.length > 0 ? `${worldState.liveSignals.social.length} posts` : 'Quiet',
        items: worldState.liveSignals.social.slice(0, 3).map((post) => `${post.handle}: ${post.text}`),
      },
      {
        id: 'bundle',
        title: 'Match context bundle',
        status: worldState.contextBundle.items.length > 0 ? `${worldState.contextBundle.items.length} lanes` : 'Quiet',
        items: worldState.contextBundle.items.slice(0, 3).map((item) => item.headline),
      },
      {
        id: 'global-docs',
        title: 'Selected global docs',
        status: sessionGlobalContextDocs.length > 0 ? `${sessionGlobalContextDocs.length} included` : 'None included',
        items: sessionGlobalContextDocs.map((document) => document.fileName).slice(0, 4),
      },
      {
        id: 'session-additions',
        title: 'Session additions',
        status: sessionContextEntries.length > 0 ? `${sessionContextEntries.length} added` : 'None added',
        items: sessionContextEntries.map((entry) => entry.fileName).slice(0, 4),
      },
    ],
    [
      preMatchCueSummary,
      sessionContextEntries,
      sessionGlobalContextDocs,
      worldState.contextBundle.items,
      worldState.liveMatch.homeTeam.name,
      worldState.liveMatch.awayTeam.name,
      worldState.liveMatch.stats,
      worldState.liveSignals.social,
      worldState.liveSignals.vision,
      worldState.liveStreamContext.scoreState.away,
      worldState.liveStreamContext.scoreState.clock,
      worldState.liveStreamContext.scoreState.home,
      worldState.recentEvents,
    ],
  );
  const currentBoothFeatures = useMemo<BoothFeatureSnapshot>(
    () => ({
      timestamp: boothClockMs,
      hesitationScore: boothSignal.hesitationScore,
      confidenceScore: boothSignal.confidenceScore,
      pauseDurationMs: Math.round(boothSignal.pauseDurationMs),
      speechStreakMs: Math.round(boothSignal.speechStreakMs),
      silenceStreakMs: Math.round(boothSignal.silenceStreakMs),
      audioLevel: boothSignal.audioLevel,
      isSpeaking: boothSignal.isSpeaking,
      hasVoiceActivity: boothSignal.hasVoiceActivity,
      fillerCount: boothSignal.fillerCount,
      fillerDensity: boothSignal.fillerDensity,
      fillerWords: boothSignal.fillerWords,
      repeatedOpeningCount: boothSignal.repeatedOpeningCount,
      repeatedPhrases: boothSignal.repeatedPhrases,
      repeatedIdeaCount: boothSignal.repeatedIdeaCount,
      repeatedIdeaPhrases: boothSignal.repeatedIdeaPhrases,
      unfinishedPhrase: boothSignal.unfinishedPhrase,
      transcriptWordCount: boothSignal.transcriptWordCount,
      transcriptStabilityScore: boothSignal.transcriptStabilityScore,
      wordsPerMinute: boothSignal.wordsPerMinute,
      pacePressureScore: boothSignal.pacePressureScore,
      hesitationReasons: boothSignal.hesitationReasons,
      transcriptWindow: boothTranscript.slice(-LOCAL_TRANSCRIPT_LIMIT),
      interimTranscript: boothInterimTranscript,
      contextSummary: mergeUniqueText([
        buildContextSummary(worldState),
        sessionContextSummary,
      ], 10).join(' | '),
      expectedTopics: sessionExpectedTopics,
      wakePhraseDetected: boothSignal.wakePhraseDetected,
      previousState: boothInterpretation?.state,
    }),
    [
      boothClockMs,
      boothInterimTranscript,
      boothSignal.audioLevel,
      boothSignal.confidenceScore,
      boothSignal.fillerCount,
      boothSignal.fillerDensity,
      boothSignal.fillerWords,
      boothSignal.hasVoiceActivity,
      boothSignal.hesitationReasons,
      boothSignal.isSpeaking,
      boothSignal.pauseDurationMs,
      boothSignal.repeatedOpeningCount,
      boothSignal.repeatedPhrases,
      boothSignal.repeatedIdeaCount,
      boothSignal.repeatedIdeaPhrases,
      boothSignal.silenceStreakMs,
      boothSignal.speechStreakMs,
      boothSignal.transcriptStabilityScore,
      boothSignal.transcriptWordCount,
      boothSignal.unfinishedPhrase,
      boothSignal.wordsPerMinute,
      boothSignal.pacePressureScore,
      boothSignal.wakePhraseDetected,
      boothTranscript,
      boothInterpretation?.state,
      sessionContextSummary,
      sessionExpectedTopics,
      worldState,
    ],
  );
  const interpretedHesitationScore = boothInterpretation?.hesitationScore ?? 0;
  const interpretedRecoveryScore = boothInterpretation?.recoveryScore ?? 0;
  const {
    effectiveHesitationScore,
    effectiveRecoveryScore,
  } = resolveBoothGuidanceScores({
    localHesitationScore: boothSignal.hesitationScore,
    localConfidenceScore: boothSignal.confidenceScore,
    interpretedHesitationScore,
    interpretedRecoveryScore,
    interpretationState: boothInterpretation?.state,
  });
  const confidenceReason =
    boothInterpretation?.confidenceReason ??
    worldState.orchestration?.confidenceReason ??
    boothSignal.confidenceReasons[0] ??
    (effectiveRecoveryScore >= effectiveHesitationScore
      ? 'Confidence is recovering because the current delivery looks steadier than the hesitation spike.'
      : 'Confidence is still held down because hesitation signals outweigh the recovery signals.');
  const liveBoothShouldSurfaceAssist =
    boothSignal.shouldSurfaceAssist || Boolean(boothInterpretation?.shouldSurfaceAssist);
  const workerAssistShouldSurface =
    assist.type !== 'none' &&
    (controls.forceHesitation ||
      (!boothHasLiveInput && worldState.commentator.hesitationScore >= LIVE_HESITATION_GATE));
  const sidekickShouldSurface =
    boothHasLiveInput &&
    liveBoothShouldSurfaceAssist &&
    ((generatedCue?.assist.type ?? 'none') !== 'none' || boothAssist.type !== 'none');
  const nextTriggeredAssist = sidekickShouldSurface
    ? selectPreferredTriggeredAssist({
        localAssist: boothAssist,
        generatedAssist: generatedCue?.assist,
      })
    : workerAssistShouldSurface
      ? assist
      : null;
  const activeAssist = latchedAssist;
  const shouldSurfaceAssist = activeAssist.type !== 'none' && assistVisibilityPhase !== 'hidden';
  const isAssistWeaning = assistVisibilityPhase === 'weaning';
  const rhythmScore = Math.max(0, 1 - effectiveHesitationScore);
  const boothRhythmPercent = formatPercent(rhythmScore);
  const visibleReasons = [...(boothInterpretation?.reasons ?? []), ...boothSignal.hesitationReasons].filter(
    (reason, index, collection) => collection.indexOf(reason) === index,
  );
  const generationExplainability =
    generatedCue?.explainability ?? worldState.orchestration?.lastGeneration ?? null;
  const generationAgents = generationExplainability?.contributingAgents ?? [];
  const fixtureLinkBlocked =
    Boolean(boothError) &&
    /match linking|identify this match|fixture extraction|sportmonks_api_token|fixture resolution/i.test(
      boothError ?? '',
    );
  const cueGenerationBlocked =
    !isCueEndpointAvailable ||
    (Boolean(boothError) &&
      /generate-cue|prompt|cue|assist could not be generated|render is missing the \/booth\/generate-cue route/i.test(
        boothError ?? '',
      ));
  const liveAgents = mergeAgentRuns(
    [
      {
        agents: boothInterpretation?.explainability?.contributingAgents ?? [],
        origin: 'interpretation',
      },
      {
        agents: worldState.orchestration?.agentRuns ?? [],
        origin: 'orchestration',
      },
      {
        agents: generationExplainability?.contributingAgents ?? [],
        origin: 'generation',
      },
    ],
    {
      contextBlocked: fixtureLinkBlocked,
      cueBlocked: cueGenerationBlocked,
    },
  );
  const activeAgentNames = liveAgents
    .filter((agent) => agent.displayState === 'active' || agent.displayState === 'contributing')
    .map((agent) => agent.agentName);
  const coachingTone = getCoachingTone({
    hasStartedBroadcast,
    boothHasLiveInput,
    boothSignal: {
      ...boothSignal,
      hesitationScore: effectiveHesitationScore,
      confidenceScore: effectiveRecoveryScore,
    },
    shouldSurfaceAssist: shouldSurfaceAssist && !isAssistWeaning,
  });
  const readinessChecks = [
    {
      label: 'Clip loaded',
      done: Boolean(loadedClipUrl),
      detail: loadedClipUrl ? loadedClipName || 'Local replay is ready.' : 'Bring in a replay clip first.',
    },
    {
      label: 'Mic access',
      done: isMicPrepared,
      detail: isMicPrepared
        ? 'Microphone permission is ready for the live booth.'
        : isMicPreparing
          ? 'Requesting microphone access.'
          : 'AndOne will request access when you go live.',
    },
    {
      label: 'System linked',
      done: isSystemReady,
      detail: isSystemReady ? 'The hosted backend is reachable.' : 'Waiting for the backend connection.',
    },
  ];
  const isStandbyVoiceAvailable =
    standbyVoiceEnabled && standbyVoiceStatus === 'ready' && supportsSpeechSynthesis() && speechVoicesReady;
  const standbyVoiceStatusLabel =
    standbyVoiceStatus === 'ready' && (!supportsSpeechSynthesis() || !speechVoicesReady)
      ? 'Browser speech unavailable'
      : formatStandbyVoiceStatus(standbyVoiceStatus);
  const activeDeliverySourceLabel =
    activeDeliverySource === 'synthetic-standby' ? 'AndOne has the call' : 'You have the call';
  const isBroadcastLive =
    hasStartedBroadcast && (controls.playbackStatus === 'playing' || isMicListening);
  const selectedProgramSlot = PROGRAM_FEED_SLOTS.find((slot) => slot.id === selectedProgramFeedId) ?? null;
  const feedHeading = selectedProgramSlot
    ? selectedProgramSlot.source === 'upload'
      ? storedProgramFeeds[selectedProgramSlot.id]?.fileName
        ? `${selectedProgramSlot.label} · ${storedProgramFeeds[selectedProgramSlot.id]?.fileName}`
        : `${selectedProgramSlot.label} · Add input`
      : `${selectedProgramSlot.label} · ${selectedProgramSlot.presetFileName ?? loadedClipName}`
    : 'Select a program feed';
  const replayToastSignature = `${activeAssist.type}:${activeAssist.text}:${shouldSurfaceAssist}:${controls.restartToken}`;
  const activeTriggerBadges = [
    boothSignal.pauseDurationMs >= LONG_PAUSE_START_MS ? 'pause' : null,
    boothSignal.fillerCount > 0 ? 'filler' : null,
    boothSignal.repeatedOpeningCount > 0 ? 'repeat-start' : null,
    boothSignal.unfinishedPhrase ? 'unfinished' : null,
    boothSignal.wakePhraseDetected ? 'line' : null,
  ].filter(Boolean) as string[];
  const recentFillerWords = [...new Set(boothSignal.fillerWords.map((word) => word.toLowerCase()))].slice(-2);
  const monitoredSignals = [
    {
      label: 'Pause',
      detail: boothSignal.pauseDurationMs >= LONG_PAUSE_START_MS ? formatDurationMs(Math.round(boothSignal.pauseDurationMs)) : '--',
      active: boothSignal.pauseDurationMs >= LONG_PAUSE_START_MS,
    },
    {
      label: 'Fillers',
      detail:
        boothSignal.fillerCount > 0
          ? recentFillerWords.length > 0
            ? recentFillerWords.join(' · ')
            : `${boothSignal.fillerCount} hit${boothSignal.fillerCount === 1 ? '' : 's'}`
          : '--',
      active: boothSignal.fillerCount > 0,
    },
    {
      label: 'Repeat start',
      detail: boothSignal.repeatedOpeningCount > 0 ? `${boothSignal.repeatedOpeningCount}x` : '--',
      active: boothSignal.repeatedOpeningCount > 0,
    },
    {
      label: 'Unfinished line',
      detail: boothSignal.unfinishedPhrase ? 'Open phrase' : '--',
      active: boothSignal.unfinishedPhrase,
    },
    {
      label: 'Wake phrase',
      detail: boothSignal.wakePhraseDetected ? 'Line heard' : '--',
      active: boothSignal.wakePhraseDetected,
    },
  ];
  const standbySetupSummary =
    standbyVoiceStatus === 'ready'
      ? `A ${Math.round(standbyVoiceSampleDurationMs / 1000)}s handoff voice sample is ready.`
      : standbyVoiceStatus === 'recording'
        ? 'Capturing your handoff voice sample now.'
        : standbyVoiceStatus === 'processing'
          ? 'Preparing the handoff voice from your sample.'
          : standbyVoiceStatus === 'failed'
            ? 'The last handoff voice sample did not complete cleanly. Capture a fresh one in Sidekick Console.'
            : 'Prepare a handoff voice sample in Sidekick Console before using booth handoff on the live desk.';
  const liveActivityHeadline =
    activeAgentNames.length > 0
      ? `${activeAgentNames.length} live stream${activeAgentNames.length === 1 ? '' : 's'} are shaping this beat`
      : 'No live stream is shaping the current beat';
  const cueAssemblyHeadline =
    generationExplainability
      ? generationAgents.length > 0
        ? `${generationAgents.length} stream${generationAgents.length === 1 ? '' : 's'} shaped this cue`
        : 'Cue reasoning is active for the current line'
      : 'No cue stream is shaping a line right now';
  const cueAssemblySummary = generationExplainability?.reasoningTrace[0] ?? null;
  const cueAssemblySupportCopy = generationExplainability
    ? generationExplainability.sourcesUsed.length > 0
      ? `${generationExplainability.sourcesUsed.length} grounded source${generationExplainability.sourcesUsed.length === 1 ? '' : 's'} fed this cue.`
      : 'The cue leaned on live booth state because explicit retrieval facts were thin.'
    : 'When a grounded cue appears, the streams and source facts behind it will show here.';
  const primaryActionLabel = isFinalizingSession
    ? 'Saving session...'
    : isBroadcastLive
      ? 'End live session'
      : 'Go live';
  const primaryActionDisabled =
    isFinalizingSession || (!isBroadcastLive && (!isBroadcastReady || isUpdatingControls || !isSystemReady || isUploadingContext));
  const hasStartedMonitoring = hasStartedBroadcast;
  const activeAssistSupportCopy = isAssistWeaning
    ? 'Confidence is returning. AndOne is backing off.'
    : activeAssist.whyNow;
  const transcriptWindow = boothTranscript.slice(-4);
  const assistSourceSummary = activeAssist.sourceChips
    .slice(0, 4)
    .map((chip) => chip.source.replace(/^[^:]+:/, ''))
    .join(' · ');
  const assistTraceLines = [
    `Rhythm ${boothRhythmPercent}${boothSignal.wordsPerMinute > 0 ? ` · ${Math.round(boothSignal.wordsPerMinute)} WPM` : ''}`,
    worldState.recentEvents[worldState.recentEvents.length - 1]
      ? `Live event · ${worldState.recentEvents[worldState.recentEvents.length - 1]?.description}`
      : null,
    worldState.liveSignals.social[worldState.liveSignals.social.length - 1]
      ? `Social pulse · ${worldState.liveSignals.social[worldState.liveSignals.social.length - 1]?.text}`
      : null,
    worldState.liveSignals.vision[worldState.liveSignals.vision.length - 1]
      ? `Vision cue · ${worldState.liveSignals.vision[worldState.liveSignals.vision.length - 1]?.label}`
      : null,
  ].filter((value): value is string => Boolean(value));
  const cueSource =
    shouldSurfaceAssist
      ? generatedCue
        ? generatedCue.source === 'openai'
          ? 'openai'
          : 'local'
        : workerAssistShouldSurface
          ? 'worker'
          : 'local'
      : 'none';
  const railSystemNote = isAssistWeaning
    ? 'Flow is restored. The Sidekick is receding so you can resume lead of the broadcast.'
    : activeDeliverySource === 'synthetic-standby'
      ? 'The Sidekick is bridging the gap while your live mic stays off-air.'
    : shouldSurfaceAssist
      ? 'Anticipating hesitation. Use the grounded assist to unblock your delivery rhythm.'
      : boothHasLiveInput
        ? 'The Sidekick is watching silently. No assist needed while you are in flow.'
        : 'Feed and microphone are ready. The Sidekick starts once you begin calling the action.';
  const overviewCopy = hasStartedMonitoring
    ? railSystemNote
    : 'AndOne stays silent while you’re in rhythm, surfaces a cue when it senses hesitation, then fades once you’re back in flow.';
  const overviewReason = hasStartedMonitoring
    ? visibleReasons[0] ?? confidenceReason
    : '';
  const assistStateLabel = shouldSurfaceAssist
    ? isAssistWeaning
      ? 'Receding'
      : 'Assisting'
    : coachingTone.tone === 'steady'
      ? 'Watching'
      : 'Silent';
  const overviewBadgeLabel = hasStartedMonitoring ? assistStateLabel : 'Idle';
  const overviewHesitationLabel = hasStartedMonitoring ? formatPercent(effectiveHesitationScore) : '--';
  const overviewRecoveryLabel = hasStartedMonitoring ? formatPercent(effectiveRecoveryScore) : '--';
  const overviewHesitationWidth = hasStartedMonitoring ? `${Math.round(effectiveHesitationScore * 100)}%` : '0%';
  const overviewRecoveryWidth = hasStartedMonitoring ? `${Math.round(effectiveRecoveryScore * 100)}%` : '0%';
  const overviewInputLabel = hasStartedMonitoring ? assistStateLabel : '--';
  const overviewInputWidth = hasStartedMonitoring
    ? `${Math.max(boothSignal.audioLevel * 100, 3)}%`
    : '0%';
  const activeSessionContextCount =
    sessionAutoArtifacts.length + sessionGlobalContextDocs.length + sessionContextEntries.length;
  const stageContextOverlayLabel =
    activeSessionContextCount > 0
      ? `${activeSessionContextCount} context ${activeSessionContextCount === 1 ? 'item' : 'items'} loaded`
      : null;
  const stageDeliveryOverlayLabel =
    activeDeliverySource === 'synthetic-standby' ? 'AndOne has the call' : null;
  const standbyToggleDirection = activeDeliverySource === 'synthetic-standby' ? 'sub_back' : 'sub_in';
  const standbyToggleLabel =
    activeDeliverySource === 'synthetic-standby' ? 'Take the call back' : 'Hand off to AndOne';
  const standbyToggleDisabled =
    activeDeliverySource === 'synthetic-standby'
      ? !isBroadcastLive
      : !isBroadcastLive || !isStandbyVoiceAvailable;
  useEffect(() => {
    if (activeSessionContextCount === 0) {
      setIsStageContextOpen(false);
    }
  }, [activeSessionContextCount]);
  const postSessionReview = derivePostSessionReview(latestCompletedSession);
  const completedReviewSessions = useMemo(
    () =>
      recentBoothSessions
        .filter((session) => session.status === 'completed')
        .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt)),
    [recentBoothSessions],
  );
  const activeSavedSessions = useMemo(
    () => recentBoothSessions.filter((session) => session.status === 'active'),
    [recentBoothSessions],
  );
  const completedReviewAnalytics = useMemo(() => {
    if (completedReviewSessions.length === 0) {
      return {
        totalSessions: 0,
        totalPrompts: 0,
        averagePeakHesitation: 0,
        averageLongestPauseMs: 0,
      };
    }

    return {
      totalSessions: completedReviewSessions.length,
      totalPrompts: completedReviewSessions.reduce((total, session) => total + session.assistCount, 0),
      averagePeakHesitation:
        completedReviewSessions.reduce((total, session) => total + session.maxHesitationScore, 0) /
        completedReviewSessions.length,
      averageLongestPauseMs:
        completedReviewSessions.reduce((total, session) => total + session.longestPauseMs, 0) /
        completedReviewSessions.length,
    };
  }, [completedReviewSessions]);
  const sessionWorkspaceInsights = deriveSessionWorkspaceInsights(completedReviewSessions);
  const reviewStatusLabel = isLoadingReview
    ? 'Analyzing'
    : latestCompletedSessionReview
      ? 'AI analysis ready'
      : latestCompletedSession
        ? 'Saved trace ready'
        : 'Standby';
  const speakerHasRecovered = hasRecoveredFromAssistEpisode({
    isSpeaking: boothSignal.isSpeaking,
    speechStreakMs: boothSignal.speechStreakMs,
    effectiveRecoveryScore,
    effectiveHesitationScore,
    interpretationState: boothInterpretation?.state,
  });

  useEffect(() => {
    if (!import.meta.env.DEV || !hasStartedBroadcast || !shouldSurfaceAssist) {
      return;
    }

    console.debug('booth-assist-visible', {
      source: generatedCue?.assist.text === activeAssist.text ? 'model' : 'local',
      query: boothAssistQuery,
      activeAssist: activeAssist.text,
      topFactSources: rankedBoothAssistFacts.slice(0, 3).map(({ fact }) => fact.source),
      hasRealFacts: boothAssistFacts.length > 0,
      hasTranscriptContext: boothHasTranscriptContext,
    });
  }, [
    activeAssist.text,
    boothAssistFacts.length,
    boothAssistQuery,
    boothHasTranscriptContext,
    generatedCue?.assist.text,
    hasStartedBroadcast,
    rankedBoothAssistFacts,
    shouldSurfaceAssist,
  ]);

  useEffect(() => {
    if (!hasStartedBroadcast) {
      if (isAssistEpisodeActive) {
        setIsAssistEpisodeActive(false);
      }
      if (assistEpisodeId !== 0) {
        setAssistEpisodeId(0);
      }
      return;
    }

    if (!isAssistEpisodeActive && liveBoothShouldSurfaceAssist) {
      setIsAssistEpisodeActive(true);
      setAssistEpisodeId((current) => current + 1);
      return;
    }

    if (isAssistEpisodeActive && speakerHasRecovered) {
      const timeoutId = window.setTimeout(() => {
        setIsAssistEpisodeActive(false);
      }, MIN_RECOVERY_COMMIT_MS);

      return () => {
        window.clearTimeout(timeoutId);
      };
    }
  }, [
    assistEpisodeId,
    hasStartedBroadcast,
    isAssistEpisodeActive,
    liveBoothShouldSurfaceAssist,
    speakerHasRecovered,
  ]);

  useEffect(() => {
    if (!hasStartedBroadcast) {
      if (latchedAssist.type !== 'none') {
        setLatchedAssist(createEmptyAssistCard());
      }
      if (assistVisibilityPhase !== 'hidden') {
        setAssistVisibilityPhase('hidden');
      }
      if (assistLockExpiresAt !== 0) {
        setAssistLockExpiresAt(0);
      }
      if (latchedAssistEpisodeId !== 0) {
        setLatchedAssistEpisodeId(0);
      }
      return;
    }

    const now = Date.now();
    const hasLatchedAssist = latchedAssist.type !== 'none';
    const assistIsLocked = shouldHoldLockedAssist({
      currentAssist: latchedAssist,
      nextAssist: nextTriggeredAssist,
      assistLockExpiresAt,
      nowMs: now,
    });
    const assistChanged = nextTriggeredAssist
      ? !areAssistCardsEquivalent(latchedAssist, nextTriggeredAssist)
      : false;
    const enteringNewEpisode =
      nextTriggeredAssist !== null &&
      assistEpisodeId > 0 &&
      latchedAssistEpisodeId !== assistEpisodeId;

    if (nextTriggeredAssist && !hasLatchedAssist) {
      setLatchedAssist(nextTriggeredAssist);
      setLatchedAssistEpisodeId(assistEpisodeId);
      setAssistVisibilityPhase('live');
      setAssistLockExpiresAt(now + MIN_ASSIST_DISPLAY_MS);
      return;
    }

    if (
      nextTriggeredAssist !== null &&
      hasLatchedAssist &&
      enteringNewEpisode &&
      !assistIsLocked
    ) {
      setLatchedAssist(nextTriggeredAssist);
      setLatchedAssistEpisodeId(assistEpisodeId);
      setAssistVisibilityPhase('live');
      setAssistLockExpiresAt(now + MIN_ASSIST_DISPLAY_MS);
      return;
    }

    if (
      nextTriggeredAssist !== null &&
      hasLatchedAssist &&
      !assistChanged &&
      assistVisibilityPhase !== 'live'
    ) {
      setAssistVisibilityPhase('live');
      return;
    }

    if (
      speakerHasRecovered &&
      hasLatchedAssist &&
      !assistIsLocked
    ) {
      setAssistVisibilityPhase((current) => (current === 'hidden' ? 'hidden' : 'weaning'));
      return;
    }

    if (
      !nextTriggeredAssist &&
      hasLatchedAssist &&
      !assistIsLocked &&
      !isAssistEpisodeActive
    ) {
      setAssistVisibilityPhase((current) => (current === 'hidden' ? 'hidden' : 'weaning'));
    }
  }, [
    assistLockExpiresAt,
    assistEpisodeId,
    assistVisibilityPhase,
    hasStartedBroadcast,
    isAssistEpisodeActive,
    latchedAssist.text,
    latchedAssistEpisodeId,
    latchedAssist.type,
    latchedAssist.whyNow,
    nextTriggeredAssist,
    speakerHasRecovered,
  ]);

  useEffect(() => {
    if (assistVisibilityPhase !== 'weaning') {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setAssistVisibilityPhase('hidden');
      setLatchedAssist(createEmptyAssistCard());
    }, ASSIST_WEAN_OFF_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [assistVisibilityPhase]);

  const lastGeneratedCueSignatureRef = useRef('');

  useEffect(() => {
    if (
      !hasStartedBroadcast ||
      !boothHasLiveInput ||
      !boothHasTranscriptContext ||
      !liveBoothShouldSurfaceAssist ||
      boothInterpretation?.state === 'weaning-off'
    ) {
      lastGeneratedCueSignatureRef.current = '';
      return;
    }

    if (!boothCueSignature) {
      return;
    }

    if (lastGeneratedCueSignatureRef.current === '') {
      lastGeneratedCueSignatureRef.current = boothCueSignature;
      return;
    }

    if (lastGeneratedCueSignatureRef.current === boothCueSignature) {
      return;
    }

    lastGeneratedCueSignatureRef.current = boothCueSignature;

    if (generatedCue) {
      setGeneratedCue(null);
    }

    if (generatedCueRequestedAt !== 0) {
      setGeneratedCueRequestedAt(0);
    }
  }, [
    boothCueSignature,
    boothHasLiveInput,
    boothHasTranscriptContext,
    boothInterpretation?.state,
    generatedCue,
    generatedCueRequestedAt,
    hasStartedBroadcast,
    liveBoothShouldSurfaceAssist,
  ]);

  useEffect(() => {
    if (!hasStartedBroadcast) {
      if (speechStreakStartedAtMs !== -1) {
        setSpeechStreakStartedAtMs(-1);
      }
      if (silenceStreakStartedAtMs !== -1) {
        setSilenceStreakStartedAtMs(-1);
      }
      return;
    }

    if (boothActivity.isSpeaking) {
      if (speechStreakStartedAtMs === -1) {
        setSpeechStreakStartedAtMs(boothClockMs);
      }
      if (silenceStreakStartedAtMs !== -1) {
        setSilenceStreakStartedAtMs(-1);
      }
      return;
    }

    if (boothActivity.lastActivityAtMs >= 0) {
      if (speechStreakStartedAtMs !== -1) {
        setSpeechStreakStartedAtMs(-1);
      }
      if (silenceStreakStartedAtMs === -1) {
        setSilenceStreakStartedAtMs(boothActivity.lastActivityAtMs);
      }
      return;
    }

    if (speechStreakStartedAtMs !== -1) {
      setSpeechStreakStartedAtMs(-1);
    }
    if (silenceStreakStartedAtMs !== -1) {
      setSilenceStreakStartedAtMs(-1);
    }
  }, [
    boothActivity.isSpeaking,
    boothActivity.lastActivityAtMs,
    boothClockMs,
    hasStartedBroadcast,
    silenceStreakStartedAtMs,
    speechStreakStartedAtMs,
  ]);

  useEffect(() => {
    if (!hasStartedBroadcast || !activeBoothSessionId) {
      return;
    }

    const sampleTimestamp = Math.floor(Date.now() / 1_000) * 1_000;
    if (lastPersistedSampleAtRef.current === sampleTimestamp) {
      return;
    }

    lastPersistedSampleAtRef.current = sampleTimestamp;

    void appendBoothSessionSample(activeBoothSessionId, {
      timestamp: sampleTimestamp,
      hesitationScore: effectiveHesitationScore,
      confidenceScore: effectiveRecoveryScore,
      pauseDurationMs: boothSignal.pauseDurationMs,
      audioLevel: boothSignal.audioLevel,
      isSpeaking: boothSignal.isSpeaking,
      triggerBadges: activeTriggerBadges,
      activeAssistText: shouldSurfaceAssist ? activeAssist.text : null,
      featureSnapshot: {
        ...currentBoothFeatures,
        hesitationScore: effectiveHesitationScore,
        confidenceScore: effectiveRecoveryScore,
      },
      interpretation: boothInterpretation ?? undefined,
    }).catch(() => {
      setBoothError('Live booth metrics could not be saved to the local store.');
    });
  }, [
    activeAssist.text,
    activeBoothSessionId,
    activeTriggerBadges,
    boothClockMs,
    boothInterimTranscript,
    boothSignal.audioLevel,
    boothSignal.confidenceScore,
    boothSignal.hesitationScore,
    boothSignal.isSpeaking,
    boothSignal.pauseDurationMs,
    boothSignal.fillerCount,
    boothSignal.fillerDensity,
    boothSignal.fillerWords,
    boothSignal.hasVoiceActivity,
    boothSignal.hesitationReasons,
    boothSignal.repeatedOpeningCount,
    boothSignal.repeatedPhrases,
    boothSignal.silenceStreakMs,
    boothSignal.speechStreakMs,
    boothSignal.transcriptStabilityScore,
    boothSignal.transcriptWordCount,
    boothSignal.unfinishedPhrase,
    boothTranscript,
    currentBoothFeatures,
    effectiveHesitationScore,
    effectiveRecoveryScore,
    boothInterpretation?.hesitationScore,
    boothInterpretation?.recoveryScore,
    boothInterpretation?.state,
    boothInterpretation,
    hasStartedBroadcast,
    shouldSurfaceAssist,
    worldState,
  ]);

  useEffect(() => {
    if (!hasStartedBroadcast || !isMicListening) {
      setBoothInterpretation(null);
      return;
    }

    if (boothSignal.confidenceScore >= 0.68 && boothSignal.hesitationScore <= 0.18) {
      setBoothInterpretation((current) =>
        current?.state === 'weaning-off' ? current : null,
      );
      return;
    }

    const hasTranscriptContext =
      boothTranscript.length > 0 ||
      boothInterimTranscript.trim().length > 0 ||
      boothSignal.pauseDurationMs >= LONG_PAUSE_START_MS;

    if (!hasTranscriptContext) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void interpretBooth(currentBoothFeatures)
        .then((nextInterpretation) => {
          setBoothInterpretation(nextInterpretation);
          setBoothError(null);
        })
        .catch(() => {
          setBoothInterpretation(null);
          setBoothError('Live booth interpretation failed.');
        });
    }, 900);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    boothClockMs,
    boothInterimTranscript,
    boothSignal.audioLevel,
    boothSignal.confidenceScore,
    boothSignal.fillerCount,
    boothSignal.fillerDensity,
    boothSignal.fillerWords,
    boothSignal.hasVoiceActivity,
    boothSignal.hesitationReasons,
    boothSignal.hesitationScore,
    boothSignal.isSpeaking,
    boothSignal.pauseDurationMs,
    boothSignal.repeatedOpeningCount,
    boothSignal.repeatedPhrases,
    boothSignal.silenceStreakMs,
    boothSignal.speechStreakMs,
    boothSignal.transcriptStabilityScore,
      boothSignal.transcriptWordCount,
    boothSignal.unfinishedPhrase,
    boothTranscript,
    currentBoothFeatures,
    worldState,
    hasStartedBroadcast,
    isMicListening,
    boothInterpretation?.state,
  ]);

  useEffect(() => {
    if (
      !hasStartedBroadcast ||
      !boothHasLiveInput ||
      !isCueEndpointAvailable ||
      !liveBoothShouldSurfaceAssist ||
      boothInterpretation?.state === 'weaning-off' ||
      speakerHasRecovered
    ) {
      if (generatedCue) {
        setGeneratedCue(null);
      }
      if (generatedCueRequestedAt !== 0) {
        setGeneratedCueRequestedAt(0);
      }
      return;
    }

    const elapsedMs = generatedCueRequestedAt > 0 ? Date.now() - generatedCueRequestedAt : Infinity;
    const retryBlockedForMs = Math.max(0, cueRetryBlockedUntilRef.current - Date.now());
    const waitMs =
      retryBlockedForMs > 0
        ? retryBlockedForMs
        : generatedCue && elapsedMs < generatedCue.refreshAfterMs
          ? Math.max(0, generatedCue.refreshAfterMs - elapsedMs)
          : 0;

    const timeoutId = window.setTimeout(() => {
      setGeneratedCueRequestedAt(Date.now());

      void generateBoothCue({
        features: currentBoothFeatures,
        interpretation: boothInterpretation ?? undefined,
        retrieval: {
          ...worldState.retrieval,
          query: boothAssistQuery || worldState.retrieval.query,
          supportingFacts: rankedBoothAssistFacts.map(({ fact }) => fact),
        },
        preMatch: worldState.preMatch,
        liveMatch: worldState.liveMatch,
        contextBundle: worldState.contextBundle,
        liveStreamContext: worldState.liveStreamContext,
        recentEvents: worldState.recentEvents.slice(-4),
        liveSignals: worldState.liveSignals,
        agentWeights: worldState.orchestration?.agentWeights,
        clipName: loadedClipName,
        contextSummary: currentBoothFeatures.contextSummary,
        preMatchSummary: preMatchCueSummary,
        expectedTopics: currentBoothFeatures.expectedTopics,
        recentCueTexts,
        excludedCueTexts,
      })
        .then((nextCue) => {
          cueRetryBlockedUntilRef.current = 0;
          if (nextCue.assist.type !== 'none' && nextCue.assist.text.trim()) {
            setGeneratedCue(nextCue);
          }
        })
        .catch((error) => {
          if (isMissingApiRouteError(error, '/booth/generate-cue')) {
            setIsCueEndpointAvailable(false);
            setBoothError('Render is missing the /booth/generate-cue route. Redeploy the API service.');
            return;
          }

          cueRetryBlockedUntilRef.current = Date.now() + GENERATE_CUE_FAILURE_BACKOFF_MS;
        });
    }, waitMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    boothHasLiveInput,
    boothHasTranscriptContext,
    boothInterpretation,
    currentBoothFeatures,
    excludedCueTexts,
    generatedCue,
    generatedCueRequestedAt,
    hasStartedBroadcast,
    isCueEndpointAvailable,
    latchedAssist.text,
    latchedAssist.type,
    liveBoothShouldSurfaceAssist,
    loadedClipName,
    boothAssistQuery,
    boothCueSignature,
    rankedBoothAssistFacts,
    preMatchCueSummary,
    recentCueTexts,
    speakerHasRecovered,
    worldState.contextBundle,
    worldState.liveStreamContext,
    worldState.orchestration?.agentWeights,
    worldState.recentEvents,
    worldState.retrieval,
    worldState.sessionMemory.surfacedAssists,
  ]);

  useEffect(() => {
    if (!hasStartedBroadcast || handoffState !== 'subbed_in' || activeDeliverySource !== 'synthetic-standby') {
      return;
    }

    if (isSyntheticSpeaking) {
      return;
    }

    const spokenCueTexts = spokenSyntheticCueTextsRef.current;
    const hasSpokenCue = (text: string) =>
      spokenCueTexts.some((spoken) => spoken.trim().toLowerCase() === text.trim().toLowerCase());

    const liveCueText =
      subbedCue?.assist.type !== 'none' && subbedCue?.assist.text.trim()
        ? subbedCue.assist.text.trim()
        : generatedCue?.assist.type !== 'none' && generatedCue?.assist.text.trim()
          ? generatedCue.assist.text.trim()
          : activeAssist.type !== 'none' && activeAssist.text.trim()
            ? activeAssist.text.trim()
            : null;

    if (liveCueText && !hasSpokenCue(liveCueText)) {
      spokenSyntheticCueTextsRef.current = [...spokenSyntheticCueTextsRef.current, liveCueText].slice(-8);
      speakStandbyNarration(liveCueText);
      return;
    }

    const fallbackNarration = buildStandbyFallbackText();
    if (fallbackNarration && !hasSpokenCue(fallbackNarration)) {
      spokenSyntheticCueTextsRef.current = [...spokenSyntheticCueTextsRef.current, fallbackNarration].slice(-8);
      speakStandbyNarration(fallbackNarration);
      return;
    }

    const elapsedMs = subbedCueRequestedAt > 0 ? Date.now() - subbedCueRequestedAt : Infinity;
    const retryBlockedForMs = Math.max(0, subbedCueRetryBlockedUntilRef.current - Date.now());
    const waitMs =
      retryBlockedForMs > 0
        ? retryBlockedForMs
        : subbedCue && elapsedMs < subbedCue.refreshAfterMs
          ? Math.max(0, subbedCue.refreshAfterMs - elapsedMs)
          : SUBBED_CUE_FLOOR_MS;

    const timeoutId = window.setTimeout(() => {
      setSubbedCueRequestedAt(Date.now());

      void generateBoothCue({
        features: currentBoothFeatures,
        interpretation: boothInterpretation ?? undefined,
        retrieval: {
          ...worldState.retrieval,
          query: boothAssistQuery || worldState.retrieval.query,
          supportingFacts: rankedBoothAssistFacts.map(({ fact }) => fact),
        },
        liveMatch: worldState.liveMatch,
        contextBundle: worldState.contextBundle,
        liveStreamContext: worldState.liveStreamContext,
        recentEvents: worldState.recentEvents.slice(-4),
        liveSignals: worldState.liveSignals,
        agentWeights: worldState.orchestration?.agentWeights,
        clipName: loadedClipName,
        contextSummary: currentBoothFeatures.contextSummary,
        preMatchSummary: preMatchCueSummary,
        expectedTopics: currentBoothFeatures.expectedTopics,
        recentCueTexts: [...recentCueTexts, ...spokenSyntheticCueTextsRef.current].slice(-8),
        excludedCueTexts: [...excludedCueTexts, ...spokenSyntheticCueTextsRef.current].slice(-12),
      })
        .then((nextCue) => {
          subbedCueRetryBlockedUntilRef.current = 0;
          if (nextCue.assist.type !== 'none' && nextCue.assist.text.trim()) {
            setSubbedCue(nextCue);
          }
        })
        .catch(() => {
          subbedCueRetryBlockedUntilRef.current = Date.now() + GENERATE_CUE_FAILURE_BACKOFF_MS;
        });
    }, waitMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    activeAssist,
    activeDeliverySource,
    boothAssistQuery,
    boothInterpretation,
    cueGenerationBlocked,
    currentBoothFeatures,
    excludedCueTexts,
    generatedCue,
    handoffState,
    hasStartedBroadcast,
    isSyntheticSpeaking,
    loadedClipName,
    preMatchCueSummary,
    rankedBoothAssistFacts,
    recentCueTexts,
    subbedCue,
    subbedCueRequestedAt,
    worldState.contextBundle,
    worldState.liveMatch,
    worldState.liveSignals,
    worldState.liveStreamContext,
    worldState.orchestration?.agentWeights,
    worldState.recentEvents,
    worldState.retrieval,
  ]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__brand">
          <div className="brand-mark" aria-hidden="true" onClick={() => navigateToRoute('live-desk')}>
            <span className="brand-mark__dot" />
            <span className="brand-mark__text">AndOne</span>
          </div>
        </div>

        <nav className="header-actions">
          {appRoute === 'live-desk' ? (
            <div className="desk-status-strip" aria-label="Desk readiness">
              {readinessChecks.map((check) => (
                <div
                  key={check.label}
                  className={`desk-status-item ${check.done ? 'desk-status-item--done' : ''}`}
                  title={check.detail}
                >
                  <span className={`readiness-dot ${check.done ? 'readiness-dot--done' : ''}`} />
                  <span>{check.label}</span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="view-switcher" role="tablist" aria-label="App navigation">
            <button
              type="button"
              role="tab"
              aria-selected={appRoute === 'live-desk'}
              className={appRoute === 'live-desk' ? 'ghost-button ghost-button--active' : 'ghost-button'}
              onClick={() => navigateToRoute('live-desk')}
            >
              Live Desk
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={appRoute === 'analyze'}
              className={appRoute === 'analyze' ? 'ghost-button ghost-button--active' : 'ghost-button'}
              onClick={() => navigateToRoute('analyze')}
            >
              Analyze
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={appRoute === 'sidekick-console'}
              className={appRoute === 'sidekick-console' ? 'ghost-button ghost-button--active' : 'ghost-button'}
              onClick={() => navigateToRoute('sidekick-console')}
            >
              Sidekick Console
            </button>
          </div>
        </nav>
      </header>

      {error ? <div className="warning-banner">{error}</div> : null}

      {appRoute === 'live-desk' ? (
        <>
          <section className="panel live-toolbar">
            <div className="program-toolbar">
              <div className="program-toolbar__group" role="tablist" aria-label="Program feeds">
                {PROGRAM_FEED_SLOTS.map((slot) => {
                  const feed = storedProgramFeeds[slot.id];
                  const isSelected = selectedProgramFeedId === slot.id;

                  return (
                    <button
                      key={slot.id}
                      type="button"
                      role="tab"
                      aria-selected={isSelected}
                      className={`program-pill ${isSelected ? 'program-pill--active' : ''}`}
                      onClick={() => {
                        if (slot.source === 'preset') {
                          void loadProgramFeed(slot.id, {
                            slotId: slot.id,
                            fileName: slot.presetFileName ?? slot.label,
                            fileSize: 0,
                            updatedAt: '',
                            blob: new Blob(),
                          });
                          return;
                        }

                        if (feed) {
                          void loadProgramFeed(slot.id, feed);
                          return;
                        }

                        setSelectedProgramFeedId(slot.id);
                        setBoothError(null);
                        channel3InputRef.current?.click();
                      }}
                    >
                      <span>{slot.label}</span>
                      <small>
                        {slot.source === 'preset'
                          ? slot.presetFileName
                          : feed?.fileName ?? 'Add input'}
                      </small>
                    </button>
                  );
                })}
              </div>

              <div className="program-toolbar__actions">
                <input
                  ref={channel3InputRef}
                  type="file"
                  accept="video/*"
                  className="sr-only-input"
                  onChange={(event) => void handleProgramFeedChange('program-c', event)}
                />
                {selectedProgramSlot?.source === 'upload' && storedProgramFeeds[selectedProgramSlot.id] ? (
                  <label className="file-chip ghost-button">
                    <span>Replace Channel 3 input</span>
                    <input
                      type="file"
                      accept="video/*"
                      onChange={(event) => void handleProgramFeedChange('program-c', event)}
                    />
                  </label>
                ) : null}
                {selectedProgramSlot?.source === 'upload' ? (
                  <>
                    {storedProgramFeeds[selectedProgramSlot.id] ? (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => void clearProgramFeedSlot(selectedProgramSlot.id)}
                      >
                        Clear
                      </button>
                    ) : null}
                  </>
                ) : null}
                {loadedClipUrl ? (
                  <button
                    type="button"
                    className="ghost-button ghost-button--subtle"
                    onClick={() => setIsClipMuted((current) => !current)}
                  >
                    {isClipMuted ? 'Feed audio off' : 'Feed audio on'}
                  </button>
                ) : null}
              </div>
            </div>
          </section>

          <div className="main-grid main-grid--live">
            <section className="panel replay-panel stage-panel">
              <div className="panel-header panel-header--stage">
                <div>
                  <h2 className="stage-title">{feedHeading}</h2>
                </div>
                <div className="panel-chip-row">
                  <span className="panel-tag">{loadedClipUrl ? 'Feed active' : 'No feed live'}</span>
                  <span className="panel-tag">{cueSource === 'none' ? 'Monitoring only' : `Cue via ${cueSource}`}</span>
                </div>
              </div>

              <div className="stage-primary-bar">
                <button
                  type="button"
                  className={`stage-primary-button ${isBroadcastLive ? 'stage-primary-button--live' : ''}`}
                  disabled={primaryActionDisabled}
                  onClick={() => void (isBroadcastLive ? stopBroadcast() : startBroadcast())}
                >
                  {primaryActionLabel}
                </button>
                <p className="stage-primary-copy">
                  {isFinalizingSession
                    ? 'Saving the session and building the analysis.'
                    : loadedClipUrl
                      ? isBroadcastLive
                        ? 'The desk is live. AndOne stays silent while you’re in rhythm, only surfacing cues when it senses hesitation.'
                        : !isSystemReady || isUploadingContext
                          ? 'The feed is loaded. AndOne is still arming the backend or context before the session can start.'
                          : 'The feed is loaded and muted. Go live when you are ready.'
                      : 'Pick a preset above or add an input to Channel 3.'}
                </p>
              </div>

              <div className={`replay-stage ${loadedClipUrl ? 'replay-stage--video' : ''}`}>
                {loadedClipUrl ? (
                  <video
                    ref={videoRef}
                    className="replay-video"
                    src={loadedClipUrl}
                    crossOrigin="anonymous"
                    playsInline
                    loop
                    muted={isClipMuted}
                    onLoadedMetadata={(event) => {
                      setClipDurationMs(Math.round(event.currentTarget.duration * 1_000));
                    }}
                    onEnded={(event) => {
                      if (!hasStartedBroadcast || controls.playbackStatus !== 'playing') {
                        return;
                      }

                      event.currentTarget.currentTime = 0;
                      safelyPlayVideo(event.currentTarget, () => {
                        setBoothError('Press play on the loaded clip if the browser blocks autoplay.');
                      });
                    }}
                    onError={() => {
                      setBoothError('The selected video feed could not be loaded. Try the other channel or reload the input.');
                    }}
                  />
                ) : (
                  <div className="replay-stage__scrim" />
                )}

                <div className="replay-stage__overlay" />

                <div className="replay-stage__content">
                  {stageDeliveryOverlayLabel ? (
                    <div className="stage-delivery-chip" aria-label="Delivery mode">
                      {stageDeliveryOverlayLabel}
                    </div>
                  ) : null}

                  {stageContextOverlayLabel ? (
                    <div
                      className={`stage-context-overlay ${isStageContextOpen ? 'stage-context-overlay--open' : ''}`}
                      onMouseEnter={() => setIsStageContextOpen(true)}
                      onMouseLeave={() => setIsStageContextOpen(false)}
                    >
                      <button
                        type="button"
                        className="stage-context-chip"
                        aria-label="Session context loaded"
                        aria-expanded={isStageContextOpen}
                        aria-controls="stage-context-popover"
                        onClick={() => setIsStageContextOpen((current) => !current)}
                      >
                        {stageContextOverlayLabel}
                      </button>

                      {isStageContextOpen ? (
                        <div className="stage-context-popover" id="stage-context-popover">
                          <p className="stage-context-popover__title">Loaded for this session</p>
                          <div className="stage-context-popover__list">
                            {sessionContextPreviewItems.slice(0, 6).map((item) => (
                              <div className="stage-context-popover__item" key={item.id}>
                                <strong>{item.title}</strong>
                                <p>{item.summary}</p>
                                <span>{item.kind}</span>
                              </div>
                            ))}
                          </div>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => navigateToRoute('sidekick-console')}
                          >
                            Open Sidekick Console
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {!loadedClipUrl ? (
                    <div className="replay-copy">
                      <span className="live-chip">Ready for live desk</span>
                      <h3>Choose a preset above or add a backup input.</h3>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="stage-support">
                <div className="stage-cue-slot" aria-live="polite">
                  {shouldSurfaceAssist ? (
                    <article
                      className={`replay-toast replay-toast--below ${
                        isAssistWeaning ? 'replay-toast--weaning' : 'replay-toast--live'
                      }`}
                      key={replayToastSignature}
                    >
                      <p className="assist-type">{isAssistWeaning ? 'Hand-off' : 'Sidekick Insight'}</p>
                      <h3>{activeAssist.text}</h3>
                      <p>{activeAssistSupportCopy}</p>
                      {activeAssist.sourceChips.length > 0 ? (
                        <details className="assist-trace">
                          <summary>
                            Why this cue
                            {assistSourceSummary ? <span>{assistSourceSummary}</span> : null}
                          </summary>
                          <div className="assist-trace__body">
                            <div className="source-chip-row">
                              {activeAssist.sourceChips.map((chip) => (
                                <span className="source-chip" key={chip.id}>
                                  {chip.label}
                                </span>
                              ))}
                            </div>
                            <div className="reason-list">
                              {assistTraceLines.map((line) => (
                                <p key={line}>{line}</p>
                              ))}
                            </div>
                          </div>
                        </details>
                      ) : null}
                    </article>
                  ) : (
                    <article className="replay-toast replay-toast--below replay-toast--placeholder">
                      <p className="assist-type">Cue card</p>
                      <h3>AndOne stays quiet until hesitation needs backup.</h3>
                    </article>
                  )}
                </div>

                <p className="stage-footnote">
                  {loadedClipUrl
                    ? isBroadcastLive
                      ? 'The feed keeps looping while the session is live so the desk behaves like a continuous broadcast.'
                      : 'The feed is loaded and ready. Go live when you want the sidekick to start monitoring.'
                    : 'Channel 1 and Channel 2 are presets. Channel 3 is your upload slot.'}
                </p>
              </div>
            </section>

            <aside className="side-column">
              <section className={`panel control-panel control-panel--${coachingTone.tone} live-sidebar`}>
                <div className="panel-header panel-header--compact">
                  <div>
                    <h2>Live state</h2>
                  </div>
                  <span className="panel-tag">
                    {activeAgentNames.length > 0 ? `${activeAgentNames.length} active` : 'Quiet'}
                  </span>
                </div>

                <article className={`booth-card booth-card--compact booth-card--${coachingTone.tone} live-card live-overview-card`}>
                    <div className="booth-card__header">
                      <div>
                        <p className="control-label">Cue engine</p>
                        <strong>{hasStartedMonitoring ? (isAssistWeaning ? 'Sidekick is receding' : assistStateLabel) : 'Monitoring preview'}</strong>
                      </div>
                      <span className="metric-badge">{overviewBadgeLabel}</span>
                    </div>

                    <p className="field-copy field-copy--tight">{overviewCopy}</p>

                    <div className="signal-indicator-row" aria-label="Hesitation triggers">
                      {monitoredSignals.map((signal) => (
                        <div
                          className={`signal-indicator ${
                            signal.active
                              ? coachingTone.tone === 'step-in'
                                ? 'signal-indicator--step-in signal-indicator--active'
                                : 'signal-indicator--supporting signal-indicator--active'
                              : 'signal-indicator--steady'
                          }`}
                          key={signal.label}
                        >
                          <span>{signal.label}</span>
                          <strong>{signal.detail}</strong>
                        </div>
                      ))}
                    </div>

                    <div className="signal-meta signal-meta--meters" aria-label="Hesitation and recovery meters">
                      <div className="metric-card">
                        <div className="meter-label-row">
                          <span>Hesitation</span>
                          <strong>{overviewHesitationLabel}</strong>
                        </div>
                        <div className="meter-track meter-track--step-in">
                          <span style={{ width: overviewHesitationWidth }} />
                        </div>
                      </div>
                      <div className="metric-card">
                        <div className="meter-label-row">
                          <span>Recovery</span>
                          <strong>{overviewRecoveryLabel}</strong>
                        </div>
                        <div className="meter-track meter-track--steady">
                          <span style={{ width: overviewRecoveryWidth }} />
                        </div>
                      </div>
                    </div>

                    <div className="level-meter-block">
                      <div className="meter-label-row">
                        <span>Input level</span>
                        <strong>{overviewInputLabel}</strong>
                      </div>
                      <div className="level-meter" aria-label="Microphone level">
                        <span style={{ width: overviewInputWidth }} />
                      </div>
                    </div>

                    <div className="reason-list">
                      <p>{overviewReason}</p>
                    </div>
                  </article>

                {boothError ? <p className="inline-warning">{boothError}</p> : null}

                <details className="booth-card booth-card--compact details-card">
                  <summary className="details-card__summary">
                    <div>
                      <p className="control-label">Booth handoff</p>
                      <strong>{activeDeliverySourceLabel}</strong>
                    </div>
                    <span
                      className={`panel-tag ${
                        isStandbyVoiceAvailable ? 'panel-tag--success' : ''
                      }`}
                    >
                      {standbyVoiceStatusLabel}
                    </span>
                  </summary>
                  <div className="details-card__body">
                    <p className="field-copy field-copy--tight">{standbySetupSummary}</p>
                    <div className="handoff-strip">
                      <div className="handoff-strip__meta">
                        <span>On Air</span>
                          <strong>{activeDeliverySource === 'live-mic' ? 'You' : 'AndOne'}</strong>
                      </div>
                      <div className="handoff-strip__meta">
                        <span>Transition</span>
                        <strong>{handoffCountdown ? `${handoffNote} ${handoffCountdown}` : handoffNote ?? 'Ready'}</strong>
                      </div>
                    </div>
                    <div className="standby-voice-actions">
                      {!isStandbyVoiceAvailable ? (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => navigateToRoute('sidekick-console')}
                        >
                          Open Sidekick Console
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={standbyToggleDisabled}
                        onClick={() => beginHandoff(standbyToggleDirection)}
                      >
                        {standbyToggleLabel}
                      </button>
                    </div>
                  </div>
                </details>
              </section>
            </aside>
          </div>

          <section className="panel live-workspace">
            <div className="live-workspace-grid">
              <article className="booth-card booth-card--compact booth-card--steady booth-card--transcript live-workspace-card">
                <div className="booth-card__header">
                  <div>
                    <p className="control-label">Live transcript</p>
                    <strong>
                      {hasStartedMonitoring
                        ? boothHasTranscriptContext
                          ? 'Mic copy is flowing'
                          : 'Waiting for speech'
                        : 'Session not started'}
                    </strong>
                  </div>
                </div>

                <div className="transcript-list" aria-live="polite">
                  {hasStartedMonitoring ? (
                    transcriptWindow.length > 0 ? (
                      transcriptWindow.map((entry) => (
                        <p className="transcript-line" key={`${entry.timestamp}-${entry.text}`}>
                          {entry.text}
                        </p>
                      ))
                    ) : (
                      <p className="transcript-line transcript-line--muted">
                        Once the booth mic produces usable text, the latest lines will appear here.
                      </p>
                    )
                  ) : (
                    <p className="transcript-line transcript-line--muted">
                      Start a live session to stream transcript context into the desk.
                    </p>
                  )}

                  {hasStartedMonitoring && boothInterimTranscript.trim() ? (
                    <p className="transcript-line transcript-line--interim">{boothInterimTranscript.trim()}</p>
                  ) : null}
                </div>

                <div className="inline-actions inline-actions--compact inline-actions--spread">
                  <button
                    type="button"
                    className="text-button"
                    disabled={isFinalizingSession || !hasStartedMonitoring}
                    onClick={clearBoothTranscript}
                  >
                    Clear transcript
                  </button>
                </div>
              </article>

              <div className="live-workspace-stack">
                <details className="booth-card booth-card--compact details-card live-card live-card--wide" open>
                  <summary className="details-card__summary">
                    <div>
                      <p className="control-label">Assist streams</p>
                      <strong>{liveActivityHeadline}</strong>
                    </div>
                    <span className="panel-tag">{liveAgents.length} observed</span>
                  </summary>

                  {liveAgents.length > 0 ? (
                    <div className="details-card__body">
                      <div className="agent-trace-list">
                        {liveAgents.map((agent) => (
                          <details
                            className={`agent-trace-item agent-trace-item--${agent.displayState}`}
                            key={`${agent.origin}-${agent.agentName}`}
                          >
                            <summary className="agent-trace-item__summary">
                              <div className="agent-trace-item__content">
                                <span className="agent-trace-item__label">{agent.agentName}</span>
                                <p className="agent-trace-item__detail">{normalizeMonitorCopy(agent.output)}</p>
                              </div>
                              <span className="agent-trace-item__state">{formatSidebarAgentStateLabel(agent)}</span>
                            </summary>
                            <div className="details-card__body">
                              <div className="reason-list">
                                {agent.reasoningTrace.map((traceLine) => (
                                  <p key={`${agent.agentName}-${traceLine}`}>{normalizeMonitorCopy(traceLine)}</p>
                                ))}
                              </div>
                              {agent.sourcesUsed.length > 0 ? (
                                <div className="source-chip-row">
                                  {agent.sourcesUsed.map((chip) => (
                                    <span className="source-chip" key={`${agent.agentName}-${chip.id}`}>
                                      {chip.label}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          </details>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="transcript-line transcript-line--muted">
                      Relevant live streams will appear here only when they change the current beat.
                    </p>
                  )}
                </details>

                <details
                  className="booth-card booth-card--compact details-card live-card live-card--wide"
                  open={Boolean(generationExplainability)}
                >
                  <summary className="details-card__summary">
                    <div>
                      <p className="control-label">Cue assembly</p>
                      <strong>{cueAssemblyHeadline}</strong>
                    </div>
                    <span className="panel-tag">{generationAgents.length} streams</span>
                  </summary>

                  {generationExplainability ? (
                    <div className="details-card__body">
                      {generationAgents.length > 0 ? (
                        <div className="agent-trace-list">
                          {generationAgents.map((agent) => (
                            <details
                              className={`agent-trace-item agent-trace-item--${agent.state === 'waiting' ? 'idle' : 'contributing'}`}
                              key={`generation-${agent.agentName}`}
                            >
                              <summary className="agent-trace-item__summary">
                                <div className="agent-trace-item__content">
                                  <span className="agent-trace-item__label">{agent.agentName}</span>
                                  <p className="agent-trace-item__detail">{normalizeMonitorCopy(agent.output)}</p>
                                </div>
                                <span className="agent-trace-item__state">
                                  {formatSidebarAgentStateLabel({
                                    ...agent,
                                    origin: 'generation',
                                    displayState: agent.state === 'waiting' ? 'idle' : 'contributing',
                                  })}
                                </span>
                              </summary>
                              <div className="details-card__body">
                                <div className="reason-list">
                                  {agent.reasoningTrace.map((line) => (
                                    <p key={`generation-${agent.agentName}-${line}`}>{normalizeMonitorCopy(line)}</p>
                                  ))}
                                </div>
                                {agent.sourcesUsed.length > 0 ? (
                                  <div className="source-chip-row">
                                    {agent.sourcesUsed.map((chip) => (
                                      <span className="source-chip" key={`generation-agent-${agent.agentName}-${chip.id}`}>
                                        {chip.label}
                                      </span>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            </details>
                          ))}
                        </div>
                      ) : null}
                      <div className="monitor-summary-note">
                        {cueAssemblySummary ? <strong>{normalizeMonitorCopy(cueAssemblySummary)}</strong> : null}
                        <p>{cueAssemblySupportCopy}</p>
                      </div>
                      {generationExplainability.sourcesUsed.length > 0 ? (
                        <div className="source-chip-row">
                          {generationExplainability.sourcesUsed.map((chip) => (
                            <span className="source-chip" key={`generation-${chip.id}`}>
                              {chip.label}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <p className="transcript-line transcript-line--muted">
                      When a grounded cue appears, the streams and source facts behind it will show here.
                    </p>
                  )}
                </details>
              </div>
            </div>
          </section>
        </>
      ) : appRoute === 'analyze' ? (
        <div className="main-grid main-grid--reviews">
          <section className="panel analyze-sidebar">
            <div className="panel-header">
              <div>
                <p className="panel-kicker"><span className="panel-kicker__icon" aria-hidden="true">📈</span>Analyze</p>
                <h2>Completed runs</h2>
                <p className="panel-copy">
                  Finished runs only. Live sessions stay out of analysis until they are ended and saved.
                </p>
              </div>
              <span className="panel-tag">{completedReviewSessions.length} runs</span>
            </div>

            <div className="commentary-metadata commentary-metadata--review">
              <div>
                <p className="control-label">Completed runs</p>
                <strong>{completedReviewAnalytics.totalSessions}</strong>
              </div>
              <div>
                <p className="control-label">Avg hesitation</p>
                <strong>{formatPercent(completedReviewAnalytics.averagePeakHesitation)}</strong>
              </div>
              <div>
                <p className="control-label">Avg pause</p>
                <strong>{formatDurationMs(Math.round(sessionWorkspaceInsights.averageLongestPauseMs))}</strong>
              </div>
              <div>
                <p className="control-label">Cues / run</p>
                <strong>{sessionWorkspaceInsights.averageAssistRate.toFixed(1)}</strong>
              </div>
            </div>

            <div className="timeline-list">
              {activeSavedSessions.length > 0 ? (
                <div className="inline-note">
                  {activeSavedSessions.length} live run{activeSavedSessions.length === 1 ? '' : 's'} {activeSavedSessions.length === 1 ? 'is' : 'are'} still open and will appear here after the session is finished.
                </div>
              ) : null}

              {completedReviewSessions.length > 0 ? (
                completedReviewSessions.map((session) => (
                  <article
                    className={`timeline-item analyze-session-card ${selectedReviewSessionId === session.id ? 'timeline-item--hot' : ''}`}
                    key={session.id}
                  >
                    <div className="analyze-session-card__header">
                      <div className="analyze-session-card__identity">
                        <strong>{session.clipName}</strong>
                        <small>{formatSessionStartedAt(session.startedAt)}</small>
                      </div>
                      <span className="panel-tag">{selectedReviewSessionId === session.id ? 'Selected' : 'Saved'}</span>
                    </div>
                    <div className="analyze-session-card__metrics">
                      <span>Peak {formatPercent(session.maxHesitationScore)}</span>
                      <span>Longest pause {formatDurationMs(session.longestPauseMs)}</span>
                      <span>{session.assistCount} cue{session.assistCount === 1 ? '' : 's'}</span>
                    </div>
                    <div className="analyze-session-card__actions">
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => void loadSessionReview(session.id)}
                      >
                        {selectedReviewSessionId === session.id ? 'Refresh analysis' : 'Open analysis'}
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <p className="transcript-line transcript-line--muted">
                  End a live session to save a run for analysis here.
                </p>
              )}
            </div>
          </section>

          <section className="panel review-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker"><span className="panel-kicker__icon" aria-hidden="true">🧠</span>Analyze run</p>
                <h2>{latestCompletedSession?.clipName ?? 'No run selected'}</h2>
                <p className="panel-copy">
                  {latestCompletedSession
                    ? 'Saved trace and model analysis, side by side.'
                    : 'Choose a completed run to inspect the hesitation trace and model analysis.'}
                </p>
              </div>
              <span className="panel-tag">{reviewStatusLabel}</span>
            </div>

            {latestCompletedSession ? (
              <>
                <div className="booth-summary booth-summary--review analyze-summary">
                  <div>
                    <p className="control-label">Peak hesitation</p>
                    <strong>{formatPercent(latestCompletedSession.maxHesitationScore)}</strong>
                  </div>
                  <div>
                    <p className="control-label">Longest pause</p>
                    <strong>{formatDurationMs(latestCompletedSession.longestPauseMs)}</strong>
                  </div>
                  <div>
                    <p className="control-label">Samples</p>
                    <strong>{latestCompletedSession.sampleCount}</strong>
                  </div>
                  <div>
                    <p className="control-label">Cues</p>
                    <strong>{latestCompletedSession.assistCount}</strong>
                  </div>
                </div>

                <div className="inline-actions inline-actions--compact review-actions">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void loadSessionReview(latestCompletedSession.id)}
                  >
                    Refresh AI analysis
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => navigateToRoute('live-desk')}
                  >
                    Return to live
                  </button>
                </div>

                <div className="review-workspace">
                  {postSessionReview ? (
                    <section className="review-rail">
                      <div className="review-lead review-lead--trace">
                        <div className="review-lead__header">
                          <div>
                            <p className="memory-title">Session trace</p>
                            <h3>{postSessionReview.headline}</h3>
                          </div>
                          <span className="panel-tag">Saved data</span>
                        </div>
                        <p className="field-copy field-copy--tight">{postSessionReview.summary}</p>
                      </div>

                      <div className="review-metric-grid">
                        {postSessionReview.metrics.map((metric) => (
                          <article className="review-metric-card" key={metric.label}>
                            <p className="control-label">{metric.label}</p>
                            <strong>{metric.value}</strong>
                          </article>
                        ))}
                      </div>

                      <div className="review-section">
                        <p className="memory-title">Signal takeaways</p>
                        <div className="reason-list">
                          {postSessionReview.learningNotes.map((note) => (
                            <p key={`trace-${note}`}>{note}</p>
                          ))}
                        </div>
                      </div>
                    </section>
                  ) : null}

                  <section className="review-rail">
                    <div className="review-lead review-lead--ai">
                      <div className="review-lead__header">
                        <div>
                          <p className="memory-title">AI analysis</p>
                          <h3>
                            {latestCompletedSessionReview?.headline ??
                              (isLoadingReview ? 'Analyzing hesitation trace' : 'Awaiting AI analysis')}
                          </h3>
                        </div>
                        <span className="panel-tag">
                          {latestCompletedSessionReview ? 'OpenAI' : isLoadingReview ? 'Loading' : 'Pending'}
                        </span>
                      </div>
                      <p className="field-copy field-copy--tight">
                        {latestCompletedSessionReview?.summary ??
                          (isLoadingReview
                            ? 'AndOne is generating a grounded analysis from the saved booth session record.'
                            : 'Refresh the run to fetch the latest OpenAI analysis.')}
                      </p>
                    </div>

                    {isLoadingReview ? (
                      <div className="review-loading-card" aria-live="polite">
                        <div className="review-loading-spinner" aria-hidden="true" />
                        <div>
                          <strong>OpenAI analysis in progress</strong>
                          <p>The saved trace is already here. The model analysis will slot in as soon as it returns.</p>
                        </div>
                      </div>
                    ) : latestCompletedSessionReview ? (
                      <div className="review-stack">
                        <div className="review-section">
                          <p className="memory-title">What went well</p>
                          <div className="reason-list">
                            {latestCompletedSessionReview.strengths.map((note) => (
                              <p key={`strength-${note}`}>{note}</p>
                            ))}
                          </div>
                        </div>

                        <div className="review-section">
                          <p className="memory-title">Watchouts</p>
                          <div className="reason-list">
                            {latestCompletedSessionReview.watchouts.map((note) => (
                              <p key={`watchout-${note}`}>{note}</p>
                            ))}
                          </div>
                        </div>

                        <div className="review-section">
                          <p className="memory-title">Coaching notes</p>
                          <div className="reason-list">
                            {latestCompletedSessionReview.coachingNotes.map((note) => (
                              <p key={`coach-${note}`}>{note}</p>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="review-loading-card review-loading-card--idle">
                        <div>
                          <strong>No AI analysis loaded yet</strong>
                          <p>The run metrics are real and saved. Use “Refresh AI analysis” to fetch the model-written analysis.</p>
                        </div>
                      </div>
                    )}
                  </section>
                </div>
              </>
            ) : (
              <p className="transcript-line transcript-line--muted">
                Pick a saved run to inspect its hesitation trace and AI analysis.
              </p>
            )}
          </section>
        </div>
      ) : (
        <div className="debug-layout">
          <div className="main-grid main-grid--debug">
          <section className="panel review-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Global setup</p>
                <h2>Sidekick Console</h2>
                <p className="panel-copy">Configure the reusable context library that shapes cue generation across sessions.</p>
              </div>
              <span className="panel-tag">{visibleContextDocuments.length} docs</span>
            </div>

            <div className="review-stack review-stack--console">
              <details className="console-section" open>
                <summary className="console-section__summary">
                  <div>
                    <p className="memory-title">Global context library</p>
                    <strong>Reusable docs and notes</strong>
                  </div>
                  <span className="panel-tag">{visibleContextDocuments.length}</span>
                </summary>
                <div className="console-section__body">
                  <p className="field-copy field-copy--tight">
                    Save reusable prep notes, research docs, and cheat sheets here. These become the default base library for future sessions.
                  </p>
                  <div className="context-upload">
                    <textarea
                      className="context-textarea"
                      value={contextUploadText}
                      onChange={(event) => setContextUploadText(event.target.value)}
                      placeholder="Paste reusable prep notes or talking points..."
                    />
                    <div className="context-upload__actions">
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={isUploadingContext || !contextUploadText.trim()}
                        onClick={() => void handleContextTextUpload()}
                      >
                        {isUploadingContext ? 'Saving...' : 'Save to global library'}
                      </button>
                      <label className="file-chip">
                        <span>Upload global file</span>
                        <input
                          type="file"
                          accept=".txt,.md,.csv,.json,.html,.xml"
                          onChange={(event) => void handleContextFileUpload(event)}
                        />
                      </label>
                    </div>
                  </div>
                </div>
              </details>

              <details className="console-section" open>
                <summary className="console-section__summary">
                  <div>
                    <p className="memory-title">Library contents</p>
                    <strong>Docs available to include</strong>
                  </div>
                  <span className="panel-tag">{visibleContextDocuments.length}</span>
                </summary>
                <div className="console-section__body">
                  {visibleContextDocuments.length > 0 ? (
                    <div className="context-doc-list">
                      {visibleContextDocuments.map((document) => (
                        <div className="context-fact-item" key={document.id}>
                          <strong>{document.fileName}</strong>
                          <p>{document.localEntry ? getLocalContextPreview(document.localEntry) : 'Stored in the shared context library for cue retrieval.'}</p>
                          <div className="inline-actions inline-actions--compact inline-actions--spread">
                            <span>{document.chunkCount} chunks</span>
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => removeGlobalContextDocument(document.id)}
                            >
                              Remove from library
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="transcript-line transcript-line--muted">
                      No reusable docs are stored yet. Add a cheat sheet or prep note to seed the library.
                    </p>
                  )}
                </div>
              </details>
            </div>
          </section>

          <section className="panel review-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Session setup</p>
                <h2>{loadedClipName || 'Session context'}</h2>
                <p className="panel-copy">Choose exactly what this session feeds into the cue engine before you go live.</p>
              </div>
              <span className="panel-tag">{activeSessionContextCount} in session</span>
            </div>

            <div className="review-stack review-stack--console">
              <details className="console-section" open>
                <summary className="console-section__summary">
                  <div>
                    <p className="memory-title">Session mode</p>
                    <strong>{sessionContextMode === 'inherit-global' ? 'Using the global setup' : 'Customizing this session'}</strong>
                  </div>
                  <span className="panel-tag">{sessionContextMode === 'inherit-global' ? 'Global' : 'Custom'}</span>
                </summary>
                <div className="console-section__body">
                  <div className="inline-actions inline-actions--compact">
                    <button
                      type="button"
                      className={`ghost-button ${sessionContextMode === 'inherit-global' ? 'ghost-button--active' : ''}`}
                      onClick={() => setSessionContextMode('inherit-global')}
                    >
                      Use global setup
                    </button>
                    <button
                      type="button"
                      className={`ghost-button ${sessionContextMode === 'custom' ? 'ghost-button--active' : ''}`}
                      onClick={() => {
                        setSessionContextMode('custom');
                        setSessionSelectedGlobalContextIds(visibleContextDocuments.map((document) => document.id));
                      }}
                    >
                      Customize this session
                    </button>
                  </div>
                  <p className="field-copy field-copy--tight">
                    {sessionContextMode === 'inherit-global'
                      ? 'This session uses the visible global library by default, plus the live-generated system streams below.'
                      : 'This session is using a custom context pack. Pick which global docs carry over, then add session-specific material on top.'}
                  </p>
                </div>
              </details>

              <details className="console-section" open>
                <summary className="console-section__summary">
                  <div>
                    <p className="memory-title">Cue engine streams</p>
                    <strong>What is currently feeding generation</strong>
                  </div>
                  <span className="panel-tag">{cueEngineStreams.length} streams</span>
                </summary>
                <div className="console-section__body">
                  <div className="context-doc-list">
                    {cueEngineStreams.map((stream) => (
                      <div className="context-fact-item" key={stream.id}>
                        <strong>{stream.title}</strong>
                        <p>
                          {stream.items.length > 0
                            ? stream.items.join(' · ')
                            : 'No data is flowing through this stream yet.'}
                        </p>
                        <span>{stream.status}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </details>

              <details className="console-section" open>
                <summary className="console-section__summary">
                  <div>
                    <p className="memory-title">Global docs in this session</p>
                    <strong>Choose which reusable docs carry over</strong>
                  </div>
                  <span className="panel-tag">{sessionGlobalContextDocs.length} included</span>
                </summary>
                <div className="console-section__body">
                  {visibleContextDocuments.length > 0 ? (
                    <div className="context-doc-list">
                      {visibleContextDocuments.map((document) => {
                        const isInSession = activeGlobalContextIds.includes(document.id);

                        return (
                          <div className="context-fact-item" key={`session-${document.id}`}>
                            <strong>{document.fileName}</strong>
                            <p>{document.localEntry ? getLocalContextPreview(document.localEntry) : 'Stored in the shared library for cue retrieval.'}</p>
                            <div className="inline-actions inline-actions--compact inline-actions--spread">
                              <span>{document.chunkCount} chunks</span>
                              {sessionContextMode === 'custom' ? (
                                <button
                                  type="button"
                                  className="text-button"
                                  onClick={() =>
                                    setSessionSelectedGlobalContextIds((current) =>
                                      current.includes(document.id)
                                        ? current.filter((id) => id !== document.id)
                                        : [...current, document.id]
                                    )
                                  }
                                >
                                  {isInSession ? 'Remove from session' : 'Add to session'}
                                </button>
                              ) : (
                                <span>{isInSession ? 'Included' : 'Not included'}</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="transcript-line transcript-line--muted">
                      No global docs are available yet for this session to inherit.
                    </p>
                  )}
                </div>
              </details>

              <details className="console-section" open>
                <summary className="console-section__summary">
                  <div>
                    <p className="memory-title">Session additions</p>
                    <strong>Add one-off notes or cheat sheets</strong>
                  </div>
                  <span className="panel-tag">{sessionContextEntries.length} added</span>
                </summary>
                <div className="console-section__body">
                  <div className="context-upload">
                    <textarea
                      className="context-textarea"
                      value={sessionContextText}
                      onChange={(event) => setSessionContextText(event.target.value)}
                      placeholder="Add matchup-specific reminders, sponsor reads, or a one-off cheat sheet for this session..."
                    />
                    <div className="context-upload__actions">
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={isUploadingContext || !sessionContextText.trim()}
                        onClick={() => void handleSessionContextTextUpload()}
                      >
                        {isUploadingContext ? 'Saving...' : 'Add session note'}
                      </button>
                      <label className="file-chip">
                        <span>Upload session file</span>
                        <input
                          type="file"
                          accept=".txt,.md,.csv,.json,.html,.xml"
                          onChange={(event) => void handleSessionContextFileUpload(event)}
                        />
                      </label>
                    </div>
                  </div>

                  {sessionContextEntries.length > 0 ? (
                    <div className="context-doc-list">
                      {sessionContextEntries.map((entry) => (
                        <div className="context-fact-item" key={entry.id}>
                          <strong>{entry.fileName}</strong>
                          <p>{getLocalContextPreview(entry)}</p>
                          <div className="inline-actions inline-actions--compact inline-actions--spread">
                            <span>Session-only</span>
                            <div className="inline-actions inline-actions--compact">
                              <button
                                type="button"
                                className="text-button"
                                onClick={() => editSessionContextEntry(entry.id)}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="text-button"
                                onClick={() => removeSessionContextEntry(entry.id)}
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="transcript-line transcript-line--muted">
                      Nothing extra is pinned to this session yet.
                    </p>
                  )}
                </div>
              </details>

              <details className="console-section" open>
                <summary className="console-section__summary">
                  <div>
                    <p className="memory-title">Cue engine context</p>
                    <strong>What the model will receive</strong>
                  </div>
                  <span className="panel-tag">{sessionExpectedTopics.length} topics</span>
                </summary>
                <div className="console-section__body">
                  <div className="reason-list">
                    <p>
                      The cue engine receives the live match state, the system-generated context streams, the selected global docs, and any session-specific additions shown here.
                    </p>
                    <p>
                      Session topics: {sessionExpectedTopics.slice(0, 10).join(' · ') || 'Waiting for match context'}
                    </p>
                    <p>{sessionContextSummary || 'Session context will appear here once the pack has real content.'}</p>
                  </div>
                </div>
              </details>

              <div className="inline-actions inline-actions--compact inline-actions--spread">
                <button type="button" className="text-button" onClick={() => navigateToRoute('live-desk')}>
                  Return to live
                </button>
                <button type="button" className="text-button" onClick={() => navigateToRoute('analyze')}>
                  Open Analyze
                </button>
              </div>
            </div>
          </section>

          </div>

          <section className="panel review-panel console-voice-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Booth handoff</p>
                <h2>Handoff voice</h2>
                <p className="panel-copy">Voice setup is separate from context setup. Capture it only if you want AndOne to take the call during a booth handoff.</p>
              </div>
              <span className={`panel-tag ${isStandbyVoiceAvailable ? 'panel-tag--success' : ''}`}>
                {isStandbyVoiceAvailable ? 'Ready' : 'Setup'}
              </span>
            </div>

            <div className="setup-card standby-voice-card">
              <div className="setup-card__header">
                <div>
                  <p className="control-label">Handoff voice</p>
                  <strong>{standbyVoiceStatusLabel}</strong>
                </div>
              </div>
              <p className="field-copy field-copy--tight">{standbySetupSummary}</p>
              <div className="standby-voice-actions">
                <button
                  type="button"
                  className="ghost-button"
                  disabled={standbyVoiceStatus === 'recording' || standbyVoiceStatus === 'processing'}
                  onClick={() => void recordStandbyVoiceSample()}
                >
                  {standbyVoiceStatus === 'ready' ? 'Capture again' : 'Capture voice'}
                </button>
                {standbyVoiceEnabled ? (
                  <button
                    type="button"
                    className="text-button"
                    disabled={standbyVoiceStatus === 'recording' || standbyVoiceStatus === 'processing'}
                    onClick={disableStandbyVoice}
                  >
                    Clear voice
                  </button>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      )}

    </div>
  );
}

export default App;
