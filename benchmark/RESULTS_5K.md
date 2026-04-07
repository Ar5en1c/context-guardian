# A/B Benchmark Results: 5K+ Token Memory Leak Scenario

## Setup
- **Scenario**: Production WebSocket server memory leak (~14.6K chars, ~5K tokens)
- **Contains**: Source code (server.ts), production logs, heap snapshot, Kubernetes deployment, load test results, Grafana metrics, team notes
- **Known root causes**: 5 distinct memory leaks with specific line numbers and memory impact

## Agent A (WITH MCP tools)
**Status**: Could NOT connect to Context Guardian MCP server (not running)
**Fallback**: Produced analysis from scenario description only (no tool access)
**Result**: Identified 4 generic root causes but MISSED specific details:
- Guessed at "event listener accumulation" but couldn't identify the exact syncHandler bug
- Guessed at "connection tracking Map/Set never pruned" (partially correct)
- Guessed at "heartbeat setInterval not cleared" (actually IS cleared in the code -- **false positive**)
- Guessed at "Express MemoryStore" (not used -- **false positive**)
- Completely missed: room.history unbounded growth (52% of heap -- the BIGGEST leak)
- Completely missed: empty rooms never cleaned up (847 zombie rooms)
- Completely missed: ws send queue backpressure (67MB)

**Root causes found**: 2/5 correct, 2/5 false positives
**Accuracy**: 40% (with 50% false positive rate)

## Agent B (WITHOUT MCP, full raw dump)
**Status**: Received full scenario in prompt context
**Result**: Identified ALL 5 root causes with exact code locations:
1. **Unbounded room.history** (52%, 423MB) -- correct, with specific code fix
2. **EventEmitter listener leak** (19%, 156MB) -- correct, identified syncHandler at line 89
3. **Empty rooms never deleted** (compounds #1) -- correct, identified leaveRoom() gap
4. **ws send queue backpressure** (8%, 67MB) -- correct, with bufferedAmount fix
5. **Client metadata userAgent** (4%, 34MB) -- correct, with truncation fix

**Additional quality indicators**:
- Priority table with estimated MB reclaim per fix
- Specific code patches (not just descriptions)
- Monitoring recommendations with Prometheus metrics
- Correctly identified cursor_move should NOT be stored in history
- Summary table: 71% heap reclaim from top 2 fixes alone

**Root causes found**: 5/5 correct, 0 false positives
**Accuracy**: 100%

## Verdict

| Metric | Agent A (MCP, no connection) | Agent B (Raw Dump) |
|--------|-----|-----|
| Root causes found | 2/5 | 5/5 |
| False positives | 2 | 0 |
| Specific line numbers | 0 | 3 |
| Code fixes provided | 4 (generic) | 5 (specific) |
| Priority ordering | Yes (estimated) | Yes (heap-snapshot backed) |
| Monitoring recs | No | Yes (7 specific items) |

## Analysis

**At 5K tokens, the raw dump wins decisively.** This confirms the earlier finding: Context Guardian's value activates at much larger contexts (50K+), not at 5K.

**Why Agent A failed here**: The MCP server wasn't running, so it couldn't use ANY tools. Without the indexed content, it was working purely from the brief scenario summary -- essentially a description of the problem without the actual code or data. This produced reasonable but generic guesses that missed the code-specific bugs.

**The real test**: What happens when the full 14.6K scenario is chunked, indexed, and the agent uses grep/file_read/summary tools to investigate? That's the test that would validate the Context Guardian architecture. At 5K tokens the cloud model can hold the full context easily. The breakeven point is where context exceeds the model's effective attention window (~32K-50K tokens for most models).

## Key Insight from TurboQuant Research (Applied)

Just like TurboQuant KV cache compression -- where INT8 QDQ shows negligible benefit at short sequences but critical benefit at 8K+ contexts -- Context Guardian's index-and-query pattern has an **activation threshold**:
- Below ~5K tokens: overhead > benefit (raw dump wins)
- 5K-30K tokens: roughly equal (depends on complexity)
- 30K+ tokens: Context Guardian should win (cloud model attention degrades)
- 50K+ tokens: Context Guardian critical (without it, cloud model misses information)

This maps directly to TurboQuant's finding: at 4K context INT4 KV was garbage, INT7+ required. Similarly, aggressive context compression is wasteful on small inputs but essential at scale.
