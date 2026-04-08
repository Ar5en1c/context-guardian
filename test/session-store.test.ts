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

  async function createStore(sessionId?: string): Promise<SessionStore> {
    const path = tempDb();
    dbs.push(path);
    const store = new SessionStore(sessionId, path);
    await store.ensureReady();
    return store;
  }

  afterEach(() => {
    for (const p of dbs) {
      try { unlinkSync(p); } catch { /* ok */ }
    }
    dbs.length = 0;
  });

  it('creates a session and stores chunks', async () => {
    const store = await createStore('test-session');
    store.startSession('Fix the auth bug');
    store.addChunks(
      [
        { id: '1', text: 'ERROR: auth timeout at login endpoint', label: 'error', startOffset: 0, endOffset: 36, metadata: { source: 'request' } },
        { id: '2', text: 'import { auth } from "./auth";', label: 'code', startOffset: 37, endOffset: 66, metadata: { source: 'request' } },
      ],
      [[0.1, 0.2], [0.3, 0.4]],
    );

    expect(store.getSessionChunkCount()).toBe(2);
    store.close();
  });

  it('performs keyword search across chunks', async () => {
    const store = await createStore('search-test');
    store.startSession('Debug timeout');
    store.addChunks(
      [
        { id: '1', text: 'Connection timeout after 30 seconds on database pool', label: 'error', startOffset: 0, endOffset: 53, metadata: { source: 'log' } },
        { id: '2', text: 'User login successful for admin', label: 'log', startOffset: 54, endOffset: 85, metadata: { source: 'log' } },
        { id: '3', text: 'function handleTimeout() { retry(); }', label: 'code', startOffset: 86, endOffset: 123, metadata: { source: 'code' } },
      ],
      [[0.1], [0.2], [0.3]],
    );

    const results = store.searchFTS('timeout');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].text.toLowerCase()).toContain('timeout');
    store.close();
  });

  it('searches by label', async () => {
    const store = await createStore('label-test');
    store.startSession();
    store.addChunks(
      [
        { id: '1', text: 'some error log', label: 'error', startOffset: 0, endOffset: 14, metadata: { source: 'request' } },
        { id: '2', text: 'some code', label: 'code', startOffset: 15, endOffset: 24, metadata: { source: 'request' } },
        { id: '3', text: 'another error', label: 'error', startOffset: 25, endOffset: 38, metadata: { source: 'request' } },
      ],
      [[], [], []],
    );

    const errors = store.searchByLabel('error');
    expect(errors.length).toBe(2);
    expect(errors.every((e) => e.label === 'error')).toBe(true);
    store.close();
  });

  it('lists sessions', async () => {
    const store = await createStore('list-test-1');
    store.startSession('First goal');
    store.addChunks([{ id: '1', text: 'chunk1', label: 'other', startOffset: 0, endOffset: 6, metadata: { source: 'req' } }], [[]]);

    const sessions = store.listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions[0].id).toBe('list-test-1');
    store.close();
  });

  it('handles empty search gracefully', async () => {
    const store = await createStore('empty-search');
    store.startSession();
    const results = store.searchFTS('');
    expect(results).toEqual([]);
    store.close();
  });

  it('handles special characters in search', async () => {
    const store = await createStore('special-char-test');
    store.startSession();
    store.addChunks(
      [{ id: '1', text: 'error: can\'t connect to "database"', label: 'error', startOffset: 0, endOffset: 33, metadata: { source: 'log' } }],
      [[]],
    );
    const results = store.searchFTS('database');
    expect(results.length).toBe(1);
    store.close();
  });

  it('supports semantic search over persisted embeddings', async () => {
    const store = await createStore('semantic-search');
    store.startSession();
    store.addChunks(
      [
        {
          id: '1',
          text: 'JWT validation timeout while refreshing JWKS',
          label: 'error',
          startOffset: 0,
          endOffset: 42,
          metadata: { source: 'auth.log' },
        },
        {
          id: '2',
          text: 'Database connection pool healthy',
          label: 'log',
          startOffset: 43,
          endOffset: 74,
          metadata: { source: 'db.log' },
        },
      ],
      [
        [0.9, 0.1, 0.0],
        [0.1, 0.9, 0.0],
      ],
    );

    const results = store.searchByEmbedding([1, 0, 0], 2);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text.toLowerCase()).toContain('jwt');
    store.close();
  });

  it('redacts sensitive tokens before persistence', async () => {
    const store = await createStore('redaction-test');
    store.startSession();
    store.addChunks(
      [{
        id: '1',
        text: 'Authorization: Bearer sk-1234567890abcdefghijklmnop',
        label: 'log',
        startOffset: 0,
        endOffset: 54,
        metadata: { source: 'log' },
      }],
      [[0.1]],
    );

    const results = store.searchFTS('Authorization');
    expect(results[0].text).toContain('[REDACTED_');
    expect(results[0].text).not.toContain('sk-1234567890abcdefghijklmnop');
    store.close();
  });

  it('deduplicates identical chunks per session', async () => {
    const store = await createStore('dedup-test');
    store.startSession();
    const chunk = {
      id: '1',
      text: 'ERROR: duplicate timeout',
      label: 'error',
      startOffset: 0,
      endOffset: 24,
      metadata: { source: 'log' },
    } as const;

    store.addChunks([chunk], [[]]);
    store.addChunks([{ ...chunk, id: '2' }], [[]]);

    expect(store.getSessionChunkCount()).toBe(1);
    store.close();
  });
});
