import { RetrievedFact, VisionCue, VisionFrame } from '@sports-copilot/shared-types';

const ACTIVE_VISION_WINDOW_MS = 18_000;

const TAG_RULES: Array<{
  tag: VisionCue['tag'];
  pattern: RegExp;
}> = [
  { tag: 'coach-reaction', pattern: /\bcoach\b|\bmanager\b|\bsideline\b/i },
  { tag: 'celebration', pattern: /\bcelebrat/i },
  { tag: 'replay', pattern: /\breplay\b|\bslow[\s-]?motion\b/i },
  { tag: 'player-close-up', pattern: /\bclose-?up\b|\btight angle\b|\bplayer shot\b/i },
  { tag: 'crowd-reaction', pattern: /\bcrowd\b|\bsupporters\b|\bstands\b|\bstadium\b/i },
  { tag: 'set-piece', pattern: /\bset piece\b|\bcorner\b|\bfree kick\b/i },
  { tag: 'stoppage', pattern: /\bstoppage\b|\bpause\b|\breferee\b/i },
];

function normalizeTag(tag: VisionCue['tag']) {
  return tag.replace(/-/g, ' ');
}

export function inferVisionCueTag(description: string): VisionCue['tag'] {
  for (const rule of TAG_RULES) {
    if (rule.pattern.test(description)) {
      return rule.tag;
    }
  }

  return 'attack';
}

export function ingestVisionFrames(frames: VisionFrame[]): VisionCue[] {
  return frames.map((frame) => ({
    timestamp: frame.timestamp,
    tag: inferVisionCueTag(frame.description),
    label: frame.description.trim(),
  }));
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
