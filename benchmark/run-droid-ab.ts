import { randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { scenarios, type ScenarioName } from './run-benchmark.js';
import { countTokens } from '../src/proxy/interceptor.js';

const execFileAsync = promisify(execFile);

interface Check {
  key: string;
  question: string;
  expected: RegExp;
  grepPattern: string;
}

interface DroidUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

interface DroidExecResult {
  duration_ms: number;
  result: string;
  usage: DroidUsage;
  session_id: string;
}

interface RunResult {
  scenario: ScenarioName;
  mode: 'baseline' | 'mcp';
  repeat: number;
  durationMs: number;
  usage: DroidUsage;
  score: number;
  total: number;
  answered: number;
  promptTokens: number;
}

const RAW_CONTEXT_WINDOW_TOKENS = 46_000;
const MCP_PORT = 9120;

const CHECKS: Record<ScenarioName, Check[]> = {
  'auth-timeout': [
    { key: 'max_retries', question: 'What is max_retries?', expected: /\b0\b/i, grepPattern: 'max_retries' },
    { key: 'jwks_cache_ttl_ms', question: 'What is jwks_cache_ttl_ms?', expected: /\b3600000\b/i, grepPattern: 'jwks_cache_ttl_ms' },
    { key: 'failure_threshold', question: 'What is failure_threshold?', expected: /\b5\b/i, grepPattern: 'failure_threshold' },
    { key: 'dns_failure', question: 'Which DNS failure appears?', expected: /\bSERVFAIL\b/i, grepPattern: 'SERVFAIL' },
    { key: 'retry_backoff_ms', question: 'What retry_backoff_ms schedule is in notes?', expected: /\b200,\s*400,\s*800\b/i, grepPattern: 'retry_backoff_ms' },
    { key: 'incident_ticket', question: 'What is incident_ticket?', expected: /\bINC-9471\b/i, grepPattern: 'incident_ticket' },
  ],
  'memory-leak': [
    { key: 'event_listeners', question: 'How many EventEmitter listeners are retained?', expected: /\b14,?302\b/i, grepPattern: 'EventEmitter listeners' },
    { key: 'unfreed_response_mb', question: 'How many MB are in unfreed response bodies?', expected: /\b340\b/i, grepPattern: 'Unfreed response bodies' },
    { key: 'cleanup_missing', question: 'Is listener cleanup missing after release?', expected: /\b(yes|true|missing)\b/i, grepPattern: 'NOT removed after release' },
    { key: 'pending_timeouts', question: 'How many setTimeout callbacks are pending?', expected: /\b2,?101\b/i, grepPattern: 'setTimeout callbacks pending' },
    { key: 'patch_sha', question: 'What patch SHA is recommended?', expected: /\b9f2ab77\b/i, grepPattern: 'recommended_patch_sha' },
    { key: 'history_cap', question: 'What max_room_history_entries is proposed?', expected: /\b5000\b/i, grepPattern: 'max_room_history_entries' },
  ],
  'api-migration': [
    { key: 'default_limit', question: 'What is the old default page limit?', expected: /\b50\b/i, grepPattern: 'limit = 50' },
    { key: 'rate_limit', question: 'What rate limit is required?', expected: /\b100\s*req\/min\b/i, grepPattern: '100 req/min' },
    { key: 'soft_delete_field', question: 'What field is used for soft delete?', expected: /\bdeleted_at\b/i, grepPattern: 'deleted_at' },
    { key: 'error_keys', question: 'What standardized error keys are required?', expected: /\bcode,\s*message,\s*details\b/i, grepPattern: 'code, message, details' },
    { key: 'migration_deadline', question: 'What is migration_deadline?', expected: /\b2026-05-01\b/i, grepPattern: 'migration_deadline' },
    { key: 'rollout_strategy', question: 'What rollout strategy is specified?', expected: /\bcanary-10-25-50-100\b/i, grepPattern: 'rollout_strategy' },
  ],
};

const SCENARIO_FACTS: Record<ScenarioName, { front: string; tail: string }> = {
  'auth-timeout': {
    front: `EARLY INCIDENT SNAPSHOT:
- service=auth
- primary symptom=JWT validation timeout`,
    tail: `LATEST INCIDENT NOTES (tail section):
retry_backoff_ms: 200,400,800
incident_ticket: INC-9471
owner: platform-auth`,
  },
  'memory-leak': {
    front: `EARLY TRIAGE NOTES:
- symptom=memory growth over hours
- component=websocket gateway`,
    tail: `LATEST TRIAGE ADDENDUM (tail section):
recommended_patch_sha: 9f2ab77
max_room_history_entries: 5000
leak_fix_priority: P0`,
  },
  'api-migration': {
    front: `EARLY MIGRATION BRIEF:
- target=v2 user APIs
- need=validation + pagination + error contracts`,
    tail: `LATEST PROGRAM UPDATE (tail section):
migration_deadline: 2026-05-01
rollout_strategy: canary-10-25-50-100
compatibility_window_days: 14`,
  },
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = resolve(process.cwd());
  const model = args.model || 'claude-opus-4-6';
  const auto = args.auto || 'high';
  const reasoning = args.reasoning || 'low';
  const repeats = Math.max(1, Number(args.repeats || 1));
  const scenariosToRun = parseScenarios(args.scenarios);
  const outPath = args.json ? resolve(cwd, args.json) : '';
  const debug = args.debug === 'true';

  const results: RunResult[] = [];

  await disableMcpConfigured();
  const baselineToolIds = await listToolIds(model);
  const baselineDisabledTools = baselineToolIds;

  for (const scenarioName of scenariosToRun) {
    const scenario = scenarios[scenarioName]();
    const facts = SCENARIO_FACTS[scenarioName];
    const expandedContext = buildExpandedContext(
      scenario.rawContext,
      scenarioName,
      RAW_CONTEXT_WINDOW_TOKENS,
      facts.front,
      facts.tail,
    );
    const checks = CHECKS[scenarioName];

    for (let repeat = 1; repeat <= repeats; repeat++) {
      await disableMcpConfigured();
      const baselinePrompt = buildBaselinePrompt(scenario.task, expandedContext, checks);
      const baseline = await runDroidExec({
        cwd,
        model,
        auto,
        reasoning,
        prompt: baselinePrompt,
        disabledTools: baselineDisabledTools,
      });
      const baselineScored = scoreAnswerJson(baseline.result, checks);
      results.push({
        scenario: scenarioName,
        mode: 'baseline',
        repeat,
        durationMs: baseline.duration_ms,
        usage: baseline.usage,
        score: baselineScored.correct,
        total: checks.length,
        answered: baselineScored.answered,
        promptTokens: countTokens(baselinePrompt),
      });

      const sourceName = `${scenarioName}-indexed-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const mcpProcess = startMcpServer(cwd, MCP_PORT);
      try {
        await waitForMcpServer(MCP_PORT, 60_000);
        await ensureMcpConfigured(MCP_PORT);
        const mcpToolIds = await listToolIds(model);
        const mcpDisabledTools = mcpToolIds.filter((id) => id !== 'mcp_context-guardian_grep');
        await indexContentViaMcp(MCP_PORT, expandedContext, sourceName);

        const mcpPrompt = buildMcpPrompt(scenario.task, checks, sourceName);
        const mcp = await runDroidExec({
          cwd,
          model,
          auto,
          reasoning,
          prompt: mcpPrompt,
          disabledTools: mcpDisabledTools,
        });
        const mcpScored = scoreAnswerJson(mcp.result, checks);
        results.push({
          scenario: scenarioName,
          mode: 'mcp',
          repeat,
          durationMs: mcp.duration_ms,
          usage: mcp.usage,
          score: mcpScored.correct,
          total: checks.length,
          answered: mcpScored.answered,
          promptTokens: countTokens(mcpPrompt),
        });

        if (debug) {
          console.log(`[${scenarioName} repeat ${repeat}] baseline=${baselineScored.correct}/${checks.length}, mcp=${mcpScored.correct}/${checks.length}`);
        }
        if (debug || baselineScored.correct === 0) {
          console.log(`[${scenarioName} repeat ${repeat}] baseline output preview: ${baseline.result.slice(0, 600).replace(/\s+/g, ' ')}`);
        }
        if (debug || mcpScored.correct === 0) {
          console.log(`[${scenarioName} repeat ${repeat}] mcp output preview: ${mcp.result.slice(0, 600).replace(/\s+/g, ' ')}`);
        }
      } finally {
        try { mcpProcess.kill('SIGTERM'); } catch { /* ignore */ }
        await sleep(250);
        await disableMcpConfigured();
      }
    }
  }

  const report = buildReport(results, model);
  printReport(report);
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`Saved JSON report: ${outPath}`);
  }
}

function startMcpServer(cwd: string, port: number): ChildProcess {
  const child = spawn('npx', ['tsx', 'src/cli.ts', 'mcp', '--port', String(port)], {
    cwd,
    stdio: 'ignore',
    detached: false,
  });
  return child;
}

async function waitForMcpServer(port: number, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {},
        }),
      });
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(400);
  }
  throw new Error(`MCP server did not become ready on port ${port}`);
}

async function ensureMcpConfigured(port: number) {
  try {
    await execFileAsync('droid', ['mcp', 'remove', 'context-guardian']);
  } catch {
    // ignore if absent
  }
  await execFileAsync('droid', [
    'mcp',
    'add',
    'context-guardian',
    `http://localhost:${port}/mcp`,
    '--type',
    'http',
  ]);
}

async function disableMcpConfigured() {
  try {
    await execFileAsync('droid', ['mcp', 'remove', 'context-guardian']);
  } catch {
    // ignore if already absent
  }
}

async function indexContentViaMcp(port: number, content: string, source: string) {
  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'index_content',
        arguments: { content, source },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`index_content failed: ${res.status} ${text.slice(0, 500)}`);
  }
  const data = await res.json() as { error?: { message?: string } };
  if (data.error) {
    throw new Error(`index_content error: ${data.error.message || 'unknown'}`);
  }
}

async function runDroidExec(input: {
  cwd: string;
  model: string;
  auto: string;
  reasoning: string;
  prompt: string;
  disabledTools?: string[];
}): Promise<DroidExecResult> {
  const tempFile = resolve(tmpdir(), `cg-droid-prompt-${randomUUID()}.txt`);
  writeFileSync(tempFile, input.prompt);

  const args = [
    'exec',
    '--output-format',
    'json',
    '--auto',
    input.auto,
    '--model',
    input.model,
    '--reasoning-effort',
    input.reasoning,
    '--cwd',
    input.cwd,
    '--file',
    tempFile,
  ];
  if (input.disabledTools && input.disabledTools.length > 0) {
    args.push('--disabled-tools', input.disabledTools.join(','));
  }
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { stdout } = await execFileAsync('droid', args, {
          cwd: input.cwd,
          timeout: 240000,
          maxBuffer: 1024 * 1024 * 16,
        });
        const parsed = JSON.parse(stdout.trim()) as Partial<DroidExecResult>;
        return {
          duration_ms: Number(parsed.duration_ms || 0),
          result: String(parsed.result || ''),
          session_id: String(parsed.session_id || ''),
          usage: {
            input_tokens: Number(parsed.usage?.input_tokens || 0),
            output_tokens: Number(parsed.usage?.output_tokens || 0),
            cache_read_input_tokens: Number(parsed.usage?.cache_read_input_tokens || 0),
            cache_creation_input_tokens: Number(parsed.usage?.cache_creation_input_tokens || 0),
          },
        };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const parsed = tryParseExecJson(e.stdout || '') || tryParseExecJson(e.stderr || '');
        if (parsed) return parsed;
        if (attempt < 3) {
          await sleep(1200 * attempt);
          continue;
        }
        throw new Error(
          `droid exec failed after retries: ${(e.stderr || e.stdout || e.message || '').slice(0, 1500)}`,
        );
      }
    }
    throw new Error('droid exec failed after retries');
  } finally {
    try { unlinkSync(tempFile); } catch { /* ignore */ }
  }
}

async function listToolIds(model: string): Promise<string[]> {
  const { stdout } = await execFileAsync('droid', [
    'exec',
    '--model',
    model,
    '--list-tools',
    '--output-format',
    'json',
  ], {
    timeout: 120000,
    maxBuffer: 1024 * 1024 * 16,
  });

  const tools = JSON.parse(stdout) as Array<{ id?: string }>;
  return tools.map((t) => String(t.id || '')).filter(Boolean);
}

function tryParseExecJson(text: string): DroidExecResult | null {
  try {
    const parsed = JSON.parse(text.trim()) as Partial<DroidExecResult>;
    return {
      duration_ms: Number(parsed.duration_ms || 0),
      result: String(parsed.result || ''),
      session_id: String(parsed.session_id || ''),
      usage: {
        input_tokens: Number(parsed.usage?.input_tokens || 0),
        output_tokens: Number(parsed.usage?.output_tokens || 0),
        cache_read_input_tokens: Number(parsed.usage?.cache_read_input_tokens || 0),
        cache_creation_input_tokens: Number(parsed.usage?.cache_creation_input_tokens || 0),
      },
    };
  } catch {
    return null;
  }
}

function buildBaselinePrompt(task: string, rawContext: string, checks: Check[]): string {
  return [
    `You are solving a coding investigation task.`,
    `TASK: ${task}`,
    '',
    `CONTEXT (all relevant info may be large):`,
    rawContext,
    '',
    answerFormatInstructions(checks),
  ].join('\n');
}

function buildMcpPrompt(task: string, checks: Check[], sourceName: string): string {
  const plan = checks.map((c, i) => `${i + 1}. key=${c.key} pattern=${c.grepPattern}`).join('\n');
  return [
    `You are solving a coding investigation task.`,
    `TASK: ${task}`,
    `The full context is indexed in MCP source "${sourceName}".`,
    `You MUST use the Context Guardian grep tool before answering.`,
    `You may make at most ${checks.length + 2} total tool calls.`,
    `For each key, run one grep call with context_lines=0 and limit=2.`,
    `Do not use any pattern other than the plan below:`,
    plan,
    `Do not guess.`,
    '',
    answerFormatInstructions(checks),
  ].join('\n');
}

function answerFormatInstructions(checks: Check[]): string {
  const questions = checks.map((c, i) => `${i + 1}. (${c.key}) ${c.question}`).join('\n');
  return [
    'Return STRICT MINIFIED JSON only (no markdown/code fences/explanations) with this exact shape:',
    '{"answers":{"<key>":"<value>"}}',
    '',
    'Questions:',
    questions,
  ].join('\n');
}

function scoreAnswerJson(output: string, checks: Check[]): { correct: number; answered: number } {
  const answers = extractAnswers(output);
  let correct = 0;
  let answered = 0;
  for (const check of checks) {
    const val = answers[check.key];
    if (val && val.trim()) answered++;
    if (val && check.expected.test(val)) correct++;
  }
  return { correct, answered };
}

function extractAnswers(output: string): Record<string, string> {
  const candidates: string[] = [];
  candidates.push(output.trim());

  const fenced = output.match(/```json\s*([\s\S]*?)```/i) || output.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const jsonBlob = output.match(/\{[\s\S]*"answers"[\s\S]*\}/i);
  if (jsonBlob?.[0]) candidates.push(jsonBlob[0].trim());

  for (const candidate of candidates) {
    const parsed = parseAnswersJson(candidate);
    if (Object.keys(parsed).length > 0) return parsed;
  }
  return {};
}

function parseAnswersJson(text: string): Record<string, string> {
  try {
    const parsed = JSON.parse(text) as { answers?: Record<string, unknown> };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.answers || {})) out[k] = String(v);
    return out;
  } catch {
    return {};
  }
}

function buildExpandedContext(
  base: string,
  label: string,
  targetTokens: number,
  frontFacts: string,
  tailFacts: string,
): string {
  const prefix = buildNoise(`${label}-prefix`, Math.floor(targetTokens * 0.35));
  const suffix = buildNoise(`${label}-suffix`, Math.floor(targetTokens * 0.45));
  return `${frontFacts}\n\n${prefix}\n\n${base}\n\n${suffix}\n\n${tailFacts}`;
}

function buildNoise(tag: string, targetTokens: number): string {
  const make = (lines: number) =>
    Array.from({ length: lines }, (_, i) =>
      `${tag} line=${i} status=ok latency_ms=${(i % 89) + 5} cpu=${(i % 70) + 10} mem=${(i % 300) + 200}`,
    ).join('\n');

  let lines = Math.max(100, Math.floor(targetTokens / 20));
  let text = make(lines);
  while (countTokens(text) < targetTokens) {
    lines += 50;
    text = make(lines);
  }
  return text;
}

function parseScenarios(input?: string): ScenarioName[] {
  if (!input || input === 'all') {
    return ['auth-timeout', 'memory-leak', 'api-migration'];
  }
  return input.split(',').map((s) => s.trim()).filter(Boolean) as ScenarioName[];
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

function buildReport(results: RunResult[], model: string) {
  const grouped = groupByScenario(results);
  const scenarioRows = Object.entries(grouped).map(([scenario, rows]) => {
    const baseline = rows.filter((r) => r.mode === 'baseline');
    const mcp = rows.filter((r) => r.mode === 'mcp');
    return {
      scenario,
      baseline: aggregateMode(baseline),
      mcp: aggregateMode(mcp),
    };
  });

  const allBaseline = results.filter((r) => r.mode === 'baseline');
  const allMcp = results.filter((r) => r.mode === 'mcp');

  return {
    generatedAt: new Date().toISOString(),
    model,
    repeats: Math.max(...results.map((r) => r.repeat)),
    scenarios: scenarioRows,
    aggregate: {
      baseline: aggregateMode(allBaseline),
      mcp: aggregateMode(allMcp),
    },
  };
}

function aggregateMode(rows: RunResult[]) {
  const sum = rows.reduce((acc, row) => {
    acc.durationMs += row.durationMs;
    acc.inputTokens += row.usage.input_tokens;
    acc.outputTokens += row.usage.output_tokens;
    acc.cacheReadTokens += row.usage.cache_read_input_tokens;
    acc.cacheCreationTokens += row.usage.cache_creation_input_tokens;
    acc.correct += row.score;
    acc.total += row.total;
    acc.answered += row.answered;
    acc.promptTokens += row.promptTokens;
    return acc;
  }, {
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    correct: 0,
    total: 0,
    answered: 0,
    promptTokens: 0,
  });

  const n = Math.max(1, rows.length);
  const accuracy = sum.total ? sum.correct / sum.total : 0;
  const precision = sum.answered ? sum.correct / sum.answered : 0;
  const totalInputProcessed = sum.inputTokens + sum.cacheReadTokens + sum.cacheCreationTokens;
  const billedLikeTokens = totalInputProcessed + sum.outputTokens;

  return {
    runs: rows.length,
    avgDurationMs: sum.durationMs / n,
    avgPromptTokens: sum.promptTokens / n,
    inputTokens: sum.inputTokens,
    outputTokens: sum.outputTokens,
    cacheReadTokens: sum.cacheReadTokens,
    cacheCreationTokens: sum.cacheCreationTokens,
    totalInputProcessed,
    billedLikeTokens,
    accuracy,
    precision,
    correct: sum.correct,
    total: sum.total,
  };
}

function groupByScenario(results: RunResult[]) {
  const out: Record<string, RunResult[]> = {};
  for (const row of results) {
    if (!out[row.scenario]) out[row.scenario] = [];
    out[row.scenario].push(row);
  }
  return out;
}

function printReport(report: ReturnType<typeof buildReport>) {
  console.log('\n=== Droid A/B (baseline vs Context Guardian MCP) ===');
  console.log(`Model: ${report.model}`);
  for (const s of report.scenarios) {
    console.log(`\n--- ${s.scenario} ---`);
    console.log(`Baseline: acc ${(s.baseline.accuracy * 100).toFixed(1)}% (${s.baseline.correct}/${s.baseline.total}), precision ${(s.baseline.precision * 100).toFixed(1)}%, avgDur ${s.baseline.avgDurationMs.toFixed(0)}ms, input=${s.baseline.inputTokens}, cache_read=${s.baseline.cacheReadTokens}, cache_create=${s.baseline.cacheCreationTokens}, output=${s.baseline.outputTokens}`);
    console.log(`MCP     : acc ${(s.mcp.accuracy * 100).toFixed(1)}% (${s.mcp.correct}/${s.mcp.total}), precision ${(s.mcp.precision * 100).toFixed(1)}%, avgDur ${s.mcp.avgDurationMs.toFixed(0)}ms, input=${s.mcp.inputTokens}, cache_read=${s.mcp.cacheReadTokens}, cache_create=${s.mcp.cacheCreationTokens}, output=${s.mcp.outputTokens}`);
  }

  const b = report.aggregate.baseline;
  const m = report.aggregate.mcp;
  const inputReduction = 1 - m.totalInputProcessed / Math.max(1, b.totalInputProcessed);
  const billedReduction = 1 - m.billedLikeTokens / Math.max(1, b.billedLikeTokens);
  console.log('\n=== Aggregate ===');
  console.log(`Baseline: acc ${(b.accuracy * 100).toFixed(1)}%, processedInput=${b.totalInputProcessed}, billedLike=${b.billedLikeTokens}`);
  console.log(`MCP     : acc ${(m.accuracy * 100).toFixed(1)}%, processedInput=${m.totalInputProcessed}, billedLike=${m.billedLikeTokens}`);
  console.log(`Processed input reduction: ${(inputReduction * 100).toFixed(1)}%`);
  console.log(`Billed-like reduction: ${(billedReduction * 100).toFixed(1)}%`);
  console.log(`Accuracy delta: ${((m.accuracy - b.accuracy) * 100).toFixed(1)} points`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main();
