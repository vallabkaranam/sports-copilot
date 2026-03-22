import { expect, test } from '@playwright/test';
import { createDefaultReplayControlState, createEmptyAssistCard, createEmptyContextBundle, createEmptyLiveMatchState, createEmptyNarrativeState, createEmptyPreMatchState, createEmptyRetrievalState, createEmptySessionMemory } from '@sports-copilot/shared-types';

const apiBaseUrl = 'http://127.0.0.1:4010';

const worldState = {
  matchId: 'sportmonks-live',
  clock: '00:00',
  score: { home: 0, away: 0 },
  possession: 'LIVE',
  gameStateSummary: 'Waiting for Sportmonks live data.',
  highSalienceMoments: [],
  recentEvents: [],
  sessionMemory: createEmptySessionMemory(),
  assist: createEmptyAssistCard(),
  commentator: {
    activeSpeaker: 'none',
    hesitationScore: 0,
    confidenceScore: 1,
    lastTranscriptSnippet: '',
    recentFillers: [],
  },
  narrative: createEmptyNarrativeState(),
  retrieval: createEmptyRetrievalState(),
  contextBundle: createEmptyContextBundle(),
  preMatch: createEmptyPreMatchState(),
  liveMatch: createEmptyLiveMatchState(),
  liveSignals: { social: [], vision: [] },
};

const controls = {
  ...createDefaultReplayControlState(),
  activeFixtureId: 'fixture-1',
};

const boothSessions = {
  analytics: {
    totalSessions: 0,
    completedSessions: 0,
    averageMaxHesitationScore: 0,
    averageLongestPauseMs: 0,
    totalAssistCount: 0,
  },
  sessions: [],
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    class FakeAudioContext {
      createMediaStreamSource() {
        return {
          connect() {},
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
    }

    class FakeMediaRecorder {
      static isTypeSupported() {
        return true;
      }

      mimeType: string;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;

      constructor(_stream: MediaStream, options?: { mimeType?: string }) {
        this.mimeType = options?.mimeType ?? 'audio/webm';
      }

      start() {}

      stop() {
        this.onstop?.();
      }
    }

    class FakeRTCPeerConnection {
      createDataChannel() {
        return {
          addEventListener() {},
          close() {},
        };
      }

      addTrack() {}

      async createOffer() {
        return { type: 'offer', sdp: 'fake-offer-sdp' };
      }

      async setLocalDescription() {}

      async setRemoteDescription() {}

      close() {}
    }

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => new MediaStream(),
      },
    });

    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: FakeAudioContext,
    });

    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: FakeMediaRecorder,
    });

    Object.defineProperty(window, 'RTCPeerConnection', {
      configurable: true,
      value: FakeRTCPeerConnection,
    });
  });

  await page.route(`${apiBaseUrl}/world-state`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(worldState),
    });
  });

  await page.route(`${apiBaseUrl}/controls`, async (route, request) => {
    const status = request.method() === 'POST' ? 200 : 200;
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(controls),
    });
  });

  await page.route(`${apiBaseUrl}/booth-sessions`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(boothSessions),
    });
  });

  await page.route(`${apiBaseUrl}/booth-sessions/start`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        session: {
          id: 'session-1',
          clipName: 'Barca preset',
          startedAt: new Date().toISOString(),
          endedAt: null,
          status: 'active',
          sampleCount: 0,
          maxHesitationScore: 0,
          maxConfidenceScore: 0,
          longestPauseMs: 0,
          assistCount: 0,
          lastTriggerBadges: [],
        },
      }),
    });
  });

  await page.route(`${apiBaseUrl}/booth/realtime-connect`, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'text/plain',
      body: '',
    });
  });

  await page.route(`${apiBaseUrl}/booth/interpret`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        state: 'monitoring',
        hesitationScore: 0.12,
        recoveryScore: 0.88,
        shouldSurfaceAssist: false,
        summary: 'Monitoring',
        reasons: [],
        signals: [],
        source: 'openai',
      }),
    });
  });

  await page.route(`${apiBaseUrl}/booth/generate-cue`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        assist: {
          type: 'context',
          text: 'Stay with the setup and bridge into the opening beat.',
          styleMode: 'analyst',
          urgency: 'medium',
          confidence: 0.72,
          whyNow: 'The booth needs a short bridge line.',
          sourceChips: [],
        },
        refreshAfterMs: 1800,
        source: 'openai',
      }),
    });
  });

  await page.route(`${apiBaseUrl}/booth/transcribe`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        transcript: 'um this is a quick booth check',
        source: 'openai',
      }),
    });
  });

  await page.route('**/media/barca-preset.mp4', async (route) => {
    await route.fulfill({
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'content-range': 'bytes 0-0/1',
      },
      body: '0',
    });
  });
});

test('renders the live booth shell and can enter live mode', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('Commentary sidekick', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Monitor' })).toBeVisible();
  await expect(page.getByText('System linked')).toBeVisible();

  await page.getByRole('button', { name: 'Go live' }).click();

  await expect(page.getByRole('button', { name: 'End live session' })).toBeVisible();
  await expect(page.getByText('Listening')).toBeVisible();
});
