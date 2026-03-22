import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertResolvableDatabaseHost, createBoothSessionStore } from './booth-session-store';

const tempPaths: string[] = [];

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }
});

function createTempDatabasePath() {
  const databasePath = path.join(
    os.tmpdir(),
    `sports-copilot-booth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sqlite`,
  );
  tempPaths.push(databasePath);
  return databasePath;
}

describe('booth session store', () => {
  it('persists session samples and analytics in sqlite', async () => {
    const store = await createBoothSessionStore(createTempDatabasePath());
    const session = await store.createSession('demo-clip.mp4');

    await store.appendSample(session.id, {
      timestamp: 1_000,
      hesitationScore: 0.42,
      confidenceScore: 0.58,
      pauseDurationMs: 1_900,
      audioLevel: 0.09,
      isSpeaking: false,
      triggerBadges: ['pause'],
      activeAssistText: 'Reset with a simple scene call and one short takeaway.',
      featureSnapshot: {
        timestamp: 1_000,
        hesitationScore: 0.42,
        confidenceScore: 0.58,
        pauseDurationMs: 1_900,
        speechStreakMs: 0,
        silenceStreakMs: 1_900,
        audioLevel: 0.09,
        isSpeaking: false,
        hasVoiceActivity: false,
        fillerCount: 1,
        fillerDensity: 0.1,
        fillerWords: ['um'],
        repeatedOpeningCount: 0,
        repeatedPhrases: [],
        unfinishedPhrase: false,
        transcriptWordCount: 10,
        transcriptStabilityScore: 0.9,
        hesitationReasons: ['pause'],
        transcriptWindow: [],
        interimTranscript: '',
      },
      interpretation: {
        state: 'monitoring',
        hesitationScore: 0.42,
        recoveryScore: 0.58,
        shouldSurfaceAssist: false,
        summary: 'Monitoring a short pause.',
        reasons: ['pause'],
        signals: [],
        source: 'openai',
      },
    });
    const updatedSession = await store.appendSample(session.id, {
      timestamp: 2_000,
      hesitationScore: 0.91,
      confidenceScore: 0.24,
      pauseDurationMs: 4_300,
      audioLevel: 0.03,
      isSpeaking: false,
      triggerBadges: ['pause', 'repeat-start'],
      activeAssistText: null,
    });
    const finishedSession = await store.finishSession(session.id);
    const record = await store.getSession(session.id);
    const analytics = await store.getAnalytics();
    const profile = await store.getSpeakerProfile();

    expect(updatedSession.sampleCount).toBe(2);
    expect(updatedSession.maxHesitationScore).toBe(0.91);
    expect(updatedSession.longestPauseMs).toBe(4_300);
    expect(updatedSession.assistCount).toBe(1);
    expect(finishedSession.status).toBe('completed');
    expect(record?.samples).toHaveLength(2);
    expect(record?.samples[1]?.triggerBadges).toEqual(['pause', 'repeat-start']);
    expect(record?.samples[0]?.featureSnapshot).toBeTruthy();
    expect(record?.samples[0]?.interpretation).toBeTruthy();
    expect(analytics.totalSessions).toBe(1);
    expect(analytics.completedSessions).toBe(1);
    expect(analytics.totalAssistCount).toBe(1);
    expect(profile.totalSessions).toBe(1);
    expect(profile.totalSamples).toBe(2);
    expect(profile.averageFillerDensity).toBeGreaterThan(0);
    await store.close?.();
  });

  it('fails fast when the configured postgres host cannot be resolved', async () => {
    await expect(
      assertResolvableDatabaseHost(
        'postgresql://postgres:password@db.example.supabase.co:5432/postgres',
        async () => {
          throw new Error('getaddrinfo ENOTFOUND db.example.supabase.co');
        },
      ),
    ).rejects.toThrow(/could not be resolved/i);
  });
});
