import { describe, expect, it } from 'vitest';
import { GameEvent, SocialPost, TranscriptEntry, VisionFrame } from '@sports-copilot/shared-types';
import events from '../../../data/demo_match/events.json';
import socialPosts from '../../../data/demo_match/fake_social.json';
import narratives from '../../../data/demo_match/narratives.json';
import roster from '../../../data/demo_match/roster.json';
import transcript from '../../../data/demo_match/transcript_seed.json';
import visionFrames from '../../../data/demo_match/vision_frames.json';
import { buildAssistCard } from './assist';
import { analyzeCommentary } from './commentator';
import { buildNarrativeState } from './narrative';
import { buildRetrievalState } from './retrieval';
import { ingestVisionFrames } from './vision';

const inferredVisionCues = ingestVisionFrames(visionFrames as VisionFrame[]);
const demoEvents = events as GameEvent[];
const demoSocialPosts = socialPosts as SocialPost[];
const demoTranscript = transcript as TranscriptEntry[];

function buildDemoAssist(clockMs: number, preferredStyleMode: 'analyst' | 'hype' = 'analyst') {
  const commentator = analyzeCommentary({ clockMs, events: demoEvents, transcript: demoTranscript });
  const narrative = buildNarrativeState({ clockMs, events: demoEvents, narratives });
  const retrieval = buildRetrievalState({
    clockMs,
    events: demoEvents,
    transcript: demoTranscript,
    roster,
    narratives,
    socialPosts: demoSocialPosts,
    visionCues: inferredVisionCues,
  });
  const assist = buildAssistCard({
    clockMs,
    events: demoEvents,
    commentator,
    narrative,
    retrieval,
    preferredStyleMode,
  });

  return {
    commentator,
    narrative,
    retrieval,
    assist,
  };
}

describe('demo run-through', () => {
  it('stays quiet while the co-host is still actively speaking after the save', () => {
    const { commentator, assist } = buildDemoAssist(77_500, 'analyst');

    expect(commentator.coHostIsSpeaking).toBe(true);
    expect(assist.type).toBe('none');
  });

  it('hands a grounded toss-up to the co-host once the save hesitation window opens', () => {
    const { commentator, assist } = buildDemoAssist(79_000, 'analyst');

    expect(commentator.hesitationScore).toBe(0.8);
    expect(assist.type).toBe('co-host-tossup');
    expect(assist.text).toBe("What did you make of Courtois's save there?");
  });

  it('delivers an analyst context line on the late Madrid counter when analyst mode is selected', () => {
    const { assist, narrative } = buildDemoAssist(92_500, 'analyst');

    expect(narrative.topNarrative).toBe('Real Madrid are flipping the momentum.');
    expect(assist.type).toBe('context');
    expect(assist.text).toBe(
      'Vinícius Júnior is at the heart of it, and the bigger story is Real Madrid are flipping the momentum.',
    );
  });

  it('switches to a hype line for the same counter when hype mode is selected', () => {
    const { assist } = buildDemoAssist(92_500, 'hype');

    expect(assist.type).toBe('hype');
    expect(assist.text).toBe('Vinícius Júnior has Real Madrid flying in transition!');
  });
});
