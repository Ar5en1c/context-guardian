export interface Chunk {
  id: string;
  text: string;
  label: string;
  startOffset: number;
  endOffset: number;
  metadata: Record<string, string>;
}

const DEFAULT_CHUNK_SIZE = 1500;
const DEFAULT_OVERLAP = 200;

export function chunkText(
  text: string,
  opts: { chunkSize?: number; overlap?: number; source?: string } = {},
): Chunk[] {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;
  const source = opts.source ?? 'unknown';
  const chunks: Chunk[] = [];

  const separators = ['\n\n', '\n', '. ', ' '];

  function split(text: string, sepIdx: number): string[] {
    if (sepIdx >= separators.length) {
      const parts: string[] = [];
      for (let i = 0; i < text.length; i += chunkSize) {
        parts.push(text.slice(i, i + chunkSize));
      }
      return parts;
    }

    const sep = separators[sepIdx];
    const segments = text.split(sep);
    const merged: string[] = [];
    let current = '';

    for (const seg of segments) {
      const candidate = current ? current + sep + seg : seg;
      if (candidate.length > chunkSize && current) {
        merged.push(current);
        current = seg;
      } else {
        current = candidate;
      }
    }
    if (current) merged.push(current);

    const result: string[] = [];
    for (const m of merged) {
      if (m.length > chunkSize) {
        result.push(...split(m, sepIdx + 1));
      } else {
        result.push(m);
      }
    }
    return result;
  }

  const parts = split(text, 0);
  let offset = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const start = text.indexOf(part, offset);
    const actualStart = start >= 0 ? start : offset;

    let chunkText = part;
    if (i > 0 && overlap > 0) {
      const prevEnd = actualStart;
      const overlapStart = Math.max(0, prevEnd - overlap);
      const overlapText = text.slice(overlapStart, prevEnd);
      chunkText = overlapText + part;
    }

    chunks.push({
      id: `${source}:${i}`,
      text: chunkText,
      label: 'other',
      startOffset: actualStart,
      endOffset: actualStart + part.length,
      metadata: { source, index: String(i) },
    });

    offset = actualStart + part.length;
  }

  return chunks;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
