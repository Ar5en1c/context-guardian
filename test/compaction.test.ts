import { describe, it, expect } from 'vitest';
import { shouldAutoCompact } from '../src/proxy/compaction.js';

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
