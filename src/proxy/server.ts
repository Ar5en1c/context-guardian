import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { LocalLLMAdapter } from '../local-llm/adapter.js';
import { VectorStore } from '../index/store.js';
import { analyzeRequest, extractRawContent } from './interceptor.js';
import { rewriteRequest } from './rewriter.js';
import { createSSEHeaders, synthesizeSSEStream, synthesizeAnthropicSSEStream } from './streaming.js';
import { getTool } from '../tools/registry.js';
import * as openai from './adapters/openai.js';
import * as anthropic from './adapters/anthropic.js';
import { log } from '../display/logger.js';
import { logRequest } from '../display/request-log.js';
import { logMetrics } from '../display/metrics-log.js';
import type { Stats } from '../display/dashboard.js';
import { printStats } from '../display/dashboard.js';
import { SessionStore } from '../index/session-store.js';
import { renderDashboardHTML } from '../display/dashboard-html.js';

import { countTokens } from './interceptor.js';
import { autoCompact } from './compaction.js';

import '../tools/log-search.js';
import '../tools/file-read.js';
import '../tools/grep.js';
import '../tools/summary.js';
import '../tools/repo-map.js';
import '../tools/file-tree.js';
import '../tools/symbol-find.js';
import '../tools/git-diff.js';
import '../tools/test-failures.js';
import '../tools/run-checks.js';

const MAX_TOOL_ROUNDS = 10;

export function createProxyServer(config: Config, llm: LocalLLMAdapter, stats: Stats, sessionStore?: SessionStore) {
  const app = new Hono();
  const store = new VectorStore(); // shared store for health/stats only
  const startedAt = Date.now();

  app.get('/', (c) => {
    const sessions = sessionStore ? sessionStore.listSessions(15) : [];
    const html = renderDashboardHTML({
      mode: 'proxy',
      version: '0.3.0',
      uptime: (Date.now() - startedAt) / 1000,
      intercepted: stats.intercepted,
      passedThrough: stats.passedThrough,
      tokensSaved: stats.tokensSaved,
      storeSize: store.size,
      toolCalls: 0,
      sessions,
    });
    return c.html(html);
  });

  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      version: '0.3.0',
      intercepted: stats.intercepted,
      passedThrough: stats.passedThrough,
      tokensSaved: stats.tokensSaved,
      storeSize: store.size,
    });
  });

  app.get('/stats', (c) => {
    return c.json(stats);
  });

  // OpenAI-compatible: POST /v1/chat/completions
  app.post('/v1/chat/completions', async (c) => {
    return handleOpenAIRequest(c, config, llm, store, stats, sessionStore);
  });

  // Also handle without /v1 prefix
  app.post('/chat/completions', async (c) => {
    return handleOpenAIRequest(c, config, llm, store, stats, sessionStore);
  });

  // Anthropic-compatible: POST /v1/messages
  app.post('/v1/messages', async (c) => {
    return handleAnthropicRequest(c, config, llm, store, stats, sessionStore);
  });

  // Passthrough for model listing
  app.get('/v1/models', async (c) => {
    const apiKey = extractApiKey(c.req.header('Authorization'));
    try {
      const res = await fetch(`${config.cloud.openai_base}/models`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      const data = await res.json();
      return c.json(data);
    } catch {
      return c.json({ object: 'list', data: [] });
    }
  });

  // Catch-all passthrough
  app.all('*', async (c) => {
    log('debug', `Unhandled route: ${c.req.method} ${c.req.path}`);
    return c.json({ error: 'Unknown endpoint. Context Guardian supports /v1/chat/completions and /v1/messages' }, 404);
  });

  return app;
}

async function executeToolCalls(
  toolCalls: openai.OpenAIToolCall[],
  store: VectorStore,
  llm: LocalLLMAdapter,
  config: Config,
  sessionStore?: SessionStore,
  sessionId?: string,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const promises = toolCalls.map(async (tc) => {
    const tool = getTool(tc.function.name);
    if (!tool) {
      results.set(tc.id, `Unknown tool: ${tc.function.name}`);
      return;
    }
    const policyCheck = canExecuteTool(tc.function.name, config);
    if (!policyCheck.allowed) {
      results.set(tc.id, `Tool blocked by policy: ${policyCheck.reason}`);
      return;
    }
    try {
      const args = JSON.parse(tc.function.arguments);
      const result = await tool.handler(args, { store, llm, sessionStore, sessionId });
      results.set(tc.id, result);
      log('debug', `Tool ${tc.function.name} returned ${result.length} chars`);
      // Track tool result in session store for hot-tail / cold-storage compaction
      if (sessionStore) {
        try {
          const query = args.query || args.pattern || args.topic || '';
          sessionStore.addToolResult(tc.function.name, String(query), result, countTokens(result), sessionId);
        } catch { /* non-critical */ }
      }
    } catch (err) {
      results.set(tc.id, `Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  await Promise.all(promises);
  return results;
}

async function handleOpenAIRequest(
  c: { req: { json: () => Promise<unknown>; header: (name: string) => string | undefined }; json: (data: unknown, status?: number) => Response; header: (name: string, value: string) => void; body: (data: ReadableStream) => Response },
  config: Config,
  llm: LocalLLMAdapter,
  store: VectorStore,
  stats: Stats,
  sessionStore?: SessionStore,
) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!openai.isOpenAIFormat(body)) {
    return c.json({ error: 'Invalid request format' }, 400);
  }

  const apiKey = extractApiKey(c.req.header('Authorization'));
  const headerGetter = (name: string) => c.req.header(name);
  const sessionId = resolveSessionId(headerGetter, body, 'openai', apiKey);
  const extraHeaders = extractForwardHeaders(headerGetter);
  const messages = openai.extractMessages(body);
  let decision = analyzeRequest(messages, config.threshold_tokens, config.intercept_policy);
  decision = applySessionScopeOverride(decision, sessionStore, sessionId);

  if (!decision.shouldIntercept) {
    stats.passedThrough++;
    logRequest('passthrough', 'openai', decision.totalTokens, body.model);
    logMetrics({
      timestamp: new Date().toISOString(),
      provider: 'openai',
      mode: 'passthrough',
      sessionId,
      model: body.model,
      inputTokens: decision.totalTokens,
    });
    return forwardOpenAIPassthrough(config.cloud.openai_base, apiKey, body, c, extraHeaders);
  }

  const requestStore = new VectorStore(); // per-request store to avoid race conditions
  let countedIntercept = false;
  try {
    const rawContent = extractRawContent(messages);
    const rewrite = await rewriteRequest(
      rawContent, messages, llm, requestStore, config.tools, config.context_budget,
      { sessionStore: sessionStore || undefined, sessionId, routeMode: decision.mode, decisionReasons: decision.reasons },
    );

    if (!rewrite.roi.shouldRewrite) {
      log('passthrough', `Skipping rewrite due to ROI: ${rewrite.roi.reason}`);
      stats.passedThrough++;
      logRequest('passthrough', 'openai', decision.totalTokens, body.model);
      logMetrics({
        timestamp: new Date().toISOString(),
        provider: 'openai',
        mode: 'passthrough',
        sessionId,
        model: body.model,
        inputTokens: rewrite.inputTokens,
        outputTokens: rewrite.outputTokens,
        tokenReduction: rewrite.inputTokens > 0
          ? 1 - rewrite.outputTokens / rewrite.inputTokens
          : 0,
        goal: rewrite.goal,
        note: `roi_skip: ${rewrite.roi.reason}`,
      });
      return forwardOpenAIPassthrough(config.cloud.openai_base, apiKey, body, c, extraHeaders);
    }

    stats.intercepted++;
    countedIntercept = true;

    stats.tokensSaved += rewrite.inputTokens - rewrite.outputTokens;
    stats.lastIntercept = {
      inTokens: rewrite.inputTokens,
      outTokens: rewrite.outputTokens,
      goal: rewrite.goal,
      toolsInjected: rewrite.toolNames,
    };
    printStats(stats);
    logRequest('intercept', 'openai', rewrite.inputTokens, body.model, rewrite.goal, rewrite.outputTokens);
    logMetrics({
      timestamp: new Date().toISOString(),
      provider: 'openai',
      mode: decision.mode,
      sessionId,
      model: body.model,
      inputTokens: rewrite.inputTokens,
      outputTokens: rewrite.outputTokens,
      tokenReduction: rewrite.inputTokens > 0
        ? 1 - rewrite.outputTokens / rewrite.inputTokens
        : 0,
      goal: rewrite.goal,
    });

    const forwardReq = openai.buildForwardRequest(body, rewrite.messages, rewrite.tools);
    const wasStreaming = Boolean(body.stream);

    // For intercepted requests, always use non-stream to enable tool call loop,
    // then re-synthesize SSE if the original request was streaming
    forwardReq.stream = false;

    // Multi-round tool call loop
    let currentReq = forwardReq;
    let currentMessages = [...forwardReq.messages] as Array<Record<string, unknown>>;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const cloudResponse = await openai.forwardToCloud(config.cloud.openai_base, apiKey, currentReq, extraHeaders);
      const responseData = (await cloudResponse.json()) as openai.OpenAIResponse;

      if (!openai.hasToolCalls(responseData)) {
        if (wasStreaming) {
          const headers = createSSEHeaders();
          for (const [k, v] of Object.entries(headers)) c.header(k, v);
          return c.body(synthesizeSSEStream(responseData));
        }
        return c.json(responseData);
      }

      const toolCalls = openai.extractToolCalls(responseData);
      log('intercept', `Tool round ${round + 1}: ${toolCalls.map((t) => t.function.name).join(', ')}`);

      const results = await executeToolCalls(toolCalls, requestStore, llm, config, sessionStore, sessionId);
      const toolResultMsgs = openai.buildToolResultMessages(toolCalls, results);

      currentMessages = [
        ...currentMessages,
        responseData.choices[0].message as unknown as Record<string, unknown>,
        ...toolResultMsgs,
      ];

      if (sessionStore) {
        const compacted = await autoCompact(
          sessionStore,
          llm,
          normalizeOpenAIMessagesForCompaction(currentMessages),
          { contextBudget: config.context_budget },
          sessionId,
        );
        if (compacted.compacted) {
          currentMessages = applyOpenAICompactionBoundary(currentMessages, compacted.summaryMessage);
        }
      }

      currentReq = { ...forwardReq, messages: currentMessages as openai.OpenAIRequest['messages'] };
    }

    log('warn', `Hit max tool rounds (${MAX_TOOL_ROUNDS}), forcing final response`);
    const finalReq = { ...currentReq };
    delete finalReq.tools;
    delete finalReq.tool_choice;
    const finalRes = await openai.forwardToCloud(config.cloud.openai_base, apiKey, finalReq, extraHeaders);
    const finalData = await finalRes.json();
    if (wasStreaming) {
      const headers = createSSEHeaders();
      for (const [k, v] of Object.entries(headers)) c.header(k, v);
      return c.body(synthesizeSSEStream(finalData));
    }
    return c.json(finalData);
  } catch (err) {
    log('error', `Intercept failed, falling back to passthrough: ${err instanceof Error ? err.message : String(err)}`);
    logMetrics({
      timestamp: new Date().toISOString(),
      provider: 'openai',
      mode: 'error',
      sessionId,
      model: body.model,
      inputTokens: decision.totalTokens,
      note: err instanceof Error ? err.message : String(err),
    });
    stats.passedThrough++;
    if (countedIntercept) stats.intercepted--;
    return forwardOpenAIPassthrough(config.cloud.openai_base, apiKey, body, c, extraHeaders);
  }
}

async function handleAnthropicRequest(
  c: { req: { json: () => Promise<unknown>; header: (name: string) => string | undefined }; json: (data: unknown, status?: number) => Response; header: (name: string, value: string) => void; body: (data: ReadableStream) => Response },
  config: Config,
  llm: LocalLLMAdapter,
  store: VectorStore,
  stats: Stats,
  sessionStore?: SessionStore,
) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!anthropic.isAnthropicFormat(body)) {
    return c.json({ error: 'Invalid Anthropic request format' }, 400);
  }

  const apiKey = c.req.header('x-api-key') || '';
  const headerGetter = (name: string) => c.req.header(name);
  const sessionId = resolveSessionId(headerGetter, body, 'anthropic', apiKey);
  const extraHeaders = extractForwardHeaders(headerGetter);
  const messages = anthropic.extractMessages(body);
  let decision = analyzeRequest(messages, config.threshold_tokens, config.intercept_policy);
  decision = applySessionScopeOverride(decision, sessionStore, sessionId);

  if (!decision.shouldIntercept) {
    stats.passedThrough++;
    logRequest('passthrough', 'anthropic', decision.totalTokens, body.model);
    logMetrics({
      timestamp: new Date().toISOString(),
      provider: 'anthropic',
      mode: 'passthrough',
      sessionId,
      model: body.model,
      inputTokens: decision.totalTokens,
    });
    return forwardAnthropicPassthrough(config.cloud.anthropic_base, apiKey, body, c, extraHeaders);
  }

  const requestStore = new VectorStore(); // per-request store for Anthropic
  let countedIntercept = false;
  try {
    const rawContent = extractRawContent(messages);
    const rewrite = await rewriteRequest(
      rawContent, messages, llm, requestStore, config.tools, config.context_budget,
      { sessionStore: sessionStore || undefined, sessionId, routeMode: decision.mode, decisionReasons: decision.reasons },
    );

    if (!rewrite.roi.shouldRewrite) {
      log('passthrough', `Skipping Anthropic rewrite due to ROI: ${rewrite.roi.reason}`);
      stats.passedThrough++;
      logRequest('passthrough', 'anthropic', decision.totalTokens, body.model);
      logMetrics({
        timestamp: new Date().toISOString(),
        provider: 'anthropic',
        mode: 'passthrough',
        sessionId,
        model: body.model,
        inputTokens: rewrite.inputTokens,
        outputTokens: rewrite.outputTokens,
        tokenReduction: rewrite.inputTokens > 0
          ? 1 - rewrite.outputTokens / rewrite.inputTokens
          : 0,
        goal: rewrite.goal,
        note: `roi_skip: ${rewrite.roi.reason}`,
      });
      return forwardAnthropicPassthrough(config.cloud.anthropic_base, apiKey, body, c, extraHeaders);
    }

    stats.intercepted++;
    countedIntercept = true;

    stats.tokensSaved += rewrite.inputTokens - rewrite.outputTokens;
    stats.lastIntercept = {
      inTokens: rewrite.inputTokens,
      outTokens: rewrite.outputTokens,
      goal: rewrite.goal,
      toolsInjected: rewrite.toolNames,
    };
    printStats(stats);
    logRequest('intercept', 'anthropic', rewrite.inputTokens, body.model, rewrite.goal, rewrite.outputTokens);
    logMetrics({
      timestamp: new Date().toISOString(),
      provider: 'anthropic',
      mode: decision.mode,
      sessionId,
      model: body.model,
      inputTokens: rewrite.inputTokens,
      outputTokens: rewrite.outputTokens,
      tokenReduction: rewrite.inputTokens > 0
        ? 1 - rewrite.outputTokens / rewrite.inputTokens
        : 0,
      goal: rewrite.goal,
    });

    const forwardReq = anthropic.buildForwardRequest(body, rewrite.messages, rewrite.tools);
    const wasStreaming = Boolean(body.stream);
    forwardReq.stream = false;

    // Multi-round tool call loop for Anthropic
    let currentReq = forwardReq;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const cloudResponse = await anthropic.forwardToCloud(config.cloud.anthropic_base, apiKey, currentReq, extraHeaders);
      const responseData = (await cloudResponse.json()) as anthropic.AnthropicResponse;

      if (!anthropic.hasToolUse(responseData)) {
        if (wasStreaming) {
          const headers = createSSEHeaders();
          for (const [k, v] of Object.entries(headers)) c.header(k, v);
          return c.body(synthesizeAnthropicSSEStream(responseData));
        }
        return c.json(responseData);
      }

      const toolUseBlocks = anthropic.extractToolUse(responseData);
      log('intercept', `Anthropic tool round ${round + 1}: ${toolUseBlocks.map((t) => t.name).join(', ')}`);

      const toolResults: anthropic.ToolResultBlock[] = [];
      for (const tu of toolUseBlocks) {
        const tool = getTool(tu.name);
        if (!tool) {
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Unknown tool: ${tu.name}` });
          continue;
        }
        const policyCheck = canExecuteTool(tu.name, config);
        if (!policyCheck.allowed) {
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Tool blocked by policy: ${policyCheck.reason}` });
          continue;
        }
        try {
          const result = await tool.handler(tu.input as Record<string, unknown>, { store: requestStore, llm, sessionStore, sessionId });
          if (sessionStore) {
            const args = (tu.input as Record<string, unknown>) || {};
            const query = args.query || args.pattern || args.topic || '';
            sessionStore.addToolResult(tu.name, String(query), result, countTokens(result), sessionId);
          }
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
        } catch (err) {
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Error: ${err instanceof Error ? err.message : String(err)}` });
        }
      }

      currentReq = anthropic.appendToolResults(currentReq, responseData, toolResults);
      if (sessionStore) {
        const compacted = await autoCompact(
          sessionStore,
          llm,
          normalizeAnthropicMessagesForCompaction(currentReq),
          { contextBudget: config.context_budget },
          sessionId,
        );
        if (compacted.compacted) {
          currentReq = applyAnthropicCompactionBoundary(currentReq, compacted.summaryMessage);
        }
      }
    }

    log('warn', `Hit max tool rounds (${MAX_TOOL_ROUNDS}) on Anthropic, forcing final`);
    const finalReq = { ...currentReq };
    delete finalReq.tools;
    const finalRes = await anthropic.forwardToCloud(config.cloud.anthropic_base, apiKey, finalReq, extraHeaders);
    const finalData = await finalRes.json();
    if (wasStreaming) {
      const headers = createSSEHeaders();
      for (const [k, v] of Object.entries(headers)) c.header(k, v);
      return c.body(synthesizeAnthropicSSEStream(finalData));
    }
    return c.json(finalData);
  } catch (err) {
    log('error', `Anthropic intercept failed, falling back: ${err instanceof Error ? err.message : String(err)}`);
    logMetrics({
      timestamp: new Date().toISOString(),
      provider: 'anthropic',
      mode: 'error',
      sessionId,
      model: body.model,
      inputTokens: decision.totalTokens,
      note: err instanceof Error ? err.message : String(err),
    });
    stats.passedThrough++;
    if (countedIntercept) stats.intercepted--;
    return forwardAnthropicPassthrough(config.cloud.anthropic_base, apiKey, body, c, extraHeaders);
  }
}

async function forwardOpenAIPassthrough(
  cloudBase: string,
  apiKey: string,
  body: openai.OpenAIRequest,
  c: { json: (data: unknown, status?: number) => Response; header: (name: string, value: string) => void; body: (data: ReadableStream) => Response },
  extraHeaders: Record<string, string> = {},
) {
  try {
    const res = await openai.forwardToCloud(cloudBase, apiKey, body, extraHeaders);
    if (body.stream && res.body) {
      const headers = createSSEHeaders();
      for (const [k, v] of Object.entries(headers)) c.header(k, v);
      return c.body(res.body as unknown as ReadableStream);
    }
    const data = await res.json();
    return c.json(data);
  } catch (err) {
    log('error', `Proxy forward failed: ${err instanceof Error ? err.message : String(err)}`);
    return c.json({ error: 'Proxy forward failed' }, 502);
  }
}

async function forwardAnthropicPassthrough(
  cloudBase: string,
  apiKey: string,
  body: anthropic.AnthropicRequest,
  c: { json: (data: unknown, status?: number) => Response; header: (name: string, value: string) => void; body: (data: ReadableStream) => Response },
  extraHeaders: Record<string, string> = {},
) {
  try {
    const res = await anthropic.forwardToCloud(cloudBase, apiKey, body, extraHeaders);
    if (body.stream && res.body) {
      const headers = createSSEHeaders();
      for (const [k, v] of Object.entries(headers)) c.header(k, v);
      return c.body(res.body as unknown as ReadableStream);
    }
    const data = await res.json();
    return c.json(data);
  } catch (err) {
    log('error', `Anthropic proxy forward failed: ${err instanceof Error ? err.message : String(err)}`);
    return c.json({ error: 'Proxy forward failed' }, 502);
  }
}

function extractApiKey(authHeader?: string): string {
  if (!authHeader) return '';
  return authHeader.replace(/^Bearer\s+/i, '');
}

const FORWARDED_HEADERS = ['user-agent', 'x-request-id'];

function extractForwardHeaders(headerFn: (name: string) => string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    for (const name of FORWARDED_HEADERS) {
      const val = headerFn(name);
      if (val) headers[name] = val;
    }
  } catch {
    // Hono test client may not support raw header access
  }
  return headers;
}

function normalizeOpenAIMessagesForCompaction(
  messages: Array<Record<string, unknown>>,
): Array<{ role: string; content: string }> {
  return messages.map((m) => ({
    role: typeof m.role === 'string' ? m.role : 'user',
    content: contentToText(m.content),
  }));
}

function applyOpenAICompactionBoundary(
  messages: Array<Record<string, unknown>>,
  summaryMessage: string,
): Array<Record<string, unknown>> {
  const systemMsg = messages.find((m) => m.role === 'system');
  const latestUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const compacted: Array<Record<string, unknown>> = [];

  if (systemMsg) compacted.push(systemMsg);
  compacted.push({ role: 'system', content: summaryMessage });
  if (latestUserMsg) compacted.push(latestUserMsg);

  return compacted;
}

function normalizeAnthropicMessagesForCompaction(
  request: anthropic.AnthropicRequest,
): Array<{ role: string; content: string }> {
  const normalized: Array<{ role: string; content: string }> = [];
  if (request.system) {
    normalized.push({
      role: 'system',
      content: Array.isArray(request.system)
        ? request.system.map((s) => contentToText(s.text)).join('\n')
        : contentToText(request.system),
    });
  }
  for (const m of request.messages) {
    normalized.push({
      role: m.role,
      content: contentToText(m.content),
    });
  }
  return normalized;
}

function applyAnthropicCompactionBoundary(
  request: anthropic.AnthropicRequest,
  summaryMessage: string,
): anthropic.AnthropicRequest {
  const latestUser = [...request.messages].reverse().find((m) => m.role === 'user');
  const priorSystem = request.system
    ? Array.isArray(request.system)
      ? request.system.map((s) => contentToText(s.text)).join('\n')
      : contentToText(request.system)
    : '';

  return {
    ...request,
    system: [priorSystem, summaryMessage].filter(Boolean).join('\n\n'),
    messages: latestUser ? [latestUser] : [],
  };
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      const rec = item as Record<string, unknown>;
      if (typeof rec.text === 'string') return rec.text;
      if (typeof rec.content === 'string') return rec.content;
      return JSON.stringify(rec);
    }).join('\n');
  }
  if (!content) return '';
  if (typeof content === 'object') return JSON.stringify(content);
  return String(content);
}

const SESSION_HEADERS = [
  'x-context-guardian-session',
  'x-session-id',
  'x-conversation-id',
  'anthropic-conversation-id',
  'openai-conversation-id',
];

function resolveSessionId(
  headerFn: (name: string) => string | undefined,
  body: Record<string, unknown>,
  provider: 'openai' | 'anthropic',
  apiKey: string,
): string {
  for (const name of SESSION_HEADERS) {
    const val = safeHeader(headerFn, name);
    if (val && val.trim()) return sanitizeSessionId(val);
  }

  const bodyId = firstStringField(body, [
    'session_id',
    'sessionId',
    'conversation_id',
    'conversationId',
    'thread_id',
    'threadId',
  ]);
  if (bodyId) return sanitizeSessionId(bodyId);

  const userAgent = safeHeader(headerFn, 'user-agent') || 'unknown';
  const model = typeof body.model === 'string' ? body.model : 'unknown-model';
  const date = new Date().toISOString().slice(0, 10);
  const seed = `${provider}|${apiKey || 'anonymous'}|${userAgent}|${model}|${date}`;
  const hash = createHash('sha1').update(seed).digest('hex').slice(0, 12);
  return `${provider}-${hash}`;
}

function firstStringField(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function sanitizeSessionId(input: string): string {
  const cleaned = input.trim().replace(/[^a-zA-Z0-9._:-]/g, '-');
  if (!cleaned) return `session-${Date.now()}`;
  return cleaned.slice(0, 120);
}

function safeHeader(
  headerFn: (name: string) => string | undefined,
  name: string,
): string | undefined {
  try {
    return headerFn(name);
  } catch {
    return undefined;
  }
}

function canExecuteTool(
  toolName: string,
  config: Config,
): { allowed: boolean; reason?: string } {
  if (!config.tools.includes(toolName)) {
    return { allowed: false, reason: `"${toolName}" not enabled in config.tools` };
  }

  const tool = getTool(toolName);
  const mode = tool?.definition.mode || 'read';
  if (mode !== 'execute') {
    return { allowed: true };
  }

  if (!config.tool_policy.allow_execution) {
    return { allowed: false, reason: 'execution tools disabled (tool_policy.allow_execution=false)' };
  }

  if (!config.tool_policy.allowed_execute_tools.includes(toolName)) {
    return { allowed: false, reason: `"${toolName}" not in tool_policy.allowed_execute_tools` };
  }

  return { allowed: true };
}

function applySessionScopeOverride(
  decision: ReturnType<typeof analyzeRequest>,
  sessionStore?: SessionStore,
  sessionId?: string,
): ReturnType<typeof analyzeRequest> {
  if (decision.shouldIntercept || !decision.signals.broadScopePrompt || !sessionStore) {
    return decision;
  }

  const chunkCount = sessionStore.getSessionChunkCount(sessionId);
  if (chunkCount < 8) {
    return decision;
  }

  const reasons = [...decision.reasons, ...decision.signals.scopeHintReasons, 'broad-scope prompt with indexed session corpus'];
  log('intercept', `Promoting request to context_shape due to broad scope with ${chunkCount} indexed session chunks`);
  return {
    ...decision,
    shouldIntercept: true,
    mode: 'context_shape',
    reasons: [...new Set(reasons)],
  };
}
