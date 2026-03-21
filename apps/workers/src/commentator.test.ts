import { describe, expect, it } from 'vitest';
import { analyzeCommentary, detectRepeatedPhrases } from './commentator';
import { GameEvent, TranscriptEntry } from '@sports-copilot/shared-types';

describe('commentary analysis', () => {
  it('raises hesitation after silence following a high-salience moment', () => {
    const events: GameEvent[] = [
      {
        id: 'chance-1',
        timestamp: 5_000,
        matchTime: '00:05',
        type: 'CHANCE',
        description: 'Big chance for Barcelona.',
        highSalience: true,
      },
    ];
    const transcript: TranscriptEntry[] = [
      { timestamp: 4_500, speaker: 'lead', text: 'He is through on goal—' },
    ];

    const state = analyzeCommentary({ clockMs: 8_200, events, transcript });

    expect(state.hesitationScore).toBeGreaterThan(0.5);
    expect(state.hesitationReasons).toContain(
      'Lead commentator paused after a high-salience moment.',
    );
  });

  it('detects filler-heavy commentary and raises hesitation', () => {
    const transcript: TranscriptEntry[] = [
      {
        timestamp: 1_000,
        speaker: 'lead',
        text: 'Um, uh, I mean, Barcelona are still probing.',
      },
    ];

    const state = analyzeCommentary({ clockMs: 4_000, events: [], transcript });

    expect(state.fillerWords).toEqual(['uh', 'um', 'i mean']);
    expect(state.hesitationScore).toBeGreaterThan(0.2);
    expect(state.hesitationReasons).toContain('Lead commentator is leaning on filler phrases.');
  });

  it('suppresses assists while the co-host is actively speaking', () => {
    const transcript: TranscriptEntry[] = [
      {
        timestamp: 10_000,
        speaker: 'cohost',
        text: 'Courtois had to be perfect there.',
      },
    ];

    const state = analyzeCommentary({ clockMs: 11_500, events: [], transcript });

    expect(state.activeSpeaker).toBe('cohost');
    expect(state.coHostIsSpeaking).toBe(true);
    expect(state.shouldSuppressAssist).toBe(true);
    expect(state.coHostTossUp).toBeNull();
  });

  it('clamps hesitation scores to the valid range', () => {
    const events: GameEvent[] = [
      {
        id: 'save-1',
        timestamp: 7_000,
        matchTime: '00:07',
        type: 'SAVE',
        description: 'Outstanding save.',
        highSalience: true,
      },
    ];
    const transcript: TranscriptEntry[] = [
      { timestamp: 6_000, speaker: 'lead', text: 'I mean, I mean, Barcelona pressing.' },
      { timestamp: 6_500, speaker: 'lead', text: 'I mean, Barcelona pressing again—' },
      { timestamp: 6_800, speaker: 'lead', text: 'Barcelona pressing even higher.' },
    ];

    const state = analyzeCommentary({ clockMs: 10_000, events, transcript });

    expect(state.hesitationScore).toBeGreaterThanOrEqual(0);
    expect(state.hesitationScore).toBeLessThanOrEqual(1);
  });

  it('treats an unfinished lead phrase followed by a pause as hesitation', () => {
    const transcript: TranscriptEntry[] = [
      { timestamp: 10_000, speaker: 'lead', text: 'Pedri slips him in behind—' },
    ];

    const state = analyzeCommentary({ clockMs: 13_000, events: [], transcript });

    expect(state.unfinishedPhrase).toBe(true);
    expect(state.hesitationReasons).toContain('Lead commentator left the latest line unfinished.');
    expect(state.hesitationScore).toBeGreaterThan(0);
  });

  it('returns normalized repeated leading phrases', () => {
    const transcript: TranscriptEntry[] = [
      { timestamp: 1_000, speaker: 'lead', text: 'Barcelona pressing the back line.' },
      { timestamp: 3_000, speaker: 'lead', text: 'Barcelona pressing again with intent.' },
      { timestamp: 5_000, speaker: 'cohost', text: 'Real Madrid are feeling it.' },
    ];

    expect(detectRepeatedPhrases(transcript)).toContain('barcelona pressing');
  });

  it('creates a co-host toss-up cue after a high-salience event and lead hesitation', () => {
    const events: GameEvent[] = [
      {
        id: 'save-1',
        timestamp: 75_000,
        matchTime: '01:15',
        type: 'SAVE',
        description: 'Courtois gets across to make the stop.',
        highSalience: true,
        data: { player: 'Courtois' },
      },
    ];
    const transcript: TranscriptEntry[] = [
      { timestamp: 74_000, speaker: 'lead', text: 'He hits it hard—' },
    ];

    const state = analyzeCommentary({ clockMs: 77_500, events, transcript });

    expect(state.coHostTossUp).toEqual({
      question: "What did you make of Courtois's save there?",
      reason: 'Recent high-salience action and lead hesitation make a co-host handoff timely.',
      confidence: 0.85,
      sourceEventId: 'save-1',
      sourceEventType: 'SAVE',
    });
  });
});
