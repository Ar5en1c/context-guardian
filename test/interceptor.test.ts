import { describe, it, expect } from 'vitest';
import { analyzeRequest, countTokens, extractRawContent } from '../src/proxy/interceptor.js';

describe('countTokens', () => {
  it('returns a positive count for non-empty text', () => {
    const count = countTokens('Hello world, this is a test message.');
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(50);
  });

  it('returns 0 for empty text', () => {
    expect(countTokens('')).toBe(0);
  });

  it('counts a long text proportionally', () => {
    const short = countTokens('Hello');
    const long = countTokens('Hello '.repeat(1000));
    expect(long).toBeGreaterThan(short * 100);
  });
});

describe('analyzeRequest', () => {
  it('does not intercept small requests', () => {
    const messages = [
      { role: 'user', content: 'Fix the bug in auth.ts' },
    ];
    const result = analyzeRequest(messages, 8000);
    expect(result.shouldIntercept).toBe(false);
    expect(result.totalTokens).toBeLessThan(100);
  });

  it('intercepts requests exceeding threshold', () => {
    const largeContent = 'ERROR: something went wrong\n'.repeat(5000);
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: largeContent },
    ];
    const result = analyzeRequest(messages, 8000);
    expect(result.shouldIntercept).toBe(true);
    expect(result.totalTokens).toBeGreaterThan(8000);
    expect(result.largestMessageIndex).toBe(1);
  });

  it('identifies the largest message correctly', () => {
    const messages = [
      { role: 'system', content: 'Short system prompt.' },
      { role: 'user', content: 'A' .repeat(100) },
      { role: 'assistant', content: 'B'.repeat(50000) },
    ];
    const result = analyzeRequest(messages, 100);
    expect(result.largestMessageIndex).toBe(2);
  });
});

describe('extractRawContent', () => {
  it('concatenates all messages with role labels', () => {
    const messages = [
      { role: 'system', content: 'Be helpful.' },
      { role: 'user', content: 'Fix the bug.' },
    ];
    const raw = extractRawContent(messages);
    expect(raw).toContain('[system]');
    expect(raw).toContain('Be helpful.');
    expect(raw).toContain('[user]');
    expect(raw).toContain('Fix the bug.');
  });

  it('handles non-string content', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ];
    const raw = extractRawContent(messages);
    expect(raw).toContain('Hello');
  });
});
