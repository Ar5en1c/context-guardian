import { registerTool } from './registry.js';
import type { ToolContext } from './registry.js';
import { searchSessionHybrid } from './utils.js';

registerTool({
  definition: {
    name: 'file_read',
    description: 'Read specific portions of indexed file content. Returns exact lines from a file that was included in the original context. Use this to inspect specific code sections.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filename or path pattern to search for' },
        keyword: { type: 'string', description: 'Optional keyword to find within matching files' },
        limit: { type: 'number', description: 'Max chunks to return (default 5)' },
      },
      required: ['query'],
    },
  },

  handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
    const query = String(args.query || '');
    const keyword = String(args.keyword || '');
    const limit = Number(args.limit) || 5;

    // First try: match by source name (file path search)
    const sourceFilter = (chunk: { label: string; metadata: Record<string, string> }) => {
      const source = chunk.metadata.source || '';
      return source.toLowerCase().includes(query.toLowerCase());
    };
    const bySource = ctx.store.searchByKeyword(keyword || '', limit, sourceFilter);
    if (bySource.length > 0) {
      const lines = bySource.map((r, i) => {
        const preview = r.chunk.text.slice(0, 800);
        return `[${i + 1}] (source: ${r.chunk.metadata.source}, lines: ${r.chunk.startOffset}-${r.chunk.endOffset})\n${preview}`;
      });
      return lines.join('\n\n');
    }

    // Second try: source match without keyword filter
    const sourceOnly = ctx.store.getAllChunks().filter(
      (c) => (c.metadata.source || '').toLowerCase().includes(query.toLowerCase())
    );
    if (sourceOnly.length > 0) {
      let limited = keyword
        ? sourceOnly.filter((c) => c.text.toLowerCase().includes(keyword.toLowerCase())).slice(0, limit)
        : sourceOnly.slice(0, limit);
      if (limited.length === 0 && keyword) {
        limited = sourceOnly.slice(0, limit);
      }
      if (limited.length > 0) {
        const lines = limited.map((r, i) => {
          const preview = r.text.slice(0, 800);
          return `[${i + 1}] (source: ${r.metadata.source})\n${preview}`;
        });
        return lines.join('\n\n');
      }
    }

    // Third try: keyword search across all chunks
    const fallback = ctx.store.searchByKeyword(keyword || query, limit);
    if (fallback.length > 0) {
      const lines = fallback.map((r, i) => {
        const preview = r.chunk.text.slice(0, 800);
        return `[${i + 1}] (source: ${r.chunk.metadata.source})\n${preview}`;
      });
      return lines.join('\n\n');
    }

    // Fallback to persisted session chunks for cross-request memory
    if (ctx.sessionStore) {
      const persisted = await searchSessionHybrid(ctx, keyword || query, limit, {
        labelAllowlist: ['code', 'config', 'documentation', 'other', 'output', 'log', 'error'],
      });
      if (persisted.length > 0) {
        const lines = persisted.map((r, i) => {
          const preview = r.text.slice(0, 800);
          return `[${i + 1}] (source: ${r.source})\n${preview}`;
        });
        return lines.join('\n\n');
      }
    }

    return `No file content found matching "${query}"`;
  },
});
