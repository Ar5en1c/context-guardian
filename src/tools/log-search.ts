import { registerTool } from './registry.js';
import type { ToolContext } from './registry.js';
import { searchSessionHybrid } from './utils.js';

registerTool({
  definition: {
    name: 'log_search',
    description: 'Search through indexed log data. Returns matching log lines based on query terms, severity level, or time patterns. Use this instead of reading raw logs.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for log content' },
        severity: {
          type: 'string',
          enum: ['error', 'warn', 'info', 'debug', 'all'],
          description: 'Filter by log severity level',
        },
        limit: { type: 'number', description: 'Max results to return (default 10)' },
      },
      required: ['query'],
    },
  },

  handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
    const query = String(args.query || '');
    const severity = String(args.severity || 'all');
    const limit = Number(args.limit) || 10;

    const filter = (chunk: { label: string; text: string }) => {
      if (chunk.label !== 'log' && chunk.label !== 'error' && chunk.label !== 'output') {
        return false;
      }
      if (severity !== 'all') {
        const lower = chunk.text.toLowerCase();
        if (!lower.includes(severity)) return false;
      }
      return true;
    };

    let results = ctx.store.searchByKeyword(query, limit, filter);

    if (results.length === 0) {
      results = ctx.store.searchByKeyword(query, limit);
    }

    if (results.length > 0) {
      const lines = results.map((r, i) => {
        const preview = r.chunk.text.slice(0, 500);
        return `[${i + 1}] (score: ${r.score.toFixed(2)}, source: ${r.chunk.metadata.source})\n${preview}`;
      });
      return lines.join('\n\n');
    }

    // Fallback to persisted session chunks for cross-request memory
    if (ctx.sessionStore) {
      const persisted = (await searchSessionHybrid(ctx, query, limit, {
        labelAllowlist: ['log', 'error', 'output', 'stacktrace'],
      })).filter((r) => {
        if (severity === 'all') return true;
        return r.text.toLowerCase().includes(severity);
      });
      if (persisted.length > 0) {
        const lines = persisted.map((r, i) => {
          const preview = r.text.slice(0, 500);
          return `[${i + 1}] (score: ${r.score.toFixed(2)}, source: ${r.source})\n${preview}`;
        });
        return lines.join('\n\n');
      }
    }

    return `No log entries found matching "${query}"`;
  },
});
