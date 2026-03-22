import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BoothFeatureSnapshot,
  createEmptyLiveMatchState,
  createEmptyPreMatchState,
  RetrievedFact,
} from '@sports-copilot/shared-types';
import { generateBoothCueWithOpenAI } from './booth-assist';

function makeFeatures(overrides: Partial<BoothFeatureSnapshot> = {}): BoothFeatureSnapshot {
  return {
    timestamp: 1_000,
    hesitationScore: 0.74,
    confidenceScore: 0.22,
    pauseDurationMs: 2_800,
    speechStreakMs: 0,
    silenceStreakMs: 2_800,
    audioLevel: 0.02,
    isSpeaking: false,
    hasVoiceActivity: false,
    fillerCount: 2,
    fillerDensity: 0.18,
    fillerWords: ['um', 'uh'],
    repeatedOpeningCount: 1,
    repeatedPhrases: ['vinicius is'],
    unfinishedPhrase: true,
    transcriptWordCount: 11,
    transcriptStabilityScore: 0.52,
    hesitationReasons: ['You paused for 2.8s after the last thought.'],
    transcriptWindow: [
      {
        timestamp: 800,
        speaker: 'lead',
        text: 'Vinicius is...',
      },
    ],
    interimTranscript: 'uh vinicius is',
    contextSummary: 'Madrid are countering into space.',
    expectedTopics: ['Vinicius', 'transition'],
    previousState: 'step-in',
    ...overrides,
  };
}

function makeFact(): RetrievedFact {
  return {
    id: 'fact-1',
    tier: 'live',
    text: 'Courtois stands tall to keep Madrid alive during the pressure spell.',
    source: 'event-feed:save',
    timestamp: 75_000,
    relevance: 0.94,
    sourceChip: {
      id: 'fact-1',
      label: 'Courtois save',
      source: 'live:event-feed:save',
      relevance: 0.94,
    },
  };
}

describe('booth cue generation', () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    vi.unstubAllGlobals();
  });

  it('throws when the cue path cannot authenticate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      }),
    );

    await expect(
      generateBoothCueWithOpenAI({
        features: makeFeatures(),
        retrievalFacts: [],
      }),
    ).rejects.toThrow('OpenAI cue generation failed: 401 Unauthorized');
  });

  it('parses a generated cue from the OpenAI response path', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            type: 'context',
            text: 'Reset with the save, then bridge to Madrid in transition.',
            whyNow: 'Pause and restart signals are rising together.',
            confidence: 0.81,
            sourceFactIds: ['fact-1'],
            refreshAfterMs: 1800,
          }),
        }),
      }),
    );

    const result = await generateBoothCueWithOpenAI({
      features: makeFeatures(),
      contextBundle: {
        summary: 'Live moment: Courtois save | Social pulse: fans are calling it world class',
        items: [
          {
            id: 'fact-1',
            lane: 'live-moment',
            headline: 'Live moment',
            detail: 'Courtois stands tall to keep Madrid alive during the pressure spell.',
            expiresAt: 90_000,
            salience: 0.94,
            sourceChip: {
              id: 'fact-1',
              label: 'Courtois save',
              source: 'live:event-feed:save',
              relevance: 0.94,
            },
          },
        ],
      },
      retrievalFacts: [makeFact()],
    });

    expect(result.source).toBe('openai');
    expect(result.assist.type).toBe('context');
    expect(result.assist.text).toContain('save');
    expect(result.refreshAfterMs).toBe(1800);
    expect(result.assist.sourceChips[0]?.id).toBe('fact-1');
    expect(result.explainability.contributingAgents.map((agent) => agent.agentName)).toEqual([
      'context-agent',
      'grounding-agent',
      'cue-agent',
    ]);
    expect(result.explainability.sourcesUsed[0]?.id).toBe('fact-1');
  });

  it('preserves the incoming fact order in the OpenAI prompt payload', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          type: 'context',
          text: 'Use the current top fact.',
          whyNow: 'The ranked fact order should be preserved.',
          confidence: 0.7,
          sourceFactIds: ['fact-b'],
          refreshAfterMs: 1600,
        }),
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const lowRelevanceTopRanked: RetrievedFact = {
      id: 'fact-b',
      tier: 'live',
      text: 'Barcelona possession: 58%.',
      source: 'stats:possession',
      timestamp: 75_000,
      relevance: 0.4,
      sourceChip: {
        id: 'fact-b',
        label: 'Barcelona possession: 58%.',
        source: 'live:stats:possession',
        relevance: 0.4,
      },
    };
    const highRelevanceSecond: RetrievedFact = {
      id: 'fact-a',
      tier: 'live',
      text: '@MadridXtra: Fans are losing it over the save.',
      source: 'social:@MadridXtra',
      timestamp: 76_000,
      relevance: 0.95,
      sourceChip: {
        id: 'fact-a',
        label: 'Fans are losing it over the save.',
        source: 'live:social:@MadridXtra',
        relevance: 0.95,
      },
    };

    await generateBoothCueWithOpenAI({
      features: makeFeatures(),
      retrievalFacts: [lowRelevanceTopRanked, highRelevanceSecond],
    });

    const requestBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? '{}')) as {
      input?: string;
    };
    const promptPayload = JSON.parse(requestBody.input?.split('\n').at(-1) ?? '{}') as {
      retrievedFacts?: Array<{ id: string }>;
    };

    expect(promptPayload.retrievedFacts?.map((fact) => fact.id)).toEqual(['fact-b', 'fact-a']);
  });

  it('includes the retrieval query and live match stats in the OpenAI prompt payload', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          type: 'stat',
          text: 'Rangers had 62 percent of the ball.',
          whyNow: 'The query was clearly asking for stats.',
          confidence: 0.82,
          sourceFactIds: ['fact-1'],
          refreshAfterMs: 1700,
        }),
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    await generateBoothCueWithOpenAI({
      features: makeFeatures(),
      retrievalQuery: 'The numbers tell you Rangers controlled this match because',
      retrievalFacts: [makeFact()],
      liveMatch: {
        ...createEmptyLiveMatchState(),
        fixtureId: '19428224',
        homeTeam: {
          id: '62',
          name: 'Rangers',
          shortCode: 'RAN',
          logoUrl: null,
        },
        awayTeam: {
          id: '273',
          name: 'Aberdeen',
          shortCode: 'ABE',
          logoUrl: null,
        },
        stats: [
          {
            teamSide: 'home',
            label: 'Ball Possession %',
            value: '62',
          },
          {
            teamSide: 'away',
            label: 'Corners',
            value: '4',
          },
        ],
      },
    });

    const requestBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? '{}')) as {
      input?: string;
    };
    const promptPayload = JSON.parse(requestBody.input?.split('\n').at(-1) ?? '{}') as {
      retrievalQuery?: string;
      liveMatch?: {
        fixtureId?: string;
        homeTeam?: string;
        awayTeam?: string;
        stats?: Array<{ label: string; value: string }>;
      };
    };

    expect(promptPayload.retrievalQuery).toContain('Rangers controlled');
    expect(promptPayload.liveMatch?.homeTeam).toBe('Rangers');
    expect(promptPayload.liveMatch?.stats?.[0]).toEqual({
      teamSide: 'home',
      label: 'Ball Possession %',
      value: '62',
    });
  });

  it('includes rich pre-match context in the OpenAI prompt payload', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          type: 'context',
          text: 'Rangers have been scoring first consistently coming in.',
          whyNow: 'The setup prompt is asking for a pre-match frame.',
          confidence: 0.79,
          sourceFactIds: ['fact-1'],
          refreshAfterMs: 2100,
        }),
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    await generateBoothCueWithOpenAI({
      features: makeFeatures(),
      retrievalQuery: 'Set up the match with recent form and scoring trends',
      preMatch: {
        ...createEmptyPreMatchState(),
        loadStatus: 'ready',
        generatedAt: 1_000,
        homeRecentForm: {
          teamSide: 'home',
          teamName: 'Rangers',
          record: { wins: 3, draws: 1, losses: 1 },
          lastFive: [],
        },
        awayRecentForm: {
          teamSide: 'away',
          teamName: 'Aberdeen',
          record: { wins: 1, draws: 2, losses: 2 },
          lastFive: [],
        },
        headToHead: {
          meetings: [],
          homeWins: 3,
          awayWins: 1,
          draws: 1,
          summary: 'Rangers have had the better of the last five meetings.',
        },
        venue: {
          name: 'Ibrox Stadium',
          city: 'Glasgow',
          country: 'Scotland',
          capacity: 50987,
          surface: 'grass',
        },
        weather: {
          summary: 'Light rain',
          temperatureC: 7,
          windKph: 16,
          precipitationMm: 0.4,
          source: 'open-meteo',
          isFallback: true,
        },
        homeScoringTrend: {
          teamSide: 'home',
          teamName: 'Rangers',
          sampleSize: 5,
          matchesScoredIn: 4,
          matchesConcededIn: 2,
          averageGoalsFor: 2.2,
          averageGoalsAgainst: 0.8,
          matchesOverTwoPointFive: 3,
          bothTeamsScoredMatches: 2,
          summary: 'Rangers have scored in 4 of their last 5, averaging 2.2 goals.',
        },
        awayScoringTrend: {
          teamSide: 'away',
          teamName: 'Aberdeen',
          sampleSize: 5,
          matchesScoredIn: 3,
          matchesConcededIn: 4,
          averageGoalsFor: 1,
          averageGoalsAgainst: 1.6,
          matchesOverTwoPointFive: 2,
          bothTeamsScoredMatches: 3,
          summary: 'Aberdeen have conceded in 4 of their last 5.',
        },
        homeFirstToScore: {
          teamSide: 'home',
          teamName: 'Rangers',
          sampleSize: 5,
          scoredFirst: 4,
          concededFirst: 1,
          scorelessMatches: 0,
          unknownMatches: 0,
          summary: 'Rangers have scored first in 4 of their last 5 matches.',
        },
        awayFirstToScore: {
          teamSide: 'away',
          teamName: 'Aberdeen',
          sampleSize: 5,
          scoredFirst: 2,
          concededFirst: 3,
          scorelessMatches: 0,
          unknownMatches: 0,
          summary: 'Aberdeen have conceded first in 3 of their last 5 matches.',
        },
        deterministicOpener: 'Rangers bring stronger form, a scoring edge, and home support at Ibrox.',
        aiOpener: null,
        sourceMetadata: {
          provider: 'sportmonks',
          fetchedAt: 1_000,
          sourceNotes: [],
          usedWeatherFallback: true,
        },
      },
      retrievalFacts: [makeFact()],
    });

    const requestBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? '{}')) as {
      input?: string;
    };
    const promptPayload = JSON.parse(requestBody.input?.split('\n').at(-1) ?? '{}') as {
      preMatch?: {
        venue?: { name?: string };
        homeScoringTrend?: { summary?: string };
        awayFirstToScore?: { summary?: string };
      };
    };

    expect(promptPayload.preMatch?.venue?.name).toBe('Ibrox Stadium');
    expect(promptPayload.preMatch?.homeScoringTrend?.summary).toContain('averaging 2.2 goals');
    expect(promptPayload.preMatch?.awayFirstToScore?.summary).toContain('conceded first');
  });
});
