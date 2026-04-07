import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const ConfigSchema = z.object({
  port: z.number().default(9119),
  threshold_tokens: z.number().default(8000),
  context_budget: z.number().default(4000),
  local_llm: z.object({
    backend: z.enum(['ollama', 'llamacpp', 'custom']).default('ollama'),
    model: z.string().default('qwen3.5:4b'),
    endpoint: z.string().default('http://localhost:11434'),
    embed_model: z.string().default('nomic-embed-text'),
  }).default({}),
  cloud: z.object({
    openai_base: z.string().default('https://api.openai.com/v1'),
    anthropic_base: z.string().default('https://api.anthropic.com'),
  }).default({}),
  tools: z.array(z.string()).default(['log_search', 'file_read', 'grep', 'summary']),
  verbose: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

const CONFIG_FILENAMES = ['guardian.config.json', '.guardian.json'];

export function loadConfig(overrides: Partial<Config> = {}): Config {
  let fileConfig: Record<string, unknown> = {};

  for (const name of CONFIG_FILENAMES) {
    const p = resolve(process.cwd(), name);
    if (existsSync(p)) {
      try {
        fileConfig = JSON.parse(readFileSync(p, 'utf-8'));
      } catch {
        // ignore malformed config
      }
      break;
    }
  }

  return ConfigSchema.parse({ ...fileConfig, ...overrides });
}
