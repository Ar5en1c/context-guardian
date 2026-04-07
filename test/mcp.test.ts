import { describe, it, expect } from 'vitest';
import { createMCPServer } from '../src/mcp/server.js';
import type { LocalLLMAdapter } from '../src/local-llm/adapter.js';

const mockLLM: LocalLLMAdapter = {
  name: 'mock',
  isAvailable: async () => true,
  extractIntent: async () => 'Fix the issue',
  classifyChunks: async (chunks) => chunks.map((c) => ({ label: 'other', chunk: c })),
  summarize: async (text) => 'Summary: ' + text.slice(0, 50),
  embed: async (texts) => texts.map(() => [0.1]),
};

describe('MCP server', () => {
  it('handles initialize', async () => {
    const { app } = createMCPServer(mockLLM);
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });

    const data = await res.json();
    expect(data.result.serverInfo.name).toBe('context-guardian');
    expect(data.result.capabilities.tools).toBeDefined();
  });

  it('lists tools', async () => {
    const { app } = createMCPServer(mockLLM);
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });

    const data = await res.json();
    const names = data.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('log_search');
    expect(names).toContain('grep');
    expect(names).toContain('file_read');
    expect(names).toContain('summary');
  });

  it('executes summary tool', async () => {
    const { app, store } = createMCPServer(mockLLM);

    // Index some data first
    store.addBatch(
      [{ text: 'ERROR: auth failed for user admin', label: 'error', metadata: { source: 'test' } }],
      [[0.1]],
    );

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'summary', arguments: { topic: 'errors' } },
      }),
    });

    const data = await res.json();
    expect(data.result.content[0].type).toBe('text');
    expect(data.result.content[0].text.length).toBeGreaterThan(0);
  });

  it('returns error for unknown tool', async () => {
    const { app } = createMCPServer(mockLLM);
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'nonexistent_tool', arguments: {} },
      }),
    });

    const data = await res.json();
    expect(data.error).toBeDefined();
    expect(data.error.message).toContain('Unknown tool');
  });

  it('returns error for unknown method', async () => {
    const { app } = createMCPServer(mockLLM);
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'bogus/method' }),
    });

    const data = await res.json();
    expect(data.error.code).toBe(-32601);
  });
});
