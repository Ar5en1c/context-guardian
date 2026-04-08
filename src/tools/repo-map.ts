import { registerTool } from './registry.js';
import type { ToolContext } from './registry.js';
import { collectSearchChunks } from './utils.js';
import { buildFileSummaries, extractSymbols } from '../index/repo-map.js';

registerTool({
  definition: {
    name: 'repo_map',
    description: 'Build a compact structural map of indexed repository context: key files and top symbols.',
    parameters: {
      type: 'object',
      properties: {
        limit_files: { type: 'number', description: 'Max files to include (default 30)' },
        limit_symbols: { type: 'number', description: 'Max symbols to include (default 40)' },
      },
      required: [],
    },
  },

  handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
    const limitFiles = Math.max(1, Number(args.limit_files) || 30);
    const limitSymbols = Math.max(1, Number(args.limit_symbols) || 40);
    const chunks = collectSearchChunks(ctx, { includeSession: true, sessionLimit: 1000 });

    if (chunks.length === 0) return 'No indexed content available to build repo map.';

    const files = buildFileSummaries(chunks).slice(0, limitFiles);
    const symbols = extractSymbols(chunks).slice(0, limitSymbols);

    const fileRows = files.map((f, i) => `${i + 1}. ${f.path} (chunks=${f.chunkCount}, lines~${f.lineCount})`);
    const symbolRows = symbols.map((s, i) => `${i + 1}. [${s.type}] ${s.name} — ${s.source}:${s.line}`);

    return [
      `Repo map from ${chunks.length} chunks`,
      '',
      '## Key files',
      ...fileRows,
      '',
      '## Top symbols',
      ...(symbolRows.length > 0 ? symbolRows : ['(none detected)']),
    ].join('\n');
  },
});
