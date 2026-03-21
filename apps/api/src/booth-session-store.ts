import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import {
  BoothSessionAnalytics,
  BoothSessionRecord,
  BoothSessionSample,
  BoothSessionSummary,
} from '@sports-copilot/shared-types';

type SessionRow = {
  id: string;
  clip_name: string;
  started_at: string;
  ended_at: string | null;
  status: 'active' | 'completed';
  sample_count: number;
  max_hesitation_score: number;
  max_confidence_score: number;
  longest_pause_ms: number;
  assist_count: number;
  last_trigger_badges: string;
};

type SampleRow = {
  timestamp: number;
  hesitation_score: number;
  confidence_score: number;
  pause_duration_ms: number;
  audio_level: number;
  is_speaking: number;
  trigger_badges: string;
  active_assist_text: string | null;
};

function createEmptyAnalytics(): BoothSessionAnalytics {
  return {
    totalSessions: 0,
    completedSessions: 0,
    averageMaxHesitationScore: 0,
    averageLongestPauseMs: 0,
    totalAssistCount: 0,
  };
}

function mapSessionRow(row: SessionRow): BoothSessionSummary {
  return {
    id: row.id,
    clipName: row.clip_name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    sampleCount: row.sample_count,
    maxHesitationScore: row.max_hesitation_score,
    maxConfidenceScore: row.max_confidence_score,
    longestPauseMs: row.longest_pause_ms,
    assistCount: row.assist_count,
    lastTriggerBadges: JSON.parse(row.last_trigger_badges) as string[],
  };
}

function mapSampleRow(row: SampleRow): BoothSessionSample {
  return {
    timestamp: row.timestamp,
    hesitationScore: row.hesitation_score,
    confidenceScore: row.confidence_score,
    pauseDurationMs: row.pause_duration_ms,
    audioLevel: row.audio_level,
    isSpeaking: Boolean(row.is_speaking),
    triggerBadges: JSON.parse(row.trigger_badges) as string[],
    activeAssistText: row.active_assist_text,
  };
}

export interface BoothSessionStore {
  createSession: (clipName: string) => BoothSessionSummary;
  appendSample: (sessionId: string, sample: BoothSessionSample) => BoothSessionSummary;
  finishSession: (sessionId: string, endedAt?: string) => BoothSessionSummary;
  listSessions: (limit?: number) => BoothSessionSummary[];
  getSession: (sessionId: string) => BoothSessionRecord | null;
  getAnalytics: () => BoothSessionAnalytics;
}

export function createBoothSessionStore(databaseFile?: string): BoothSessionStore {
  const resolvedFile =
    databaseFile ??
    path.resolve(__dirname, '../../../data/app/sports-copilot.sqlite');
  fs.mkdirSync(path.dirname(resolvedFile), { recursive: true });
  const database = new Database(resolvedFile);

  database.exec(`
    CREATE TABLE IF NOT EXISTS booth_sessions (
      id TEXT PRIMARY KEY,
      clip_name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL CHECK(status IN ('active', 'completed')),
      sample_count INTEGER NOT NULL DEFAULT 0,
      max_hesitation_score REAL NOT NULL DEFAULT 0,
      max_confidence_score REAL NOT NULL DEFAULT 0,
      longest_pause_ms INTEGER NOT NULL DEFAULT 0,
      assist_count INTEGER NOT NULL DEFAULT 0,
      last_trigger_badges TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS booth_session_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      hesitation_score REAL NOT NULL,
      confidence_score REAL NOT NULL,
      pause_duration_ms INTEGER NOT NULL,
      audio_level REAL NOT NULL,
      is_speaking INTEGER NOT NULL,
      trigger_badges TEXT NOT NULL,
      active_assist_text TEXT,
      FOREIGN KEY(session_id) REFERENCES booth_sessions(id) ON DELETE CASCADE
    );
  `);

  const insertSession = database.prepare(`
    INSERT INTO booth_sessions (
      id, clip_name, started_at, ended_at, status,
      sample_count, max_hesitation_score, max_confidence_score,
      longest_pause_ms, assist_count, last_trigger_badges
    ) VALUES (
      @id, @clip_name, @started_at, NULL, 'active',
      0, 0, 0, 0, 0, '[]'
    )
  `);

  const appendSample = database.prepare(`
    INSERT INTO booth_session_samples (
      session_id, timestamp, hesitation_score, confidence_score, pause_duration_ms,
      audio_level, is_speaking, trigger_badges, active_assist_text
    ) VALUES (
      @session_id, @timestamp, @hesitation_score, @confidence_score, @pause_duration_ms,
      @audio_level, @is_speaking, @trigger_badges, @active_assist_text
    )
  `);

  const updateSession = database.prepare(`
    UPDATE booth_sessions
    SET sample_count = sample_count + 1,
        max_hesitation_score = MAX(max_hesitation_score, @hesitation_score),
        max_confidence_score = MAX(max_confidence_score, @confidence_score),
        longest_pause_ms = MAX(longest_pause_ms, @pause_duration_ms),
        assist_count = assist_count + @assist_increment,
        last_trigger_badges = @trigger_badges
    WHERE id = @session_id
  `);

  const finishSession = database.prepare(`
    UPDATE booth_sessions
    SET status = 'completed',
        ended_at = @ended_at
    WHERE id = @id
  `);

  const getSessionById = database.prepare(`
    SELECT *
    FROM booth_sessions
    WHERE id = ?
  `);

  const listSessions = database.prepare(`
    SELECT *
    FROM booth_sessions
    ORDER BY datetime(started_at) DESC
    LIMIT ?
  `);

  const listSamples = database.prepare(`
    SELECT timestamp, hesitation_score, confidence_score, pause_duration_ms, audio_level,
           is_speaking, trigger_badges, active_assist_text
    FROM booth_session_samples
    WHERE session_id = ?
    ORDER BY timestamp ASC
  `);

  const analyticsQuery = database.prepare(`
    SELECT
      COUNT(*) AS total_sessions,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_sessions,
      COALESCE(AVG(max_hesitation_score), 0) AS average_max_hesitation_score,
      COALESCE(AVG(longest_pause_ms), 0) AS average_longest_pause_ms,
      COALESCE(SUM(assist_count), 0) AS total_assist_count
    FROM booth_sessions
  `);

  const createSessionTransaction = database.transaction((clipName: string) => {
    const sessionId = `booth-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    insertSession.run({
      id: sessionId,
      clip_name: clipName,
      started_at: new Date().toISOString(),
    });
    return mapSessionRow(getSessionById.get(sessionId) as SessionRow);
  });

  const appendSampleTransaction = database.transaction(
    (sessionId: string, sample: BoothSessionSample) => {
      appendSample.run({
        session_id: sessionId,
        timestamp: sample.timestamp,
        hesitation_score: sample.hesitationScore,
        confidence_score: sample.confidenceScore,
        pause_duration_ms: sample.pauseDurationMs,
        audio_level: sample.audioLevel,
        is_speaking: sample.isSpeaking ? 1 : 0,
        trigger_badges: JSON.stringify(sample.triggerBadges),
        active_assist_text: sample.activeAssistText,
      });
      updateSession.run({
        session_id: sessionId,
        hesitation_score: sample.hesitationScore,
        confidence_score: sample.confidenceScore,
        pause_duration_ms: sample.pauseDurationMs,
        assist_increment: sample.activeAssistText ? 1 : 0,
        trigger_badges: JSON.stringify(sample.triggerBadges),
      });
      return mapSessionRow(getSessionById.get(sessionId) as SessionRow);
    },
  );

  return {
    createSession(clipName) {
      return createSessionTransaction(clipName);
    },
    appendSample(sessionId, sample) {
      return appendSampleTransaction(sessionId, sample);
    },
    finishSession(sessionId, endedAt) {
      finishSession.run({
        id: sessionId,
        ended_at: endedAt ?? new Date().toISOString(),
      });
      const row = getSessionById.get(sessionId) as SessionRow | undefined;
      if (!row) {
        throw new Error(`Unknown booth session: ${sessionId}`);
      }
      return mapSessionRow(row);
    },
    listSessions(limit = 12) {
      return (listSessions.all(limit) as SessionRow[]).map(mapSessionRow);
    },
    getSession(sessionId) {
      const sessionRow = getSessionById.get(sessionId) as SessionRow | undefined;
      if (!sessionRow) {
        return null;
      }
      return {
        ...mapSessionRow(sessionRow),
        samples: (listSamples.all(sessionId) as SampleRow[]).map(mapSampleRow),
      };
    },
    getAnalytics() {
      const row = analyticsQuery.get() as
        | {
            total_sessions: number;
            completed_sessions: number;
            average_max_hesitation_score: number;
            average_longest_pause_ms: number;
            total_assist_count: number;
          }
        | undefined;
      if (!row) {
        return createEmptyAnalytics();
      }
      return {
        totalSessions: row.total_sessions,
        completedSessions: row.completed_sessions,
        averageMaxHesitationScore: row.average_max_hesitation_score,
        averageLongestPauseMs: Math.round(row.average_longest_pause_ms),
        totalAssistCount: row.total_assist_count,
      };
    },
  };
}
