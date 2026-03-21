import {
  CommentatorState,
  CoHostTossUpCue,
  GameEvent,
  TranscriptEntry,
  createEmptyCommentatorState,
} from '@sports-copilot/shared-types';

const RECENT_TRANSCRIPT_WINDOW_MS = 20_000;
const RECENT_LEAD_WINDOW_MS = 15_000;
const ACTIVE_SPEECH_WINDOW_MS = 2_500;
const HIGH_SALIENCE_LOOKBACK_MS = 10_000;
const HIGH_SALIENCE_SILENCE_TRIGGER_MS = 2_000;
const UNFINISHED_PHRASE_TRIGGER_MS = 1_500;
const COHOST_TOSS_UP_LOOKBACK_MS = 12_000;
const COHOST_TOSS_UP_MIN_PAUSE_MS = 1_500;
const COHOST_TOSS_UP_MIN_HESITATION_SCORE = 0.35;

const FILLER_PATTERNS = [
  { label: 'uh', regex: /\buh\b/gi },
  { label: 'um', regex: /\bum\b/gi },
  { label: 'er', regex: /\ber\b/gi },
  { label: 'ah', regex: /\bah\b/gi },
  { label: 'you know', regex: /\byou know\b/gi },
  { label: 'i mean', regex: /\bi mean\b/gi },
] as const;

export interface CommentaryAnalysisInput {
  clockMs: number;
  events: GameEvent[];
  transcript: TranscriptEntry[];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function roundToHundredths(value: number) {
  return Number(value.toFixed(2));
}

function isEntryActive(entry: TranscriptEntry, clockMs: number) {
  return clockMs >= entry.timestamp && clockMs - entry.timestamp <= ACTIVE_SPEECH_WINDOW_MS;
}

function normalizeText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getLeadingFragment(text: string) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('you know')) {
    return 'you know';
  }

  if (normalized.startsWith('i mean')) {
    return 'i mean';
  }

  const words = normalized.split(' ').filter(Boolean);
  if (words.length === 0) {
    return null;
  }

  return words.slice(0, Math.min(2, words.length)).join(' ');
}

function isUnfinishedPhrase(text: string) {
  return /(?:-|—|\.{3}|…)\s*$/.test(text.trim());
}

function getEventPlayer(event: GameEvent) {
  return typeof event.data?.player === 'string' ? event.data.player : null;
}

function buildCoHostQuestion(event: GameEvent) {
  const player = getEventPlayer(event);

  switch (event.type) {
    case 'SAVE':
      return player
        ? `What did you make of ${player}'s save there?`
        : 'What did you make of that save?';
    case 'CHANCE':
      return player
        ? `How did ${player} find that pocket of space?`
        : 'How did that chance open up so quickly?';
    case 'COUNTER_ATTACK':
      return player
        ? `How dangerous does ${player} look on the break right now?`
        : 'How dangerous does that counter look to you?';
    default:
      return 'What stood out to you in that last sequence?';
  }
}

function findLatestEntry(
  transcript: TranscriptEntry[],
  clockMs: number,
  predicate: (entry: TranscriptEntry) => boolean,
) {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (entry.timestamp <= clockMs && predicate(entry)) {
      return entry;
    }
  }

  return null;
}

export function extractFillerWords(text: string) {
  return FILLER_PATTERNS.flatMap(({ label, regex }) => {
    const matches = text.match(regex) ?? [];
    return matches.map(() => label);
  });
}

export function detectRepeatedPhrases(transcript: TranscriptEntry[]) {
  const counts = new Map<string, number>();

  for (const entry of transcript) {
    if (entry.speaker !== 'lead') {
      continue;
    }

    const fragment = getLeadingFragment(entry.text);
    if (!fragment) {
      continue;
    }

    counts.set(fragment, (counts.get(fragment) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([fragment]) => fragment)
    .sort();
}

function buildCoHostTossUp(params: {
  clockMs: number;
  hesitationScore: number;
  pauseDurationMs: number;
  unfinishedPhrase: boolean;
  isSpeaking: boolean;
  coHostIsSpeaking: boolean;
  latestHighSalienceEvent?: GameEvent;
}): CoHostTossUpCue | null {
  const {
    clockMs,
    hesitationScore,
    pauseDurationMs,
    unfinishedPhrase,
    isSpeaking,
    coHostIsSpeaking,
    latestHighSalienceEvent,
  } = params;

  if (!latestHighSalienceEvent || isSpeaking || coHostIsSpeaking) {
    return null;
  }

  if (!['SAVE', 'CHANCE'].includes(latestHighSalienceEvent.type)) {
    return null;
  }

  if (clockMs - latestHighSalienceEvent.timestamp > COHOST_TOSS_UP_LOOKBACK_MS) {
    return null;
  }

  const shouldPrompt =
    hesitationScore >= COHOST_TOSS_UP_MIN_HESITATION_SCORE ||
    unfinishedPhrase ||
    pauseDurationMs >= COHOST_TOSS_UP_MIN_PAUSE_MS;

  if (!shouldPrompt) {
    return null;
  }

  return {
    question: buildCoHostQuestion(latestHighSalienceEvent),
    reason: 'Recent high-salience action and lead hesitation make a co-host handoff timely.',
    confidence: roundToHundredths(clamp(0.45 + hesitationScore * 0.5, 0, 1)),
    sourceEventId: latestHighSalienceEvent.id,
    sourceEventType: latestHighSalienceEvent.type,
  };
}

export function analyzeCommentary({
  clockMs,
  events,
  transcript,
}: CommentaryAnalysisInput): CommentatorState {
  const baseState = createEmptyCommentatorState();
  const recentTranscript = transcript.filter(
    (entry) =>
      entry.timestamp <= clockMs && entry.timestamp >= clockMs - RECENT_TRANSCRIPT_WINDOW_MS,
  );
  const recentLeadTranscript = transcript.filter(
    (entry) =>
      entry.speaker === 'lead' &&
      entry.timestamp <= clockMs &&
      entry.timestamp >= clockMs - RECENT_LEAD_WINDOW_MS,
  );
  const activeEntries = recentTranscript.filter((entry) => isEntryActive(entry, clockMs));
  const latestActiveEntry =
    activeEntries.length > 0 ? [...activeEntries].sort((a, b) => b.timestamp - a.timestamp)[0] : null;
  const lastLeadEntry = findLatestEntry(transcript, clockMs, (entry) => entry.speaker === 'lead');
  const lastLeadSpokeAt = lastLeadEntry?.timestamp ?? -1;
  const lastLeadText = lastLeadEntry?.text ?? '';
  const isSpeaking = activeEntries.some((entry) => entry.speaker === 'lead');
  const coHostIsSpeaking = activeEntries.some((entry) => entry.speaker === 'cohost');
  const pauseDurationMs =
    lastLeadSpokeAt < 0 || isSpeaking ? 0 : Math.max(0, clockMs - lastLeadSpokeAt);
  const fillerWords = recentLeadTranscript.flatMap((entry) => extractFillerWords(entry.text));
  const repeatedPhrases = detectRepeatedPhrases(recentLeadTranscript);
  const unfinishedPhrase =
    lastLeadText.length > 0 &&
    isUnfinishedPhrase(lastLeadText) &&
    pauseDurationMs >= UNFINISHED_PHRASE_TRIGGER_MS;
  const latestHighSalienceEvent = [...events]
    .filter(
      (event) =>
        event.highSalience &&
        event.timestamp <= clockMs &&
        clockMs - event.timestamp <= HIGH_SALIENCE_LOOKBACK_MS,
    )
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  const hesitationReasons: string[] = [];
  let hesitationScore = 0;

  if (
    latestHighSalienceEvent &&
    !isSpeaking &&
    clockMs - latestHighSalienceEvent.timestamp >= HIGH_SALIENCE_SILENCE_TRIGGER_MS &&
    pauseDurationMs >= HIGH_SALIENCE_SILENCE_TRIGGER_MS
  ) {
    hesitationScore += 0.55;
    hesitationReasons.push('Lead commentator paused after a high-salience moment.');
  }

  if (fillerWords.length >= 2) {
    hesitationScore += Math.min(0.35, 0.2 + (fillerWords.length - 2) * 0.05);
    hesitationReasons.push('Lead commentator is leaning on filler phrases.');
  }

  if (unfinishedPhrase) {
    hesitationScore += 0.25;
    hesitationReasons.push('Lead commentator left the latest line unfinished.');
  }

  if (repeatedPhrases.length > 0) {
    hesitationScore += Math.min(0.2, repeatedPhrases.length * 0.1);
    hesitationReasons.push('Lead commentator is repeating the same setup phrase.');
  }

  const clampedHesitationScore = clamp(hesitationScore, 0, 1);
  const coHostTossUp = buildCoHostTossUp({
    clockMs,
    hesitationScore: clampedHesitationScore,
    pauseDurationMs,
    unfinishedPhrase,
    isSpeaking,
    coHostIsSpeaking,
    latestHighSalienceEvent,
  });

  return {
    ...baseState,
    activeSpeaker: latestActiveEntry?.speaker ?? 'none',
    isSpeaking,
    coHostIsSpeaking,
    coHostTossUp,
    pauseDurationMs,
    fillerWords,
    repeatedPhrases,
    unfinishedPhrase,
    hesitationScore: clampedHesitationScore,
    hesitationReasons,
    shouldSuppressAssist: coHostIsSpeaking,
    lastLeadSpokeAt,
    recentTranscript,
  };
}
