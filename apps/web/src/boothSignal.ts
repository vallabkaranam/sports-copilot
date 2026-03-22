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
  wordsPerMinute: number;
  pacePressureScore: number;
  repeatedIdeaCount: number;
  repeatedIdeaPhrases: string[];
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
    | 'repeat-idea'
    | 'unfinished'
    | 'wake-phrase'
    | 'pace-pressure'
    | 'speech-recovery'
    | 'audio-presence';
  label: string;
  score: number;
};

export type BoothGuidanceScoreResolution = {
  effectiveHesitationScore: number;
  effectiveRecoveryScore: number;
  rawHesitationScore: number;
  rawRecoveryScore: number;
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
  { token: 'uhh', pattern: /\buhh+\b/gi },
  { token: 'um', pattern: /\bum\b/gi },
  { token: 'umm', pattern: /\bumm+\b/gi },
  { token: 'er', pattern: /\ber\b/gi },
  { token: 'err', pattern: /\berr+\b/gi },
  { token: 'erm', pattern: /\berm\b/gi },
  { token: 'ah', pattern: /\bah\b/gi },
  { token: 'kind of', pattern: /\bkind of\b/gi },
  { token: 'sort of', pattern: /\bsort of\b/gi },
  { token: 'basically', pattern: /\bbasically\b/gi },
  { token: 'you know', pattern: /\byou know\b/gi },
  { token: 'i mean', pattern: /\bi mean\b/gi },
] as const;
const WAKE_PHRASES = ['line', 'need a line', 'give me a line', 'what is the line', 'what’s the line', 'feed me a line', 'but um'] as const;
const MIN_SPEAKING_WPM = 105;
const HIGH_PRESSURE_WPM = 220;
const IDEA_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'have',
  'i',
  'is',
  'just',
  'now',
  'of',
  'or',
  'really',
  'the',
  'this',
  'to',
]);

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function resolveBoothGuidanceScores(params: {
  localHesitationScore: number;
  localConfidenceScore: number;
  interpretedHesitationScore?: number;
  interpretedRecoveryScore?: number;
  interpretationState?: 'standby' | 'monitoring' | 'step-in' | 'weaning-off';
}): BoothGuidanceScoreResolution {
  const rawHesitationScore = clamp(
    Math.max(params.localHesitationScore, params.interpretedHesitationScore ?? 0),
  );
  const rawRecoveryScore = clamp(
    Math.max(params.localConfidenceScore, params.interpretedRecoveryScore ?? 0),
  );

  const reductionWeight =
    params.interpretationState === 'weaning-off'
      ? 0.92
      : rawHesitationScore >= 0.6
        ? 0.68
        : rawHesitationScore >= LIVE_HESITATION_GATE
          ? 0.8
          : 0.9;
  const recoveryReduction = rawRecoveryScore * reductionWeight;
  let effectiveHesitationScore = clamp(rawHesitationScore - recoveryReduction);

  if (rawRecoveryScore >= 0.72 && rawHesitationScore <= 0.32) {
    effectiveHesitationScore = clamp(effectiveHesitationScore - 0.12);
  }

  const effectiveRecoveryScore = clamp(
    Math.max(
      rawRecoveryScore,
      rawHesitationScore > 0 ? 1 - effectiveHesitationScore - 0.12 : rawRecoveryScore,
    ),
  );

  return {
    effectiveHesitationScore,
    effectiveRecoveryScore,
    rawHesitationScore,
    rawRecoveryScore,
  };
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

  return /\b(?:uh|uhh+|um|umm+|er|err+|erm|ah)\b(?:\s+\w+){0,3}\s+\b(?:uh|uhh+|um|umm+|er|err+|erm|ah)\b/i.test(
    normalized,
  );
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

function tokenize(text: string) {
  return normalizeTranscriptText(text).split(' ').filter(Boolean);
}

function tokenizeIdea(text: string) {
  return tokenize(text).filter((word) => word.length > 2 && !IDEA_STOP_WORDS.has(word));
}

function findRepeatedIdeas(texts: string[]) {
  const repeatedIdeas: string[] = [];

  for (let index = 1; index < texts.length; index += 1) {
    const previousWords = tokenizeIdea(texts[index - 1] ?? '');
    const nextWords = tokenizeIdea(texts[index] ?? '');

    if (previousWords.length < 3 || nextWords.length < 3) {
      continue;
    }

    const previousSet = new Set(previousWords);
    const nextSet = new Set(nextWords);
    const intersectionSize = [...nextSet].filter((word) => previousSet.has(word)).length;
    const overlap = intersectionSize / Math.max(previousSet.size, nextSet.size);
    const containsPrevious = previousWords.every((word) => nextSet.has(word));
    const containsNext = nextWords.every((word) => previousSet.has(word));

    if (overlap >= 0.6 || containsPrevious || containsNext) {
      const excerpt = nextWords.slice(0, Math.min(6, nextWords.length)).join(' ');
      if (excerpt && !repeatedIdeas.includes(excerpt)) {
        repeatedIdeas.push(excerpt);
      }
    }
  }

  return repeatedIdeas;
}

function deriveWordsPerMinute({
  transcriptWordCount,
  transcriptEntries,
  speechStreakMs,
  nowMs,
  isSpeaking,
}: {
  transcriptWordCount: number;
  transcriptEntries: TranscriptEntry[];
  speechStreakMs: number;
  nowMs: number;
  isSpeaking: boolean;
}) {
  if (!isSpeaking || transcriptWordCount <= 0) {
    return 0;
  }

  const firstTimestamp = transcriptEntries[0]?.timestamp ?? nowMs;
  const lastTimestamp = transcriptEntries[transcriptEntries.length - 1]?.timestamp ?? nowMs;
  const transcriptSpanMs = Math.max(0, lastTimestamp - firstTimestamp);
  const effectiveWindowMs = Math.max(2_500, transcriptSpanMs + 1_200, speechStreakMs);

  return Math.round((transcriptWordCount / (effectiveWindowMs / 60_000)) * 10) / 10;
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
  const repeatedIdeaPhrases = findRepeatedIdeas(analysisTexts);
  const repeatedIdeaCount = repeatedIdeaPhrases.length;
  const lastLine = interimText || recentTranscript[recentTranscript.length - 1]?.text.trim() || '';
  const unfinishedPhrase = /(?:\.\.\.|-)\s*$/.test(lastLine);
  const wakePhrase = detectWakePhrase(analysisTexts);
  const transcriptWordCount = countTranscriptWords(analysisTexts);
  const fillerDensity = clamp(fillerCount / Math.max(1, transcriptWordCount));
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
  let repeatedIdeaContribution = 0;
  let wakePhraseContribution = 0;
  let pacePressureContribution = 0;
  const wordsPerMinute = deriveWordsPerMinute({
    transcriptWordCount,
    transcriptEntries: recentTranscript,
    speechStreakMs,
    nowMs,
    isSpeaking,
  });

  if (repeatedIdeaCount > 0) {
    repeatedIdeaContribution = Math.min(0.22, repeatedIdeaCount * 0.11);
    hesitationScore += repeatedIdeaContribution;
    hesitationReasons.push(`Repeated idea: "${repeatedIdeaPhrases[0]}".`);
    hesitationContributors.push({
      key: 'repeat-idea',
      label: 'Repeated idea',
      score: repeatedIdeaContribution,
    });
  }

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

  const slowPaceScore =
    isSpeaking && wordsPerMinute > 0 && wordsPerMinute < MIN_SPEAKING_WPM
      ? clamp((MIN_SPEAKING_WPM - wordsPerMinute) / MIN_SPEAKING_WPM)
      : 0;
  const rushedPaceScore =
    isSpeaking && wordsPerMinute > HIGH_PRESSURE_WPM
      ? clamp((wordsPerMinute - HIGH_PRESSURE_WPM) / 120)
      : 0;
  const pacePressureScore = clamp(
    slowPaceScore * 0.68 +
      rushedPaceScore * 0.38 +
      (fillerBurstDetected ? 0.14 : 0) +
      (repeatedIdeaCount > 0 ? 0.08 : 0),
  );

  if (pacePressureScore >= 0.12) {
    pacePressureContribution = Math.min(0.2, pacePressureScore * 0.4);
    hesitationScore += pacePressureContribution;
    hesitationReasons.push(
      slowPaceScore > rushedPaceScore
        ? `Delivery pace dropped to ${Math.round(wordsPerMinute)} WPM while you were still searching for the next beat.`
        : `Delivery pace spiked to ${Math.round(wordsPerMinute)} WPM and sounds rushed.`,
    );
    hesitationContributors.push({
      key: 'pace-pressure',
      label: 'Pace pressure',
      score: pacePressureContribution,
    });
  }

  const transcriptInstabilityPenalty = clamp(
    fillerDensity * 0.45 +
      repeatedOpeningCount * 0.18 +
      repeatedIdeaCount * 0.16 +
      (unfinishedPhrase ? 0.2 : 0) +
      pacePressureScore * 0.18 +
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
    const pacePenalty = clamp(
      pacePressureContribution + repeatedIdeaContribution,
      0,
      0.65,
    );

    confidenceScore = clamp(
      recoveryContribution * 0.6 + audioContribution * 0.28 + (wordsPerMinute >= MIN_SPEAKING_WPM ? 0.12 : 0) - deliveryPenalty - pacePenalty,
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
    if (pacePenalty > 0) {
      confidenceReasons.push('Delivery pace still looks uneven, so AndOne stays close.');
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
    wordsPerMinute,
    pacePressureScore,
    repeatedIdeaCount,
    repeatedIdeaPhrases,
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
