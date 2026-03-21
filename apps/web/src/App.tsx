import { startTransition, useEffect, useRef, useState } from 'react';
import {
  BoothSessionAnalytics,
  BoothSessionSummary,
  ReplayControlState,
  TranscriptEntry,
} from '@sports-copilot/shared-types';
import './App.css';
import { BRAND } from './brand';
import {
  appendBoothSessionSample,
  fetchBoothSessions,
  fetchControlState,
  fetchWorldState,
  finishBoothSession,
  startBoothSession,
  updateControlState,
} from './api';
import type { BoothSignal } from './boothSignal';
import {
  LOCAL_TRANSCRIPT_LIMIT,
  LIVE_HESITATION_GATE,
  LONG_PAUSE_START_MS,
  buildBoothSignal,
  calculateAudioLevel,
  deriveBoothActivity,
} from './boothSignal';
import {
  createInitialWorldState,
  formatAssistType,
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

function createPracticeAssist(boothSignal: BoothSignal) {
  const confidence = boothSignal.hesitationScore;

  if (boothSignal.pauseDurationMs >= LONG_PAUSE_START_MS) {
    return {
      type: 'context' as const,
      text: 'Reset with a simple scene call and one short takeaway.',
      whyNow: 'You left a clear pause after the last thought.',
      urgency: 'medium' as const,
      confidence,
    };
  }

  if (boothSignal.fillerWords.length >= 2) {
    return {
      type: 'transition' as const,
      text: 'Drop the filler and go straight to what the viewer is seeing.',
      whyNow: 'The booth cadence is getting clogged with filler words.',
      urgency: 'medium' as const,
      confidence,
    };
  }

  if (boothSignal.repeatedPhrases.length > 0) {
    return {
      type: 'transition' as const,
      text: 'Pick one clean re-entry line and commit to it.',
      whyNow: 'You restarted the same opening more than once.',
      urgency: 'medium' as const,
      confidence,
    };
  }

  if (boothSignal.unfinishedPhrase) {
    return {
      type: 'context' as const,
      text: 'Finish the thought with one short sentence, then breathe.',
      whyNow: 'The last line trailed off before it landed.',
      urgency: 'low' as const,
      confidence,
    };
  }

  return {
    type: 'none' as const,
    text: '',
    whyNow: 'No assist needed right now.',
    urgency: 'low' as const,
    confidence: 0,
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
      headline: 'Set the booth, then go live.',
      copy: 'Think of this as training wheels for the call. We stay quiet until you actually need a nudge.',
    };
  }

  if (shouldSurfaceAssist) {
    return {
      tone: 'step-in' as CoachingTone,
      label: 'Stepping in',
      headline: 'The sidekick is helping on this beat.',
      copy: 'A real wobble is active, so the cue stays present until your delivery settles again.',
    };
  }

  if (!boothHasLiveInput) {
    return {
      tone: 'standby' as CoachingTone,
      label: 'Listening',
      headline: 'The booth is waiting for your first line.',
      copy: 'Start calling the action and the sidekick will watch for pauses, fillers, and restarts.',
    };
  }

  if (boothSignal.isSpeaking && boothSignal.confidenceScore >= 0.68 && boothSignal.hesitationScore < 0.18) {
    return {
      tone: 'steady' as CoachingTone,
      label: 'Backing off',
      headline: 'You are driving the call cleanly.',
      copy: 'Confidence is back, so the training wheels are easing off and staying out of your way.',
    };
  }

  return {
    tone: 'supporting' as CoachingTone,
    label: 'Hovering',
    headline: 'The sidekick is nearby, but not interrupting.',
    copy: 'There is a little wobble, so we stay close and only step in if the hesitation grows.',
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
  const [recentBoothSessions, setRecentBoothSessions] = useState<BoothSessionSummary[]>([]);
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
  const [isMicListening, setIsMicListening] = useState(false);
  const [isMicPrepared, setIsMicPrepared] = useState(false);
  const [isMicPreparing, setIsMicPreparing] = useState(false);
  const [lastSpeechAtMs, setLastSpeechAtMs] = useState(-1);
  const [lastVoiceActivityAtMs, setLastVoiceActivityAtMs] = useState(-1);
  const [speechStreakStartedAtMs, setSpeechStreakStartedAtMs] = useState(-1);
  const [silenceStreakStartedAtMs, setSilenceStreakStartedAtMs] = useState(-1);
  const [audioLevel, setAudioLevel] = useState(0);
  const [boothClockMs, setBoothClockMs] = useState(() => Date.now());
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
        setBoothError('The booth session could not be saved locally.');
        return;
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
  const recentEvents = [...worldState.recentEvents].reverse();
  const surfacedAssists = [...worldState.sessionMemory.surfacedAssists].reverse();
  const systemHesitationReasons =
    worldState.commentator.hesitationReasons.length > 0
      ? worldState.commentator.hesitationReasons
      : ['No replay-side hesitation trigger is active right now.'];
  const isMicSupported =
    microphoneAvailability !== 'unsupported' &&
    (Boolean(getSpeechRecognitionConstructor()) || supportsAudioMonitoring());
  const isSystemReady = isHydrated && !error;
  const isBroadcastReady = Boolean(loadedClipUrl) && isMicPrepared && isSystemReady;
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
  const isPracticeMode = true;
  const practiceAssist = createPracticeAssist(boothSignal);
  const shouldSurfaceAssist =
    isPracticeMode
      ? boothHasLiveInput && boothSignal.shouldSurfaceAssist
      : assist.type !== 'none' &&
        (controls.forceHesitation ||
          !boothHasLiveInput ||
          boothSignal.shouldSurfaceAssist ||
          worldState.commentator.hesitationScore >= LIVE_HESITATION_GATE);
  const activeAssist = isPracticeMode
    ? {
        ...assist,
        type: practiceAssist.type,
        text: practiceAssist.text,
        whyNow: practiceAssist.whyNow,
        urgency: practiceAssist.urgency,
        confidence: practiceAssist.confidence,
        sourceChips: [],
        styleMode: 'analyst' as const,
      }
    : assist;
  const assistConfidencePercent = formatPercent(shouldSurfaceAssist ? activeAssist.confidence : 0);
  const hesitationPercent = formatPercent(
    boothHasLiveInput ? boothSignal.hesitationScore : worldState.commentator.hesitationScore,
  );
  const boothConfidencePercent = formatPercent(boothSignal.confidenceScore);
  const boothHesitationPercent = formatPercent(boothSignal.hesitationScore);
  const systemHesitationPercent = formatPercent(worldState.commentator.hesitationScore);
  const visibleReasons =
    boothHasLiveInput && boothSignal.hesitationReasons.length > 0
      ? boothSignal.hesitationReasons
      : boothHasLiveInput
        ? ['Talk through the play. The copilot will watch for pauses, fillers, and repeated starts.']
        : systemHesitationReasons;
  const visibleConfidenceReasons =
    boothSignal.confidenceReasons.length > 0
      ? boothSignal.confidenceReasons
      : ['Confidence builds only when your delivery restarts and holds.'];
  const coachingTone = getCoachingTone({
    hasStartedBroadcast,
    boothHasLiveInput,
    boothSignal,
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
      detail: isSystemReady ? 'The hosted backend is reachable.' : 'Waiting for the backend connection.',
    },
  ];
  const readyCount = readinessChecks.filter((check) => check.done).length;
  const clipClockLabel = formatDurationMs(clipPositionMs);
  const clipDurationLabel = clipDurationMs > 0 ? formatDurationMs(clipDurationMs) : '--:--';
  const clipProgress = clipDurationMs > 0 ? Math.min(100, Math.round((clipPositionMs / clipDurationMs) * 100)) : 0;
  const boothStatusLabel = !loadedClipUrl
    ? 'Load clip first'
    : !hasStartedBroadcast
      ? 'Ready to start'
      : isMicListening
        ? boothSignal.isSpeaking
          ? 'Mic live'
          : 'Listening for the next beat'
        : isMicSupported
          ? microphoneAvailability === 'degraded'
            ? 'Mic degraded'
            : 'Mic ready'
          : 'Mic unavailable';
  const isBroadcastLive =
    hasStartedBroadcast && (controls.playbackStatus === 'playing' || isMicListening);
  const setupStatusLabel = !loadedClipUrl
    ? 'Waiting for clip upload'
    : !hasStartedBroadcast
      ? 'Clip loaded. Booth standing by'
      : boothStatusLabel;
  const systemStatusLabel = error ? 'Reconnecting' : isHydrated ? 'Ready' : 'Booting';
  const feedHeading = loadedClipName || 'Load a clip to begin';
  const feedSubheading = loadedClipUrl
    ? hasStartedBroadcast
      ? 'Call the play naturally. Your sidekick only leans in when the delivery genuinely wobbles.'
      : 'Your clip is loaded and muted. Arm the booth, then go live when you are ready.'
    : 'Bring in any local replay clip to rehearse live commentary with a sidekick that knows when to help and when to disappear.';
  const replayToastSignature = `${activeAssist.type}:${activeAssist.text}:${shouldSurfaceAssist}:${controls.restartToken}`;
  const activeTriggerBadges = [
    boothSignal.pauseDurationMs >= LONG_PAUSE_START_MS ? 'pause' : null,
    boothSignal.fillerWords.length > 0 ? 'filler' : null,
    boothSignal.repeatedPhrases.length > 0 ? 'repeat-start' : null,
    boothSignal.unfinishedPhrase ? 'unfinished' : null,
  ].filter(Boolean) as string[];

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
      hesitationScore: boothSignal.hesitationScore,
      confidenceScore: boothSignal.confidenceScore,
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
    hasStartedBroadcast,
    shouldSurfaceAssist,
  ]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <p className="eyebrow">{BRAND.eyebrow}</p>
          <h1>{BRAND.heroTitle}</h1>
          <p className="hero-copy">{BRAND.heroCopy}</p>
        </div>

        <div className="header-actions">
          <div className="header-status-card">
            <p className="control-label">System</p>
            <strong>{systemStatusLabel}</strong>
            <span>{readyCount}/3 checks ready. {setupStatusLabel}</span>
          </div>
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
        <section className="panel replay-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Feed</p>
              <h2>{feedHeading}</h2>
              <p className="panel-copy">{feedSubheading}</p>
            </div>
            <div className="panel-chip-row">
              <span className="panel-tag">{loadedClipUrl ? `${clipClockLabel} / ${clipDurationLabel}` : 'Awaiting upload'}</span>
              <span className={`panel-tag panel-tag--${coachingTone.tone}`}>{coachingTone.label}</span>
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
                      : 'Arm the booth, then take the feed live.'
                    : 'Upload a clip, then arm your sidekick.'}
                </h3>
                <p>
                  {coachingTone.copy}
                </p>
              </div>

              {shouldSurfaceAssist ? (
                <article className="replay-toast" key={replayToastSignature}>
                  <p className="assist-type">{formatAssistType(activeAssist.type)}</p>
                  <h3>{activeAssist.text}</h3>
                  <p>{activeAssist.whyNow}</p>
                </article>
              ) : boothHasLiveInput ? (
                <div className="replay-toast replay-toast--hint">
                  <p className="assist-type">Monitoring</p>
                  <h3>Booth tracking is live.</h3>
                  <p>The feed stays clear until hesitation becomes strong enough to justify one assist.</p>
                </div>
              ) : loadedClipUrl && !hasStartedBroadcast ? (
                <div className="replay-toast replay-toast--hint">
                  <p className="assist-type">Preflight</p>
                  <h3>Finish the mic check, then go live.</h3>
                  <p>The feed is set and muted. Nothing is scored until the booth is armed and the session starts.</p>
                </div>
              ) : null}

              <div className="replay-tags">
                {isPracticeMode ? (
                  activeTriggerBadges.length > 0 ? (
                    activeTriggerBadges.map((badge) => (
                      <span className="scene-chip" key={badge}>
                        {badge}
                      </span>
                    ))
                  ) : (
                    <span className="scene-chip scene-chip--muted">Waiting for hesitation cue</span>
                  )
                ) : (
                  <span className="scene-chip scene-chip--muted">Waiting for hesitation cue</span>
                )}
              </div>

              <div className="replay-footer">
                <div className={`coach-lane coach-lane--${coachingTone.tone}`}>
                  <span className="coach-lane__signal">{coachingTone.label}</span>
                  <div>
                    <strong>{coachingTone.headline}</strong>
                    <p>{coachingTone.copy}</p>
                  </div>
                </div>
                <div className="progress-track" aria-label="Replay progress">
                  <span style={{ width: `${clipProgress}%` }} />
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="side-column">
          <section className="panel control-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Booth</p>
                <h2>Sidekick panel</h2>
                <p className="panel-copy">A calmer control rail for preflight, live coaching, and that gentle step-back when you are back in rhythm.</p>
              </div>
            </div>

            <article className="booth-summary booth-summary--preflight">
              <div>
                <p className="control-label">Preflight</p>
                <strong>{readyCount}/3 ready</strong>
              </div>
              {readinessChecks.map((check) => (
                <div key={check.label} className={`readiness-item ${check.done ? 'readiness-item--done' : ''}`}>
                  <div className="readiness-item__row">
                    <p className="control-label">{check.label}</p>
                    <span className={`readiness-dot ${check.done ? 'readiness-dot--done' : ''}`} />
                  </div>
                  <strong>{check.done ? 'Ready' : 'Pending'}</strong>
                  <span>{check.detail}</span>
                </div>
              ))}
            </article>

            <div className="control-group">
              <p className="control-label">Setup</p>
              <div className="primary-controls primary-controls--split">
                <button
                  type="button"
                  className={isMicPrepared ? 'is-active' : ''}
                  disabled={isMicPreparing}
                  onClick={() => void prepareMicrophone()}
                >
                  {isMicPrepared ? 'Mic Ready' : isMicPreparing ? 'Checking Mic…' : 'Enable Microphone'}
                </button>
                <button
                  type="button"
                  className={isBroadcastLive ? 'is-active' : ''}
                  disabled={!isBroadcastReady || isUpdatingControls}
                  onClick={() => void (isBroadcastLive ? stopBroadcast() : startBroadcast())}
                >
                  {isBroadcastLive ? 'End Session' : 'Start Broadcast'}
                </button>
              </div>
              <p className="field-copy field-copy--tight">
                The booth will not go live until the clip is loaded, the mic is armed, and the hosted system is connected.
              </p>
            </div>

            <div className="control-group">
              <p className="control-label">Session</p>
              <div className="primary-controls">
                <button type="button" className={`tone-button tone-button--${coachingTone.tone}`}>
                  {coachingTone.label}
                </button>
              </div>
              <div className="inline-actions">
                <button type="button" className="text-button" onClick={() => void resetBroadcast()}>
                  Reset session
                </button>
                <button type="button" className="text-button" onClick={clearBoothTranscript}>
                  Clear transcript
                </button>
              </div>
            </div>

            <article className={`booth-card booth-card--${coachingTone.tone}`}>
              <div className="booth-card__header">
                <div>
                  <p className="control-label">Coaching zone</p>
                  <strong>{coachingTone.headline}</strong>
                </div>
                <div className={`metric-badge metric-badge--${coachingTone.tone}`}>
                  <span>{coachingTone.label}</span>
                </div>
              </div>

              <p className="field-copy">{coachingTone.copy}</p>

              <div className="signal-duo">
                <div>
                  <div className="meter-label-row">
                    <span>Hesitation</span>
                    <strong>{boothHesitationPercent}</strong>
                  </div>
                  <div className={`meter-track meter-track--${coachingTone.tone}`}>
                    <span style={{ width: boothHesitationPercent }} />
                  </div>
                </div>

                <div>
                  <div className="meter-label-row">
                    <span>Confidence</span>
                    <strong>{boothConfidencePercent}</strong>
                  </div>
                  <div className="meter-track meter-track--steady">
                    <span style={{ width: boothConfidencePercent }} />
                  </div>
                </div>
              </div>

              <div className="meter-label-row">
                <span>Mic activity</span>
                <strong>{Math.round(boothSignal.audioLevel * 100)}%</strong>
              </div>

              <div className="meter-label-row">
                <span>Training wheels</span>
                <strong>{shouldSurfaceAssist ? 'On screen' : coachingTone.tone === 'steady' ? 'Weaning off' : 'Hovering nearby'}</strong>
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
                The clip stays muted by default so the booth tracks your voice, not the program feed. Green means we trust you, yellow means we hover, and red means we step in until you are stable again.
              </p>
              {boothError ? <p className="inline-warning">{boothError}</p> : null}
            </article>
          </section>

        </div>
      </div>

      {showDetails ? (
        <div className="bottom-grid">
          <section className="panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Booth Sessions</p>
                <h2>Saved analytics</h2>
              </div>
              <span className="panel-tag">{boothAnalytics.totalSessions} runs</span>
            </div>

            <div className="commentary-metadata">
              <div>
                <p className="control-label">Completed</p>
                <strong>{boothAnalytics.completedSessions}</strong>
              </div>
              <div>
                <p className="control-label">Avg max hesitation</p>
                <strong>{formatPercent(boothAnalytics.averageMaxHesitationScore)}</strong>
              </div>
              <div>
                <p className="control-label">Avg longest pause</p>
                <strong>{formatDurationMs(boothAnalytics.averageLongestPauseMs)}</strong>
              </div>
              <div>
                <p className="control-label">Assists surfaced</p>
                <strong>{boothAnalytics.totalAssistCount}</strong>
              </div>
            </div>

            <div className="timeline-list">
              {recentBoothSessions.length > 0 ? (
                recentBoothSessions.slice(0, 5).map((session) => (
                  <article className="timeline-item" key={session.id}>
                    <div className="timeline-time">
                      <span>{session.clipName}</span>
                      <small>{session.status}</small>
                    </div>
                    <p>
                      Max hesitation {formatPercent(session.maxHesitationScore)}, longest pause{' '}
                      {formatDurationMs(session.longestPauseMs)}, assists {session.assistCount}.
                    </p>
                  </article>
                ))
              ) : (
                <p className="empty-copy">
                  Saved booth analytics will appear here after you run a broadcast session.
                </p>
              )}
            </div>
          </section>

          <section className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Match Flow</p>
              <h2>Event Timeline</h2>
            </div>
            <span className="panel-tag">{recentEvents.length} recent events</span>
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
              <p className="empty-copy">Recent match events will roll in here as the replay advances.</p>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Narrative Stack</p>
              <h2>Storylines</h2>
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
            <p className="memory-title">Recent assist memory</p>
            {surfacedAssists.length > 0 ? (
              surfacedAssists.slice(0, 3).map((savedAssist) => (
                <p className="memory-line" key={`${savedAssist.type}:${savedAssist.text}`}>
                  {savedAssist.text}
                </p>
              ))
            ) : (
              <p className="memory-line">No assists have been surfaced yet.</p>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Signal Matrix</p>
              <h2>Booth hesitation tracker</h2>
            </div>
            <span className="panel-tag">{hesitationPercent}</span>
          </div>

          <div className="meter-cluster">
            <div>
              <div className="meter-label-row">
                <span>Booth hesitation</span>
                <strong>{boothHesitationPercent}</strong>
              </div>
              <div className="meter-track">
                <span style={{ width: boothHesitationPercent }} />
              </div>
            </div>

            <div>
              <div className="meter-label-row">
                <span>Replay-side hesitation</span>
                <strong>{systemHesitationPercent}</strong>
              </div>
              <div className="meter-track meter-track--cool">
                <span style={{ width: systemHesitationPercent }} />
              </div>
            </div>

            <div>
              <div className="meter-label-row">
                <span>Assist confidence</span>
                <strong>{assistConfidencePercent}</strong>
              </div>
              <div className="meter-track meter-track--gold">
                <span style={{ width: assistConfidencePercent }} />
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
              <strong>{boothHasLiveInput ? boothSignal.activeSpeaker : worldState.commentator.activeSpeaker}</strong>
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
              <strong>
                {(boothHasLiveInput ? boothSignal.fillerWords : worldState.commentator.fillerWords).join(', ') ||
                  'Clean'}
              </strong>
            </div>
            <div>
              <p className="control-label">Repeated opens</p>
              <strong>{boothSignal.repeatedPhrases[0] ?? 'None'}</strong>
            </div>
          </div>

          <div className="memory-strip">
            <p className="memory-title">Booth transcript</p>
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
                    ? 'Load a clip first, then start the booth.'
                    : !hasStartedBroadcast
                      ? 'Start the booth to begin live mic tracking.'
                      : isMicSupported
                        ? 'Live booth transcript will appear here once you start speaking.'
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
