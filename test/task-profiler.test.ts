import { describe, it, expect } from 'vitest';
import { chunkText } from '../src/index/chunker.js';
import { extractEntities } from '../src/index/entity-extractor.js';
import { detectPromptScopeSignals, formatTaskProfileBlock, profileTask } from '../src/proxy/task-profiler.js';

describe('detectPromptScopeSignals', () => {
  it('identifies broad repo requests', () => {
    const signals = detectPromptScopeSignals('Analyze the whole codebase and explain the architecture of the auth system.');
    expect(signals.broadScopePrompt).toBe(true);
    expect(signals.repoWideRequest).toBe(true);
  });

  it('keeps surgical prompts out of broad-scope mode', () => {
    const signals = detectPromptScopeSignals('Fix the retry bug in src/auth/token.ts.');
    expect(signals.broadScopePrompt).toBe(false);
  });
});

describe('profileTask', () => {
  it('marks repo-wide prompts with thin corpus as bootstrap-needed', () => {
    const goal = 'Analyze the whole codebase and explain the architecture of the auth system.';
    const content = goal;
    const profile = profileTask({
      goal,
      rawContent: content,
      chunks: chunkText(content, { source: 'request' }),
      entities: extractEntities(content),
      enabledTools: ['repo_map', 'file_tree', 'symbol_find', 'grep', 'file_read', 'summary'],
      priorSessionChunkCount: 0,
    });

    expect(profile.scopeClass).toBe('repo_wide');
    expect(profile.bootstrapNeeded).toBe(true);
    expect(profile.preferredEntryTools.slice(0, 3)).toEqual(['repo_map', 'file_tree', 'symbol_find']);
    expect(profile.estimatedToolCalls.max).toBeGreaterThanOrEqual(15);
  });

  it('treats noisy debugging bundles as focused investigations', () => {
    const goal = 'Investigate the auth timeout and fix the root cause.';
    const content = [
      goal,
      '2026-04-07T10:00:00Z ERROR auth timeout ETIMEDOUT refreshing JWKS',
      '2026-04-07T10:00:01Z WARN circuit breaker OPEN',
      'function refreshJwt() { return fetchKeys(); }',
      '/src/auth/jwt-validator.ts',
    ].join('\n');

    const profile = profileTask({
      goal,
      rawContent: content,
      chunks: chunkText(content, { source: 'request' }),
      entities: extractEntities(content),
      enabledTools: ['log_search', 'grep', 'file_read', 'summary'],
      priorSessionChunkCount: 0,
    });

    expect(profile.scopeClass).toBe('focused_investigation');
    expect(profile.bootstrapNeeded).toBe(false);
    expect(profile.preferredEntryTools[0]).toBe('log_search');
    expect(profile.focusTerms).toContain('auth');
  });

  it('predicts wide refactor work for migration prompts', () => {
    const goal = 'Migrate auth v1 to v2 across the repo and rename all old middleware references.';
    const profile = profileTask({
      goal,
      rawContent: goal,
      chunks: chunkText(goal, { source: 'request' }),
      entities: extractEntities(goal),
      enabledTools: ['repo_map', 'symbol_find', 'grep', 'file_read', 'git_diff', 'summary'],
      priorSessionChunkCount: 18,
    });

    expect(profile.intentType).toBe('migration');
    expect(profile.scopeClass).toBe('wide_refactor');
    expect(profile.executionLikely).toBe(true);
    expect(profile.bootstrapNeeded).toBe(false);
  });

  it('formats a profile block for prompt injection', () => {
    const goal = 'Analyze the whole codebase and explain the architecture.';
    const profile = profileTask({
      goal,
      rawContent: goal,
      chunks: chunkText(goal, { source: 'request' }),
      entities: extractEntities(goal),
      enabledTools: ['repo_map', 'file_tree', 'symbol_find', 'summary'],
      priorSessionChunkCount: 12,
    });

    const block = formatTaskProfileBlock(profile);
    expect(block).toContain('## TASK PROFILE');
    expect(block).toContain('Scope: repo_wide');
    expect(block).toContain('Expected tool budget');
    expect(block).toContain('Phase plan:');
  });
});
