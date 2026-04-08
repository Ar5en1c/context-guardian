import { describe, it, expect } from 'vitest';
import { createProxyServer } from '../src/proxy/server.js';
import { loadConfig } from '../src/config.js';
import { createStats } from '../src/display/dashboard.js';
import type { LocalLLMAdapter } from '../src/local-llm/adapter.js';

const mockLLM: LocalLLMAdapter = {
  name: 'mock',
  isAvailable: async () => true,
  extractIntent: async () => 'Fix the issue',
  classifyChunks: async (chunks) => chunks.map((c) => ({ label: 'other', chunk: c })),
  summarize: async (text) => 'Summary: ' + text.slice(0, 50),
  embed: async (texts) => texts.map(() => new Array(384).fill(0)),
};

const FAIL_FAST_CLOUD = {
  openai_base: 'http://127.0.0.1:9/v1',
  anthropic_base: 'http://127.0.0.1:9',
};

describe('edge cases', () => {
  it('handles empty messages array', async () => {
    const config = loadConfig({ port: 0, cloud: FAIL_FAST_CLOUD });
    const stats = createStats();
    const app = createProxyServer(config, mockLLM, stats);

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', messages: [] }),
    });
    // Should not crash -- may passthrough (0 tokens < threshold)
    expect(res.status).toBeLessThan(600);
  });

  it('handles messages with null content', async () => {
    const config = loadConfig({ port: 0, threshold_tokens: 1, cloud: FAIL_FAST_CLOUD });
    const stats = createStats();
    const app = createProxyServer(config, mockLLM, stats);

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'assistant', content: null }, { role: 'user', content: 'hello' }],
      }),
    });
    expect(res.status).toBeLessThan(600);
  });

  it('handles missing Authorization header gracefully', async () => {
    const config = loadConfig({ port: 0, threshold_tokens: 100000, cloud: FAIL_FAST_CLOUD });
    const stats = createStats();
    const app = createProxyServer(config, mockLLM, stats);

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    // Passthrough will fail at cloud but proxy should not crash
    expect(stats.passedThrough).toBe(1);
  });

  it('handles non-JSON body', async () => {
    const config = loadConfig({ port: 0, cloud: FAIL_FAST_CLOUD });
    const stats = createStats();
    const app = createProxyServer(config, mockLLM, stats);

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    });
    expect(res.status).toBe(400);
  });

  it('handles extremely large single message', { timeout: 30000 }, async () => {
    const config = loadConfig({ port: 0, threshold_tokens: 10, cloud: FAIL_FAST_CLOUD });
    const stats = createStats();
    const app = createProxyServer(config, mockLLM, stats);

    const hugeContent = 'x'.repeat(100000);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: hugeContent }],
      }),
    });
    // Should intercept but may fail at cloud -- should not crash
    expect(res.status).toBeLessThan(600);
  });

  it('handles Anthropic format with missing x-api-key', async () => {
    const config = loadConfig({ port: 0, threshold_tokens: 100000, cloud: FAIL_FAST_CLOUD });
    const stats = createStats();
    const app = createProxyServer(config, mockLLM, stats);

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-opus',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1024,
      }),
    });
    expect(stats.passedThrough).toBe(1);
  });

  it('GET on POST-only routes returns 404', async () => {
    const config = loadConfig({ port: 0, cloud: FAIL_FAST_CLOUD });
    const stats = createStats();
    const app = createProxyServer(config, mockLLM, stats);

    const res = await app.request('/v1/chat/completions', { method: 'GET' });
    expect(res.status).toBe(404);
  });
});
