// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import {
  BoothSessionRecord,
  BoothSessionsResponse,
  ReplayControlState,
  WorldState,
  createEmptyAssistCard,
  createEmptyCommentatorState,
  createEmptyLiveMatchState,
  createEmptyNarrativeState,
  createEmptyPreMatchState,
  createEmptyRetrievalState,
  createEmptySessionMemory,
} from '@sports-copilot/shared-types';
import App from './App.tsx';

function createWorldState(overrides: Partial<WorldState> = {}): WorldState {
  return {
    matchId: 'clasico-demo',
    clock: '01:15',
    score: { home: 0, away: 0 },
    possession: 'BAR',
    gameStateSummary: 'Courtois stands tall to deny Barcelona.',
    highSalienceMoments: [
      {
        id: 'e4',
        timestamp: 75_000,
        matchTime: '01:15',
        type: 'SAVE',
        description: 'Courtois stands tall to deny Barcelona.',
        highSalience: true,
        data: { team: 'RMA', player: 'Courtois' },
      },
    ],
    recentEvents: [
      {
        id: 'e3',
        timestamp: 65_000,
        matchTime: '01:05',
        type: 'CHANCE',
        description: 'Pedri threads a needle and Lewandowski is in.',
        highSalience: true,
        data: { team: 'BAR', player: 'Lewandowski' },
      },
      {
        id: 'e4',
        timestamp: 75_000,
        matchTime: '01:15',
        type: 'SAVE',
        description: 'Courtois stands tall to deny Barcelona.',
        highSalience: true,
        data: { team: 'RMA', player: 'Courtois' },
      },
    ],
    sessionMemory: {
      ...createEmptySessionMemory(),
      surfacedAssists: [
        {
          ...createEmptyAssistCard(),
          type: 'context',
          text: 'Courtois is keeping Madrid alive.',
          confidence: 0.74,
          whyNow: 'The booth paused after the save.',
        },
      ],
    },
    commentator: {
      ...createEmptyCommentatorState(),
      activeSpeaker: 'none',
      hesitationScore: 0.68,
      hesitationReasons: ['Lead commentator paused after a high-salience moment.'],
      pauseDurationMs: 3_100,
      recentTranscript: [
        {
          timestamp: 74_000,
          speaker: 'lead',
          text: 'He hits it hard—',
        },
      ],
    },
    narrative: {
      ...createEmptyNarrativeState(),
      topNarrative: "Barcelona's High Press",
      activeNarratives: ["Barcelona's High Press", 'Spotlight on Pedri.'],
      currentSentiment: 'Charged',
      momentum: 'home',
    },
    retrieval: {
      ...createEmptyRetrievalState(),
      query: 'Courtois save',
      supportingFacts: [
        {
          id: 'fact-1',
          tier: 'live',
          text: '@MadridXtra: THIBAUT COURTOIS IS WORLD CLASS.',
          source: 'social:@MadridXtra',
          timestamp: 78_000,
          relevance: 0.96,
          sourceChip: {
            id: 'fact-1',
            label: 'THIBAUT COURTOIS IS WORLD CLASS.',
            source: 'live:social:@MadridXtra',
            relevance: 0.96,
          },
        },
      ],
    },
    assist: {
      type: 'context',
      text: 'Courtois is keeping Madrid alive in this pressure wave.',
      styleMode: 'analyst',
      urgency: 'high',
      confidence: 0.82,
      whyNow: 'The moment is hot and the booth left dead air.',
      sourceChips: [
        {
          id: 'fact-1',
          label: 'THIBAUT COURTOIS IS WORLD CLASS.',
          source: 'live:social:@MadridXtra',
          relevance: 0.96,
        },
      ],
    },
    preMatch: {
      ...createEmptyPreMatchState(),
      loadStatus: 'ready',
      generatedAt: 1000,
      homeRecentForm: {
        teamSide: 'home',
        teamName: 'Barcelona',
        record: { wins: 3, draws: 1, losses: 1 },
        lastFive: [
          {
            fixtureId: 'r1',
            kickoffAt: '2026-03-01 18:00:00',
            opponent: 'Valencia',
            venue: 'home',
            scoreFor: 2,
            scoreAgainst: 1,
            result: 'win',
          },
        ],
      },
      awayRecentForm: {
        teamSide: 'away',
        teamName: 'Real Madrid',
        record: { wins: 4, draws: 0, losses: 1 },
        lastFive: [
          {
            fixtureId: 'r2',
            kickoffAt: '2026-03-01 18:00:00',
            opponent: 'Sevilla',
            venue: 'away',
            scoreFor: 1,
            scoreAgainst: 0,
            result: 'win',
          },
        ],
      },
      headToHead: {
        meetings: [],
        homeWins: 2,
        awayWins: 2,
        draws: 1,
        summary: 'Barcelona and Real Madrid have split the last five meetings.',
      },
      venue: {
        name: 'Estadi Olimpic',
        city: 'Barcelona',
        country: 'Spain',
        capacity: 55000,
        surface: 'grass',
      },
      weather: {
        summary: 'Clear skies',
        temperatureC: 18,
        windKph: 11,
        precipitationMm: 0,
        source: 'open-meteo',
        isFallback: true,
      },
      deterministicOpener:
        'Barcelona arrive 3-1-1, Madrid 4-0-1, with clear skies over Estadi Olimpic.',
      aiOpener: 'Barcelona arrive with strong recent form and a level rivalry backdrop tonight.',
      sourceMetadata: {
        provider: 'sportmonks',
        fetchedAt: 1000,
        sourceNotes: [],
        usedWeatherFallback: true,
      },
    },
    liveMatch: {
      ...createEmptyLiveMatchState(),
      fixtureId: '19427573',
      status: 'live',
      period: 'Second Half',
      minute: 75,
      homeTeam: {
        id: '14',
        name: 'Barcelona',
        shortCode: 'BAR',
        logoUrl: null,
      },
      awayTeam: {
        id: '15',
        name: 'Real Madrid',
        shortCode: 'RMA',
        logoUrl: null,
      },
      cards: [
        { teamSide: 'home', yellow: 2, red: 0 },
        { teamSide: 'away', yellow: 1, red: 0 },
      ],
      substitutions: [
        {
          id: 'sub-1',
          timestamp: 70_000,
          matchTime: '01:10',
          teamSide: 'away',
          playerOff: 'Rodrygo',
          playerOn: 'Joselu',
        },
      ],
      lineups: [
        {
          teamSide: 'home',
          teamId: '14',
          teamName: 'Barcelona',
          formation: '4-3-3',
          startingXI: Array.from({ length: 11 }, (_, index) => ({
            id: `bar-${index}`,
            name: `Bar Starter ${index + 1}`,
            number: index + 1,
            position: 'MF',
            formationPosition: `${index + 1}`,
            starter: true,
          })),
          bench: [],
        },
      ],
      stats: [
        { teamSide: 'home', label: 'Possession', value: '58%' },
        { teamSide: 'away', label: 'Shots On Target', value: '4' },
      ],
    },
    liveSignals: {
      social: [
        {
          timestamp: 78_000,
          handle: '@MadridXtra',
          text: 'THIBAUT COURTOIS IS WORLD CLASS.',
          sentiment: 'positive',
        },
      ],
      vision: [
        {
          timestamp: 76_000,
          tag: 'replay',
          label: 'Replay isolates Courtois stretching to save',
        },
      ],
    },
    ...overrides,
  };
}

function createControls(overrides: Partial<ReplayControlState> = {}): ReplayControlState {
  return {
    playbackStatus: 'paused',
    preferredStyleMode: 'analyst',
    forceHesitation: false,
    restartToken: 0,
    ...overrides,
  };
}

function jsonResponse<T>(data: T) {
  return Promise.resolve({
    ok: true,
    json: async () => data,
  } as Response);
}

function createBoothSessionsResponse(): BoothSessionsResponse {
  return {
    analytics: {
      totalSessions: 0,
      completedSessions: 0,
      averageMaxHesitationScore: 0,
      averageLongestPauseMs: 0,
      totalAssistCount: 0,
    },
    sessions: [],
  };
}

function createBoothSessionRecord(overrides: Partial<BoothSessionRecord> = {}): BoothSessionRecord {
  return {
    id: 'session-1',
    clipName: 'test.mp4',
    startedAt: '2026-03-20T00:00:00.000Z',
    endedAt: '2026-03-20T00:01:00.000Z',
    status: 'completed',
    sampleCount: 3,
    maxHesitationScore: 0.82,
    maxConfidenceScore: 0.71,
    longestPauseMs: 4_200,
    assistCount: 2,
    lastTriggerBadges: ['pause', 'filler'],
    samples: [
      {
        timestamp: 1_000,
        hesitationScore: 0.22,
        confidenceScore: 0.34,
        pauseDurationMs: 800,
        audioLevel: 0.08,
        isSpeaking: true,
        triggerBadges: [],
        activeAssistText: null,
        featureSnapshot: {
          timestamp: 1_000,
          hesitationScore: 0.22,
          confidenceScore: 0.34,
          pauseDurationMs: 800,
          speechStreakMs: 1_100,
          silenceStreakMs: 0,
          audioLevel: 0.08,
          isSpeaking: true,
          hasVoiceActivity: true,
          fillerCount: 0,
          fillerDensity: 0,
          fillerWords: [],
          repeatedOpeningCount: 0,
          repeatedPhrases: [],
          unfinishedPhrase: false,
          transcriptWordCount: 8,
          transcriptStabilityScore: 0.92,
          hesitationReasons: [],
          transcriptWindow: [],
          interimTranscript: '',
        },
      },
      {
        timestamp: 2_000,
        hesitationScore: 0.82,
        confidenceScore: 0.1,
        pauseDurationMs: 4_200,
        audioLevel: 0.01,
        isSpeaking: false,
        triggerBadges: ['pause', 'filler'],
        activeAssistText: 'Courtois is keeping Madrid alive.',
        featureSnapshot: {
          timestamp: 2_000,
          hesitationScore: 0.82,
          confidenceScore: 0.1,
          pauseDurationMs: 4_200,
          speechStreakMs: 0,
          silenceStreakMs: 4_200,
          audioLevel: 0.01,
          isSpeaking: false,
          hasVoiceActivity: false,
          fillerCount: 2,
          fillerDensity: 0.18,
          fillerWords: ['um', 'uh'],
          repeatedOpeningCount: 1,
          repeatedPhrases: ['vinicius is'],
          unfinishedPhrase: true,
          transcriptWordCount: 11,
          transcriptStabilityScore: 0.54,
          hesitationReasons: ['You paused for 4.2s after the last thought.'],
          transcriptWindow: [],
          interimTranscript: 'uh vinicius is...',
        },
      },
      {
        timestamp: 3_000,
        hesitationScore: 0.14,
        confidenceScore: 0.71,
        pauseDurationMs: 0,
        audioLevel: 0.12,
        isSpeaking: true,
        triggerBadges: [],
        activeAssistText: null,
        featureSnapshot: {
          timestamp: 3_000,
          hesitationScore: 0.14,
          confidenceScore: 0.71,
          pauseDurationMs: 0,
          speechStreakMs: 2_400,
          silenceStreakMs: 0,
          audioLevel: 0.12,
          isSpeaking: true,
          hasVoiceActivity: true,
          fillerCount: 0,
          fillerDensity: 0,
          fillerWords: [],
          repeatedOpeningCount: 0,
          repeatedPhrases: [],
          unfinishedPhrase: false,
          transcriptWordCount: 10,
          transcriptStabilityScore: 0.95,
          hesitationReasons: [],
          transcriptWindow: [],
          interimTranscript: '',
        },
      },
    ],
    ...overrides,
  };
}

describe('App dashboard', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock = vi.fn();
  let currentWorldState: WorldState;
  let currentControls: ReplayControlState;
  let currentBoothSessions: BoothSessionsResponse;
  let currentBoothSessionRecord: BoothSessionRecord;

  beforeEach(() => {
    vi.useFakeTimers();
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    currentWorldState = createWorldState();
    currentControls = createControls();
    currentBoothSessions = createBoothSessionsResponse();
    currentBoothSessionRecord = createBoothSessionRecord();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn() }],
      getAudioTracks: () => [{ kind: 'audio', stop: vi.fn() }],
    } as unknown as MediaStream;
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(fakeStream),
      },
    });
    vi.stubGlobal(
      'AudioContext',
      class FakeAudioContext {
        createMediaStreamSource() {
          return {
            connect: vi.fn(),
          };
        }

        createAnalyser() {
          return {
            fftSize: 1024,
            smoothingTimeConstant: 0.78,
            getByteTimeDomainData(samples: Uint8Array) {
              samples.fill(128);
            },
          };
        }

        close() {
          return Promise.resolve();
        }
      } as unknown as typeof AudioContext,
    );
    vi.stubGlobal(
      'MediaRecorder',
      class FakeMediaRecorder {
        static isTypeSupported() {
          return true;
        }

        mimeType: string;
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onerror: (() => void) | null = null;
        onstop: (() => void) | null = null;

        constructor(_stream: MediaStream, options?: { mimeType?: string }) {
          this.mimeType = options?.mimeType ?? 'audio/webm';
        }

        start() {}

        stop() {
          this.onstop?.();
        }
      } as unknown as typeof MediaRecorder,
    );
    vi.stubGlobal(
      'RTCPeerConnection',
      class FakeRTCPeerConnection {
        createDataChannel() {
          return {
            addEventListener: vi.fn(),
            close: vi.fn(),
          };
        }

        addTrack() {}

        async createOffer() {
          return { type: 'offer', sdp: 'fake-offer-sdp' };
        }

        async setLocalDescription() {}

        async setRemoteDescription() {}

        close() {}
      } as unknown as typeof RTCPeerConnection,
    );
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes('/world-state')) {
        return jsonResponse(currentWorldState);
      }

      if (url.includes('/booth-sessions') && (!init?.method || init.method === 'GET')) {
        if (url.includes('/booth-sessions/session-1/review')) {
          return jsonResponse({
            review: {
              headline: 'You recovered cleanly after the pressure beat.',
              summary: 'The saved booth trace shows a long pause, a quick assist, and a solid recovery.',
              strengths: ['Recovery showed up clearly once speech resumed.'],
              watchouts: ['Pause-based hesitation remains the dominant trigger.'],
              coachingNotes: ['Re-enter with one short line instead of restarting twice.'],
            },
          });
        }
        if (url.includes('/booth-sessions/session-1')) {
          return jsonResponse({ session: currentBoothSessionRecord });
        }
        return jsonResponse(currentBoothSessions);
      }

      if (url.includes('/booth/interpret') && init?.method === 'POST') {
        return jsonResponse({
          state: 'monitoring',
          hesitationScore: 0.18,
          recoveryScore: 0.34,
          shouldSurfaceAssist: false,
          summary: 'Tracking the booth without stepping in.',
          reasons: ['No strong hesitation cue is active in the current booth window.'],
          signals: [],
          source: 'openai',
        });
      }

      if (url.includes('/booth/realtime-connect') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          text: async () => 'fake-answer-sdp',
        } as Response);
      }

      if (url.includes('/booth/transcribe') && init?.method === 'POST') {
        return jsonResponse({
          transcript: 'um vinicius is driving forward',
          source: 'openai',
        });
      }

      if (url.includes('/controls') && (!init?.method || init.method === 'GET')) {
        return jsonResponse(currentControls);
      }

      if (url.includes('/booth-sessions/start') && init?.method === 'POST') {
        currentBoothSessions = {
          ...currentBoothSessions,
          analytics: {
            ...currentBoothSessions.analytics,
            totalSessions: currentBoothSessions.analytics.totalSessions + 1,
          },
          sessions: [
            {
              id: 'session-1',
              clipName: 'test.mp4',
              startedAt: '2026-03-20T00:00:00.000Z',
              endedAt: null,
              status: 'active',
              sampleCount: 0,
              maxHesitationScore: 0,
              maxConfidenceScore: 0,
              longestPauseMs: 0,
              assistCount: 0,
              lastTriggerBadges: [],
            },
            ...currentBoothSessions.sessions,
          ],
        };

        return jsonResponse({ session: currentBoothSessions.sessions[0] });
      }

      if (url.includes('/booth-sessions/session-1/sample') && init?.method === 'POST') {
        return jsonResponse({ session: currentBoothSessions.sessions[0] });
      }

      if (url.includes('/booth-sessions/session-1/finish') && init?.method === 'POST') {
        currentBoothSessions = {
          ...currentBoothSessions,
          analytics: {
            ...currentBoothSessions.analytics,
            completedSessions: currentBoothSessions.analytics.completedSessions + 1,
          },
          sessions: currentBoothSessions.sessions.map((session) =>
            session.id === 'session-1'
              ? {
                  ...session,
                  status: 'completed',
                  endedAt: '2026-03-20T00:01:00.000Z',
                }
              : session,
          ),
        };
        return jsonResponse({ session: currentBoothSessions.sessions[0] });
      }

      if (url.includes('/controls') && init?.method === 'POST') {
        const patch = JSON.parse(String(init.body ?? '{}')) as Partial<ReplayControlState> & {
          restart?: boolean;
        };

        currentControls = {
          ...currentControls,
          ...(patch.playbackStatus ? { playbackStatus: patch.playbackStatus } : {}),
          ...(patch.preferredStyleMode ? { preferredStyleMode: patch.preferredStyleMode } : {}),
          ...(typeof patch.forceHesitation === 'boolean'
            ? { forceHesitation: patch.forceHesitation }
            : {}),
          restartToken: currentControls.restartToken + (patch.restart ? 1 : 0),
        };

        return jsonResponse(currentControls);
      }

      throw new Error(`Unhandled fetch for ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = false;
  });

  async function renderApp() {
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('renders the live And-One booth surface', async () => {
    await renderApp();

    expect(container.textContent).toContain('Live Commentary Copilot');
    expect(container.textContent).toContain('And-One');
    expect(container.textContent).toContain('Channel 1');
    expect(container.textContent).toContain('Channel 2');
    expect(container.textContent).toContain('Live control');
    expect(container.textContent).toContain('Show Details');
    expect(container.textContent).toContain('Select a program feed');
    expect(container.textContent).not.toContain('Pre-match brief');
  });

  it('keeps the booth in setup mode until a clip is loaded', async () => {
    await renderApp();

    const playButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Go live'),
    );
    expect(playButton?.textContent).toBe('Go live');
    expect(playButton?.hasAttribute('disabled')).toBe(true);
    expect(container.textContent).toContain('Bring in a replay clip first.');
    expect(container.textContent).toContain('And-One will request access when you go live.');
  });

  it('requests mic access when going live and still posts control updates', async () => {
    await renderApp();

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();

    const file = new File(['video'], 'test.mp4', { type: 'video/mp4' });
    const createObjectUrl = vi.fn(() => 'blob:test');
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: createObjectUrl,
      revokeObjectURL: vi.fn(),
    });

    await act(async () => {
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: [file],
      });
      fileInput?.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    const playButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Go live'),
    );

    expect(playButton?.hasAttribute('disabled')).toBe(false);

    await act(async () => {
      playButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const resetButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Reset live session'),
    );

    await act(async () => {
      resetButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const postBodies = fetchMock.mock.calls
      .filter(
        ([, init]) =>
          init?.method === 'POST' &&
          String(
            ((init?.headers as Record<string, string> | undefined)?.['Content-Type']) ?? '',
          ).includes('application/json'),
      )
      .map(([, init]) => JSON.parse(String(init?.body ?? '{}')));

    expect(postBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clipName: 'test.mp4' }),
        expect.objectContaining({ playbackStatus: 'playing' }),
        expect.objectContaining({ restart: true }),
      ]),
    );
    expect(createObjectUrl).toHaveBeenCalled();
  });

  it('clears the live booth state and shows a saved session review after ending the session', async () => {
    await renderApp();

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    const file = new File(['video'], 'test.mp4', { type: 'video/mp4' });
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:test'),
      revokeObjectURL: vi.fn(),
    });

    await act(async () => {
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: [file],
      });
      fileInput?.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    const startButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Go live'),
    );

    await act(async () => {
      startButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const endButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('End live session'),
    );

    await act(async () => {
      endButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('You recovered cleanly after the pressure beat.');
    expect(container.textContent).toContain('Post-session analytics');
    expect(container.textContent).toContain('Stored in DB');
    expect(container.textContent).toContain('Peak hesitation');
    expect(container.textContent).toContain('The saved booth trace shows a long pause, a quick assist, and a solid recovery.');
    expect(container.textContent).not.toContain('Assist live on this beat.');
  });

  it('keeps worker context off the live overlay until booth interpretation asks for help', async () => {
    currentWorldState = createWorldState({
      assist: {
        type: 'hype',
        text: 'Courtois keeps Madrid alive with an enormous reflex stop.',
        styleMode: 'hype',
        urgency: 'high',
        confidence: 0.88,
        whyNow: 'The replay is hot and the silence window is open.',
        sourceChips: [
          {
            id: 'fact-1',
            label: 'THIBAUT COURTOIS IS WORLD CLASS.',
            source: 'live:social:@MadridXtra',
            relevance: 0.96,
          },
        ],
      },
      sessionMemory: createEmptySessionMemory(),
    });

    await renderApp();
    expect(container.textContent).not.toContain('Courtois keeps Madrid alive with an enormous reflex stop.');

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();

    const file = new File(['video'], 'test.mp4', { type: 'video/mp4' });
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:test'),
      revokeObjectURL: vi.fn(),
    });

    await act(async () => {
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: [file],
      });
      fileInput?.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    const playButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Go live'),
    );

    await act(async () => {
      playButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('Courtois keeps Madrid alive with an enormous reflex stop.');
    expect(container.textContent).toContain('Show Details');
  });
});
