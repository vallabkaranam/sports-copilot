import Database from 'better-sqlite3';
import { lookup } from 'dns/promises';
import fs from 'fs';
import path from 'path';
import {
  BoothSessionAnalytics,
  BoothSessionRecord,
  BoothSessionSample,
  BoothSpeakerProfile,
  BoothSessionSummary,
} from '@sports-copilot/shared-types';

type SessionRow = {
  id: string;
  clip_name: string;
  started_at: string;
  ended_at: string | null;
  status: 'active' | 'completed';
  sample_count: number | string;
  max_hesitation_score: number | string;
  max_confidence_score: number | string;
  longest_pause_ms: number | string;
  assist_count: number | string;
  last_trigger_badges: unknown;
};

type SampleRow = {
  timestamp: number | string;
  hesitation_score: number | string;
  confidence_score: number | string;
  pause_duration_ms: number | string;
  audio_level: number | string;
  is_speaking: number | string | boolean;
  trigger_badges: unknown;
  active_assist_text: string | null;
  feature_snapshot?: unknown;
  interpretation?: unknown;
};

export interface BoothSessionStore {
  createSession: (clipName: string) => Promise<BoothSessionSummary>;
  appendSample: (sessionId: string, sample: BoothSessionSample) => Promise<BoothSessionSummary>;
  finishSession: (sessionId: string, endedAt?: string) => Promise<BoothSessionSummary>;
  listSessions: (limit?: number) => Promise<BoothSessionSummary[]>;
  getSession: (sessionId: string) => Promise<BoothSessionRecord | null>;
  getAnalytics: () => Promise<BoothSessionAnalytics>;
  getSpeakerProfile: () => Promise<BoothSpeakerProfile>;
  close?: () => Promise<void>;
}

function createEmptyAnalytics(): BoothSessionAnalytics {
  return {
    totalSessions: 0,
    completedSessions: 0,
    averageMaxHesitationScore: 0,
    averageLongestPauseMs: 0,
    totalAssistCount: 0,
  };
}

function createEmptySpeakerProfile(): BoothSpeakerProfile {
  return {
    totalSessions: 0,
    totalSamples: 0,
    averageMaxHesitationScore: 0,
    averageRecoveryScore: 0,
    averagePauseDurationMs: 0,
    averageSpeechStreakMs: 0,
    averageFillerDensity: 0,
    averageRepeatedOpenings: 0,
    averageTranscriptStability: 1,
    wakePhrase: 'line',
  };
}

function createSessionId() {
  return `booth-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toNumber(value: number | string | null | undefined) {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : [];
    } catch (_error) {
      return [];
    }
  }

  return [];
}

function parseJsonValue(value: unknown) {
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      return JSON.parse(value) as unknown;
    } catch (_error) {
      return undefined;
    }
  }

  return value ?? undefined;
}

function mapSessionRow(row: SessionRow): BoothSessionSummary {
  return {
    id: row.id,
    clipName: row.clip_name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    sampleCount: toNumber(row.sample_count),
    maxHesitationScore: toNumber(row.max_hesitation_score),
    maxConfidenceScore: toNumber(row.max_confidence_score),
    longestPauseMs: toNumber(row.longest_pause_ms),
    assistCount: toNumber(row.assist_count),
    lastTriggerBadges: parseStringArray(row.last_trigger_badges),
  };
}

function mapSampleRow(row: SampleRow): BoothSessionSample {
  return {
    timestamp: toNumber(row.timestamp),
    hesitationScore: toNumber(row.hesitation_score),
    confidenceScore: toNumber(row.confidence_score),
    pauseDurationMs: toNumber(row.pause_duration_ms),
    audioLevel: toNumber(row.audio_level),
    isSpeaking:
      typeof row.is_speaking === 'boolean' ? row.is_speaking : Boolean(toNumber(row.is_speaking)),
    triggerBadges: parseStringArray(row.trigger_badges),
    activeAssistText: row.active_assist_text,
    featureSnapshot: parseJsonValue(row.feature_snapshot),
    interpretation: parseJsonValue(row.interpretation),
  };
}

function getDefaultSqlitePath() {
  return path.resolve(__dirname, '../../../data/app/sports-copilot.sqlite');
}

function getPoolConfiguration(connectionString: string) {
  const requiresSsl =
    /supabase\.co|render\.com|neon\.tech|railway\.app/i.test(connectionString) &&
    !/sslmode=disable/i.test(connectionString);

  return {
    connectionString,
    ssl: requiresSsl ? { rejectUnauthorized: false } : undefined,
  };
}

function getConnectionHostname(connectionString: string) {
  try {
    const parsed = new URL(connectionString);
    return parsed.hostname;
  } catch (_error) {
    throw new Error('DATABASE_URL is not a valid Postgres connection string.');
  }
}

export async function assertResolvableDatabaseHost(
  connectionString: string,
  resolveHostname: typeof lookup = lookup,
) {
  const hostname = getConnectionHostname(connectionString);

  try {
    await resolveHostname(hostname);
  } catch (error) {
    const resolutionDetail = error instanceof Error ? error.message : String(error);
    const supabaseHint = /^db\.[a-z0-9-]+\.supabase\.co$/i.test(hostname)
      ? ' The host looks like a stale Supabase direct DB host. Replace DATABASE_URL with the current Postgres connection string from the Supabase dashboard.'
      : '';

    throw new Error(
      `DATABASE_URL host "${hostname}" could not be resolved.${supabaseHint} DNS error: ${resolutionDetail}`,
    );
  }
}

async function createPostgresBoothSessionStore(connectionString: string): Promise<BoothSessionStore> {
  await assertResolvableDatabaseHost(connectionString);
  const { Pool } = await import('pg');
  const pool = new Pool(getPoolConfiguration(connectionString));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS booth_sessions (
      id TEXT PRIMARY KEY,
      clip_name TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ,
      status TEXT NOT NULL CHECK(status IN ('active', 'completed')),
      sample_count INTEGER NOT NULL DEFAULT 0,
      max_hesitation_score DOUBLE PRECISION NOT NULL DEFAULT 0,
      max_confidence_score DOUBLE PRECISION NOT NULL DEFAULT 0,
      longest_pause_ms INTEGER NOT NULL DEFAULT 0,
      assist_count INTEGER NOT NULL DEFAULT 0,
      last_trigger_badges JSONB NOT NULL DEFAULT '[]'::jsonb
    );

    CREATE TABLE IF NOT EXISTS booth_session_samples (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES booth_sessions(id) ON DELETE CASCADE,
      timestamp BIGINT NOT NULL,
      hesitation_score DOUBLE PRECISION NOT NULL,
      confidence_score DOUBLE PRECISION NOT NULL,
      pause_duration_ms INTEGER NOT NULL,
      audio_level DOUBLE PRECISION NOT NULL,
      is_speaking BOOLEAN NOT NULL,
      trigger_badges JSONB NOT NULL DEFAULT '[]'::jsonb,
      active_assist_text TEXT,
      feature_snapshot JSONB,
      interpretation JSONB
    );

    CREATE INDEX IF NOT EXISTS booth_session_samples_session_id_idx
      ON booth_session_samples (session_id, timestamp);
  `);

  return {
    async createSession(clipName) {
      const sessionId = createSessionId();
      const startedAt = new Date().toISOString();

      await pool.query(
        `
          INSERT INTO booth_sessions (
            id, clip_name, started_at, status, sample_count, max_hesitation_score,
            max_confidence_score, longest_pause_ms, assist_count, last_trigger_badges
          ) VALUES ($1, $2, $3, 'active', 0, 0, 0, 0, 0, $4::jsonb)
        `,
        [sessionId, clipName, startedAt, JSON.stringify([])],
      );

      const result = await pool.query<SessionRow>(
        `
          SELECT *
          FROM booth_sessions
          WHERE id = $1
        `,
        [sessionId],
      );

      return mapSessionRow(result.rows[0]);
    },

    async appendSample(sessionId, sample) {
      await pool.query('BEGIN');

      try {
        await pool.query(
          `
            INSERT INTO booth_session_samples (
              session_id, timestamp, hesitation_score, confidence_score, pause_duration_ms,
              audio_level, is_speaking, trigger_badges, active_assist_text, feature_snapshot, interpretation
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb)
          `,
          [
            sessionId,
            sample.timestamp,
            sample.hesitationScore,
            sample.confidenceScore,
            sample.pauseDurationMs,
            sample.audioLevel,
            sample.isSpeaking,
            JSON.stringify(sample.triggerBadges),
            sample.activeAssistText,
            sample.featureSnapshot ? JSON.stringify(sample.featureSnapshot) : null,
            sample.interpretation ? JSON.stringify(sample.interpretation) : null,
          ],
        );

        await pool.query(
          `
            UPDATE booth_sessions
            SET sample_count = sample_count + 1,
                max_hesitation_score = GREATEST(max_hesitation_score, $2),
                max_confidence_score = GREATEST(max_confidence_score, $3),
                longest_pause_ms = GREATEST(longest_pause_ms, $4),
                assist_count = assist_count + $5,
                last_trigger_badges = $6::jsonb
            WHERE id = $1
          `,
          [
            sessionId,
            sample.hesitationScore,
            sample.confidenceScore,
            sample.pauseDurationMs,
            sample.activeAssistText ? 1 : 0,
            JSON.stringify(sample.triggerBadges),
          ],
        );

        const result = await pool.query<SessionRow>(
          `
            SELECT *
            FROM booth_sessions
            WHERE id = $1
          `,
          [sessionId],
        );

        if (result.rows.length === 0) {
          throw new Error(`Unknown booth session: ${sessionId}`);
        }

        await pool.query('COMMIT');
        return mapSessionRow(result.rows[0]);
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
    },

    async finishSession(sessionId, endedAt) {
      const result = await pool.query<SessionRow>(
        `
          UPDATE booth_sessions
          SET status = 'completed',
              ended_at = $2
          WHERE id = $1
          RETURNING *
        `,
        [sessionId, endedAt ?? new Date().toISOString()],
      );

      if (result.rows.length === 0) {
        throw new Error(`Unknown booth session: ${sessionId}`);
      }

      return mapSessionRow(result.rows[0]);
    },

    async listSessions(limit = 12) {
      const result = await pool.query<SessionRow>(
        `
          SELECT *
          FROM booth_sessions
          ORDER BY started_at DESC
          LIMIT $1
        `,
        [limit],
      );

      return result.rows.map(mapSessionRow);
    },

    async getSession(sessionId) {
      const sessionResult = await pool.query<SessionRow>(
        `
          SELECT *
          FROM booth_sessions
          WHERE id = $1
        `,
        [sessionId],
      );

      if (sessionResult.rows.length === 0) {
        return null;
      }

      const sampleResult = await pool.query<SampleRow>(
        `
          SELECT timestamp, hesitation_score, confidence_score, pause_duration_ms, audio_level,
                 is_speaking, trigger_badges, active_assist_text, feature_snapshot, interpretation
          FROM booth_session_samples
          WHERE session_id = $1
          ORDER BY timestamp ASC
        `,
        [sessionId],
      );

      return {
        ...mapSessionRow(sessionResult.rows[0]),
        samples: sampleResult.rows.map(mapSampleRow),
      };
    },

    async getAnalytics() {
      const result = await pool.query<{
        total_sessions: number | string;
        completed_sessions: number | string;
        average_max_hesitation_score: number | string;
        average_longest_pause_ms: number | string;
        total_assist_count: number | string;
      }>(`
        SELECT
          COUNT(*) AS total_sessions,
          COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_sessions,
          COALESCE(AVG(max_hesitation_score), 0) AS average_max_hesitation_score,
          COALESCE(AVG(longest_pause_ms), 0) AS average_longest_pause_ms,
          COALESCE(SUM(assist_count), 0) AS total_assist_count
        FROM booth_sessions
      `);

      const row = result.rows[0];
      if (!row) {
        return createEmptyAnalytics();
      }

      return {
        totalSessions: toNumber(row.total_sessions),
        completedSessions: toNumber(row.completed_sessions),
        averageMaxHesitationScore: toNumber(row.average_max_hesitation_score),
        averageLongestPauseMs: Math.round(toNumber(row.average_longest_pause_ms)),
        totalAssistCount: toNumber(row.total_assist_count),
      };
    },

    async getSpeakerProfile() {
      const result = await pool.query<{
        total_sessions: number | string;
        total_samples: number | string;
        average_max_hesitation_score: number | string;
        average_recovery_score: number | string;
        average_pause_duration_ms: number | string;
        average_speech_streak_ms: number | string;
        average_filler_density: number | string;
        average_repeated_openings: number | string;
        average_transcript_stability: number | string;
      }>(`
        SELECT
          COUNT(DISTINCT s.id) AS total_sessions,
          COUNT(ss.id) AS total_samples,
          COALESCE(AVG(s.max_hesitation_score), 0) AS average_max_hesitation_score,
          COALESCE(AVG(ss.confidence_score), 0) AS average_recovery_score,
          COALESCE(AVG(ss.pause_duration_ms), 0) AS average_pause_duration_ms,
          COALESCE(AVG(COALESCE((ss.feature_snapshot->>'speechStreakMs')::double precision, 0)), 0) AS average_speech_streak_ms,
          COALESCE(AVG(COALESCE((ss.feature_snapshot->>'fillerDensity')::double precision, 0)), 0) AS average_filler_density,
          COALESCE(AVG(COALESCE((ss.feature_snapshot->>'repeatedOpeningCount')::double precision, 0)), 0) AS average_repeated_openings,
          COALESCE(AVG(COALESCE((ss.feature_snapshot->>'transcriptStabilityScore')::double precision, 1)), 1) AS average_transcript_stability
        FROM booth_sessions s
        LEFT JOIN booth_session_samples ss ON ss.session_id = s.id
      `);

      const row = result.rows[0];
      if (!row) {
        return createEmptySpeakerProfile();
      }

      return {
        totalSessions: toNumber(row.total_sessions),
        totalSamples: toNumber(row.total_samples),
        averageMaxHesitationScore: toNumber(row.average_max_hesitation_score),
        averageRecoveryScore: toNumber(row.average_recovery_score),
        averagePauseDurationMs: Math.round(toNumber(row.average_pause_duration_ms)),
        averageSpeechStreakMs: Math.round(toNumber(row.average_speech_streak_ms)),
        averageFillerDensity: toNumber(row.average_filler_density),
        averageRepeatedOpenings: toNumber(row.average_repeated_openings),
        averageTranscriptStability: toNumber(row.average_transcript_stability),
        wakePhrase: 'line',
      };
    },

    async close() {
      await pool.end();
    },
  };
}

function createSqliteBoothSessionStore(databaseFile?: string): BoothSessionStore {
  const resolvedFile = databaseFile ?? getDefaultSqlitePath();
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
      feature_snapshot TEXT,
      interpretation TEXT,
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

  const insertSample = database.prepare(`
    INSERT INTO booth_session_samples (
      session_id, timestamp, hesitation_score, confidence_score, pause_duration_ms,
      audio_level, is_speaking, trigger_badges, active_assist_text, feature_snapshot, interpretation
    ) VALUES (
      @session_id, @timestamp, @hesitation_score, @confidence_score, @pause_duration_ms,
      @audio_level, @is_speaking, @trigger_badges, @active_assist_text, @feature_snapshot, @interpretation
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

  const markSessionFinished = database.prepare(`
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

  const listSessionRows = database.prepare(`
    SELECT *
    FROM booth_sessions
    ORDER BY datetime(started_at) DESC
    LIMIT ?
  `);

  const listSampleRows = database.prepare(`
    SELECT timestamp, hesitation_score, confidence_score, pause_duration_ms, audio_level,
           is_speaking, trigger_badges, active_assist_text, feature_snapshot, interpretation
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
    const sessionId = createSessionId();
    insertSession.run({
      id: sessionId,
      clip_name: clipName,
      started_at: new Date().toISOString(),
    });

    return mapSessionRow(getSessionById.get(sessionId) as SessionRow);
  });

  const appendSampleTransaction = database.transaction(
    (sessionId: string, sample: BoothSessionSample) => {
      insertSample.run({
        session_id: sessionId,
        timestamp: sample.timestamp,
        hesitation_score: sample.hesitationScore,
        confidence_score: sample.confidenceScore,
        pause_duration_ms: sample.pauseDurationMs,
        audio_level: sample.audioLevel,
        is_speaking: sample.isSpeaking ? 1 : 0,
        trigger_badges: JSON.stringify(sample.triggerBadges),
        active_assist_text: sample.activeAssistText,
        feature_snapshot: sample.featureSnapshot ? JSON.stringify(sample.featureSnapshot) : null,
        interpretation: sample.interpretation ? JSON.stringify(sample.interpretation) : null,
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
    async createSession(clipName) {
      return createSessionTransaction(clipName);
    },

    async appendSample(sessionId, sample) {
      return appendSampleTransaction(sessionId, sample);
    },

    async finishSession(sessionId, endedAt) {
      markSessionFinished.run({
        id: sessionId,
        ended_at: endedAt ?? new Date().toISOString(),
      });

      const row = getSessionById.get(sessionId) as SessionRow | undefined;
      if (!row) {
        throw new Error(`Unknown booth session: ${sessionId}`);
      }

      return mapSessionRow(row);
    },

    async listSessions(limit = 12) {
      return (listSessionRows.all(limit) as SessionRow[]).map(mapSessionRow);
    },

    async getSession(sessionId) {
      const sessionRow = getSessionById.get(sessionId) as SessionRow | undefined;
      if (!sessionRow) {
        return null;
      }

      return {
        ...mapSessionRow(sessionRow),
        samples: (listSampleRows.all(sessionId) as SampleRow[]).map(mapSampleRow),
      };
    },

    async getAnalytics() {
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

    async getSpeakerProfile() {
      const sessions = await this.listSessions(200);
      const records = await Promise.all(sessions.map((session) => this.getSession(session.id)));
      const samples = records.flatMap((record) => record?.samples ?? []);

      if (sessions.length === 0 || samples.length === 0) {
        return createEmptySpeakerProfile();
      }

      const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
      const numericFeature = (key: string, fallback = 0) =>
        samples.map((sample) => {
          const snapshot = sample.featureSnapshot as Record<string, unknown> | undefined;
          const value = snapshot?.[key];
          return typeof value === 'number' ? value : fallback;
        });

      return {
        totalSessions: sessions.length,
        totalSamples: samples.length,
        averageMaxHesitationScore:
          sum(sessions.map((session) => session.maxHesitationScore)) / Math.max(1, sessions.length),
        averageRecoveryScore:
          sum(samples.map((sample) => sample.confidenceScore)) / Math.max(1, samples.length),
        averagePauseDurationMs: Math.round(
          sum(samples.map((sample) => sample.pauseDurationMs)) / Math.max(1, samples.length),
        ),
        averageSpeechStreakMs: Math.round(
          sum(numericFeature('speechStreakMs')) / Math.max(1, samples.length),
        ),
        averageFillerDensity:
          sum(numericFeature('fillerDensity')) / Math.max(1, samples.length),
        averageRepeatedOpenings:
          sum(numericFeature('repeatedOpeningCount')) / Math.max(1, samples.length),
        averageTranscriptStability:
          sum(numericFeature('transcriptStabilityScore', 1)) / Math.max(1, samples.length),
        wakePhrase: 'line',
      };
    },

    async close() {
      database.close();
    },
  };
}

export async function createBoothSessionStore(
  databaseFile?: string,
  databaseUrl = process.env.DATABASE_URL,
): Promise<BoothSessionStore> {
  if (databaseUrl) {
    return createPostgresBoothSessionStore(databaseUrl);
  }

  if (!databaseFile) {
    throw new Error('DATABASE_URL is required for the API runtime.');
  }

  return createSqliteBoothSessionStore(databaseFile);
}
