import { describe, it, expect, beforeEach } from 'vitest';
import { VectorStore } from '../src/index/store.js';
import type { Chunk } from '../src/index/chunker.js';
import type { LocalLLMAdapter } from '../src/local-llm/adapter.js';

// Import tool registrations
import '../src/tools/log-search.js';
import '../src/tools/file-read.js';
import '../src/tools/grep.js';
import '../src/tools/summary.js';

import { getTool, getToolDefinitions, toOpenAIToolFormat } from '../src/tools/registry.js';

function makeChunk(id: string, text: string, label: string, source = 'test'): Chunk {
  return { id, text, label, startOffset: 0, endOffset: text.length, metadata: { source, index: '0' } };
}

const mockLLM: LocalLLMAdapter = {
  name: 'mock',
  isAvailable: async () => true,
  extractIntent: async (text) => 'Mock intent for: ' + text.slice(0, 30),
  classifyChunks: async (chunks) => chunks.map((c) => ({ label: 'other', chunk: c })),
  summarize: async (text) => 'Summary: ' + text.slice(0, 100),
  embed: async (texts) => texts.map(() => [0.5, 0.5, 0.5]),
};

describe('tool registry', () => {
  it('has all 4 tools registered', () => {
    expect(getTool('log_search')).toBeDefined();
    expect(getTool('file_read')).toBeDefined();
    expect(getTool('grep')).toBeDefined();
    expect(getTool('summary')).toBeDefined();
  });

  it('generates OpenAI tool format', () => {
    const defs = getToolDefinitions(['log_search', 'grep']);
    const formatted = toOpenAIToolFormat(defs);
    expect(formatted).toHaveLength(2);
    expect((formatted[0] as Record<string, unknown>).type).toBe('function');
  });
});

describe('log_search tool', () => {
  it('finds matching log chunks', async () => {
    const store = new VectorStore();
    store.add(makeChunk('1', 'ERROR: auth failed for user admin', 'log'), []);
    store.add(makeChunk('2', 'INFO: server started on port 3000', 'log'), []);
    store.add(makeChunk('3', 'function authenticate() { }', 'code'), []);

    const tool = getTool('log_search')!;
    const result = await tool.handler({ query: 'auth failed' }, { store, llm: mockLLM });
    expect(result).toContain('auth failed');
  });
});

describe('grep tool', () => {
  it('finds pattern matches with context', async () => {
    const store = new VectorStore();
    const text = 'line 1\nline 2\nERROR: something broke\nline 4\nline 5';
    store.add(makeChunk('1', text, 'log'), []);

    const tool = getTool('grep')!;
    const result = await tool.handler({ pattern: 'ERROR', context_lines: 1 }, { store, llm: mockLLM });
    expect(result).toContain('ERROR: something broke');
    expect(result).toContain('line 2');
    expect(result).toContain('line 4');
  });

  it('returns no matches message for absent pattern', async () => {
    const store = new VectorStore();
    store.add(makeChunk('1', 'all is fine here', 'log'), []);

    const tool = getTool('grep')!;
    const result = await tool.handler({ pattern: 'CRITICAL_FAILURE' }, { store, llm: mockLLM });
    expect(result).toContain('No matches found');
  });
});

describe('summary tool', () => {
  it('summarizes by topic', async () => {
    const store = new VectorStore();
    store.add(makeChunk('1', 'ERROR: connection refused', 'error'), []);
    store.add(makeChunk('2', 'ERROR: timeout waiting for response', 'error'), []);
    store.add(makeChunk('3', 'Config file loaded ok', 'config'), []);

    const tool = getTool('summary')!;
    const result = await tool.handler({ topic: 'errors' }, { store, llm: mockLLM });
    expect(result).toContain('Summary');
    expect(result).toContain('2 chunks');
  });
});
