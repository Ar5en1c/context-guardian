import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createProxyServer } from '../src/proxy/server.js';
import { loadConfig } from '../src/config.js';
import { createStats } from '../src/display/dashboard.js';
import type { LocalLLMAdapter } from '../src/local-llm/adapter.js';

// Mock cloud server that simulates OpenAI API responses
function createMockCloudServer() {
  const app = new Hono();
  const calls: Array<{ body: unknown; timestamp: number }> = [];

  app.post('/chat/completions', async (c) => {
    const body = await c.req.json();
    calls.push({ body, timestamp: Date.now() });

    const messages = (body as { messages: Array<{ role: string; content: unknown }> }).messages;
    const tools = (body as { tools?: unknown[] }).tools;
    const lastUser = messages.filter((m: { role: string }) => m.role === 'user').pop();
    const content = typeof lastUser?.content === 'string' ? lastUser.content : '';

    // If tools are provided and this is an intercepted request, simulate a tool call
    if (tools && Array.isArray(tools) && tools.length > 0 && content.includes('OBJECTIVE:')) {
      return c.json({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: 'mock-model',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_mock_1',
              type: 'function',
              function: { name: 'summary', arguments: JSON.stringify({ topic: 'all' }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      });
    }

    // Normal response (or after tool results)
    return c.json({
      id: 'chatcmpl-mock-final',
      object: 'chat.completion',
      model: 'mock-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: `Processed: ${content.slice(0, 50)}` },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
  });

  app.get('/models', (c) => {
    return c.json({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] });
  });

  return { app, calls };
}

// Mock local LLM that is deterministic and fast
const mockLLM: LocalLLMAdapter = {
  name: 'mock-integration',
  isAvailable: async () => true,
  extractIntent: async (text) => {
    if (text.includes('auth')) return 'Fix the authentication failure in the login endpoint';
    if (text.includes('database')) return 'Resolve database connection timeout';
    return 'Investigate and fix the reported issue';
  },
  classifyChunks: async (chunks) => chunks.map((c) => {
    const lower = c.toLowerCase();
    if (lower.includes('error') || lower.includes('fatal')) return { label: 'error', chunk: c };
    if (lower.includes('import ') || lower.includes('function ')) return { label: 'code', chunk: c };
    if (/\d{4}-\d{2}-\d{2}/.test(c)) return { label: 'log', chunk: c };
    return { label: 'other', chunk: c };
  }),
  summarize: async (text) => `Summary of ${text.length} chars: ${text.slice(0, 100)}`,
  embed: async (texts) => texts.map(() => new Array(384).fill(0.1)),
};

describe('integration: proxy + mock cloud server', () => {
  let mockCloud: ReturnType<typeof createMockCloudServer>;
  let mockCloudServer: ReturnType<typeof serve>;
  const MOCK_CLOUD_PORT = 19876;
  const PROXY_PORT = 19877;

  beforeAll(async () => {
    mockCloud = createMockCloudServer();
    mockCloudServer = serve({ fetch: mockCloud.app.fetch, port: MOCK_CLOUD_PORT });
    // Wait for server to start
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterAll(() => {
    mockCloudServer?.close?.();
  });

  it('passes through small requests to cloud unchanged', async () => {
    const config = loadConfig({
      port: PROXY_PORT,
      threshold_tokens: 50000,
      cloud: { openai_base: `http://localhost:${MOCK_CLOUD_PORT}`, anthropic_base: '' },
    });
    const stats = createStats();
    const proxy = createProxyServer(config, mockLLM, stats);

    const res = await proxy.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test' },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hello world' }],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.choices[0].message.content).toContain('Processed');
    expect(stats.passedThrough).toBe(1);
    expect(stats.intercepted).toBe(0);
  });

  it('intercepts large requests, rewrites, and gets response via tool loop', async () => {
    const callsBefore = mockCloud.calls.length;
    const config = loadConfig({
      port: PROXY_PORT,
      threshold_tokens: 100,
      cloud: { openai_base: `http://localhost:${MOCK_CLOUD_PORT}`, anthropic_base: '' },
    });
    const stats = createStats();
    const proxy = createProxyServer(config, mockLLM, stats);

    const largeContent = [
      'ERROR: auth failed for user admin at 2026-04-07T10:00:00Z',
      'ERROR: auth failed for user bob at 2026-04-07T10:01:00Z',
      'import { authenticate } from "./auth";\nfunction login(user, pass) { return authenticate(user, pass); }',
    ].join('\n').repeat(20);

    const res = await proxy.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test' },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [
          { role: 'system', content: 'You are a coding assistant.' },
          { role: 'user', content: largeContent },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(stats.intercepted).toBe(1);
    expect(stats.tokensSaved).toBeGreaterThan(0);
    expect(stats.lastIntercept).toBeDefined();
    expect(stats.lastIntercept!.goal).toContain('auth');

    // Cloud should have received calls for this test
    const newCalls = mockCloud.calls.slice(callsBefore);
    expect(newCalls.length).toBeGreaterThanOrEqual(2);

    // First call for THIS test should have tools injected
    const firstCall = newCalls[0].body as { tools?: unknown[]; messages?: unknown[] };
    expect(firstCall.tools).toBeDefined();
    expect(firstCall.tools!.length).toBeGreaterThan(0);
  });

  it('synthesizes SSE stream for intercepted streaming requests', async () => {
    const config = loadConfig({
      port: PROXY_PORT,
      threshold_tokens: 50,
      cloud: { openai_base: `http://localhost:${MOCK_CLOUD_PORT}`, anthropic_base: '' },
    });
    const stats = createStats();
    const proxy = createProxyServer(config, mockLLM, stats);

    const res = await proxy.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test' },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Fix the auth bug. '.repeat(50) }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const text = await res.text();
    expect(text).toContain('data: ');
    expect(text).toContain('[DONE]');
    expect(text).toContain('chat.completion.chunk');
    expect(stats.intercepted).toBe(1);
  });

  it('reports timing in stats after interception', async () => {
    const config = loadConfig({
      port: PROXY_PORT,
      threshold_tokens: 50,
      cloud: { openai_base: `http://localhost:${MOCK_CLOUD_PORT}`, anthropic_base: '' },
    });
    const stats = createStats();
    const proxy = createProxyServer(config, mockLLM, stats);

    await proxy.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test' },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Debug this error log:\n' + 'ERROR: timeout\n'.repeat(100) }],
      }),
    });

    expect(stats.lastIntercept).toBeDefined();
    expect(stats.lastIntercept!.inTokens).toBeGreaterThan(50);
    expect(stats.lastIntercept!.outTokens).toBeLessThan(stats.lastIntercept!.inTokens);
  });
});
