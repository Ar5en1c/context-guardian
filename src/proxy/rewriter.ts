import type { LocalLLMAdapter } from '../local-llm/adapter.js';
import type { VectorStore } from '../index/store.js';
import { chunkText } from '../index/chunker.js';
import { getToolDefinitions, toOpenAIToolFormat } from '../tools/registry.js';
import { log } from '../display/logger.js';
import { countTokens } from './interceptor.js';

export interface RewriteResult {
  messages: Array<{ role: string; content: string }>;
  tools: unknown[];
  goal: string;
  chunksIndexed: number;
  inputTokens: number;
  outputTokens: number;
  toolNames: string[];
}

export async function rewriteRequest(
  rawContent: string,
  originalMessages: Array<{ role: string; content: unknown }>,
  llm: LocalLLMAdapter,
  store: VectorStore,
  enabledTools: string[],
  contextBudget: number,
): Promise<RewriteResult> {
  const inputTokens = countTokens(rawContent);

  log('intercept', `Extracting intent from ${inputTokens} tokens...`);
  const goal = await llm.extractIntent(rawContent);
  log('intercept', `Goal: "${goal}"`);

  log('intercept', 'Chunking and indexing content...');
  store.clear();
  const chunks = chunkText(rawContent, { source: 'request' });

  const classified = await llm.classifyChunks(chunks.map((c) => c.text));
  for (let i = 0; i < chunks.length; i++) {
    if (classified[i]) {
      chunks[i].label = classified[i].label;
    }
  }

  let embeddings: number[][] = [];
  try {
    embeddings = await llm.embed(chunks.map((c) => c.text));
  } catch {
    embeddings = chunks.map(() => []);
  }
  store.addBatch(chunks, embeddings);

  log('intercept', `Indexed ${chunks.length} chunks. Labels: ${summarizeLabels(chunks.map((c) => c.label))}`);

  const systemPrompt = buildSystemPrompt(goal, chunks, enabledTools);
  const userPrompt = buildUserPrompt(goal, chunks);

  const toolDefs = getToolDefinitions(enabledTools);
  const openaiTools = toOpenAIToolFormat(toolDefs);

  const rewrittenMessages: Array<{ role: string; content: string }> = [];

  const origSystem = originalMessages.find((m) => m.role === 'system');
  if (origSystem) {
    const origContent = typeof origSystem.content === 'string' ? origSystem.content : '';
    rewrittenMessages.push({
      role: 'system',
      content: origContent + '\n\n' + systemPrompt,
    });
  } else {
    rewrittenMessages.push({ role: 'system', content: systemPrompt });
  }

  rewrittenMessages.push({ role: 'user', content: userPrompt });

  const outputTokens = countTokens(rewrittenMessages.map((m) => m.content).join('\n'));

  log('intercept', `Rewritten: ${inputTokens} -> ${outputTokens} tokens (${Math.round((1 - outputTokens / inputTokens) * 100)}% reduction)`);

  return {
    messages: rewrittenMessages,
    tools: openaiTools,
    goal,
    chunksIndexed: chunks.length,
    inputTokens,
    outputTokens,
    toolNames: enabledTools,
  };
}

function buildSystemPrompt(
  goal: string,
  chunks: Array<{ label: string }>,
  enabledTools: string[],
): string {
  const labels = summarizeLabels(chunks.map((c) => c.label));

  return `CONTEXT GUARDIAN INSTRUCTIONS:
You are working on the following objective: ${goal}

The original request contained a large amount of raw data that has been indexed locally.
DO NOT ask the user to provide the data again. Instead, use the available tools to retrieve specific information on-demand.

Available indexed content: ${labels}
Total chunks indexed: ${chunks.length}

Available tools: ${enabledTools.join(', ')}

RULES:
1. Use tools to fetch specific data rather than assuming or hallucinating content.
2. Start by using the 'summary' tool to understand the overall context.
3. Use 'grep' or 'log_search' for precise lookups.
4. Use 'file_read' to inspect specific code sections.
5. Stay focused on the primary objective.
6. Do not ask the user to re-paste any data.`;
}

function buildUserPrompt(
  goal: string,
  chunks: Array<{ label: string; text: string }>,
): string {
  const preview = chunks.slice(0, 3).map((c) => {
    const snippet = c.text.slice(0, 200).replace(/\n/g, ' ');
    return `[${c.label}] ${snippet}...`;
  }).join('\n');

  return `OBJECTIVE: ${goal}

I have provided a large amount of context data that has been indexed. Here is a brief preview:
${preview}

Please use the available tools (log_search, file_read, grep, summary) to investigate and complete the objective. Start by getting a summary of the available data.`;
}

function summarizeLabels(labels: string[]): string {
  const counts: Record<string, number> = {};
  for (const l of labels) {
    counts[l] = (counts[l] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([label, count]) => `${label}(${count})`)
    .join(', ');
}
