import { describe, it, expect } from 'vitest';
import { VectorStore } from '../src/index/store.js';
import type { Chunk } from '../src/index/chunker.js';

function makeChunk(id: string, text: string, label = 'other'): Chunk {
  return {
    id,
    text,
    label,
    startOffset: 0,
    endOffset: text.length,
    metadata: { source: 'test' },
  };
}

describe('VectorStore', () => {
  it('adds and retrieves chunks', () => {
    const store = new VectorStore();
    const chunk = makeChunk('1', 'Hello world');
    store.add(chunk, [1, 0, 0]);
    expect(store.size).toBe(1);
    expect(store.getAllChunks()).toHaveLength(1);
  });

  it('searches by cosine similarity', () => {
    const store = new VectorStore();
    store.add(makeChunk('1', 'Error in auth'), [1, 0, 0]);
    store.add(makeChunk('2', 'Config file'), [0, 1, 0]);
    store.add(makeChunk('3', 'Auth failure log'), [0.9, 0.1, 0]);

    const results = store.search([1, 0, 0], 2);
    expect(results).toHaveLength(2);
    expect(results[0].chunk.id).toBe('1');
    expect(results[0].score).toBeCloseTo(1.0);
  });

  it('searches by keyword', () => {
    const store = new VectorStore();
    store.add(makeChunk('1', 'ERROR: auth failed at line 42'), []);
    store.add(makeChunk('2', 'Config loaded successfully'), []);
    store.add(makeChunk('3', 'ERROR: database connection timeout'), []);

    const results = store.searchByKeyword('ERROR', 5);
    expect(results).toHaveLength(2);
  });

  it('filters by label', () => {
    const store = new VectorStore();
    store.add(makeChunk('1', 'Log line 1', 'log'), []);
    store.add(makeChunk('2', 'Code block', 'code'), []);
    store.add(makeChunk('3', 'Log line 2', 'log'), []);

    const logs = store.getChunksByLabel('log');
    expect(logs).toHaveLength(2);
  });

  it('clears all entries', () => {
    const store = new VectorStore();
    store.add(makeChunk('1', 'test'), []);
    store.add(makeChunk('2', 'test2'), []);
    expect(store.size).toBe(2);

    store.clear();
    expect(store.size).toBe(0);
  });

  it('addBatch adds multiple entries', () => {
    const store = new VectorStore();
    const chunks = [makeChunk('1', 'a'), makeChunk('2', 'b'), makeChunk('3', 'c')];
    const embeddings = [[1, 0], [0, 1], [0.5, 0.5]];
    store.addBatch(chunks, embeddings);
    expect(store.size).toBe(3);
  });

  it('handles search with filter', () => {
    const store = new VectorStore();
    store.add(makeChunk('1', 'error in auth', 'error'), [1, 0]);
    store.add(makeChunk('2', 'error in db', 'error'), [0.8, 0.2]);
    store.add(makeChunk('3', 'config ok', 'config'), [0, 1]);

    const results = store.search([1, 0], 5, (c) => c.label === 'error');
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.chunk.label === 'error')).toBe(true);
  });
});
