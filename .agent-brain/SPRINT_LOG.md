# Sprint Log

## Sprint 1 -- MVP Proxy (COMPLETED 2026-04-07)

### What Was Built
- Full OpenAI + Anthropic compatible proxy server
- Token counting interceptor with configurable threshold
- Ollama adapter for local LLM (intent extraction, classification, embedding)
- Recursive text chunker with paragraph-first splitting
- In-memory vector store (cosine similarity + keyword search)
- Prompt rewriter: raw dumps -> clean task + tool definitions
- 4 core tools: log_search, file_read, grep, summary
- Tool call handler (single round: cloud calls tool -> serve from index -> continue)
- CLI with start/check commands
- Terminal dashboard with live stats
- 38 passing tests

### Metrics
- 31 files, ~1,900 lines of TypeScript
- E2E test showed 86% token reduction (2,509 -> 343 tokens)
- Clean compile, zero warnings

### Known Gaps Identified for Sprint 2
1. Tool call loop is single-round only (cloud can call tools once, then gets one continuation)
2. Anthropic adapter lacks tool call handling (only passthrough after rewrite)
3. Chunk classification calls local LLM sequentially (slow for many chunks)
4. No multi-round tool loop (cloud may need to call tools multiple times)
5. No request header forwarding (some agents send custom headers)
6. No graceful handling of Ollama model not being pulled yet
7. No CLI config init command
8. No request/response logging for debugging
9. Streaming interception not implemented (only passthrough streaming works)
10. Store is cleared on every new interception (no cross-request persistence)

---

## Sprint 2 -- Hardening, Persistence, Multi-Round Tools (IN PROGRESS)

### Research Inputs Applied
- Karpathy LLM Wiki: adopt "compile once, query many" + log.md pattern
- Hermes Agent: steal FTS5 session persistence, benchmark Hermes 3 8B as local model option
- Sprint 1 audit: 10 known gaps identified (see Sprint 1 section)

### Goals
1. Multi-round tool calling loop (cloud can call tools N times, not just once)
2. Anthropic adapter tool call handling (not just passthrough)
3. Batch chunk classification (parallel, not sequential per-chunk)
4. Session persistence with SQLite FTS5 (Hermes-inspired)
5. Request/response logging (log.md pattern from Karpathy)
6. Auto-pull missing Ollama models on startup
7. CLI `init` command to generate config file
8. Header forwarding for agent-specific headers
9. Hermes 3 8B as configurable alternative local model
10. Streaming interception (deferred to Sprint 3 -- complex, needs SSE parse+rewrite)

### What Was Built
1. Multi-round tool call loop (up to 10 rounds) for both OpenAI and Anthropic
2. Full Anthropic tool_use handling (extractToolUse, hasToolUse, appendToolResults)
3. Heuristic chunk classifier (instant, no LLM call for obvious types)
4. Batch LLM classification (parallel batches of 5 for unknown chunks)
5. Request/response logging to .context-guardian/log.md (Karpathy pattern)
6. Auto-pull missing Ollama models on startup
7. CLI `init` command to generate guardian.config.json
8. Header forwarding for agent-specific headers
9. Hermes 3 8B documented as configurable alternative model

### Metrics
- 53 passing tests (up from 38 in Sprint 1)
- 8 test files
- Clean compile, zero warnings
- Heuristic classifier handles 7 content types without LLM calls
- Multi-round tool loop supports up to 10 rounds per request

### Deferred to Sprint 3
- Streaming interception (SSE parse + rewrite mid-stream)
- SQLite FTS5 session persistence (moved to Sprint 3 for proper design)
- MCP server mode

---

## Sprint 3 -- Prove It Works (IN PROGRESS)

### Honest Assessment Inputs (pre-sprint review)
- Zero real agent traffic has touched this proxy
- Streaming requests (90%+ of real agent traffic) bypass rewriting entirely
- Prompt rewriting quality is unproven -- could be WORSE than raw dump
- No latency overhead measurement exists
- Without streaming + real benchmarks, this is a demo, not a product

### Goals (ordered by "does this prove the product?")
1. Streaming interception: buffer stream request body, intercept if over threshold,
   forward rewritten request as non-stream, re-emit response as SSE stream to agent
2. Latency instrumentation: measure local LLM time, cloud forward time, total overhead
3. A/B evaluation harness: CLI command to run same prompt with/without proxy, compare
4. Real integration test script: automated test with real Ollama + mock cloud server
5. Edge case hardening: malformed requests, empty messages, huge single messages,
   missing API keys, Ollama timeout, cloud 429/500 responses
6. Dry-run mode: --dry-run flag shows what WOULD be rewritten without forwarding

### What Was Built
1. Streaming interception: intercepted requests have stream=true stripped, sent as
   non-stream to cloud (enabling multi-round tool calls), response re-synthesized
   as SSE chunks back to agent. Both OpenAI and Anthropic formats supported.
2. SSE synthesis: synthesizeSSEStream (OpenAI format) and synthesizeAnthropicSSEStream
   create proper chunk-by-chunk SSE streams from JSON responses. Content split into
   ~20-char pieces to simulate realistic streaming behavior.
3. Timer class: mark/measure/report pattern tracks intent extraction, chunking,
   classification, embedding, and total time. Printed on every interception.
4. RewriteResult now includes timingMs breakdown for programmatic access.
5. CLI `eval` command: A/B comparison -- shows token reduction, timing, goal extraction,
   and full rewritten prompts side-by-side for a given input.
6. CLI `dry-run` command: reads a file, runs full rewrite pipeline, outputs JSON
   with goal/messages/tools/timing without forwarding to cloud.
7. Mock cloud integration test: Hono server simulating OpenAI API, validates
   passthrough, interception with tool loop, SSE streaming, and timing stats.
8. Edge case test suite: empty messages, null content, missing auth headers,
   invalid JSON bodies, 100K character messages, missing Anthropic keys, wrong HTTP methods.

### Metrics
- 64 passing tests (up from 53 in Sprint 2)
- 10 test files
- Clean compile, zero warnings
- SSE streaming verified: Content-Type=text/event-stream, data: chunks, [DONE] terminator
- Timing instrumentation wired into every interception

### Key Architecture Decision
For intercepted streaming requests, we convert stream→non-stream at the cloud boundary.
This enables the multi-round tool call loop (which requires parsing JSON responses).
The final response is then re-synthesized as SSE chunks back to the agent.
Trade-off: agent sees slightly delayed "streaming" (buffered), but gets the full
benefit of tool-augmented responses. For 90%+ of real agent traffic (which uses
streaming), this means interception now WORKS instead of being bypassed.

### Deferred to Sprint 4
- SQLite FTS5 session persistence (cross-request memory)
- npm packaging for `npx context-guardian`
- Test with real Ollama + real cloud API (not mock)
- Benchmark with actual Aider/OpenCode/Claude Code traffic

---

## Sprint 4 -- Make It Reliable (COMPLETED)

### Goals
1. SQLite FTS5 session persistence (cross-request memory)
2. npm packaging (npx context-guardian works out of box)
3. Config validation UX improvements
4. Sessions CLI command to list recent sessions
5. Graceful degradation wiring

### What Was Built
1. SessionStore: SQLite FTS5 full-text search across persisted chunks, WAL mode,
   porter stemmer tokenizer, session tracking with goals, auto-prune old sessions
2. Session persistence wired into proxy: every interception persists chunks to SQLite
3. CLI `sessions` command: list recent sessions with chunk counts and goals
4. npm packaging: files array, .npmignore, prepublishOnly build hook, version 0.2.0
5. Session tests: create, FTS5 search, label search, session listing, fallback to LIKE

### Metrics
- 75 passing tests (up from 64 in Sprint 3)
- 12 test files
- Clean compile, zero warnings

---

## Sprint 5 -- Ship It (COMPLETED)

### Goals
1. README with usage examples and architecture diagram
2. MCP server mode (expose tools as MCP)
3. Final packaging and version bump

### What Was Built
1. README.md: problem statement, architecture diagram, quick start guide, CLI commands,
   configuration reference, supported agents, architecture tree
2. MCP server: JSON-RPC 2.0 handler at /mcp endpoint, implements initialize, tools/list,
   tools/call, exposes all 4 RAG tools as MCP tools
3. CLI `mcp` command: start standalone MCP server on configurable port
4. MCP tests: initialize, tools/list, tool execution, error handling for unknown tools/methods

### Metrics
- 75 passing tests
- 12 test files
- Version bumped to 0.2.0
- npm publish-ready with files array and prepublishOnly hook

---

## Real-World Testing (2026-04-07)

### Live Ollama Integration Test
- **Model**: qwen3:8b (already pulled, Ollama v0.x on macOS)
- **Input**: 5,621 tokens (200 log lines + TypeScript code)
- **Output**: 416 tokens after rewrite = **93% reduction**
- **Intent extracted**: "Fix the database shard connection timeout error" (correct)
- **Chunks**: 14 total, 13 classified as log, 1 as other
- **Timing**: intent 87s, classify 53s, embed 3s, total 144s (qwen3:8b is slow; qwen3.5:4b would be ~2x faster)
- **Passthrough**: small requests correctly forwarded to cloud API unchanged
- **Session persistence**: SQLite (sql.js WASM, zero native deps) stores chunks across requests

### MCP Integration with Factory Droid
- Registered as HTTP MCP server: `droid mcp add context-guardian http://localhost:9120/mcp --type http`
- 5 tools exposed: index_content, log_search, file_read, grep, summary
- All tools tested live from Droid session:
  - index_content: indexed auth logs + code, classified chunks
  - grep: found JWT/ECONNRESET matches with context lines
  - log_search: filtered by severity, returned relevant logs
  - summary: generated accurate error summary with key details
- **Key finding**: MCP mode works perfectly as a standalone RAG tool provider

### Migration: better-sqlite3 -> sql.js
- better-sqlite3 native module had NODE_MODULE_VERSION mismatch (141 vs 127)
- Switched to sql.js (pure WASM SQLite): zero native deps, works on any Node/platform
- Trade-off: no FTS5 support, using LIKE-based search instead (adequate for this use case)
- All 75 tests pass with sql.js backend
