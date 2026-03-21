import { startTransition, useEffect, useRef, useState } from 'react';
import { ReplayControlState, TranscriptEntry } from '@sports-copilot/shared-types';
import './App.css';
import { fetchControlState, fetchWorldState, updateControlState } from './api';
import {
  TEAM_META,
  createInitialWorldState,
  formatAssistType,
  formatDurationMs,
  formatEventType,
  formatMomentum,
  formatPercent,
  parseClock,
} from './dashboard';

type BoothActiveSpeaker = 'lead' | 'none';
type MicrophoneAvailability = 'supported' | 'degraded' | 'unsupported';

type BoothSignal = {
  activeSpeaker: BoothActiveSpeaker;
  hesitationScore: number;
  hesitationReasons: string[];
  pauseDurationMs: number;
  fillerWords: string[];
  repeatedPhrases: string[];
  unfinishedPhrase: boolean;
  isSpeaking: boolean;
  shouldSurfaceAssist: boolean;
};

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

const ACTIVE_SPEECH_WINDOW_MS = 1_400;
const LIVE_HESITATION_GATE = 0.36;
const LONG_PAUSE_START_MS = 1_600;
const PAUSE_RANGE_MS = 2_400;
const PAUSE_DECAY_START_MS = 6_000;
const PAUSE_DECAY_RANGE_MS = 6_000;
const LOCAL_TRANSCRIPT_LIMIT = 8;
const FILLER_PATTERNS = [
  { token: 'uh', pattern: /\buh\b/gi },
  { token: 'um', pattern: /\bum\b/gi },
  { token: 'er', pattern: /\ber\b/gi },
  { token: 'ah', pattern: /\bah\b/gi },
  { token: 'you know', pattern: /\byou know\b/gi },
  { token: 'i mean', pattern: /\bi mean\b/gi },
] as const;

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function countMatches(text: string, pattern: RegExp) {
  return text.match(pattern)?.length ?? 0;
}

function normalizeTranscriptText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectFillerWords(texts: string[]) {
  const hits: string[] = [];

  for (const text of texts) {
    for (const filler of FILLER_PATTERNS) {
      const matchCount = countMatches(text, filler.pattern);

      for (let index = 0; index < matchCount; index += 1) {
        hits.push(filler.token);
      }
    }
  }

  return hits;
}

function findRepeatedPhrases(entries: TranscriptEntry[]) {
  const repeatedPhrases: string[] = [];
  const prefixCounts = new Map<string, number>();

  for (const entry of entries) {
    const words = normalizeTranscriptText(entry.text).split(' ').filter(Boolean);

    if (words.length < 2) {
      continue;
    }

    const prefix = words.slice(0, Math.min(3, words.length)).join(' ');

    if (prefix.length < 6) {
      continue;
    }

    const nextCount = (prefixCounts.get(prefix) ?? 0) + 1;
    prefixCounts.set(prefix, nextCount);

    if (nextCount === 2) {
      repeatedPhrases.push(prefix);
    }
  }

  return repeatedPhrases;
}

function buildBoothSignal({
  boothTranscript,
  interimTranscript,
  isMicListening,
  lastSpeechAtMs,
  nowMs,
}: {
  boothTranscript: TranscriptEntry[];
  interimTranscript: string;
  isMicListening: boolean;
  lastSpeechAtMs: number;
  nowMs: number;
}): BoothSignal {
  const recentTranscript = boothTranscript.slice(-LOCAL_TRANSCRIPT_LIMIT);
  const transcriptTexts = recentTranscript.map((entry) => entry.text);
  const interimText = interimTranscript.trim();
  const fillerWords = collectFillerWords(
    interimText ? [...transcriptTexts, interimText] : transcriptTexts,
  );
  const repeatedPhrases = findRepeatedPhrases(recentTranscript);
  const lastLine = recentTranscript[recentTranscript.length - 1]?.text.trim() ?? '';
  const unfinishedPhrase = /(?:\.\.\.|-)\s*$/.test(lastLine);
  const isSpeaking =
    isMicListening &&
    (interimText.length > 0 ||
      (lastSpeechAtMs >= 0 && nowMs - lastSpeechAtMs < ACTIVE_SPEECH_WINDOW_MS));
  const pauseDurationMs =
    !isSpeaking && lastSpeechAtMs >= 0 ? Math.max(0, nowMs - lastSpeechAtMs) : 0;
  const hesitationReasons: string[] = [];
  let hesitationScore = 0;

  if (pauseDurationMs >= LONG_PAUSE_START_MS) {
    const pauseSeconds = Math.round((pauseDurationMs / 1_000) * 10) / 10;
    const pauseBuild = clamp((pauseDurationMs - LONG_PAUSE_START_MS) / PAUSE_RANGE_MS) * 0.55;
    const pauseDecay =
      pauseDurationMs <= PAUSE_DECAY_START_MS
        ? 1
        : 1 - clamp((pauseDurationMs - PAUSE_DECAY_START_MS) / PAUSE_DECAY_RANGE_MS);
    hesitationScore += pauseBuild * pauseDecay;
    hesitationReasons.push(`You paused for ${pauseSeconds}s after the last thought.`);
  }

  if (fillerWords.length > 0) {
    const uniqueFillers = [...new Set(fillerWords)];
    hesitationScore += Math.min(0.24, 0.08 * fillerWords.length);
    hesitationReasons.push(`Fillers detected: ${uniqueFillers.join(', ')}.`);
  }

  if (unfinishedPhrase && pauseDurationMs >= 900) {
    hesitationScore += 0.18;
    hesitationReasons.push('The last line trails off mid-thought.');
  }

  if (repeatedPhrases.length > 0) {
    hesitationScore += Math.min(0.16, repeatedPhrases.length * 0.08);
    hesitationReasons.push(`Repeated opening: "${repeatedPhrases[0]}".`);
  }

  return {
    activeSpeaker: isSpeaking ? 'lead' : 'none',
    hesitationScore: clamp(hesitationScore),
    hesitationReasons,
    pauseDurationMs,
    fillerWords,
    repeatedPhrases,
    unfinishedPhrase,
    isSpeaking,
    shouldSurfaceAssist: hesitationScore >= LIVE_HESITATION_GATE,
  };
}

function getSpeechRecognitionConstructor() {
  if (typeof window === 'undefined') {
    return null;
  }

  const speechWindow = window as SpeechRecognitionWindow;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function createTranscriptEntry(timestamp: number, text: string): TranscriptEntry {
  return {
    timestamp,
    speaker: 'lead',
    text,
  };
}

function createPracticeAssist(boothSignal: BoothSignal) {
  const confidence = clamp(0.28 + boothSignal.hesitationScore * 0.72);

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

function formatFormRecord(
  form: {
    record: { wins: number; draws: number; losses: number };
    lastFive: Array<unknown>;
  },
) {
  return `${form.record.wins}-${form.record.draws}-${form.record.losses} (${form.lastFive.length})`;
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
  const [lastSpeechAtMs, setLastSpeechAtMs] = useState(-1);
  const [boothClockMs, setBoothClockMs] = useState(() => Date.now());
  const [microphoneAvailability, setMicrophoneAvailability] =
    useState<MicrophoneAvailability>('supported');
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const shouldKeepMicLiveRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const clipObjectUrlRef = useRef<string | null>(null);
  const lastRestartTokenRef = useRef(controls.restartToken);

  useEffect(() => {
    let isActive = true;

    const syncDashboard = async () => {
      try {
        const [nextWorldState, nextControls] = await Promise.all([
          fetchWorldState(),
          fetchControlState(),
        ]);

        if (!isActive) {
          return;
        }

        startTransition(() => {
          setWorldState(nextWorldState);
          setControls(nextControls);
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
      void videoRef.current.play().catch(() => {
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
    setBoothClockMs(Date.now());
    setClipPositionMs(0);

    if (!videoRef.current) {
      return;
    }

    videoRef.current.currentTime = 0;

    if (controls.playbackStatus === 'playing') {
      void videoRef.current.play().catch(() => {
        setBoothError('Press play on the loaded clip if the browser blocks autoplay.');
      });
    }
  }, [controls.playbackStatus, controls.restartToken]);

  useEffect(() => {
    return () => {
      shouldKeepMicLiveRef.current = false;
      recognitionRef.current?.stop();

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

      switch (event.error) {
        case 'not-allowed':
          setMicrophoneAvailability('degraded');
          setBoothError('Microphone access was blocked. Allow mic access to test live hesitation.');
          break;
        case 'no-speech':
          setBoothError('No speech was detected. Try speaking a little closer to the mic.');
          break;
        case 'network':
          setMicrophoneAvailability('degraded');
          setBoothError(
            'This browser speech service is unavailable right now. Chrome or Edge usually work best.',
          );
          break;
        default:
          setMicrophoneAvailability('degraded');
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

    if (!SpeechRecognition) {
      setMicrophoneAvailability('unsupported');
      setBoothError('Use Chrome or Edge to test browser speech recognition in this booth.');
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

      shouldKeepMicLiveRef.current = true;
      recognition.start();
      setMicrophoneAvailability('supported');
      setBoothError(null);
      setIsMicListening(true);
      setBoothClockMs(Date.now());
    } catch (_error) {
      setBoothError('The browser could not start the microphone session. Try again once the tab is focused.');
    }
  }

  function stopMicrophone() {
    shouldKeepMicLiveRef.current = false;
    recognitionRef.current?.stop();
    setIsMicListening(false);
    setBoothInterimTranscript('');
  }

  function clearBoothTranscript() {
    setBoothTranscript([]);
    setBoothInterimTranscript('');
    setLastSpeechAtMs(-1);
    setBoothClockMs(Date.now());
    setBoothError(null);
  }

  async function startBroadcast() {
    if (controls.playbackStatus !== 'playing') {
      await sendControlPatch({ playbackStatus: 'playing' });
    }

    if (!isMicListening && isMicSupported) {
      startMicrophone();
    }
  }

  async function stopBroadcast() {
    if (isMicListening) {
      stopMicrophone();
    }

    if (controls.playbackStatus !== 'paused') {
      await sendControlPatch({ playbackStatus: 'paused' });
    }
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
  const latestBoothLine =
    boothInterimTranscript || boothTranscript[boothTranscript.length - 1]?.text || null;
  const recentEvents = [...worldState.recentEvents].reverse();
  const surfacedAssists = [...worldState.sessionMemory.surfacedAssists].reverse();
  const systemHesitationReasons =
    worldState.commentator.hesitationReasons.length > 0
      ? worldState.commentator.hesitationReasons
      : ['No replay-side hesitation trigger is active right now.'];
  const isMicSupported =
    microphoneAvailability !== 'unsupported' && Boolean(getSpeechRecognitionConstructor());
  const boothSignal = buildBoothSignal({
    boothTranscript,
    interimTranscript: boothInterimTranscript,
    isMicListening,
    lastSpeechAtMs,
    nowMs: boothClockMs,
  });
  const boothHasLiveInput =
    isMicListening || boothTranscript.length > 0 || boothInterimTranscript.length > 0;
  const isPracticeMode = true;
  const practiceAssist = createPracticeAssist(boothSignal);
  const workerAssistShouldSurface =
    assist.type !== 'none' &&
    (controls.forceHesitation ||
      !boothHasLiveInput ||
      boothSignal.shouldSurfaceAssist ||
      worldState.commentator.hesitationScore >= LIVE_HESITATION_GATE);
  const practiceAssistShouldSurface = boothHasLiveInput && boothSignal.shouldSurfaceAssist;
  const shouldSurfaceAssist = workerAssistShouldSurface || practiceAssistShouldSurface;
  const activeAssist = workerAssistShouldSurface
    ? assist
    : isPracticeMode
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
  const boothHesitationPercent = formatPercent(boothSignal.hesitationScore);
  const systemHesitationPercent = formatPercent(worldState.commentator.hesitationScore);
  const visibleReasons =
    boothHasLiveInput && boothSignal.hesitationReasons.length > 0
      ? boothSignal.hesitationReasons
      : boothHasLiveInput
        ? ['Talk through the play. The copilot will watch for pauses, fillers, and repeated starts.']
        : systemHesitationReasons;
  const clipClockLabel = formatDurationMs(clipPositionMs);
  const clipDurationLabel = clipDurationMs > 0 ? formatDurationMs(clipDurationMs) : '--:--';
  const clipProgress = clipDurationMs > 0 ? Math.min(100, Math.round((clipPositionMs / clipDurationMs) * 100)) : 0;
  const boothStatusLabel = isMicListening
    ? boothSignal.isSpeaking
      ? 'Mic live'
      : 'Listening for the next beat'
    : isMicSupported
      ? microphoneAvailability === 'degraded'
        ? 'Mic degraded'
        : 'Mic ready'
      : 'Mic unavailable';
  const boothStatusTone = isMicListening
    ? 'status-pill--live'
    : microphoneAvailability === 'degraded'
      ? 'status-pill--warning'
      : isMicSupported
      ? 'status-pill--ghost'
      : 'status-pill--warning';
  const isBroadcastLive = controls.playbackStatus === 'playing' || isMicListening;
  const replayToastSignature = `${activeAssist.type}:${activeAssist.text}:${shouldSurfaceAssist}:${controls.restartToken}`;
  const activeTriggerBadges = [
    boothSignal.pauseDurationMs >= LONG_PAUSE_START_MS ? 'pause' : null,
    boothSignal.fillerWords.length > 0 ? 'filler' : null,
    boothSignal.repeatedPhrases.length > 0 ? 'repeat-start' : null,
    boothSignal.unfinishedPhrase ? 'unfinished' : null,
  ].filter(Boolean) as string[];
  const preMatchSummary = worldState.preMatch.aiOpener ?? worldState.preMatch.deterministicOpener;

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">{isPracticeMode ? 'Practice Booth' : 'Controlled El Clasico Replay'}</p>
          <h1>Sports Copilot</h1>
          <p className="hero-copy">
            {isPracticeMode
              ? 'Test hesitation tracking, confidence, and assist timing against your own commentary on any clip.'
              : 'A replay-aware commentator booth with a real clip window, live hesitation tracking, and grounded assist timing.'}
          </p>
        </div>

        <div className="hero-meta">
          <span className={`status-pill ${error ? 'status-pill--warning' : 'status-pill--live'}`}>
            {error ? 'Reconnecting' : isHydrated ? 'Live Sync' : 'Booting'}
          </span>
          <span className={`status-pill ${boothStatusTone}`}>{boothStatusLabel}</span>
          <span className="status-pill status-pill--ghost">
            {isBroadcastLive ? 'Broadcast live' : 'Broadcast idle'}
          </span>
          <span className="status-pill status-pill--ghost">
            {worldState.liveMatch.fixtureId ? `Fixture ${worldState.liveMatch.fixtureId}` : 'No fixture'}
          </span>
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
        <section className="panel replay-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Practice Booth</p>
              <h2>Test hesitation on any clip</h2>
            </div>
            <span className="panel-tag">
              {loadedClipUrl ? `${clipClockLabel} / ${clipDurationLabel}` : 'Load a clip to begin'}
            </span>
          </div>

          <div className="media-toolbar">
            <label className="file-chip">
              <span>{loadedClipUrl ? 'Replace Clip' : 'Load Replay Clip'}</span>
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
                <span className="live-chip">{loadedClipUrl ? 'Practice clip' : 'Ready for practice'}</span>
                <h3>{loadedClipUrl ? 'Test your booth timing against the clip.' : 'Load a clip and start talking.'}</h3>
                <p>
                  Speak naturally, leave a beat, repeat yourself, or use filler words to test the
                  hesitation tracker.
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
                  <p className="assist-type">Booth monitor</p>
                  <h3>{latestBoothLine ?? 'Talk through the play.'}</h3>
                  <p>Leave a beat and the grounded assist will surface when the hesitation is real.</p>
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
          <section className="panel control-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Broadcast Control</p>
                <h2>Start the booth</h2>
              </div>
              <span className="panel-tag">{isUpdatingControls ? 'Applying' : boothStatusLabel}</span>
            </div>

            <div className="control-group">
              <p className="control-label">Broadcast</p>
              <div className="primary-controls">
                <button
                  type="button"
                  className={isBroadcastLive ? 'is-active' : ''}
                  onClick={() => void (isBroadcastLive ? stopBroadcast() : startBroadcast())}
                >
                  {isBroadcastLive ? 'Stop Broadcast' : 'Start Broadcast'}
                </button>
              </div>
              <div className="inline-actions">
                <button type="button" className="text-button" onClick={() => void resetBroadcast()}>
                  Reset broadcast
                </button>
                <button type="button" className="text-button" onClick={clearBoothTranscript}>
                  Clear transcript
                </button>
              </div>
            </div>

            <article className="booth-card">
              <div className="booth-card__header">
                <div>
                  <p className="control-label">Live hesitation</p>
                  <strong>{boothHesitationPercent}</strong>
                </div>
                <span className={`status-pill ${boothStatusTone}`}>{boothSignal.activeSpeaker}</span>
              </div>

              <div className="meter-track">
                <span style={{ width: boothHesitationPercent }} />
              </div>

              <div className="reason-list">
                {visibleReasons.map((reason) => (
                  <p key={reason}>{reason}</p>
                ))}
              </div>

              <p className="field-copy">
                The clip is muted by default so the booth mic tracks your voice instead of the
                program feed. Chrome or Edge work best for live hesitation testing.
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
          </section>

        </div>
      </div>

      <div className="details-toggle-row">
        <button
          type="button"
          className="text-button"
          onClick={() => setShowDetails((current) => !current)}
        >
          {showDetails ? 'Hide system details' : 'Show system details'}
        </button>
      </div>

      {showDetails ? (
        <div className="bottom-grid">
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
          </section>
        </div>
      ) : null}
    </div>
  );
}

export default App;
