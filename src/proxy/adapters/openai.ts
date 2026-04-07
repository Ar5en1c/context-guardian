import { log } from '../../display/logger.js';

export interface OpenAIRequest {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  [key: string]: unknown;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIResponse {
  id: string;
  object: string;
  choices: Array<{
    index: number;
    message: OpenAIMessage;
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export function isOpenAIFormat(body: unknown): body is OpenAIRequest {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return Array.isArray(b.messages) && typeof b.model === 'string';
}

export function extractMessages(req: OpenAIRequest): Array<{ role: string; content: unknown }> {
  return req.messages.map((m) => ({ role: m.role, content: m.content }));
}

export function buildForwardRequest(
  original: OpenAIRequest,
  rewrittenMessages: Array<{ role: string; content: string }>,
  tools: unknown[],
): OpenAIRequest {
  const forwarded: OpenAIRequest = { ...original };
  forwarded.messages = rewrittenMessages;

  if (tools.length > 0) {
    forwarded.tools = [...(original.tools || []), ...tools];
    if (!forwarded.tool_choice) {
      forwarded.tool_choice = 'auto';
    }
  }

  return forwarded;
}

export async function forwardToCloud(
  cloudBase: string,
  apiKey: string,
  request: OpenAIRequest,
): Promise<Response> {
  const url = `${cloudBase.replace(/\/$/, '')}/chat/completions`;

  log('debug', `Forwarding to ${url}`, { model: request.model, stream: request.stream });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };

  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });
}

export function hasToolCalls(response: OpenAIResponse): boolean {
  return response.choices?.some(
    (c) => c.message?.tool_calls && c.message.tool_calls.length > 0
  ) ?? false;
}

export function extractToolCalls(response: OpenAIResponse): OpenAIToolCall[] {
  const calls: OpenAIToolCall[] = [];
  for (const choice of response.choices || []) {
    if (choice.message?.tool_calls) {
      calls.push(...choice.message.tool_calls);
    }
  }
  return calls;
}

export function buildToolResultMessages(
  toolCalls: OpenAIToolCall[],
  results: Map<string, string>,
): Array<{ role: string; tool_call_id: string; content: string }> {
  return toolCalls.map((tc) => ({
    role: 'tool',
    tool_call_id: tc.id,
    content: results.get(tc.id) || 'Tool execution failed',
  }));
}
