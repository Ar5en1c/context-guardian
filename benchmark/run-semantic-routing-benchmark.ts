import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { scenarios } from './run-benchmark.js';
import { loadConfig } from '../src/config.js';
import {
  analyzeRequest,
  DEFAULT_INTERCEPT_POLICY,
  extractRawContent,
  type InterceptDecision,
  type InterceptPolicy,
} from '../src/proxy/interceptor.js';
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

type RouteMode = 'passthrough' | 'context_shape' | 'full_rewrite';

interface BenchmarkCase {
  id: string;
  title: string;
  content: string;
  expectedSemanticMode: RouteMode;
  note: string;
}

interface RouteRun {
  mode: RouteMode;
  reasons: string[];
  cloudInputTokens: number;
  outputTokens: number;
  localRewriteMs: number;
}

interface CaseResult {
  id: string;
  title: string;
  note: string;
  expectedSemanticMode: RouteMode;
  requestTokens: number;
  thresholdOnly: RouteRun;
  semantic: RouteRun;
}

const DISABLED_SEMANTIC_POLICY: InterceptPolicy = {
  ...DEFAULT_INTERCEPT_POLICY,
  signal_score_threshold: Number.MAX_SAFE_INTEGER,
  min_context_shape_tokens: Number.MAX_SAFE_INTEGER,
  min_context_shape_lines: Number.MAX_SAFE_INTEGER,
  large_message_tokens: Number.MAX_SAFE_INTEGER,
  total_line_trigger: Number.MAX_SAFE_INTEGER,
  log_line_trigger: Number.MAX_SAFE_INTEGER,
  stacktrace_line_trigger: Number.MAX_SAFE_INTEGER,
  error_line_trigger: Number.MAX_SAFE_INTEGER,
  code_line_trigger: Number.MAX_SAFE_INTEGER,
  path_hint_trigger: Number.MAX_SAFE_INTEGER,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const repeats = Math.max(1, Number(args.repeats || 2));
  const outPath = args.json ? resolve(process.cwd(), args.json) : '';
  const llm = new OllamaAdapter(
    args.ollamaEndpoint || config.local_llm.endpoint,
    args.localModel || config.local_llm.model,
    args.embedModel || config.local_llm.embed_model,
  );

  if (!(await llm.isAvailable())) {
    throw new Error(`Ollama not available at ${config.local_llm.endpoint}`);
  }

  const cases = buildCases();
  const results: CaseResult[] = [];

  for (const item of cases) {
    const messages = [{ role: 'user', content: item.content }];
    const rawContent = extractRawContent(messages);

    const thresholdOnly = await runCaseVariant(
      rawContent,
      messages,
      llm,
      config.threshold_tokens,
      DISABLED_SEMANTIC_POLICY,
      config.context_budget,
      config.tools,
      repeats,
    );

    const semantic = await runCaseVariant(
      rawContent,
      messages,
      llm,
      config.threshold_tokens,
      config.intercept_policy,
      config.context_budget,
      config.tools,
      repeats,
    );

    results.push({
      id: item.id,
      title: item.title,
      note: item.note,
      expectedSemanticMode: item.expectedSemanticMode,
      requestTokens: thresholdOnly.cloudInputTokens,
      thresholdOnly,
      semantic,
    });
  }

  const report = buildReport(results, repeats, config.threshold_tokens);
  printReport(report);
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`Saved JSON report: ${outPath}`);
  }
}

async function runCaseVariant(
  rawContent: string,
  messages: Array<{ role: string; content: string }>,
  llm: OllamaAdapter,
  threshold: number,
  policy: InterceptPolicy,
  contextBudget: number,
  tools: string[],
  repeats: number,
): Promise<RouteRun> {
  let lastDecision: InterceptDecision | null = null;
  let totalCloudInput = 0;
  let totalOutputTokens = 0;
  let totalLocalRewriteMs = 0;

  for (let i = 0; i < repeats; i++) {
    const decision = analyzeRequest(messages, threshold, policy);
    lastDecision = decision;

    if (!decision.shouldIntercept) {
      totalCloudInput += decision.totalTokens;
      totalOutputTokens += decision.totalTokens;
      continue;
    }

    const started = performance.now();
    const rewrite = await rewriteRequest(
      rawContent,
      messages,
      llm,
      new VectorStore(),
      tools,
      contextBudget,
      { routeMode: decision.mode, decisionReasons: decision.reasons },
    );
    totalLocalRewriteMs += performance.now() - started;
    totalCloudInput += rewrite.outputTokens;
    totalOutputTokens += rewrite.outputTokens;
  }

  if (!lastDecision) {
    throw new Error('No decision produced during benchmark');
  }

  return {
    mode: lastDecision.mode,
    reasons: lastDecision.reasons,
    cloudInputTokens: Math.round(totalCloudInput / repeats),
    outputTokens: Math.round(totalOutputTokens / repeats),
    localRewriteMs: Number((totalLocalRewriteMs / repeats).toFixed(1)),
  };
}

function buildCases(): BenchmarkCase[] {
  const auth = scenarios['auth-timeout']();
  const memory = scenarios['memory-leak']();
  const api = scenarios['api-migration']();

  const noisyStack = [
    'Investigate why the websocket gateway is leaking memory and tell me exactly where to look.',
    'Traceback (most recent call last):',
    ...Array.from({ length: 12 }, (_, i) =>
      `  File "/srv/gateway/socket_${i}.ts", line ${70 + i}, in handleConnection\n  at GatewaySocket.handle (${90 + i}:14)\nTypeError: listener cleanup missing after release`,
    ),
    '',
    'function releaseConnection(socket) {',
    '  pool.release(socket);',
    '  // TODO cleanup listeners',
    '}',
  ].join('\n');

  return [
    {
      id: 'clean-small',
      title: 'Small clean fix request',
      content: 'Fix auth.ts to retry JWKS refresh and add one focused test.',
      expectedSemanticMode: 'passthrough',
      note: 'Should stay out of the way for short non-noisy prompts.',
    },
    {
      id: 'auth-timeout-compact',
      title: 'Moderate auth incident bundle',
      content: auth.rawContext,
      expectedSemanticMode: 'context_shape',
      note: 'Moderate prompt with logs + code + config should trigger shaping even below threshold.',
    },
    {
      id: 'memory-leak-compact',
      title: 'Moderate memory leak bundle',
      content: memory.rawContext,
      expectedSemanticMode: 'context_shape',
      note: 'Heap dump + metrics + code should be shaped instead of dumped raw.',
    },
    {
      id: 'mixed-stacktrace',
      title: 'Focused stacktrace plus code',
      content: noisyStack,
      expectedSemanticMode: 'passthrough',
      note: 'Short stacktraces should stay direct unless they are accompanied by much larger dumps.',
    },
    {
      id: 'large-auth-expanded',
      title: 'Large expanded auth incident',
      content: `${auth.rawContext}\n\n${buildNoise('auth-expanded', 420)}`,
      expectedSemanticMode: 'full_rewrite',
      note: 'Huge prompt should still go through the full rewrite path.',
    },
    {
      id: 'api-migration-clean',
      title: 'Moderate API migration spec',
      content: api.rawContext,
      expectedSemanticMode: 'passthrough',
      note: 'Spec-heavy but not artifact-heavy context should remain direct unless it gets huge.',
    },
  ];
}

function buildNoise(tag: string, lines: number): string {
  return Array.from(
    { length: lines },
    (_, i) => `${tag} telemetry line=${i} status=ok latency_ms=${(i % 120) + 5} request_id=req-${i} cache=warm`,
  ).join('\n');
}

function buildReport(results: CaseResult[], repeats: number, threshold: number) {
  const aggregate = results.reduce(
    (acc, row) => {
      acc.thresholdOnlyInput += row.thresholdOnly.cloudInputTokens;
      acc.semanticInput += row.semantic.cloudInputTokens;
      acc.semanticLatencyMs += row.semantic.localRewriteMs;
      acc.thresholdOnlyLatencyMs += row.thresholdOnly.localRewriteMs;
      if (row.semantic.mode === row.expectedSemanticMode) acc.semanticModeMatches++;
      if (row.thresholdOnly.mode !== row.semantic.mode) acc.modeChanged++;
      return acc;
    },
    {
      thresholdOnlyInput: 0,
      semanticInput: 0,
      thresholdOnlyLatencyMs: 0,
      semanticLatencyMs: 0,
      semanticModeMatches: 0,
      modeChanged: 0,
    },
  );

  return {
    generatedAt: new Date().toISOString(),
    repeats,
    thresholdTokens: threshold,
    results,
    aggregate: {
      thresholdOnlyInputTokens: aggregate.thresholdOnlyInput,
      semanticInputTokens: aggregate.semanticInput,
      semanticInputReductionPct: percentageReduction(aggregate.thresholdOnlyInput, aggregate.semanticInput),
      avgThresholdOnlyLocalRewriteMs: Number((aggregate.thresholdOnlyLatencyMs / results.length).toFixed(1)),
      avgSemanticLocalRewriteMs: Number((aggregate.semanticLatencyMs / results.length).toFixed(1)),
      semanticModeAccuracyPct: Number(((aggregate.semanticModeMatches / results.length) * 100).toFixed(1)),
      modeChangedCases: aggregate.modeChanged,
    },
  };
}

function printReport(report: ReturnType<typeof buildReport>) {
  console.log('\n=== Semantic Routing Benchmark ===');
  console.log(`Threshold: ${report.thresholdTokens} tokens | repeats: ${report.repeats}`);

  for (const row of report.results) {
    const reduction = percentageReduction(row.thresholdOnly.cloudInputTokens, row.semantic.cloudInputTokens);
    console.log(`\n--- ${row.title} ---`);
    console.log(`Expected semantic mode: ${row.expectedSemanticMode}`);
    console.log(`Threshold-only: mode=${row.thresholdOnly.mode} cloud_input=${row.thresholdOnly.cloudInputTokens} local_ms=${row.thresholdOnly.localRewriteMs}`);
    console.log(`Semantic      : mode=${row.semantic.mode} cloud_input=${row.semantic.cloudInputTokens} local_ms=${row.semantic.localRewriteMs}`);
    console.log(`Delta         : ${reduction.toFixed(1)}% cloud-input reduction | reasons=${row.semantic.reasons.join(', ') || 'none'}`);
    console.log(`Note          : ${row.note}`);
  }

  console.log('\n=== Aggregate ===');
  console.log(`Threshold-only cloud input: ${report.aggregate.thresholdOnlyInputTokens}`);
  console.log(`Semantic cloud input      : ${report.aggregate.semanticInputTokens}`);
  console.log(`Semantic reduction        : ${report.aggregate.semanticInputReductionPct.toFixed(1)}%`);
  console.log(`Semantic mode accuracy    : ${report.aggregate.semanticModeAccuracyPct.toFixed(1)}%`);
  console.log(`Cases with route change   : ${report.aggregate.modeChangedCases}/${report.results.length}`);
  console.log(`Avg local rewrite ms      : threshold-only=${report.aggregate.avgThresholdOnlyLocalRewriteMs}, semantic=${report.aggregate.avgSemanticLocalRewriteMs}`);
}

function percentageReduction(before: number, after: number): number {
  return before <= 0 ? 0 : (1 - after / before) * 100;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[key] = value;
  }
  return out;
}

void main();
