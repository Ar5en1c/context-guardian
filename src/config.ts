import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_INTERCEPT_POLICY } from './proxy/interceptor.js';

export const ConfigSchema = z.object({
  port: z.number().default(9119),
  threshold_tokens: z.number().default(8000),
  context_budget: z.number().default(4000),
  intercept_policy: z.object({
    signal_score_threshold: z.number().default(DEFAULT_INTERCEPT_POLICY.signal_score_threshold),
    min_context_shape_tokens: z.number().default(DEFAULT_INTERCEPT_POLICY.min_context_shape_tokens),
    min_context_shape_lines: z.number().default(DEFAULT_INTERCEPT_POLICY.min_context_shape_lines),
    large_message_tokens: z.number().default(DEFAULT_INTERCEPT_POLICY.large_message_tokens),
    total_line_trigger: z.number().default(DEFAULT_INTERCEPT_POLICY.total_line_trigger),
    log_line_trigger: z.number().default(DEFAULT_INTERCEPT_POLICY.log_line_trigger),
    stacktrace_line_trigger: z.number().default(DEFAULT_INTERCEPT_POLICY.stacktrace_line_trigger),
    error_line_trigger: z.number().default(DEFAULT_INTERCEPT_POLICY.error_line_trigger),
    code_line_trigger: z.number().default(DEFAULT_INTERCEPT_POLICY.code_line_trigger),
    path_hint_trigger: z.number().default(DEFAULT_INTERCEPT_POLICY.path_hint_trigger),
  }).default({}),
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
  tools: z.array(z.string()).default([
    'log_search',
    'file_read',
    'grep',
    'summary',
    'repo_map',
    'file_tree',
    'symbol_find',
    'git_diff',
    'test_failures',
    'run_checks',
  ]),
  tool_policy: z.object({
    allow_execution: z.boolean().default(true),
    allowed_execute_tools: z.array(z.string()).default(['run_checks', 'test_failures']),
  }).default({}),
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
