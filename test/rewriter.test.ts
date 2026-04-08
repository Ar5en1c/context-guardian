import { describe, it, expect } from 'vitest';
import { VectorStore } from '../src/index/store.js';
import { rewriteRequest } from '../src/proxy/rewriter.js';
import type { LocalLLMAdapter } from '../src/local-llm/adapter.js';
import { SessionStore } from '../src/index/session-store.js';
import { existsSync, unlinkSync } from 'node:fs';

import '../src/tools/log-search.js';
import '../src/tools/file-read.js';
import '../src/tools/grep.js';
import '../src/tools/summary.js';
import '../src/tools/repo-map.js';
import '../src/tools/file-tree.js';
import '../src/tools/symbol-find.js';

const mockLLM: LocalLLMAdapter = {
  name: 'mock-rewriter',
  isAvailable: async () => true,
  extractIntent: async () => 'Fix the auth refresh failure using the provided dump',
  classifyChunks: async (chunks) => chunks.map((chunk) => {
    if (chunk.includes('ERROR') || chunk.includes('Traceback')) return { label: 'error', chunk };
    if (chunk.includes('function ') || chunk.includes('const ')) return { label: 'code', chunk };
    if (/\d{4}-\d{2}-\d{2}/.test(chunk)) return { label: 'log', chunk };
    return { label: 'other', chunk };
  }),
  summarize: async (text) => `Focused brief: ${text.slice(0, 120)}`,
  embed: async (texts) => texts.map(() => new Array(16).fill(0.2)),
};

describe('rewriteRequest', () => {
  it('injects a precise small-agent search plan for noisy mixed context', async () => {
    const store = new VectorStore();
    const rawContent = [
      '[user]',
      'Fix the auth refresh failure and tell me exactly what to inspect.',
      '2026-04-07T12:00:00Z ERROR auth refresh failed for tenant=acme',
      'ETIMEDOUT: JWKS refresh failed after 5000ms',
      'Traceback (most recent call last):',
      '  File "/src/auth/jwt-validator.ts", line 42, in refreshJwt',
      'function refreshJwt(token) { return fetchKeys(token); }',
      'retry_backoff_ms: 200,400,800',
    ].join('\n');

    const result = await rewriteRequest(
      rawContent,
      [{ role: 'user', content: rawContent }],
      mockLLM,
      store,
      ['log_search', 'file_read', 'grep', 'summary'],
      1200,
      { routeMode: 'context_shape', decisionReasons: ['log-heavy context', 'mixed debugging context'] },
    );

    expect(result.messages[0].content).toContain('SMALL-AGENT SEARCH PLAN');
    expect(result.messages[0].content).toContain('ROUTING CONTEXT: The local agent intervened');
    expect(result.messages[0].content).toContain('log_search(');
    expect(result.messages[0].content).toContain('file_read({"query":"/src/auth/jwt-validator.ts"');
    expect(result.messages[0].content).toContain('retry_backoff_ms');
    expect(result.messages[1].content).toContain('Follow the SMALL-AGENT SEARCH PLAN');
    expect(result.messages[1].content).not.toContain("Start with 'summary'");
  });

  it('injects deterministic bootstrap results for broad repo tasks', async () => {
    const dbPath = '/tmp/test-rewriter-bootstrap.db';
    if (existsSync(dbPath)) unlinkSync(dbPath);
    const sessionStore = new SessionStore('bootstrap', dbPath);
    await sessionStore.ensureReady();

    try {
      const sessionId = 'rewriter-bootstrap';
      sessionStore.startSession('Explain auth architecture', sessionId);
      const seededChunks = [
        {
          text: 'src/auth/service.ts\nexport function authenticateUser(input) { return validateSession(input); }',
          label: 'code',
          metadata: { source: 'src/auth/service.ts' },
        },
        {
          text: 'src/auth/middleware.ts\nexport function authMiddleware(req, res, next) { next(); }',
          label: 'code',
          metadata: { source: 'src/auth/middleware.ts' },
        },
        {
          text: 'src/auth/jwt-validator.ts\nexport class JwtValidator { verify(token) { return token; } }',
          label: 'code',
          metadata: { source: 'src/auth/jwt-validator.ts' },
        },
      ];
      sessionStore.addChunks(seededChunks, seededChunks.map(() => new Array(16).fill(0.1)), sessionId);

      const store = new VectorStore();
      const rawContent = 'Analyze the whole codebase and explain the architecture of the auth system.';
      const result = await rewriteRequest(
        rawContent,
        [{ role: 'user', content: rawContent }],
        mockLLM,
        store,
        ['repo_map', 'file_tree', 'symbol_find', 'grep', 'file_read', 'summary'],
        1400,
        { sessionStore, sessionId, routeMode: 'context_shape', decisionReasons: ['repo-wide request'] },
      );

      expect(result.bootstrap.ran).toBe(true);
      expect(result.bootstrap.toolNames).toContain('repo_map');
      expect(result.messages[0].content).toContain('## DETERMINISTIC BOOTSTRAP');
      expect(result.messages[0].content).toContain('repo_map(');
      expect(result.roi.shouldRewrite).toBe(true);
    } finally {
      sessionStore.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
    }
  });
});
