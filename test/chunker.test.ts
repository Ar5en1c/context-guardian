import { describe, it, expect } from 'vitest';
import { chunkText, estimateTokens } from '../src/index/chunker.js';

describe('chunkText', () => {
  it('returns a single chunk for small text', () => {
    const chunks = chunkText('Hello world', { chunkSize: 1500 });
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain('Hello world');
    expect(chunks[0].id).toBe('unknown:0');
  });

  it('splits large text into multiple chunks', () => {
    const text = 'Line of text number N.\n'.repeat(500);
    const chunks = chunkText(text, { chunkSize: 500 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('preserves source metadata', () => {
    const chunks = chunkText('Test content', { source: 'myfile.ts' });
    expect(chunks[0].metadata.source).toBe('myfile.ts');
    expect(chunks[0].id).toBe('myfile.ts:0');
  });

  it('splits on paragraph boundaries first', () => {
    const text = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
    const chunks = chunkText(text, { chunkSize: 30, overlap: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('sets default label to other', () => {
    const chunks = chunkText('Some text');
    expect(chunks[0].label).toBe('other');
  });
});

describe('estimateTokens', () => {
  it('estimates roughly 1 token per 3.5 chars', () => {
    const text = 'A'.repeat(350);
    const estimate = estimateTokens(text);
    expect(estimate).toBe(100);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});
