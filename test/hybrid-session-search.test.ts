import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { VectorStore } from '../src/index/store.js';
import { SessionStore } from '../src/index/session-store.js';
import { searchSessionHybrid } from '../src/tools/utils.js';
import type { LocalLLMAdapter } from '../src/local-llm/adapter.js';

const TEST_DB = '/tmp/test-hybrid-session-search.db';

const llm: LocalLLMAdapter = {
  name: 'mock',
  isAvailable: async () => true,
  extractIntent: async () => 'mock',
  classifyChunks: async (chunks) => chunks.map((c) => ({ label: 'other', chunk: c })),
  summarize: async () => 'summary',
  embed: async (texts) =>
    texts.map((t) => (t.includes('semantic-auth') ? [1, 0, 0] : [0, 1, 0])),
};

describe('searchSessionHybrid', () => {
  let store: SessionStore;

  beforeEach(async () => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    store = new SessionStore('hybrid-session', TEST_DB);
    await store.ensureReady();
    store.startSession();
    store.addChunks(
      [
        {
          id: '1',
          text: 'JWT verification timeout while fetching JWKS',
          label: 'error',
          startOffset: 0,
          endOffset: 42,
          metadata: { source: 'auth.log' },
        },
        {
          id: '2',
          text: 'db pool healthy',
          label: 'log',
          startOffset: 43,
          endOffset: 58,
          metadata: { source: 'db.log' },
        },
      ],
      [
        [1, 0, 0],
        [0, 1, 0],
      ],
    );
  });

  afterEach(() => {
    store.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('returns semantic matches even when lexical terms are absent', async () => {
    const results = await searchSessionHybrid(
      { store: new VectorStore(), llm, sessionStore: store, sessionId: 'hybrid-session' },
      'semantic-auth',
      5,
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text.toLowerCase()).toContain('jwt');
  });
});
