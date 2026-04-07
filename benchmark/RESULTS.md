# Context Guardian A/B Benchmark Results

## Test Date: 2026-04-07
## Environment: Factory Droid (macOS), Ollama 0.20.3, qwen3.5:4b, Node 22

---

## Scenario: Authentication Service Timeout

**Task**: Users report intermittent login failures. The auth service times out validating JWT tokens. Find the root cause and propose a fix with code.

**Context size**: ~2,800 tokens (18 log lines + 30 lines TypeScript + 12 lines YAML config)

---

### Agent A: WITH Context Guardian MCP Tools

**Approach**: Indexed all data via `index_content`, then used `log_search`, `grep`, `file_read`, and `summary` to investigate.

**Tools called**: 5 (index_content, log_search, grep, file_read, summary)

**Root cause identified**:
- Intermittent IDP network/DNS failures
- Zero retries (max_retries: 0)
- JWKS cache TTL (1h) too short for recovery window
- Key rotation creating kid mismatch in stale cache

**Fix proposed**: Retry with exponential backoff, extended cache TTL (4h), local key fallback cache by kid, reduced per-attempt timeouts.

**Quality score**: 4/5 -- Correctly identified all root causes. Fix was directionally correct but less detailed than Agent B's implementation.

---

### Agent B: WITHOUT MCP (Raw Context Dump)

**Approach**: Analyzed the full context directly in a single pass.

**Tools called**: 0

**Root cause identified**:
- Three-part cascade: zero-retry JWKS + tight cache TTL race condition + key rotation during outage
- DNS SERVFAIL as underlying infrastructure trigger
- No proactive background refresh pattern
- No overall validation timeout wrapper

**Fix proposed**: Complete rewritten jwt-validator.ts with:
- `withRetry()` helper (exponential backoff: 200/400/800ms)
- `withTimeout()` wrapper for overall validation
- Local `keyCache` Map (stale-while-revalidate pattern)
- `startProactiveRefresh()` background interval (30 min)
- Updated config.yaml with new parameters

**Quality score**: 5/5 -- Comprehensive analysis with evidence table, complete production-ready code fix, and clear mapping of each fix to each problem.

---

## Analysis

### What the benchmark reveals

| Metric | Agent A (WITH MCP) | Agent B (WITHOUT) |
|--------|-------------------|-------------------|
| Root causes found | 4/4 | 4/4 |
| Fix completeness | Directional | Production-ready |
| Code provided | Summary only | Full implementation |
| Token consumption | ~2,800 indexed + ~500 per tool call | ~2,800 in context |
| Tools called | 5 | 0 |

### Honest Assessment

For this scenario (2,800 tokens), **the raw dump approach wins**. The context is small enough that a cloud model can see everything at once and produce a superior response. The MCP tools added overhead without adding value because:

1. **The context fits comfortably in any cloud model's window** -- there's nothing to compress
2. **Tool calls add latency** -- each call to the MCP server takes time
3. **Information loss** -- the structured tool responses remove nuance that the raw text contains

### Where Context Guardian WOULD win

Context Guardian's value proposition activates when:
- **Context exceeds 50K+ tokens** -- real agent sessions with full file dumps, build logs, test output
- **Multi-turn conversations** -- where stale context from 10 messages ago pollutes the window
- **Repeated investigations** -- session persistence means the 2nd request benefits from the 1st
- **Rate-limited APIs** -- reducing 50K tokens to 5K saves real money at scale

### Key Insight

The benchmark proves the **plumbing works** -- tools index, search, and retrieve correctly. But the value is proportional to context size. For a 2,800 token scenario, the proxy is overhead. For a 50,000+ token scenario (which is 90% of real agent traffic with Aider/Claude Code), the 93% token reduction we measured earlier becomes critical.

### Next Steps for Fair Benchmarking
1. Generate a 50K+ token scenario (full repo dump, CI logs, test failures)
2. Re-run with token counting on both sides
3. Measure cloud API cost difference
4. Test with multi-turn conversations where context accumulates
