import { registerTool } from './registry.js';
import type { ToolContext } from './registry.js';

registerTool({
  definition: {
    name: 'grep',
    description: 'Search for a regex or literal pattern across all indexed content. Returns matching lines with surrounding context. Use this for precise pattern matching.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex or literal string pattern to search for' },
        context_lines: { type: 'number', description: 'Lines of surrounding context (default 2)' },
        limit: { type: 'number', description: 'Max matches to return (default 15)' },
      },
      required: ['pattern'],
    },
  },

  handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
    const pattern = String(args.pattern || '');
    const contextLines = Number(args.context_lines) || 2;
    const limit = Number(args.limit) || 15;

    if (!pattern) return 'Error: pattern is required';

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'gi');
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    }

    const allChunks = ctx.store.getAllChunks();
    const matches: Array<{ source: string; lineNum: number; match: string; context: string }> = [];

    for (const chunk of allChunks) {
      const lines = chunk.text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          regex.lastIndex = 0;
          const start = Math.max(0, i - contextLines);
          const end = Math.min(lines.length - 1, i + contextLines);
          const contextBlock = lines.slice(start, end + 1).map((l, idx) => {
            const lineNo = start + idx;
            const marker = lineNo === i ? '>' : ' ';
            return `${marker} ${lineNo + 1}: ${l}`;
          }).join('\n');

          matches.push({
            source: chunk.metadata.source || 'unknown',
            lineNum: i + 1,
            match: lines[i].trim().slice(0, 200),
            context: contextBlock,
          });

          if (matches.length >= limit) break;
        }
      }
      if (matches.length >= limit) break;
    }

    if (matches.length === 0) {
      return `No matches found for pattern "${pattern}"`;
    }

    const out = matches.map((m, i) =>
      `[${i + 1}] ${m.source}:${m.lineNum}\n${m.context}`
    );

    return out.join('\n\n');
  },
});
