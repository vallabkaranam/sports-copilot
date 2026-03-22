import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import {
  BoothFeatureSnapshot,
  BoothInterpretation,
  BoothSessionRecord,
  BoothSessionReview,
  BoothSessionSummary,
  GenerateBoothCueResponse,
  ReplayControlState,
  TranscriptEntry,
  createEmptyAssistCard,
} from '@sports-copilot/shared-types';
import './App.css';
import { BRAND } from './brand';
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
  startBoothSession,
  transcribeBoothAudio,
  updateControlState,
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
type AppView = 'live' | 'reviews';

const AUDIO_ACTIVITY_SAMPLE_MS = 120;
const MIN_AUDIO_ACTIVITY_THRESHOLD = 0.012;
const MAX_AUDIO_ACTIVITY_THRESHOLD = 0.08;
const ASSIST_WEAN_OFF_MS = 2600;
const MIN_ASSIST_DISPLAY_MS = 2400;
const BUFFERED_TRANSCRIPTION_CHUNK_MS = 2_500;
const BUFFERED_TRANSCRIPTION_WARNING_THRESHOLD = 3;
const BUFFERED_TRANSCRIPTION_WARNING =
  'Live transcription is not producing usable text yet. Keep speaking or check the OpenAI mic path.';
const GENERATE_CUE_FAILURE_BACKOFF_MS = 4_000;
const PROGRAM_FEED_SLOTS: ProgramFeedSlot[] = [
  {
    id: 'program-a',
    label: 'Channel 1',
    tone: 'Preset match feed',
    source: 'preset',
    presetUrl: '/media/barca-preset.mp4',
    presetFileName: 'Barca preset',
  },
  {
    id: 'program-b',
    label: 'Channel 2',
    tone: 'Manual backup feed',
    source: 'upload',
  },
];

function supportsAudioMonitoring() {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof window.AudioContext !== 'undefined'
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

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
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

function formatSignalIndicatorValue(label: 'Pause' | 'Fillers' | 'Wake phrase', boothSignal: BoothSignal) {
  if (label === 'Pause') {
    return boothSignal.pauseDurationMs >= LONG_PAUSE_START_MS
      ? `${Math.round((boothSignal.pauseDurationMs / 100) * 10) / 10}s`
      : 'Stable';
  }

  if (label === 'Fillers') {
    return boothSignal.fillerCount > 0 ? boothSignal.fillerWords.slice(0, 3).join(', ') : 'Clean';
  }

  return boothSignal.wakePhraseDetected ? 'Detected' : 'Listening';
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
    headline: 'Session review is ready.',
    summary: `Saved ${session.sampleCount} live samples and ${session.assistCount} prompt${
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
      copy: 'Prompts stay off-screen until you go live.',
    };
  }

  if (shouldSurfaceAssist) {
    return {
      tone: 'step-in' as CoachingTone,
      label: 'Prompt live',
      headline: 'A prompt is live.',
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
      copy: 'The prompt is fading because your delivery is stable again.',
    };
  }

  return {
    tone: 'supporting' as CoachingTone,
    label: 'Monitoring',
    headline: 'AndOne is following your delivery.',
    copy: 'The live feed is active, but the hesitation signal is not strong enough to prompt yet.',
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
  const [appView, setAppView] = useState<AppView>('live');
  const [activeBoothSessionId, setActiveBoothSessionId] = useState<string | null>(null);
  const [loadedClipName, setLoadedClipName] = useState('');
  const [loadedClipUrl, setLoadedClipUrl] = useState<string | null>(null);
  const [selectedProgramFeedId, setSelectedProgramFeedId] = useState<ProgramFeedSlotId | null>(null);
  const [storedProgramFeeds, setStoredProgramFeeds] = useState<Record<ProgramFeedSlotId, StoredProgramFeed | null>>({
    'program-a': null,
    'program-b': null,
  });
  const [clipPositionMs, setClipPositionMs] = useState(0);
  const [clipDurationMs, setClipDurationMs] = useState(0);
  const [isClipMuted, setIsClipMuted] = useState(true);
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
  const [assistLockExpiresAt, setAssistLockExpiresAt] = useState(0);
  const [assistEpisodeId, setAssistEpisodeId] = useState(0);
  const [isAssistEpisodeActive, setIsAssistEpisodeActive] = useState(false);
  const [latchedAssistEpisodeId, setLatchedAssistEpisodeId] = useState(0);
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

  useEffect(() => {
    let isActive = true;

    void listStoredProgramFeeds().then(async (feeds) => {
      if (!isActive) {
        return;
      }

      const nextFeeds: Record<ProgramFeedSlotId, StoredProgramFeed | null> = {
        'program-a': null,
        'program-b': null,
      };

      for (const feed of feeds) {
        nextFeeds[feed.slotId] = feed;
      }

      setStoredProgramFeeds(nextFeeds);

      const presetSlot = PROGRAM_FEED_SLOTS.find((slot) => slot.source === 'preset');
      if (presetSlot?.presetUrl && (await canLoadPresetFeed(presetSlot.presetUrl))) {
        if (!isActive) {
          return;
        }
        setSelectedProgramFeedId(presetSlot.id);
        setLoadedClipUrl(presetSlot.presetUrl);
        setLoadedClipName(presetSlot.presetFileName ?? presetSlot.label);
      } else {
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
    setClipPositionMs(0);

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

  function clearLoadedClip() {
    if (clipObjectUrlRef.current) {
      URL.revokeObjectURL(clipObjectUrlRef.current);
      clipObjectUrlRef.current = null;
    }

    setLoadedClipName('');
    setLoadedClipUrl(null);
    setClipPositionMs(0);
    setClipDurationMs(0);
    setIsClipMuted(true);
    setHasStartedBroadcast(false);
    setActiveBoothSessionId(null);
    setIsMicPrepared(false);
    setSpeechStreakStartedAtMs(-1);
    setSilenceStreakStartedAtMs(-1);
    setSelectedProgramFeedId(null);
    consecutiveBufferedTranscriptFailuresRef.current = 0;
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
      setBoothError('The AI session review is still processing. Try this saved session again in a moment.');
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
      setLatestCompletedSession(null);

      try {
        const completedSession = await fetchBoothSession(response.session.id);
        setLatestCompletedSession(completedSession.session);
      } catch (_error) {
        setBoothError('The live session was saved, but the saved session detail is not ready yet.');
      }

      setAppView('reviews');

      try {
        const review = await fetchBoothSessionReview(response.session.id);
        setLatestCompletedSessionReview(review.review);
      } catch (_error) {
        setBoothError('The live session was saved, but the AI session review is still loading.');
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
        setBoothError('This preset feed is not reachable right now. Switch to the upload channel instead.');
        return;
      }
      if (clipObjectUrlRef.current) {
        URL.revokeObjectURL(clipObjectUrlRef.current);
        clipObjectUrlRef.current = null;
      }
      setSelectedProgramFeedId(slotId);
      setLoadedClipName(slot.presetFileName ?? slot.label);
      setLoadedClipUrl(slot.presetUrl);
      setClipPositionMs(0);
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
    setClipPositionMs(0);
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
    clearBoothTranscript();
    setBoothInterpretation(null);
    setGeneratedCue(null);
    setGeneratedCueRequestedAt(0);
    setLatchedAssist(createEmptyAssistCard());
    setAssistVisibilityPhase('hidden');
  }

  async function startBroadcast() {
    setBoothError(null);

    if (!loadedClipUrl) {
      setBoothError('Load a clip before starting the booth.');
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
    facts: boothAssistFacts,
    boothTranscript,
    interimTranscript: boothInterimTranscript,
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
      contextSummary: buildContextSummary(worldState),
      expectedTopics: buildExpectedTopics(worldState),
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
  const liveBoothShouldSurfaceAssist =
    boothSignal.shouldSurfaceAssist || Boolean(boothInterpretation?.shouldSurfaceAssist);
  const workerAssistShouldSurface =
    assist.type !== 'none' &&
    (controls.forceHesitation ||
      (!boothHasLiveInput && worldState.commentator.hesitationScore >= LIVE_HESITATION_GATE));
  const boothAssistShouldSurface =
    boothHasLiveInput &&
    liveBoothShouldSurfaceAssist &&
    ((generatedCue?.assist.type ?? 'none') !== 'none' || boothAssist.type !== 'none');
  const nextTriggeredAssist = boothAssistShouldSurface
    ? generatedCue?.assist ?? boothAssist
    : workerAssistShouldSurface
      ? assist
      : null;
  const activeAssist = latchedAssist;
  const shouldSurfaceAssist = activeAssist.type !== 'none' && assistVisibilityPhase !== 'hidden';
  const isAssistWeaning = assistVisibilityPhase === 'weaning';
  const boothHesitationPercent = formatPercent(effectiveHesitationScore);
  const visibleReasons = [...(boothInterpretation?.reasons ?? []), ...boothSignal.hesitationReasons].filter(
    (reason, index, collection) => collection.indexOf(reason) === index,
  );
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
  const clipClockLabel = formatDurationMs(clipPositionMs);
  const clipDurationLabel = clipDurationMs > 0 ? formatDurationMs(clipDurationMs) : '--:--';
  const isBroadcastLive =
    hasStartedBroadcast && (controls.playbackStatus === 'playing' || isMicListening);
  const selectedProgramSlot = PROGRAM_FEED_SLOTS.find((slot) => slot.id === selectedProgramFeedId) ?? null;
  const feedHeading = selectedProgramSlot
    ? `${selectedProgramSlot.label} · ${loadedClipName}`
    : 'Select a program feed';
  const preMatchCueSummary = useMemo(() => buildPreMatchCueSummary(worldState), [worldState]);
  const replayToastSignature = `${activeAssist.type}:${activeAssist.text}:${shouldSurfaceAssist}:${controls.restartToken}`;
  const activeTriggerBadges = [
    boothSignal.pauseDurationMs >= LONG_PAUSE_START_MS ? 'pause' : null,
    boothSignal.fillerCount > 0 ? 'filler' : null,
    boothSignal.repeatedOpeningCount > 0 ? 'repeat-start' : null,
    boothSignal.unfinishedPhrase ? 'unfinished' : null,
    boothSignal.wakePhraseDetected ? 'line' : null,
  ].filter(Boolean) as string[];
  const primaryActionLabel = isFinalizingSession
    ? 'Saving session...'
    : isBroadcastLive
      ? 'End live session'
      : 'Go live';
  const primaryActionDisabled =
    isFinalizingSession || (!isBroadcastLive && (!isBroadcastReady || isUpdatingControls));
  const boothSignalIndicators = [
    {
      label: 'Pause' as const,
      active: boothSignal.pauseDurationMs >= LONG_PAUSE_START_MS,
      emphasis: boothSignal.pauseDurationMs >= LONG_PAUSE_START_MS ? coachingTone.tone : 'standby',
      value: formatSignalIndicatorValue('Pause', boothSignal),
    },
    {
      label: 'Fillers' as const,
      active: boothSignal.fillerCount > 0,
      emphasis: boothSignal.fillerCount > 0 ? 'supporting' : 'standby',
      value: formatSignalIndicatorValue('Fillers', boothSignal),
    },
    {
      label: 'Wake phrase' as const,
      active: boothSignal.wakePhraseDetected,
      emphasis: boothSignal.wakePhraseDetected ? 'step-in' : 'standby',
      value: formatSignalIndicatorValue('Wake phrase', boothSignal),
    },
  ];
  const activeAssistSupportCopy = isAssistWeaning
    ? 'Confidence is returning. AndOne is backing off.'
    : activeAssist.whyNow;
  const transcriptWindow = boothTranscript.slice(-4);
  const railSystemNote = isAssistWeaning
    ? 'Recovery is strong, so the cue is shrinking and handing the call back to you.'
    : shouldSurfaceAssist
      ? 'A cue is live because delivery slipped. Use the prompt card, then keep moving.'
      : boothHasLiveInput
        ? 'The system is only monitoring now. No prompt should surface unless hesitation returns.'
        : 'Feed and microphone are armed. Start speaking when you are ready to call the action.';
  const micBars = Array.from({ length: 14 }, (_, index) => {
    const threshold = (index + 1) / 14;
    return boothSignal.audioLevel >= threshold * 0.18;
  });
  const assistStateLabel = shouldSurfaceAssist
    ? isAssistWeaning
      ? 'Backing off'
      : 'Visible'
    : coachingTone.tone === 'steady'
      ? 'Standby'
      : 'Waiting';
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
      ? 'AI review ready'
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
      setIsAssistEpisodeActive(false);
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
      boothInterpretation?.state === 'weaning-off'
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
        contextBundle: worldState.contextBundle,
        recentEvents: worldState.recentEvents.slice(-4),
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
    worldState.contextBundle,
    worldState.recentEvents,
    worldState.retrieval,
    worldState.sessionMemory.surfacedAssists,
  ]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span className="brand-mark__dot" />
            <span className="brand-mark__text">AO</span>
          </div>
          <div className="brand-copy">
            <p className="eyebrow">{BRAND.eyebrow}</p>
            <h1>{BRAND.heroTitle}</h1>
            <p className="hero-copy">{BRAND.heroCopy}</p>
          </div>
        </div>

        <div className="header-actions">
          <div className="view-switcher" role="tablist" aria-label="AndOne views">
            <button
              type="button"
              role="tab"
              aria-selected={appView === 'live'}
              className={appView === 'live' ? 'ghost-button ghost-button--active' : 'ghost-button'}
              onClick={() => setAppView('live')}
            >
              Live
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={appView === 'reviews'}
              className={appView === 'reviews' ? 'ghost-button ghost-button--active' : 'ghost-button'}
              onClick={() => setAppView('reviews')}
            >
              Archive
            </button>
          </div>
        </div>
      </header>

      {error ? <div className="warning-banner">{error}</div> : null}

      {appView === 'live' ? (
        <div className="main-grid">
        <section className="panel replay-panel stage-panel">
            <div className="panel-header panel-header--stage">
              <div>
                <p className="panel-kicker">Live desk</p>
                <h2>{feedHeading}</h2>
                <p className="panel-copy">Keep the program feed in view. The prompt only appears when delivery slips.</p>
              </div>
              <div className="panel-chip-row">
                <span className="panel-tag">{loadedClipUrl ? `${clipClockLabel} / ${clipDurationLabel}` : 'No feed live'}</span>
            </div>
          </div>

          <div className="media-toolbar">
            <div className="feed-switcher" role="group" aria-label="Program feeds">
              {PROGRAM_FEED_SLOTS.map((slot) => {
                const feed = storedProgramFeeds[slot.id];
                const isSelected = selectedProgramFeedId === slot.id;
                const isPreset = slot.source === 'preset';
                const slotFeedName = isPreset ? slot.presetFileName ?? 'Preset feed' : feed?.fileName ?? 'No reel loaded';

                return (
                  <article
                    key={slot.id}
                    className={`feed-switcher__slot ${isSelected ? 'feed-switcher__slot--selected' : ''}`}
                  >
                    <div className="feed-switcher__copy">
                      <span className="feed-switcher__label">{slot.label}</span>
                      <strong>{slotFeedName}</strong>
                      <small>{slot.tone}</small>
                    </div>
                    <div className="feed-switcher__actions">
                      {isPreset ? (
                        <button
                          type="button"
                          className={isSelected ? 'ghost-button ghost-button--active' : 'ghost-button'}
                          onClick={() =>
                            void loadProgramFeed(slot.id, {
                              slotId: slot.id,
                              fileName: slot.presetFileName ?? slot.label,
                              fileSize: 0,
                              updatedAt: '',
                              blob: new Blob(),
                            })
                          }
                        >
                          {isSelected ? 'On deck' : 'Take feed'}
                        </button>
                      ) : feed ? (
                        <button
                          type="button"
                          className={isSelected ? 'ghost-button ghost-button--active' : 'ghost-button'}
                          onClick={() => void loadProgramFeed(slot.id, feed)}
                        >
                          {isSelected ? 'On deck' : 'Take feed'}
                        </button>
                      ) : null}
                      {!isPreset ? (
                        <label className="file-chip file-chip--slot">
                          <span>{feed ? 'Replace reel' : 'Load reel'}</span>
                          <input
                            type="file"
                            accept="video/*"
                            onChange={(event) => void handleProgramFeedChange(slot.id, event)}
                          />
                        </label>
                      ) : null}
                      {!isPreset && feed ? (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => void clearProgramFeedSlot(slot.id)}
                        >
                          Clear
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="media-meta">
              <span className="meta-pill">
                {selectedProgramSlot ? `${selectedProgramSlot.label}` : 'Choose a feed'}
              </span>
              {loadedClipName ? <span className="meta-pill">{loadedClipName}</span> : null}
              {loadedClipUrl ? (
                <button
                  type="button"
                  className="ghost-button ghost-button--subtle"
                  onClick={() => setIsClipMuted((current) => !current)}
                >
                  {isClipMuted ? 'Clip audio muted' : 'Clip audio on'}
                </button>
              ) : null}
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
                ? 'Saving the session and building the review.'
                : loadedClipUrl
                ? isBroadcastLive
                  ? 'You are live. AndOne will stay quiet until you need support.'
                  : 'Start when you are ready.'
                : 'Load a feed, then go live.'}
            </p>
          </div>

          <div className={`replay-stage ${loadedClipUrl ? 'replay-stage--video' : ''}`}>
            {loadedClipUrl ? (
              <video
                ref={videoRef}
                className="replay-video"
                src={loadedClipUrl}
                playsInline
                loop
                muted={isClipMuted}
                onLoadedMetadata={(event) => {
                  setClipDurationMs(Math.round(event.currentTarget.duration * 1_000));
                }}
                onTimeUpdate={(event) => {
                  setClipPositionMs(Math.round(event.currentTarget.currentTime * 1_000));
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
                  setBoothError('The selected video feed could not be loaded. Try the other channel or reload the reel.');
                }}
              />
            ) : (
              <div className="replay-stage__scrim" />
            )}

            <div className="replay-stage__overlay" />

            <div className="replay-stage__content">
              {!loadedClipUrl ? (
                <div className="replay-copy">
                  <span className="live-chip">Ready for upload</span>
                  <h3>Load a feed into Channel 1 or Channel 2 to begin.</h3>
                </div>
              ) : null}
            </div>
          </div>

          <div className="stage-support">
            {shouldSurfaceAssist ? (
              <article
                className={`replay-toast replay-toast--below ${
                  isAssistWeaning ? 'replay-toast--weaning' : 'replay-toast--live'
                }`}
                key={replayToastSignature}
              >
                <p className="assist-type">Prompt</p>
                <h3>{activeAssist.text}</h3>
                <p>{activeAssistSupportCopy}</p>
              </article>
            ) : null}

            <p className="stage-footnote">
              {loadedClipUrl
                ? isBroadcastLive
                  ? 'The feed loops while the session is live so the desk behaves like a continuous broadcast.'
                  : 'Load the feed, then go live when you are ready.'
                : 'Channel 1 uses the Barca preset. Channel 2 can hold your own reel.'}
            </p>
          </div>
        </section>

        <div className="side-column">
          <section className={`panel control-panel control-panel--${coachingTone.tone}`}>
            <div className="panel-header panel-header--compact">
              <div>
                <p className="panel-kicker">Live session</p>
                <h2>Monitor</h2>
              </div>
            </div>

            <div className="rail-status-strip" aria-label="Booth readiness">
              {readinessChecks.map((check) => (
                <div
                  key={check.label}
                  className={`rail-status-chip ${check.done ? 'rail-status-chip--done' : ''}`}
                  title={check.detail}
                >
                  <span className={`readiness-dot ${check.done ? 'readiness-dot--done' : ''}`} />
                  <strong>{check.label}</strong>
                </div>
              ))}
            </div>

            {boothError ? <p className="inline-warning">{boothError}</p> : null}

            <article className={`booth-card booth-card--compact booth-card--${coachingTone.tone}`}>
              <div className="booth-card__header">
                <div>
                  <p className="control-label">System note</p>
                  <strong>{isAssistWeaning ? 'Prompt is fading out' : assistStateLabel}</strong>
                </div>
              </div>

              <p className="field-copy field-copy--tight">{railSystemNote}</p>

              <div className="metric-card">
                <div className="meter-label-row">
                  <span>Hesitation</span>
                  <strong>{boothHesitationPercent}</strong>
                </div>
                <div className={`meter-track meter-track--${coachingTone.tone}`}>
                  <span style={{ width: boothHesitationPercent }} />
                </div>
              </div>

              <div className="signal-meta">
                <div className="signal-meta__item">
                  <span>Mic activity</span>
                  <div className="audio-meter" aria-label="Mic activity">
                    {micBars.map((isActive, index) => (
                      <span
                        key={index}
                        className={isActive ? 'audio-meter__bar audio-meter__bar--active' : 'audio-meter__bar'}
                      />
                    ))}
                  </div>
                </div>
                <div className="signal-meta__item">
                  <span>Prompt state</span>
                  <strong>{assistStateLabel}</strong>
                </div>
              </div>

              <div className="signal-indicator-row" aria-label="Live booth indicators">
                {boothSignalIndicators.map((indicator) => (
                  <div
                    key={indicator.label}
                    className={`signal-indicator signal-indicator--${indicator.emphasis} ${
                      indicator.active ? 'signal-indicator--active' : ''
                    }`}
                  >
                    <span>{indicator.label}</span>
                    <strong>{indicator.value}</strong>
                  </div>
                ))}
              </div>

              <div className="reason-list">
                {visibleReasons.slice(0, 1).map((reason) => (
                  <p key={reason}>{reason}</p>
                ))}
              </div>
            </article>

            <article className="booth-card booth-card--compact booth-card--steady booth-card--transcript">
              <div className="booth-card__header">
                <div>
                  <p className="control-label">Live transcript</p>
                  <strong>{boothHasTranscriptContext ? 'Mic copy is flowing' : 'Waiting for speech'}</strong>
                </div>
              </div>

              <div className="transcript-list" aria-live="polite">
                {transcriptWindow.length > 0 ? (
                  transcriptWindow.map((entry) => (
                    <p className="transcript-line" key={`${entry.timestamp}-${entry.text}`}>
                      {entry.text}
                    </p>
                  ))
                ) : (
                  <p className="transcript-line transcript-line--muted">
                    Once the booth mic produces usable text, the latest lines will appear here.
                  </p>
                )}

                {boothInterimTranscript.trim() ? (
                  <p className="transcript-line transcript-line--interim">{boothInterimTranscript.trim()}</p>
                ) : null}
              </div>
            </article>

            <div className="inline-actions inline-actions--compact">
              <button
                type="button"
                className="text-button"
                disabled={isFinalizingSession}
                onClick={clearBoothTranscript}
              >
                Clear transcript
              </button>
            </div>
          </section>

        </div>
      </div>
      ) : (
        <div className="main-grid main-grid--reviews">
          <section className="panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker"><span className="panel-kicker__icon" aria-hidden="true">🗂</span>Saved sessions</p>
                <h2>Completed sessions</h2>
                <p className="panel-copy">
                  Saved sessions only. Open live runs stay out of the archive until they are finished.
                </p>
              </div>
              <span className="panel-tag">{completedReviewSessions.length} sessions</span>
            </div>

            <div className="commentary-metadata commentary-metadata--review">
              <div>
                <p className="control-label">Completed</p>
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
                <p className="control-label">Prompts / run</p>
                <strong>{sessionWorkspaceInsights.averageAssistRate.toFixed(1)}</strong>
              </div>
            </div>

            <div className="timeline-list">
              {activeSavedSessions.length > 0 ? (
                <div className="inline-note">
                  {activeSavedSessions.length} active run{activeSavedSessions.length === 1 ? '' : 's'} are still open in the saved session store and hidden from this review list.
                </div>
              ) : null}

              {completedReviewSessions.length > 0 ? (
                completedReviewSessions.map((session) => (
                  <article
                    className={`timeline-item ${selectedReviewSessionId === session.id ? 'timeline-item--hot' : ''}`}
                    key={session.id}
                  >
                    <div className="timeline-time">
                      <span>{session.clipName}</span>
                      <small>{session.status}</small>
                    </div>
                    <div className="timeline-item__body">
                      <p>
                        Peak {formatPercent(session.maxHesitationScore)} · longest pause{' '}
                        {formatDurationMs(session.longestPauseMs)} · {session.assistCount} prompt
                        {session.assistCount === 1 ? '' : 's'}
                      </p>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => void loadSessionReview(session.id)}
                      >
                        {selectedReviewSessionId === session.id ? 'Reload review' : 'Open session'}
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <p className="transcript-line transcript-line--muted">
                  End a live session to save a completed run here.
                </p>
              )}
            </div>
          </section>

          <section className="panel review-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker"><span className="panel-kicker__icon" aria-hidden="true">📋</span>Session review</p>
                <h2>{latestCompletedSession?.clipName ?? 'No session selected'}</h2>
                <p className="panel-copy">
                  {latestCompletedSession
                    ? 'Saved trace and model review, side by side.'
                    : 'Choose a completed session to inspect its saved signals and review.'}
                </p>
              </div>
              <span className="panel-tag">{reviewStatusLabel}</span>
            </div>

            {latestCompletedSession ? (
              <>
                <div className="booth-summary booth-summary--review">
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
                    <p className="control-label">Prompts</p>
                    <strong>{latestCompletedSession.assistCount}</strong>
                  </div>
                </div>

                <div className="inline-actions inline-actions--compact review-actions">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void loadSessionReview(latestCompletedSession.id)}
                  >
                    Reload AI review
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setAppView('live')}
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
                            <p className="memory-title">Saved trace</p>
                            <h3>{postSessionReview.headline}</h3>
                          </div>
                          <span className="panel-tag">Session data</span>
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
                          <p className="memory-title">AI review</p>
                          <h3>
                            {latestCompletedSessionReview?.headline ??
                              (isLoadingReview ? 'Analyzing hesitation trace' : 'Awaiting AI review')}
                          </h3>
                        </div>
                        <span className="panel-tag">
                          {latestCompletedSessionReview ? 'OpenAI' : isLoadingReview ? 'Loading' : 'Pending'}
                        </span>
                      </div>
                      <p className="field-copy field-copy--tight">
                        {latestCompletedSessionReview?.summary ??
                          (isLoadingReview
                            ? 'AndOne is generating a grounded review from the saved booth session record.'
                            : 'Reload the session review to fetch the latest OpenAI analysis.')}
                      </p>
                    </div>

                    {isLoadingReview ? (
                      <div className="review-loading-card" aria-live="polite">
                        <div className="review-loading-spinner" aria-hidden="true" />
                        <div>
                          <strong>OpenAI analysis in progress</strong>
                          <p>The saved session trace is already here. The model review will slot in as soon as it returns.</p>
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
                          <strong>No AI review loaded yet</strong>
                          <p>The session metrics are real and saved. Use “Reload AI review” to fetch the model-written analysis.</p>
                        </div>
                      </div>
                    )}
                  </section>
                </div>
              </>
            ) : (
              <p className="transcript-line transcript-line--muted">
                Pick a saved session to inspect its hesitation trace and AI review.
              </p>
            )}
          </section>
        </div>
      )}

    </div>
  );
}

export default App;
