import { RetrievedFact, VisionCue } from '@sports-copilot/shared-types';

const ACTIVE_VISION_WINDOW_MS = 18_000;

function normalizeTag(tag: VisionCue['tag']) {
  return tag.replace(/-/g, ' ');
}

export function getActiveVisionCues(clockMs: number, cues: VisionCue[]) {
  return cues.filter(
    (cue) => cue.timestamp <= clockMs && clockMs - cue.timestamp <= ACTIVE_VISION_WINDOW_MS,
  );
}

export function buildVisionMemory(clockMs: number, cues: VisionCue[]): RetrievedFact[] {
  return getActiveVisionCues(clockMs, cues).map((cue, index) => {
    const relevance = Number(Math.max(0.55, 0.88 - (clockMs - cue.timestamp) / 60_000).toFixed(2));
    const text = `${cue.label} (${normalizeTag(cue.tag)})`;

    return {
      id: `live-vision-${cue.timestamp}-${index}`,
      tier: 'live',
      text,
      source: `vision:${cue.tag}`,
      timestamp: cue.timestamp,
      relevance,
      sourceChip: {
        id: `live-vision-${cue.timestamp}-${index}`,
        label: text,
        source: `live:vision:${cue.tag}`,
        relevance,
      },
    };
  });
}
