import { log } from '../../display/logger.js';

export interface AnthropicRequest {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  system?: string | Array<{ type: string; text: string }>;
  tools?: unknown[];
  max_tokens: number;
  stream?: boolean;
  [key: string]: unknown;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason: string | null;
  usage?: { input_tokens: number; output_tokens: number };
}

export function isAnthropicFormat(body: unknown): body is AnthropicRequest {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return Array.isArray(b.messages) && typeof b.model === 'string' && typeof b.max_tokens === 'number';
}

export function extractMessages(req: AnthropicRequest): Array<{ role: string; content: unknown }> {
  const msgs: Array<{ role: string; content: unknown }> = [];

  if (req.system) {
    const systemText = typeof req.system === 'string'
      ? req.system
      : req.system.map((s) => s.text).join('\n');
    msgs.push({ role: 'system', content: systemText });
  }

  for (const m of req.messages) {
    msgs.push({ role: m.role, content: m.content });
  }

  return msgs;
}

export function buildForwardRequest(
  original: AnthropicRequest,
  rewrittenMessages: Array<{ role: string; content: string }>,
  tools: unknown[],
): AnthropicRequest {
  const forwarded: AnthropicRequest = { ...original };

  const systemMsg = rewrittenMessages.find((m) => m.role === 'system');
  const nonSystemMsgs = rewrittenMessages.filter((m) => m.role !== 'system');

  if (systemMsg) {
    forwarded.system = systemMsg.content;
  }
  forwarded.messages = nonSystemMsgs;

  if (tools.length > 0) {
    const anthropicTools = tools.map((t: unknown) => {
      const tool = t as { type: string; function: { name: string; description: string; parameters: unknown } };
      return {
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters,
      };
    });
    forwarded.tools = [...(original.tools || []), ...anthropicTools];
  }

  return forwarded;
}

export function hasToolUse(response: AnthropicResponse): boolean {
  return response.stop_reason === 'tool_use' ||
    response.content?.some((b) => b.type === 'tool_use') === true;
}

export function extractToolUse(response: AnthropicResponse): ToolUseBlock[] {
  return (response.content || [])
    .filter((b): b is ToolUseBlock => b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string')
    .map((b) => ({ type: 'tool_use' as const, id: b.id!, name: b.name!, input: b.input }));
}

export function appendToolResults(
  request: AnthropicRequest,
  assistantResponse: AnthropicResponse,
  toolResults: ToolResultBlock[],
): AnthropicRequest {
  const updatedMessages = [
    ...request.messages,
    { role: 'assistant', content: assistantResponse.content },
    { role: 'user', content: toolResults },
  ];

  return { ...request, messages: updatedMessages };
}

export async function forwardToCloud(
  cloudBase: string,
  apiKey: string,
  request: AnthropicRequest,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const url = `${cloudBase.replace(/\/$/, '')}/v1/messages`;

  log('debug', `Forwarding to Anthropic: ${url}`, { model: request.model });

  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      ...extraHeaders,
    },
    body: JSON.stringify(request),
  });
}
