import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import type { Chunk } from './chunker.js';
import { log } from '../display/logger.js';

const DB_DIR = '.context-guardian';
const DB_FILE = 'sessions.db';

export interface SessionEntry {
  id: number;
  sessionId: string;
  text: string;
  label: string;
  source: string;
  embedding: string; // JSON-encoded number[]
  createdAt: string;
}

export class SessionStore {
  private db: Database.Database;
  private sessionId: string;

  constructor(sessionId?: string, dbPath?: string) {
    this.sessionId = sessionId || generateSessionId();

    const dir = resolve(process.cwd(), DB_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const fullPath = dbPath || resolve(dir, DB_FILE);
    this.db = new Database(fullPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT 'other',
        source TEXT NOT NULL DEFAULT 'request',
        embedding TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_label ON chunks(label);
    `);

    // FTS5 virtual table for full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        label,
        content=chunks,
        content_rowid=id,
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text, label) VALUES (new.id, new.text, new.label);
      END;

      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text, label) VALUES('delete', old.id, old.text, old.label);
      END;
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        goal TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_active TEXT NOT NULL DEFAULT (datetime('now')),
        request_count INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  get currentSessionId(): string {
    return this.sessionId;
  }

  startSession(goal?: string) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, goal, last_active, request_count)
      VALUES (?, ?, datetime('now'),
        COALESCE((SELECT request_count FROM sessions WHERE id = ?), 0) + 1
      )
    `);
    stmt.run(this.sessionId, goal || null, this.sessionId);
  }

  addChunks(chunks: Chunk[], embeddings: number[][]) {
    const stmt = this.db.prepare(`
      INSERT INTO chunks (session_id, text, label, source, embedding)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((items: Array<{ chunk: Chunk; emb: number[] }>) => {
      for (const { chunk, emb } of items) {
        stmt.run(
          this.sessionId,
          chunk.text,
          chunk.label || 'other',
          chunk.metadata.source || 'request',
          JSON.stringify(emb),
        );
      }
    });

    const items = chunks.map((c, i) => ({ chunk: c, emb: embeddings[i] || [] }));
    insertMany(items);
    log('debug', `Persisted ${chunks.length} chunks to session ${this.sessionId}`);
  }

  searchFTS(query: string, limit = 10, sessionId?: string): Array<{ text: string; label: string; score: number }> {
    const sid = sessionId || this.sessionId;
    const sanitized = query.replace(/['"]/g, '').trim();
    if (!sanitized) return [];

    try {
      const stmt = this.db.prepare(`
        SELECT c.text, c.label, rank
        FROM chunks_fts f
        JOIN chunks c ON c.id = f.rowid
        WHERE chunks_fts MATCH ?
          AND c.session_id = ?
        ORDER BY rank
        LIMIT ?
      `);
      const rows = stmt.all(sanitized, sid, limit) as Array<{ text: string; label: string; rank: number }>;
      return rows.map((r) => ({ text: r.text, label: r.label, score: -r.rank }));
    } catch {
      // FTS query syntax error, fall back to LIKE
      return this.searchLike(query, limit, sid);
    }
  }

  searchLike(query: string, limit = 10, sessionId?: string): Array<{ text: string; label: string; score: number }> {
    const sid = sessionId || this.sessionId;
    const stmt = this.db.prepare(`
      SELECT text, label FROM chunks
      WHERE session_id = ? AND text LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(sid, `%${query}%`, limit) as Array<{ text: string; label: string }>;
    return rows.map((r) => ({ text: r.text, label: r.label, score: 1.0 }));
  }

  searchByLabel(label: string, limit = 20, sessionId?: string): Array<{ text: string; label: string }> {
    const sid = sessionId || this.sessionId;
    const stmt = this.db.prepare(`
      SELECT text, label FROM chunks
      WHERE session_id = ? AND label = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(sid, label, limit) as Array<{ text: string; label: string }>;
  }

  getSessionChunkCount(sessionId?: string): number {
    const sid = sessionId || this.sessionId;
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM chunks WHERE session_id = ?');
    const row = stmt.get(sid) as { count: number };
    return row.count;
  }

  listSessions(limit = 20): Array<{ id: string; goal: string | null; requestCount: number; chunkCount: number; lastActive: string }> {
    const stmt = this.db.prepare(`
      SELECT s.id, s.goal, s.request_count, s.last_active,
        (SELECT COUNT(*) FROM chunks c WHERE c.session_id = s.id) as chunk_count
      FROM sessions s
      ORDER BY s.last_active DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as Array<{ id: string; goal: string | null; request_count: number; chunk_count: number; last_active: string }>;
    return rows.map((r) => ({
      id: r.id,
      goal: r.goal,
      requestCount: r.request_count,
      chunkCount: r.chunk_count,
      lastActive: r.last_active,
    }));
  }

  pruneOldSessions(maxAgeDays = 7) {
    const stmt = this.db.prepare(`
      DELETE FROM chunks WHERE session_id IN (
        SELECT id FROM sessions WHERE last_active < datetime('now', ?)
      )
    `);
    stmt.run(`-${maxAgeDays} days`);

    const stmt2 = this.db.prepare(`DELETE FROM sessions WHERE last_active < datetime('now', ?)`);
    const result = stmt2.run(`-${maxAgeDays} days`);
    if (result.changes > 0) {
      log('info', `Pruned ${result.changes} old sessions (>${maxAgeDays} days)`);
    }
  }

  close() {
    this.db.close();
  }
}

function generateSessionId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${date}-${rand}`;
}
