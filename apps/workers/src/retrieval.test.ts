import { describe, expect, it } from 'vitest';
import {
  GameEvent,
  SocialPost,
  TranscriptEntry,
  VisionCue,
  createEmptyPreMatchState,
} from '@sports-copilot/shared-types';
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

  const visionCues: VisionCue[] = [
    {
      timestamp: 76_000,
      tag: 'replay',
      label: 'Replay isolates Courtois stretching full length',
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

  it('makes active vision cues available in retrieval output', () => {
    const state = buildRetrievalState({
      clockMs: 78_000,
      events,
      transcript,
      roster,
      narratives,
      socialPosts,
      visionCues,
    });

    expect(state.supportingFacts.some((fact) => fact.source.includes('vision:replay'))).toBe(true);
  });

  it('makes pre-match facts available for downstream assists', () => {
    const state = buildRetrievalState({
      clockMs: 5_000,
      events: [],
      transcript: [],
      roster,
      narratives: [],
      socialPosts: [],
      preMatch: {
        ...createEmptyPreMatchState(),
        loadStatus: 'ready',
        generatedAt: 1_000,
        homeRecentForm: {
          teamSide: 'home',
          teamName: 'FC Barcelona',
          record: { wins: 3, draws: 1, losses: 1 },
          lastFive: [],
        },
        awayRecentForm: {
          teamSide: 'away',
          teamName: 'Real Madrid',
          record: { wins: 4, draws: 0, losses: 1 },
          lastFive: [],
        },
        headToHead: {
          meetings: [],
          homeWins: 2,
          awayWins: 2,
          draws: 1,
          summary: 'Barcelona and Madrid have split the last five meetings.',
        },
        venue: {
          name: 'Estadi Olimpic',
          city: 'Barcelona',
          country: 'Spain',
          capacity: null,
          surface: null,
        },
        weather: {
          summary: 'Clear skies',
          temperatureC: 18,
          windKph: 9,
          precipitationMm: 0,
          source: 'open-meteo',
          isFallback: true,
        },
        deterministicOpener: 'Deterministic opener.',
        aiOpener: null,
        sourceMetadata: {
          provider: 'sportmonks',
          fetchedAt: 1_000,
          sourceNotes: [],
          usedWeatherFallback: true,
        },
      },
    });

    expect(state.supportingFacts.some((fact) => fact.tier === 'pre_match')).toBe(true);
    expect(
      state.supportingFacts.some(
        (fact) => fact.metadata?.chunkCategory === 'recent-form' || fact.metadata?.chunkCategory === 'venue',
      ),
    ).toBe(true);
  });

  it('lets pre-match chunks outrank static memory before kickoff', () => {
    const state = buildRetrievalState({
      clockMs: 0,
      events: [],
      transcript: [],
      roster,
      narratives,
      socialPosts: [],
      liveMatch: {
        provider: 'sportmonks',
        fixtureId: 'fixture-1',
        status: 'not_started',
        period: 'Pre-match',
        minute: 0,
        stoppageMinute: null,
        lastUpdatedAt: 0,
        isDegraded: false,
        degradedReason: null,
        homeTeam: { id: '1', name: 'FC Barcelona', shortCode: 'BAR', logoUrl: null },
        awayTeam: { id: '2', name: 'Real Madrid', shortCode: 'RMA', logoUrl: null },
        lineups: [],
        cards: [],
        substitutions: [],
        stats: [],
      },
      preMatch: {
        ...createEmptyPreMatchState(),
        loadStatus: 'ready',
        generatedAt: 1_000,
        homeRecentForm: {
          teamSide: 'home',
          teamName: 'FC Barcelona',
          record: { wins: 3, draws: 1, losses: 1 },
          lastFive: [],
        },
        awayRecentForm: {
          teamSide: 'away',
          teamName: 'Real Madrid',
          record: { wins: 4, draws: 0, losses: 1 },
          lastFive: [],
        },
        headToHead: {
          meetings: [],
          homeWins: 2,
          awayWins: 2,
          draws: 1,
          summary: 'Barcelona and Madrid have split the last five meetings.',
        },
        venue: {
          name: 'Estadi Olimpic',
          city: 'Barcelona',
          country: 'Spain',
          capacity: null,
          surface: null,
        },
        weather: null,
        deterministicOpener: 'Barcelona arrive with recent form on their side.',
        aiOpener: null,
        sourceMetadata: {
          provider: 'sportmonks',
          fetchedAt: 1_000,
          sourceNotes: [],
          usedWeatherFallback: false,
        },
      },
    });

    expect(state.supportingFacts[0]?.tier).toBe('pre_match');
  });
});
