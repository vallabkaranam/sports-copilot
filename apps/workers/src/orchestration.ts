import { CommentatorState, LiveMatchState, LiveStreamContext, RetrievalState } from '@sports-copilot/shared-types';

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

export interface AgentWeightSummary {
  agentName: string;
  weight: number;
  reasons: string[];
}

export function buildAgentWeights(params: {
  retrieval: RetrievalState;
  liveStreamContext: LiveStreamContext;
  liveMatch?: LiveMatchState;
  commentator: CommentatorState;
}) {
  const { retrieval, liveStreamContext, liveMatch, commentator } = params;
  const liveContextSignal = clamp(
    Math.max(
      liveStreamContext.recentEvents[0]?.salience ?? 0,
      liveStreamContext.transcriptSnippets.length > 0 ? 0.56 : 0,
      liveMatch?.status === 'live' ? 0.62 : 0.3,
    ),
  );
  const preMatchCoverage = clamp(
    retrieval.supportingFacts.filter((fact) => fact.tier === 'pre_match').length / 3,
  );
  const retrievalQuality = clamp(
    retrieval.supportingFacts.reduce((total, fact) => total + fact.relevance, 0) /
      Math.max(1, retrieval.supportingFacts.length),
  );
  const uncertaintyPenalty = clamp(
    commentator.hesitationScore > 0.45 && liveContextSignal < 0.45 ? 0.18 : 0.05,
  );
  const recovering = commentator.hesitationScore < 0.2 ? 0.1 : 0;

  const liveContextWeight = clamp(liveContextSignal * 0.62 + retrievalQuality * 0.22 - uncertaintyPenalty);
  const preMatchWeight = clamp(
    preMatchCoverage * 0.52 + (liveContextSignal < 0.45 ? 0.18 : 0.04) + recovering,
  );
  const contextWeight = clamp(retrievalQuality * 0.58 + liveContextSignal * 0.22 + preMatchCoverage * 0.12);
  const cueWeight = clamp(retrievalQuality * 0.44 + commentator.hesitationScore * 0.24 + liveContextSignal * 0.16);
  const recoveryWeight = clamp((1 - commentator.hesitationScore) * 0.62 + recovering);
  const signalWeight = clamp(commentator.hesitationScore * 0.66 + (1 - retrievalQuality) * 0.12);

  const weights: AgentWeightSummary[] = [
    {
      agentName: 'signal-agent',
      weight: signalWeight,
      reasons: [
        `Hesitation ${Math.round(commentator.hesitationScore * 100)}% is ${commentator.hesitationScore >= 0.35 ? 'still elevated' : 'under control'}.`,
      ],
    },
    {
      agentName: 'live-context-agent',
      weight: liveContextWeight,
      reasons: [
        `${liveStreamContext.recentEvents.length} live stream signals are inside the active window.`,
        `Retrieval quality is ${Math.round(retrievalQuality * 100)}%.`,
      ],
    },
    {
      agentName: 'pre-match-agent',
      weight: preMatchWeight,
      reasons: [
        `${retrieval.supportingFacts.filter((fact) => fact.tier === 'pre_match').length} pre-match facts are still relevant.`,
      ],
    },
    {
      agentName: 'context-agent',
      weight: contextWeight,
      reasons: [
        'Balances live, pre-match, and uploaded context before generation.',
      ],
    },
    {
      agentName: 'cue-agent',
      weight: cueWeight,
      reasons: [
        'Final cue weight follows retrieval quality, live relevance, and delivery pressure.',
      ],
    },
    {
      agentName: 'recovery-agent',
      weight: recoveryWeight,
      reasons: [
        commentator.hesitationScore < 0.2
          ? 'Recovery is strong enough to keep weaning support down.'
          : 'Recovery remains secondary while hesitation is still elevated.',
      ],
    },
  ];

  return weights.sort((left, right) => right.weight - left.weight);
}
