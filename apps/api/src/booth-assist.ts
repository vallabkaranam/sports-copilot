import {
  AgentExplainability,
  AssistCard,
  ContextBundle,
  BoothInterpretation,
  BoothFeatureSnapshot,
  createEmptyAssistCard,
  GenerateBoothCueResponse,
  LiveMatchState,
  LiveStreamContext,
  GenerationExplainability,
  PreMatchState,
  RetrievedFact,
  SourceChip,
} from '@sports-copilot/shared-types';

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const OPENAI_ASSIST_MODEL_LIGHT = 'gpt-5.4-mini';
const OPENAI_ASSIST_MODEL_HEAVY = 'gpt-5.4';

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function extractResponseText(payload: unknown) {
  const candidate = payload as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  };

  if (typeof candidate.output_text === 'string' && candidate.output_text.trim().length > 0) {
    return candidate.output_text;
  }

  return (
    candidate.output
      ?.flatMap((item) => item.content ?? [])
      .map((item) => item.text ?? '')
      .join('')
      .trim() ?? ''
  );
}

function dedupeSourceChips(facts: RetrievedFact[]) {
  const seen = new Set<string>();
  const chips: SourceChip[] = [];

  for (const fact of facts) {
    if (seen.has(fact.sourceChip.id)) {
      continue;
    }

    seen.add(fact.sourceChip.id);
    chips.push(fact.sourceChip);
  }

  return chips;
}

function summarizeLiveMatchForPrompt(liveMatch?: LiveMatchState) {
  if (!liveMatch) {
    return null;
  }

  return {
    fixtureId: liveMatch.fixtureId,
    status: liveMatch.status,
    minute: liveMatch.minute,
    period: liveMatch.period,
    homeTeam: liveMatch.homeTeam.name,
    awayTeam: liveMatch.awayTeam.name,
    stats: liveMatch.stats.slice(0, 16).map((stat) => ({
      teamSide: stat.teamSide,
      label: stat.label,
      value: stat.value,
    })),
  };
}

function summarizePreMatchForPrompt(preMatch?: PreMatchState) {
  if (!preMatch || preMatch.loadStatus === 'pending') {
    return null;
  }

  return {
    loadStatus: preMatch.loadStatus,
    homeRecentForm: preMatch.homeRecentForm,
    awayRecentForm: preMatch.awayRecentForm,
    headToHead: preMatch.headToHead,
    venue: preMatch.venue,
    weather: preMatch.weather,
    homeScoringTrend: preMatch.homeScoringTrend,
    awayScoringTrend: preMatch.awayScoringTrend,
    homeFirstToScore: preMatch.homeFirstToScore,
    awayFirstToScore: preMatch.awayFirstToScore,
    deterministicOpener: preMatch.deterministicOpener,
    aiOpener: preMatch.aiOpener,
  };
}

function buildCueExplainability(params: {
  selectedFacts: RetrievedFact[];
  model: string;
  assist: AssistCard;
  features: BoothFeatureSnapshot;
  interpretation?: BoothInterpretation;
  contextBundle?: ContextBundle;
  liveStreamContext?: LiveStreamContext;
}): GenerationExplainability {
  const contextAgent: AgentExplainability = {
    agentName: 'context-agent',
    output:
      params.contextBundle?.summary ||
      (params.selectedFacts[0]?.text ?? 'Using the live booth state as the context anchor.'),
    reasoningTrace: [
      `Context bundle items available: ${params.contextBundle?.items.length ?? 0}.`,
      `Retrieved facts considered: ${params.selectedFacts.length}.`,
    ],
    sourcesUsed: params.selectedFacts.slice(0, 4).map((fact) => fact.sourceChip),
    state: params.selectedFacts.length > 0 ? 'ready' : 'waiting',
  };

  const groundingAgent: AgentExplainability = {
    agentName: 'grounding-agent',
    output:
      params.selectedFacts.length > 0
        ? params.selectedFacts
            .slice(0, 2)
            .map((fact) => fact.text)
            .join(' | ')
        : 'Falling back to the live booth state because explicit retrieval facts were thin.',
    reasoningTrace: params.selectedFacts.length
      ? params.selectedFacts.slice(0, 3).map(
          (fact) =>
            `${fact.source} scored ${Math.round(fact.relevance * 100)}%${
              fact.metadata?.userProvided ? ' and comes from uploaded context.' : ''
            }`,
        )
      : ['Grounding fell back to the current booth state because explicit retrieval facts were thin.'],
    sourcesUsed: params.selectedFacts.slice(0, 4).map((fact) => fact.sourceChip),
    state: params.selectedFacts.length > 0 ? 'active' : 'waiting',
  };

  const cueAgent: AgentExplainability = {
    agentName: 'cue-agent',
    output: params.assist.text,
    reasoningTrace: [
      params.assist.whyNow,
      `Cue model: ${params.model}`,
      `Local hesitation ${Math.round(params.features.hesitationScore * 100)}%${
        params.interpretation ? ` · interpreted state ${params.interpretation.state}` : ''
      }`,
    ],
    sourcesUsed: params.assist.sourceChips,
    state: params.assist.type === 'none' ? 'quiet' : 'active',
  };

  return {
    contributingAgents: [contextAgent, groundingAgent, cueAgent],
    reasoningTrace: [
      params.assist.whyNow,
      `Model ${params.model} generated the final cue from ${params.selectedFacts.length} selected fact${params.selectedFacts.length === 1 ? '' : 's'}.`,
    ],
    sourcesUsed: params.assist.sourceChips,
  };
}

function buildPrompt(params: {
  features: BoothFeatureSnapshot;
  interpretation?: BoothInterpretation;
  retrievalQuery?: string;
  contextSummary?: string;
  preMatchSummary?: string;
  preMatch?: PreMatchState;
  clipName?: string;
  expectedTopics?: string[];
  recentCueTexts?: string[];
  excludedCueTexts?: string[];
  contextBundle?: ContextBundle;
  liveStreamContext?: LiveStreamContext;
  liveMatch?: LiveMatchState;
  liveSignals?: {
    social: Array<{ timestamp: number; handle: string; text: string; sentiment: string }>;
    vision: Array<{ timestamp: number; tag: string; label: string }>;
  };
  retrievedFacts: RetrievedFact[];
  recentEvents?: Array<{ matchTime: string; description: string; highSalience: boolean }>;
  agentWeights?: Array<{ agentName: string; weight: number; reasons: string[] }>;
}) {
  const {
    features,
    interpretation,
    retrievalQuery,
    contextSummary,
    preMatchSummary,
    preMatch,
    clipName,
    expectedTopics = [],
    recentCueTexts = [],
    excludedCueTexts = [],
    contextBundle,
    liveStreamContext,
    liveMatch,
    liveSignals,
    retrievedFacts,
    recentEvents = [],
    agentWeights = [],
  } = params;

  return [
    'You are generating a live cue card for And-One, a commentator sidekick.',
    'The hesitation engine has already decided this moment may need help.',
    'Your job is to offer one short, broadcaster-friendly line that gets the speaker moving again without taking over.',
    'Use only the supplied facts and context. Never invent a stat, event, player detail, or narrative.',
    'Treat liveStreamContext as the freshest rolling summary of the last several seconds of play.',
    'Never mention the speaker, transcript, hesitation, filler words, or coaching process inside the cue text.',
    'Do not write meta lines such as "pick up from there", "use this", "go back to", "you said", or "reset with".',
    'If the hesitation came from filler or a broken restart, ignore the filler fragment and anchor the cue to the last substantive live idea or grounded fact.',
    'Use transcript fragments only to infer intent. Use retrieved facts, live events, live stream context, stats, and pre-match context as the truth sources for the cue itself.',
    'If the facts are thin, generate a generic bridge line that stays grounded in the current moment instead of hallucinating.',
    'Prefer the rolling context bundle first when it has relevant items, because it represents the freshest session rack.',
    'When multiple source families are available, blend them naturally: live moment first, then stat/social/setup support when relevant.',
    'Prefer the freshest live event or live stream context over stale transcript paraphrase whenever those sources conflict in tone.',
    'Avoid generic phrasing like "reset with one clean line" or "go back to the moment" unless the supplied facts are truly too thin for anything more specific.',
    'If you can ground the cue in a live event plus one supporting source, do that instead of producing a vague bridge.',
    'Keep the cue to a single line, ideally 8-18 words, and keep whyNow short.',
    'Prefer a fresh angle if recentCueTexts show you already used the same framing.',
    'If excludedCueTexts are present, treat them as already-covered ideas from the recent transcript. Do not repeat, paraphrase, or lightly reword them.',
    'When an idea has already been covered, advance the call with a new grounded angle or a supporting fact from a different source family.',
    'Return strict JSON with keys: type, text, whyNow, confidence, sourceFactIds, refreshAfterMs.',
    'Valid type values: hype, context, stat, narrative, transition, co-host-tossup.',
    'confidence must be 0-1. refreshAfterMs should usually be 1400-3200 depending on urgency.',
    'When the booth is deep in hesitation, make the cue more direct. When the booth is recovering, make it lighter.',
    '',
    JSON.stringify({
      clipName,
      retrievalQuery,
      contextSummary,
      preMatchSummary,
      preMatch: summarizePreMatchForPrompt(preMatch),
      expectedTopics,
      recentCueTexts,
      excludedCueTexts,
      contextBundle,
      liveStreamContext,
      liveMatch: summarizeLiveMatchForPrompt(liveMatch),
      liveSignals,
      agentWeights,
      features,
      interpretation,
      recentEvents,
      retrievedFacts: retrievedFacts.map((fact) => ({
        id: fact.id,
        text: fact.text,
        tier: fact.tier,
        source: fact.source,
        relevance: fact.relevance,
        metadata: fact.metadata,
      })),
    }),
  ].join('\n');
}

function selectAssistModel(params: {
  features: BoothFeatureSnapshot;
  interpretation?: BoothInterpretation;
}) {
  if (
    params.interpretation?.state === 'step-in' ||
    params.features.hesitationScore >= 0.72 ||
    params.features.wakePhraseDetected ||
    (params.features.pacePressureScore ?? 0) >= 0.34
  ) {
    return OPENAI_ASSIST_MODEL_HEAVY;
  }

  return OPENAI_ASSIST_MODEL_LIGHT;
}

export async function generateBoothCueWithOpenAI(params: {
  features: BoothFeatureSnapshot;
  interpretation?: BoothInterpretation;
  retrievalQuery?: string;
  retrievalFacts: RetrievedFact[];
  preMatch?: PreMatchState;
  liveMatch?: LiveMatchState;
  liveStreamContext?: LiveStreamContext;
  recentEvents?: Array<{ matchTime: string; description: string; highSalience: boolean }>;
  clipName?: string;
  contextSummary?: string;
  preMatchSummary?: string;
  expectedTopics?: string[];
  recentCueTexts?: string[];
  excludedCueTexts?: string[];
  contextBundle?: ContextBundle;
  agentWeights?: Array<{ agentName: string; weight: number; reasons: string[] }>;
  liveSignals?: {
    social: Array<{ timestamp: number; handle: string; text: string; sentiment: string }>;
    vision: Array<{ timestamp: number; tag: string; label: string }>;
  };
}): Promise<GenerateBoothCueResponse> {
  const retrievedFacts = params.retrievalFacts.slice(0, 8);
  const model = selectAssistModel({
    features: params.features,
    interpretation: params.interpretation,
  });

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      reasoning: {
        effort: 'low',
      },
      input: buildPrompt({
        features: params.features,
        interpretation: params.interpretation,
        retrievalQuery: params.retrievalQuery,
        contextSummary: params.contextSummary,
        preMatchSummary: params.preMatchSummary,
        preMatch: params.preMatch,
        clipName: params.clipName,
        expectedTopics: params.expectedTopics,
        recentCueTexts: params.recentCueTexts,
        excludedCueTexts: params.excludedCueTexts,
        contextBundle: params.contextBundle,
        liveStreamContext: params.liveStreamContext,
        liveMatch: params.liveMatch,
        liveSignals: params.liveSignals,
        retrievedFacts,
        recentEvents: params.recentEvents,
        agentWeights: params.agentWeights,
      }),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI cue generation failed: ${response.status} ${errorText}`);
  }

  const payload = (await response.json()) as unknown;
  const text = extractResponseText(payload);

  if (!text) {
    throw new Error('OpenAI cue generation returned no text');
  }

  try {
    const parsed = JSON.parse(text) as {
      type?: AssistCard['type'];
      text?: string;
      whyNow?: string;
      confidence?: number;
      sourceFactIds?: string[];
      refreshAfterMs?: number;
    };

    if (!parsed.text || !parsed.whyNow || !parsed.type) {
      throw new Error('OpenAI cue generation returned an invalid JSON shape');
    }

    const selectedFacts = retrievedFacts.filter((fact) =>
      parsed.sourceFactIds?.includes(fact.id),
    );
    const groundedFacts = selectedFacts.length > 0 ? selectedFacts : retrievedFacts.slice(0, 2);
    const assist: AssistCard = {
      ...createEmptyAssistCard(),
      type: parsed.type === 'none' ? 'context' : parsed.type,
      text: parsed.text.trim(),
      styleMode: 'analyst',
      urgency:
        params.interpretation?.state === 'step-in'
          ? 'high'
          : params.interpretation?.state === 'monitoring'
            ? 'medium'
            : 'low',
      confidence: clamp(typeof parsed.confidence === 'number' ? parsed.confidence : 0.64),
      whyNow: parsed.whyNow.trim(),
      sourceChips: dedupeSourceChips(groundedFacts),
    };

    return {
      assist,
      refreshAfterMs:
        typeof parsed.refreshAfterMs === 'number'
          ? Math.max(1200, Math.min(3600, Math.round(parsed.refreshAfterMs)))
          : params.interpretation?.state === 'step-in'
            ? 1600
            : 2400,
      explainability: buildCueExplainability({
        selectedFacts: groundedFacts,
        model,
        assist,
        features: params.features,
        interpretation: params.interpretation,
        contextBundle: params.contextBundle,
        liveStreamContext: params.liveStreamContext,
      }),
      source: 'openai',
    };
  } catch (_error) {
    throw new Error('OpenAI cue generation returned invalid JSON');
  }
}
