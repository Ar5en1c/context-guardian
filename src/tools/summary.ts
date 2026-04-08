import { registerTool } from './registry.js';
import type { ToolContext } from './registry.js';
import { searchSessionHybrid } from './utils.js';

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
    type SummaryChunk = { text: string; label: string };

    const labelMap: Record<string, string[]> = {
      errors: ['error', 'stacktrace'],
      logs: ['log', 'output'],
      code: ['code'],
      config: ['config'],
      docs: ['documentation'],
      all: ['log', 'code', 'error', 'config', 'documentation', 'stacktrace', 'output', 'data', 'other'],
    };

    const allChunks: SummaryChunk[] = ctx.store.getAllChunks().map((c) => ({
      text: c.text,
      label: c.label,
    }));
    const targetLabels = labelMap[topic] || [topic];
    let matchingChunks = allChunks.filter((c) => targetLabels.includes(c.label));

    if (matchingChunks.length === 0) {
      const words = topic.split(/\s+/).filter(Boolean);
      matchingChunks = allChunks.filter((c) => {
        const lower = c.text.toLowerCase();
        const hits = words.filter((w) => lower.includes(w)).length;
        return hits >= Math.max(1, Math.ceil(words.length * 0.4));
      });
    }

    if (matchingChunks.length === 0 && ctx.sessionStore) {
      const byLabel = targetLabels.flatMap((l) =>
        ctx.sessionStore!.searchByLabel(l, 20, ctx.sessionId).map((r) => ({ text: r.text, label: r.label })),
      );
      const byTopic = await searchSessionHybrid(ctx, topic || 'error', 20);
      const merged = [...byLabel, ...byTopic];
      const dedup = new Set<string>();
      matchingChunks = merged.filter((c) => {
        const key = `${c.label}:${c.text.slice(0, 120)}`;
        if (dedup.has(key)) return false;
        dedup.add(key);
        return true;
      });
    }

    if (matchingChunks.length === 0) {
      const labels = [...new Set(allChunks.map((c) => c.label))];
      return `No content found for "${topic}". Available: ${labels.join(', ')} (${allChunks.length} total chunks)`;
    }

    // Build structured overview
    const lines: string[] = [];
    lines.push(`## ${topic} (${matchingChunks.length} chunks)\n`);

    // Key facts extraction: first lines of each chunk as bullet points
    const keyFacts = matchingChunks.slice(0, 8).map((c) => {
      const firstMeaningfulLine = c.text.split('\n').find((l) => l.trim().length > 10) || c.text.slice(0, 100);
      return `- [${c.label}] ${firstMeaningfulLine.trim().slice(0, 200)}`;
    });
    lines.push('**Key items:**');
    lines.push(...keyFacts);

    // Count sub-patterns
    const errorCount = matchingChunks.filter((c) => c.label === 'error' || c.label === 'stacktrace').length;
    const codeCount = matchingChunks.filter((c) => c.label === 'code').length;
    const logCount = matchingChunks.filter((c) => c.label === 'log').length;

    if (errorCount + codeCount + logCount > 0) {
      lines.push(`\n**Breakdown:** ${errorCount} errors, ${codeCount} code, ${logCount} logs`);
    }

    // If we have few enough chunks, also get LLM summary
    if (matchingChunks.length <= 8) {
      const combined = matchingChunks.map((c) => c.text).join('\n---\n');
      try {
        const summary = await ctx.llm.summarize(`Topic: ${topic}\n\n${combined}`);
        lines.push(`\n**Summary:** ${summary}`);
      } catch {
        // Skip LLM summary if it fails
      }
    }

    return lines.join('\n');
  },
});
