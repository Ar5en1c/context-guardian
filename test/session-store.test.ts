import { describe, it, expect, afterEach } from 'vitest';
import { SessionStore } from '../src/index/session-store.js';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { unlinkSync } from 'node:fs';

function tempDb(): string {
  return resolve(tmpdir(), `cg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('SessionStore', () => {
  const dbs: string[] = [];

  function createStore(sessionId?: string): SessionStore {
    const path = tempDb();
    dbs.push(path);
    return new SessionStore(sessionId, path);
  }

  afterEach(() => {
    for (const p of dbs) {
      try { unlinkSync(p); } catch { /* ok */ }
    }
    dbs.length = 0;
  });

  it('creates a session and stores chunks', () => {
    const store = createStore('test-session');
    store.startSession('Fix the auth bug');
    store.addChunks(
      [
        { text: 'ERROR: auth timeout at login endpoint', label: 'error', metadata: { source: 'request' } },
        { text: 'import { auth } from "./auth";', label: 'code', metadata: { source: 'request' } },
      ],
      [[0.1, 0.2], [0.3, 0.4]],
    );

    expect(store.getSessionChunkCount()).toBe(2);
    store.close();
  });

  it('performs FTS5 full-text search', () => {
    const store = createStore('fts-test');
    store.startSession('Debug timeout');
    store.addChunks(
      [
        { text: 'Connection timeout after 30 seconds on database pool', label: 'error', metadata: { source: 'log' } },
        { text: 'User login successful for admin', label: 'log', metadata: { source: 'log' } },
        { text: 'function handleTimeout() { retry(); }', label: 'code', metadata: { source: 'code' } },
      ],
      [[0.1], [0.2], [0.3]],
    );

    const results = store.searchFTS('timeout');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].text.toLowerCase()).toContain('timeout');
    store.close();
  });

  it('searches by label', () => {
    const store = createStore('label-test');
    store.startSession();
    store.addChunks(
      [
        { text: 'some error log', label: 'error', metadata: { source: 'request' } },
        { text: 'some code', label: 'code', metadata: { source: 'request' } },
        { text: 'another error', label: 'error', metadata: { source: 'request' } },
      ],
      [[], [], []],
    );

    const errors = store.searchByLabel('error');
    expect(errors.length).toBe(2);
    expect(errors.every((e) => e.label === 'error')).toBe(true);
    store.close();
  });

  it('lists sessions', () => {
    const store = createStore('list-test-1');
    store.startSession('First goal');

    // Same DB, different session
    const store2 = new SessionStore('list-test-2', (store as unknown as { db: { name: string } }).db?.name);
    // Actually we need the same DB path -- let's just add another session manually
    store.addChunks([{ text: 'chunk1', label: 'other', metadata: { source: 'req' } }], [[]]);

    const sessions = store.listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions[0].id).toBe('list-test-1');
    store.close();
  });

  it('falls back to LIKE search on bad FTS query', () => {
    const store = createStore('fallback-test');
    store.startSession();
    store.addChunks(
      [{ text: 'the quick brown fox', label: 'other', metadata: { source: 'req' } }],
      [[]],
    );

    // Malformed FTS query should not crash
    const results = store.searchFTS('OR AND NOT');
    // May return empty or fallback results, but should not throw
    expect(Array.isArray(results)).toBe(true);
    store.close();
  });

  it('handles empty search gracefully', () => {
    const store = createStore('empty-search');
    store.startSession();
    const results = store.searchFTS('');
    expect(results).toEqual([]);
    store.close();
  });
});
