import {
  AssistCard,
  ContextBundle,
  BoothInterpretation,
  BoothFeatureSnapshot,
  createEmptyAssistCard,
  GenerateBoothCueResponse,
  RetrievedFact,
  SourceChip,
  LiveMatchState,
  VisionCue,
  TranscriptEntry,
  SocialPost,
} from '@sports-copilot/shared-types';

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const OPENAI_ASSIST_MODEL_LIGHT = 'gpt-4o-mini';
const OPENAI_ASSIST_MODEL_HEAVY = 'gpt-4o';

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

function buildPrompt(params: {
  features: BoothFeatureSnapshot;
  interpretation?: BoothInterpretation;
  contextSummary?: string;
  preMatchSummary?: string;
  clipName?: string;
  expectedTopics?: string[];
  recentCueTexts?: string[];
  contextBundle?: ContextBundle;
  retrievedFacts: RetrievedFact[];
  recentEvents?: Array<{ matchTime: string; description: string; highSalience: boolean }>;
  liveMatch?: LiveMatchState;
  visionCues?: VisionCue[];
  conversationHistory?: TranscriptEntry[];
  socialPosts?: SocialPost[];
}) {
  const {
    features,
    interpretation,
    contextSummary,
    preMatchSummary,
    clipName,
    expectedTopics = [],
    recentCueTexts = [],
    contextBundle,
    retrievedFacts,
    recentEvents = [],
    liveMatch,
    visionCues = [],
    conversationHistory = [],
    socialPosts = [],
  } = params;

  const liveMatchSummary = liveMatch
    ? {
        score: `${liveMatch.homeTeam.name} ${liveMatch.homeTeam.score} - ${liveMatch.awayTeam.score} ${liveMatch.awayTeam.name}`,
        minute: liveMatch.minute,
        period: liveMatch.period,
        stats: liveMatch.stats.map((s: { label: string; value: string }) => `${s.label}: ${s.value}`),
        cards: liveMatch.cards.map((c: { playerName: string; teamSide: string; cardType: string; matchTime: string }) => `${c.playerName} (${c.teamSide}) ${c.cardType} ${c.matchTime}`),
        substitutions: liveMatch.substitutions.map((s: { teamSide: string; playerOff: string; playerOn: string; matchTime: string }) => `${s.teamSide}: ${s.playerOff} → ${s.playerOn} ${s.matchTime}`),
      }
    : undefined;

  // Build a plain-English hesitation summary so the model doesn't have to interpret raw signal numbers.
  const hesitationSignals: string[] = [];
  if (features.pauseDurationMs >= 1500) {
    hesitationSignals.push(`${(features.pauseDurationMs / 1000).toFixed(1)}s silence`);
  }
  if (features.fillerCount >= 2) {
    hesitationSignals.push(`${features.fillerCount} filler words (${features.fillerWords.slice(0, 3).join(', ')})`);
  }
  if (features.repeatedOpeningCount >= 2) {
    hesitationSignals.push(`repeated opening phrase ${features.repeatedOpeningCount}x`);
  }
  if (features.unfinishedPhrase) {
    hesitationSignals.push('unfinished thought detected');
  }
  if (features.wakePhraseDetected) {
    hesitationSignals.push('wake phrase detected (commentator asked for help)');
  }

  const hesitationState = interpretation?.state ?? (features.hesitationScore > 0.5 ? 'step-in' : 'monitoring');
  const hesitationLevel = interpretation
    ? `${interpretation.state} (score: ${interpretation.hesitationScore.toFixed(2)})`
    : `estimated ${hesitationState} (score: ${features.hesitationScore.toFixed(2)})`;

  const lastWords = conversationHistory.length > 0
    ? conversationHistory.slice(-3).map((t) => t.text).join(' … ')
    : null;

  // Only include non-empty/non-degraded context sections.
  const contextSections: Record<string, unknown> = {};

  if (clipName) contextSections.clip = clipName;

  if (contextSummary && !contextSummary.includes('Waiting for')) {
    contextSections.matchContext = contextSummary;
  }
  if (preMatchSummary && !preMatchSummary.includes('loading')) {
    contextSections.preMatchSummary = preMatchSummary;
  }
  if (expectedTopics.length > 0) contextSections.expectedTopics = expectedTopics;

  if (liveMatchSummary && liveMatchSummary.score && !liveMatchSummary.score.includes('undefined')) {
    contextSections.liveMatch = liveMatchSummary;
  }
  if (visionCues.length > 0) {
    contextSections.onScreen = visionCues.slice(-5).map((v) => v.label);
  }
  if (socialPosts.length > 0) {
    contextSections.fanReaction = socialPosts.slice(-6).map((p) => `${p.handle}: "${p.text}" [${p.sentiment}]`);
  }
  if (recentEvents.length > 0) {
    contextSections.recentEvents = recentEvents.map((e) => `${e.matchTime} — ${e.description}${e.highSalience ? ' ⚡' : ''}`);
  }
  if (retrievedFacts.length > 0) {
    contextSections.facts = retrievedFacts.map((f) => ({ id: f.id, text: f.text, source: f.source }));
  }
  if (contextBundle && Object.keys(contextBundle).length > 0) {
    contextSections.contextBundle = contextBundle;
  }
  if (recentCueTexts.length > 0) {
    contextSections.recentCuesAlreadyShown = recentCueTexts;
  }

  return [
    '## Role',
    'You are And-One, a live sports commentary sidekick. A hesitation engine has flagged that the commentator needs a nudge right now.',
    'Generate one short cue card line — a broadcaster-friendly prompt that gets the commentator moving again without taking over.',
    '',
    '## Commentator State',
    `Hesitation level: ${hesitationLevel}`,
    hesitationSignals.length > 0 ? `Signals: ${hesitationSignals.join(', ')}` : 'Signals: low-level pause',
    lastWords ? `Last words spoken: "${lastWords}"` : 'No transcript yet this session.',
    interpretation?.summary ? `Interpretation: ${interpretation.summary}` : '',
    '',
    '## Available Context',
    JSON.stringify(contextSections, null, 2),
    '',
    '## Output Rules',
    '- Return ONLY valid JSON, no markdown, no explanation.',
    '- Keys: type, text, whyNow, confidence, sourceFactIds, refreshAfterMs',
    '- type: one of hype | context | stat | narrative | transition | co-host-tossup',
    '- text: single broadcaster-friendly line, 8–18 words. Do NOT invent stats or player details.',
    '- whyNow: one sentence explaining why this cue fits this exact moment.',
    '- confidence: 0.0–1.0',
    '- sourceFactIds: array of fact ids from the facts list that you used (empty array if none)',
    '- refreshAfterMs: 1400–3200 (lower = more urgent)',
    '- If facts are thin, use a neutral bridge line grounded in the match situation. Never hallucinate.',
    '- Avoid repeating any cue from recentCuesAlreadyShown.',
    '',
    '## Example output',
    '{"type":"stat","text":"Barcelona have had 68% of the ball so far — they are controlling this.","whyNow":"Commentator paused after describing an attack; a possession stat bridges naturally.","confidence":0.85,"sourceFactIds":["live-stat-possession"],"refreshAfterMs":2000}',
  ].filter(Boolean).join('\n');
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
  retrievalFacts: RetrievedFact[];
  recentEvents?: Array<{ matchTime: string; description: string; highSalience: boolean }>;
  clipName?: string;
  contextSummary?: string;
  preMatchSummary?: string;
  expectedTopics?: string[];
  recentCueTexts?: string[];
  contextBundle?: ContextBundle;
  liveMatch?: LiveMatchState;
  visionCues?: VisionCue[];
  conversationHistory?: TranscriptEntry[];
  socialPosts?: SocialPost[];
}): Promise<GenerateBoothCueResponse> {
  const retrievedFacts = params.retrievalFacts.slice(0, 8);
  const model = selectAssistModel({
    features: params.features,
    interpretation: params.interpretation,
  });

  const prompt = buildPrompt({
    features: params.features,
    interpretation: params.interpretation,
    contextSummary: params.contextSummary,
    preMatchSummary: params.preMatchSummary,
    clipName: params.clipName,
    expectedTopics: params.expectedTopics,
    recentCueTexts: params.recentCueTexts,
    contextBundle: params.contextBundle,
    retrievedFacts,
    recentEvents: params.recentEvents,
    liveMatch: params.liveMatch,
    visionCues: params.visionCues,
    conversationHistory: params.conversationHistory,
    socialPosts: params.socialPosts,
  });

  console.log('[booth-assist] === OPENAI REQUEST ===');
  console.log('[booth-assist] model:', model);
  console.log('[booth-assist] hesitation state:', params.interpretation?.state ?? 'none');
  console.log('[booth-assist] hesitation score:', params.interpretation?.hesitationScore ?? 'n/a');
  console.log('[booth-assist] retrieved facts count:', retrievedFacts.length);
  console.log('[booth-assist] retrieved facts:', JSON.stringify(retrievedFacts.map(f => ({ id: f.id, tier: f.tier, source: f.source, relevance: f.relevance, text: f.text.slice(0, 80) })), null, 2));
  console.log('[booth-assist] vision cues:', JSON.stringify(params.visionCues?.slice(-5).map(v => ({ tag: v.tag, label: v.label })) ?? []));
  console.log('[booth-assist] conversation history:', JSON.stringify(params.conversationHistory?.slice(-10).map(t => ({ speaker: t.speaker, text: t.text })) ?? []));
  console.log('[booth-assist] social posts:', JSON.stringify(params.socialPosts?.slice(-6).map(p => ({ handle: p.handle, sentiment: p.sentiment, text: p.text.slice(0, 60) })) ?? []));
  console.log('[booth-assist] live match:', params.liveMatch ? `${params.liveMatch.homeTeam.name} ${params.liveMatch.homeTeam.score}-${params.liveMatch.awayTeam.score} ${params.liveMatch.awayTeam.name} (${params.liveMatch.minute}')` : 'none');
  console.log('[booth-assist] pre-match summary:', params.preMatchSummary?.slice(0, 120) ?? 'none');
  console.log('[booth-assist] context summary:', params.contextSummary ?? 'none');
  console.log('[booth-assist] full prompt length:', prompt.length, 'chars');

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
      input: prompt,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[booth-assist] OpenAI error:', response.status, errorText.slice(0, 200));
    throw new Error(`OpenAI cue generation failed: ${response.status} ${errorText}`);
  }

  const payload = (await response.json()) as unknown;
  const text = extractResponseText(payload);

  console.log('[booth-assist] === OPENAI RESPONSE ===');
  console.log('[booth-assist] raw response text:', text);

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

    console.log('[booth-assist] === PARSED CUE ===');
    console.log('[booth-assist] type:', parsed.type);
    console.log('[booth-assist] text:', parsed.text);
    console.log('[booth-assist] whyNow:', parsed.whyNow);
    console.log('[booth-assist] confidence:', parsed.confidence);
    console.log('[booth-assist] refreshAfterMs:', parsed.refreshAfterMs);
    console.log('[booth-assist] sourceFactIds:', parsed.sourceFactIds);

    const selectedFacts = retrievedFacts.filter((fact) =>
      parsed.sourceFactIds?.includes(fact.id),
    );

    return {
      assist: {
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
      },
      refreshAfterMs:
        typeof parsed.refreshAfterMs === 'number'
          ? Math.max(1200, Math.min(3600, Math.round(parsed.refreshAfterMs)))
          : params.interpretation?.state === 'step-in'
            ? 1600
            : 2400,
      source: 'openai',
    };
  } catch (_error) {
    throw new Error('OpenAI cue generation returned invalid JSON');
  }
}
