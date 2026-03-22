import { TranscriptEntry } from '@sports-copilot/shared-types';

export type BoothActiveSpeaker = 'lead' | 'none';

export type BoothSignal = {
  activeSpeaker: BoothActiveSpeaker;
  hesitationScore: number;
  confidenceScore: number;
  hesitationReasons: string[];
  hesitationContributors: BoothSignalContributor[];
  confidenceReasons: string[];
  confidenceContributors: BoothSignalContributor[];
  pauseDurationMs: number;
  speechStreakMs: number;
  silenceStreakMs: number;
  fillerCount: number;
  fillerDensity: number;
  fillerWords: string[];
  repeatedOpeningCount: number;
  repeatedPhrases: string[];
  unfinishedPhrase: boolean;
  transcriptWordCount: number;
  transcriptStabilityScore: number;
  wakePhraseDetected: boolean;
  isSpeaking: boolean;
  audioLevel: number;
  hasVoiceActivity: boolean;
  shouldSurfaceAssist: boolean;
};

export type BoothSignalContributor = {
  key:
    | 'pause'
    | 'filler'
    | 'repeat-start'
    | 'unfinished'
    | 'wake-phrase'
    | 'speech-recovery'
    | 'audio-presence';
  label: string;
  score: number;
};

export type BoothActivityState = {
  isSpeaking: boolean;
  hasVoiceActivity: boolean;
  lastActivityAtMs: number;
};

export const ACTIVE_SPEECH_WINDOW_MS = 1_400;
export const LIVE_HESITATION_GATE = 0.36;
export const LONG_PAUSE_START_MS = 1_200;
export const FULL_HESITATION_PAUSE_MS = 4_200;
export const AUDIO_ACTIVITY_WINDOW_MS = 850;
export const LOCAL_TRANSCRIPT_LIMIT = 8;
export const RECOVERY_CONFIDENCE_FLOOR = 0.18;
export const FULL_RECOVERY_SPEECH_MS = 3_200;
export const STRONG_AUDIO_LEVEL = 0.12;

const FILLER_PATTERNS = [
  { token: 'uh', pattern: /\buh\b/gi },
  { token: 'um', pattern: /\bum\b/gi },
  { token: 'er', pattern: /\ber\b/gi },
  { token: 'ah', pattern: /\bah\b/gi },
  { token: 'you know', pattern: /\byou know\b/gi },
  { token: 'i mean', pattern: /\bi mean\b/gi },
] as const;
const WAKE_PHRASES = ['line', 'but um'] as const;

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

function detectWakePhrase(texts: string[]) {
  const normalized = texts.map(normalizeTranscriptText).join(' ');

  return WAKE_PHRASES.find((phrase) =>
    normalized.includes(normalizeTranscriptText(phrase)),
  );
}

function detectFillerBurst(texts: string[]) {
  const normalized = texts.map(normalizeTranscriptText).join(' ');

  return /\b(?:uh|um|er|ah)\b(?:\s+\w+){0,3}\s+\b(?:uh|um|er|ah)\b/i.test(normalized);
}

function countTranscriptWords(texts: string[]) {
  return texts
    .flatMap((text) => normalizeTranscriptText(text).split(' ').filter(Boolean))
    .length;
}

function findRepeatedPhrases(texts: string[]) {
  const repeatedPhrases: string[] = [];
  const prefixCounts = new Map<string, number>();

  for (const text of texts) {
    const words = normalizeTranscriptText(text).split(' ').filter(Boolean);

    if (words.length < 1) {
      continue;
    }

    const prefix = words.slice(0, Math.min(3, words.length)).join(' ');

    if (prefix.length < 3) {
      continue;
    }

    const nextCount = (prefixCounts.get(prefix) ?? 0) + 1;
    prefixCounts.set(prefix, nextCount);

    if (nextCount === 2) {
      repeatedPhrases.push(prefix);
    }

    for (const size of [3, 2]) {
      if (words.length < size * 2) {
        continue;
      }

      const opening = words.slice(0, size).join(' ');
      if (opening.length < 3) {
        continue;
      }

      for (let index = size; index <= words.length - size; index += 1) {
        const candidate = words.slice(index, index + size).join(' ');
        if (candidate === opening && !repeatedPhrases.includes(opening)) {
          repeatedPhrases.push(opening);
          break;
        }
      }
    }
  }

  return repeatedPhrases;
}

export function deriveBoothActivity({
  interimTranscript,
  isMicListening,
  lastSpeechAtMs,
  lastVoiceActivityAtMs,
  nowMs,
}: {
  interimTranscript: string;
  isMicListening: boolean;
  lastSpeechAtMs: number;
  lastVoiceActivityAtMs: number;
  nowMs: number;
}): BoothActivityState {
  const hasVoiceActivity =
    lastVoiceActivityAtMs >= 0 && nowMs - lastVoiceActivityAtMs < AUDIO_ACTIVITY_WINDOW_MS;
  const hasTranscriptActivity =
    lastSpeechAtMs >= 0 && nowMs - lastSpeechAtMs < ACTIVE_SPEECH_WINDOW_MS;
  const isSpeaking =
    isMicListening &&
    (interimTranscript.trim().length > 0 || hasTranscriptActivity || hasVoiceActivity);

  return {
    isSpeaking,
    hasVoiceActivity,
    lastActivityAtMs: Math.max(lastSpeechAtMs, lastVoiceActivityAtMs),
  };
}

export function buildBoothSignal({
  boothTranscript,
  interimTranscript,
  isMicListening,
  lastSpeechAtMs,
  lastVoiceActivityAtMs,
  audioLevel,
  nowMs,
  speechStreakStartedAtMs = -1,
  silenceStreakStartedAtMs = -1,
}: {
  boothTranscript: TranscriptEntry[];
  interimTranscript: string;
  isMicListening: boolean;
  lastSpeechAtMs: number;
  lastVoiceActivityAtMs: number;
  audioLevel: number;
  nowMs: number;
  speechStreakStartedAtMs?: number;
  silenceStreakStartedAtMs?: number;
}): BoothSignal {
  const recentTranscript = boothTranscript.slice(-LOCAL_TRANSCRIPT_LIMIT);
  const transcriptTexts = recentTranscript.map((entry) => entry.text);
  const interimText = interimTranscript.trim();
  const analysisTexts = interimText ? [...transcriptTexts, interimText] : transcriptTexts;
  const fillerWords = collectFillerWords(
    analysisTexts,
  );
  const fillerCount = fillerWords.length;
  const fillerBurstDetected = detectFillerBurst(analysisTexts);
  const repeatedPhrases = findRepeatedPhrases(analysisTexts);
  const repeatedOpeningCount = repeatedPhrases.length;
  const lastLine = interimText || recentTranscript[recentTranscript.length - 1]?.text.trim() || '';
  const unfinishedPhrase = /(?:\.\.\.|-)\s*$/.test(lastLine);
  const wakePhrase = detectWakePhrase(analysisTexts);
  const transcriptWordCount = Math.max(1, countTranscriptWords(analysisTexts));
  const fillerDensity = clamp(fillerCount / transcriptWordCount);
  const activity = deriveBoothActivity({
    interimTranscript,
    isMicListening,
    lastSpeechAtMs,
    lastVoiceActivityAtMs,
    nowMs,
  });
  const { isSpeaking, hasVoiceActivity, lastActivityAtMs } = activity;
  const pauseDurationMs =
    !isSpeaking && lastActivityAtMs >= 0 ? Math.max(0, nowMs - lastActivityAtMs) : 0;
  const speechStreakMs =
    isSpeaking && speechStreakStartedAtMs >= 0 ? Math.max(0, nowMs - speechStreakStartedAtMs) : 0;
  const silenceStreakMs =
    !isSpeaking && silenceStreakStartedAtMs >= 0
      ? Math.max(0, nowMs - silenceStreakStartedAtMs)
      : pauseDurationMs;
  const hesitationReasons: string[] = [];
  const hesitationContributors: BoothSignalContributor[] = [];
  const confidenceReasons: string[] = [];
  const confidenceContributors: BoothSignalContributor[] = [];
  let hesitationScore = 0;
  let fillerContribution = 0;
  let unfinishedContribution = 0;
  let repeatedContribution = 0;
  let wakePhraseContribution = 0;

  if (silenceStreakMs >= LONG_PAUSE_START_MS) {
    const pauseSeconds = Math.round((silenceStreakMs / 1_000) * 10) / 10;
    const pauseContribution = clamp(
      (silenceStreakMs - LONG_PAUSE_START_MS) /
        Math.max(1, FULL_HESITATION_PAUSE_MS - LONG_PAUSE_START_MS),
    );
    hesitationScore += pauseContribution;
    hesitationReasons.push(`You paused for ${pauseSeconds}s after the last thought.`);
    hesitationContributors.push({
      key: 'pause',
      label: 'Extended pause',
      score: pauseContribution,
    });
  }

  if (fillerCount > 0) {
    const uniqueFillers = [...new Set(fillerWords)];
    fillerContribution = Math.min(
      0.46,
      0.11 * fillerCount +
        fillerDensity * 0.34 +
        (fillerBurstDetected ? 0.16 : 0),
    );
    hesitationScore += fillerContribution;
    hesitationReasons.push(
      fillerBurstDetected
        ? `You said filler words like ${uniqueFillers.join(', ')}, so AndOne is stepping in.`
        : `You said filler words like ${uniqueFillers.join(', ')}.`,
    );
    hesitationContributors.push({
      key: 'filler',
      label: 'Filler language',
      score: fillerContribution,
    });
  }

  if (unfinishedPhrase && pauseDurationMs >= 900) {
    unfinishedContribution = 0.18;
    hesitationScore += unfinishedContribution;
    hesitationReasons.push('The last line trails off mid-thought.');
    hesitationContributors.push({
      key: 'unfinished',
      label: 'Unfinished thought',
      score: unfinishedContribution,
    });
  }

  if (repeatedOpeningCount > 0) {
    repeatedContribution = Math.min(0.2, repeatedOpeningCount * 0.1);
    hesitationScore += repeatedContribution;
    hesitationReasons.push(`Repeated opening: "${repeatedPhrases[0]}".`);
    hesitationContributors.push({
      key: 'repeat-start',
      label: 'Repeated opening',
      score: repeatedContribution,
    });
  }

  if (wakePhrase) {
    wakePhraseContribution = 0.72;
    hesitationScore = Math.max(hesitationScore, wakePhraseContribution);
    hesitationReasons.push(`You used the wake phrase "${wakePhrase}", so AndOne is stepping in now.`);
    hesitationContributors.push({
      key: 'wake-phrase',
      label: 'Wake phrase',
      score: wakePhraseContribution,
    });
  }

  const transcriptInstabilityPenalty = clamp(
    fillerDensity * 0.45 +
      repeatedOpeningCount * 0.18 +
      (unfinishedPhrase ? 0.2 : 0) +
      (fillerBurstDetected ? 0.14 : 0) +
      (interimText.length > 0 && !isSpeaking ? 0.12 : 0),
  );
  const transcriptStabilityScore = clamp(1 - transcriptInstabilityPenalty);

  const clampedHesitationScore = clamp(hesitationScore);
  let confidenceScore = 0;

  if (isSpeaking) {
    const recoveryContribution = clamp(speechStreakMs / FULL_RECOVERY_SPEECH_MS);
    const audioContribution = clamp(audioLevel / STRONG_AUDIO_LEVEL);
    const deliveryPenalty = clamp(
      fillerContribution + repeatedContribution + unfinishedContribution,
      0,
      0.65,
    );

    confidenceScore = clamp(
      recoveryContribution * 0.65 + audioContribution * 0.35 - deliveryPenalty,
      RECOVERY_CONFIDENCE_FLOOR,
      1,
    );

    confidenceContributors.push({
      key: 'speech-recovery',
      label: 'Sustained speech recovery',
      score: recoveryContribution,
    });
    confidenceContributors.push({
      key: 'audio-presence',
      label: 'Voice presence',
      score: audioContribution,
    });
    confidenceReasons.push(
      recoveryContribution >= 0.7
        ? 'Your delivery has settled back into a steady run.'
        : 'Confidence is rebuilding as you keep the call moving.',
    );

    if (deliveryPenalty > 0) {
      confidenceReasons.push('Transcript instability is still holding confidence down.');
    }
  } else if (lastActivityAtMs >= 0) {
    confidenceReasons.push('Confidence is inactive while the call is silent.');
  }

  return {
    activeSpeaker: isSpeaking ? 'lead' : 'none',
    hesitationScore: clampedHesitationScore,
    confidenceScore,
    hesitationReasons,
    hesitationContributors,
    confidenceReasons,
    confidenceContributors,
    pauseDurationMs,
    speechStreakMs,
    silenceStreakMs,
    fillerWords,
    fillerCount,
    fillerDensity,
    repeatedOpeningCount,
    repeatedPhrases,
    unfinishedPhrase,
    transcriptWordCount,
    transcriptStabilityScore,
    wakePhraseDetected: Boolean(wakePhrase),
    isSpeaking,
    audioLevel,
    hasVoiceActivity,
    shouldSurfaceAssist: clampedHesitationScore >= LIVE_HESITATION_GATE,
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
