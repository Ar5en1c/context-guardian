import type { ToolContext } from './registry.js';

export interface SearchChunk {
  text: string;
  label: string;
  source: string;
}

export function collectSearchChunks(
  ctx: ToolContext,
  options: { includeSession?: boolean; sessionLimit?: number } = {},
): SearchChunk[] {
  const includeSession = options.includeSession ?? true;
  const sessionLimit = options.sessionLimit ?? 400;

  const live = ctx.store.getAllChunks().map((c) => ({
    text: c.text,
    label: c.label,
    source: c.metadata.source || 'live',
  }));

  const merged: SearchChunk[] = [...live];
  if (includeSession && ctx.sessionStore) {
    const persisted = ctx.sessionStore.getRecentChunks(sessionLimit, ctx.sessionId).map((c) => ({
      text: c.text,
      label: c.label,
      source: c.source || 'session',
    }));
    merged.push(...persisted);
  }

  const seen = new Set<string>();
  const deduped: SearchChunk[] = [];
  for (const chunk of merged) {
    const key = `${chunk.source}:${chunk.text.slice(0, 220)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(chunk);
  }
  return deduped;
}

export function parseSourcePath(source: string): string {
  const cleaned = source.trim().replace(/\\/g, '/');
  if (!cleaned) return 'unknown';
  return cleaned.replace(/^\.?\//, '');
}

export function scoreTextMatch(query: string, text: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const t of terms) {
    if (lower.includes(t)) hits++;
  }
  return hits / terms.length;
}

export async function searchSessionHybrid(
  ctx: ToolContext,
  query: string,
  limit = 10,
  options: { labelAllowlist?: string[] } = {},
): Promise<Array<{ text: string; label: string; source: string; score: number }>> {
  if (!ctx.sessionStore) return [];

  const lexical = ctx.sessionStore.searchLike(query, Math.max(limit * 3, 30), ctx.sessionId);
  const merged = new Map<string, { text: string; label: string; source: string; score: number }>();

  for (const row of lexical) {
    const key = `${row.label}:${row.text.slice(0, 220)}`;
    merged.set(key, {
      text: row.text,
      label: row.label,
      source: 'session',
      score: row.score,
    });
  }

  try {
    const embedding = (await ctx.llm.embed([query]))[0] || [];
    if (embedding.length > 0) {
      const semantic = ctx.sessionStore.searchByEmbedding(embedding, Math.max(limit * 3, 30), ctx.sessionId);
      for (const row of semantic) {
        const key = `${row.label}:${row.text.slice(0, 220)}`;
        const prev = merged.get(key);
        const blended = row.score * 0.7 + scoreTextMatch(query, row.text) * 0.3;
        if (!prev || blended > prev.score) {
          merged.set(key, {
            text: row.text,
            label: row.label,
            source: row.source,
            score: blended,
          });
        }
      }
    }
  } catch {
    // Keep lexical-only results
  }

  let rows = [...merged.values()];
  if (options.labelAllowlist && options.labelAllowlist.length > 0) {
    const allow = new Set(options.labelAllowlist);
    rows = rows.filter((r) => allow.has(r.label));
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, limit);
}
