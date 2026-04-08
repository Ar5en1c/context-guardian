# Context Guardian: OSS Benchmark Design Spec

## Part 1: Audit of Existing Benchmarks

### 1.1 `run-droid-ab.ts` — Droid A/B Comparison

**What it measures**: Runs Factory Droid CLI with vs. without MCP on 3 synthetic scenarios, scoring 6 factual checks each.

**Methodology flaws**:

| Issue | Severity | Detail |
|-------|----------|--------|
| **MCP prompt contains pre-built search plan** | CRITICAL | `buildMcpPrompt()` provides the exact grep pattern for each answer key (`plan` variable). The baseline gets no such guidance. This is not measuring "MCP helps the model find answers" — it's measuring "if you tell the model exactly what to search for, it finds it." |
| **Asymmetric information density** | HIGH | Baseline receives ~46K tokens of noise + signal in one dump. MCP mode receives a short instruction prompt + targeted grep results. The comparison is "reading a haystack" vs. "being handed the needle." |
| **Facts planted at head and tail** | HIGH | `SCENARIO_FACTS` places key answers at the very beginning (`frontFacts`) and very end (`tailFacts`) of the expanded context. This exploits LLM primacy/recency bias, making baseline artificially easier than real scattered data. |
| **Single repeat default** | HIGH | `repeats` defaults to 1. With N=1, any result is anecdotal — no confidence intervals, no variance estimate. |
| **Synthetic noise is monotonous** | MEDIUM | `buildNoise()` generates lines like `auth-timeout-prefix line=42 status=ok latency_ms=47 cpu=52 mem=242`. Real noise has varied log formats, stack traces, config fragments, and prose. Monotonous noise is easier for models to skip. |
| **Only 3 scenarios** | MEDIUM | Auth-timeout, memory-leak, API-migration — all software debugging. No task diversity. |
| **No false-positive scenarios** | HIGH | Every scenario is one where Context Guardian *should* help. No scenarios where the system should stay out of the way. |
| **Token approximation for large text** | LOW | `countTokens()` uses `text.length / 3.5` for text > 20K chars. Acceptable for ballpark, but introduces ~10-15% error. |
| **Requires Factory Droid CLI** | MEDIUM | Not reproducible by external contributors without the proprietary `droid` binary. |

### 1.2 `run-multi-task-benchmark.ts` — Multi-Task Token Comparison

**What it measures**: Compares regex extraction on truncated context vs. MCP grep on full indexed content.

**Methodology flaws**:

| Issue | Severity | Detail |
|-------|----------|--------|
| **Not an LLM benchmark** | CRITICAL | Raw mode uses `p.extract(truncatedContext)` — a regex. MCP mode uses `mcpCall(app, id, 'grep', ...)` — also a regex over indexed data. Neither calls a real LLM. This measures "can grep beat regex on partial data" — trivially yes. The "accuracy" metric is misleading because it implies model reasoning quality. |
| **Baseline deliberately handicapped** | HIGH | Raw mode truncates to 32K tokens via binary search. MCP mode indexes ALL tokens. The comparison is "regex on partial data" vs. "grep on full data." Of course the full-data approach wins. |
| **Mock LLM** | HIGH | Uses a mock adapter that classifies via keyword matching (`includes('error')` → 'error'). Not representative of real local LLM behavior. |
| **Single run, no repeats** | HIGH | No variance measurement. |
| **Same 3 scenarios** | MEDIUM | Same limitation as droid-ab. |
| **"Cloud input tokens" metric is synthetic** | MEDIUM | Reports `cloudInputTokens` but never calls a cloud API. The number is `countTokens(question + JSON.stringify(toolArgs))` — an estimate of what a cloud call would cost, not measured reality. |

### 1.3 `run-provider-ab.ts` — Direct Provider A/B

**What it measures**: Calls real OpenAI/Anthropic APIs with raw vs. rewritten prompts.

**Methodology flaws**:

| Issue | Severity | Detail |
|-------|----------|--------|
| **Requires API keys + money** | HIGH | Not reproducible without `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` and spending real dollars. |
| **Requires Ollama running locally** | HIGH | Depends on `OllamaAdapter` with specific model (`qwen3.5:4b`). Not reproducible without exact local setup. |
| **Fewer checks per scenario** | MEDIUM | Only 4 checks (vs. 6 in droid-ab), reducing statistical power further. |
| **Single run** | HIGH | No repeats, no confidence intervals. |
| **Raw mode truncated** | HIGH | Same truncation handicap as multi-task benchmark. |
| **Same 3 scenarios** | MEDIUM | Same limitation. |
| **No warm-up / API caching control** | LOW | First call may hit cold cache; subsequent calls may benefit from provider-side caching. No accounting for this. |

### 1.4 `run-semantic-routing-benchmark.ts` — Routing Decisions

**What it measures**: Tests whether the interceptor correctly routes prompts to passthrough/context_shape/full_rewrite.

**Methodology flaws**:

| Issue | Severity | Detail |
|-------|----------|--------|
| **Requires Ollama** | HIGH | Real dependency on local LLM. Not reproducible without it. |
| **Only 6 test cases** | HIGH | Far too few to validate a routing policy. Need 20+ covering edge cases. |
| **Expected modes are subjective** | MEDIUM | `api-migration-clean` expected as "passthrough" with note "unless it gets huge" — but "huge" is undefined. Ground truth is hand-picked without formal criteria. |
| **No adversarial cases** | HIGH | No cases designed to trick the router (e.g., short text with many error keywords, or long text that's already focused). |
| **Noise generation simplistic** | LOW | 420 lines of identical telemetry format. |

### 1.5 Cross-Cutting Issues

1. **All scenarios are synthetic and authored by the same person** — no external ground truth.
2. **Only software debugging domain** — no documentation, planning, data analysis, or creative tasks.
3. **No multi-turn conversation benchmarks** — all single-turn.
4. **100% accuracy both modes in last reported run** — when both modes score perfectly, the benchmark cannot differentiate. Need harder scenarios.
5. **No cost-of-local-compute accounting** — claims "86.9% token reduction" but doesn't measure Ollama inference time, memory, or energy.
6. **Results files show the benchmark was already aware of flaws** — `RESULTS.md` honestly notes "for this scenario (2,800 tokens), the raw dump approach wins" but the aggregate claims don't reflect this nuance.

---

## Part 2: OSS Benchmark Design

### 2.1 Design Principles

1. **Reproducible by anyone**: `npm run bench:oss` works without API keys for local mode.
2. **Honest by default**: includes scenarios where Context Guardian should NOT help.
3. **Statistically defensible**: multiple repeats with CI.
4. **Machine + human readable**: JSON output + markdown report.
5. **Claims only from data**: explicit thresholds before any claim is made.

### 2.2 Architecture

```
benchmark/
  oss/
    scenarios/          # 12 scenario definition files
    harness.ts          # Core benchmark runner
    metrics.ts          # Metric computation + statistics
    report.ts           # JSON + markdown report generation
    claims.ts           # Claims framework
    run-oss-benchmark.ts  # Entry point: `npm run bench:oss`
```

**Entry point**: `npm run bench:oss` → runs `tsx benchmark/oss/run-oss-benchmark.ts`

**Modes**:
- `--mode local` (default): Uses mock LLM + real MCP server in-process. No API keys. Measures routing, indexing, retrieval accuracy.
- `--mode cloud`: Uses real cloud API. Requires `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Measures end-to-end quality.
- `--repeats N` (default: 3): Number of repeats per scenario.
- `--scenarios <list>`: Comma-separated scenario IDs, or `all`.

### 2.3 Scenario Definitions (12 scenarios)

Each scenario has:
- `id`: Unique identifier
- `title`: Human-readable name
- `description`: What the scenario tests
- `category`: `debugging` | `planning` | `documentation` | `data-analysis` | `negative`
- `contextSize`: `small` (<2K tokens) | `medium` (2K-10K) | `large` (10K-50K) | `huge` (50K+)
- `contextGenerator`: Function returning `{ task: string; rawContext: string; groundTruth: GroundTruthItem[] }`
- `expectedBehavior`: `should_help` | `should_not_help` | `marginal`
- `groundTruth`: Array of `{ key: string; question: string; answer: string; source: string; extractRegex: RegExp }`

#### Scenario 1: `small-clean-fix`
- **Category**: negative
- **Context size**: small (~200 tokens)
- **Description**: Short, focused bug fix request with no noise. "Fix the off-by-one error in `calculateTotal()` where the loop starts at 1 instead of 0."
- **Expected behavior**: `should_not_help` — Context Guardian should pass through.
- **Ground truth**: 2 checks (loop start value, function name)
- **Why it exists**: Measures false positive rate. If CG rewrites this, it's wasting resources.

#### Scenario 2: `small-already-focused`
- **Category**: negative
- **Context size**: small (~500 tokens)
- **Description**: A well-structured prompt with a clear config snippet and one question. "Given this nginx config block (15 lines), what's the proxy_read_timeout value?"
- **Expected behavior**: `should_not_help`
- **Ground truth**: 1 check (timeout value)
- **Why it exists**: Tests that CG doesn't interfere with already-focused context.

#### Scenario 3: `medium-single-artifact`
- **Category**: negative
- **Context size**: medium (~3K tokens)
- **Description**: A single TypeScript file with a clear bug. No noise, no mixed artifacts. "Review this file and find the race condition."
- **Expected behavior**: `should_not_help`
- **Ground truth**: 3 checks (race condition location, affected variables, fix approach)
- **Why it exists**: Medium context that's entirely relevant — rewriting would lose information.

#### Scenario 4: `medium-auth-incident`
- **Category**: debugging
- **Context size**: medium (~5K tokens)
- **Description**: Auth service timeout with logs + code + config (existing scenario, un-expanded).
- **Expected behavior**: `marginal` — CG may help slightly with noise filtering but context fits in window.
- **Ground truth**: 6 checks (max_retries, jwks_cache_ttl_ms, failure_threshold, DNS failure, retry_backoff_ms, incident_ticket)
- **Why it exists**: Tests the marginal zone where CG's value is debatable.

#### Scenario 5: `medium-memory-leak`
- **Category**: debugging
- **Context size**: medium (~5K tokens)
- **Description**: Memory leak triage with heap snapshot + metrics + code (existing scenario, un-expanded).
- **Expected behavior**: `marginal`
- **Ground truth**: 6 checks (listener count, unfreed MB, cleanup missing, pending timeouts, patch SHA, history cap)
- **Why it exists**: Another marginal-zone scenario for calibration.

#### Scenario 6: `large-noisy-auth`
- **Category**: debugging
- **Context size**: large (~30K tokens)
- **Description**: Auth incident buried in 25K tokens of mixed telemetry, unrelated service logs, and deployment manifests. Key facts scattered throughout (not at head/tail).
- **Expected behavior**: `should_help`
- **Ground truth**: 6 checks (same as medium-auth but facts positioned at random offsets within noise)
- **Why it exists**: Tests CG's core value proposition — finding signals in noise at scale.
- **Critical design choice**: Facts are placed at random positions (25%, 40%, 55%, 70%, 85% through the context), NOT at head/tail, to avoid primacy/recency bias.

#### Scenario 7: `large-noisy-memory-leak`
- **Category**: debugging
- **Context size**: large (~30K tokens)
- **Description**: Memory leak data buried in deployment logs, k8s events, and monitoring alerts.
- **Expected behavior**: `should_help`
- **Ground truth**: 6 checks
- **Why it exists**: Second large scenario for statistical power.

#### Scenario 8: `large-api-migration`
- **Category**: planning
- **Context size**: large (~25K tokens)
- **Description**: API migration spec mixed with old API code, database schemas, existing tests, and unrelated service documentation.
- **Expected behavior**: `should_help`
- **Ground truth**: 6 checks (default_limit, rate_limit, soft_delete_field, error_keys, migration_deadline, rollout_strategy)
- **Why it exists**: Tests a planning/implementation task (not debugging).

#### Scenario 9: `huge-full-repo-dump`
- **Category**: documentation
- **Context size**: huge (~80K tokens)
- **Description**: Full repository dump of a medium-sized project (10+ files, mix of TypeScript, configs, tests, README). Task: "Explain the authentication architecture and identify the three main entry points."
- **Expected behavior**: `should_help`
- **Ground truth**: 5 checks (architecture components, entry points, key interfaces, config location, test coverage)
- **Why it exists**: Tests the extreme case where truncation is unavoidable for raw dump.

#### Scenario 10: `huge-ci-failure-dump`
- **Category**: debugging
- **Context size**: huge (~60K tokens)
- **Description**: CI pipeline failure with full build log, test output (200+ tests, 3 failures), lint warnings, and deployment config. Task: "Find the 3 failing tests and their root causes."
- **Expected behavior**: `should_help`
- **Ground truth**: 6 checks (3 test names, 3 error messages)
- **Why it exists**: Realistic huge context that agents actually encounter.

#### Scenario 11: `large-mixed-language`
- **Category**: data-analysis
- **Context size**: large (~20K tokens)
- **Description**: Database query results (500 rows CSV), a Python analysis script, and a TypeScript API endpoint. Task: "What's the p95 latency for requests in the last hour and which endpoint is slowest?"
- **Expected behavior**: `should_help`
- **Ground truth**: 3 checks (p95 value, slowest endpoint, request count)
- **Why it exists**: Non-debugging task type to test generalization.

#### Scenario 12: `medium-adversarial-keywords`
- **Category**: negative
- **Context size**: medium (~4K tokens)
- **Description**: A well-structured code review with many error/warning keywords in comments and string literals (not actual errors). `// TODO: handle the ERROR case where timeout FAILS` etc.
- **Expected behavior**: `should_not_help`
- **Ground truth**: 3 checks (review findings)
- **Why it exists**: Adversarial case — high semantic signal score but content is focused and useful. Tests false positive rate of the routing heuristic.

### 2.4 Metric Definitions

#### 2.4.1 Primary Metrics

| Metric | Formula | Description |
|--------|---------|-------------|
| **Accuracy** | `correct / total` | Fraction of ground-truth checks answered correctly |
| **Precision** | `correct / answered` | Among attempted answers, fraction correct |
| **Recall** | `answered / total` | Fraction of checks that received any answer |
| **Token Reduction** | `1 - (cg_cloud_input / baseline_cloud_input)` | Cloud-side input token savings |
| **Latency Overhead** | `cg_total_ms / baseline_total_ms` | Wall-clock time ratio (CG vs baseline) |
| **False Positive Rate** | `should_not_help_scenarios_intercepted / should_not_help_scenarios_total` | How often CG rewrites when it shouldn't |
| **False Negative Rate** | `should_help_scenarios_not_intercepted / should_help_scenarios_total` | How often CG passes through when it should help |

#### 2.4.2 Secondary Metrics

| Metric | Formula | Description |
|--------|---------|-------------|
| **Billed Token Reduction** | `1 - (cg_billed / baseline_billed)` where billed = input + output | End-to-end cost proxy |
| **Information Preservation** | `cg_accuracy / baseline_accuracy` on scenarios where baseline has full context | Does CG lose information when rewriting? |
| **Quality-Adjusted Token Savings** | `token_reduction × (cg_accuracy / max(cg_accuracy, baseline_accuracy))` | Penalizes token savings if accuracy drops |
| **Local Compute Overhead** | `ollama_inference_ms + indexing_ms` | Cost of local processing (wall-clock) |

#### 2.4.3 Per-Scenario Metrics

Every scenario reports all primary + secondary metrics individually, enabling drill-down analysis.

### 2.5 Statistical Methodology

#### 2.5.1 Repeats

- **Default**: 3 repeats per scenario per mode.
- **Recommended for publication**: 5 repeats.
- Each repeat uses a fresh VectorStore instance and a fresh noise seed (for scenarios with noise).

#### 2.5.2 Summary Statistics (per metric, per scenario)

```typescript
interface MetricSummary {
  n: number;          // repeat count
  mean: number;
  std: number;        // sample standard deviation
  ci95_low: number;   // mean - t_crit * (std / sqrt(n))
  ci95_high: number;  // mean + t_crit * (std / sqrt(n))
  min: number;
  max: number;
  values: number[];   // raw values for transparency
}
```

- **Confidence intervals**: 95% CI using Student's t-distribution (appropriate for small N).
- **t-critical values**: Hardcoded lookup table for N=2..10 (no dependency needed).

#### 2.5.3 Aggregate Statistics

Aggregate metrics are computed as weighted means across scenarios, weighted by number of ground-truth checks.

```
aggregate_accuracy = sum(scenario_correct) / sum(scenario_total)
```

Aggregate CIs are computed via the same repeat-level methodology:
```
per_repeat_aggregate = sum(correct_in_repeat_i) / sum(total_in_repeat_i)
CI = mean(per_repeat_aggregates) ± t_crit * std(per_repeat_aggregates) / sqrt(N)
```

#### 2.5.4 Significance Testing

For each metric, a paired difference test is reported:

```typescript
interface PairedComparison {
  metric: string;
  baseline_mean: number;
  cg_mean: number;
  delta_mean: number;
  delta_ci95: [number, number];
  significant: boolean;  // true if CI doesn't cross zero
}
```

**Significance rule**: A claim is "statistically supported" only if the 95% CI of the paired difference does not cross zero.

### 2.6 Claims Framework

The benchmark produces claims only when data meets specific thresholds. Each claim has a status: `SUPPORTED`, `NOT_SUPPORTED`, or `INSUFFICIENT_DATA`.

#### Claim 1: "Context Guardian reduces cloud token usage"
- **Threshold**: Mean token reduction > 50% with 95% CI lower bound > 30%, on `should_help` scenarios.
- **Caveat required**: "On scenarios with >10K tokens of context."
- **Anti-claim check**: If token reduction on `should_not_help` scenarios is > 5%, add warning: "System also rewrites unnecessarily in X% of small/focused prompts."

#### Claim 2: "Context Guardian preserves answer accuracy"
- **Threshold**: Mean accuracy delta (CG - baseline) > -5 percentage points, with 95% CI lower bound > -10pp.
- **Stronger version**: If delta > 0 and CI lower bound > 0, claim "CG improves accuracy."
- **Failure mode**: If accuracy drops > 10pp on any scenario, flag it explicitly.

#### Claim 3: "Context Guardian has acceptable latency overhead"
- **Threshold**: Mean latency ratio < 3.0x with 95% CI upper bound < 5.0x.
- **Reporting**: Always report absolute latency values, not just ratios.

#### Claim 4: "Context Guardian correctly routes small/focused prompts"
- **Threshold**: False positive rate < 20% (i.e., ≥80% of `should_not_help` scenarios are passed through).
- **Ideal**: FPR < 10%.

#### Claim 5: "Context Guardian activates reliably on large/noisy contexts"
- **Threshold**: False negative rate < 10% (i.e., ≥90% of `should_help` scenarios are intercepted).

#### Claims Summary Table (in report output)

```
| Claim | Status | Evidence | Caveats |
|-------|--------|----------|---------|
| Token reduction >50% on large contexts | SUPPORTED | 72.3% mean [65.1%, 79.5%] CI | Only tested on synthetic scenarios |
| Accuracy preserved (≤5pp drop) | SUPPORTED | +2.1pp mean [-1.3pp, +5.5pp] CI | N=3 repeats |
| Latency overhead <3x | NOT_SUPPORTED | 3.4x mean [2.8x, 4.0x] CI | -- |
| FPR <20% | SUPPORTED | 8.3% [0%, 25%] CI | Only 4 negative scenarios |
| FNR <10% | SUPPORTED | 0% [0%, 12%] CI | Only 6 positive scenarios |
```

### 2.7 Report Output Format

#### 2.7.1 JSON Report (`benchmark/oss/results.json`)

```typescript
interface OSSBenchmarkReport {
  metadata: {
    generatedAt: string;        // ISO 8601
    version: string;            // benchmark version
    mode: 'local' | 'cloud';
    repeats: number;
    model?: string;             // cloud model, if used
    localLLM?: string;          // local model name
    nodeVersion: string;
    platform: string;
  };
  scenarios: Array<{
    id: string;
    title: string;
    category: string;
    contextSize: string;
    contextTokens: number;
    expectedBehavior: string;
    groundTruthCount: number;
    baseline: {
      accuracy: MetricSummary;
      precision: MetricSummary;
      recall: MetricSummary;
      cloudInputTokens: MetricSummary;
      cloudOutputTokens: MetricSummary;
      latencyMs: MetricSummary;
    };
    contextGuardian: {
      accuracy: MetricSummary;
      precision: MetricSummary;
      recall: MetricSummary;
      cloudInputTokens: MetricSummary;
      cloudOutputTokens: MetricSummary;
      latencyMs: MetricSummary;
      localComputeMs: MetricSummary;
      routeDecision: string;     // passthrough | context_shape | full_rewrite
      intercepted: boolean;
    };
    comparison: {
      tokenReduction: MetricSummary;
      accuracyDelta: MetricSummary;
      latencyRatio: MetricSummary;
      qualityAdjustedSavings: MetricSummary;
    };
  }>;
  aggregate: {
    shouldHelp: AggregateBlock;
    shouldNotHelp: AggregateBlock;
    marginal: AggregateBlock;
    overall: AggregateBlock;
  };
  claims: Array<{
    id: string;
    statement: string;
    status: 'SUPPORTED' | 'NOT_SUPPORTED' | 'INSUFFICIENT_DATA';
    evidence: string;
    caveats: string[];
  }>;
  rawData: Array<{
    scenarioId: string;
    repeat: number;
    mode: 'baseline' | 'context_guardian';
    accuracy: number;
    precision: number;
    recall: number;
    cloudInputTokens: number;
    cloudOutputTokens: number;
    latencyMs: number;
    localComputeMs: number;
    answers: Record<string, string>;
  }>;
}
```

#### 2.7.2 Markdown Report (`benchmark/oss/RESULTS.md`)

Generated from the JSON data. Includes:
1. **Executive Summary**: 3-5 bullet points with key findings.
2. **Per-Scenario Table**: Accuracy, token reduction, latency for each scenario.
3. **Claims Table**: Status of each claim with evidence.
4. **Methodology Notes**: Repeat count, CI method, known limitations.
5. **Raw Data Reference**: Link to JSON file for reproducibility.

### 2.8 Improvements Needed in Existing Code

#### 2.8.1 Critical Fixes (must do before any public benchmark)

1. **Remove pre-built search plan from MCP prompt** (`run-droid-ab.ts` lines building `plan`). The MCP mode should receive the same task description and questions as baseline. The model should decide what to grep for.

2. **Randomize fact placement in noise** (`buildExpandedContext`). Facts should not be at head/tail. Use randomized insertion points.

3. **Add repeat support everywhere**. All benchmarks should default to ≥3 repeats and compute CIs.

4. **Add negative (should-not-help) scenarios**. At minimum, add 3 scenarios where CG should pass through.

#### 2.8.2 High Priority

5. **Replace mock LLM in multi-task benchmark** with either a real local LLM call or an explicit disclaimer that it measures retrieval quality, not LLM reasoning.

6. **Make noise more realistic**. Mix in varied log formats, code snippets from unrelated files, config fragments, and prose (README sections).

7. **Add information preservation metric**. When CG rewrites, measure whether the rewritten prompt still contains all the information needed to answer correctly.

8. **Separate "local-only" benchmark** from "needs-API-key" benchmark. The `bench:oss` command should work without any external dependencies.

#### 2.8.3 Medium Priority

9. **Add multi-turn scenarios**. Real agent sessions involve 5-15 turns of context accumulation.

10. **Add cost accounting for local compute**. Report Ollama inference time and memory usage alongside cloud token savings.

11. **Seed randomness for reproducibility**. Use deterministic seeds for noise generation so results are reproducible across runs.

12. **Version the benchmark**. Include a version number so results from different benchmark versions aren't compared.

### 2.9 Noise Generation Improvements

The current `buildNoise()` generates monotonous telemetry lines. Replace with a realistic noise generator:

```typescript
function generateRealisticNoise(targetTokens: number, seed: number): string {
  const rng = createSeededRng(seed);
  const blocks: string[] = [];
  const templates = [
    // Unrelated service logs
    (i: number) => `2026-04-07T${pad(9 + (i % 12))}:${pad(i % 60)}:${pad(i % 60)}Z INFO  [billing] Invoice ${1000 + i} processed for customer cust_${rng.hex(8)} amount=$${(rng.float() * 500).toFixed(2)}`,
    // Kubernetes events
    (i: number) => `  Normal  Scheduled  pod/api-${rng.hex(6)}  Successfully assigned default/api-${rng.hex(6)} to node-${1 + (i % 5)}`,
    // Deployment manifests
    (i: number) => `    - name: REDIS_URL\n      value: "redis://cache-${i % 3}:6379/0"`,
    // Unrelated code
    (i: number) => `export function handleBilling(invoice: Invoice): Promise<Receipt> {\n  return billingService.process(invoice);\n}`,
    // Monitoring alerts (resolved)
    (i: number) => `[RESOLVED] Alert: CPU usage on worker-${i % 8} returned to normal (was 89%, now 34%)`,
    // Config fragments
    (i: number) => `server:\n  port: ${3000 + (i % 20)}\n  host: 0.0.0.0\n  workers: ${2 + (i % 6)}`,
    // README prose
    () => `This module handles the core business logic for user management. It integrates with the authentication service and the billing pipeline.`,
    // Test output
    (i: number) => `  ✓ should create a new user (${45 + (i % 200)}ms)\n  ✓ should validate email format (${3 + (i % 20)}ms)`,
  ];

  let tokens = 0;
  let i = 0;
  while (tokens < targetTokens) {
    const template = templates[i % templates.length];
    const block = template(i);
    blocks.push(block);
    tokens += countTokens(block);
    i++;
  }
  return blocks.join('\n');
}
```

### 2.10 Fact Placement Strategy

Replace head/tail placement with randomized scattering:

```typescript
function scatterFacts(
  noise: string,
  facts: Array<{ text: string; positionPct: number }>,
): string {
  const lines = noise.split('\n');
  // Sort facts by position descending to avoid index shift
  const sorted = [...facts].sort((a, b) => b.positionPct - a.positionPct);
  for (const fact of sorted) {
    const insertIdx = Math.floor(lines.length * fact.positionPct);
    lines.splice(insertIdx, 0, '', fact.text, '');
  }
  return lines.join('\n');
}
```

Facts should be placed at varying depths (20%, 35%, 50%, 65%, 80%) to test retrieval across the full context window.

### 2.11 Execution Flow

```
npm run bench:oss
  │
  ├─ Parse CLI args (--mode, --repeats, --scenarios)
  ├─ Load scenario definitions
  │
  ├─ For each scenario:
  │   ├─ Generate context (with seeded randomness)
  │   │
  │   ├─ For each repeat:
  │   │   ├─ BASELINE run:
  │   │   │   ├─ [local mode] Regex extraction on raw/truncated context
  │   │   │   ├─ [cloud mode] Send raw context to cloud API
  │   │   │   └─ Score against ground truth
  │   │   │
  │   │   ├─ CONTEXT GUARDIAN run:
  │   │   │   ├─ Run analyzeRequest() for routing decision
  │   │   │   ├─ If intercepted: index + rewrite via MCP/rewriter
  │   │   │   ├─ [local mode] Regex/grep extraction on rewritten context
  │   │   │   ├─ [cloud mode] Send rewritten context to cloud API
  │   │   │   └─ Score against ground truth
  │   │   │
  │   │   └─ Record raw data point
  │   │
  │   └─ Compute per-scenario MetricSummary with CI
  │
  ├─ Compute aggregate metrics
  ├─ Evaluate claims
  ├─ Write results.json
  └─ Write RESULTS.md
```

### 2.12 package.json Script

```json
{
  "bench:oss": "tsx benchmark/oss/run-oss-benchmark.ts",
  "bench:oss:cloud": "tsx benchmark/oss/run-oss-benchmark.ts --mode cloud",
  "bench:oss:quick": "tsx benchmark/oss/run-oss-benchmark.ts --repeats 1 --scenarios small-clean-fix,medium-auth-incident,large-noisy-auth"
}
```

---

## Part 3: Summary of Findings

### What the existing benchmarks get right
- Honest self-assessment in RESULTS.md (acknowledges small-context weakness)
- Multiple benchmark types testing different aspects
- JSON output support
- Ground-truth based scoring (not subjective)

### What must change for defensible public claims
1. **Equal information in prompts**: Both modes must receive the same task description without pre-built search plans.
2. **Randomized fact placement**: No primacy/recency exploitation.
3. **Statistical rigor**: ≥3 repeats with CIs on all metrics.
4. **Negative scenarios**: Must prove CG doesn't hurt when it shouldn't help.
5. **Claims only from data**: The claims framework gates every assertion on specific statistical thresholds.
6. **Reproducibility**: Local mode must work with zero external dependencies beyond npm.
