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

    let regexSource: string;
    let regexFlags = 'gi';
    try {
      const test = new RegExp(pattern, regexFlags);
      regexSource = test.source;
    } catch {
      regexSource = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    const collectMatches = (chunks: Array<{ text: string; source: string }>) => {
      const matches: Array<{ source: string; lineNum: number; match: string; context: string }> = [];
      for (const chunk of chunks) {
        const lines = chunk.text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const lineRegex = new RegExp(regexSource, regexFlags);
          if (lineRegex.test(lines[i])) {
            const start = Math.max(0, i - contextLines);
            const end = Math.min(lines.length - 1, i + contextLines);
            const contextBlock = lines.slice(start, end + 1).map((l, idx) => {
              const lineNo = start + idx;
              const marker = lineNo === i ? '>' : ' ';
              return `${marker} ${lineNo + 1}: ${l}`;
            }).join('\n');

            matches.push({
              source: chunk.source,
              lineNum: i + 1,
              match: lines[i].trim().slice(0, 200),
              context: contextBlock,
            });

            if (matches.length >= limit) break;
          }
        }
        if (matches.length >= limit) break;
      }
      return matches;
    };

    const liveChunks = ctx.store.getAllChunks().map((chunk) => ({
      text: chunk.text,
      source: chunk.metadata.source || 'unknown',
    }));
    let matches = collectMatches(liveChunks);

    // Fallback to persisted session chunks for cross-request memory
    if (matches.length === 0 && ctx.sessionStore) {
      const persistedChunks = ctx.sessionStore.getRecentChunks(400, ctx.sessionId).map((c) => ({
        text: c.text,
        source: c.source || 'session',
      }));
      matches = collectMatches(persistedChunks);
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
