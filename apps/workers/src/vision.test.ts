import { describe, expect, it } from 'vitest';
import { VisionFrame } from '@sports-copilot/shared-types';
import { buildVisionMemory, getActiveVisionCues, ingestVisionFrames } from './vision';

describe('vision cues', () => {
  const frames: VisionFrame[] = [
    { timestamp: 0, description: 'Crowd shot sets the Camp Nou atmosphere.' },
    { timestamp: 60_000, description: 'Wide attack building through the middle.' },
    { timestamp: 74_000, description: 'Tight close-up on Lewandowski before the shot.' },
    { timestamp: 76_000, description: 'Replay isolates Courtois stretching full length.' },
    { timestamp: 82_000, description: 'Coach reaction on the sideline after the save.' },
    { timestamp: 88_000, description: 'Defenders celebrate surviving the scare.' },
  ];

  it('ingests sampled frames and infers the supported scene tags', () => {
    expect(ingestVisionFrames(frames).map((cue) => cue.tag)).toEqual([
      'crowd-reaction',
      'attack',
      'player-close-up',
      'replay',
      'coach-reaction',
      'celebration',
    ]);
  });

  it('makes inferred cues available as active live retrieval facts', () => {
    const cues = ingestVisionFrames(frames);

    expect(getActiveVisionCues(77_000, cues).map((cue) => cue.tag)).toEqual([
      'attack',
      'player-close-up',
      'replay',
    ]);

    const memory = buildVisionMemory(89_000, cues);

    expect(memory.some((fact) => fact.source.includes('vision:coach-reaction'))).toBe(true);
    expect(memory.some((fact) => fact.source.includes('vision:celebration'))).toBe(true);
  });
});
