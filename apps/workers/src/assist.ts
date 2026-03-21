import {
  AssistCard,
  AssistUrgency,
  CommentatorState,
  GameEvent,
  NarrativeState,
  RetrievalState,
  RetrievedFact,
  StyleMode,
  createEmptyAssistCard,
} from '@sports-copilot/shared-types';

const MAX_ASSIST_CHARS = 120;
const HIGH_SALIENCE_LOOKBACK_MS = 12_000;
const SUPPORTING_CHIP_LIMIT = 2;

interface AssistDraft {
  type: AssistCard['type'];
  text: string;
  styleMode: StyleMode;
  urgency: AssistUrgency;
  confidence: number;
  whyNow: string;
  supportingFacts: RetrievedFact[];
}

export interface AssistPipelineInput {
  clockMs: number;
  events: GameEvent[];
  commentator: CommentatorState;
  narrative: NarrativeState;
  retrieval: RetrievalState;
  preferredStyleMode?: StyleMode;
  forceIntervention?: boolean;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function roundToHundredths(value: number) {
  return Number(value.toFixed(2));
}

function truncateText(text: string, maxChars: number) {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function sanitizeSentence(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function getLatestEvent(clockMs: number, events: GameEvent[]) {
  return [...events]
    .filter((event) => event.timestamp <= clockMs)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
}

function getLatestHighSalienceEvent(clockMs: number, events: GameEvent[]) {
  return [...events]
    .filter(
      (event) =>
        event.highSalience &&
        event.timestamp <= clockMs &&
        clockMs - event.timestamp <= HIGH_SALIENCE_LOOKBACK_MS,
    )
    .sort((a, b) => b.timestamp - a.timestamp)[0];
}

function getEventPlayer(event?: GameEvent) {
  return typeof event?.data?.player === 'string' ? event.data.player : null;
}

function getEventTeamName(team?: string) {
  if (team === 'BAR') {
    return 'Barcelona';
  }

  if (team === 'RMA') {
    return 'Real Madrid';
  }

  return 'the attack';
}

function getEventFact(retrieval: RetrievalState, event?: GameEvent) {
  if (!event) {
    return null;
  }

  return (
    retrieval.supportingFacts.find((fact) => fact.id === `session-event-${event.id}`) ??
    retrieval.supportingFacts.find((fact) => fact.source.includes(`event-feed:${event.type.toLowerCase()}`)) ??
    null
  );
}

function getNarrativeFact(retrieval: RetrievalState, topNarrative: string | null) {
  if (!topNarrative) {
    return null;
  }

  return (
    retrieval.supportingFacts.find(
      (fact) => fact.tier === 'static' && fact.text.toLowerCase().includes(topNarrative.toLowerCase()),
    ) ?? null
  );
}

function getStatFact(retrieval: RetrievalState) {
  return (
    retrieval.supportingFacts.find(
      (fact) => fact.tier !== 'session' && /\d/.test(fact.text),
    ) ?? null
  );
}

function dedupeFacts(facts: Array<RetrievedFact | null | undefined>) {
  const seen = new Set<string>();
  const result: RetrievedFact[] = [];

  for (const fact of facts) {
    if (!fact || seen.has(fact.id)) {
      continue;
    }

    seen.add(fact.id);
    result.push(fact);
  }

  return result;
}

export function chooseAssistUrgency(params: {
  clockMs: number;
  commentator: CommentatorState;
  events: GameEvent[];
}): AssistUrgency {
  const { clockMs, commentator, events } = params;
  const latestHighSalienceEvent = getLatestHighSalienceEvent(clockMs, events);

  if (commentator.coHostTossUp || (latestHighSalienceEvent && commentator.hesitationScore >= 0.45)) {
    return 'high';
  }

  if (
    commentator.hesitationScore >= 0.25 ||
    commentator.unfinishedPhrase ||
    commentator.pauseDurationMs >= 2_000
  ) {
    return 'medium';
  }

  return 'low';
}

export function chooseStyleMode(params: {
  clockMs: number;
  commentator: CommentatorState;
  events: GameEvent[];
  urgency: AssistUrgency;
}): StyleMode {
  const { clockMs, commentator, events, urgency } = params;
  const latestHighSalienceEvent = getLatestHighSalienceEvent(clockMs, events);

  if (
    urgency === 'high' &&
    latestHighSalienceEvent &&
    commentator.hesitationScore >= 0.45 &&
    ['CHANCE', 'SAVE', 'GOAL', 'COUNTER_ATTACK'].includes(latestHighSalienceEvent.type)
  ) {
    return 'hype';
  }

  return 'analyst';
}

export function shouldIntervene(params: {
  commentator: CommentatorState;
  events: GameEvent[];
  clockMs: number;
}): boolean {
  const { commentator, events, clockMs } = params;
  const latestHighSalienceEvent = getLatestHighSalienceEvent(clockMs, events);

  if (commentator.shouldSuppressAssist || commentator.coHostIsSpeaking) {
    return false;
  }

  if (commentator.coHostTossUp) {
    return true;
  }

  if (latestHighSalienceEvent && commentator.hesitationScore >= 0.3) {
    return true;
  }

  return commentator.hesitationScore >= 0.4;
}

function buildHypeLine(event: GameEvent) {
  const player = getEventPlayer(event);

  switch (event.type) {
    case 'SAVE':
      return sanitizeSentence(
        `${player ?? 'The keeper'} keeps ${getEventTeamName(event.data?.team)} alive with a huge save!`,
      );
    case 'CHANCE':
      return sanitizeSentence(
        `${player ?? 'The forward'} nearly lights up El Clasico with a massive opening!`,
      );
    case 'COUNTER_ATTACK':
      return sanitizeSentence(
        `${player ?? 'The runner'} has ${getEventTeamName(event.data?.team)} flying in transition!`,
      );
    case 'GOAL':
      return sanitizeSentence(`${player ?? 'The scorer'} has delivered a huge Clasico strike!`);
    default:
      return sanitizeSentence(event.description);
  }
}

function buildContextLine(event: GameEvent, topNarrative: string | null) {
  const player = getEventPlayer(event);
  const focus = player ?? getEventTeamName(event.data?.team);
  const narrativeText = topNarrative ? `${topNarrative} is still the thread here` : 'the tension is rising';

  return sanitizeSentence(`${focus} is at the heart of it, and ${narrativeText}.`);
}

function buildStatLine(statFact: RetrievedFact) {
  const text = statFact.text
    .replace(/^@[^:]+:\s*/i, '')
    .replace(/^[^:]+:\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return sanitizeSentence(`Stat to flag: ${text}`);
}

function buildTransitionLine(event: GameEvent) {
  return sanitizeSentence(`${getEventTeamName(event.data?.team)} are still asking fresh questions here.`);
}

function toAssistCard(draft: AssistDraft): AssistCard {
  return {
    type: draft.type,
    text: truncateText(draft.text, MAX_ASSIST_CHARS),
    styleMode: draft.styleMode,
    urgency: draft.urgency,
    confidence: roundToHundredths(clamp(draft.confidence, 0, 1)),
    whyNow: draft.whyNow,
    sourceChips: draft.supportingFacts.slice(0, SUPPORTING_CHIP_LIMIT).map((fact) => fact.sourceChip),
  };
}

function groundCandidate(draft: AssistDraft) {
  if (draft.supportingFacts.length === 0) {
    return null;
  }

  if (draft.type === 'stat' && !draft.supportingFacts.some((fact) => /\d/.test(fact.text))) {
    return null;
  }

  if (draft.type === 'co-host-tossup' && !draft.text.endsWith('?')) {
    return null;
  }

  if (!draft.text.trim()) {
    return null;
  }

  return toAssistCard(draft);
}

export function generateAssistCandidates(input: AssistPipelineInput) {
  const { clockMs, commentator, events, narrative, retrieval, preferredStyleMode } = input;
  const latestEvent = getLatestEvent(clockMs, events);
  const latestHighSalienceEvent = getLatestHighSalienceEvent(clockMs, events);
  const urgency = chooseAssistUrgency({ clockMs, commentator, events });
  const rankedStyleMode =
    preferredStyleMode ?? chooseStyleMode({ clockMs, commentator, events, urgency });

  if (!latestEvent) {
    return [];
  }

  const eventFact = getEventFact(retrieval, latestHighSalienceEvent ?? latestEvent);
  const narrativeFact = getNarrativeFact(retrieval, narrative.topNarrative);
  const statFact = getStatFact(retrieval);

  const drafts: AssistDraft[] = [];

  if (commentator.coHostTossUp) {
    drafts.push({
      type: 'co-host-tossup',
      text: commentator.coHostTossUp.question,
      styleMode: 'analyst',
      urgency,
      confidence: commentator.coHostTossUp.confidence,
      whyNow: commentator.coHostTossUp.reason,
      supportingFacts: dedupeFacts([eventFact, statFact]),
    });
  }

  if (latestHighSalienceEvent && eventFact) {
    drafts.push({
      type: 'hype',
      text: buildHypeLine(latestHighSalienceEvent),
      styleMode: 'hype',
      urgency,
      confidence: 0.76 + commentator.hesitationScore * 0.12,
      whyNow: 'The moment is hot and the commentator hesitation window is open.',
      supportingFacts: dedupeFacts([eventFact, statFact]),
    });

    drafts.push({
      type: 'context',
      text: buildContextLine(latestHighSalienceEvent, narrative.topNarrative),
      styleMode: 'analyst',
      urgency,
      confidence: 0.66 + commentator.hesitationScore * 0.1,
      whyNow: 'A grounded scene-setter can keep the call moving.',
      supportingFacts: dedupeFacts([eventFact, narrativeFact]),
    });
  }

  if (statFact) {
    drafts.push({
      type: 'stat',
      text: buildStatLine(statFact),
      styleMode: 'analyst',
      urgency: urgency === 'high' ? 'medium' : urgency,
      confidence: 0.62,
      whyNow: 'A crisp fact can rescue dead air without overtalking the moment.',
      supportingFacts: dedupeFacts([statFact]),
    });
  }

  if (eventFact) {
    drafts.push({
      type: 'transition',
      text: buildTransitionLine(latestEvent),
      styleMode: rankedStyleMode,
      urgency: urgency === 'high' ? 'medium' : urgency,
      confidence: 0.58,
      whyNow: 'A short bridge line keeps the commentary lane active.',
      supportingFacts: dedupeFacts([eventFact, narrativeFact]),
    });
  }

  return drafts
    .map((draft) => groundCandidate(draft))
    .filter((candidate): candidate is AssistCard => Boolean(candidate));
}

function rankAssist(candidate: AssistCard, preferredStyleMode: StyleMode) {
  let score = candidate.confidence;

  if (candidate.type === 'co-host-tossup') {
    score += 0.18;
  }
  if (candidate.type === 'hype' && candidate.urgency === 'high') {
    score += 0.12;
  }
  if (candidate.styleMode === preferredStyleMode) {
    score += 0.08;
  }
  if (candidate.sourceChips.length > 1) {
    score += 0.04;
  }

  return score;
}

export function rankAssistCandidates(candidates: AssistCard[], preferredStyleMode: StyleMode) {
  return [...candidates].sort(
    (left, right) => rankAssist(right, preferredStyleMode) - rankAssist(left, preferredStyleMode),
  );
}

export function buildAssistCard(input: AssistPipelineInput): AssistCard {
  if (input.commentator.shouldSuppressAssist || input.commentator.coHostIsSpeaking) {
    return createEmptyAssistCard();
  }

  if (!shouldIntervene(input) && !input.forceIntervention) {
    return createEmptyAssistCard();
  }

  const urgency = chooseAssistUrgency(input);
  const preferredStyleMode =
    input.preferredStyleMode ?? chooseStyleMode({ ...input, urgency });
  const candidates = generateAssistCandidates(input);

  if (candidates.length === 0) {
    return createEmptyAssistCard();
  }

  return rankAssistCandidates(candidates, preferredStyleMode)[0] ?? createEmptyAssistCard();
}

export { MAX_ASSIST_CHARS };
