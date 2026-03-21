// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import {
  BoothSessionsResponse,
  ReplayControlState,
  WorldState,
  createEmptyAssistCard,
  createEmptyCommentatorState,
  createEmptyNarrativeState,
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

describe('App dashboard', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock = vi.fn();
  let currentWorldState: WorldState;
  let currentControls: ReplayControlState;
  let currentBoothSessions: BoothSessionsResponse;

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
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn() }],
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
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes('/world-state')) {
        return jsonResponse(currentWorldState);
      }

      if (url.includes('/booth-sessions') && (!init?.method || init.method === 'GET')) {
        return jsonResponse(currentBoothSessions);
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

  it('renders the live booth dashboard with replay, booth, timeline, and assist panels', async () => {
    await renderApp();

    expect(container.textContent).toContain('Sports Copilot');
    expect(container.textContent).toContain('Booth Buddy');
    expect(container.textContent).toContain('Load Clip');
    expect(container.textContent).toContain('Sidekick panel');
    expect(container.textContent).toContain('Show Details');
    expect(container.textContent).toContain('Bring in any local replay clip to rehearse live commentary');
  });

  it('keeps the booth in setup mode until a clip is loaded', async () => {
    await renderApp();

    const playButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Start Broadcast'),
    );
    expect(playButton?.textContent).toBe('Start Broadcast');
    expect(playButton?.hasAttribute('disabled')).toBe(true);
    expect(container.textContent).toContain('Waiting for clip upload');
    expect(container.textContent).toContain('Enable Microphone');
  });

  it('arms the mic before letting the booth go live and still posts control updates', async () => {
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
      button.textContent?.includes('Start Broadcast'),
    );

    expect(playButton?.hasAttribute('disabled')).toBe(true);

    const micButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Enable Microphone'),
    );

    await act(async () => {
      micButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(playButton?.hasAttribute('disabled')).toBe(false);

    await act(async () => {
      playButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const resetButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Reset session'),
    );

    await act(async () => {
      resetButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const postBodies = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
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

  it('keeps the landing screen focused on practice mode instead of fixture assists', async () => {
    currentWorldState = createWorldState({
      assist: createEmptyAssistCard(),
      sessionMemory: createEmptySessionMemory(),
    });

    await renderApp();
    expect(container.textContent).not.toContain('Courtois keeps Madrid alive with an enormous reflex stop.');

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
