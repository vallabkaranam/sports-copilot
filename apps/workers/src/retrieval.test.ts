import { describe, expect, it } from 'vitest';
import { GameEvent, SocialPost, TranscriptEntry } from '@sports-copilot/shared-types';
import {
  NarrativeFixture,
  RosterFixture,
  buildRetrievalState,
  ingestLiveSocialPosts,
} from './retrieval';

describe('retrieval pipeline', () => {
  const roster: RosterFixture = {
    home: {
      name: 'FC Barcelona',
      shortName: 'BAR',
      roster: [{ id: 'p1', name: 'Pedri', number: 8, position: 'MF' }],
    },
    away: {
      name: 'Real Madrid',
      shortName: 'RMA',
      roster: [
        {
          id: 'p2',
          name: 'Thibaut Courtois',
          number: 1,
          position: 'GK',
          fact: 'Made 3 clutch saves in the last Clásico meeting.',
        },
      ],
    },
  };

  const narratives: NarrativeFixture[] = [
    {
      id: 'n1',
      type: 'RIVALRY',
      title: 'Clásico tension',
      description: 'Every big save in this fixture swings the mood of the stadium.',
    },
  ];

  const events: GameEvent[] = [
    {
      id: 'save-1',
      timestamp: 75_000,
      matchTime: '01:15',
      type: 'SAVE',
      description: 'Courtois stands tall with a huge save.',
      highSalience: true,
      data: { team: 'RMA', player: 'Thibaut Courtois' },
    },
  ];

  const transcript: TranscriptEntry[] = [
    {
      timestamp: 74_000,
      speaker: 'lead',
      text: 'Courtois again, somehow keeping that out—',
    },
  ];

  const socialPosts: SocialPost[] = [
    {
      timestamp: 76_000,
      handle: '@MadridXtra',
      text: 'THIBAUT COURTOIS IS WORLD CLASS.',
      sentiment: 'positive',
    },
  ];

  it('prefers live memory over session and static when all tiers are relevant', () => {
    const state = buildRetrievalState({
      clockMs: 78_000,
      events,
      transcript,
      roster,
      narratives,
      socialPosts,
    });

    expect(state.supportingFacts[0].tier).toBe('live');
    expect(state.supportingFacts.some((fact) => fact.tier === 'session')).toBe(true);
    expect(state.supportingFacts.some((fact) => fact.tier === 'static')).toBe(true);
  });

  it('attaches source metadata to every retrieved fact', () => {
    const state = buildRetrievalState({
      clockMs: 78_000,
      events,
      transcript,
      roster,
      narratives,
      socialPosts,
    });

    for (const fact of state.supportingFacts) {
      expect(fact.sourceChip.id).toBe(fact.id);
      expect(fact.sourceChip.source.length).toBeGreaterThan(0);
      expect(fact.sourceChip.relevance).toBe(fact.relevance);
      expect(fact.sourceChip.label.length).toBeGreaterThan(0);
    }
  });

  it('only ingests live social posts after their timestamps', () => {
    const posts = [
      {
        timestamp: 12_000,
        handle: '@OptaJose',
        text: 'Lamine Yamal is the youngest starter in a 21st-century Clásico.',
        sentiment: 'positive',
      },
      {
        timestamp: 78_000,
        handle: '@MadridXtra',
        text: 'COURTOIS AGAIN.',
        sentiment: 'positive',
      },
    ] satisfies SocialPost[];

    expect(ingestLiveSocialPosts(20_000, posts)).toHaveLength(1);
    expect(ingestLiveSocialPosts(80_000, posts)).toHaveLength(2);
  });
});
