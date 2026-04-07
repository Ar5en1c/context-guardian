import { describe, it, expect } from 'vitest';
import {
  isAnthropicFormat,
  extractMessages,
  hasToolUse,
  extractToolUse,
  appendToolResults,
  type AnthropicResponse,
  type AnthropicRequest,
} from '../src/proxy/adapters/anthropic.js';

describe('isAnthropicFormat', () => {
  it('detects valid Anthropic requests', () => {
    expect(isAnthropicFormat({
      model: 'claude-3-opus',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    })).toBe(true);
  });

  it('rejects OpenAI-only format (missing max_tokens)', () => {
    expect(isAnthropicFormat({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }],
    })).toBe(false);
  });
});

describe('extractMessages', () => {
  it('extracts system from string', () => {
    const req: AnthropicRequest = {
      model: 'claude-3',
      messages: [{ role: 'user', content: 'Hi' }],
      system: 'Be helpful.',
      max_tokens: 1024,
    };
    const msgs = extractMessages(req);
    expect(msgs[0]).toEqual({ role: 'system', content: 'Be helpful.' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'Hi' });
  });

  it('extracts system from array blocks', () => {
    const req: AnthropicRequest = {
      model: 'claude-3',
      messages: [{ role: 'user', content: 'Hi' }],
      system: [{ type: 'text', text: 'Part 1.' }, { type: 'text', text: 'Part 2.' }],
      max_tokens: 1024,
    };
    const msgs = extractMessages(req);
    expect(msgs[0].content).toBe('Part 1.\nPart 2.');
  });
});

describe('hasToolUse', () => {
  it('detects tool_use stop reason', () => {
    const resp: AnthropicResponse = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'tu_1', name: 'grep', input: { pattern: 'ERROR' } },
      ],
      stop_reason: 'tool_use',
    };
    expect(hasToolUse(resp)).toBe(true);
  });

  it('returns false for normal responses', () => {
    const resp: AnthropicResponse = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Done.' }],
      stop_reason: 'end_turn',
    };
    expect(hasToolUse(resp)).toBe(false);
  });
});

describe('extractToolUse', () => {
  it('extracts tool use blocks', () => {
    const resp: AnthropicResponse = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Searching...' },
        { type: 'tool_use', id: 'tu_1', name: 'log_search', input: { query: 'auth error' } },
        { type: 'tool_use', id: 'tu_2', name: 'grep', input: { pattern: 'timeout' } },
      ],
      stop_reason: 'tool_use',
    };
    const blocks = extractToolUse(resp);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].name).toBe('log_search');
    expect(blocks[1].name).toBe('grep');
  });
});

describe('appendToolResults', () => {
  it('builds continuation request with tool results', () => {
    const req: AnthropicRequest = {
      model: 'claude-3',
      messages: [{ role: 'user', content: 'Fix the bug' }],
      max_tokens: 1024,
    };
    const resp: AnthropicResponse = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me search.' },
        { type: 'tool_use', id: 'tu_1', name: 'grep', input: { pattern: 'ERROR' } },
      ],
      stop_reason: 'tool_use',
    };
    const results = [{ type: 'tool_result' as const, tool_use_id: 'tu_1', content: 'Found 3 errors' }];
    const continued = appendToolResults(req, resp, results);

    expect(continued.messages).toHaveLength(3);
    expect(continued.messages[0].role).toBe('user');
    expect(continued.messages[1].role).toBe('assistant');
    expect(continued.messages[2].role).toBe('user');
  });
});
