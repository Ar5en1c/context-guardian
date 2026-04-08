import { describe, it, expect } from 'vitest';
import { ConfigSchema, loadConfig } from '../src/config.js';

describe('ConfigSchema', () => {
  it('provides sensible defaults', () => {
    const config = ConfigSchema.parse({});
    expect(config.port).toBe(9119);
    expect(config.threshold_tokens).toBe(8000);
    expect(config.context_budget).toBe(4000);
    expect(config.intercept_policy.log_line_trigger).toBe(60);
    expect(config.intercept_policy.signal_score_threshold).toBe(3);
    expect(config.intercept_policy.min_context_shape_tokens).toBe(600);
    expect(config.local_llm.backend).toBe('ollama');
    expect(config.local_llm.model).toBe('qwen3.5:4b');
    expect(config.tools).toContain('log_search');
    expect(config.tools).toContain('grep');
    expect(config.tools).toContain('repo_map');
    expect(config.tools).toContain('run_checks');
    expect(config.tool_policy.allow_execution).toBe(true);
    expect(config.tool_policy.allowed_execute_tools).toContain('run_checks');
  });

  it('accepts overrides', () => {
    const config = ConfigSchema.parse({
      port: 8080,
      threshold_tokens: 4000,
      intercept_policy: { log_line_trigger: 40 },
      local_llm: { model: 'phi-4:3.8b' },
    });
    expect(config.port).toBe(8080);
    expect(config.threshold_tokens).toBe(4000);
    expect(config.intercept_policy.log_line_trigger).toBe(40);
    expect(config.local_llm.model).toBe('phi-4:3.8b');
    expect(config.local_llm.backend).toBe('ollama');
  });
});

describe('loadConfig', () => {
  it('returns default config when no file exists', () => {
    const config = loadConfig();
    expect(config.port).toBe(9119);
  });

  it('merges overrides', () => {
    const config = loadConfig({ port: 7777 });
    expect(config.port).toBe(7777);
    expect(config.threshold_tokens).toBe(8000);
  });
});
