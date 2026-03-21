import { startTransition, useEffect, useRef, useState } from 'react';
import {
  BoothFeatureSnapshot,
  BoothInterpretation,
  BoothSessionAnalytics,
  BoothSessionRecord,
  BoothSessionReview,
  BoothSessionSummary,
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
  interpretBooth,
  startBoothSession,
  transcribeBoothAudio,
  updateControlState,
} from './api';
import { buildBoothAssist } from './boothAssist';
import {
  LOCAL_TRANSCRIPT_LIMIT,
  LIVE_HESITATION_GATE,
  LONG_PAUSE_START_MS,
  BoothSignal,
  buildBoothSignal,
  calculateAudioLevel,
  deriveBoothActivity,
} from './boothSignal';
import {
  TEAM_META,
  createInitialWorldState,
  formatDurationMs,
  formatEventType,
  formatMomentum,
  formatPercent,
  parseClock,
} from './dashboard';
import {
  ProgramFeedSlotId,
  StoredProgramFeed,
  clearProgramFeed,
  listStoredProgramFeeds,
  saveProgramFeed,
} from './feedLibrary';

type MicrophoneAvailability = 'supported' | 'degraded' | 'unsupported';
type CoachingTone = 'standby' | 'steady' | 'supporting' | 'step-in';
type AssistVisibilityPhase = 'hidden' | 'live' | 'weaning';

const AUDIO_ACTIVITY_SAMPLE_MS = 120;
const MIN_AUDIO_ACTIVITY_THRESHOLD = 0.012;
const MAX_AUDIO_ACTIVITY_THRESHOLD = 0.08;
const ASSIST_WEAN_OFF_MS = 2600;
const PROGRAM_FEED_SLOTS: Array<{ id: ProgramFeedSlotId; label: string; tone: string }> = [
  { id: 'program-a', label: 'Channel 1', tone: 'Match feed' },
  { id: 'program-b', label: 'Channel 2', tone: 'Studio return' },
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

function safelyPlayVideo(videoElement: HTMLVideoElement, onBlocked: () => void) {
  const playResult = videoElement.play();

  if (playResult && typeof playResult.catch === 'function') {
    void playResult.catch(onBlocked);
  }
}

function formatFormRecord(
  form: {
    record: { wins: number; draws: number; losses: number };
    lastFive: Array<unknown>;
  },
) {
  return `${form.record.wins}-${form.record.draws}-${form.record.losses} (${form.lastFive.length})`;
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

  const learningNotes = [
    topTrigger === 'pause'
      ? 'Long pauses are still the strongest cue. The handoff should arrive earlier as silence grows.'
      : `The booth most often reacted to ${topTrigger} moments in this session.`,
    topFiller
      ? `Your most common filler was "${topFiller}". That is now part of the personal hesitation profile.`
      : 'Filler language stayed relatively clean in this run.',
    recoveryMoments > 0
      ? `And-One detected ${recoveryMoments} recovery moment${recoveryMoments === 1 ? '' : 's'} where it could back off.`
      : 'Recovery never stabilized long enough to trigger a confident back-off moment.',
  ];

  return {
    headline: 'Session review is ready.',
    summary: `Saved ${session.sampleCount} live samples and ${session.assistCount} assist moment${
      session.assistCount === 1 ? '' : 's'
    } for this run.`,
    metrics: [
      { label: 'Peak hesitation', value: formatPercent(session.maxHesitationScore) },
      { label: 'Longest pause', value: formatDurationMs(session.longestPauseMs) },
      { label: 'Avg live pause', value: formatDurationMs(Math.round(averagePause)) },
      { label: 'Avg transcript stability', value: formatPercent(averageStability) },
      { label: 'Avg filler density', value: formatPercent(averageFillerDensity) },
      { label: 'Recovery moments', value: String(recoveryMoments) },
    ],
    learningNotes,
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
      headline: 'System standing by.',
      copy: 'Nothing appears on the feed until the session is live.',
    };
  }

  if (shouldSurfaceAssist) {
    return {
      tone: 'step-in' as CoachingTone,
      label: 'Stepping in',
      headline: 'Assist live on this beat.',
      copy: 'The pause has gone long enough to justify a prompt.',
    };
  }

  if (!boothHasLiveInput) {
    return {
      tone: 'standby' as CoachingTone,
      label: 'Listening',
      headline: 'Waiting for your first line.',
      copy: 'Start calling the action and And-One will listen for a real pause.',
    };
  }

  if (boothSignal.isSpeaking && boothSignal.confidenceScore >= 0.68 && boothSignal.hesitationScore < 0.18) {
    return {
      tone: 'steady' as CoachingTone,
      label: 'Backing off',
      headline: 'You are back in rhythm.',
      copy: 'The cue fades while your delivery is stable again.',
    };
  }

  return {
    tone: 'supporting' as CoachingTone,
    label: 'Hovering',
    headline: 'And-One is tracking the beat.',
    copy: 'The booth is active, but the pause is not strong enough to step in yet.',
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
  const [boothAnalytics, setBoothAnalytics] = useState<BoothSessionAnalytics>({
    totalSessions: 0,
    completedSessions: 0,
    averageMaxHesitationScore: 0,
    averageLongestPauseMs: 0,
    totalAssistCount: 0,
  });
  const [, setRecentBoothSessions] = useState<BoothSessionSummary[]>([]);
  const [latestCompletedSession, setLatestCompletedSession] = useState<BoothSessionRecord | null>(null);
  const [latestCompletedSessionReview, setLatestCompletedSessionReview] =
    useState<BoothSessionReview | null>(null);
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
  const [showDetails, setShowDetails] = useState(false);
  const [boothTranscript, setBoothTranscript] = useState<TranscriptEntry[]>([]);
  const [boothInterimTranscript, setBoothInterimTranscript] = useState('');
  const [boothError, setBoothError] = useState<string | null>(null);
  const [latchedAssist, setLatchedAssist] = useState(() => createEmptyAssistCard());
  const [assistVisibilityPhase, setAssistVisibilityPhase] =
    useState<AssistVisibilityPhase>('hidden');
  const [isMicListening, setIsMicListening] = useState(false);
  const [isMicPrepared, setIsMicPrepared] = useState(false);
  const [isMicPreparing, setIsMicPreparing] = useState(false);
  const [lastSpeechAtMs, setLastSpeechAtMs] = useState(-1);
  const [lastVoiceActivityAtMs, setLastVoiceActivityAtMs] = useState(-1);
  const [speechStreakStartedAtMs, setSpeechStreakStartedAtMs] = useState(-1);
  const [silenceStreakStartedAtMs, setSilenceStreakStartedAtMs] = useState(-1);
  const [audioLevel, setAudioLevel] = useState(0);
  const [boothClockMs, setBoothClockMs] = useState(() => Date.now());
  const [boothInterpretation, setBoothInterpretation] = useState<BoothInterpretation | null>(null);
  const [microphoneAvailability, setMicrophoneAvailability] =
    useState<MicrophoneAvailability>('supported');
  const shouldKeepMicLiveRef = useRef(false);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioMonitorIntervalRef = useRef<number | null>(null);
  const realtimePeerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const realtimeDataChannelRef = useRef<RTCDataChannel | null>(null);
  const bufferedRecorderRef = useRef<MediaRecorder | null>(null);
  const bufferedTranscriptionQueueRef = useRef(Promise.resolve());
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

    void listStoredProgramFeeds().then((feeds) => {
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

      const firstAvailable = PROGRAM_FEED_SLOTS.find((slot) => nextFeeds[slot.id]);
      if (firstAvailable && nextFeeds[firstAvailable.id]) {
        const blob = nextFeeds[firstAvailable.id]?.blob;
        if (blob) {
          if (clipObjectUrlRef.current) {
            URL.revokeObjectURL(clipObjectUrlRef.current);
          }
          const nextUrl = URL.createObjectURL(blob);
          clipObjectUrlRef.current = nextUrl;
          setSelectedProgramFeedId(firstAvailable.id);
          setLoadedClipUrl(nextUrl);
          setLoadedClipName(nextFeeds[firstAvailable.id]?.fileName ?? '');
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
          setBoothAnalytics(nextBoothSessions.analytics);
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

    if (controls.playbackStatus === 'playing') {
      safelyPlayVideo(videoRef.current, () => {
        setBoothError('Press play on the loaded clip if the browser blocks autoplay.');
      });
      return;
    }

    videoRef.current.pause();
  }, [controls.playbackStatus, loadedClipUrl]);

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

    if (controls.playbackStatus === 'playing') {
      safelyPlayVideo(videoRef.current, () => {
        setBoothError('Press play on the loaded clip if the browser blocks autoplay.');
      });
    }
  }, [controls.playbackStatus, controls.restartToken]);

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
  }

  async function refreshBoothSessions() {
    try {
      const nextBoothSessions = await fetchBoothSessions();
      setBoothAnalytics(nextBoothSessions.analytics);
      setRecentBoothSessions(nextBoothSessions.sessions);
    } catch (_error) {
      // Keep the live booth usable even if session analytics are unavailable.
    }
  }

  async function finalizeBoothSession() {
    if (!activeBoothSessionId) {
      return;
    }

    try {
      const response = await finishBoothSession(activeBoothSessionId);
      const completedSession = await fetchBoothSession(response.session.id);
      setLatestCompletedSession(completedSession.session);
      const review = await fetchBoothSessionReview(response.session.id);
      setLatestCompletedSessionReview(review.review);
      await refreshBoothSessions();
    } catch (_error) {
      setBoothError('The booth session could not be finalized in the local store.');
    } finally {
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
            return;
          }

          const baseTimestamp = getCurrentTranscriptTimestamp();
          setBoothTranscript((current) =>
            [...current, createTranscriptEntry(baseTimestamp, transcriptText)].slice(
              -LOCAL_TRANSCRIPT_LIMIT,
            ),
          );
          setBoothInterimTranscript('');
          setLastSpeechAtMs(now);
          setLastVoiceActivityAtMs(now);
          setBoothClockMs(now);
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

    const recorder = new window.MediaRecorder(stream, { mimeType });
    bufferedRecorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) {
        return;
      }

      bufferedTranscriptionQueueRef.current = bufferedTranscriptionQueueRef.current
        .then(async () => {
          const audioBase64 = await encodeBlobAsBase64(event.data);
          const result = await transcribeBoothAudio(audioBase64, recorder.mimeType || mimeType);

          if (result.source !== 'openai' || !result.transcript.trim()) {
            return;
          }

          const transcriptText = result.transcript.trim();
          const now = Date.now();
          const baseTimestamp = getCurrentTranscriptTimestamp();

          setBoothTranscript((current) =>
            [...current, createTranscriptEntry(baseTimestamp, transcriptText)].slice(
              -LOCAL_TRANSCRIPT_LIMIT,
            ),
          );
          setBoothInterimTranscript('');
          setLastSpeechAtMs(now);
          setLastVoiceActivityAtMs(now);
          setBoothClockMs(now);
        })
        .catch(() => {
          // Keep booth flow alive if a buffered chunk fails.
        });
    };

    recorder.onstop = () => {
      bufferedRecorderRef.current = null;
    };

    recorder.start(1_500);
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
    setAudioLevel(0);
    setSpeechStreakStartedAtMs(-1);
    setSilenceStreakStartedAtMs(-1);
  }

  async function loadProgramFeed(slotId: ProgramFeedSlotId, feed: StoredProgramFeed) {
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
        'This browser cannot run the live And-One booth stack. Use a browser with getUserMedia, AudioContext, and RTCPeerConnection support.',
      );
      return;
    }

    shouldKeepMicLiveRef.current = true;
    setBoothError(null);
    setIsMicListening(true);
    setBoothClockMs(Date.now());

    void startAudioMonitoring()
      .then((stream) => {
        setMicrophoneAvailability('supported');
        setIsMicPrepared(true);

        if (stream) {
          void startRealtimeTranscription(stream).catch(() => {
            const startedBufferedFallback = startBufferedTranscription(stream);

            if (startedBufferedFallback) {
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
    setBoothError(null);
  }

  function clearLiveBoothState() {
    clearBoothTranscript();
    setBoothInterpretation(null);
    setLatchedAssist(createEmptyAssistCard());
    setAssistVisibilityPhase('hidden');
  }

  async function startBroadcast() {
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
        await refreshBoothSessions();
      } catch (_error) {
        setBoothError('The booth session could not be saved, but the live session can still run.');
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

  async function resetBroadcast() {
    await stopBroadcast();
    await sendControlPatch({ restart: true });
  }

  const assist = worldState.assist;
  const homeCode = worldState.liveMatch.homeTeam.shortCode || TEAM_META.home.code;
  const awayCode = worldState.liveMatch.awayTeam.shortCode || TEAM_META.away.code;
  const homeCards =
    worldState.liveMatch.cards.find((entry) => entry.teamSide === 'home') ?? {
      teamSide: 'home',
      yellow: 0,
      red: 0,
    };
  const awayCards =
    worldState.liveMatch.cards.find((entry) => entry.teamSide === 'away') ?? {
      teamSide: 'away',
      yellow: 0,
      red: 0,
    };
  const substitutions = [...worldState.liveMatch.substitutions].reverse();
  const lineupSummary = worldState.liveMatch.lineups;
  const statSummary = worldState.liveMatch.stats.slice(0, 8);
  const recentEvents = [...worldState.recentEvents].reverse();
  const surfacedAssists = [...worldState.sessionMemory.surfacedAssists].reverse();
  const isMicSupported =
    microphoneAvailability !== 'unsupported' && supportsAudioMonitoring();
  const isSystemReady = isHydrated && !error;
  const isBroadcastReady = Boolean(loadedClipUrl) && isSystemReady;
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
  const boothHasLiveInput =
    hasStartedBroadcast &&
    (isMicListening || boothTranscript.length > 0 || boothInterimTranscript.length > 0);
  const boothAssist = buildBoothAssist({
    boothSignal,
    boothTranscript,
    interimTranscript: boothInterimTranscript,
    retrieval: worldState.retrieval,
    preMatch: worldState.preMatch,
    liveMatch: worldState.liveMatch,
    socialPosts: worldState.liveSignals.social,
    recentEvents: worldState.recentEvents,
  });
  const liveBoothShouldSurfaceAssist = boothInterpretation?.shouldSurfaceAssist ?? boothSignal.shouldSurfaceAssist;
  const workerAssistShouldSurface =
    assist.type !== 'none' &&
    (controls.forceHesitation ||
      (!boothHasLiveInput && worldState.commentator.hesitationScore >= LIVE_HESITATION_GATE));
  const boothAssistShouldSurface =
    boothHasLiveInput &&
    liveBoothShouldSurfaceAssist &&
    boothAssist.type !== 'none';
  const nextTriggeredAssist = boothAssistShouldSurface
    ? boothAssist
    : workerAssistShouldSurface
      ? assist
      : null;
  const activeAssist = latchedAssist;
  const shouldSurfaceAssist = activeAssist.type !== 'none' && assistVisibilityPhase !== 'hidden';
  const isAssistWeaning = assistVisibilityPhase === 'weaning';
  const assistConfidencePercent = formatPercent(shouldSurfaceAssist ? activeAssist.confidence : 0);
  const boothHesitationPercent = formatPercent(
    boothInterpretation?.hesitationScore ?? boothSignal.hesitationScore,
  );
  const visibleReasons =
    boothInterpretation?.reasons && boothInterpretation.reasons.length > 0
      ? boothInterpretation.reasons
      : boothSignal.hesitationReasons.length > 0
        ? boothSignal.hesitationReasons
        : ['Waiting for the live booth model to classify the current moment.'];
  const coachingTone = getCoachingTone({
    hasStartedBroadcast,
    boothHasLiveInput,
    boothSignal: {
      ...boothSignal,
      hesitationScore: boothInterpretation?.hesitationScore ?? 0,
      confidenceScore: boothInterpretation?.recoveryScore ?? boothSignal.confidenceScore,
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
          : 'And-One will request access when you go live.',
    },
    {
      label: 'System linked',
      done: isSystemReady,
      detail: isSystemReady ? 'The hosted backend is reachable.' : 'Waiting for the backend connection.',
    },
  ];
  const clipClockLabel = formatDurationMs(clipPositionMs);
  const clipDurationLabel = clipDurationMs > 0 ? formatDurationMs(clipDurationMs) : '--:--';
  const clipProgress = clipDurationMs > 0 ? Math.min(100, Math.round((clipPositionMs / clipDurationMs) * 100)) : 0;
  const isBroadcastLive =
    hasStartedBroadcast && (controls.playbackStatus === 'playing' || isMicListening);
  const selectedProgramSlot = PROGRAM_FEED_SLOTS.find((slot) => slot.id === selectedProgramFeedId) ?? null;
  const feedHeading = selectedProgramSlot
    ? `${selectedProgramSlot.label} · ${loadedClipName}`
    : 'Select a program feed';
  const replayToastSignature = `${activeAssist.type}:${activeAssist.text}:${shouldSurfaceAssist}:${controls.restartToken}`;
  const activeTriggerBadges = [
    boothSignal.pauseDurationMs >= LONG_PAUSE_START_MS ? 'pause' : null,
    boothSignal.fillerCount > 0 ? 'filler' : null,
    boothSignal.repeatedOpeningCount > 0 ? 'repeat-start' : null,
    boothSignal.unfinishedPhrase ? 'unfinished' : null,
  ].filter(Boolean) as string[];
  const primaryActionLabel = isBroadcastLive ? 'End live session' : 'Go live';
  const primaryActionDisabled = !isBroadcastLive && (!isBroadcastReady || isUpdatingControls);
  const guidanceSummary = isAssistWeaning
    ? 'You are back in rhythm. The cue is fading out.'
    : shouldSurfaceAssist
      ? activeAssist.whyNow
      : boothInterpretation?.summary
        ? boothInterpretation.summary
        : coachingTone.tone === 'steady'
          ? 'Hesitation is falling. And-One is backing off.'
          : coachingTone.copy;
  const activeAssistSupportCopy = isAssistWeaning
    ? 'You are back in rhythm. And-One is slipping the cue away.'
    : activeAssist.whyNow;
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
  const resolvedPostSessionReview =
    latestCompletedSessionReview ??
    (postSessionReview
      ? {
          headline: postSessionReview.headline,
          summary: postSessionReview.summary,
          strengths: [postSessionReview.learningNotes[0] ?? 'Session data is available for review.'],
          watchouts: [postSessionReview.learningNotes[1] ?? 'No major watchouts recorded.'],
          coachingNotes: [postSessionReview.learningNotes[2] ?? 'Review the saved session before the next run.'],
        }
      : null);

  useEffect(() => {
    if (!hasStartedBroadcast) {
      if (latchedAssist.type !== 'none') {
        setLatchedAssist(createEmptyAssistCard());
      }
      if (assistVisibilityPhase !== 'hidden') {
        setAssistVisibilityPhase('hidden');
      }
      return;
    }

    if (
      nextTriggeredAssist &&
      (latchedAssist.type === 'none' ||
        latchedAssist.text !== nextTriggeredAssist.text ||
        latchedAssist.whyNow !== nextTriggeredAssist.whyNow)
    ) {
      setLatchedAssist(nextTriggeredAssist);
      setAssistVisibilityPhase('live');
      return;
    }

    if (!nextTriggeredAssist && latchedAssist.type !== 'none') {
      setAssistVisibilityPhase((current) => (current === 'hidden' ? 'hidden' : 'weaning'));
    }
  }, [
    assistVisibilityPhase,
    hasStartedBroadcast,
    latchedAssist.text,
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
      hesitationScore: boothInterpretation?.hesitationScore ?? boothSignal.hesitationScore,
      confidenceScore: boothInterpretation?.recoveryScore ?? boothSignal.confidenceScore,
      pauseDurationMs: boothSignal.pauseDurationMs,
      audioLevel: boothSignal.audioLevel,
      isSpeaking: boothSignal.isSpeaking,
      triggerBadges: activeTriggerBadges,
      activeAssistText: shouldSurfaceAssist ? activeAssist.text : null,
      featureSnapshot: {
        timestamp: boothClockMs,
        hesitationScore: boothInterpretation?.hesitationScore ?? 0,
        confidenceScore: boothInterpretation?.recoveryScore ?? 0,
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
        unfinishedPhrase: boothSignal.unfinishedPhrase,
        transcriptWordCount: boothSignal.transcriptWordCount,
        transcriptStabilityScore: boothSignal.transcriptStabilityScore,
        hesitationReasons: boothSignal.hesitationReasons,
        transcriptWindow: boothTranscript.slice(-LOCAL_TRANSCRIPT_LIMIT),
        interimTranscript: boothInterimTranscript,
        contextSummary: buildContextSummary(worldState),
        expectedTopics: buildExpectedTopics(worldState),
        previousState: boothInterpretation?.state,
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

    const hasTranscriptContext =
      boothTranscript.length > 0 ||
      boothInterimTranscript.trim().length > 0 ||
      boothSignal.pauseDurationMs >= LONG_PAUSE_START_MS;

    if (!hasTranscriptContext) {
      return;
    }

    const features: BoothFeatureSnapshot = {
      timestamp: boothClockMs,
      hesitationScore: 0,
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
      unfinishedPhrase: boothSignal.unfinishedPhrase,
      transcriptWordCount: boothSignal.transcriptWordCount,
      transcriptStabilityScore: boothSignal.transcriptStabilityScore,
      hesitationReasons: boothSignal.hesitationReasons,
      transcriptWindow: boothTranscript.slice(-LOCAL_TRANSCRIPT_LIMIT),
      interimTranscript: boothInterimTranscript,
      contextSummary: buildContextSummary(worldState),
      expectedTopics: buildExpectedTopics(worldState),
      previousState: boothInterpretation?.state,
    };

    const timeoutId = window.setTimeout(() => {
      void interpretBooth(features)
        .then((nextInterpretation) => {
          setBoothInterpretation(nextInterpretation);
          setBoothError(null);
        })
        .catch(() => {
          // Keep the local booth flow running even if interpretation is unavailable.
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
      worldState,
      hasStartedBroadcast,
      isMicListening,
      boothInterpretation?.state,
  ]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <p className="eyebrow">{BRAND.eyebrow}</p>
          <h1>{BRAND.heroTitle}</h1>
        </div>

        <div className="header-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={() => setShowDetails((current) => !current)}
          >
            {showDetails ? 'Hide Details' : 'Show Details'}
          </button>
        </div>
      </header>

      {error ? <div className="warning-banner">{error}</div> : null}

      <div className="main-grid">
        <section className="panel replay-panel stage-panel">
          <div className="panel-header panel-header--stage">
            <div>
              <p className="panel-kicker">Program</p>
              <h2>{feedHeading}</h2>
            </div>
            <div className="panel-chip-row">
              <span className="panel-tag">{loadedClipUrl ? `${clipClockLabel} / ${clipDurationLabel}` : 'Awaiting upload'}</span>
            </div>
          </div>

          <div className="media-toolbar">
            <div className="feed-switcher" role="group" aria-label="Program feeds">
              {PROGRAM_FEED_SLOTS.map((slot) => {
                const feed = storedProgramFeeds[slot.id];
                const isSelected = selectedProgramFeedId === slot.id;

                return (
                  <article
                    key={slot.id}
                    className={`feed-switcher__slot ${isSelected ? 'feed-switcher__slot--selected' : ''}`}
                  >
                    <div className="feed-switcher__copy">
                      <span className="feed-switcher__label">{slot.label}</span>
                      <strong>{feed ? feed.fileName : 'No reel loaded'}</strong>
                      <small>{slot.tone}</small>
                    </div>
                    <div className="feed-switcher__actions">
                      {feed ? (
                        <button
                          type="button"
                          className={isSelected ? 'ghost-button ghost-button--active' : 'ghost-button'}
                          onClick={() => void loadProgramFeed(slot.id, feed)}
                        >
                          {isSelected ? 'On deck' : 'Take feed'}
                        </button>
                      ) : null}
                      <label className="file-chip file-chip--slot">
                        <span>{feed ? 'Replace reel' : 'Load reel'}</span>
                        <input
                          type="file"
                          accept="video/*"
                          onChange={(event) => void handleProgramFeedChange(slot.id, event)}
                        />
                      </label>
                      {feed ? (
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
                {selectedProgramSlot ? `${selectedProgramSlot.label} selected` : 'No program feed selected'}
              </span>
              <span className="meta-pill">{loadedClipName || 'Load a saved reel into Channel 1 or Channel 2'}</span>
              {loadedClipUrl ? (
                <span className="meta-pill">{isClipMuted ? 'Clip audio muted' : 'Clip audio on'}</span>
              ) : null}
            </div>
            {loadedClipUrl ? (
              <>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setIsClipMuted((current) => !current)}
                >
                  {isClipMuted ? 'Monitor clip audio' : 'Mute clip audio'}
                </button>
              </>
            ) : null}
          </div>

          <div className={`replay-stage ${loadedClipUrl ? 'replay-stage--video' : ''}`}>
            {loadedClipUrl ? (
              <video
                ref={videoRef}
                className="replay-video"
                src={loadedClipUrl}
                playsInline
                controls
                muted={isClipMuted}
                onLoadedMetadata={(event) => {
                  setClipDurationMs(Math.round(event.currentTarget.duration * 1_000));
                }}
                onTimeUpdate={(event) => {
                  setClipPositionMs(Math.round(event.currentTarget.currentTime * 1_000));
                }}
              />
            ) : (
              <div className="replay-stage__scrim" />
            )}

            <div className="replay-stage__overlay" />

            <div className="replay-stage__content">
              <div className="replay-copy">
                <span className="live-chip">{loadedClipUrl ? 'Clip ready' : 'Ready for upload'}</span>
                <h3>
                  {loadedClipUrl
                    ? hasStartedBroadcast
                      ? coachingTone.headline
                      : resolvedPostSessionReview
                        ? resolvedPostSessionReview.headline
                      : 'Go live and And-One will request microphone access if needed.'
                    : 'Load a reel into Channel 1 or Channel 2 to begin.'}
                </h3>
              </div>

              {shouldSurfaceAssist ? (
                <article
                  className={`replay-toast ${
                    isAssistWeaning ? 'replay-toast--weaning' : 'replay-toast--live'
                  }`}
                  key={replayToastSignature}
                >
                  <p className="assist-type">Assist</p>
                  <h3>{activeAssist.text}</h3>
                  <p>{activeAssistSupportCopy}</p>
                </article>
              ) : boothHasLiveInput ? (
                <div className="replay-toast replay-toast--hint">
                  <p className="assist-type">Monitoring</p>
                  <h3>Mic is live.</h3>
                </div>
              ) : loadedClipUrl && !hasStartedBroadcast ? (
                <div className="replay-toast replay-toast--hint">
                  <p className="assist-type">Preflight</p>
                  <h3>Go live when the desk is ready.</h3>
                </div>
              ) : null}

              <div className="replay-tags">
                {activeTriggerBadges.length > 0 ? (
                  activeTriggerBadges.map((badge) => (
                    <span className="scene-chip" key={badge}>
                      {badge}
                    </span>
                  ))
                ) : (
                  <span className="scene-chip scene-chip--muted">Waiting for hesitation cue</span>
                )}
              </div>

              <div className="replay-footer">
                <div className={`coach-lane coach-lane--${coachingTone.tone}`}>
                  <strong>{coachingTone.headline}</strong>
                </div>
                <div className="progress-track" aria-label="Replay progress">
                  <span style={{ width: `${clipProgress}%` }} />
                </div>
                <p className="pulse-copy">{guidanceSummary}</p>
              </div>
            </div>
          </div>
        </section>

        <div className="side-column">
          <section className={`panel control-panel control-panel--${coachingTone.tone}`}>
            <div className="panel-header panel-header--compact">
              <div>
                <p className="panel-kicker">Session</p>
                <h2>Live control</h2>
              </div>
            </div>

            <div className="readiness-list">
              {readinessChecks.map((check) => (
                <div key={check.label} className={`readiness-row ${check.done ? 'readiness-row--done' : ''}`}>
                  <span className={`readiness-dot ${check.done ? 'readiness-dot--done' : ''}`} />
                  <div className="readiness-copy">
                    <strong>{check.label}</strong>
                    <span>{check.detail}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="setup-actions">
              <button
                type="button"
                className={isBroadcastLive ? 'is-active' : ''}
                disabled={primaryActionDisabled}
                onClick={() => void (isBroadcastLive ? stopBroadcast() : startBroadcast())}
              >
                {primaryActionLabel}
              </button>
            </div>

            {boothError ? <p className="inline-warning">{boothError}</p> : null}

            <article className={`booth-card booth-card--${coachingTone.tone}`}>
              <div className="booth-card__header">
                <div>
                  <p className="control-label">Status</p>
                  <strong>{coachingTone.headline}</strong>
                </div>
              </div>

              <p className="field-copy field-copy--tight">{guidanceSummary}</p>

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
                  <span>Assist state</span>
                  <strong>{assistStateLabel}</strong>
                </div>
              </div>

              <div className="reason-list">
                {visibleReasons.slice(0, 2).map((reason) => (
                  <p key={reason}>{reason}</p>
                ))}
              </div>

              <p className="field-copy">
                The clip stays muted by default so the booth tracks your voice, not the program feed.
              </p>
              {boothError ? <p className="inline-warning">{boothError}</p> : null}
            </article>

            {!hasStartedBroadcast && resolvedPostSessionReview ? (
              <article className="session-review-card">
                <div className="panel-header panel-header--compact">
                  <div>
                    <p className="control-label">Saved review</p>
                    <h3>Post-session analytics</h3>
                  </div>
                  <span className="panel-tag">Stored in DB</span>
                </div>

                <p className="field-copy field-copy--tight">{resolvedPostSessionReview.summary}</p>

                <div className="commentary-metadata commentary-metadata--review">
                  {(postSessionReview?.metrics ?? []).map((metric) => (
                    <div key={metric.label}>
                      <p className="control-label">{metric.label}</p>
                      <strong>{metric.value}</strong>
                    </div>
                  ))}
                </div>

                <div className="reason-list">
                  {resolvedPostSessionReview.strengths.map((note) => (
                    <p key={`strength-${note}`}>{note}</p>
                  ))}
                </div>

                <div className="reason-list">
                  {resolvedPostSessionReview.watchouts.map((note) => (
                    <p key={`watchout-${note}`}>{note}</p>
                  ))}
                </div>

                <div className="reason-list">
                  {resolvedPostSessionReview.coachingNotes.map((note) => (
                    <p key={`coach-${note}`}>{note}</p>
                  ))}
                </div>
              </article>
            ) : null}

            <div className="inline-actions inline-actions--compact">
              <button type="button" className="text-button" onClick={() => void resetBroadcast()}>
                Reset live session
              </button>
              <button type="button" className="text-button" onClick={clearBoothTranscript}>
                Clear transcript
              </button>
            </div>
          </section>

        </div>
      </div>

      {showDetails ? (
        <div className="bottom-grid">
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Context stash</p>
              <h2>Prematch and retrieval context</h2>
            </div>
            <span className="panel-tag">{worldState.preMatch.loadStatus}</span>
          </div>

          <div className="narrative-focus">
            <p className="narrative-label">Opening read</p>
            <h3>{worldState.preMatch.aiOpener ?? worldState.preMatch.deterministicOpener}</h3>
            <p>Kept here for context and later hint generation, not on the live operator surface.</p>
          </div>

          <div className="narrative-stack">
            <span className="stack-chip">
              {worldState.liveMatch.homeTeam.shortCode || 'HOME'} form {formatFormRecord(worldState.preMatch.homeRecentForm)}
            </span>
            <span className="stack-chip">
              {worldState.liveMatch.awayTeam.shortCode || 'AWAY'} form {formatFormRecord(worldState.preMatch.awayRecentForm)}
            </span>
            <span className="stack-chip">{worldState.preMatch.venue.name}</span>
            <span className="stack-chip">
              {worldState.preMatch.weather?.summary ?? 'Weather unavailable'}
            </span>
          </div>

          <div className="memory-strip">
            <p className="memory-title">Stored context</p>
            <div className="session-context-grid">
              <article className="context-card context-card--wide">
                <p className="context-label">Head to head</p>
                <p className="context-value">{worldState.preMatch.headToHead.summary}</p>
              </article>
              <article className="context-card">
                <p className="context-label">Venue</p>
                <p className="context-value">
                  {[
                    worldState.preMatch.venue.name,
                    worldState.preMatch.venue.city,
                    worldState.preMatch.venue.country,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </p>
              </article>
              <article className="context-card">
                <p className="context-label">Weather</p>
                <p className="context-value">
                  {worldState.preMatch.weather
                    ? `${worldState.preMatch.weather.summary}${
                        worldState.preMatch.weather.temperatureC !== null
                          ? ` · ${Math.round(worldState.preMatch.weather.temperatureC)}C`
                          : ''
                      }`
                    : 'Unavailable'}
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Details</p>
              <h2>Live trace</h2>
            </div>
            <span className="panel-tag">{boothHesitationPercent}</span>
          </div>

          <div className="timeline-list">
            {recentEvents.length > 0 ? (
              recentEvents.map((event) => (
                <article
                  className={`timeline-item ${event.highSalience ? 'timeline-item--hot' : ''}`}
                  key={event.id}
                >
                  <div className="timeline-time">
                    <span>{event.matchTime}</span>
                    <small>{formatEventType(event.type)}</small>
                  </div>
                  <p>{event.description}</p>
                </article>
              ))
            ) : (
              <p className="empty-copy">Recent match events will roll in here as the live feed advances.</p>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Live Match</p>
              <h2>Cards, substitutions, and lineups</h2>
            </div>
            <span className="panel-tag">{worldState.liveMatch.status.replace(/_/g, ' ')}</span>
          </div>

          <div className="narrative-focus">
            <p className="narrative-label">Cards</p>
            <h3>
              {homeCode} {homeCards.yellow}Y/{homeCards.red}R · {awayCode} {awayCards.yellow}Y/{awayCards.red}R
            </h3>
            <p>{substitutions.length} substitutions tracked</p>
          </div>

          <div className="narrative-stack">
            {substitutions.length > 0 ? (
              substitutions.slice(0, 4).map((substitution) => (
                <span className="stack-chip" key={substitution.id}>
                  {substitution.matchTime} {substitution.playerOn} for {substitution.playerOff}
                </span>
              ))
            ) : (
              <span className="stack-chip stack-chip--muted">Substitutions will appear here.</span>
            )}
          </div>

          <div className="memory-strip">
            <p className="memory-title">Projected starters</p>
            {lineupSummary.length > 0 ? (
              lineupSummary.map((lineup) => (
                <p className="memory-line" key={lineup.teamSide}>
                  {lineup.teamName}: {lineup.formation ?? 'formation TBD'} · {lineup.startingXI.length} starters
                </p>
              ))
            ) : (
              <p className="memory-line">Lineups will populate once Sportmonks returns them.</p>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Narrative Stack</p>
              <h2>Storylines and stats</h2>
            </div>
            <span className="panel-tag">{formatMomentum(worldState.narrative.momentum)}</span>
          </div>

          <div className="narrative-focus">
            <p className="narrative-label">Top narrative</p>
            <h3>{worldState.narrative.topNarrative ?? 'No dominant thread yet.'}</h3>
            <p>{worldState.narrative.currentSentiment}</p>
          </div>

          <div className="narrative-stack">
            {worldState.narrative.activeNarratives.length > 0 ? (
              worldState.narrative.activeNarratives.map((narrative) => (
                <span className="stack-chip" key={narrative}>
                  {narrative}
                </span>
              ))
            ) : (
              <span className="stack-chip stack-chip--muted">Narratives will stack here.</span>
            )}
          </div>

          <div className="memory-strip">
            <p className="memory-title">Live team stats</p>
            {statSummary.length > 0 ? (
              statSummary.map((stat, index) => (
                <p className="memory-line" key={`${stat.teamSide}-${stat.label}-${index}`}>
                  {(stat.teamSide === 'home' ? homeCode : awayCode).toUpperCase()} {stat.label}: {stat.value}
                </p>
              ))
            ) : surfacedAssists.length > 0 ? (
              surfacedAssists.slice(0, 3).map((savedAssist) => (
                <p className="memory-line" key={`${savedAssist.type}:${savedAssist.text}`}>
                  {savedAssist.text}
                </p>
              ))
            ) : (
              <p className="memory-line">Stats will populate once the live feed returns them.</p>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Booth Metrics</p>
              <h2>Session analytics</h2>
            </div>
            <span className="panel-tag">{assistConfidencePercent}</span>
          </div>

          <div className="commentary-metadata">
            <div>
              <p className="control-label">Runs</p>
              <strong>{boothAnalytics.totalSessions}</strong>
            </div>
            <div>
              <p className="control-label">Avg hesitation</p>
              <strong>{formatPercent(boothAnalytics.averageMaxHesitationScore)}</strong>
            </div>
            <div>
              <p className="control-label">Longest pause</p>
              <strong>{formatDurationMs(boothAnalytics.averageLongestPauseMs)}</strong>
            </div>
            <div>
              <p className="control-label">Assists</p>
              <strong>{boothAnalytics.totalAssistCount}</strong>
            </div>
          </div>

          <div className="meter-cluster">
            <div>
              <div className="meter-label-row">
                <span>Hesitation</span>
                <strong>{boothHesitationPercent}</strong>
              </div>
              <div className="meter-track">
                <span style={{ width: boothHesitationPercent }} />
              </div>
            </div>
          </div>

          <div className="reason-list">
            {visibleReasons.map((reason) => (
              <p key={reason}>{reason}</p>
            ))}
          </div>

          {boothInterpretation?.signals && boothInterpretation.signals.length > 0 ? (
            <div className="commentary-metadata">
              {boothInterpretation.signals.map((signal) => (
                <div key={signal.key}>
                  <p className="control-label">{signal.label}</p>
                  <strong>{signal.detail}</strong>
                </div>
              ))}
            </div>
          ) : null}

          <div className="commentary-metadata">
            <div>
              <p className="control-label">Speaker state</p>
              <strong>{boothSignal.activeSpeaker}</strong>
            </div>
            <div>
              <p className="control-label">Pause</p>
              <strong>
                {Math.round(
                  ((boothHasLiveInput ? boothSignal.pauseDurationMs : worldState.commentator.pauseDurationMs) /
                    100) *
                    10,
                ) / 10}
                s
              </strong>
            </div>
            <div>
              <p className="control-label">Filler cues</p>
              <strong>{boothSignal.fillerWords.join(', ') || 'Clean'}</strong>
            </div>
            <div>
              <p className="control-label">Repeated opens</p>
              <strong>{boothSignal.repeatedPhrases[0] ?? 'None'}</strong>
            </div>
          </div>

          <div className="memory-strip">
            <p className="memory-title">Transcript</p>
            <div className="transcript-list">
              {boothTranscript.length > 0 ? (
                boothTranscript.slice(-5).map((entry) => (
                  <p className="transcript-line" key={`${entry.timestamp}-${entry.text}`}>
                    {entry.text}
                  </p>
                ))
              ) : (
                <p className="transcript-line transcript-line--muted">
                  {!loadedClipUrl
                    ? 'Attach a video first, then start the session.'
                    : !hasStartedBroadcast
                      ? 'Start the session to begin live mic tracking.'
                      : isMicSupported
                        ? 'Live transcript will appear here once you start speaking.'
                        : 'This browser does not expose usable mic APIs, so live hesitation is unavailable here.'}
                </p>
              )}
              {boothInterimTranscript ? (
                <p className="transcript-line transcript-line--interim">{boothInterimTranscript}</p>
              ) : null}
            </div>
          </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

export default App;
