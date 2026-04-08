import { describe, it, expect } from 'vitest';
import { VectorStore } from '../src/index/store.js';
import type { Chunk } from '../src/index/chunker.js';
import type { LocalLLMAdapter } from '../src/local-llm/adapter.js';

// Import tool registrations
import '../src/tools/log-search.js';
import '../src/tools/file-read.js';
import '../src/tools/grep.js';
import '../src/tools/summary.js';
import '../src/tools/repo-map.js';
import '../src/tools/file-tree.js';
import '../src/tools/symbol-find.js';
import '../src/tools/git-diff.js';
import '../src/tools/test-failures.js';
import '../src/tools/run-checks.js';

import { getTool, getToolDefinitions, toOpenAIToolFormat } from '../src/tools/registry.js';
import { resolveCheckCommand } from '../src/tools/run-checks.js';
import { extractFailureLines, resolveTestCommand } from '../src/tools/test-failures.js';

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
  it('has all expected tools registered', () => {
    expect(getTool('log_search')).toBeDefined();
    expect(getTool('file_read')).toBeDefined();
    expect(getTool('grep')).toBeDefined();
    expect(getTool('summary')).toBeDefined();
    expect(getTool('repo_map')).toBeDefined();
    expect(getTool('file_tree')).toBeDefined();
    expect(getTool('symbol_find')).toBeDefined();
    expect(getTool('git_diff')).toBeDefined();
    expect(getTool('test_failures')).toBeDefined();
    expect(getTool('run_checks')).toBeDefined();
    expect(getTool('run_checks')!.definition.mode).toBe('execute');
    expect(getTool('test_failures')!.definition.mode).toBe('execute');
  });

  it('generates OpenAI tool format', () => {
    const defs = getToolDefinitions(['log_search', 'grep']);
    const formatted = toOpenAIToolFormat(defs);
    expect(formatted).toHaveLength(2);
    expect((formatted[0] as Record<string, unknown>).type).toBe('function');
  });
});

describe('repo structure tools', () => {
  it('file_tree returns source tree summary', async () => {
    const store = new VectorStore();
    store.add(makeChunk('1', 'export function login() {}', 'code', 'src/auth/login.ts'), []);
    store.add(makeChunk('2', 'class UserService {}', 'code', 'src/services/user.ts'), []);
    const tool = getTool('file_tree')!;
    const out = await tool.handler({}, { store, llm: mockLLM });
    expect(out).toContain('Tree');
    expect(out).toContain('src/auth/login.ts');
  });

  it('symbol_find extracts symbols from code chunks', async () => {
    const store = new VectorStore();
    store.add(makeChunk('1', 'export function validateToken(token: string) { return token; }', 'code', 'src/auth.ts'), []);
    const tool = getTool('symbol_find')!;
    const out = await tool.handler({ query: 'validateToken' }, { store, llm: mockLLM });
    expect(out).toContain('validateToken');
    expect(out).toContain('[function]');
  });

  it('repo_map returns key files and symbols', async () => {
    const store = new VectorStore();
    store.add(makeChunk('1', 'export class AuthService {}', 'code', 'src/auth/service.ts'), []);
    const tool = getTool('repo_map')!;
    const out = await tool.handler({}, { store, llm: mockLLM });
    expect(out).toContain('Key files');
    expect(out).toContain('Top symbols');
  });
});

describe('git_diff tool', () => {
  it('returns git status section', async () => {
    const store = new VectorStore();
    const tool = getTool('git_diff')!;
    const out = await tool.handler({ scope: 'working', max_chars: 300 }, { store, llm: mockLLM });
    expect(out.toLowerCase()).toContain('git status');
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

describe('run_checks tool', () => {
  it('resolves known safe commands from package scripts', () => {
    const testCmd = resolveCheckCommand('test', process.cwd());
    const lintCmd = resolveCheckCommand('lint', process.cwd());
    expect(testCmd).not.toBeNull();
    expect(lintCmd).not.toBeNull();
  });

  it('falls back to tsc for typecheck when needed', () => {
    const cmd = resolveCheckCommand('typecheck', '/tmp/non-existent-dir');
    expect(cmd).not.toBeNull();
    expect(cmd!.args.join(' ')).toContain('tsc');
  });
});

describe('test_failures helpers', () => {
  it('extracts failure-like lines', () => {
    const lines = extractFailureLines('PASS one\nFAIL two\nAssertionError: bad\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('FAIL');
  });

  it('rejects unsafe override commands', () => {
    expect(resolveTestCommand('rm -rf /')).toBeNull();
    expect(resolveTestCommand('npm run test --silent')).not.toBeNull();
  });
});
