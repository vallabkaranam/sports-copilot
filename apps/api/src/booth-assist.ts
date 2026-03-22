import {
  AgentExplainability,
  AssistCard,
  ContextBundle,
  BoothInterpretation,
  BoothFeatureSnapshot,
  createEmptyAssistCard,
  GenerateBoothCueResponse,
  LiveMatchState,
  GenerationExplainability,
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

function buildCueExplainability(params: {
  selectedFacts: RetrievedFact[];
  model: string;
  assist: AssistCard;
  features: BoothFeatureSnapshot;
  interpretation?: BoothInterpretation;
  contextBundle?: ContextBundle;
}): GenerationExplainability {
  const contextAgent: AgentExplainability = {
    agentName: 'context-agent',
    output:
      params.contextBundle?.summary ||
      (params.selectedFacts[0]?.text ?? 'No context bundle items were selected.'),
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
        : 'No supporting facts were selected.',
    reasoningTrace: params.selectedFacts.length
      ? params.selectedFacts.slice(0, 3).map(
          (fact) =>
            `${fact.source} scored ${Math.round(fact.relevance * 100)}%${
              fact.metadata?.userProvided ? ' and comes from uploaded context.' : ''
            }`,
        )
      : ['Grounding fell back to the current booth state because retrieval was thin.'],
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
  clipName?: string;
  expectedTopics?: string[];
  recentCueTexts?: string[];
  excludedCueTexts?: string[];
  contextBundle?: ContextBundle;
  liveMatch?: LiveMatchState;
  liveSignals?: {
    social: Array<{ timestamp: number; handle: string; text: string; sentiment: string }>;
    vision: Array<{ timestamp: number; tag: string; label: string }>;
  };
  retrievedFacts: RetrievedFact[];
  recentEvents?: Array<{ matchTime: string; description: string; highSalience: boolean }>;
}) {
  const {
    features,
    interpretation,
    retrievalQuery,
    contextSummary,
    preMatchSummary,
    clipName,
    expectedTopics = [],
    recentCueTexts = [],
    excludedCueTexts = [],
    contextBundle,
    liveMatch,
    liveSignals,
    retrievedFacts,
    recentEvents = [],
  } = params;

  return [
    'You are generating a live cue card for And-One, a commentator sidekick.',
    'The hesitation engine has already decided this moment may need help.',
    'Your job is to offer one short, broadcaster-friendly line that gets the speaker moving again without taking over.',
    'Use only the supplied facts and context. Never invent a stat, event, player detail, or narrative.',
    'If the facts are thin, generate a generic bridge line that stays grounded in the current moment instead of hallucinating.',
    'Prefer the rolling context bundle first when it has relevant items, because it represents the freshest session rack.',
    'When multiple source families are available, blend them naturally: live moment first, then stat/social/setup support when relevant.',
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
      expectedTopics,
      recentCueTexts,
      excludedCueTexts,
      contextBundle,
      liveMatch: summarizeLiveMatchForPrompt(liveMatch),
      liveSignals,
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
  liveMatch?: LiveMatchState;
  recentEvents?: Array<{ matchTime: string; description: string; highSalience: boolean }>;
  clipName?: string;
  contextSummary?: string;
  preMatchSummary?: string;
  expectedTopics?: string[];
  recentCueTexts?: string[];
  excludedCueTexts?: string[];
  contextBundle?: ContextBundle;
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
        clipName: params.clipName,
        expectedTopics: params.expectedTopics,
        recentCueTexts: params.recentCueTexts,
        excludedCueTexts: params.excludedCueTexts,
        contextBundle: params.contextBundle,
        liveMatch: params.liveMatch,
        liveSignals: params.liveSignals,
        retrievedFacts,
        recentEvents: params.recentEvents,
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
      sourceChips: dedupeSourceChips(selectedFacts),
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
        selectedFacts,
        model,
        assist,
        features: params.features,
        interpretation: params.interpretation,
        contextBundle: params.contextBundle,
      }),
      source: 'openai',
    };
  } catch (_error) {
    throw new Error('OpenAI cue generation returned invalid JSON');
  }
}
