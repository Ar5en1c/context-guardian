import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { VectorStore } from '../src/index/store.js';
import { SessionStore } from '../src/index/session-store.js';
import { getTool } from '../src/tools/registry.js';
import type { LocalLLMAdapter } from '../src/local-llm/adapter.js';

import '../src/tools/log-search.js';
import '../src/tools/file-read.js';
import '../src/tools/grep.js';
import '../src/tools/summary.js';

const TEST_DB = '/tmp/test-tool-session-fallback.db';

const mockLLM: LocalLLMAdapter = {
  name: 'mock',
  isAvailable: async () => true,
  extractIntent: async () => 'Investigate auth timeout',
  classifyChunks: async (chunks) => chunks.map((c) => ({ label: 'other', chunk: c })),
  summarize: async (text) => `Summary: ${text.slice(0, 50)}`,
  embed: async (texts) => texts.map(() => [0.1]),
};

describe('tool session fallback', () => {
  let sessionStore: SessionStore;

  beforeEach(async () => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    sessionStore = new SessionStore('fallback-session', TEST_DB);
    await sessionStore.ensureReady();
    sessionStore.startSession('Investigate auth timeout');
    sessionStore.addChunks(
      [
        {
          id: '1',
          text: '2026-04-07 ERROR: ETIMEDOUT while fetching JWKS for auth service',
          label: 'error',
          startOffset: 0,
          endOffset: 74,
          metadata: { source: 'auth.log', index: '0' },
        },
        {
          id: '2',
          text: 'export async function validateToken(token: string) { return verify(token); }',
          label: 'code',
          startOffset: 0,
          endOffset: 74,
          metadata: { source: 'src/auth.ts', index: '1' },
        },
      ],
      [[0.1], [0.2]],
    );
  });

  afterEach(() => {
    sessionStore.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('log_search falls back to persisted session chunks', async () => {
    const tool = getTool('log_search')!;
    const result = await tool.handler(
      { query: 'ETIMEDOUT', severity: 'error' },
      { store: new VectorStore(), llm: mockLLM, sessionStore },
    );
    expect(result).toContain('ETIMEDOUT');
    expect(result).toContain('source: session');
  });

  it('grep falls back to persisted session chunks', async () => {
    const tool = getTool('grep')!;
    const result = await tool.handler(
      { pattern: 'validateToken' },
      { store: new VectorStore(), llm: mockLLM, sessionStore },
    );
    expect(result).toContain('validateToken');
  });
});
