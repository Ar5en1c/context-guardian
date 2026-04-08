import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scenarios, type ScenarioName } from './run-benchmark.js';
import { countTokens } from '../src/proxy/interceptor.js';
import { createMCPServer } from '../src/mcp/server.js';
import type { LocalLLMAdapter } from '../src/local-llm/adapter.js';

type ExtractFn = (text: string) => string | null;

interface Probe {
  id: string;
  question: string;
  grepPattern: string;
  expected: string;
  extract: ExtractFn;
  isCorrect?: (answer: string | null, expected: string) => boolean;
}

interface ScenarioSpec {
  name: ScenarioName;
  title: string;
  frontFacts: string;
  tailFacts: string;
  probes: Probe[];
}

interface ApproachMetrics {
  cloudInputTokens: number;
  cloudOutputTokens: number;
  localIndexTokens: number;
  indexTimeMs: number;
  probeTimeMs: number;
  accuracy: number;
  precision: number;
  correct: number;
  total: number;
  answered: number;
}

interface BenchmarkReport {
  generatedAt: string;
  contextWindowTokens: number;
  scenarios: Array<{
    scenario: string;
    expandedTokens: number;
    truncatedTokens: number;
    raw: ApproachMetrics;
    mcp: ApproachMetrics;
  }>;
  aggregate: {
    raw: {
      accuracy: number;
      precision: number;
      cloudInputTokens: number;
      cloudOutputTokens: number;
      totalTimeMs: number;
      totalCorrect: number;
      totalQuestions: number;
    };
    mcp: {
      accuracy: number;
      precision: number;
      cloudInputTokens: number;
      cloudOutputTokens: number;
      localIndexTokens: number;
      totalTimeMs: number;
      totalCorrect: number;
      totalQuestions: number;
    };
    cloudInputReductionPct: number;
    cloudBilledReductionPct: number;
    accuracyDeltaPoints: number;
  };
}

const RAW_CONTEXT_WINDOW_TOKENS = 32000;

const mockLLM: LocalLLMAdapter = {
  name: 'benchmark-mock',
  isAvailable: async () => true,
  extractIntent: async () => 'Benchmark evaluation',
  classifyChunks: async (chunks) =>
    chunks.map((chunk) => {
      const lower = chunk.toLowerCase();
      if (lower.includes('error') || lower.includes('fatal')) return { label: 'error', chunk };
      if (/\d{4}-\d{2}-\d{2}/.test(chunk)) return { label: 'log', chunk };
      if (lower.includes('function ') || lower.includes('import ') || lower.includes('const ')) return { label: 'code', chunk };
      return { label: 'other', chunk };
    }),
  summarize: async (text) => text.slice(0, 180),
  embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
};

const scenarioSpecs: ScenarioSpec[] = [
  {
    name: 'auth-timeout',
    title: 'Auth timeout debugging',
    frontFacts: `EARLY INCIDENT SNAPSHOT:
- service=auth
- primary symptom=JWT validation timeout`,
    tailFacts: `LATEST INCIDENT NOTES (tail section):
retry_backoff_ms: 200,400,800
incident_ticket: INC-9471
owner: platform-auth`,
    probes: [
      probe('max_retries', 'What is max_retries?', 'max_retries', '0', capture(/max_retries:\s*(\d+)/i)),
      probe('jwks_ttl', 'What is jwks_cache_ttl_ms?', 'jwks_cache_ttl_ms', '3600000', capture(/jwks_cache_ttl_ms:\s*(\d+)/i)),
      probe('failure_threshold', 'What is circuit breaker failure_threshold?', 'failure_threshold', '5', capture(/failure_threshold:\s*(\d+)/i)),
      probe('dns_code', 'Which DNS failure appears?', 'SERVFAIL', 'SERVFAIL', capture(/(SERVFAIL)/i)),
      probe('retry_backoff', 'What retry backoff schedule was proposed?', 'retry_backoff_ms', '200,400,800', capture(/retry_backoff_ms:\s*([0-9, ]+)/i)),
      probe('incident_ticket', 'What is the incident ticket id?', 'incident_ticket', 'INC-9471', capture(/incident_ticket:\s*(INC-\d+)/i)),
    ],
  },
  {
    name: 'memory-leak',
    title: 'Memory leak triage',
    frontFacts: `EARLY TRIAGE NOTES:
- symptom=memory growth over hours
- component=websocket gateway`,
    tailFacts: `LATEST TRIAGE ADDENDUM (tail section):
recommended_patch_sha: 9f2ab77
max_room_history_entries: 5000
leak_fix_priority: P0`,
    probes: [
      probe('listeners_peak', 'How many EventEmitter listeners are retained?', 'EventEmitter listeners', '14302', capture(/EventEmitter listeners:\s*([\d,]+)/i), (answer, expected) => normalizeNumber(answer) === normalizeNumber(expected)),
      probe('history_mb', 'How many MB are in unfreed response bodies?', 'Unfreed response bodies', '340', capture(/Unfreed response bodies:\s*(\d+)\s*MB/i)),
      probe('sync_handler_leak', 'Is listener cleanup missing after release?', 'NOT removed after release', 'yes', capture(/NOT removed after release/i), (answer) => Boolean(answer)),
      probe('pending_callbacks', 'How many setTimeout callbacks are pending?', 'setTimeout callbacks pending', '2101', capture(/setTimeout callbacks pending:\s*([\d,]+)/i), (answer, expected) => normalizeNumber(answer) === normalizeNumber(expected)),
      probe('patch_sha', 'What patch SHA is recommended?', 'recommended_patch_sha', '9f2ab77', capture(/recommended_patch_sha:\s*([a-f0-9]+)/i)),
      probe('history_cap', 'What max_room_history_entries is proposed?', 'max_room_history_entries', '5000', capture(/max_room_history_entries:\s*(\d+)/i)),
    ],
  },
  {
    name: 'api-migration',
    title: 'API migration execution',
    frontFacts: `EARLY MIGRATION BRIEF:
- target=v2 user APIs
- need=validation + pagination + error contracts`,
    tailFacts: `LATEST PROGRAM UPDATE (tail section):
migration_deadline: 2026-05-01
rollout_strategy: canary-10-25-50-100
compatibility_window_days: 14`,
    probes: [
      probe('default_limit', 'What is the old default page limit?', 'limit = 50', '50', capture(/limit\s*=\s*(\d+)/i)),
      probe('rate_limit', 'What rate limit is required?', '100 req/min', '100req/min', capture(/(100\s*req\/min)/i), (answer, expected) => normalizeText(answer) === normalizeText(expected)),
      probe('soft_delete', 'What field is used for soft delete?', 'deleted_at', 'deleted_at', capture(/(deleted_at)/i)),
      probe('error_format', 'Which keys are required in standardized errors?', 'code, message, details', 'code,message,details', capture(/code,\s*message,\s*details/i), (answer, expected) => normalizeText(answer) === normalizeText(expected)),
      probe('migration_deadline', 'What is migration_deadline?', 'migration_deadline', '2026-05-01', capture(/migration_deadline:\s*([0-9-]+)/i)),
      probe('rollout_strategy', 'What rollout strategy is specified?', 'rollout_strategy', 'canary-10-25-50-100', capture(/rollout_strategy:\s*([a-z0-9-]+)/i)),
    ],
  },
];

async function main() {
  const scenarioRows: Array<{
    scenario: string;
    expandedTokens: number;
    truncatedTokens: number;
    raw: ApproachMetrics;
    mcp: ApproachMetrics;
  }> = [];

  for (const spec of scenarioSpecs) {
    const base = scenarios[spec.name]();
    const expandedContext = buildExpandedContext(base.rawContext, spec.frontFacts, spec.tailFacts, spec.name);
    const expandedTokens = countTokens(expandedContext);
    const truncatedContext = truncateToTokenBudget(expandedContext, RAW_CONTEXT_WINDOW_TOKENS);
    const truncatedTokens = countTokens(truncatedContext);

    const raw = evaluateRaw(spec, base.task, truncatedContext);
    const mcp = await evaluateMCP(spec, base.task, expandedContext);

    scenarioRows.push({
      scenario: spec.title,
      expandedTokens,
      truncatedTokens,
      raw,
      mcp,
    });
  }

  const report = printReport(scenarioRows);
  const jsonPath = getJsonOutputPath();
  if (jsonPath) {
    const absolute = resolve(process.cwd(), jsonPath);
    writeFileSync(absolute, JSON.stringify(report, null, 2) + '\n');
    console.log(`\nSaved JSON report: ${absolute}`);
  }
}

function evaluateRaw(spec: ScenarioSpec, task: string, truncatedContext: string): ApproachMetrics {
  let cloudInputTokens = 0;
  let cloudOutputTokens = 0;
  let correct = 0;
  let answered = 0;
  let probeTimeMs = 0;

  for (const p of spec.probes) {
    const promptTokens = countTokens(`${task}\n\n${truncatedContext}\n\nQuestion: ${p.question}`);
    cloudInputTokens += promptTokens;

    const t0 = performance.now();
    const answer = p.extract(truncatedContext);
    probeTimeMs += performance.now() - t0;

    const output = answer || 'NOT_FOUND';
    cloudOutputTokens += countTokens(output);

    if (answer) answered++;
    const isCorrect = (p.isCorrect || defaultCorrect)(answer, p.expected);
    if (isCorrect) correct++;
    if (process.env.BENCH_DEBUG === '1') {
      console.log(`[RAW][${spec.name}] ${p.id} => answer="${answer || 'NOT_FOUND'}" expected="${p.expected}" correct=${isCorrect}`);
    }
  }

  return finalizeMetrics({
    cloudInputTokens,
    cloudOutputTokens,
    localIndexTokens: 0,
    indexTimeMs: 0,
    probeTimeMs,
    correct,
    answered,
    total: spec.probes.length,
  });
}

async function evaluateMCP(spec: ScenarioSpec, task: string, expandedContext: string): Promise<ApproachMetrics> {
  const { app } = createMCPServer(mockLLM);
  let requestId = 1;

  let localIndexTokens = countTokens(expandedContext);
  let cloudInputTokens = 0;
  let cloudOutputTokens = 0;
  let correct = 0;
  let answered = 0;
  let probeTimeMs = 0;

  const indexStart = performance.now();
  await mcpCall(app, requestId++, 'index_content', { content: expandedContext, source: `${spec.name}.txt` });
  const indexTimeMs = performance.now() - indexStart;

  // Small coordinator prompt cloud side (much smaller than raw context replay)
  const coordinatorTokens = countTokens(task);
  cloudInputTokens += coordinatorTokens;

  for (const p of spec.probes) {
    const toolArgs = { pattern: p.grepPattern, context_lines: 1, limit: 20 };
    cloudInputTokens += countTokens(`${p.question}\n${JSON.stringify(toolArgs)}`);

    const t0 = performance.now();
    const toolText = await mcpCall(app, requestId++, 'grep', toolArgs);
    probeTimeMs += performance.now() - t0;

    cloudOutputTokens += countTokens(toolText);

    const answer = p.extract(toolText);
    if (answer) answered++;
    const isCorrect = (p.isCorrect || defaultCorrect)(answer, p.expected);
    if (isCorrect) correct++;
    if (process.env.BENCH_DEBUG === '1') {
      console.log(`[MCP][${spec.name}] ${p.id} => answer="${answer || 'NOT_FOUND'}" expected="${p.expected}" correct=${isCorrect}`);
    }
  }

  return finalizeMetrics({
    cloudInputTokens,
    cloudOutputTokens,
    localIndexTokens,
    indexTimeMs,
    probeTimeMs,
    correct,
    answered,
    total: spec.probes.length,
  });
}

function finalizeMetrics(input: {
  cloudInputTokens: number;
  cloudOutputTokens: number;
  localIndexTokens: number;
  indexTimeMs: number;
  probeTimeMs: number;
  correct: number;
  answered: number;
  total: number;
}): ApproachMetrics {
  const accuracy = input.total === 0 ? 0 : input.correct / input.total;
  const precision = input.answered === 0 ? 0 : input.correct / input.answered;
  return {
    cloudInputTokens: input.cloudInputTokens,
    cloudOutputTokens: input.cloudOutputTokens,
    localIndexTokens: input.localIndexTokens,
    indexTimeMs: input.indexTimeMs,
    probeTimeMs: input.probeTimeMs,
    accuracy,
    precision,
    correct: input.correct,
    total: input.total,
    answered: input.answered,
  };
}

async function mcpCall(
  app: ReturnType<typeof createMCPServer>['app'],
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const data = await res.json() as {
    result?: { content?: Array<{ type: string; text?: string }> };
    error?: { message?: string };
  };
  if (data.error) return `ERROR: ${data.error.message || 'unknown mcp error'}`;
  return data.result?.content?.[0]?.text || '';
}

function buildExpandedContext(base: string, frontFacts: string, tailFacts: string, label: string): string {
  const prefix = buildNoiseToTarget(`${label}-prefix`, 18000);
  const suffix = buildNoiseToTarget(`${label}-suffix`, 26000);
  return `${frontFacts}\n\n${prefix}\n\n${base}\n\n${suffix}\n\n${tailFacts}`;
}

function buildNoiseToTarget(label: string, targetTokens: number): string {
  const render = (lines: number) =>
    Array.from({ length: lines }, (_, i) =>
      `${label} telemetry line=${i} status=ok latency_ms=${(i % 97) + 3} cpu=${20 + (i % 50)} mem_mb=${200 + (i % 300)} request_id=req-${label}-${i}`,
    ).join('\n');

  let lines = Math.max(50, Math.floor(targetTokens / 30));
  let text = render(lines);
  let tokens = countTokens(text);

  for (let i = 0; i < 8; i++) {
    if (tokens >= targetTokens * 0.95 && tokens <= targetTokens * 1.05) break;
    const ratio = targetTokens / Math.max(1, tokens);
    lines = Math.max(50, Math.floor(lines * ratio));
    text = render(lines);
    tokens = countTokens(text);
  }

  while (tokens < targetTokens) {
    lines += 20;
    text = render(lines);
    tokens = countTokens(text);
  }
  return text;
}

function truncateToTokenBudget(text: string, budget: number): string {
  if (countTokens(text) <= budget) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const slice = text.slice(0, mid);
    if (countTokens(slice) <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo);
}

function printReport(rows: Array<{
  scenario: string;
  expandedTokens: number;
  truncatedTokens: number;
  raw: ApproachMetrics;
  mcp: ApproachMetrics;
}>): BenchmarkReport {
  const totals = rows.reduce(
    (acc, row) => {
      acc.raw.cloudInputTokens += row.raw.cloudInputTokens;
      acc.raw.cloudOutputTokens += row.raw.cloudOutputTokens;
      acc.raw.correct += row.raw.correct;
      acc.raw.total += row.raw.total;
      acc.raw.answered += row.raw.answered;
      acc.raw.timeMs += row.raw.probeTimeMs;

      acc.mcp.cloudInputTokens += row.mcp.cloudInputTokens;
      acc.mcp.cloudOutputTokens += row.mcp.cloudOutputTokens;
      acc.mcp.localIndexTokens += row.mcp.localIndexTokens;
      acc.mcp.correct += row.mcp.correct;
      acc.mcp.total += row.mcp.total;
      acc.mcp.answered += row.mcp.answered;
      acc.mcp.timeMs += row.mcp.indexTimeMs + row.mcp.probeTimeMs;
      return acc;
    },
    {
      raw: { cloudInputTokens: 0, cloudOutputTokens: 0, correct: 0, total: 0, answered: 0, timeMs: 0 },
      mcp: { cloudInputTokens: 0, cloudOutputTokens: 0, localIndexTokens: 0, correct: 0, total: 0, answered: 0, timeMs: 0 },
    },
  );

  console.log('\n=== Context Guardian Multi-Task Benchmark (MCP vs Raw) ===');
  console.log(`Context window baseline: first ${RAW_CONTEXT_WINDOW_TOKENS.toLocaleString()} tokens (simulated truncation)\n`);

  for (const row of rows) {
    console.log(`--- ${row.scenario} ---`);
    console.log(`Context size: ${row.expandedTokens.toLocaleString()} tokens (baseline sees ${row.truncatedTokens.toLocaleString()})`);
    console.log(`Raw  : accuracy ${(row.raw.accuracy * 100).toFixed(1)}% (${row.raw.correct}/${row.raw.total}), precision ${(row.raw.precision * 100).toFixed(1)}%, cloud tokens in=${row.raw.cloudInputTokens.toLocaleString()}, out=${row.raw.cloudOutputTokens.toLocaleString()}, time=${row.raw.probeTimeMs.toFixed(1)}ms`);
    console.log(`MCP  : accuracy ${(row.mcp.accuracy * 100).toFixed(1)}% (${row.mcp.correct}/${row.mcp.total}), precision ${(row.mcp.precision * 100).toFixed(1)}%, cloud tokens in=${row.mcp.cloudInputTokens.toLocaleString()}, out=${row.mcp.cloudOutputTokens.toLocaleString()}, local index tokens=${row.mcp.localIndexTokens.toLocaleString()}, time=${(row.mcp.indexTimeMs + row.mcp.probeTimeMs).toFixed(1)}ms`);
    console.log('');
  }

  const rawAccuracy = totals.raw.total === 0 ? 0 : totals.raw.correct / totals.raw.total;
  const mcpAccuracy = totals.mcp.total === 0 ? 0 : totals.mcp.correct / totals.mcp.total;
  const rawPrecision = totals.raw.answered === 0 ? 0 : totals.raw.correct / totals.raw.answered;
  const mcpPrecision = totals.mcp.answered === 0 ? 0 : totals.mcp.correct / totals.mcp.answered;

  console.log('=== Aggregate ===');
  console.log(`Raw  : accuracy ${(rawAccuracy * 100).toFixed(1)}%, precision ${(rawPrecision * 100).toFixed(1)}%, cloud in=${totals.raw.cloudInputTokens.toLocaleString()}, out=${totals.raw.cloudOutputTokens.toLocaleString()}, time=${totals.raw.timeMs.toFixed(1)}ms`);
  console.log(`MCP  : accuracy ${(mcpAccuracy * 100).toFixed(1)}%, precision ${(mcpPrecision * 100).toFixed(1)}%, cloud in=${totals.mcp.cloudInputTokens.toLocaleString()}, out=${totals.mcp.cloudOutputTokens.toLocaleString()}, local index=${totals.mcp.localIndexTokens.toLocaleString()}, time=${totals.mcp.timeMs.toFixed(1)}ms`);

  const cloudSavings = 1 - totals.mcp.cloudInputTokens / Math.max(1, totals.raw.cloudInputTokens);
  const rawBilled = totals.raw.cloudInputTokens + totals.raw.cloudOutputTokens;
  const mcpBilled = totals.mcp.cloudInputTokens + totals.mcp.cloudOutputTokens;
  const billedSavings = 1 - mcpBilled / Math.max(1, rawBilled);
  const accuracyGain = (mcpAccuracy - rawAccuracy) * 100;
  console.log(`Cloud token reduction (input): ${(cloudSavings * 100).toFixed(1)}%`);
  console.log(`Cloud token reduction (billed in+out): ${(billedSavings * 100).toFixed(1)}%`);
  console.log(`Accuracy delta: ${accuracyGain >= 0 ? '+' : ''}${accuracyGain.toFixed(1)} points`);

  const rawPerTask = totals.raw.cloudInputTokens / rows.length;
  const mcpPerTask = totals.mcp.cloudInputTokens / rows.length;
  const rawBilledPerTask = rawBilled / rows.length;
  const mcpBilledPerTask = mcpBilled / rows.length;
  const budgets = [1_000_000, 5_000_000, 10_000_000];

  console.log('\n=== Weekly quota impact (normalized cloud-input-token budgets) ===');
  for (const budget of budgets) {
    const rawTasks = Math.floor(budget / Math.max(1, rawPerTask));
    const mcpTasks = Math.floor(budget / Math.max(1, mcpPerTask));
    const multiplier = mcpTasks / Math.max(1, rawTasks);
    console.log(`Budget ${budget.toLocaleString()} tokens -> raw ~${rawTasks} tasks/week, MCP ~${mcpTasks} tasks/week (${multiplier.toFixed(1)}x longer)`);
  }
  console.log('\n=== Weekly quota impact (normalized billed-token budgets: input+output) ===');
  for (const budget of budgets) {
    const rawTasks = Math.floor(budget / Math.max(1, rawBilledPerTask));
    const mcpTasks = Math.floor(budget / Math.max(1, mcpBilledPerTask));
    const multiplier = mcpTasks / Math.max(1, rawTasks);
    console.log(`Budget ${budget.toLocaleString()} billed tokens -> raw ~${rawTasks} tasks/week, MCP ~${mcpTasks} tasks/week (${multiplier.toFixed(1)}x longer)`);
  }

  return {
    generatedAt: new Date().toISOString(),
    contextWindowTokens: RAW_CONTEXT_WINDOW_TOKENS,
    scenarios: rows,
    aggregate: {
      raw: {
        accuracy: rawAccuracy,
        precision: rawPrecision,
        cloudInputTokens: totals.raw.cloudInputTokens,
        cloudOutputTokens: totals.raw.cloudOutputTokens,
        totalTimeMs: totals.raw.timeMs,
        totalCorrect: totals.raw.correct,
        totalQuestions: totals.raw.total,
      },
      mcp: {
        accuracy: mcpAccuracy,
        precision: mcpPrecision,
        cloudInputTokens: totals.mcp.cloudInputTokens,
        cloudOutputTokens: totals.mcp.cloudOutputTokens,
        localIndexTokens: totals.mcp.localIndexTokens,
        totalTimeMs: totals.mcp.timeMs,
        totalCorrect: totals.mcp.correct,
        totalQuestions: totals.mcp.total,
      },
      cloudInputReductionPct: cloudSavings * 100,
      cloudBilledReductionPct: billedSavings * 100,
      accuracyDeltaPoints: accuracyGain,
    },
  };
}

function probe(
  id: string,
  question: string,
  grepPattern: string,
  expected: string,
  extract: ExtractFn,
  isCorrect?: (answer: string | null, expected: string) => boolean,
): Probe {
  return { id, question, grepPattern, expected, extract, isCorrect };
}

function capture(regex: RegExp): ExtractFn {
  return (text: string) => {
    const match = text.match(regex);
    if (!match) return null;
    return (match[1] || match[0]).trim();
  };
}

function extractMaxNumber(regex: RegExp): ExtractFn {
  return (text: string) => {
    const matches = [...text.matchAll(regex)];
    if (matches.length === 0) return null;
    const max = matches
      .map((m) => normalizeNumber(m[1]))
      .filter((n) => Number.isFinite(n))
      .reduce((a, b) => Math.max(a, b), 0);
    return max > 0 ? String(max) : null;
  };
}

function normalizeText(value: string | null | undefined): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s"'`]/g, '')
    .trim();
}

function normalizeNumber(value: string | null | undefined): number {
  const cleaned = String(value || '').replace(/,/g, '').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function defaultCorrect(answer: string | null, expected: string): boolean {
  if (!answer) return false;
  return normalizeText(answer) === normalizeText(expected);
}

function getJsonOutputPath(): string | null {
  const fromEnv = process.env.BENCH_JSON_PATH?.trim();
  if (fromEnv) return fromEnv;

  const args = process.argv.slice(2);
  const idx = args.indexOf('--json');
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return null;
}

void main();
