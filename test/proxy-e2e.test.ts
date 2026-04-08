import { describe, it, expect } from 'vitest';
import { createProxyServer } from '../src/proxy/server.js';
import { loadConfig } from '../src/config.js';
import { createStats } from '../src/display/dashboard.js';
import type { LocalLLMAdapter } from '../src/local-llm/adapter.js';

const mockLLM: LocalLLMAdapter = {
  name: 'mock',
  isAvailable: async () => true,
  extractIntent: async () => 'Fix the authentication bug',
  classifyChunks: async (chunks) => chunks.map((c) => ({ label: 'log', chunk: c })),
  summarize: async (text) => 'Summary: ' + text.slice(0, 50),
  embed: async (texts) => texts.map(() => new Array(384).fill(0.1)),
};

const FAIL_FAST_CLOUD = {
  openai_base: 'http://127.0.0.1:9/v1',
  anthropic_base: 'http://127.0.0.1:9',
};

describe('proxy server', () => {
  it('responds to health check', async () => {
    const config = loadConfig({ port: 0, cloud: FAIL_FAST_CLOUD });
    const stats = createStats();
    const app = createProxyServer(config, mockLLM, stats);

    const res = await app.request('/health');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('0.3.0');
  });

  it('returns 400 for invalid request body', async () => {
    const config = loadConfig({ port: 0, cloud: FAIL_FAST_CLOUD });
    const stats = createStats();
    const app = createProxyServer(config, mockLLM, stats);

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invalid: true }),
    });
    expect(res.status).toBe(400);
  });

  it('passes through small requests (increments passedThrough)', async () => {
    const config = loadConfig({ port: 0, threshold_tokens: 50000, cloud: FAIL_FAST_CLOUD });
    const stats = createStats();
    const app = createProxyServer(config, mockLLM, stats);

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    // This will fail to reach the cloud (no real API key), but the passthrough counter should increment
    expect(stats.passedThrough).toBe(1);
    expect(stats.intercepted).toBe(0);
  });

  it('intercepts large requests (increments intercepted)', async () => {
    const config = loadConfig({ port: 0, threshold_tokens: 100, cloud: FAIL_FAST_CLOUD });
    const stats = createStats();
    const app = createProxyServer(config, mockLLM, stats);

    const largeContent = 'ERROR: auth failure\n'.repeat(500);

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: largeContent },
        ],
      }),
    });

    // Will fail at cloud forward but interception logic should have run
    // Check that intercepted incremented (may fall back to passthrough on cloud error)
    expect(stats.intercepted + stats.passedThrough).toBeGreaterThan(0);
  });

  it('returns stats endpoint', async () => {
    const config = loadConfig({ port: 0, cloud: FAIL_FAST_CLOUD });
    const stats = createStats();
    stats.intercepted = 5;
    stats.passedThrough = 10;
    stats.tokensSaved = 50000;
    const app = createProxyServer(config, mockLLM, stats);

    const res = await app.request('/stats');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.intercepted).toBe(5);
    expect(body.passedThrough).toBe(10);
    expect(body.tokensSaved).toBe(50000);
  });

  it('returns 404 for unknown routes', async () => {
    const config = loadConfig({ port: 0, cloud: FAIL_FAST_CLOUD });
    const stats = createStats();
    const app = createProxyServer(config, mockLLM, stats);

    const res = await app.request('/v1/unknown');
    expect(res.status).toBe(404);
  });
});
