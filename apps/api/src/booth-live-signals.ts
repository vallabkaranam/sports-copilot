import { VisionCue, VisionCueTag } from '@sports-copilot/shared-types';

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const OPENAI_VISION_MODEL = 'gpt-4.1-mini';

type FrameAnalysisResult = {
  visionCue: VisionCue | null;
  source: 'openai' | 'unavailable';
};

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

function normalizeTag(tag: string): VisionCueTag {
  const normalized = tag.trim().toLowerCase();

  switch (normalized) {
    case 'replay':
    case 'crowd-reaction':
    case 'player-close-up':
    case 'coach-reaction':
    case 'celebration':
    case 'set-piece':
    case 'stoppage':
      return normalized;
    default:
      return 'attack';
  }
}

export async function analyzeLiveFrameWithOpenAI(params: {
  screenshotBase64: string;
  mimeType: string;
  clipName?: string;
  clockMs?: number;
}): Promise<FrameAnalysisResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return { visionCue: null, source: 'unavailable' };
  }

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_VISION_MODEL,
      reasoning: { effort: 'low' },
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                'You are labeling a single football broadcast frame for a live commentary sidekick.',
                'Return strict JSON with keys: label, tag, confidence.',
                'Allowed tag values: attack, replay, crowd-reaction, player-close-up, coach-reaction, celebration, set-piece, stoppage.',
                'Describe only what is visibly on screen. Do not invent unseen events.',
                'If the frame is ambiguous, describe the broadcast visual itself such as lineup graphic, replay angle, crowd shot, or player close-up.',
                params.clipName ? `Clip name hint: ${params.clipName}` : null,
                typeof params.clockMs === 'number' ? `Approximate live clock ms: ${params.clockMs}` : null,
              ]
                .filter(Boolean)
                .join('\n'),
            },
            {
              type: 'input_image',
              image_url: `data:${params.mimeType};base64,${params.screenshotBase64}`,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI live frame analysis failed: ${response.status} ${body}`);
  }

  const payload = (await response.json()) as unknown;
  const text = extractResponseText(payload);
  if (!text) {
    return { visionCue: null, source: 'openai' };
  }

  const parsed = JSON.parse(text) as {
    label?: string;
    tag?: string;
    confidence?: number;
  };

  if (!parsed.label?.trim()) {
    return { visionCue: null, source: 'openai' };
  }

  const cue: VisionCue = {
    timestamp: typeof params.clockMs === 'number' ? params.clockMs : Date.now(),
    tag: normalizeTag(parsed.tag ?? ''),
    label: parsed.label.trim(),
  };

  return {
    visionCue: cue,
    source: 'openai',
  };
}
