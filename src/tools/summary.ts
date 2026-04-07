import { registerTool } from './registry.js';
import type { ToolContext } from './registry.js';

registerTool({
  definition: {
    name: 'summary',
    description: 'Get a pre-digested summary of indexed content by topic or category. Use this to understand the overall context before diving into specifics.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic or category to summarize (e.g., "errors", "config", "logs")' },
      },
      required: ['topic'],
    },
  },

  handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
    const topic = String(args.topic || '').toLowerCase();

    const labelMap: Record<string, string[]> = {
      errors: ['error', 'stacktrace'],
      logs: ['log', 'output'],
      code: ['code'],
      config: ['config'],
      docs: ['documentation'],
      all: ['log', 'code', 'error', 'config', 'documentation', 'stacktrace', 'output', 'data', 'other'],
    };

    const targetLabels = labelMap[topic] || [topic];
    const matchingChunks = ctx.store.getAllChunks().filter((c) => targetLabels.includes(c.label));

    if (matchingChunks.length === 0) {
      const allChunks = ctx.store.getAllChunks();
      const keywordMatches = allChunks.filter((c) => c.text.toLowerCase().includes(topic));

      if (keywordMatches.length === 0) {
        return `No content found related to "${topic}". Available categories: ${getAvailableCategories(ctx)}`;
      }

      const combined = keywordMatches.slice(0, 5).map((c) => c.text).join('\n---\n');
      return await ctx.llm.summarize(`Topic: ${topic}\n\n${combined}`);
    }

    const combined = matchingChunks.slice(0, 8).map((c) => c.text).join('\n---\n');
    const summary = await ctx.llm.summarize(`Topic: ${topic}\n\n${combined}`);

    return `Summary of "${topic}" (${matchingChunks.length} chunks indexed):\n\n${summary}`;
  },
});

function getAvailableCategories(ctx: ToolContext): string {
  const chunks = ctx.store.getAllChunks();
  const labels = new Set(chunks.map((c) => c.label));
  return Array.from(labels).join(', ') || 'none';
}
