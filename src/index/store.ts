import type { Chunk } from './chunker.js';

export interface IndexEntry {
  chunk: Chunk;
  embedding: number[];
}

export class VectorStore {
  private entries: IndexEntry[] = [];

  clear() {
    this.entries = [];
  }

  get size() {
    return this.entries.length;
  }

  add(chunk: Chunk, embedding: number[]) {
    this.entries.push({ chunk, embedding });
  }

  addBatch(chunks: Chunk[], embeddings: number[][]) {
    for (let i = 0; i < chunks.length; i++) {
      this.entries.push({
        chunk: chunks[i],
        embedding: embeddings[i] ?? [],
      });
    }
  }

  search(queryEmbedding: number[], topK = 5, filter?: (chunk: Chunk) => boolean): Array<{ chunk: Chunk; score: number }> {
    let candidates = this.entries;
    if (filter) {
      candidates = candidates.filter((e) => filter(e.chunk));
    }

    const scored = candidates.map((entry) => ({
      chunk: entry.chunk,
      score: cosineSimilarity(queryEmbedding, entry.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  searchByKeyword(query: string, topK = 10, filter?: (chunk: Chunk) => boolean): Array<{ chunk: Chunk; score: number }> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    let candidates = this.entries;
    if (filter) {
      candidates = candidates.filter((e) => filter(e.chunk));
    }

    const scored = candidates.map((entry) => {
      const lower = entry.chunk.text.toLowerCase();
      let hits = 0;
      for (const t of terms) {
        if (lower.includes(t)) hits++;
      }
      return { chunk: entry.chunk, score: terms.length > 0 ? hits / terms.length : 0 };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.filter((s) => s.score > 0).slice(0, topK);
  }

  getAllChunks(): Chunk[] {
    return this.entries.map((e) => e.chunk);
  }

  getChunksByLabel(label: string): Chunk[] {
    return this.entries.filter((e) => e.chunk.label === label).map((e) => e.chunk);
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
