import { describe, it, expect } from 'vitest';
import { ConfigSchema, loadConfig } from '../src/config.js';

describe('ConfigSchema', () => {
  it('provides sensible defaults', () => {
    const config = ConfigSchema.parse({});
    expect(config.port).toBe(9119);
    expect(config.threshold_tokens).toBe(8000);
    expect(config.context_budget).toBe(4000);
    expect(config.local_llm.backend).toBe('ollama');
    expect(config.local_llm.model).toBe('qwen3.5:4b');
    expect(config.tools).toContain('log_search');
    expect(config.tools).toContain('grep');
  });

  it('accepts overrides', () => {
    const config = ConfigSchema.parse({
      port: 8080,
      threshold_tokens: 4000,
      local_llm: { model: 'phi-4:3.8b' },
    });
    expect(config.port).toBe(8080);
    expect(config.threshold_tokens).toBe(4000);
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
