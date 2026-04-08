import { registerTool } from './registry.js';
import type { ToolContext } from './registry.js';
import { collectSearchChunks, parseSourcePath } from './utils.js';
import { buildFileSummaries, renderTree } from '../index/repo-map.js';

registerTool({
  definition: {
    name: 'file_tree',
    description: 'Show a compact file tree and file-level coverage from indexed context and persisted session memory.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional path substring filter' },
        limit: { type: 'number', description: 'Max files to show (default 80)' },
      },
      required: [],
    },
  },

  handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
    const filter = String(args.filter || '').toLowerCase();
    const limit = Math.max(1, Number(args.limit) || 80);

    const chunks = collectSearchChunks(ctx, { includeSession: true, sessionLimit: 600 });
    const summaries = buildFileSummaries(chunks);
    const filtered = summaries.filter((f) => !filter || f.path.toLowerCase().includes(filter)).slice(0, limit);

    if (filtered.length === 0) {
      return `No indexed files found${filter ? ` for filter "${filter}"` : ''}.`;
    }

    const tree = renderTree(filtered.map((f) => parseSourcePath(f.path)), 6, limit);
    const top = filtered.slice(0, 20).map((f, idx) => {
      const labels = Object.entries(f.labels)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k}:${v}`)
        .join(', ');
      return `${idx + 1}. ${f.path}  chunks=${f.chunkCount} lines~${f.lineCount}${labels ? ` labels=[${labels}]` : ''}`;
    });

    return [
      `Indexed files: ${filtered.length}/${summaries.length}`,
      '',
      '## Tree',
      tree,
      '',
      '## Top files',
      ...top,
    ].join('\n');
  },
});
