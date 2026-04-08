import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { scenarios, type ScenarioName } from './run-benchmark.js';
import { countTokens } from '../src/proxy/interceptor.js';
import { rewriteRequest } from '../src/proxy/rewriter.js';
import { VectorStore } from '../src/index/store.js';
import { OllamaAdapter } from '../src/local-llm/ollama.js';

import '../src/tools/log-search.js';
import '../src/tools/file-read.js';
import '../src/tools/grep.js';
import '../src/tools/summary.js';
import '../src/tools/repo-map.js';
import '../src/tools/file-tree.js';
import '../src/tools/symbol-find.js';
import '../src/tools/git-diff.js';
import '../src/tools/test-failures.js';
import '../src/tools/run-checks.js';

type Provider = 'openai' | 'anthropic';
type Mode = 'proxy' | 'rewrite';

interface Check {
  key: string;
  question: string;
  expected: RegExp;
}

interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

interface EvalResult {
  scenario: string;
  raw: {
    usage: ProviderUsage;
    latencyMs: number;
    score: number;
    total: number;
  };
  guardian: {
    usage: ProviderUsage;
    latencyMs: number;
    score: number;
    total: number;
    mode: Mode;
  };
}

const CHECKS: Record<ScenarioName, Check[]> = {
  'auth-timeout': [
    { key: 'max_retries', question: 'What is max_retries?', expected: /\b0\b/i },
    { key: 'jwks_cache_ttl_ms', question: 'What is jwks_cache_ttl_ms?', expected: /\b3600000\b/i },
    { key: 'failure_threshold', question: 'What is failure_threshold?', expected: /\b5\b/i },
    { key: 'dns_issue', question: 'Which DNS failure appears?', expected: /\bservfail\b/i },
  ],
  'memory-leak': [
    { key: 'event_listeners', question: 'How many EventEmitter listeners are retained?', expected: /\b14302\b/i },
    { key: 'unfreed_response_mb', question: 'How many MB are in unfreed response bodies?', expected: /\b340\b/i },
    { key: 'pending_timeouts', question: 'How many setTimeout callbacks are pending?', expected: /\b2101\b/i },
    { key: 'patch_sha', question: 'What patch SHA is recommended?', expected: /\b9f2ab77\b/i },
  ],
  'api-migration': [
    { key: 'default_limit', question: 'What is the old default limit?', expected: /\b50\b/i },
    { key: 'rate_limit', question: 'What rate limit is required?', expected: /\b100\s*req\/min\b/i },
    { key: 'soft_delete_field', question: 'What field is used for soft delete?', expected: /\bdeleted_at\b/i },
    { key: 'rollout_strategy', question: 'What rollout strategy is specified?', expected: /\bcanary-10-25-50-100\b/i },
  ],
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const provider = (args.provider || 'openai') as Provider;
  const model = args.model || (provider === 'openai' ? 'gpt-4o-mini' : 'claude-3-5-sonnet-latest');
  const apiKey = args.apiKey || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  const providerBase = args.providerBase || defaultProviderBase(provider);
  const proxyBase = args.proxyBase || '';
  const mode: Mode = proxyBase ? 'proxy' : 'rewrite';
  const scenarioNames = parseScenarios(args.scenarios);
  const rawMaxTokens = Number(args.rawMaxTokens || 32000);
  const contextBudget = Number(args.contextBudget || 4000);

  if (!apiKey) {
    console.error('Missing API key. Pass --apiKey or set OPENAI_API_KEY / ANTHROPIC_API_KEY.');
    process.exit(1);
  }

  const llm = new OllamaAdapter(
    args.ollamaEndpoint || 'http://localhost:11434',
    args.localModel || 'qwen3.5:4b',
    args.embedModel || 'nomic-embed-text',
  );

  const results: EvalResult[] = [];
  for (const name of scenarioNames) {
    const scenario = scenarios[name]();
    const checks = CHECKS[name];
    const rawPrompt = buildPrompt(scenario.task, scenario.rawContext, checks);

    const rawRes = await callProvider({
      provider,
      baseUrl: providerBase,
      apiKey,
      model,
      prompt: truncateToTokens(rawPrompt, rawMaxTokens),
    });
    const rawParsed = parseAnswers(rawRes.text);
    const rawScore = scoreChecks(rawParsed, checks);

    let guardianPrompt = rawPrompt;
    if (!proxyBase) {
      const rewrite = await rewriteRequest(
        scenario.rawContext,
        [{ role: 'user', content: scenario.rawContext }],
        llm,
        new VectorStore(),
        ['log_search', 'file_read', 'grep', 'summary', 'repo_map', 'file_tree', 'symbol_find', 'git_diff', 'test_failures', 'run_checks'],
        contextBudget,
      );
      guardianPrompt = `${rewrite.messages.map((m) => `[${m.role}] ${m.content}`).join('\n\n')}\n\n${buildQuestionsBlock(checks)}`;
    }

    const guardianRes = proxyBase
      ? await callViaProxy({
        provider,
        proxyBase,
        apiKey,
        model,
        prompt: rawPrompt,
      })
      : await callProvider({
        provider,
        baseUrl: providerBase,
        apiKey,
        model,
        prompt: guardianPrompt,
      });

    const guardianParsed = parseAnswers(guardianRes.text);
    const guardianScore = scoreChecks(guardianParsed, checks);

    results.push({
      scenario: name,
      raw: {
        usage: rawRes.usage,
        latencyMs: rawRes.latencyMs,
        score: rawScore.correct,
        total: rawScore.total,
      },
      guardian: {
        usage: guardianRes.usage,
        latencyMs: guardianRes.latencyMs,
        score: guardianScore.correct,
        total: guardianScore.total,
        mode,
      },
    });
  }

  printReport(results, mode);
  if (args.json) {
    const out = resolve(process.cwd(), args.json);
    writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), provider, model, mode, results }, null, 2));
    console.log(`Saved JSON report: ${out}`);
  }
}

function buildPrompt(task: string, rawContext: string, checks: Check[]): string {
  return [
    `TASK: ${task}`,
    '',
    'CONTEXT:',
    rawContext,
    '',
    buildQuestionsBlock(checks),
  ].join('\n');
}

function buildQuestionsBlock(checks: Check[]): string {
  const q = checks.map((c, i) => `${i + 1}. (${c.key}) ${c.question}`).join('\n');
  return `Answer ONLY as strict JSON using this shape:
{"answers":{"<key>":"<value>"}}

Questions:
${q}`;
}

async function callProvider(input: {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
}): Promise<{ text: string; usage: ProviderUsage; latencyMs: number }> {
  const started = performance.now();
  if (input.provider === 'openai') {
    const res = await fetch(`${input.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        temperature: 0,
        messages: [{ role: 'user', content: input.prompt }],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI request failed: ${res.status} ${text.slice(0, 500)}`);
    }
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content || '';
    const usage = {
      inputTokens: data.usage?.prompt_tokens ?? countTokens(input.prompt),
      outputTokens: data.usage?.completion_tokens ?? countTokens(text),
    };
    return { text, usage, latencyMs: performance.now() - started };
  }

  const res = await fetch(`${input.baseUrl.replace(/\/$/, '')}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': input.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: 900,
      temperature: 0,
      messages: [{ role: 'user', content: input.prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic request failed: ${res.status} ${text.slice(0, 500)}`);
  }
  const data = await res.json() as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('\n');
  const usage = {
    inputTokens: data.usage?.input_tokens ?? countTokens(input.prompt),
    outputTokens: data.usage?.output_tokens ?? countTokens(text),
  };
  return { text, usage, latencyMs: performance.now() - started };
}

async function callViaProxy(input: {
  provider: Provider;
  proxyBase: string;
  apiKey: string;
  model: string;
  prompt: string;
}): Promise<{ text: string; usage: ProviderUsage; latencyMs: number }> {
  const started = performance.now();
  if (input.provider === 'openai') {
    const res = await fetch(`${input.proxyBase.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: 'user', content: input.prompt }],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Proxy(OpenAI) request failed: ${res.status} ${text.slice(0, 500)}`);
    }
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content || '';
    const usage = {
      inputTokens: data.usage?.prompt_tokens ?? countTokens(input.prompt),
      outputTokens: data.usage?.completion_tokens ?? countTokens(text),
    };
    return { text, usage, latencyMs: performance.now() - started };
  }

  const res = await fetch(`${input.proxyBase.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': input.apiKey,
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: 900,
      messages: [{ role: 'user', content: input.prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Proxy(Anthropic) request failed: ${res.status} ${text.slice(0, 500)}`);
  }
  const data = await res.json() as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('\n');
  const usage = {
    inputTokens: data.usage?.input_tokens ?? countTokens(input.prompt),
    outputTokens: data.usage?.output_tokens ?? countTokens(text),
  };
  return { text, usage, latencyMs: performance.now() - started };
}

function parseAnswers(text: string): Record<string, string> {
  const cleaned = text.trim().replace(/^```json/i, '').replace(/^```/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as { answers?: Record<string, unknown> };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.answers || {})) {
      out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

function scoreChecks(answers: Record<string, string>, checks: Check[]): { correct: number; total: number } {
  let correct = 0;
  for (const check of checks) {
    const value = answers[check.key] || '';
    if (check.expected.test(value)) correct++;
  }
  return { correct, total: checks.length };
}

function printReport(results: EvalResult[], mode: Mode) {
  console.log(`\n=== Provider A/B report (${mode}) ===`);
  let rawIn = 0;
  let rawOut = 0;
  let guardianIn = 0;
  let guardianOut = 0;
  let rawScore = 0;
  let guardianScore = 0;
  let total = 0;

  for (const r of results) {
    rawIn += r.raw.usage.inputTokens;
    rawOut += r.raw.usage.outputTokens;
    guardianIn += r.guardian.usage.inputTokens;
    guardianOut += r.guardian.usage.outputTokens;
    rawScore += r.raw.score;
    guardianScore += r.guardian.score;
    total += r.raw.total;

    console.log(`\n--- ${r.scenario} ---`);
    console.log(`raw      tokens(in/out): ${r.raw.usage.inputTokens}/${r.raw.usage.outputTokens} latency=${r.raw.latencyMs.toFixed(0)}ms score=${r.raw.score}/${r.raw.total}`);
    console.log(`guardian tokens(in/out): ${r.guardian.usage.inputTokens}/${r.guardian.usage.outputTokens} latency=${r.guardian.latencyMs.toFixed(0)}ms score=${r.guardian.score}/${r.guardian.total}`);
  }

  const rawAcc = total ? (rawScore / total) * 100 : 0;
  const guardianAcc = total ? (guardianScore / total) * 100 : 0;
  const inReduction = 100 * (1 - guardianIn / Math.max(1, rawIn));
  const billedRaw = rawIn + rawOut;
  const billedGuardian = guardianIn + guardianOut;
  const billedReduction = 100 * (1 - billedGuardian / Math.max(1, billedRaw));

  console.log('\n=== Aggregate ===');
  console.log(`Raw:      in=${rawIn} out=${rawOut} billed=${billedRaw} accuracy=${rawAcc.toFixed(1)}%`);
  console.log(`Guardian: in=${guardianIn} out=${guardianOut} billed=${billedGuardian} accuracy=${guardianAcc.toFixed(1)}%`);
  console.log(`Input token reduction: ${inReduction.toFixed(1)}%`);
  console.log(`Billed token reduction: ${billedReduction.toFixed(1)}%`);
}

function truncateToTokens(text: string, maxTokens: number): string {
  if (countTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (countTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

function parseScenarios(input: string | undefined): ScenarioName[] {
  if (!input || input === 'all') return ['auth-timeout', 'memory-leak', 'api-migration'];
  const values = input.split(',').map((s) => s.trim()).filter(Boolean) as ScenarioName[];
  return values.length > 0 ? values : ['auth-timeout'];
}

function defaultProviderBase(provider: Provider): string {
  return provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1';
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    args[key] = value;
  }
  return args;
}

void main();
