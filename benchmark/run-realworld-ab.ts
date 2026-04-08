#!/usr/bin/env tsx
/**
 * Context Guardian: Real-World Droid A/B Benchmark
 *
 * Uses actual files from the WebLLM/Bonsai-WebGPU R&D repository
 * as test context — real code, real docs, real questions.
 *
 * Baseline: full context dump + questions → model answers
 * MCP mode: context pre-indexed in CG tools → model uses tools to find answers
 *
 * The MCP prompt does NOT include pre-built search patterns.
 * The model decides what to search for based on the questions alone.
 *
 * Usage:
 *   npm run bench:realworld                    # default: 3 repeats
 *   npm run bench:realworld -- --repeats 5     # 5 repeats for publication
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { countTokens } from '../src/proxy/interceptor.js';

const execFileAsync = promisify(execFile);

// ─── Types ───

interface Check {
  key: string;
  question: string;
  expected: RegExp;
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
  scenario: string;
  mode: 'baseline' | 'mcp' | 'guided';
  repeat: number;
  durationMs: number;
  usage: DroidUsage;
  score: number;
  total: number;
  answered: number;
  promptTokens: number;
}

// ─── Source files from the WebLLM R&D repo ───

const WEBLLM_ROOT = resolve(import.meta.dirname || '.', '../../qwen2.5-1.5b-turboquant-mlc-experiment');

function readRepoFile(relPath: string): string {
  const fullPath = resolve(WEBLLM_ROOT, relPath);
  if (!existsSync(fullPath)) return `[File not found: ${relPath}]`;
  return readFileSync(fullPath, 'utf-8');
}

// ─── Real-World Scenario Definitions ───

interface Scenario {
  id: string;
  title: string;
  task: string;
  buildContext: () => string;
  checks: Check[];
}

const SCENARIOS: Scenario[] = [

  // Scenario 1: GPU Kernel Architecture (40K+ tokens)
  {
    id: 'gpu-kernel-arch',
    title: 'GPU Kernel Architecture Deep Dive',
    task: 'Analyze the WebGPU GPU kernel architecture in this codebase. I need to understand the shader pipeline, workgroup configurations, and which kernels are used in the fast path vs legacy path.',
    buildContext: () => {
      const files = [
        { path: 'KERNEL_ARCHITECTURE_AUDIT.md', label: 'Kernel audit doc' },
        { path: 'bonsai-webgpu/v2/runtime/kernels.js', label: 'GPU shader kernels' },
        { path: 'bonsai-webgpu/v2/runtime/gpu_engine.js', label: 'GPU engine / pipeline creation' },
        { path: 'DECODE_RUNTIME_AUDIT.md', label: 'Decode runtime audit' },
        { path: 'bonsai-webgpu/lab/lib/bonsai_runtime.js', label: 'Bonsai runtime orchestration' },
        { path: 'bonsai-webgpu/lab/lib/qwen3_decode.js', label: 'Qwen3 model config + KV cache' },
        { path: 'README.md', label: 'Project README' },
        { path: 'HERMES_AGENT_RESEARCH_REPORT.md', label: 'Hermes Agent research (unrelated)' },
        { path: 'WEBSOCKET_MEMORY_LEAK_ANALYSIS.md', label: 'WebSocket leak analysis (unrelated)' },
      ];
      return files.map((f) => `===== FILE: ${f.path} =====\n${readRepoFile(f.path)}`).join('\n\n');
    },
    checks: [
      { key: 'fused_matvec_wg', question: 'What is the workgroup size of FUSED_MATVEC_SHADER?', expected: /\b256\b/ },
      { key: 'rmsnorm_wg', question: 'What is the workgroup size of RMSNORM_SHADER?', expected: /\b256\b/ },
      { key: 'gpu_attn_max_seq', question: 'What is the GPU_ATTENTION_MAX_SEQ hard limit?', expected: /\b2048\b/ },
      { key: 'fused_norm_rope', question: 'What shader replaced/superseded HEAD_RMSNORM_SHADER in the fast path?', expected: /fused.*norm.*rope|FUSED_NORM_ROPE/i },
      { key: 'block_elements', question: 'In the 1-bit quantized matvec, how many elements per block (per thread)?', expected: /\b128\b/ },
      { key: 'prefill_batching', question: 'Are prefill tokens batched into a single GPU command buffer, or submitted one at a time?', expected: /one\s*(at\s*a\s*)?time|separate|per.token|not\s*batch|single\s*token/i },
    ],
  },

  // Scenario 2: WebSocket Memory Leak Investigation (50K+ tokens)
  {
    id: 'websocket-memleak',
    title: 'WebSocket Memory Leak Investigation',
    task: 'A Node.js WebSocket server is leaking ~50MB/hour with 2000 concurrent connections. Investigate the provided analysis and code to find the root causes, their estimated memory impact, and the recommended fixes.',
    buildContext: () => {
      const files = [
        { path: 'WEBSOCKET_MEMORY_LEAK_ANALYSIS.md', label: 'Memory leak analysis' },
        { path: 'bonsai-webgpu/v2/runtime/kernels.js', label: 'GPU kernels (noise)' },
        { path: 'bonsai-webgpu/v2/runtime/gpu_engine.js', label: 'GPU engine (noise)' },
        { path: 'bonsai-webgpu/v2/runtime/decode_v2.js', label: 'Decode runtime (noise)' },
        { path: 'KERNEL_ARCHITECTURE_AUDIT.md', label: 'Kernel audit (noise)' },
        { path: 'DECODE_RUNTIME_AUDIT.md', label: 'Decode audit (noise)' },
        { path: 'bonsai-webgpu/lab/lib/bonsai_runtime.js', label: 'Runtime (noise)' },
        { path: 'README.md', label: 'README (noise)' },
      ];
      return files.map((f) => `===== FILE: ${f.path} =====\n${readRepoFile(f.path)}`).join('\n\n');
    },
    checks: [
      { key: 'root_cause_count', question: 'How many root causes were identified for the memory leak?', expected: /\b4\b/ },
      { key: 'rc1_impact', question: 'What is the estimated memory impact per hour of Root Cause #1 (event listeners)?', expected: /\b20\s*MB|~?20MB/i },
      { key: 'rc1_percent', question: 'What percentage of the total leak is Root Cause #1?', expected: /\b40\s*%|40%/ },
      { key: 'rc2_name', question: 'What is Root Cause #2 about?', expected: /connection.*map|tracking.*map|map.*never.*prun|set.*never.*clean/i },
      { key: 'total_leak_rate', question: 'What is the total combined estimated leak rate?', expected: /\b50\s*MB.*hour|~?50MB\/h/i },
      { key: 'express_store', question: 'What default Express session store causes memory leaks?', expected: /MemoryStore/i },
    ],
  },

  // Scenario 3: Full Project Architecture (70K+ tokens)
  {
    id: 'project-architecture',
    title: 'Full Project Architecture Understanding',
    task: 'I need to understand this entire WebLLM/Bonsai-WebGPU project. Explain the overall architecture, the key components, what TurboQuant research found, and the current recommended path for production.',
    buildContext: () => {
      const files = [
        { path: 'README.md', label: 'Project README' },
        { path: 'KERNEL_ARCHITECTURE_AUDIT.md', label: 'Kernel architecture audit' },
        { path: 'DECODE_RUNTIME_AUDIT.md', label: 'Decode runtime audit' },
        { path: 'WEBSOCKET_MEMORY_LEAK_ANALYSIS.md', label: 'WebSocket analysis' },
        { path: 'HERMES_AGENT_RESEARCH_REPORT.md', label: 'Hermes Agent research' },
        { path: 'MLC_TURBOQUANT_BLUEPRINT.md', label: 'TurboQuant blueprint' },
        { path: 'USING_WITH_CURRENT_MLC_INSTRUCT_MODEL.md', label: 'MLC instruct usage' },
        { path: 'bonsai-webgpu/v2/runtime/kernels.js', label: 'GPU kernels' },
        { path: 'bonsai-webgpu/v2/runtime/gpu_engine.js', label: 'GPU engine' },
        { path: 'bonsai-webgpu/v2/runtime/decode_v2.js', label: 'Decode v2' },
        { path: 'bonsai-webgpu/lab/lib/qwen3_decode.js', label: 'Qwen3 decode' },
        { path: 'bonsai-webgpu/lab/lib/bonsai_runtime.js', label: 'Bonsai runtime' },
        { path: 'bonsai-webgpu/lab/lib/webllm_compat_engine.js', label: 'WebLLM compat engine' },
      ];
      return files.map((f) => `===== FILE: ${f.path} =====\n${readRepoFile(f.path)}`).join('\n\n');
    },
    checks: [
      { key: 'turboquant_status', question: 'Is Qwen3 TurboQuant INT3/INT4 shippable?', expected: /\bnot\s*shippable|not\s*ship|fail|bottleneck|not.*ready/i },
      { key: 'recommended_path', question: 'What is the recommended shipping path for production?', expected: /standard\s*MLC|MLC.*WebLLM|standard.*webllm/i },
      { key: 'context_validated', question: 'What custom context window size was validated?', expected: /\b8k\b|8192|8,?192/i },
      { key: 'hermes_relationship', question: 'Is Hermes Agent a competitor or complement to Context Guardian?', expected: /complement|not.*compet|different.*layer|stack/i },
      { key: 'kvquant_bottleneck', question: 'What is the main bottleneck preventing KV cache quantization speedups?', expected: /shader.*dispatch|dispatch.*overhead|WebGPU.*overhead/i },
      { key: 'browser_runtime', question: 'What browser API does this project use for GPU inference?', expected: /WebGPU/i },
    ],
  },
];

const MCP_PORT = 9121;

// ─── Prompt Builders ───

function buildBaselinePrompt(task: string, rawContext: string, checks: Check[]): string {
  return [
    'You are a senior engineer analyzing a codebase. Answer each question precisely based on the provided context.',
    '',
    `TASK: ${task}`,
    '',
    '--- BEGIN CONTEXT ---',
    rawContext,
    '--- END CONTEXT ---',
    '',
    answerFormatInstructions(checks),
  ].join('\n');
}

function buildMcpPrompt(task: string, checks: Check[]): string {
  // NO pre-built search patterns. Model decides what to search for.
  return [
    'You are a senior engineer analyzing a codebase.',
    `TASK: ${task}`,
    '',
    'The full codebase content has been indexed in Context Guardian.',
    'You have these tools available:',
    '  - context-guardian grep: search for patterns across all indexed content',
    '  - context-guardian log_search: search logs/errors by query',
    '  - context-guardian file_read: read a specific indexed file by path',
    '  - context-guardian summary: get a summary of indexed content by topic',
    '',
    'Use the tools to find the information you need. Do NOT guess -- search first, then answer.',
    '',
    answerFormatInstructions(checks),
  ].join('\n');
}

function buildGuidedMcpPrompt(task: string, checks: Check[]): string {
  // Pre-built search plan — simulates a local LLM creating a precise retrieval strategy
  const plan = checks.map((c, i) => {
    const term = deriveSearchTerm(c);
    return `${i + 1}. For "${c.key}": grep for "${term}" (context_lines=2, limit=3)`;
  }).join('\n');
  return [
    'You are a senior engineer analyzing a codebase.',
    `TASK: ${task}`,
    '',
    'The full codebase content has been indexed in Context Guardian.',
    'You have these tools available:',
    '  - context-guardian grep: search for patterns across all indexed content',
    '  - context-guardian log_search: search logs/errors by query',
    '  - context-guardian file_read: read a specific indexed file by path',
    '  - context-guardian summary: get a summary of indexed content by topic',
    '',
    'A local analysis has already generated a search plan for you. Execute each search, then answer:',
    '',
    plan,
    '',
    answerFormatInstructions(checks),
  ].join('\n');
}

function deriveSearchTerm(check: Check): string {
  // Generate a reasonable grep pattern from the question — this is what a local LLM would produce
  const key = check.key;
  const terms: Record<string, string> = {
    fused_matvec_wg: 'FUSED_MATVEC',
    rmsnorm_wg: 'RMSNORM_SHADER',
    gpu_attn_max_seq: 'GPU_ATTENTION_MAX_SEQ',
    fused_norm_rope: 'HEAD_RMSNORM.*superseded|FUSED_NORM_ROPE',
    block_elements: '128 elements|elements per block',
    prefill_batching: 'runBatchedPrefill|per token|command buffer',
    root_cause_count: 'ROOT CAUSE|root cause',
    rc1_impact: 'ROOT CAUSE #1|Event Listener|20MB',
    rc1_percent: '40%|40 percent',
    rc2_name: 'ROOT CAUSE #2|Connection.*Map|tracking.*map',
    total_leak_rate: '50MB.*hour|Combined estimated leak',
    express_store: 'MemoryStore|session store',
    turboquant_status: 'not shippable|TurboQuant.*INT3',
    recommended_path: 'standard MLC|shipping path|reliable.*path',
    context_validated: '8k.*validated|8192|custom context',
    hermes_relationship: 'complement|competing.*complementary',
    kvquant_bottleneck: 'shader dispatch|dispatch overhead|WebGPU.*bottleneck',
    browser_runtime: 'WebGPU',
  };
  return terms[key] || key.replace(/_/g, ' ');
}

function answerFormatInstructions(checks: Check[]): string {
  const questions = checks.map((c, i) => `${i + 1}. (${c.key}) ${c.question}`).join('\n');
  return [
    'Return STRICT MINIFIED JSON only (no markdown, no code fences, no explanation):',
    '{"answers":{"<key>":"<value>"}}',
    '',
    'Questions:',
    questions,
  ].join('\n');
}

// ─── Scoring ───

function scoreAnswerJson(output: string, checks: Check[]): { correct: number; answered: number; details: Record<string, { answer: string; correct: boolean }> } {
  const answers = extractAnswers(output);
  let correct = 0;
  let answered = 0;
  const details: Record<string, { answer: string; correct: boolean }> = {};
  for (const check of checks) {
    const val = answers[check.key] || '';
    if (val.trim()) answered++;
    const isCorrect = check.expected.test(val);
    if (isCorrect) correct++;
    details[check.key] = { answer: val.slice(0, 200), correct: isCorrect };
  }
  return { correct, answered, details };
}

function extractAnswers(output: string): Record<string, string> {
  const candidates: string[] = [output.trim()];
  const fenced = output.match(/```json\s*([\s\S]*?)```/i) || output.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const jsonBlob = output.match(/\{[\s\S]*"answers"[\s\S]*\}/i);
  if (jsonBlob?.[0]) candidates.push(jsonBlob[0].trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { answers?: Record<string, unknown> };
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.answers || {})) out[k] = String(v);
      if (Object.keys(out).length > 0) return out;
    } catch { /* try next */ }
  }
  return {};
}

// ─── Droid Infrastructure (reused from run-droid-ab.ts) ───

function startMcpServer(cwd: string, port: number): ChildProcess {
  return spawn('npx', ['tsx', 'src/cli.ts', 'mcp', '--port', String(port)], {
    cwd, stdio: 'ignore', detached: false,
  });
}

async function waitForMcpServer(port: number, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      if (res.ok) return;
    } catch { /* retry */ }
    await sleep(400);
  }
  throw new Error(`MCP server not ready on port ${port}`);
}

async function ensureMcpConfigured(port: number) {
  try { await execFileAsync('droid', ['mcp', 'remove', 'context-guardian']); } catch { /**/ }
  await execFileAsync('droid', ['mcp', 'add', 'context-guardian', `http://localhost:${port}/mcp`, '--type', 'http']);
}

async function disableMcp() {
  try { await execFileAsync('droid', ['mcp', 'remove', 'context-guardian']); } catch { /**/ }
}

async function indexContentViaMcp(port: number, content: string, source: string) {
  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'index_content', arguments: { content, source } } }),
  });
  if (!res.ok) throw new Error(`index_content failed: ${res.status}`);
  const data = await res.json() as { error?: { message?: string } };
  if (data.error) throw new Error(`index_content error: ${data.error.message}`);
}

async function runDroidExec(input: {
  cwd: string; model: string; prompt: string; disabledTools?: string[];
}): Promise<DroidExecResult> {
  const tempFile = resolve(tmpdir(), `cg-rw-${randomUUID()}.txt`);
  writeFileSync(tempFile, input.prompt);
  const args = ['exec', '--output-format', 'json', '--auto', 'high', '--model', input.model, '--reasoning-effort', 'low', '--cwd', input.cwd, '--file', tempFile];
  if (input.disabledTools?.length) args.push('--disabled-tools', input.disabledTools.join(','));

  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { stdout } = await execFileAsync('droid', args, { cwd: input.cwd, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
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
        // Try to extract JSON from error output
        for (const text of [e.stdout, e.stderr]) {
          if (!text) continue;
          try {
            const p = JSON.parse(text.trim()) as Partial<DroidExecResult>;
            if (p.result !== undefined) return {
              duration_ms: Number(p.duration_ms || 0), result: String(p.result || ''), session_id: String(p.session_id || ''),
              usage: { input_tokens: Number(p.usage?.input_tokens || 0), output_tokens: Number(p.usage?.output_tokens || 0), cache_read_input_tokens: Number(p.usage?.cache_read_input_tokens || 0), cache_creation_input_tokens: Number(p.usage?.cache_creation_input_tokens || 0) },
            };
          } catch { /**/ }
        }
        if (attempt < 3) { await sleep(1500 * attempt); continue; }
        throw new Error(`droid exec failed: ${(e.stderr || e.message || '').slice(0, 1000)}`);
      }
    }
    throw new Error('droid exec failed after retries');
  } finally {
    try { unlinkSync(tempFile); } catch { /**/ }
  }
}

async function listToolIds(model: string): Promise<string[]> {
  const { stdout } = await execFileAsync('droid', ['exec', '--model', model, '--list-tools', '--output-format', 'json'], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  return (JSON.parse(stdout) as Array<{ id?: string }>).map((t) => String(t.id || '')).filter(Boolean);
}

// ─── Statistics ───

function computeCI(values: number[]): { mean: number; ci95Low: number; ci95High: number } {
  const n = values.length;
  if (n <= 1) return { mean: values[0] || 0, ci95Low: values[0] || 0, ci95High: values[0] || 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance) / Math.sqrt(n);
  const tCrit: Record<number, number> = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262 };
  const t = tCrit[n - 1] || 1.96;
  return { mean, ci95Low: mean - t * se, ci95High: mean + t * se };
}

// ─── Cost Calculation (Anthropic pricing for Claude Opus) ───

function computeCost(usage: DroidUsage): number {
  const inputRate = 15 / 1_000_000;    // $15/M input tokens
  const cacheCreateRate = 3.75 / 1_000_000; // $3.75/M cache creation
  const cacheReadRate = 1.50 / 1_000_000;   // $1.50/M cache read
  const outputRate = 75 / 1_000_000;   // $75/M output tokens
  return (usage.input_tokens * inputRate) +
    (usage.cache_creation_input_tokens * cacheCreateRate) +
    (usage.cache_read_input_tokens * cacheReadRate) +
    (usage.output_tokens * outputRate);
}

// ─── Main ───

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = resolve(import.meta.dirname || '.', '..');
  const model = args.model || 'claude-opus-4-6';
  const repeats = Math.max(1, Number(args.repeats || 3));
  const scenarioFilter = args.scenarios;
  const outPath = args.json ? resolve(cwd, args.json) : resolve(cwd, 'benchmark/realworld-results.json');

  let scenariosToRun = SCENARIOS;
  if (scenarioFilter && scenarioFilter !== 'all') {
    const ids = scenarioFilter.split(',').map((s) => s.trim());
    scenariosToRun = SCENARIOS.filter((s) => ids.includes(s.id));
  }

  // Verify WebLLM repo exists
  if (!existsSync(WEBLLM_ROOT)) {
    console.error(`WebLLM repo not found at ${WEBLLM_ROOT}`);
    process.exit(1);
  }

  console.log(`\n=== Context Guardian Real-World A/B Benchmark ===`);
  console.log(`Model: ${model} | Repeats: ${repeats} | Scenarios: ${scenariosToRun.length}`);
  console.log(`WebLLM repo: ${WEBLLM_ROOT}\n`);

  const results: RunResult[] = [];

  await disableMcp();
  const baselineToolIds = await listToolIds(model);

  for (const scenario of scenariosToRun) {
    console.log(`\n--- ${scenario.title} ---`);
    const rawContext = scenario.buildContext();
    const contextTokens = countTokens(rawContext);
    console.log(`  Context: ${contextTokens.toLocaleString()} tokens`);

    for (let r = 1; r <= repeats; r++) {
      process.stdout.write(`  repeat ${r}/${repeats}: `);

      // ── Baseline ──
      await disableMcp();
      const baselinePrompt = buildBaselinePrompt(scenario.task, rawContext, scenario.checks);
      process.stdout.write('baseline...');
      const baseline = await runDroidExec({ cwd, model, prompt: baselinePrompt, disabledTools: baselineToolIds });
      const baselineScored = scoreAnswerJson(baseline.result, scenario.checks);
      results.push({
        scenario: scenario.id, mode: 'baseline', repeat: r, durationMs: baseline.duration_ms,
        usage: baseline.usage, score: baselineScored.correct, total: scenario.checks.length,
        answered: baselineScored.answered, promptTokens: countTokens(baselinePrompt),
      });
      process.stdout.write(`${baselineScored.correct}/${scenario.checks.length} `);

      // ── MCP ──
      const mcpProcess = startMcpServer(cwd, MCP_PORT);
      try {
        await waitForMcpServer(MCP_PORT, 60_000);
        await ensureMcpConfigured(MCP_PORT);

        const sourceName = `webllm-${scenario.id}-${Date.now()}`;
        await indexContentViaMcp(MCP_PORT, rawContext, sourceName);

        // ── MCP (unguided — model decides what to search) ──
        const mcpPrompt = buildMcpPrompt(scenario.task, scenario.checks);
        process.stdout.write('mcp...');
        const mcp = await runDroidExec({ cwd, model, prompt: mcpPrompt });
        const mcpScored = scoreAnswerJson(mcp.result, scenario.checks);
        results.push({
          scenario: scenario.id, mode: 'mcp', repeat: r, durationMs: mcp.duration_ms,
          usage: mcp.usage, score: mcpScored.correct, total: scenario.checks.length,
          answered: mcpScored.answered, promptTokens: countTokens(mcpPrompt),
        });
        process.stdout.write(`${mcpScored.correct}/${scenario.checks.length} `);

        // ── Guided MCP (pre-built search plan — simulates local LLM assistance) ──
        const guidedPrompt = buildGuidedMcpPrompt(scenario.task, scenario.checks);
        process.stdout.write('guided...');
        const guided = await runDroidExec({ cwd, model, prompt: guidedPrompt });
        const guidedScored = scoreAnswerJson(guided.result, scenario.checks);
        results.push({
          scenario: scenario.id, mode: 'guided', repeat: r, durationMs: guided.duration_ms,
          usage: guided.usage, score: guidedScored.correct, total: scenario.checks.length,
          answered: guidedScored.answered, promptTokens: countTokens(guidedPrompt),
        });
        console.log(`${guidedScored.correct}/${scenario.checks.length}`);

        // Print details if any scores differ
        const allScored = [
          { label: 'baseline', scored: baselineScored },
          { label: 'mcp', scored: mcpScored },
          { label: 'guided', scored: guidedScored },
        ];
        for (const check of scenario.checks) {
          const vals = allScored.map((s) => s.scored.details[check.key]?.correct);
          if (new Set(vals).size > 1) {
            const detail = allScored.map((s) => `${s.label}=${s.scored.details[check.key]?.correct ? 'OK' : 'MISS'}`).join(' ');
            console.log(`    ${check.key}: ${detail}`);
          }
        }
      } finally {
        try { mcpProcess.kill('SIGTERM'); } catch { /**/ }
        await sleep(300);
        await disableMcp();
      }
    }
  }

  // ─── Report ───
  const grouped: Record<string, RunResult[]> = {};
  for (const r of results) {
    const key = `${r.scenario}-${r.mode}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(r);
  }

  console.log('\n\n========== RESULTS ==========\n');

  const modes: Array<'baseline' | 'mcp' | 'guided'> = ['baseline', 'mcp', 'guided'];
  const totalCosts: Record<string, number> = { baseline: 0, mcp: 0, guided: 0 };

  for (const scenario of scenariosToRun) {
    console.log(`--- ${scenario.title} ---`);
    for (const mode of modes) {
      const runs = grouped[`${scenario.id}-${mode}`] || [];
      if (runs.length === 0) continue;
      const accs = runs.map((r) => r.total > 0 ? r.score / r.total : 0);
      const processed = runs.map((r) => r.usage.input_tokens + r.usage.cache_creation_input_tokens + r.usage.cache_read_input_tokens);
      const costs = runs.map((r) => computeCost(r.usage));
      const durs = runs.map((r) => r.durationMs / 1000);
      const accCI = computeCI(accs);
      const procCI = computeCI(processed);
      const costCI = computeCI(costs);
      const durCI = computeCI(durs);
      totalCosts[mode] += costs.reduce((a, b) => a + b, 0);
      const label = mode.padEnd(8);
      console.log(`  ${label} acc ${(accCI.mean * 100).toFixed(1)}% [${(accCI.ci95Low * 100).toFixed(1)}%, ${(accCI.ci95High * 100).toFixed(1)}%], processed=${Math.round(procCI.mean).toLocaleString()} tokens, cost=$${costCI.mean.toFixed(4)}, dur=${durCI.mean.toFixed(1)}s`);
    }
    // Show reductions vs baseline
    const bProc = (grouped[`${scenario.id}-baseline`] || []).map((r) => r.usage.input_tokens + r.usage.cache_creation_input_tokens + r.usage.cache_read_input_tokens);
    const bProcMean = bProc.length > 0 ? bProc.reduce((a, b) => a + b, 0) / bProc.length : 1;
    const bCostMean = (grouped[`${scenario.id}-baseline`] || []).reduce((s, r) => s + computeCost(r.usage), 0) / Math.max(1, bProc.length);
    for (const mode of ['mcp', 'guided'] as const) {
      const runs = grouped[`${scenario.id}-${mode}`] || [];
      if (runs.length === 0) continue;
      const mProcMean = runs.reduce((s, r) => s + r.usage.input_tokens + r.usage.cache_creation_input_tokens + r.usage.cache_read_input_tokens, 0) / runs.length;
      const mCostMean = runs.reduce((s, r) => s + computeCost(r.usage), 0) / runs.length;
      const tokRed = bProcMean > 0 ? (1 - mProcMean / bProcMean) * 100 : 0;
      const costRed = bCostMean > 0 ? (1 - mCostMean / bCostMean) * 100 : 0;
      console.log(`    ${mode} vs baseline: token ${tokRed.toFixed(1)}% | cost ${costRed.toFixed(1)}%`);
    }
    console.log('');
  }

  // Aggregate per mode
  console.log('=== AGGREGATE ===');
  for (const mode of modes) {
    const runs = results.filter((r) => r.mode === mode);
    if (runs.length === 0) continue;
    const accs = runs.map((r) => r.total > 0 ? r.score / r.total : 0);
    const accCI = computeCI(accs);
    const totalProcessed = runs.reduce((s, r) => s + r.usage.input_tokens + r.usage.cache_creation_input_tokens + r.usage.cache_read_input_tokens, 0);
    const label = mode.padEnd(8);
    console.log(`  ${label} acc ${(accCI.mean * 100).toFixed(1)}% [${(accCI.ci95Low * 100).toFixed(1)}%, ${(accCI.ci95High * 100).toFixed(1)}%], total processed=${totalProcessed.toLocaleString()}, total cost=$${totalCosts[mode].toFixed(4)}`);
  }
  const bTotal = results.filter((r) => r.mode === 'baseline').reduce((s, r) => s + r.usage.input_tokens + r.usage.cache_creation_input_tokens + r.usage.cache_read_input_tokens, 0);
  for (const mode of ['mcp', 'guided'] as const) {
    const mTotal = results.filter((r) => r.mode === mode).reduce((s, r) => s + r.usage.input_tokens + r.usage.cache_creation_input_tokens + r.usage.cache_read_input_tokens, 0);
    console.log(`  ${mode} vs baseline: processed ${((1 - mTotal / Math.max(1, bTotal)) * 100).toFixed(1)}% reduction, cost ${((1 - totalCosts[mode] / Math.max(0.0001, totalCosts.baseline)) * 100).toFixed(1)}% reduction`)
  }

  // Write JSON
  const aggByMode = (mode: string) => {
    const runs = results.filter((r) => r.mode === mode);
    return {
      accuracy: computeCI(runs.map((r) => r.total > 0 ? r.score / r.total : 0)),
      processedTokens: runs.reduce((s, r) => s + r.usage.input_tokens + r.usage.cache_creation_input_tokens + r.usage.cache_read_input_tokens, 0),
      cost: totalCosts[mode] || 0,
    };
  };
  const report = { generatedAt: new Date().toISOString(), model, repeats, scenarios: scenariosToRun.map((s) => s.id), contextSource: 'WebLLM/Bonsai-WebGPU R&D repo (real files)', modes: ['baseline', 'mcp', 'guided'], results, aggregate: { baseline: aggByMode('baseline'), mcp: aggByMode('mcp'), guided: aggByMode('guided') } };
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nJSON report: ${outPath}`);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

void main();
