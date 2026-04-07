import { Hono } from 'hono';
import { VectorStore } from '../index/store.js';
import { getTool, getAllToolNames, getToolDefinitions } from '../tools/registry.js';
import type { LocalLLMAdapter } from '../local-llm/adapter.js';
import { log } from '../display/logger.js';

import '../tools/log-search.js';
import '../tools/file-read.js';
import '../tools/grep.js';
import '../tools/summary.js';

export function createMCPServer(llm: LocalLLMAdapter) {
  const app = new Hono();
  const store = new VectorStore();

  // MCP initialize
  app.post('/mcp', async (c) => {
    const body = await c.req.json() as { method: string; id?: unknown; params?: unknown };

    switch (body.method) {
      case 'initialize':
        return c.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'context-guardian', version: '0.2.0' },
            capabilities: { tools: {} },
          },
        });

      case 'tools/list':
        return c.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: getToolDefinitions(getAllToolNames()).map((d) => ({
              name: d.name,
              description: d.description,
              inputSchema: { type: 'object', properties: d.parameters.properties || {}, required: d.parameters.required || [] },
            })),
          },
        });

      case 'tools/call': {
        const params = body.params as { name: string; arguments?: Record<string, unknown> };
        const tool = getTool(params.name);
        if (!tool) {
          return c.json({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32601, message: `Unknown tool: ${params.name}` },
          });
        }

        try {
          const result = await tool.handler(params.arguments || {}, { store, llm });
          return c.json({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: result }] },
          });
        } catch (err) {
          return c.json({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
      }

      case 'notifications/initialized':
        return c.json({ jsonrpc: '2.0' });

      default:
        return c.json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32601, message: `Unknown method: ${body.method}` },
        });
    }
  });

  return { app, store };
}
