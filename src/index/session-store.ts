import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { resolve } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

export interface CoreMemory {
  goal: string;
  filesTouched: string[];
  decisions: string[];
  errorsFixed: string[];
  pendingTasks: string[];
  nextStep: string;
  toolResultCount: number;
  compactedAt?: string;
}

export interface CompactionResult {
  coreMemory: CoreMemory;
  coldChunkIds: number[];
  hotTailSize: number;
}

export class SessionStore {
  private db!: import('sql.js').Database;
  private sessionId: string;
  private dbPath: string;
  private ready: Promise<void>;

  constructor(sessionId?: string, dbPath?: string) {
    this.sessionId = normalizeSessionId(sessionId || generateSessionId());
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
        chunk_hash TEXT,
        embedding TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    try {
      this.db.run('ALTER TABLE chunks ADD COLUMN chunk_hash TEXT');
    } catch {
      // already exists
    }
    this.db.run('CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_chunks_label ON chunks(label)');
    this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_session_hash
      ON chunks(session_id, chunk_hash)
      WHERE chunk_hash IS NOT NULL AND chunk_hash != ''`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        goal TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_active TEXT NOT NULL DEFAULT (datetime('now')),
        request_count INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Core memory: structured state that persists across requests (Claude Code compaction contract)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS core_memory (
        session_id TEXT PRIMARY KEY,
        goal TEXT NOT NULL DEFAULT '',
        files_touched TEXT NOT NULL DEFAULT '[]',
        decisions TEXT NOT NULL DEFAULT '[]',
        errors_fixed TEXT NOT NULL DEFAULT '[]',
        pending_tasks TEXT NOT NULL DEFAULT '[]',
        next_step TEXT NOT NULL DEFAULT '',
        tool_result_count INTEGER NOT NULL DEFAULT 0,
        compacted_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Tool results cold storage: older results stored by reference, not inline
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tool_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        query TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0,
        is_hot INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_tool_results_session ON tool_results(session_id)');

    // Entity index: pre-extracted searchable entities for entity hints
    this.db.run(`
      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        value TEXT NOT NULL,
        source_chunk_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_entities_session ON entities(session_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type)');

    this.persist();
  }

  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private persist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        const data = this.db.export();
        const tmpPath = this.dbPath + '.tmp';
        writeFileSync(tmpPath, Buffer.from(data));
        renameSync(tmpPath, this.dbPath);
      } catch {
        // never crash over persistence
      }
    }, 100);
  }

  private persistSync() {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    try {
      const data = this.db.export();
      const tmpPath = this.dbPath + '.tmp';
      writeFileSync(tmpPath, Buffer.from(data));
      renameSync(tmpPath, this.dbPath);
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

  startSession(goal?: string, sessionId?: string) {
    const sid = this.resolveSessionId(sessionId);
    this.db.run(
      `INSERT OR REPLACE INTO sessions (id, goal, last_active, request_count)
       VALUES (?, ?, datetime('now'),
         COALESCE((SELECT request_count FROM sessions WHERE id = ?), 0) + 1
       )`,
      [sid, goal || null, sid],
    );
    this.persist();
  }

  addChunks(chunks: Chunk[], embeddings: number[][], sessionId?: string) {
    const sid = this.resolveSessionId(sessionId);
    this.db.run('BEGIN TRANSACTION');
    try {
      const stmt = this.db.prepare(
        'INSERT OR IGNORE INTO chunks (session_id, text, label, source, chunk_hash, embedding) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const source = c.metadata.source || 'request';
        const redactedText = redactSensitiveText(c.text);
        const hash = hashChunk(redactedText, source);
        stmt.run([
          sid,
          redactedText,
          c.label || 'other',
          source,
          hash,
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
    log('debug', `Persisted ${chunks.length} chunks to session ${sid}`);
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

  searchByEmbedding(
    queryEmbedding: number[],
    limit = 10,
    sessionId?: string,
  ): Array<{ text: string; label: string; source: string; score: number }> {
    const sid = sessionId || this.sessionId;
    if (!queryEmbedding.length) return [];

    const stmt = this.db.prepare(
      'SELECT text, label, source, embedding FROM chunks WHERE session_id = ? ORDER BY id DESC LIMIT 1500',
    );
    stmt.bind([sid]);

    const results: Array<{ text: string; label: string; source: string; score: number }> = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        text: string;
        label: string;
        source: string;
        embedding: string;
      };
      const emb = safeNumArrayParse(row.embedding);
      if (emb.length !== queryEmbedding.length) continue;
      const score = cosineSimilarity(queryEmbedding, emb);
      if (score <= 0) continue;
      results.push({
        text: row.text,
        label: row.label,
        source: row.source || 'session',
        score,
      });
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

  getRecentChunks(limit = 200, sessionId?: string): Array<{ text: string; label: string; source: string }> {
    const sid = sessionId || this.sessionId;
    const stmt = this.db.prepare(
      'SELECT text, label, source FROM chunks WHERE session_id = ? ORDER BY id DESC LIMIT ?',
    );
    stmt.bind([sid, limit]);

    const results: Array<{ text: string; label: string; source: string }> = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { text: string; label: string; source: string };
      results.push({
        text: row.text,
        label: row.label,
        source: row.source || 'session',
      });
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
    this.db.run(
      `DELETE FROM sessions WHERE last_active < datetime('now', ?)`,
      [`-${maxAgeDays} days`],
    );
    this.persist();
  }

  // ── Core Memory: structured state persisted across requests ──

  getCoreMemory(sessionId?: string): CoreMemory | null {
    const sid = sessionId || this.sessionId;
    const stmt = this.db.prepare(
      'SELECT goal, files_touched, decisions, errors_fixed, pending_tasks, next_step, tool_result_count, compacted_at FROM core_memory WHERE session_id = ?',
    );
    stmt.bind([sid]);
    if (!stmt.step()) { stmt.free(); return null; }
    const r = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    return {
      goal: String(r.goal || ''),
      filesTouched: safeJsonParse(r.files_touched),
      decisions: safeJsonParse(r.decisions),
      errorsFixed: safeJsonParse(r.errors_fixed),
      pendingTasks: safeJsonParse(r.pending_tasks),
      nextStep: String(r.next_step || ''),
      toolResultCount: Number(r.tool_result_count || 0),
      compactedAt: r.compacted_at ? String(r.compacted_at) : undefined,
    };
  }

  updateCoreMemory(memory: Partial<CoreMemory>, sessionId?: string) {
    const sid = sessionId || this.sessionId;
    const existing = this.getCoreMemory(sid);

    const merged: CoreMemory = {
      goal: memory.goal ?? existing?.goal ?? '',
      filesTouched: dedup([...(existing?.filesTouched || []), ...(memory.filesTouched || [])]),
      decisions: dedup([...(existing?.decisions || []), ...(memory.decisions || [])]),
      errorsFixed: dedup([...(existing?.errorsFixed || []), ...(memory.errorsFixed || [])]),
      pendingTasks: memory.pendingTasks ?? existing?.pendingTasks ?? [],
      nextStep: memory.nextStep ?? existing?.nextStep ?? '',
      toolResultCount: memory.toolResultCount ?? existing?.toolResultCount ?? 0,
      compactedAt: memory.compactedAt ?? existing?.compactedAt,
    };

    this.db.run(
      `INSERT OR REPLACE INTO core_memory (session_id, goal, files_touched, decisions, errors_fixed, pending_tasks, next_step, tool_result_count, compacted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        sid,
        merged.goal,
        JSON.stringify(merged.filesTouched),
        JSON.stringify(merged.decisions),
        JSON.stringify(merged.errorsFixed),
        JSON.stringify(merged.pendingTasks),
        merged.nextStep,
        merged.toolResultCount,
        merged.compactedAt || null,
      ],
    );
    this.persist();
  }

  formatCoreMemoryBlock(sessionId?: string): string {
    const mem = this.getCoreMemory(sessionId);
    if (!mem || !mem.goal) return '';

    const lines: string[] = ['## SESSION MEMORY'];
    lines.push(`Goal: ${mem.goal}`);
    if (mem.filesTouched.length > 0)
      lines.push(`Files touched: ${mem.filesTouched.slice(-10).join(', ')}`);
    if (mem.decisions.length > 0)
      lines.push(`Decisions: ${mem.decisions.slice(-5).join('; ')}`);
    if (mem.errorsFixed.length > 0)
      lines.push(`Errors fixed: ${mem.errorsFixed.slice(-3).join('; ')}`);
    if (mem.pendingTasks.length > 0)
      lines.push(`Pending: ${mem.pendingTasks.join('; ')}`);
    if (mem.nextStep)
      lines.push(`Next step: ${mem.nextStep}`);
    return lines.join('\n');
  }

  // ── Tool Results Cold Storage (hot tail / cold archive pattern) ──

  addToolResult(toolName: string, query: string, result: string, tokens: number, sessionId?: string) {
    const sid = sessionId || this.sessionId;
    const safeQuery = redactSensitiveText(query);
    const safeResult = redactSensitiveText(result);
    this.db.run(
      'INSERT INTO tool_results (session_id, tool_name, query, result, tokens, is_hot) VALUES (?, ?, ?, ?, ?, 1)',
      [sid, toolName, safeQuery, safeResult, tokens],
    );
    this.persist();
  }

  getHotToolResults(limit = 3, sessionId?: string): Array<{ id: number; toolName: string; query: string; result: string; tokens: number }> {
    const sid = sessionId || this.sessionId;
    const stmt = this.db.prepare(
      'SELECT id, tool_name, query, result, tokens FROM tool_results WHERE session_id = ? AND is_hot = 1 ORDER BY id DESC LIMIT ?',
    );
    stmt.bind([sid, limit]);
    const results: Array<{ id: number; toolName: string; query: string; result: string; tokens: number }> = [];
    while (stmt.step()) {
      const r = stmt.getAsObject() as { id: number; tool_name: string; query: string; result: string; tokens: number };
      results.push({ id: r.id, toolName: r.tool_name, query: r.query, result: r.result, tokens: r.tokens });
    }
    stmt.free();
    return results;
  }

  freezeOldToolResults(keepHot = 3, sessionId?: string) {
    const sid = sessionId || this.sessionId;
    // Keep the most recent `keepHot` results as hot, freeze the rest
    this.db.run(
      `UPDATE tool_results SET is_hot = 0 WHERE session_id = ? AND id NOT IN (
        SELECT id FROM tool_results WHERE session_id = ? AND is_hot = 1 ORDER BY id DESC LIMIT ?
      )`,
      [sid, sid, keepHot],
    );
    this.persist();
  }

  getToolResultTokenCount(sessionId?: string): number {
    const sid = sessionId || this.sessionId;
    const stmt = this.db.prepare(
      'SELECT SUM(tokens) as total FROM tool_results WHERE session_id = ? AND is_hot = 1',
    );
    stmt.bind([sid]);
    stmt.step();
    const r = stmt.getAsObject() as { total: number | null };
    stmt.free();
    return r.total || 0;
  }

  // ── Entity Extraction: pre-extracted searchable entities ──

  addEntities(entities: Array<{ type: string; value: string; chunkId?: number }>, sessionId?: string) {
    const sid = sessionId || this.sessionId;
    this.db.run('BEGIN TRANSACTION');
    try {
      const stmt = this.db.prepare(
        'INSERT INTO entities (session_id, entity_type, value, source_chunk_id) VALUES (?, ?, ?, ?)',
      );
      for (const e of entities) {
        stmt.run([sid, e.type, redactSensitiveText(e.value), e.chunkId || null]);
      }
      stmt.free();
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.persist();
  }

  getEntities(sessionId?: string): Array<{ type: string; value: string }> {
    const sid = sessionId || this.sessionId;
    const stmt = this.db.prepare(
      'SELECT DISTINCT entity_type, value FROM entities WHERE session_id = ? ORDER BY entity_type, id DESC LIMIT 50',
    );
    stmt.bind([sid]);
    const results: Array<{ type: string; value: string }> = [];
    while (stmt.step()) {
      const r = stmt.getAsObject() as { entity_type: string; value: string };
      results.push({ type: r.entity_type, value: r.value });
    }
    stmt.free();
    return results;
  }

  formatEntityHints(sessionId?: string): string {
    const entities = this.getEntities(sessionId);
    if (entities.length === 0) return '';

    const grouped: Record<string, string[]> = {};
    for (const e of entities) {
      if (!grouped[e.type]) grouped[e.type] = [];
      if (grouped[e.type].length < 5) grouped[e.type].push(e.value);
    }

    const lines: string[] = ['## ENTITY HINTS (use these as precise search queries)'];
    for (const [type, values] of Object.entries(grouped)) {
      lines.push(`${type}: ${values.join(', ')}`);
    }
    return lines.join('\n');
  }

  close() {
    this.persistSync();
    this.db.close();
  }

  private resolveSessionId(sessionId?: string): string {
    return normalizeSessionId(sessionId || this.sessionId);
  }
}

function safeJsonParse(val: unknown): string[] {
  if (!val) return [];
  try { return JSON.parse(String(val)); } catch { return []; }
}

function safeNumArrayParse(val: unknown): number[] {
  if (!val) return [];
  try {
    const parsed = JSON.parse(String(val));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n) => typeof n === 'number') as number[];
  } catch {
    return [];
  }
}

function dedup(arr: string[]): string[] {
  return [...new Set(arr)];
}

function hashChunk(text: string, source: string): string {
  return createHash('sha1').update(source).update('\n').update(text).digest('hex');
}

function normalizeSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) return generateSessionId();
  const sanitized = trimmed.replace(/[^a-zA-Z0-9._:-]/g, '-').slice(0, 120);
  return sanitized || generateSessionId();
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function redactSensitiveText(text: string): string {
  if (!text) return text;
  return text
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{10,}\b/gi, '$1[REDACTED_TOKEN]')
    .replace(/\b(api[_-]?key\s*[:=]\s*)(['"]?)[^\s,'"`]+/gi, '$1$2[REDACTED]')
    .replace(/\b(password\s*[:=]\s*)(['"]?)[^\s,'"`]+/gi, '$1$2[REDACTED]')
    .replace(/\b(token\s*[:=]\s*)(['"]?)[^\s,'"`]+/gi, '$1$2[REDACTED]');
}

function generateSessionId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${date}-${rand}`;
}
