import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from '../src/index/session-store.js';
import { unlinkSync, existsSync } from 'node:fs';

const TEST_DB = '/tmp/test-core-memory.db';

describe('CoreMemory', () => {
  let store: SessionStore;

  beforeEach(async () => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    store = new SessionStore('test-session', TEST_DB);
    await store.ensureReady();
  });

  afterEach(() => {
    store.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('returns null for non-existent core memory', () => {
    const mem = store.getCoreMemory();
    expect(mem).toBeNull();
  });

  it('creates and retrieves core memory', () => {
    store.updateCoreMemory({
      goal: 'Fix auth timeout',
      filesTouched: ['src/auth.ts'],
      decisions: ['Use JWT refresh tokens'],
      errorsFixed: ['ETIMEDOUT on /login'],
      pendingTasks: ['Add retry logic'],
      nextStep: 'Implement retry in auth middleware',
    });

    const mem = store.getCoreMemory();
    expect(mem).not.toBeNull();
    expect(mem!.goal).toBe('Fix auth timeout');
    expect(mem!.filesTouched).toContain('src/auth.ts');
    expect(mem!.decisions).toContain('Use JWT refresh tokens');
    expect(mem!.errorsFixed).toContain('ETIMEDOUT on /login');
    expect(mem!.pendingTasks).toContain('Add retry logic');
    expect(mem!.nextStep).toBe('Implement retry in auth middleware');
  });

  it('merges updates without losing existing data', () => {
    store.updateCoreMemory({
      goal: 'Fix auth',
      filesTouched: ['src/auth.ts'],
      decisions: ['Use JWT'],
    });

    store.updateCoreMemory({
      filesTouched: ['src/middleware.ts'],
      errorsFixed: ['Fixed null check'],
    });

    const mem = store.getCoreMemory();
    expect(mem!.filesTouched).toContain('src/auth.ts');
    expect(mem!.filesTouched).toContain('src/middleware.ts');
    expect(mem!.decisions).toContain('Use JWT');
    expect(mem!.errorsFixed).toContain('Fixed null check');
  });

  it('deduplicates arrays on merge', () => {
    store.updateCoreMemory({ filesTouched: ['a.ts', 'b.ts'] });
    store.updateCoreMemory({ filesTouched: ['b.ts', 'c.ts'] });

    const mem = store.getCoreMemory();
    expect(mem!.filesTouched).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('formats core memory block as text', () => {
    store.updateCoreMemory({
      goal: 'Optimize DB queries',
      filesTouched: ['src/db.ts'],
      nextStep: 'Add index on users.email',
    });

    const block = store.formatCoreMemoryBlock();
    expect(block).toContain('SESSION MEMORY');
    expect(block).toContain('Optimize DB queries');
    expect(block).toContain('src/db.ts');
    expect(block).toContain('Add index on users.email');
  });

  it('returns empty string for no core memory', () => {
    const block = store.formatCoreMemoryBlock();
    expect(block).toBe('');
  });
});

describe('ToolResults cold storage', () => {
  let store: SessionStore;

  beforeEach(async () => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    store = new SessionStore('test-session', TEST_DB);
    await store.ensureReady();
  });

  afterEach(() => {
    store.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('stores and retrieves hot tool results', () => {
    store.addToolResult('grep', 'ETIMEDOUT', 'Found 3 matches in auth.ts', 50);
    store.addToolResult('file_read', 'auth.ts', 'const jwt = require("jsonwebtoken")', 80);

    const hot = store.getHotToolResults(3);
    expect(hot.length).toBe(2);
    expect(hot[0].toolName).toBe('file_read');
    expect(hot[1].toolName).toBe('grep');
  });

  it('freezes old results beyond hot tail', () => {
    for (let i = 0; i < 6; i++) {
      store.addToolResult('grep', `query-${i}`, `result-${i}`, 10);
    }

    store.freezeOldToolResults(3);
    const hot = store.getHotToolResults(10);
    expect(hot.length).toBe(3);
  });

  it('tracks token count of hot results', () => {
    store.addToolResult('grep', 'q1', 'r1', 100);
    store.addToolResult('grep', 'q2', 'r2', 200);

    const tokens = store.getToolResultTokenCount();
    expect(tokens).toBe(300);
  });
});

describe('Entity storage', () => {
  let store: SessionStore;

  beforeEach(async () => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    store = new SessionStore('test-session', TEST_DB);
    await store.ensureReady();
  });

  afterEach(() => {
    store.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('stores and retrieves entities', () => {
    store.addEntities([
      { type: 'file_path', value: '/src/auth.ts' },
      { type: 'error_message', value: 'ETIMEDOUT' },
      { type: 'function_name', value: 'handleLogin' },
    ]);

    const entities = store.getEntities();
    expect(entities.length).toBe(3);
  });

  it('formats entity hints', () => {
    store.addEntities([
      { type: 'file_path', value: '/src/auth.ts' },
      { type: 'error_message', value: 'ETIMEDOUT on /login' },
    ]);

    const hints = store.formatEntityHints();
    expect(hints).toContain('ENTITY HINTS');
    expect(hints).toContain('/src/auth.ts');
    expect(hints).toContain('ETIMEDOUT');
  });

  it('returns empty for no entities', () => {
    expect(store.formatEntityHints()).toBe('');
  });
});
