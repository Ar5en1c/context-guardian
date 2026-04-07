import { registerTool } from './registry.js';
import type { ToolContext } from './registry.js';

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

    const filter = (chunk: { label: string; metadata: Record<string, string> }) => {
      const source = chunk.metadata.source || '';
      return source.toLowerCase().includes(query.toLowerCase()) || chunk.label === 'code';
    };

    const searchTerm = keyword || query;
    const results = ctx.store.searchByKeyword(searchTerm, limit, filter);

    if (results.length === 0) {
      const fallback = ctx.store.searchByKeyword(query, limit);
      if (fallback.length === 0) {
        return `No file content found matching "${query}"`;
      }
      const lines = fallback.map((r, i) => {
        const preview = r.chunk.text.slice(0, 800);
        return `[${i + 1}] (source: ${r.chunk.metadata.source})\n${preview}`;
      });
      return lines.join('\n\n');
    }

    const lines = results.map((r, i) => {
      const preview = r.chunk.text.slice(0, 800);
      return `[${i + 1}] (source: ${r.chunk.metadata.source}, lines: ${r.chunk.startOffset}-${r.chunk.endOffset})\n${preview}`;
    });

    return lines.join('\n\n');
  },
});
