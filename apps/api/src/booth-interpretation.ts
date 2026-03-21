import {
  BoothFeatureSnapshot,
  BoothInterpretation,
  BoothInterpretationSignal,
  BoothSpeakerProfile,
} from '@sports-copilot/shared-types';

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const OPENAI_MODEL = process.env.OPENAI_HESITATION_MODEL ?? 'gpt-5.4';

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function buildSignals(features: BoothFeatureSnapshot): BoothInterpretationSignal[] {
  return [
    {
      key: 'pauseDurationMs',
      label: 'Pause after speech',
      value: features.pauseDurationMs,
      detail: `${(features.pauseDurationMs / 1000).toFixed(1)}s`,
    },
    {
      key: 'speechStreakMs',
      label: 'Current speech streak',
      value: features.speechStreakMs,
      detail: `${(features.speechStreakMs / 1000).toFixed(1)}s`,
    },
    {
      key: 'silenceStreakMs',
      label: 'Current silence streak',
      value: features.silenceStreakMs,
      detail: `${(features.silenceStreakMs / 1000).toFixed(1)}s`,
    },
    {
      key: 'audioLevel',
      label: 'Mic energy',
      value: features.audioLevel,
      detail: `${Math.round(features.audioLevel * 100)}%`,
    },
    {
      key: 'fillerCount',
      label: 'Filler count',
      value: features.fillerCount,
      detail: `${features.fillerCount}`,
    },
    {
      key: 'fillerDensity',
      label: 'Filler density',
      value: features.fillerDensity,
      detail: `${Math.round(features.fillerDensity * 100)}%`,
    },
    {
      key: 'repeatedOpeningCount',
      label: 'Repeated openings',
      value: features.repeatedOpeningCount,
      detail: `${features.repeatedOpeningCount}`,
    },
    {
      key: 'unfinishedPhrase',
      label: 'Unfinished thought',
      value: features.unfinishedPhrase,
      detail: features.unfinishedPhrase ? 'detected' : 'not detected',
    },
    {
      key: 'transcriptStabilityScore',
      label: 'Transcript stability',
      value: features.transcriptStabilityScore,
      detail: `${Math.round(features.transcriptStabilityScore * 100)}%`,
    },
  ];
}

function buildUnavailableBoothInterpretation(
  features: BoothFeatureSnapshot,
  profile?: BoothSpeakerProfile,
): BoothInterpretation {
  return {
    state: features.previousState ?? 'standby',
    hesitationScore: 0,
    recoveryScore: 0,
    shouldSurfaceAssist: false,
    summary: 'Live booth interpretation is unavailable until the model path responds.',
    reasons: [
      'The API transcription or interpretation path is unavailable right now.',
      profile && profile.totalSamples > 0
        ? `Historical profile is loaded from ${profile.totalSamples} samples, but live model inference is not available.`
        : 'No historical booth profile is available yet.',
    ],
    signals: buildSignals(features),
    source: 'unavailable',
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
  profile?: BoothSpeakerProfile,
): Promise<BoothInterpretation> {
  if (!process.env.OPENAI_API_KEY) {
    return buildUnavailableBoothInterpretation(features, profile);
  }

  const prompt = [
    'You are classifying a live sports commentator booth state.',
    'Use only the observed signal data, speaker profile, and supplied live context. Do not invent facts.',
    'Return strict JSON with keys: state, hesitationScore, recoveryScore, shouldSurfaceAssist, summary, reasons, signals.',
    'Valid state values: standby, monitoring, step-in, weaning-off.',
    'Interpret hesitation as loss of delivery momentum. Interpret recovery as regained stable speaking.',
    'Use pause after active speech, filler density, repeated ideas, repeated openings, unfinished thought, wake phrase, and context drift as possible signals.',
    'Compare the current moment against the historical speaker profile when deciding whether this behavior is actually unusual for this commentator.',
    'Be conservative. Only choose step-in when help is clearly needed now. Prefer monitoring or weaning-off when the user is recovering.',
    '',
    JSON.stringify({ features, profile }),
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
    return buildUnavailableBoothInterpretation(features, profile);
  }

  const payload = (await response.json()) as unknown;
  const text = extractResponseText(payload);

  if (!text) {
    return buildUnavailableBoothInterpretation(features, profile);
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
            signals: Array.isArray(parsedJson.signals)
              ? parsedJson.signals.filter(
                  (signal): signal is BoothInterpretationSignal =>
                    Boolean(signal) &&
                    typeof signal === 'object' &&
                    typeof (signal as BoothInterpretationSignal).key === 'string' &&
                    typeof (signal as BoothInterpretationSignal).label === 'string' &&
                    typeof (signal as BoothInterpretationSignal).detail === 'string' &&
                    (typeof (signal as BoothInterpretationSignal).value === 'number' ||
                      typeof (signal as BoothInterpretationSignal).value === 'boolean'),
                )
              : buildSignals(features),
            source: 'openai',
          };
    }
  } catch (_error) {
    // Fall through to unavailable response.
  }

  return buildUnavailableBoothInterpretation(features, profile);
}
