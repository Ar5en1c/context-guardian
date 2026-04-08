import type { LocalLLMAdapter } from '../local-llm/adapter.js';
import type { VectorStore } from '../index/store.js';
import { chunkText } from '../index/chunker.js';
import { getToolDefinitions, toOpenAIToolFormat } from '../tools/registry.js';
import { log } from '../display/logger.js';
import { Timer } from '../display/timing.js';
import { countTokens } from './interceptor.js';
import { extractEntities, type ExtractedEntity } from '../index/entity-extractor.js';
import type { SessionStore } from '../index/session-store.js';
import { microcompactToolResults } from './compaction.js';
import { formatTaskProfileBlock, profileTask, type TaskProfile } from './task-profiler.js';
import { evaluateRewriteROI, runDeterministicBootstrap, type BootstrapResult, type RewriteROI } from './rewrite-controls.js';

export interface RewriteResult {
  messages: Array<{ role: string; content: string }>;
  tools: unknown[];
  goal: string;
  taskProfile: TaskProfile;
  bootstrap: BootstrapResult;
  roi: RewriteROI;
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
  sessionId?: string;
  routeMode?: 'passthrough' | 'context_shape' | 'full_rewrite';
  decisionReasons?: string[];
}

interface RetrievalStep {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

interface InvestigationBrief {
  artifactOverview: string;
  localBrief: string;
  searchPlan: RetrievalStep[];
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
  const sessionId = options?.sessionId;
  const priorSessionChunkCount = ss ? ss.getSessionChunkCount(sessionId) : 0;

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
      ss.startSession(goal, sessionId);
      ss.addChunks(chunks, embeddings, sessionId);
      // Update core memory with this request's goal
      ss.updateCoreMemory({ goal }, sessionId);
      // Persist extracted entities
      if (entities.length > 0) {
        ss.addEntities(entities.map((e) => ({ type: e.type, value: e.value })), sessionId);
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
      const scored = store.search(goalEmbedding, Math.min(12, chunks.length));
      if (scored.length > 0) {
        relevantChunks = scored.map((s) => s.chunk);
        log('intercept', `Relevance filter: ${chunks.length} -> ${relevantChunks.length} chunks (top-K by cosine similarity)`);
      }
    }
  } catch {
    // Fall back to all chunks
  }

  // Load session memory block (core memory from previous requests)
  const coreMemoryBlock = ss ? ss.formatCoreMemoryBlock(sessionId) : '';
  const entityHints = ss ? ss.formatEntityHints(sessionId) : '';

  // Microcompaction: freeze old tool results, keep hot tail
  if (ss) {
    try { microcompactToolResults(ss, sessionId); } catch { /* non-critical */ }
  }

  const taskProfile = profileTask({
    goal,
    rawContent,
    chunks,
    entities,
    enabledTools,
    priorSessionChunkCount,
  });
  const previewChunks = selectPreviewChunks(relevantChunks, contextBudget);
  const brief = await buildInvestigationBrief(goal, previewChunks, entities, llm, contextBudget, taskProfile);
  const bootstrap = await runDeterministicBootstrap(taskProfile, brief.searchPlan, {
    store,
    llm,
    sessionStore: ss,
    sessionId,
  });
  const systemPrompt = buildSystemPrompt(
    goal,
    previewChunks,
    enabledTools,
    coreMemoryBlock,
    entityHints,
    brief,
    taskProfile,
    bootstrap.summaryBlock,
    options?.routeMode || 'full_rewrite',
    options?.decisionReasons || [],
  );
  const userPrompt = buildUserPrompt(goal, previewChunks);

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
  const roi = evaluateRewriteROI({
    inputTokens,
    outputTokens,
    taskProfile,
    routeMode: options?.routeMode || 'full_rewrite',
    decisionReasons: options?.decisionReasons || [],
    bootstrap,
  });

  timer.measure('total', 'start');

  log('intercept', `Rewritten: ${inputTokens} -> ${outputTokens} tokens (${Math.round((1 - outputTokens / inputTokens) * 100)}% reduction)`);
  log(roi.shouldRewrite ? 'intercept' : 'passthrough', `Rewrite ROI: ${roi.reason} (savings=${roi.tokenSavings}, reduction=${Math.round(roi.tokenReduction * 100)}%)`);
  timer.print();

  return {
    messages: rewrittenMessages,
    tools: openaiTools,
    goal,
    taskProfile,
    bootstrap,
    roi,
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
  brief: InvestigationBrief,
  taskProfile: TaskProfile,
  bootstrapBlock: string,
  routeMode: 'passthrough' | 'context_shape' | 'full_rewrite',
  decisionReasons: string[],
): string {
  const labels = summarizeLabels(chunks.map((c) => c.label));
  const hasErrors = chunks.some((c) => c.label === 'error' || c.label === 'stacktrace');
  const hasCode = chunks.some((c) => c.label === 'code');
  const hasLogs = chunks.some((c) => c.label === 'log');

  // Task-specific investigation sequence
  let strategy: string;
  if (hasErrors && hasCode) {
    strategy = `INVESTIGATION STRATEGY:
1. First: follow the SMALL-AGENT SEARCH PLAN to isolate the failing signal.
2. Then: use 'grep' and 'file_read' to connect the failure to the relevant code.
3. Use 'summary' only if you need cross-artifact synthesis.
4. Finally: propose a concrete fix with code.`;
  } else if (hasLogs && hasCode) {
    strategy = `INVESTIGATION STRATEGY:
1. First: use the SMALL-AGENT SEARCH PLAN to pull the most relevant log and code evidence.
2. Then: narrow with 'log_search' and 'file_read' until you can explain the causal chain.
3. Use 'summary' only if you need a broader timeline.
4. Finally: explain the root cause and propose a fix.`;
  } else if (hasCode) {
    strategy = `INVESTIGATION STRATEGY:
1. First: use the SMALL-AGENT SEARCH PLAN to land on the likely file or symbol.
2. Then: use 'file_read' to inspect relevant files.
3. Then: use 'grep' for cross-references.
4. Finally: complete the requested task.`;
  } else {
    strategy = `INVESTIGATION STRATEGY:
1. First: use the SMALL-AGENT SEARCH PLAN to retrieve the sharpest clues.
2. Then: use 'grep' or 'log_search' for specific details.
3. Use 'summary' only if the targeted retrieval is insufficient.
4. Finally: complete the objective based on findings.`;
  }

  const routeContext = routeMode === 'context_shape'
    ? 'The local agent intervened because the prompt contained dense debugging artifacts even though the overall request may not be huge.'
    : 'The local agent intercepted this request because the raw prompt was large enough that direct stuffing would waste context.';

  const searchPlan = renderSearchPlan(brief.searchPlan);
  const taskProfileBlock = formatTaskProfileBlock(taskProfile);

  // Build session context sections
  const sessionContext = [coreMemoryBlock, entityHints].filter(Boolean).join('\n\n');

  return `CONTEXT GUARDIAN INSTRUCTIONS:
OBJECTIVE: ${goal}
${sessionContext ? `\n${sessionContext}\n` : ''}
ROUTING CONTEXT: ${routeContext}
ROUTING SIGNALS: ${decisionReasons.join(', ') || 'token threshold'}
${taskProfileBlock}
${bootstrapBlock ? `${bootstrapBlock}\n` : ''}LOCAL BRIEF: ${brief.localBrief}
ARTIFACT OVERVIEW: ${brief.artifactOverview}
The original request contained ${chunks.length} focused chunks of raw data (${labels}) that have been indexed locally. You MUST use tools to retrieve specific information -- do NOT ask the user to re-paste anything.

${strategy}

SMALL-AGENT SEARCH PLAN:
${searchPlan}

RULES:
- Use tools to fetch data. Do not guess or hallucinate content.
- Treat the TASK PROFILE as a planning budget. For broad tasks, survey first; for focused tasks, stop searching once you have the likely files and evidence.
- If DETERMINISTIC BOOTSTRAP results are present, use them as your initial survey state instead of repeating the same broad opening call.
- Start with the search plan above before using broad summaries.
- Prefer narrow grep/log_search/file_read calls that target one artifact at a time.
- Be specific in tool queries. Use exact error messages, function names, config keys, or patterns.${entityHints ? '\n- Use the ENTITY HINTS above as precise search queries for grep and log_search.' : ''}
- Only use 'summary' when the targeted lookups are insufficient or you need synthesis across artifacts.
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

Follow the SMALL-AGENT SEARCH PLAN from the system instructions. Use summary only if targeted retrieval is insufficient.`;
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

function selectPreviewChunks(
  chunks: Chunk[],
  contextBudget: number,
): Chunk[] {
  const previewBudget = Math.min(1200, Math.max(300, Math.floor(contextBudget * 0.35)));
  const selected: Chunk[] = [];
  const seen = new Set<string>();
  let usedTokens = 0;

  const groups = [
    chunks.filter((c) => c.label === 'error' || c.label === 'stacktrace'),
    chunks.filter((c) => c.label === 'log' || c.label === 'output'),
    chunks.filter((c) => c.label === 'code' || c.label === 'config'),
    chunks.filter((c) => !['error', 'stacktrace', 'log', 'output', 'code', 'config'].includes(c.label)),
  ];

  for (const group of groups) {
    for (const chunk of group) {
      const key = `${chunk.label}:${chunk.text.slice(0, 140)}`;
      if (seen.has(key)) continue;
      const cost = Math.max(8, countTokens(chunk.text.slice(0, 220)));
      if (selected.length >= 4 && usedTokens + cost > previewBudget) continue;
      selected.push(chunk);
      seen.add(key);
      usedTokens += cost;
      if (selected.length >= 8 || usedTokens >= previewBudget) return selected;
    }
  }

  return selected.length > 0 ? selected : chunks.slice(0, 4);
}

async function buildInvestigationBrief(
  goal: string,
  chunks: Chunk[],
  entities: ExtractedEntity[],
  llm: LocalLLMAdapter,
  contextBudget: number,
  taskProfile: TaskProfile,
): Promise<InvestigationBrief> {
  const artifactOverview = buildArtifactOverview(chunks, entities);
  const searchPlan = buildSearchPlan(goal, chunks, entities, taskProfile);
  const localBrief = await buildLocalBrief(goal, chunks, artifactOverview, llm, contextBudget);
  return { artifactOverview, localBrief, searchPlan };
}

function buildArtifactOverview(
  chunks: Array<{ label: string }>,
  entities: ExtractedEntity[],
): string {
  const labelSummary = summarizeLabels(chunks.map((c) => c.label));
  const entityCounts: Record<string, number> = {};
  for (const entity of entities) {
    entityCounts[entity.type] = (entityCounts[entity.type] || 0) + 1;
  }
  const entitySummary = Object.entries(entityCounts)
    .slice(0, 6)
    .map(([type, count]) => `${type}(${count})`)
    .join(', ');

  return entitySummary ? `${labelSummary}; entities: ${entitySummary}` : labelSummary;
}

async function buildLocalBrief(
  goal: string,
  chunks: Chunk[],
  artifactOverview: string,
  llm: LocalLLMAdapter,
  contextBudget: number,
): Promise<string> {
  const briefInput = chunks
    .slice(0, 6)
    .map((chunk) => `[${chunk.label}] ${extractMeaningfulSnippet(chunk.text, 260)}`)
    .join('\n---\n');

  if (!briefInput.trim()) {
    return `Focused on ${artifactOverview}. Use the search plan to validate details before answering.`;
  }

  const maxWords = Math.min(180, Math.max(80, Math.floor(contextBudget / 24)));
  try {
    const summary = await llm.summarize(
      `Goal: ${goal}\nArtifact overview: ${artifactOverview}\n\nEvidence excerpts:\n${briefInput}`,
      maxWords,
    );
    return summary.trim();
  } catch {
    return `Focused on ${artifactOverview}. Use the search plan to validate details before answering.`;
  }
}

function buildSearchPlan(
  goal: string,
  chunks: Array<{ label: string; text: string }>,
  entities: ExtractedEntity[],
  taskProfile: TaskProfile,
): RetrievalStep[] {
  const plan: RetrievalStep[] = [];
  const seen = new Set<string>();
  const hasLogs = chunks.some((c) => c.label === 'log' || c.label === 'output' || c.label === 'error');
  const hasErrors = chunks.some((c) => c.label === 'error' || c.label === 'stacktrace');
  const seedQuery = deriveSeedQuery(goal, entities, taskProfile.focusTerms);

  const addStep = (tool: string, args: Record<string, unknown>, reason: string) => {
    const key = `${tool}:${JSON.stringify(args)}`;
    if (seen.has(key)) return;
    seen.add(key);
    plan.push({ tool, args, reason });
  };

  for (const tool of taskProfile.preferredEntryTools.slice(0, 3)) {
    switch (tool) {
      case 'repo_map':
        addStep('repo_map', { limit_files: taskProfile.scopeClass === 'repo_wide' ? 35 : 20, limit_symbols: 30 }, 'survey indexed repository structure first');
        break;
      case 'file_tree':
        addStep('file_tree', { filter: seedQuery, limit: taskProfile.scopeClass === 'repo_wide' ? 80 : 40 }, 'check which files are already indexed for this task');
        break;
      case 'symbol_find':
        addStep('symbol_find', { query: seedQuery || taskProfile.focusTerms[0] || 'main', limit: 12 }, 'find the primary symbols tied to the task');
        break;
      case 'log_search':
        addStep('log_search', { query: seedQuery || taskProfile.focusTerms[0] || 'error', severity: 'all', limit: 6 }, 'pull the highest-signal log lines first');
        break;
      case 'grep':
        addStep('grep', { pattern: escapeRegex(seedQuery || taskProfile.focusTerms[0] || 'error'), context_lines: 1, limit: 6 }, 'fan out from the strongest textual clue');
        break;
      case 'file_read': {
        const fileEntity = entities.find((entity) => entity.type === 'file_path');
        if (fileEntity) {
          addStep('file_read', { query: simplifySearchValue(fileEntity.value), limit: 2 }, 'read the most likely target file immediately');
        }
        break;
      }
      case 'summary':
        addStep('summary', { topic: hasLogs ? 'logs' : hasErrors ? 'errors' : 'all' }, 'synthesize a quick overview before deeper reads');
        break;
    }
  }

  for (const entity of entities) {
    const value = simplifySearchValue(entity.value);
    if (!value) continue;
    switch (entity.type) {
      case 'error_message':
        if (hasLogs) {
          addStep('log_search', { query: value, severity: 'error', limit: 6 }, 'locate the exact failing log lines');
        }
        addStep('grep', { pattern: escapeRegex(value), context_lines: 1, limit: 6 }, 'find exact error occurrences across indexed content');
        break;
      case 'file_path':
        addStep('file_read', { query: value, limit: 2 }, 'inspect the implicated file directly');
        break;
      case 'function_name':
      case 'class_name':
      case 'config_key':
      case 'env_var':
      case 'module':
        addStep('grep', { pattern: `\\b${escapeRegex(value)}\\b`, context_lines: 1, limit: 6 }, `trace ${entity.type.replace(/_/g, ' ')}`);
        break;
      case 'http_status':
      case 'url':
      case 'port':
        addStep(hasLogs ? 'log_search' : 'grep', hasLogs
          ? { query: value, limit: 6 }
          : { pattern: escapeRegex(value), context_lines: 1, limit: 6 }, `trace ${entity.type.replace(/_/g, ' ')}`);
        break;
    }
    if (plan.length >= 6) break;
  }

  if (plan.length === 0) {
    const errorHint = chunks.find((c) => c.label === 'error' || c.label === 'stacktrace');
    const logHint = chunks.find((c) => c.label === 'log' || c.label === 'output');
    if (errorHint) {
      addStep('summary', { topic: 'errors' }, 'orient on the highest-signal failures first');
      const snippet = simplifySearchValue(extractMeaningfulSnippet(errorHint.text, 80));
      if (snippet) addStep('grep', { pattern: escapeRegex(snippet), context_lines: 1, limit: 4 }, 'expand the key failure clue');
    } else if (logHint) {
      addStep('summary', { topic: 'logs' }, 'build the timeline before drilling into details');
    } else {
      addStep('summary', { topic: 'all' }, 'get a compact overview before retrieving details');
    }
  }

  return plan.slice(0, 6);
}

function renderSearchPlan(plan: RetrievalStep[]): string {
  if (plan.length === 0) {
    return '1. summary({"topic":"all"}) -- get a compact overview before drilling into details';
  }
  return plan
    .map((step, index) => `${index + 1}. ${step.tool}(${JSON.stringify(step.args)}) -- ${step.reason}`)
    .join('\n');
}

function simplifySearchValue(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
    .slice(0, 90);
}

function extractMeaningfulSnippet(text: string, maxChars: number): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 6 && !/^[{}\[\],;]+$/.test(l));
  return (line || text.trim()).slice(0, maxChars);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function deriveSeedQuery(
  goal: string,
  entities: ExtractedEntity[],
  focusTerms: string[],
): string {
  const preferredEntity = entities.find((entity) =>
    ['module', 'function_name', 'class_name', 'config_key', 'file_path', 'error_message'].includes(entity.type),
  );
  if (preferredEntity) {
    return simplifySearchValue(preferredEntity.value);
  }
  if (focusTerms.length > 0) return simplifySearchValue(focusTerms[0]);

  const fallback = goal
    .split(/[^a-zA-Z0-9_./:-]+/)
    .map((term) => term.trim())
    .find((term) => term.length >= 4);
  return fallback ? simplifySearchValue(fallback) : '';
}
