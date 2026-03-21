// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import {
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

describe('App dashboard', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock = vi.fn();
  let currentWorldState: WorldState;
  let currentControls: ReplayControlState;

  beforeEach(() => {
    vi.useFakeTimers();
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    currentWorldState = createWorldState();
    currentControls = createControls();
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes('/world-state')) {
        return jsonResponse(currentWorldState);
      }

      if (url.includes('/controls') && (!init?.method || init.method === 'GET')) {
        return jsonResponse(currentControls);
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

  it('renders the broadcast dashboard with replay, timeline, narrative, and assist panels', async () => {
    await renderApp();

    expect(container.textContent).toContain('Sports Copilot');
    expect(container.textContent).toContain('Barcelona');
    expect(container.textContent).toContain('Real Madrid');
    expect(container.textContent).toContain('Broadcast view');
    expect(container.textContent).toContain('Event Timeline');
    expect(container.textContent).toContain('Narrative Stack');
    expect(container.textContent).toContain('Hesitation Meter');
    expect(container.textContent).toContain('Courtois is keeping Madrid alive in this pressure wave.');
  });

  it('posts replay and backup control updates back to the API', async () => {
    await renderApp();

    const playButton = container.querySelector('button');
    expect(playButton?.textContent).toBe('Play');

    await act(async () => {
      playButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const hypeButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Hype',
    );

    await act(async () => {
      hypeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const forceButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Force Hesitation'),
    );

    await act(async () => {
      forceButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const postBodies = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body ?? '{}')));

    expect(postBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playbackStatus: 'playing' }),
        expect.objectContaining({ preferredStyleMode: 'hype' }),
        expect.objectContaining({ forceHesitation: true }),
      ]),
    );
  });

  it('surfaces a fresh assist card when the polled world state changes', async () => {
    currentWorldState = createWorldState({
      assist: createEmptyAssistCard(),
      sessionMemory: createEmptySessionMemory(),
    });

    await renderApp();
    expect(container.textContent).toContain('System holding its fire until the booth needs help.');

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

    expect(container.textContent).toContain('Courtois keeps Madrid alive with an enormous reflex stop.');
    expect(container.textContent).toContain('THIBAUT COURTOIS IS WORLD CLASS.');
  });
});
