import { TranscriptEntry } from '@sports-copilot/shared-types';

export type BoothActiveSpeaker = 'lead' | 'none';

export type BoothSignal = {
  activeSpeaker: BoothActiveSpeaker;
  hesitationScore: number;
  confidenceScore: number;
  hesitationReasons: string[];
  pauseDurationMs: number;
  fillerWords: string[];
  repeatedPhrases: string[];
  unfinishedPhrase: boolean;
  isSpeaking: boolean;
  audioLevel: number;
  hasVoiceActivity: boolean;
  shouldSurfaceAssist: boolean;
};

export const ACTIVE_SPEECH_WINDOW_MS = 1_400;
export const LIVE_HESITATION_GATE = 0.36;
export const LONG_PAUSE_START_MS = 1_200;
export const FULL_HESITATION_PAUSE_MS = 4_200;
export const AUDIO_ACTIVITY_WINDOW_MS = 850;
export const LOCAL_TRANSCRIPT_LIMIT = 8;
export const RECOVERY_CONFIDENCE_FLOOR = 0.18;

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

export function buildBoothSignal({
  boothTranscript,
  interimTranscript,
  isMicListening,
  lastSpeechAtMs,
  lastVoiceActivityAtMs,
  audioLevel,
  nowMs,
}: {
  boothTranscript: TranscriptEntry[];
  interimTranscript: string;
  isMicListening: boolean;
  lastSpeechAtMs: number;
  lastVoiceActivityAtMs: number;
  audioLevel: number;
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
  const recentVoiceActivity =
    lastVoiceActivityAtMs >= 0 && nowMs - lastVoiceActivityAtMs < AUDIO_ACTIVITY_WINDOW_MS;
  const recentTranscriptActivity =
    lastSpeechAtMs >= 0 && nowMs - lastSpeechAtMs < ACTIVE_SPEECH_WINDOW_MS;
  const isSpeaking =
    isMicListening && (interimText.length > 0 || recentTranscriptActivity || recentVoiceActivity);
  const lastActivityAtMs = Math.max(lastSpeechAtMs, lastVoiceActivityAtMs);
  const pauseDurationMs =
    !isSpeaking && lastActivityAtMs >= 0 ? Math.max(0, nowMs - lastActivityAtMs) : 0;
  const hesitationReasons: string[] = [];
  let hesitationScore = 0;

  if (pauseDurationMs >= LONG_PAUSE_START_MS) {
    const pauseSeconds = Math.round((pauseDurationMs / 1_000) * 10) / 10;
    const pauseBuild = clamp(
      (pauseDurationMs - LONG_PAUSE_START_MS) /
        Math.max(1, FULL_HESITATION_PAUSE_MS - LONG_PAUSE_START_MS),
    );
    hesitationScore = Math.max(hesitationScore, pauseBuild);
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

  const confidenceScore = isSpeaking
    ? clamp(0.72 + Math.min(0.18, audioLevel * 1.8) - hesitationScore * 0.3)
    : clamp(
        0.78 -
          hesitationScore * 0.95 -
          Math.min(0.28, Math.max(0, pauseDurationMs - LONG_PAUSE_START_MS) / 5_000),
        RECOVERY_CONFIDENCE_FLOOR,
        0.88,
      );

  return {
    activeSpeaker: isSpeaking ? 'lead' : 'none',
    hesitationScore: clamp(hesitationScore),
    confidenceScore,
    hesitationReasons,
    pauseDurationMs,
    fillerWords,
    repeatedPhrases,
    unfinishedPhrase,
    isSpeaking,
    audioLevel,
    hasVoiceActivity: recentVoiceActivity,
    shouldSurfaceAssist: hesitationScore >= LIVE_HESITATION_GATE,
  };
}

export function calculateAudioLevel(samples: Uint8Array) {
  if (samples.length === 0) {
    return 0;
  }

  let total = 0;

  for (const sample of samples) {
    const normalized = sample / 128 - 1;
    total += normalized * normalized;
  }

  return Math.sqrt(total / samples.length);
}
