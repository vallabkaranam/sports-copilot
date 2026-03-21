import { BoothFeatureSnapshot, BoothInterpretation } from '@sports-copilot/shared-types';

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const OPENAI_MODEL = process.env.OPENAI_HESITATION_MODEL ?? 'gpt-5.4';

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function buildHeuristicState(features: BoothFeatureSnapshot): BoothInterpretation['state'] {
  if (
    (!features.isSpeaking && features.pauseDurationMs >= 1_200) ||
    features.hesitationScore >= 0.62 ||
    features.fillerDensity >= 0.22 ||
    features.repeatedOpeningCount >= 2 ||
    (features.unfinishedPhrase && features.pauseDurationMs >= 900)
  ) {
    return 'step-in';
  }

  if (
    features.previousState === 'step-in' &&
    features.isSpeaking &&
    features.speechStreakMs >= 1_600 &&
    features.confidenceScore >= 0.52 &&
    features.transcriptStabilityScore >= 0.68
  ) {
    return 'weaning-off';
  }

  if (
    features.previousState === 'weaning-off' &&
    features.isSpeaking &&
    features.speechStreakMs >= 2_400 &&
    features.hesitationScore <= 0.12
  ) {
    return 'monitoring';
  }

  if (features.isSpeaking || features.hasVoiceActivity || features.previousState === 'weaning-off') {
    return 'monitoring';
  }

  return 'standby';
}

export function buildHeuristicBoothInterpretation(
  features: BoothFeatureSnapshot,
): BoothInterpretation {
  const state = buildHeuristicState(features);
  const recoveryScore =
    state === 'weaning-off' ? clamp(features.confidenceScore) : clamp(features.confidenceScore * 0.6);
  const reasons =
    features.hesitationReasons.length > 0
      ? features.hesitationReasons
      : ['No strong hesitation cue is active in the current booth window.'];

  const summaryByState: Record<BoothInterpretation['state'], string> = {
    standby: 'Standing by until the commentator starts the call.',
    monitoring: 'Tracking the live call without stepping in yet.',
    'step-in': 'A real hesitation window is open and the prompt should stay visible.',
    'weaning-off': 'The call has steadied, so the prompt can fade back.',
  };

  return {
    state,
    hesitationScore: clamp(features.hesitationScore),
    recoveryScore,
    shouldSurfaceAssist: state === 'step-in',
    summary: summaryByState[state],
    reasons,
    source: 'heuristic',
  };
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

export async function interpretBoothWithOpenAI(
  features: BoothFeatureSnapshot,
): Promise<BoothInterpretation> {
  if (!process.env.OPENAI_API_KEY) {
    return buildHeuristicBoothInterpretation(features);
  }

  const prompt = [
    'You are classifying a live sports commentator booth state.',
    'Use only the observed signal data. Do not invent facts.',
    'Return strict JSON with keys: state, hesitationScore, recoveryScore, shouldSurfaceAssist, summary, reasons.',
    'Valid state values: standby, monitoring, step-in, weaning-off.',
    'Interpret hesitation as loss of delivery momentum. Interpret recovery as regained stable speaking.',
    'Use pause after active speech as the strongest signal.',
    'Transcript instability signals: fillers, repeated openings, unfinished thought, interim churn.',
    'Be conservative. Only choose step-in when help is clearly needed now.',
    '',
    JSON.stringify(features),
  ].join('\n');

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt,
    }),
  });

  if (!response.ok) {
    return buildHeuristicBoothInterpretation(features);
  }

  const payload = (await response.json()) as unknown;
  const text = extractResponseText(payload);

  if (!text) {
    return buildHeuristicBoothInterpretation(features);
  }

  try {
    const parsedJson = JSON.parse(text) as Partial<BoothInterpretation>;
    if (
      parsedJson &&
      typeof parsedJson.state === 'string' &&
      typeof parsedJson.hesitationScore === 'number' &&
      typeof parsedJson.recoveryScore === 'number' &&
      typeof parsedJson.shouldSurfaceAssist === 'boolean' &&
      typeof parsedJson.summary === 'string' &&
      Array.isArray(parsedJson.reasons)
    ) {
      return {
        state: parsedJson.state as BoothInterpretation['state'],
        hesitationScore: clamp(parsedJson.hesitationScore),
        recoveryScore: clamp(parsedJson.recoveryScore),
        shouldSurfaceAssist: parsedJson.shouldSurfaceAssist,
        summary: parsedJson.summary,
        reasons: parsedJson.reasons.filter((reason): reason is string => typeof reason === 'string'),
        source: 'openai',
      };
    }
  } catch (_error) {
    // Fall through to heuristic fallback.
  }

  return buildHeuristicBoothInterpretation(features);
}
