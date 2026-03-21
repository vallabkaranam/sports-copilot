import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBoothSessionStore } from './booth-session-store';

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
  it('persists session samples and analytics in sqlite', () => {
    const store = createBoothSessionStore(createTempDatabasePath());
    const session = store.createSession('demo-clip.mp4');

    store.appendSample(session.id, {
      timestamp: 1_000,
      hesitationScore: 0.42,
      confidenceScore: 0.58,
      pauseDurationMs: 1_900,
      audioLevel: 0.09,
      isSpeaking: false,
      triggerBadges: ['pause'],
      activeAssistText: 'Reset with a simple scene call and one short takeaway.',
    });
    const updatedSession = store.appendSample(session.id, {
      timestamp: 2_000,
      hesitationScore: 0.91,
      confidenceScore: 0.24,
      pauseDurationMs: 4_300,
      audioLevel: 0.03,
      isSpeaking: false,
      triggerBadges: ['pause', 'repeat-start'],
      activeAssistText: null,
    });
    const finishedSession = store.finishSession(session.id);
    const record = store.getSession(session.id);
    const analytics = store.getAnalytics();

    expect(updatedSession.sampleCount).toBe(2);
    expect(updatedSession.maxHesitationScore).toBe(0.91);
    expect(updatedSession.longestPauseMs).toBe(4_300);
    expect(updatedSession.assistCount).toBe(1);
    expect(finishedSession.status).toBe('completed');
    expect(record?.samples).toHaveLength(2);
    expect(record?.samples[1]?.triggerBadges).toEqual(['pause', 'repeat-start']);
    expect(analytics.totalSessions).toBe(1);
    expect(analytics.completedSessions).toBe(1);
    expect(analytics.totalAssistCount).toBe(1);
  });
});
