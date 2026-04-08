import type { SearchChunk } from '../tools/utils.js';
import { parseSourcePath } from '../tools/utils.js';

export interface FileSummary {
  path: string;
  chunkCount: number;
  lineCount: number;
  labels: Record<string, number>;
}

export interface SymbolInfo {
  name: string;
  type: 'function' | 'class' | 'interface' | 'type' | 'variable';
  source: string;
  line: number;
  signature: string;
}

export function buildFileSummaries(chunks: SearchChunk[]): FileSummary[] {
  const byPath = new Map<string, FileSummary>();
  for (const chunk of chunks) {
    const path = parseSourcePath(chunk.source);
    const existing = byPath.get(path) || {
      path,
      chunkCount: 0,
      lineCount: 0,
      labels: {},
    };
    existing.chunkCount += 1;
    existing.lineCount += chunk.text.split('\n').length;
    existing.labels[chunk.label] = (existing.labels[chunk.label] || 0) + 1;
    byPath.set(path, existing);
  }

  return [...byPath.values()].sort((a, b) => {
    if (b.chunkCount !== a.chunkCount) return b.chunkCount - a.chunkCount;
    return a.path.localeCompare(b.path);
  });
}

export function extractSymbols(chunks: SearchChunk[]): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    if (chunk.label !== 'code' && !mightContainCode(chunk.text)) continue;
    const source = parseSourcePath(chunk.source);
    const lines = chunk.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;

      const matchers: Array<{ type: SymbolInfo['type']; regex: RegExp }> = [
        { type: 'function', regex: /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/ },
        { type: 'class', regex: /^(?:export\s+)?class\s+([A-Za-z_]\w*)\b/ },
        { type: 'interface', regex: /^(?:export\s+)?interface\s+([A-Za-z_]\w*)\b/ },
        { type: 'type', regex: /^(?:export\s+)?type\s+([A-Za-z_]\w*)\b/ },
        { type: 'variable', regex: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*[:=]/ },
      ];

      for (const matcher of matchers) {
        const m = trimmed.match(matcher.regex);
        if (!m?.[1]) continue;
        const name = m[1];
        const key = `${source}:${matcher.type}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        symbols.push({
          name,
          type: matcher.type,
          source,
          line: i + 1,
          signature: trimmed.slice(0, 220),
        });
      }
    }
  }
  return symbols;
}

export function renderTree(paths: string[], maxDepth = 5, maxEntries = 200): string {
  const rows: string[] = [];
  const sorted = [...new Set(paths.map((p) => parseSourcePath(p)))].sort();
  for (const path of sorted.slice(0, maxEntries)) {
    const parts = path.split('/').filter(Boolean).slice(0, maxDepth);
    const indent = '  '.repeat(Math.max(0, parts.length - 1));
    rows.push(`${indent}- ${parts[parts.length - 1] || path}`);
  }
  return rows.join('\n');
}

function mightContainCode(text: string): boolean {
  return /(?:function|class|interface|type|const|let|var|import|export)\s+/m.test(text);
}
