import { startTransition, useEffect, useRef, useState } from 'react';
import {
  BoothFeatureSnapshot,
  BoothInterpretation,
  BoothSessionAnalytics,
  BoothSessionSummary,
  ReplayControlState,
  TranscriptEntry,
  createEmptyAssistCard,
} from '@sports-copilot/shared-types';
import './App.css';
import { BRAND } from './brand';
import {
  appendBoothSessionSample,
  fetchBoothSessions,
  fetchControlState,
  fetchWorldState,
  finishBoothSession,
  interpretBooth,
  startBoothSession,
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

type MicrophoneAvailability = 'supported' | 'degraded' | 'unsupported';
type CoachingTone = 'standby' | 'steady' | 'supporting' | 'step-in';

type SpeechRecognitionAlternativeLike = {
  transcript: string;
};

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionErrorEventLike = {
  error: string;
};

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

const AUDIO_ACTIVITY_SAMPLE_MS = 120;
const AUDIO_ACTIVITY_THRESHOLD = 0.045;

function getSpeechRecognitionConstructor() {
  if (typeof window === 'undefined') {
    return null;
  }

  const speechWindow = window as SpeechRecognitionWindow;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function supportsAudioMonitoring() {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof window.AudioContext !== 'undefined'
  );
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
  const [activeBoothSessionId, setActiveBoothSessionId] = useState<string | null>(null);
  const [loadedClipName, setLoadedClipName] = useState('');
  const [loadedClipUrl, setLoadedClipUrl] = useState<string | null>(null);
  const [clipPositionMs, setClipPositionMs] = useState(0);
  const [clipDurationMs, setClipDurationMs] = useState(0);
  const [isClipMuted, setIsClipMuted] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const [boothTranscript, setBoothTranscript] = useState<TranscriptEntry[]>([]);
  const [boothInterimTranscript, setBoothInterimTranscript] = useState('');
  const [boothError, setBoothError] = useState<string | null>(null);
  const [latchedAssist, setLatchedAssist] = useState(() => createEmptyAssistCard());
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
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const shouldKeepMicLiveRef = useRef(false);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioMonitorIntervalRef = useRef<number | null>(null);
  const lastPersistedSampleAtRef = useRef<number>(-1);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const clipObjectUrlRef = useRef<string | null>(null);
  const lastRestartTokenRef = useRef(controls.restartToken);

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
      recognitionRef.current?.stop();
      if (audioMonitorIntervalRef.current !== null) {
        window.clearInterval(audioMonitorIntervalRef.current);
      }
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
      await finishBoothSession(activeBoothSessionId);
      await refreshBoothSessions();
    } catch (_error) {
      setBoothError('The booth session could not be finalized in the local store.');
    } finally {
      setActiveBoothSessionId(null);
      lastPersistedSampleAtRef.current = -1;
    }
  }

  async function startAudioMonitoring() {
    if (
      microphoneStreamRef.current &&
      audioContextRef.current &&
      audioMonitorIntervalRef.current !== null
    ) {
      return;
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
      setAudioLevel(nextAudioLevel);
      setBoothClockMs(Date.now());

      if (nextAudioLevel >= AUDIO_ACTIVITY_THRESHOLD) {
        setLastVoiceActivityAtMs(Date.now());
      }
    }, AUDIO_ACTIVITY_SAMPLE_MS);
  }

  async function prepareMicrophone() {
    if (!supportsAudioMonitoring()) {
      setMicrophoneAvailability('unsupported');
      setBoothError('This browser cannot arm the booth microphone. Chrome or Edge work best.');
      setIsMicPrepared(false);
      return;
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
    } catch (_error) {
      setMicrophoneAvailability('degraded');
      setBoothError('Microphone access was blocked. Allow mic access to arm the booth.');
      setIsMicPrepared(false);
    } finally {
      setIsMicPreparing(false);
    }
  }

  function stopAudioMonitoring() {
    if (audioMonitorIntervalRef.current !== null) {
      window.clearInterval(audioMonitorIntervalRef.current);
      audioMonitorIntervalRef.current = null;
    }

    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
    microphoneStreamRef.current = null;
    setAudioLevel(0);
    setSpeechStreakStartedAtMs(-1);
    setSilenceStreakStartedAtMs(-1);
  }

  function handleClipChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    if (clipObjectUrlRef.current) {
      URL.revokeObjectURL(clipObjectUrlRef.current);
    }

    const nextClipUrl = URL.createObjectURL(file);
    clipObjectUrlRef.current = nextClipUrl;
    setLoadedClipName(file.name);
    setLoadedClipUrl(nextClipUrl);
    setClipPositionMs(0);
    setClipDurationMs(0);
    setIsClipMuted(true);
    setBoothError(null);
    event.currentTarget.value = '';
  }

  function attachRecognitionHandlers(recognition: SpeechRecognitionLike) {
    recognition.onresult = (event) => {
      let nextInterimTranscript = '';
      const finalTranscripts: string[] = [];

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcriptText = result[0]?.transcript.trim();

        if (!transcriptText) {
          continue;
        }

        if (result.isFinal) {
          finalTranscripts.push(transcriptText);
          continue;
        }

        nextInterimTranscript = transcriptText;
      }

      const currentTime = Date.now();
      setBoothClockMs(currentTime);

      if (finalTranscripts.length > 0) {
        const baseTimestamp = getCurrentTranscriptTimestamp();
        setBoothTranscript((current) => {
          const nextEntries = finalTranscripts.map((text, index) =>
            createTranscriptEntry(baseTimestamp + index * 25, text),
          );
          return [...current, ...nextEntries].slice(-LOCAL_TRANSCRIPT_LIMIT);
        });
        setLastSpeechAtMs(currentTime);
        setBoothInterimTranscript('');
        return;
      }

      if (nextInterimTranscript) {
        setLastSpeechAtMs(currentTime);
      }

      setBoothInterimTranscript(nextInterimTranscript);
    };

    recognition.onerror = (event) => {
      shouldKeepMicLiveRef.current = false;
      setIsMicListening(false);
      setBoothInterimTranscript('');
      setAudioLevel(0);

      switch (event.error) {
        case 'not-allowed':
          setMicrophoneAvailability('degraded');
          setIsMicPrepared(false);
          setBoothError('Microphone access was blocked. Allow mic access to test live hesitation.');
          break;
        case 'no-speech':
          setBoothError('No speech was detected. Try speaking a little closer to the mic.');
          break;
        case 'network':
          setMicrophoneAvailability('degraded');
          setIsMicPrepared(true);
          setBoothError(
            'This browser speech service is unavailable right now. Chrome or Edge usually work best.',
          );
          break;
        default:
          setMicrophoneAvailability('degraded');
          setIsMicPrepared(false);
          setBoothError(`Microphone error: ${event.error}.`);
      }
    };

    recognition.onend = () => {
      if (!shouldKeepMicLiveRef.current) {
        setIsMicListening(false);
        setBoothInterimTranscript('');
        return;
      }

      window.setTimeout(() => {
        try {
          recognition.start();
          setIsMicListening(true);
        } catch (_error) {
          setIsMicListening(false);
        }
      }, 250);
    };
  }

  function startMicrophone() {
    const SpeechRecognition = getSpeechRecognitionConstructor();

    if (!SpeechRecognition && !supportsAudioMonitoring()) {
      setMicrophoneAvailability('unsupported');
      setBoothError(
        'This browser does not expose a usable microphone API for the booth. Chrome or Edge work best.',
      );
      return;
    }

    shouldKeepMicLiveRef.current = true;
    setBoothError(null);
    setIsMicListening(true);
    setBoothClockMs(Date.now());

    void startAudioMonitoring()
      .then(() => {
        setMicrophoneAvailability('supported');
        setIsMicPrepared(true);
      })
      .catch(() => {
        shouldKeepMicLiveRef.current = false;
        recognitionRef.current?.stop();
        setMicrophoneAvailability('degraded');
        setIsMicPrepared(false);
        setBoothError(
          'Microphone access was blocked. Allow mic access to test live hesitation from your voice.',
        );
        setIsMicListening(false);
      });

    if (!SpeechRecognition) {
      setMicrophoneAvailability('degraded');
      setBoothError(
        'Voice activity is live, but browser speech transcription is unavailable in this tab.',
      );
      return;
    }

    try {
      const recognition =
        recognitionRef.current ??
        (() => {
          const nextRecognition = new SpeechRecognition();
          nextRecognition.continuous = true;
          nextRecognition.interimResults = true;
          nextRecognition.lang = 'en-US';
          attachRecognitionHandlers(nextRecognition);
          recognitionRef.current = nextRecognition;
          return nextRecognition;
        })();

      recognition.start();
      setMicrophoneAvailability('supported');
      setIsMicPrepared(true);
    } catch (_error) {
      setMicrophoneAvailability('degraded');
      setBoothError(
        'Voice activity is live, but speech transcription could not start in this browser session.',
      );
    }
  }

  function stopMicrophone() {
    shouldKeepMicLiveRef.current = false;
    recognitionRef.current?.stop();
    stopAudioMonitoring();
    setIsMicListening(false);
    setBoothInterimTranscript('');
    setAudioLevel(0);
  }

  function clearBoothTranscript() {
    setBoothTranscript([]);
    setBoothInterimTranscript('');
    setLastSpeechAtMs(-1);
    setLastVoiceActivityAtMs(-1);
    setSpeechStreakStartedAtMs(-1);
    setSilenceStreakStartedAtMs(-1);
    setAudioLevel(0);
    setBoothClockMs(Date.now());
    setBoothError(null);
  }

  async function startBroadcast() {
    if (!loadedClipUrl) {
      setBoothError('Load a clip before starting the booth.');
      return;
    }

    if (!isMicPrepared) {
      setBoothError('Arm the microphone before starting the booth.');
      return;
    }

    if (!activeBoothSessionId) {
      try {
        const response = await startBoothSession(loadedClipName || 'Untitled clip');
        setActiveBoothSessionId(response.session.id);
        await refreshBoothSessions();
      } catch (_error) {
        setBoothError('The booth session could not be saved locally, but the broadcast can still run.');
      }
    }

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

    if (controls.playbackStatus !== 'paused') {
      await sendControlPatch({ playbackStatus: 'paused' });
    }

    await finalizeBoothSession();
  }

  async function resetBroadcast() {
    await stopBroadcast();
    clearBoothTranscript();
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
  const latestSocial =
    worldState.liveSignals.social[worldState.liveSignals.social.length - 1];
  const recentEvents = [...worldState.recentEvents].reverse();
  const surfacedAssists = [...worldState.sessionMemory.surfacedAssists].reverse();
  const isMicSupported =
    microphoneAvailability !== 'unsupported' &&
    (Boolean(getSpeechRecognitionConstructor()) || supportsAudioMonitoring());
  const isSystemReady = isHydrated && !error;
  const isBroadcastReady = Boolean(loadedClipUrl) && isMicPrepared;
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
  const workerAssistShouldSurface =
    assist.type !== 'none' &&
    (controls.forceHesitation ||
      !boothHasLiveInput ||
      boothSignal.shouldSurfaceAssist ||
      boothInterpretation?.shouldSurfaceAssist ||
      worldState.commentator.hesitationScore >= LIVE_HESITATION_GATE);
  const boothAssistShouldSurface = boothHasLiveInput && boothAssist.type !== 'none';
  const nextTriggeredAssist = boothAssistShouldSurface
    ? boothAssist
    : workerAssistShouldSurface
      ? assist
      : null;
  const activeAssist = latchedAssist;
  const shouldSurfaceAssist = activeAssist.type !== 'none';
  const assistConfidencePercent = formatPercent(shouldSurfaceAssist ? activeAssist.confidence : 0);
  const boothHesitationPercent = formatPercent(
    boothInterpretation?.hesitationScore ?? boothSignal.hesitationScore,
  );
  const boothConfidencePercent = formatPercent(
    boothInterpretation?.recoveryScore ?? boothSignal.confidenceScore,
  );
  const visibleReasons =
    boothInterpretation?.reasons && boothInterpretation.reasons.length > 0
      ? boothInterpretation.reasons
      : boothSignal.hesitationReasons.length > 0
        ? boothSignal.hesitationReasons
      : ['Hesitation is currently driven by live silence after active speech.'];
  const visibleConfidenceReasons = [
    boothInterpretation?.summary
      ? `Recovery signal: ${boothInterpretation.summary}`
      : 'Confidence builds only when your delivery restarts and holds.',
  ];
  const coachingTone = getCoachingTone({
    hasStartedBroadcast,
    boothHasLiveInput,
    boothSignal: {
      ...boothSignal,
      hesitationScore: boothInterpretation?.hesitationScore ?? boothSignal.hesitationScore,
      confidenceScore: boothInterpretation?.recoveryScore ?? boothSignal.confidenceScore,
    },
    shouldSurfaceAssist,
  });
  const readinessChecks = [
    {
      label: 'Clip loaded',
      done: Boolean(loadedClipUrl),
      detail: loadedClipUrl ? loadedClipName || 'Local replay is ready.' : 'Bring in a replay clip first.',
    },
    {
      label: 'Mic armed',
      done: isMicPrepared,
      detail: isMicPrepared
        ? 'Microphone permission is ready for the live booth.'
        : isMicPreparing
          ? 'Requesting microphone access.'
          : 'Enable mic access before going live.',
    },
    {
      label: 'System linked',
      done: isSystemReady,
      detail: isSystemReady
        ? 'The hosted backend is reachable.'
        : 'Backend is unavailable, but local booth mode can still run.',
    },
  ];
  const clipClockLabel = formatDurationMs(clipPositionMs);
  const clipDurationLabel = clipDurationMs > 0 ? formatDurationMs(clipDurationMs) : '--:--';
  const clipProgress = clipDurationMs > 0 ? Math.min(100, Math.round((clipPositionMs / clipDurationMs) * 100)) : 0;
  const isBroadcastLive =
    hasStartedBroadcast && (controls.playbackStatus === 'playing' || isMicListening);
  const feedHeading = loadedClipName || 'Attach a video input';
  const replayToastSignature = `${activeAssist.type}:${activeAssist.text}:${shouldSurfaceAssist}:${controls.restartToken}`;
  const activeTriggerBadges = [
    boothSignal.pauseDurationMs >= LONG_PAUSE_START_MS ? 'pause' : null,
  ].filter(Boolean) as string[];
  const preMatchSummary = worldState.preMatch.aiOpener ?? worldState.preMatch.deterministicOpener;
  const primaryActionLabel = isBroadcastLive ? 'End session' : 'Start session';
  const primaryActionDisabled = !isBroadcastLive && (!isBroadcastReady || isUpdatingControls);
  const guidanceSummary = shouldSurfaceAssist
    ? activeAssist.whyNow
    : boothInterpretation?.summary
      ? boothInterpretation.summary
    : coachingTone.tone === 'steady'
      ? 'Hesitation is falling. And-One is backing off.'
      : coachingTone.copy;
  const micBars = Array.from({ length: 14 }, (_, index) => {
    const threshold = (index + 1) / 14;
    return boothSignal.audioLevel >= threshold * 0.18;
  });

  useEffect(() => {
    if (!hasStartedBroadcast) {
      if (latchedAssist.type !== 'none') {
        setLatchedAssist(createEmptyAssistCard());
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
    }
  }, [hasStartedBroadcast, latchedAssist.text, latchedAssist.type, latchedAssist.whyNow, nextTriggeredAssist]);

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
    }).catch(() => {
      setBoothError('Live booth metrics could not be saved to the local store.');
    });
  }, [
    activeAssist.text,
    activeBoothSessionId,
    activeTriggerBadges,
    boothSignal.audioLevel,
    boothSignal.confidenceScore,
    boothSignal.hesitationScore,
    boothSignal.isSpeaking,
    boothSignal.pauseDurationMs,
    boothInterpretation?.hesitationScore,
    boothInterpretation?.recoveryScore,
    hasStartedBroadcast,
    shouldSurfaceAssist,
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
      unfinishedPhrase: boothSignal.unfinishedPhrase,
      transcriptWordCount: boothSignal.transcriptWordCount,
      transcriptStabilityScore: boothSignal.transcriptStabilityScore,
      hesitationReasons: boothSignal.hesitationReasons,
      transcriptWindow: boothTranscript.slice(-LOCAL_TRANSCRIPT_LIMIT),
      interimTranscript: boothInterimTranscript,
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

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="panel-kicker">Session Opener</p>
            <h2>Pre-match brief</h2>
          </div>
          <span className="panel-tag">{worldState.preMatch.loadStatus}</span>
        </div>

        <div className="narrative-focus">
          <p className="narrative-label">Opening read</p>
          <h3>{preMatchSummary}</h3>
          <p>
            {worldState.preMatch.aiOpener
              ? 'AI-polished from the same structured packet.'
              : 'Deterministic summary from structured match context.'}
          </p>
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
          <p className="memory-title">Session context</p>
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
            <label className="file-chip">
              <span>{loadedClipUrl ? 'Replace Clip' : 'Load Clip'}</span>
              <input type="file" accept="video/*" onChange={handleClipChange} />
            </label>
            <div className="media-meta">
              <span className="meta-pill">{loadedClipName || 'No local clip loaded yet'}</span>
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
                <button type="button" className="text-button" onClick={clearLoadedClip}>
                  Clear clip
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
                      : 'Arm the mic, then start the session.'
                    : 'Attach a video input to begin.'}
                </h3>
                {loadedClipUrl ? (
                  <div className="quick-setup-actions">
                    <button
                      type="button"
                      className={isMicPrepared ? 'is-active' : ''}
                      disabled={isMicPreparing}
                      onClick={() => void prepareMicrophone()}
                    >
                      {isMicPrepared
                        ? 'Microphone ready'
                        : isMicPreparing
                          ? 'Checking microphone…'
                          : 'Enable microphone'}
                    </button>
                    <button
                      type="button"
                      className={isBroadcastLive ? 'is-active' : ''}
                      disabled={primaryActionDisabled}
                      onClick={() => void (isBroadcastLive ? stopBroadcast() : startBroadcast())}
                    >
                      {primaryActionLabel}
                    </button>
                  </div>
                ) : null}
              </div>

              {shouldSurfaceAssist ? (
                <article className="replay-toast replay-toast--live" key={replayToastSignature}>
                  <p className="assist-type">Assist</p>
                  <h3>{activeAssist.text}</h3>
                  <p>{activeAssist.whyNow}</p>
                </article>
              ) : boothHasLiveInput ? (
                <div className="replay-toast replay-toast--hint">
                  <p className="assist-type">Monitoring</p>
                  <h3>Mic is live.</h3>
                </div>
              ) : loadedClipUrl && !hasStartedBroadcast ? (
                <div className="replay-toast replay-toast--hint">
                  <p className="assist-type">Preflight</p>
                  <h3>Finish setup, then start.</h3>
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
                <p className="pulse-copy">
                  {boothInterimTranscript ||
                    boothTranscript[boothTranscript.length - 1]?.text ||
                    latestSocial?.text ||
                    worldState.liveMatch.degradedReason ||
                    'Live transcript and hesitation cues will appear as you speak.'}
                </p>
              </div>
            </div>
          </div>
        </section>

        <div className="side-column">
          <section className={`panel control-panel control-panel--${coachingTone.tone}`}>
            <div className="panel-header panel-header--compact">
              <div>
                <p className="panel-kicker">Session</p>
                <h2>Go live</h2>
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
                className={isMicPrepared ? 'is-active' : ''}
                disabled={isMicPreparing}
                onClick={() => void prepareMicrophone()}
              >
                {isMicPrepared ? 'Microphone ready' : isMicPreparing ? 'Checking microphone…' : 'Enable microphone'}
              </button>
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
                  <strong>{shouldSurfaceAssist ? 'Visible' : coachingTone.tone === 'steady' ? 'Standby' : 'Waiting'}</strong>
                </div>
              </div>
              <div className="meter-label-row">
                <span>Mic activity</span>
                <strong>{Math.round(boothSignal.audioLevel * 100)}%</strong>
              </div>

              <div className="meter-label-row">
                <span>Confidence</span>
                <strong>{boothConfidencePercent}</strong>
              </div>

              <div className="reason-list">
                {visibleReasons.map((reason) => (
                  <p key={reason}>{reason}</p>
                ))}
                {visibleConfidenceReasons.map((reason) => (
                  <p key={reason}>{reason}</p>
                ))}
              </div>

              <p className="field-copy">
                The clip stays muted by default so the booth tracks your voice, not the program feed. Confidence should recover only when your call does.
              </p>
              {boothError ? <p className="inline-warning">{boothError}</p> : null}

              <div className="transcript-list">
                {boothTranscript.length > 0 ? (
                  boothTranscript.slice(-3).map((entry) => (
                    <p className="transcript-line" key={`${entry.timestamp}-${entry.text}`}>
                      {entry.text}
                    </p>
                  ))
                ) : (
                  <p className="transcript-line transcript-line--muted">
                    {isMicSupported
                      ? 'Start the mic and talk through the match to see live booth transcript here.'
                      : 'This browser does not expose speech recognition, so the booth stays in live-feed-only mode.'}
                  </p>
                )}
                {boothInterimTranscript ? (
                  <p className="transcript-line transcript-line--interim">{boothInterimTranscript}</p>
                ) : null}
              </div>
            </article>

            <div className="inline-actions inline-actions--compact">
              <button type="button" className="text-button" onClick={() => void resetBroadcast()}>
                Reset session
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
