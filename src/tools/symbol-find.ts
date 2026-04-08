import { registerTool } from './registry.js';
import type { ToolContext } from './registry.js';
import { collectSearchChunks } from './utils.js';
import { extractSymbols } from '../index/repo-map.js';

registerTool({
  definition: {
    name: 'symbol_find',
    description: 'Find functions, classes, interfaces, types, and variables across indexed code context.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name or substring to search for' },
        symbol_type: {
          type: 'string',
          enum: ['all', 'function', 'class', 'interface', 'type', 'variable'],
          description: 'Filter by symbol type (default all)',
        },
        limit: { type: 'number', description: 'Max symbols to return (default 25)' },
      },
      required: ['query'],
    },
  },

  handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
    const query = String(args.query || '').trim();
    const symbolType = String(args.symbol_type || 'all');
    const limit = Math.max(1, Number(args.limit) || 25);

    if (!query) return 'Error: query is required';

    const chunks = collectSearchChunks(ctx, { includeSession: true, sessionLimit: 800 });
    const symbols = extractSymbols(chunks);
    const lowerQuery = query.toLowerCase();

    const filtered = symbols.filter((s) => {
      if (symbolType !== 'all' && s.type !== symbolType) return false;
      return s.name.toLowerCase().includes(lowerQuery) || s.signature.toLowerCase().includes(lowerQuery);
    }).slice(0, limit);

    if (filtered.length === 0) {
      return `No symbols found for "${query}"`;
    }

    const rows = filtered.map((s, i) =>
      `${i + 1}. [${s.type}] ${s.name} — ${s.source}:${s.line}\n   ${s.signature}`,
    );

    return [
      `Symbol matches: ${filtered.length}/${symbols.length}`,
      ...rows,
    ].join('\n');
  },
});
