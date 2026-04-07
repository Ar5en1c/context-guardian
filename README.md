# Context Guardian

Edge-Cloud Hybrid Agent Harness. A local proxy that intercepts massive prompts from AI coding agents, chunks and indexes the raw data locally using a sub-8B LLM, and forces cloud models to use deterministic RAG tools instead of context-stuffing.

## The Problem

Cloud coding agents (Aider, OpenCode, Claude Code, Cursor) dump entire files, logs, and stack traces into context windows. This wastes tokens, hits context limits, and degrades model output quality as irrelevant data dilutes the actual task.

## How It Works

```
Agent (Aider/OpenCode/etc.)
    │
    ▼
Context Guardian Proxy (localhost:9119)
    │
    ├─ Small request? → passthrough to cloud unchanged
    │
    ├─ Large request? →
    │   1. Local LLM extracts intent ("Fix the auth timeout bug")
    │   2. Chunks raw data (logs, code, traces) → vector + FTS index
    │   3. Rewrites prompt: goal + tool definitions (no raw data)
    │   4. Cloud calls tools to fetch specific data on-demand
    │   5. Multi-round tool loop (up to 10 rounds)
    │   6. Response streamed back to agent as SSE
    │
    ▼
Cloud API (OpenAI / Anthropic)
```

## Quick Start

```bash
# Prerequisites
# 1. Node.js >= 20
# 2. Ollama running locally (https://ollama.ai)
ollama pull qwen3.5:4b
ollama pull nomic-embed-text

# Install
npm install -g context-guardian

# Generate config
context-guardian init

# Start the proxy
context-guardian start

# Point your agent at the proxy
export OPENAI_BASE_URL=http://localhost:9119/v1
# Then use Aider, OpenCode, etc. as normal
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `start` | Start the proxy server |
| `check` | Verify Ollama and models are available |
| `init` | Generate `guardian.config.json` |
| `eval --prompt "..."` | A/B comparison: with vs without proxy |
| `dry-run --file input.txt` | Show rewrite without forwarding to cloud |
| `sessions` | List recent proxy sessions |

## Configuration

```json
{
  "port": 9119,
  "threshold_tokens": 8000,
  "context_budget": 4000,
  "local_llm": {
    "backend": "ollama",
    "model": "qwen3.5:4b",
    "endpoint": "http://localhost:11434",
    "embed_model": "nomic-embed-text"
  },
  "cloud": {
    "openai_base": "https://api.openai.com/v1",
    "anthropic_base": "https://api.anthropic.com"
  },
  "tools": ["log_search", "file_read", "grep", "summary"],
  "verbose": false
}
```

## Key Design Decisions

- **Sub-8B local model**: Qwen 3.5 4B (3.4GB RAM, 97.5% tool calling accuracy) runs on work laptops without GPU
- **Proxy pattern**: Zero config change in agents — just set `OPENAI_BASE_URL`
- **Streaming interception**: Converts intercepted stream requests to non-stream for tool loop, re-synthesizes SSE back to agent
- **Session persistence**: SQLite FTS5 stores indexed chunks across requests within a session
- **Graceful degradation**: If Ollama is down or local LLM fails, requests pass through to cloud unchanged

## Architecture

```
src/
├── cli.ts                    # Commander CLI (start, check, eval, dry-run, sessions)
├── config.ts                 # Zod config schema + file loader
├── proxy/
│   ├── server.ts             # Hono HTTP server, route handlers, tool loop
│   ├── interceptor.ts        # Token counting, threshold analysis
│   ├── rewriter.ts           # Intent extraction → chunk → classify → embed → rewrite
│   ├── streaming.ts          # SSE synthesis (OpenAI + Anthropic formats)
│   └── adapters/
│       ├── openai.ts         # OpenAI format detection, forwarding, tool calls
│       └── anthropic.ts      # Anthropic format, tool_use handling
├── local-llm/
│   ├── adapter.ts            # LLM interface (intent, classify, summarize, embed)
│   └── ollama.ts             # Ollama HTTP client + heuristic classifier
├── index/
│   ├── chunker.ts            # Recursive text splitter
│   ├── store.ts              # In-memory vector store (cosine + keyword)
│   └── session-store.ts      # SQLite FTS5 persistent session store
├── tools/
│   ├── registry.ts           # Tool definition + handler registry
│   ├── log-search.ts         # Search indexed logs by query/severity
│   ├── file-read.ts          # Read indexed code chunks
│   ├── grep.ts               # Regex search across all indexed content
│   └── summary.ts            # Summarize indexed data by topic
└── display/
    ├── dashboard.ts          # Terminal banner + live stats
    ├── logger.ts             # Structured stderr logging
    ├── request-log.ts        # Append-only markdown request log
    └── timing.ts             # Latency instrumentation
```

## Supported Agents

Any agent using the OpenAI or Anthropic API format:

- **Aider** — `export OPENAI_API_BASE=http://localhost:9119/v1`
- **OpenCode** — configure base URL in settings
- **Claude Code** — set `ANTHROPIC_BASE_URL=http://localhost:9119`
- **Continue.dev** — custom model provider URL
- **Any OpenAI-compatible client**

## License

MIT
