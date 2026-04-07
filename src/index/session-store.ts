import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { resolve } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Chunk } from './chunker.js';
import { log } from '../display/logger.js';

const DB_DIR = '.context-guardian';
const DB_FILE = 'sessions.db';

let sqlPromise: ReturnType<typeof initSqlJs> | null = null;

function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs();
  }
  return sqlPromise;
}

export class SessionStore {
  private db!: import('sql.js').Database;
  private sessionId: string;
  private dbPath: string;
  private ready: Promise<void>;

  constructor(sessionId?: string, dbPath?: string) {
    this.sessionId = sessionId || generateSessionId();
    const dir = resolve(process.cwd(), DB_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.dbPath = dbPath || resolve(dir, DB_FILE);
    this.ready = this.init();
  }

  private async init() {
    const SQL = await getSql();

    if (existsSync(this.dbPath)) {
      const buf = readFileSync(this.dbPath);
      this.db = new SQL.Database(buf);
    } else {
      this.db = new SQL.Database();
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT 'other',
        source TEXT NOT NULL DEFAULT 'request',
        embedding TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_chunks_label ON chunks(label)');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        goal TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_active TEXT NOT NULL DEFAULT (datetime('now')),
        request_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.persist();
  }

  private persist() {
    try {
      const data = this.db.export();
      writeFileSync(this.dbPath, Buffer.from(data));
    } catch {
      // never crash over persistence
    }
  }

  async ensureReady() {
    await this.ready;
  }

  get currentSessionId(): string {
    return this.sessionId;
  }

  startSession(goal?: string) {
    this.db.run(
      `INSERT OR REPLACE INTO sessions (id, goal, last_active, request_count)
       VALUES (?, ?, datetime('now'),
         COALESCE((SELECT request_count FROM sessions WHERE id = ?), 0) + 1
       )`,
      [this.sessionId, goal || null, this.sessionId],
    );
    this.persist();
  }

  addChunks(chunks: Chunk[], embeddings: number[][]) {
    this.db.run('BEGIN TRANSACTION');
    try {
      const stmt = this.db.prepare(
        'INSERT INTO chunks (session_id, text, label, source, embedding) VALUES (?, ?, ?, ?, ?)',
      );
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        stmt.run([
          this.sessionId,
          c.text,
          c.label || 'other',
          c.metadata.source || 'request',
          JSON.stringify(embeddings[i] || []),
        ]);
      }
      stmt.free();
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.persist();
    log('debug', `Persisted ${chunks.length} chunks to session ${this.sessionId}`);
  }

  searchFTS(query: string, limit = 10, sessionId?: string): Array<{ text: string; label: string; score: number }> {
    // sql.js doesn't support FTS5 out of the box, use LIKE-based search
    return this.searchLike(query, limit, sessionId);
  }

  searchLike(query: string, limit = 10, sessionId?: string): Array<{ text: string; label: string; score: number }> {
    const sid = sessionId || this.sessionId;
    const sanitized = query.replace(/['"]/g, '').trim();
    if (!sanitized) return [];

    const terms = sanitized.toLowerCase().split(/\s+/).filter(Boolean);
    const stmt = this.db.prepare(
      'SELECT text, label FROM chunks WHERE session_id = ? ORDER BY created_at DESC LIMIT 1000',
    );
    stmt.bind([sid]);

    const results: Array<{ text: string; label: string; score: number }> = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { text: string; label: string };
      const lower = row.text.toLowerCase();
      let hits = 0;
      for (const t of terms) {
        if (lower.includes(t)) hits++;
      }
      if (hits > 0) {
        results.push({ text: row.text, label: row.label, score: hits / terms.length });
      }
    }
    stmt.free();

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  searchByLabel(label: string, limit = 20, sessionId?: string): Array<{ text: string; label: string }> {
    const sid = sessionId || this.sessionId;
    const stmt = this.db.prepare(
      'SELECT text, label FROM chunks WHERE session_id = ? AND label = ? ORDER BY created_at DESC LIMIT ?',
    );
    stmt.bind([sid, label, limit]);

    const results: Array<{ text: string; label: string }> = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as { text: string; label: string });
    }
    stmt.free();
    return results;
  }

  getSessionChunkCount(sessionId?: string): number {
    const sid = sessionId || this.sessionId;
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM chunks WHERE session_id = ?');
    stmt.bind([sid]);
    stmt.step();
    const row = stmt.getAsObject() as { count: number };
    stmt.free();
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
    stmt.bind([limit]);

    const results: Array<{ id: string; goal: string | null; requestCount: number; chunkCount: number; lastActive: string }> = [];
    while (stmt.step()) {
      const r = stmt.getAsObject() as { id: string; goal: string | null; request_count: number; chunk_count: number; last_active: string };
      results.push({
        id: r.id,
        goal: r.goal,
        requestCount: r.request_count,
        chunkCount: r.chunk_count,
        lastActive: r.last_active,
      });
    }
    stmt.free();
    return results;
  }

  pruneOldSessions(maxAgeDays = 7) {
    this.db.run(
      `DELETE FROM chunks WHERE session_id IN (
        SELECT id FROM sessions WHERE last_active < datetime('now', ?)
      )`,
      [`-${maxAgeDays} days`],
    );
    const result = this.db.run(
      `DELETE FROM sessions WHERE last_active < datetime('now', ?)`,
      [`-${maxAgeDays} days`],
    );
    this.persist();
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
