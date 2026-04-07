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

export async function forwardToCloud(
  cloudBase: string,
  apiKey: string,
  request: AnthropicRequest,
): Promise<Response> {
  const url = `${cloudBase.replace(/\/$/, '')}/v1/messages`;

  log('debug', `Forwarding to Anthropic: ${url}`, { model: request.model });

  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(request),
  });
}
