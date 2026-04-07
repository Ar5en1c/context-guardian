import type { VectorStore } from '../index/store.js';
import type { LocalLLMAdapter } from '../local-llm/adapter.js';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolContext {
  store: VectorStore;
  llm: LocalLLMAdapter;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

export interface Tool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

const tools = new Map<string, Tool>();

export function registerTool(tool: Tool) {
  tools.set(tool.definition.name, tool);
}

export function getTool(name: string): Tool | undefined {
  return tools.get(name);
}

export function getToolDefinitions(enabledTools: string[]): ToolDefinition[] {
  return enabledTools
    .map((name) => tools.get(name)?.definition)
    .filter((d): d is ToolDefinition => d !== undefined);
}

export function getAllToolNames(): string[] {
  return Array.from(tools.keys());
}

export function toOpenAIToolFormat(defs: ToolDefinition[]): unknown[] {
  return defs.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: d.parameters,
    },
  }));
}
