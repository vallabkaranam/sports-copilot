import {
  BoothSessionRecord,
  BoothSessionReview,
  BoothSpeakerProfile,
} from '@sports-copilot/shared-types';

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const OPENAI_REVIEW_MODEL = 'gpt-5.4';

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

export async function reviewBoothSessionWithOpenAI(
  session: BoothSessionRecord,
  profile?: BoothSpeakerProfile,
): Promise<BoothSessionReview> {
  const prompt = [
    'You are reviewing a saved live-commentary sidekick session.',
    'Use only the saved booth session record and optional speaker profile. Do not invent facts.',
    'Return strict JSON with keys: headline, summary, strengths, watchouts, coachingNotes.',
    'Focus on hesitation and recovery only. Do not suggest new hint content.',
    'Call out which hesitation signals seemed strongest, whether recovery/weaning happened clearly, and what the speaker should watch next time.',
    'Look for individualized behavior patterns such as filler clusters, repeated ideas, pace pressure, long-pause habits, and the way confidence rebuilds.',
    'If the data supports it, describe what kind of hesitation this speaker tends to show instead of giving generic advice.',
    'Keep each array concise: 1-3 items each.',
    '',
    JSON.stringify({ session, profile }),
  ].join('\n');

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_REVIEW_MODEL,
      input: prompt,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI review failed: ${response.status} ${errorText}`);
  }

  const payload = (await response.json()) as unknown;
  const text = extractResponseText(payload);

  if (!text) {
    throw new Error('OpenAI review returned no text');
  }

  try {
    const parsed = JSON.parse(text) as Partial<BoothSessionReview>;
    if (
      parsed &&
      typeof parsed.headline === 'string' &&
      typeof parsed.summary === 'string' &&
      Array.isArray(parsed.strengths) &&
      Array.isArray(parsed.watchouts) &&
      Array.isArray(parsed.coachingNotes)
    ) {
      return {
        headline: parsed.headline,
        summary: parsed.summary,
        strengths: parsed.strengths.filter((item): item is string => typeof item === 'string'),
        watchouts: parsed.watchouts.filter((item): item is string => typeof item === 'string'),
        coachingNotes: parsed.coachingNotes.filter((item): item is string => typeof item === 'string'),
      };
    }
    throw new Error('OpenAI review returned an invalid JSON shape');
  } catch (_error) {
    throw new Error('OpenAI review returned invalid JSON');
  }
}
