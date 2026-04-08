import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shouldAutoCompact, autoCompact, manualCompact } from '../src/proxy/compaction.js';
import { SessionStore } from '../src/index/session-store.js';
import type { LocalLLMAdapter } from '../src/local-llm/adapter.js';
import { existsSync, unlinkSync } from 'node:fs';

const TEST_DB = '/tmp/test-compaction.db';

const mockLLM: LocalLLMAdapter = {
  name: 'mock',
  isAvailable: async () => true,
  extractIntent: async () => 'Fix memory leak',
  classifyChunks: async (chunks) => chunks.map((c) => ({ label: 'other', chunk: c })),
  summarize: async () => `GOAL: Stabilize auth timeouts
FILES: src/auth.ts, src/config.ts
DECISIONS: add retry with backoff
ERRORS: ETIMEDOUT on JWKS refresh
PENDING: update tests
NEXT: implement retry helper`,
  embed: async (texts) => texts.map(() => [0.1]),
};

describe('compaction', () => {
  it('triggers auto-compact at 80% of budget', () => {
    expect(shouldAutoCompact(9000, { contextBudget: 10000 })).toBe(true);
    expect(shouldAutoCompact(5000, { contextBudget: 10000 })).toBe(false);
  });

  it('accounts for output reserve (2000 tokens)', () => {
    // Budget 10000, reserve 2000 -> effective 8000, threshold 80% -> 6400
    expect(shouldAutoCompact(6500, { contextBudget: 10000 })).toBe(true);
    expect(shouldAutoCompact(6000, { contextBudget: 10000 })).toBe(false);
  });

  it('respects custom threshold', () => {
    expect(shouldAutoCompact(5000, { contextBudget: 10000, autoThreshold: 0.5 })).toBe(true);
    expect(shouldAutoCompact(3000, { contextBudget: 10000, autoThreshold: 0.5 })).toBe(false);
  });

  it('handles edge case of zero budget', () => {
    expect(shouldAutoCompact(100, { contextBudget: 0 })).toBe(true);
  });
});

describe('compaction execution', () => {
  let store: SessionStore;

  beforeEach(async () => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    store = new SessionStore('test-session', TEST_DB);
    await store.ensureReady();
    store.startSession('Fix auth timeout');
  });

  afterEach(() => {
    store.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('autoCompact updates core memory when threshold exceeded', async () => {
    const messages = [
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: 'ERROR: timeout '.repeat(300) },
    ];

    const result = await autoCompact(store, mockLLM, messages, { contextBudget: 2200 });
    expect(result.compacted).toBe(true);

    const mem = store.getCoreMemory();
    expect(mem).not.toBeNull();
    expect(mem!.goal).toContain('Stabilize auth timeouts');
    expect(mem!.compactedAt).toBeDefined();
  });

  it('manualCompact forces compaction from provided source text', async () => {
    const result = await manualCompact(
      store,
      mockLLM,
      '[user] auth timeout and ETIMEDOUT from jwks endpoint',
    );

    expect(result.compacted).toBe(true);
    expect(result.summaryMessage).toContain('COMPACTION BOUNDARY');
    const mem = store.getCoreMemory();
    expect(mem?.nextStep).toContain('implement retry helper');
  });

  it('respects auto-compaction cooldown between consecutive compactions', async () => {
    const messages = [{ role: 'user', content: 'ERROR timeout '.repeat(300) }];
    const first = await autoCompact(store, mockLLM, messages, { contextBudget: 2200 });
    expect(first.compacted).toBe(true);

    const second = await autoCompact(store, mockLLM, messages, { contextBudget: 2200 });
    expect(second.compacted).toBe(false);
  });
});
