import Database from 'better-sqlite3';
import { lookup } from 'dns/promises';
import fs from 'fs';
import path from 'path';
import {
  RetrieveUserContextResponse,
  UploadUserContextInput,
  UserContextChunk,
  UserContextDocument,
} from '@sports-copilot/shared-types';

const OPENAI_EMBEDDING_URL = 'https://api.openai.com/v1/embeddings';
const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
const MAX_CHUNK_CHARS = 900;
const CHUNK_OVERLAP_CHARS = 140;

type ContextDocumentRow = {
  id: string;
  file_name: string;
  source_type: 'text' | 'file';
  created_at: string;
  chunk_count: number | string;
};

type ContextChunkRow = {
  id: string;
  document_id: string;
  document_name: string;
  chunk_index: number | string;
  text: string;
  embedding: string | number[];
};

export interface UserContextStore {
  ingestDocument: (input: UploadUserContextInput) => Promise<UserContextDocument>;
  listDocuments: () => Promise<UserContextDocument[]>;
  retrieveRelevantChunks: (queryText: string, limit?: number) => Promise<RetrieveUserContextResponse>;
  close?: () => Promise<void>;
}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

function parseEmbedding(value: string | number[]) {
  if (Array.isArray(value)) {
    return value.map((item) => Number(item));
  }

  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.map((item) => Number(item)) : [];
}

function mapDocumentRow(row: ContextDocumentRow): UserContextDocument {
  return {
    id: row.id,
    fileName: row.file_name,
    sourceType: row.source_type,
    createdAt: row.created_at,
    chunkCount: toNumber(row.chunk_count),
  };
}

function normalizeWhitespace(text: string) {
  return text.replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
}

function chunkText(text: string) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const rawEnd = Math.min(normalized.length, cursor + MAX_CHUNK_CHARS);
    let end = rawEnd;

    if (rawEnd < normalized.length) {
      const paragraphBreak = normalized.lastIndexOf('\n\n', rawEnd);
      const sentenceBreak = Math.max(
        normalized.lastIndexOf('. ', rawEnd),
        normalized.lastIndexOf('! ', rawEnd),
        normalized.lastIndexOf('? ', rawEnd),
      );
      const chosenBreak = Math.max(paragraphBreak, sentenceBreak);
      if (chosenBreak > cursor + MAX_CHUNK_CHARS * 0.55) {
        end = chosenBreak + 1;
      }
    }

    const chunk = normalized.slice(cursor, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= normalized.length) {
      break;
    }

    cursor = Math.max(end - CHUNK_OVERLAP_CHARS, cursor + 1);
  }

  return chunks;
}

function dot(left: number[], right: number[]) {
  let total = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    total += left[index] * right[index];
  }
  return total;
}

function magnitude(values: number[]) {
  return Math.sqrt(values.reduce((total, value) => total + value * value, 0));
}

function cosineSimilarity(left: number[], right: number[]) {
  const leftMagnitude = magnitude(left);
  const rightMagnitude = magnitude(right);

  if (!leftMagnitude || !rightMagnitude) {
    return 0;
  }

  return Math.max(0, Math.min(1, dot(left, right) / (leftMagnitude * rightMagnitude)));
}

async function embedTexts(input: string[]) {
  const response = await fetch(OPENAI_EMBEDDING_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_EMBEDDING_MODEL,
      input,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI embeddings failed: ${response.status} ${errorText}`);
  }

  const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
  return (payload.data ?? []).map((item) => item.embedding ?? []);
}

function getDefaultSqlitePath() {
  return path.resolve(__dirname, '../../../data/app/sports-copilot.sqlite');
}

type PoolConfiguration = {
  connectionString?: string;
  user?: string;
  password?: string;
  host?: string;
  port?: number;
  database?: string;
  ssl?: false | { rejectUnauthorized: false; servername?: string };
};

function getPoolConfiguration(connectionString: string): PoolConfiguration {
  const requiresSsl =
    /supabase\.co|render\.com|neon\.tech|railway\.app/i.test(connectionString) &&
    !/sslmode=disable/i.test(connectionString);

  return {
    connectionString,
    ssl: requiresSsl ? { rejectUnauthorized: false } : undefined,
  };
}

function getParsedConnectionDetails(connectionString: string) {
  const parsed = new URL(connectionString);

  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    database: parsed.pathname.replace(/^\//, ''),
  };
}

async function getIpv4PreferredPoolConfiguration(
  connectionString: string,
  resolveHostname: typeof lookup = lookup,
): Promise<PoolConfiguration> {
  const baseConfig = getPoolConfiguration(connectionString);
  const parsed = getParsedConnectionDetails(connectionString);

  try {
    const { address } = await resolveHostname(parsed.host, { family: 4 });

    return {
      user: parsed.user,
      password: parsed.password,
      host: address,
      port: parsed.port,
      database: parsed.database,
      ssl:
        baseConfig.ssl && typeof baseConfig.ssl === 'object'
          ? { ...baseConfig.ssl, servername: parsed.host }
          : baseConfig.ssl,
    };
  } catch (_error) {
    return baseConfig;
  }
}

async function createPostgresUserContextStore(connectionString: string): Promise<UserContextStore> {
  const { Pool } = await import('pg');
  const pool = new Pool(await getIpv4PreferredPoolConfiguration(connectionString));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS context_documents (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN ('text', 'file')),
      created_at TIMESTAMPTZ NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS context_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES context_documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS context_chunks_document_id_idx
      ON context_chunks (document_id, chunk_index);
  `);

  return {
    async ingestDocument(input) {
      const documentId = createId('ctxdoc');
      const createdAt = new Date().toISOString();
      const chunks = chunkText(input.text);
      const embeddings = chunks.length > 0 ? await embedTexts(chunks) : [];

      await pool.query('BEGIN');
      try {
        await pool.query(
          `
            INSERT INTO context_documents (id, file_name, source_type, created_at, chunk_count)
            VALUES ($1, $2, $3, $4, $5)
          `,
          [documentId, input.fileName, input.sourceType, createdAt, chunks.length],
        );

        for (let index = 0; index < chunks.length; index += 1) {
          await pool.query(
            `
              INSERT INTO context_chunks (id, document_id, chunk_index, text, embedding)
              VALUES ($1, $2, $3, $4, $5::jsonb)
            `,
            [createId('ctxchunk'), documentId, index, chunks[index], JSON.stringify(embeddings[index] ?? [])],
          );
        }

        await pool.query('COMMIT');
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }

      return {
        id: documentId,
        fileName: input.fileName,
        sourceType: input.sourceType,
        createdAt,
        chunkCount: chunks.length,
      };
    },

    async listDocuments() {
      const result = await pool.query<ContextDocumentRow>(
        `SELECT * FROM context_documents ORDER BY created_at DESC`,
      );
      return result.rows.map(mapDocumentRow);
    },

    async retrieveRelevantChunks(queryText, limit = 5) {
      const queryEmbedding = (await embedTexts([queryText]))[0] ?? [];
      const documents = await pool.query<ContextChunkRow>(
        `
          SELECT c.id, c.document_id, d.file_name AS document_name, c.chunk_index, c.text, c.embedding
          FROM context_chunks c
          JOIN context_documents d ON d.id = c.document_id
        `,
      );

      const chunks = documents.rows
        .map((row) => {
          const score = cosineSimilarity(queryEmbedding, parseEmbedding(row.embedding));
          return {
            id: row.id,
            documentId: row.document_id,
            documentName: row.document_name,
            chunkIndex: toNumber(row.chunk_index),
            text: row.text,
            score,
          } satisfies UserContextChunk;
        })
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);

      return { chunks };
    },

    async close() {
      await pool.end();
    },
  };
}

function createSqliteUserContextStore(databaseFile?: string): UserContextStore {
  const resolvedFile = databaseFile ?? getDefaultSqlitePath();
  fs.mkdirSync(path.dirname(resolvedFile), { recursive: true });
  const database = new Database(resolvedFile);

  database.exec(`
    CREATE TABLE IF NOT EXISTS context_documents (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN ('text', 'file')),
      created_at TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS context_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      FOREIGN KEY(document_id) REFERENCES context_documents(id) ON DELETE CASCADE
    );
  `);

  const insertDocument = database.prepare(`
    INSERT INTO context_documents (id, file_name, source_type, created_at, chunk_count)
    VALUES (@id, @file_name, @source_type, @created_at, @chunk_count)
  `);

  const insertChunk = database.prepare(`
    INSERT INTO context_chunks (id, document_id, chunk_index, text, embedding)
    VALUES (@id, @document_id, @chunk_index, @text, @embedding)
  `);

  const listDocuments = database.prepare(`
    SELECT *
    FROM context_documents
    ORDER BY datetime(created_at) DESC
  `);

  const listChunks = database.prepare(`
    SELECT c.id, c.document_id, d.file_name AS document_name, c.chunk_index, c.text, c.embedding
    FROM context_chunks c
    JOIN context_documents d ON d.id = c.document_id
  `);

  const ingestTransaction = database.transaction(
    (document: UserContextDocument, chunks: string[], embeddings: number[][]) => {
      insertDocument.run({
        id: document.id,
        file_name: document.fileName,
        source_type: document.sourceType,
        created_at: document.createdAt,
        chunk_count: document.chunkCount,
      });

      for (let index = 0; index < chunks.length; index += 1) {
        insertChunk.run({
          id: createId('ctxchunk'),
          document_id: document.id,
          chunk_index: index,
          text: chunks[index],
          embedding: JSON.stringify(embeddings[index] ?? []),
        });
      }
    },
  );

  return {
    async ingestDocument(input) {
      const chunks = chunkText(input.text);
      const embeddings = chunks.length > 0 ? await embedTexts(chunks) : [];
      const document: UserContextDocument = {
        id: createId('ctxdoc'),
        fileName: input.fileName,
        sourceType: input.sourceType,
        createdAt: new Date().toISOString(),
        chunkCount: chunks.length,
      };

      ingestTransaction(document, chunks, embeddings);
      return document;
    },

    async listDocuments() {
      return (listDocuments.all() as ContextDocumentRow[]).map(mapDocumentRow);
    },

    async retrieveRelevantChunks(queryText, limit = 5) {
      const queryEmbedding = (await embedTexts([queryText]))[0] ?? [];
      const chunks = (listChunks.all() as ContextChunkRow[])
        .map((row) => {
          const score = cosineSimilarity(queryEmbedding, parseEmbedding(row.embedding));
          return {
            id: row.id,
            documentId: row.document_id,
            documentName: row.document_name,
            chunkIndex: toNumber(row.chunk_index),
            text: row.text,
            score,
          } satisfies UserContextChunk;
        })
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);

      return { chunks };
    },

    async close() {
      database.close();
    },
  };
}

export async function createUserContextStore(
  databaseFile?: string,
  databaseUrl = process.env.DATABASE_URL,
) {
  if (databaseUrl) {
    return createPostgresUserContextStore(databaseUrl);
  }

  return createSqliteUserContextStore(databaseFile);
}
