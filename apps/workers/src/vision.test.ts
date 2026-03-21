import { describe, expect, it } from 'vitest';
import { VisionCue } from '@sports-copilot/shared-types';
import { buildVisionMemory, getActiveVisionCues } from './vision';

describe('vision cues', () => {
  const cues: VisionCue[] = [
    { timestamp: 65_000, tag: 'attack', label: 'Barcelona surge through the middle' },
    { timestamp: 76_000, tag: 'replay', label: 'Replay isolates Courtois save' },
  ];

  it('maps recent cues into active vision tags', () => {
    expect(getActiveVisionCues(77_000, cues).map((cue) => cue.tag)).toEqual(['attack', 'replay']);
    expect(getActiveVisionCues(90_000, cues).map((cue) => cue.tag)).toEqual(['replay']);
  });

  it('makes vision cues available as live retrieval facts', () => {
    const memory = buildVisionMemory(77_000, cues);

    expect(memory).toHaveLength(2);
    expect(memory[0].tier).toBe('live');
    expect(memory.some((fact) => fact.source.includes('vision:replay'))).toBe(true);
  });
});
