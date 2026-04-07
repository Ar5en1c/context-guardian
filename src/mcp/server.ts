import { Hono } from 'hono';
import { VectorStore } from '../index/store.js';
import { chunkText } from '../index/chunker.js';
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

      case 'tools/list': {
        const ragTools = getToolDefinitions(getAllToolNames()).map((d) => ({
          name: d.name,
          description: d.description,
          inputSchema: { type: 'object', properties: d.parameters.properties || {}, required: d.parameters.required || [] },
        }));
        const indexTool = {
          name: 'index_content',
          description: 'Index raw text content (logs, code, config, etc.) into the Context Guardian store for later retrieval. Call this first before using log_search, grep, file_read, or summary.',
          inputSchema: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'The raw text content to index (logs, code, stack traces, etc.)' },
              source: { type: 'string', description: 'Source label for the content (e.g. "server.log", "auth.ts")' },
            },
            required: ['content'],
          },
        };
        return c.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [indexTool, ...ragTools] },
        });
      }

      case 'tools/call': {
        const params = body.params as { name: string; arguments?: Record<string, unknown> };

        // Handle index_content specially
        if (params.name === 'index_content') {
          try {
            const content = String(params.arguments?.content || '');
            const source = String(params.arguments?.source || 'mcp-input');
            if (!content.trim()) {
              return c.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'Error: content is empty' }] } });
            }
            const chunks = chunkText(content, { source });
            const classified = await llm.classifyChunks(chunks.map((c) => c.text));
            for (let i = 0; i < chunks.length; i++) {
              if (classified[i]) chunks[i].label = classified[i].label;
            }
            let embeddings: number[][] = [];
            try {
              embeddings = await llm.embed(chunks.map((c) => c.text));
            } catch {
              embeddings = chunks.map(() => []);
            }
            store.addBatch(chunks, embeddings);
            const labels = chunks.map((c) => c.label);
            const labelSummary = [...new Set(labels)].map((l) => `${l}(${labels.filter((x) => x === l).length})`).join(', ');
            return c.json({
              jsonrpc: '2.0',
              id: body.id,
              result: { content: [{ type: 'text', text: `Indexed ${chunks.length} chunks from "${source}". Labels: ${labelSummary}. Store now has ${store.size} total chunks. Use log_search, grep, file_read, or summary to query.` }] },
            });
          } catch (err) {
            return c.json({
              jsonrpc: '2.0',
              id: body.id,
              error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
            });
          }
        }

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
