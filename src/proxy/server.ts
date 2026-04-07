import { Hono } from 'hono';
import type { Config } from '../config.js';
import type { LocalLLMAdapter } from '../local-llm/adapter.js';
import { VectorStore } from '../index/store.js';
import { analyzeRequest, extractRawContent } from './interceptor.js';
import { rewriteRequest } from './rewriter.js';
import { createSSEHeaders } from './streaming.js';
import { getTool } from '../tools/registry.js';
import * as openai from './adapters/openai.js';
import * as anthropic from './adapters/anthropic.js';
import { log } from '../display/logger.js';
import { logRequest } from '../display/request-log.js';
import type { Stats } from '../display/dashboard.js';
import { printStats } from '../display/dashboard.js';

import '../tools/log-search.js';
import '../tools/file-read.js';
import '../tools/grep.js';
import '../tools/summary.js';

const MAX_TOOL_ROUNDS = 10;

export function createProxyServer(config: Config, llm: LocalLLMAdapter, stats: Stats) {
  const app = new Hono();
  const store = new VectorStore();

  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      version: '0.1.0',
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
    return handleOpenAIRequest(c, config, llm, store, stats);
  });

  // Also handle without /v1 prefix
  app.post('/chat/completions', async (c) => {
    return handleOpenAIRequest(c, config, llm, store, stats);
  });

  // Anthropic-compatible: POST /v1/messages
  app.post('/v1/messages', async (c) => {
    return handleAnthropicRequest(c, config, llm, store, stats);
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
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const promises = toolCalls.map(async (tc) => {
    const tool = getTool(tc.function.name);
    if (!tool) {
      results.set(tc.id, `Unknown tool: ${tc.function.name}`);
      return;
    }
    try {
      const args = JSON.parse(tc.function.arguments);
      const result = await tool.handler(args, { store, llm });
      results.set(tc.id, result);
      log('debug', `Tool ${tc.function.name} returned ${result.length} chars`);
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
  const extraHeaders = extractForwardHeaders(c.req.header);
  const messages = openai.extractMessages(body);
  const decision = analyzeRequest(messages, config.threshold_tokens);

  if (!decision.shouldIntercept) {
    stats.passedThrough++;
    logRequest('passthrough', 'openai', decision.totalTokens, body.model);
    return forwardOpenAIPassthrough(config.cloud.openai_base, apiKey, body, c, extraHeaders);
  }

  stats.intercepted++;

  try {
    const rawContent = extractRawContent(messages);
    const rewrite = await rewriteRequest(
      rawContent, messages, llm, store, config.tools, config.context_budget,
    );

    stats.tokensSaved += rewrite.inputTokens - rewrite.outputTokens;
    stats.lastIntercept = {
      inTokens: rewrite.inputTokens,
      outTokens: rewrite.outputTokens,
      goal: rewrite.goal,
      toolsInjected: rewrite.toolNames,
    };
    printStats(stats);
    logRequest('intercept', 'openai', rewrite.inputTokens, body.model, rewrite.goal, rewrite.outputTokens);

    const forwardReq = openai.buildForwardRequest(body, rewrite.messages, rewrite.tools);

    if (body.stream) {
      const cloudResponse = await openai.forwardToCloud(config.cloud.openai_base, apiKey, forwardReq, extraHeaders);
      if (!cloudResponse.body) return c.json({ error: 'No response body from cloud' }, 502);
      const headers = createSSEHeaders();
      for (const [k, v] of Object.entries(headers)) c.header(k, v);
      return c.body(cloudResponse.body as unknown as ReadableStream);
    }

    // Multi-round tool call loop
    let currentReq = forwardReq;
    let currentMessages = [...forwardReq.messages] as Array<Record<string, unknown>>;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const cloudResponse = await openai.forwardToCloud(config.cloud.openai_base, apiKey, currentReq, extraHeaders);
      const responseData = (await cloudResponse.json()) as openai.OpenAIResponse;

      if (!openai.hasToolCalls(responseData)) {
        return c.json(responseData);
      }

      const toolCalls = openai.extractToolCalls(responseData);
      log('intercept', `Tool round ${round + 1}: ${toolCalls.map((t) => t.function.name).join(', ')}`);

      const results = await executeToolCalls(toolCalls, store, llm);
      const toolResultMsgs = openai.buildToolResultMessages(toolCalls, results);

      currentMessages = [
        ...currentMessages,
        responseData.choices[0].message as unknown as Record<string, unknown>,
        ...toolResultMsgs,
      ];
      currentReq = { ...forwardReq, messages: currentMessages as openai.OpenAIRequest['messages'] };
    }

    log('warn', `Hit max tool rounds (${MAX_TOOL_ROUNDS}), forcing final response`);
    const finalReq = { ...currentReq };
    delete finalReq.tools;
    delete finalReq.tool_choice;
    const finalRes = await openai.forwardToCloud(config.cloud.openai_base, apiKey, finalReq, extraHeaders);
    const finalData = await finalRes.json();
    return c.json(finalData);
  } catch (err) {
    log('error', `Intercept failed, falling back to passthrough: ${err instanceof Error ? err.message : String(err)}`);
    stats.passedThrough++;
    stats.intercepted--;
    return forwardOpenAIPassthrough(config.cloud.openai_base, apiKey, body, c, extraHeaders);
  }
}

async function handleAnthropicRequest(
  c: { req: { json: () => Promise<unknown>; header: (name: string) => string | undefined }; json: (data: unknown, status?: number) => Response; header: (name: string, value: string) => void; body: (data: ReadableStream) => Response },
  config: Config,
  llm: LocalLLMAdapter,
  store: VectorStore,
  stats: Stats,
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
  const extraHeaders = extractForwardHeaders(c.req.header);
  const messages = anthropic.extractMessages(body);
  const decision = analyzeRequest(messages, config.threshold_tokens);

  if (!decision.shouldIntercept) {
    stats.passedThrough++;
    logRequest('passthrough', 'anthropic', decision.totalTokens, body.model);
    return forwardAnthropicPassthrough(config.cloud.anthropic_base, apiKey, body, c, extraHeaders);
  }

  stats.intercepted++;

  try {
    const rawContent = extractRawContent(messages);
    const rewrite = await rewriteRequest(
      rawContent, messages, llm, store, config.tools, config.context_budget,
    );

    stats.tokensSaved += rewrite.inputTokens - rewrite.outputTokens;
    stats.lastIntercept = {
      inTokens: rewrite.inputTokens,
      outTokens: rewrite.outputTokens,
      goal: rewrite.goal,
      toolsInjected: rewrite.toolNames,
    };
    printStats(stats);
    logRequest('intercept', 'anthropic', rewrite.inputTokens, body.model, rewrite.goal, rewrite.outputTokens);

    const forwardReq = anthropic.buildForwardRequest(body, rewrite.messages, rewrite.tools);

    if (body.stream && !config.verbose) {
      const cloudResponse = await anthropic.forwardToCloud(config.cloud.anthropic_base, apiKey, forwardReq, extraHeaders);
      if (cloudResponse.body) {
        const headers = createSSEHeaders();
        for (const [k, v] of Object.entries(headers)) c.header(k, v);
        return c.body(cloudResponse.body as unknown as ReadableStream);
      }
    }

    // Multi-round tool call loop for Anthropic
    let currentReq = forwardReq;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const cloudResponse = await anthropic.forwardToCloud(config.cloud.anthropic_base, apiKey, currentReq, extraHeaders);
      const responseData = (await cloudResponse.json()) as anthropic.AnthropicResponse;

      if (!anthropic.hasToolUse(responseData)) {
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
        try {
          const result = await tool.handler(tu.input as Record<string, unknown>, { store, llm });
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
        } catch (err) {
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Error: ${err instanceof Error ? err.message : String(err)}` });
        }
      }

      currentReq = anthropic.appendToolResults(currentReq, responseData, toolResults);
    }

    log('warn', `Hit max tool rounds (${MAX_TOOL_ROUNDS}) on Anthropic, forcing final`);
    const finalReq = { ...currentReq };
    delete finalReq.tools;
    const finalRes = await anthropic.forwardToCloud(config.cloud.anthropic_base, apiKey, finalReq, extraHeaders);
    const finalData = await finalRes.json();
    return c.json(finalData);
  } catch (err) {
    log('error', `Anthropic intercept failed, falling back: ${err instanceof Error ? err.message : String(err)}`);
    stats.passedThrough++;
    stats.intercepted--;
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
    return c.json({ error: `Proxy forward failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
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
    return c.json({ error: `Proxy forward failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
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
