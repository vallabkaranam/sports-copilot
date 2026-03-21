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
  getReplayProgress,
  parseClock,
} from './dashboard';

type BoothActiveSpeaker = 'lead' | 'none';

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
    hesitationScore +=
      clamp((pauseDurationMs - LONG_PAUSE_START_MS) / PAUSE_RANGE_MS) * 0.55;
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
  const [boothTranscript, setBoothTranscript] = useState<TranscriptEntry[]>([]);
  const [boothInterimTranscript, setBoothInterimTranscript] = useState('');
  const [boothError, setBoothError] = useState<string | null>(null);
  const [isMicListening, setIsMicListening] = useState(false);
  const [lastSpeechAtMs, setLastSpeechAtMs] = useState(-1);
  const [boothClockMs, setBoothClockMs] = useState(() => Date.now());
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

      switch (event.error) {
        case 'not-allowed':
          setBoothError('Microphone access was blocked. Allow mic access to test live hesitation.');
          break;
        case 'no-speech':
          setBoothError('No speech was detected. Try speaking a little closer to the mic.');
          break;
        default:
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

  const assist = worldState.assist;
  const latestTranscript =
    worldState.commentator.recentTranscript[
      worldState.commentator.recentTranscript.length - 1
    ];
  const latestSocial =
    worldState.liveSignals.social[worldState.liveSignals.social.length - 1];
  const latestBoothLine =
    boothInterimTranscript || boothTranscript[boothTranscript.length - 1]?.text || null;
  const replayProgress = getReplayProgress(worldState.clock);
  const recentEvents = [...worldState.recentEvents].reverse();
  const surfacedAssists = [...worldState.sessionMemory.surfacedAssists].reverse();
  const systemHesitationReasons =
    worldState.commentator.hesitationReasons.length > 0
      ? worldState.commentator.hesitationReasons
      : ['No replay-side hesitation trigger is active right now.'];
  const isMicSupported = Boolean(getSpeechRecognitionConstructor());
  const boothSignal = buildBoothSignal({
    boothTranscript,
    interimTranscript: boothInterimTranscript,
    isMicListening,
    lastSpeechAtMs,
    nowMs: boothClockMs,
  });
  const boothHasLiveInput =
    isMicListening || boothTranscript.length > 0 || boothInterimTranscript.length > 0;
  const shouldSurfaceAssist =
    assist.type !== 'none' &&
    (controls.forceHesitation ||
      !boothHasLiveInput ||
      boothSignal.shouldSurfaceAssist ||
      worldState.commentator.hesitationScore >= LIVE_HESITATION_GATE);
  const assistCardText = shouldSurfaceAssist
    ? assist.text
    : boothHasLiveInput
      ? 'Copilot is listening for a real hesitation beat before it jumps in.'
      : 'System holding its fire until the booth needs help.';
  const assistWhyNow = shouldSurfaceAssist
    ? assist.whyNow
    : boothHasLiveInput
      ? 'Talk through the play and leave a beat. The assist will surface once your cadence breaks.'
      : 'No assist needed right now.';
  const assistType = shouldSurfaceAssist ? assist.type : 'none';
  const assistStyleMode = shouldSurfaceAssist ? assist.styleMode : controls.preferredStyleMode;
  const assistConfidencePercent = formatPercent(shouldSurfaceAssist ? assist.confidence : 0);
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
  const clipSyncDeltaMs = loadedClipUrl ? Math.abs(clipPositionMs - parseClock(worldState.clock)) : 0;
  const clipSyncLabel =
    loadedClipUrl && clipDurationMs > 0
      ? clipSyncDeltaMs <= 2_000
        ? 'Fixture timing aligned'
        : `Fixture delta ${formatDurationMs(clipSyncDeltaMs)}`
      : 'Load the replay clip to compare the footage with the fixture clock';
  const boothStatusLabel = isMicListening
    ? boothSignal.isSpeaking
      ? 'Mic live'
      : 'Listening for the next beat'
    : isMicSupported
      ? 'Mic ready'
      : 'Mic unavailable';
  const boothStatusTone = isMicListening
    ? 'status-pill--live'
    : isMicSupported
      ? 'status-pill--ghost'
      : 'status-pill--warning';
  const replayToastSignature = `${assist.type}:${assist.text}:${shouldSurfaceAssist}:${controls.restartToken}`;

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Controlled El Clasico Replay</p>
          <h1>Sports Copilot</h1>
          <p className="hero-copy">
            A replay-aware commentator booth with a real clip window, live hesitation tracking,
            and grounded assist timing.
          </p>
        </div>

        <div className="hero-meta">
          <span className={`status-pill ${error ? 'status-pill--warning' : 'status-pill--live'}`}>
            {error ? 'Reconnecting' : isHydrated ? 'Live Sync' : 'Booting'}
          </span>
          <span className={`status-pill ${boothStatusTone}`}>{boothStatusLabel}</span>
          <span className="status-pill status-pill--ghost">{controls.preferredStyleMode} mode</span>
        </div>
      </header>

      {error ? <div className="warning-banner">{error}</div> : null}

      <section className="panel score-strip">
        <div className="team-block">
          <span className="team-code">{TEAM_META.home.code}</span>
          <div>
            <p className="team-name">{TEAM_META.home.name}</p>
            <p className="team-note">Fixture lane</p>
          </div>
        </div>

        <div className="score-center">
          <p className="score-label">Replay Clock</p>
          <div className="scoreline">
            <span>{worldState.score.home}</span>
            <span className="score-divider">:</span>
            <span>{worldState.score.away}</span>
          </div>
          <p className="clock-chip">{worldState.clock}</p>
        </div>

        <div className="team-block team-block--away">
          <div>
            <p className="team-name">{TEAM_META.away.name}</p>
            <p className="team-note">Counter threat live</p>
          </div>
          <span className="team-code">{TEAM_META.away.code}</span>
        </div>

        <div className="score-sidecar">
          <p className="score-label">Possession</p>
          <strong>{worldState.possession}</strong>
          <p className="score-sidecar-copy">{worldState.gameStateSummary}</p>
        </div>
      </section>

      <div className="main-grid">
        <section className="panel replay-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Replay Booth</p>
              <h2>See the clip and the cue timing together</h2>
            </div>
            <span className="panel-tag">
              {loadedClipUrl ? `${clipClockLabel} / ${clipDurationLabel}` : `${replayProgress}% through fixture`}
            </span>
          </div>

          <div className="media-toolbar">
            <label className="file-chip">
              <span>Load Replay Clip</span>
              <input type="file" accept="video/*" onChange={handleClipChange} />
            </label>
            <div className="media-meta">
              <span className="meta-pill">{loadedClipName || 'No local clip loaded yet'}</span>
              <span className="meta-pill">{clipSyncLabel}</span>
            </div>
            {loadedClipUrl ? (
              <button type="button" className="ghost-button" onClick={clearLoadedClip}>
                Remove Clip
              </button>
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
                <span className="live-chip">
                  {loadedClipUrl ? 'Loaded footage' : 'Fixture director cue'}
                </span>
                <h3>{worldState.gameStateSummary}</h3>
                <p>
                  {latestTranscript
                    ? latestTranscript.text
                    : 'Load the replay clip and press play to compare the footage with the fixture state.'}
                </p>
              </div>

              {shouldSurfaceAssist ? (
                <article className="replay-toast" key={replayToastSignature}>
                  <p className="assist-type">{formatAssistType(assist.type)}</p>
                  <h3>{assist.text}</h3>
                  <p>{assist.whyNow}</p>
                </article>
              ) : boothHasLiveInput ? (
                <div className="replay-toast replay-toast--hint">
                  <p className="assist-type">Booth monitor</p>
                  <h3>{latestBoothLine ?? 'Talk through the play.'}</h3>
                  <p>Leave a beat and the grounded assist will surface when the hesitation is real.</p>
                </div>
              ) : null}

              <div className="replay-tags">
                {worldState.liveSignals.vision.length > 0 ? (
                  worldState.liveSignals.vision.map((cue) => (
                    <span className="scene-chip" key={`${cue.timestamp}-${cue.tag}`}>
                      {cue.tag}
                    </span>
                  ))
                ) : (
                  <span className="scene-chip scene-chip--muted">Awaiting visual cue</span>
                )}
              </div>

              <div className="replay-footer">
                <div className="progress-track" aria-label="Replay progress">
                  <span style={{ width: `${replayProgress}%` }} />
                </div>
                <p className="pulse-copy">
                  {latestSocial
                    ? `${latestSocial.handle}: ${latestSocial.text}`
                    : 'Social pulse and crowd reaction will populate as the sequence heats up.'}
                </p>
              </div>
            </div>
          </div>
        </section>

        <div className="side-column">
          <section className="panel control-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Commentator Booth</p>
                <h2>Talk into the replay</h2>
              </div>
              <span className="panel-tag">{isUpdatingControls ? 'Applying' : boothStatusLabel}</span>
            </div>

            <div className="control-group">
              <p className="control-label">Replay</p>
              <div className="segmented-control">
                <button
                  type="button"
                  className={controls.playbackStatus === 'playing' ? 'is-active' : ''}
                  onClick={() => void sendControlPatch({ playbackStatus: 'playing' })}
                >
                  Play
                </button>
                <button
                  type="button"
                  className={controls.playbackStatus === 'paused' ? 'is-active' : ''}
                  onClick={() => void sendControlPatch({ playbackStatus: 'paused' })}
                >
                  Pause
                </button>
                <button type="button" onClick={() => void sendControlPatch({ restart: true })}>
                  Restart
                </button>
              </div>
            </div>

            <div className="control-group">
              <p className="control-label">Style Mode</p>
              <div className="segmented-control">
                <button
                  type="button"
                  aria-pressed={controls.preferredStyleMode === 'analyst'}
                  className={controls.preferredStyleMode === 'analyst' ? 'is-active' : ''}
                  onClick={() => void sendControlPatch({ preferredStyleMode: 'analyst' })}
                >
                  Analyst
                </button>
                <button
                  type="button"
                  aria-pressed={controls.preferredStyleMode === 'hype'}
                  className={controls.preferredStyleMode === 'hype' ? 'is-active' : ''}
                  onClick={() => void sendControlPatch({ preferredStyleMode: 'hype' })}
                >
                  Hype
                </button>
              </div>
            </div>

            <div className="control-group">
              <p className="control-label">Microphone</p>
              <div className="mic-controls">
                <button
                  type="button"
                  className={isMicListening ? 'is-active' : ''}
                  onClick={startMicrophone}
                  disabled={!isMicSupported || isMicListening}
                >
                  Start Mic
                </button>
                <button type="button" onClick={stopMicrophone} disabled={!isMicListening}>
                  Stop Mic
                </button>
                <button type="button" onClick={clearBoothTranscript}>
                  Clear Booth
                </button>
              </div>
              <p className="field-copy">
                Browser speech recognition is local to the tab. Chrome or Edge work best for live
                hesitation testing.
              </p>
              {boothError ? <p className="inline-warning">{boothError}</p> : null}
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
                      ? 'Start the mic and talk through the replay to see live booth transcript here.'
                      : 'This browser does not expose speech recognition, so the booth stays in replay-only mode.'}
                  </p>
                )}
                {boothInterimTranscript ? (
                  <p className="transcript-line transcript-line--interim">{boothInterimTranscript}</p>
                ) : null}
              </div>
            </article>

            <div className="control-group">
              <p className="control-label">Backup Trigger</p>
              <button
                type="button"
                className={`toggle-button ${controls.forceHesitation ? 'toggle-button--on' : ''}`}
                aria-pressed={controls.forceHesitation}
                onClick={() =>
                  void sendControlPatch({ forceHesitation: !controls.forceHesitation })
                }
              >
                {controls.forceHesitation ? 'Force Hesitation On' : 'Force Hesitation Off'}
              </button>
            </div>
          </section>

          <section className="panel assist-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Active Assist</p>
                <h2>Copilot card</h2>
              </div>
              <span className={`panel-tag panel-tag--${assistStyleMode}`}>{assistStyleMode}</span>
            </div>

            <article
              className={`assist-card ${shouldSurfaceAssist ? 'assist-card--live' : ''}`}
              key={`${assistType}:${assistCardText}:${assistWhyNow}`}
            >
              <div className="assist-card__header">
                <div>
                  <p className="assist-type">{formatAssistType(assistType)}</p>
                  <h3>{assistCardText}</h3>
                </div>
                <div className="assist-confidence">
                  <span>Confidence</span>
                  <strong>{assistConfidencePercent}</strong>
                </div>
              </div>

              <p className="assist-why">{assistWhyNow}</p>

              <div className="assist-meta">
                <span className="meta-pill">
                  {shouldSurfaceAssist ? assist.urgency : 'standing by'} urgency
                </span>
                <span className="meta-pill">{controls.preferredStyleMode} preference</span>
                <span className="meta-pill">
                  {shouldSurfaceAssist ? assist.sourceChips.length : 0} sources grounded
                </span>
              </div>

              <div className="source-chip-row">
                {shouldSurfaceAssist && assist.sourceChips.length > 0 ? (
                  assist.sourceChips.map((chip) => (
                    <span className="source-chip" key={chip.id}>
                      {chip.label}
                    </span>
                  ))
                ) : (
                  <span className="source-chip source-chip--muted">
                    Source chips appear when a grounded assist is surfaced.
                  </span>
                )}
              </div>
            </article>
          </section>
        </div>
      </div>

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
        </section>
      </div>
    </div>
  );
}

export default App;
