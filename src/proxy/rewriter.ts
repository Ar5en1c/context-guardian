import type { LocalLLMAdapter } from '../local-llm/adapter.js';
import type { VectorStore } from '../index/store.js';
import { chunkText } from '../index/chunker.js';
import { getToolDefinitions, toOpenAIToolFormat } from '../tools/registry.js';
import { log } from '../display/logger.js';
import { Timer } from '../display/timing.js';
import { countTokens } from './interceptor.js';
import { extractEntities } from '../index/entity-extractor.js';
import type { SessionStore } from '../index/session-store.js';
import { shouldAutoCompact, autoCompact, microcompactToolResults } from './compaction.js';

export interface RewriteResult {
  messages: Array<{ role: string; content: string }>;
  tools: unknown[];
  goal: string;
  chunksIndexed: number;
  inputTokens: number;
  outputTokens: number;
  toolNames: string[];
  timingMs: {
    intent: number;
    chunking: number;
    classification: number;
    embedding: number;
    entity: number;
    total: number;
  };
}

import type { Chunk } from '../index/chunker.js';

export interface RewriteOptions {
  sessionStore?: SessionStore;
}

export async function rewriteRequest(
  rawContent: string,
  originalMessages: Array<{ role: string; content: unknown }>,
  llm: LocalLLMAdapter,
  store: VectorStore,
  enabledTools: string[],
  contextBudget: number,
  options?: RewriteOptions,
): Promise<RewriteResult> {
  const timer = new Timer();
  timer.mark('start');
  const inputTokens = countTokens(rawContent);
  const ss = options?.sessionStore;

  timer.mark('intentStart');
  log('intercept', `Extracting intent from ${inputTokens} tokens...`);
  const goal = await llm.extractIntent(rawContent);
  timer.measure('intent', 'intentStart');
  log('intercept', `Goal: "${goal}"`);

  timer.mark('chunkStart');
  log('intercept', 'Chunking and indexing content...');
  store.clear();
  const chunks = chunkText(rawContent, { source: 'request' });
  timer.measure('chunking', 'chunkStart');

  timer.mark('classifyStart');
  const classified = await llm.classifyChunks(chunks.map((c) => c.text));
  for (let i = 0; i < chunks.length; i++) {
    if (classified[i]) {
      chunks[i].label = classified[i].label;
    }
  }
  timer.measure('classification', 'classifyStart');

  timer.mark('embedStart');
  let embeddings: number[][] = [];
  try {
    embeddings = await llm.embed(chunks.map((c) => c.text));
  } catch {
    embeddings = chunks.map(() => []);
  }
  store.addBatch(chunks, embeddings);
  timer.measure('embedding', 'embedStart');

  // Entity extraction (heuristic, no LLM call -- fast)
  timer.mark('entityStart');
  const entities = extractEntities(rawContent);
  timer.measure('entity', 'entityStart');

  // Persist to session store for cross-request memory
  if (ss) {
    try {
      ss.startSession(goal);
      ss.addChunks(chunks, embeddings);
      // Update core memory with this request's goal
      ss.updateCoreMemory({ goal });
      // Persist extracted entities
      if (entities.length > 0) {
        ss.addEntities(entities.map((e) => ({ type: e.type, value: e.value })));
      }
    } catch {
      // never crash the proxy over persistence
    }
  }

  log('intercept', `Indexed ${chunks.length} chunks (${entities.length} entities). Labels: ${summarizeLabels(chunks.map((c) => c.label))}`);

  // Relevance scoring: embed the goal and find top-K most relevant chunks
  let relevantChunks = chunks;
  try {
    const goalEmbedding = (await llm.embed([goal]))[0];
    if (goalEmbedding && goalEmbedding.some((v) => v !== 0)) {
      const scored = store.search(goalEmbedding, Math.min(10, chunks.length));
      if (scored.length > 0) {
        relevantChunks = scored.map((s) => s.chunk);
        log('intercept', `Relevance filter: ${chunks.length} -> ${relevantChunks.length} chunks (top-K by cosine similarity)`);
      }
    }
  } catch {
    // Fall back to all chunks
  }

  // Load session memory block (core memory from previous requests)
  const coreMemoryBlock = ss ? ss.formatCoreMemoryBlock() : '';
  const entityHints = ss ? ss.formatEntityHints() : '';

  // Microcompaction: freeze old tool results, keep hot tail
  if (ss) {
    try { microcompactToolResults(ss); } catch { /* non-critical */ }
  }

  const systemPrompt = buildSystemPrompt(goal, relevantChunks, enabledTools, coreMemoryBlock, entityHints);
  const userPrompt = buildUserPrompt(goal, relevantChunks);

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

  timer.measure('total', 'start');

  log('intercept', `Rewritten: ${inputTokens} -> ${outputTokens} tokens (${Math.round((1 - outputTokens / inputTokens) * 100)}% reduction)`);
  timer.print();

  return {
    messages: rewrittenMessages,
    tools: openaiTools,
    goal,
    chunksIndexed: chunks.length,
    inputTokens,
    outputTokens,
    toolNames: enabledTools,
    timingMs: {
      intent: timer.get('intent'),
      chunking: timer.get('chunking'),
      classification: timer.get('classification'),
      embedding: timer.get('embedding'),
      entity: timer.get('entity'),
      total: timer.get('total'),
    },
  };
}

function buildSystemPrompt(
  goal: string,
  chunks: Array<{ label: string }>,
  enabledTools: string[],
  coreMemoryBlock = '',
  entityHints = '',
): string {
  const labels = summarizeLabels(chunks.map((c) => c.label));
  const hasErrors = chunks.some((c) => c.label === 'error' || c.label === 'stacktrace');
  const hasCode = chunks.some((c) => c.label === 'code');
  const hasLogs = chunks.some((c) => c.label === 'log');

  // Task-specific investigation sequence
  let strategy: string;
  if (hasErrors && hasCode) {
    strategy = `INVESTIGATION STRATEGY:
1. First: use 'summary' with topic 'errors' to understand what failed.
2. Then: use 'grep' to find the specific error pattern in code.
3. Then: use 'file_read' to read the relevant code section in full.
4. Finally: propose a concrete fix with code.`;
  } else if (hasLogs && hasCode) {
    strategy = `INVESTIGATION STRATEGY:
1. First: use 'summary' with topic 'logs' to understand the timeline.
2. Then: use 'log_search' to find key events.
3. Then: use 'file_read' to read the relevant code.
4. Finally: explain the root cause and propose a fix.`;
  } else if (hasCode) {
    strategy = `INVESTIGATION STRATEGY:
1. First: use 'summary' with topic 'all' to understand the codebase.
2. Then: use 'file_read' to inspect relevant files.
3. Then: use 'grep' for cross-references.
4. Finally: complete the requested task.`;
  } else {
    strategy = `INVESTIGATION STRATEGY:
1. First: use 'summary' with topic 'all' to get an overview.
2. Then: use 'grep' or 'log_search' for specific details.
3. Finally: complete the objective based on findings.`;
  }

  // Build session context sections
  const sessionContext = [coreMemoryBlock, entityHints].filter(Boolean).join('\n\n');

  return `CONTEXT GUARDIAN INSTRUCTIONS:
OBJECTIVE: ${goal}
${sessionContext ? `\n${sessionContext}\n` : ''}
The original request contained ${chunks.length} chunks of raw data (${labels}) that have been indexed locally. You MUST use tools to retrieve specific information -- do NOT ask the user to re-paste anything.

${strategy}

RULES:
- Use tools to fetch data. Do not guess or hallucinate content.
- Be specific in tool queries. Use exact error messages, function names, or patterns.${entityHints ? '\n- Use the ENTITY HINTS above as precise search queries for grep and log_search.' : ''}
- After gathering evidence, provide a concrete, actionable response.
- Available tools: ${enabledTools.join(', ')}`;
}

function buildUserPrompt(
  goal: string,
  chunks: Array<{ label: string; text: string }>,
): string {
  // Build structured preview with the most relevant snippets
  const errorChunks = chunks.filter((c) => c.label === 'error' || c.label === 'stacktrace');
  const codeChunks = chunks.filter((c) => c.label === 'code');
  const logChunks = chunks.filter((c) => c.label === 'log');
  const otherChunks = chunks.filter((c) => !['error', 'stacktrace', 'code', 'log'].includes(c.label));

  const previews: string[] = [];
  const addPreview = (label: string, items: typeof chunks, max: number) => {
    for (const c of items.slice(0, max)) {
      const firstLine = c.text.split('\n')[0].slice(0, 150);
      previews.push(`  [${label}] ${firstLine}`);
    }
  };

  addPreview('ERROR', errorChunks, 3);
  addPreview('CODE', codeChunks, 2);
  addPreview('LOG', logChunks, 2);
  addPreview('OTHER', otherChunks, 1);

  return `OBJECTIVE: ${goal}

INDEXED DATA PREVIEW (${chunks.length} chunks available via tools):
${previews.join('\n')}

Begin investigation using the strategy above. Start with 'summary' to get an overview, then use precise tool calls.`;
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
