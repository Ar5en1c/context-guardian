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
