# Context Guardian

MCP server that cuts cloud LLM costs **36-42%** by indexing context locally and giving agents precision retrieval tools instead of raw context dumps.

Works with any MCP-compatible agent (Claude Code, Cursor, Aider, Cline, Factory Droid). Also works as a transparent proxy for agents that use OpenAI/Anthropic APIs directly.

## How It Works

1. Your agent sends a massive prompt (code + logs + configs) to the cloud
2. Context Guardian intercepts it, chunks and indexes it locally using Ollama
3. Instead of the raw dump, the cloud model gets **tools** to search the indexed content
4. The model retrieves only what it needs → fewer tokens processed → lower cost

The local LLM (Qwen 3.5 4B) handles classification and embedding. The cloud model does the reasoning. You pay for focused retrieval, not haystack scanning.

## Quick Start (MCP Mode)

```bash
# Install
npm install -g context-guardian

# Start the MCP server
context-guardian mcp

# Add to your agent's MCP config:
#   URL: http://localhost:9120/mcp
```

### Factory Droid
```bash
droid mcp add context-guardian http://localhost:9120/mcp --type http
```

### Claude Code / Cursor / Cline
Add to your MCP settings:
```json
{
  "mcpServers": {
    "context-guardian": {
      "url": "http://localhost:9120/mcp"
    }
  }
}
```

## Quick Start (Proxy Mode)

```bash
# Start the proxy
context-guardian start

# Point your agent to the proxy instead of OpenAI/Anthropic:
export OPENAI_BASE_URL=http://localhost:9119/v1
```

The proxy intercepts requests above the token threshold, rewrites them with RAG tools, runs a multi-round tool loop with the cloud, and returns the final response. Requests below the threshold pass through unchanged.

## Requirements

- **Node.js 20+**
- **Ollama** running locally with:
  - `ollama pull qwen3.5:4b` (intent extraction + classification)
  - `ollama pull nomic-embed-text` (embeddings)

## MCP Tools Exposed

| Tool | Description |
|------|-------------|
| `index_content` | Index raw text (code, logs, configs) into the local store |
| `grep` | Regex search across all indexed content with context lines |
| `log_search` | Search logs/errors by query with relevance scoring |
| `file_read` | Read a specific indexed file or path |
| `summary` | Get a summary of indexed content by topic |
| `repo_map` | Structural map of indexed repository (key files + symbols) |
| `file_tree` | Compact file tree with coverage summary |
| `symbol_find` | Find functions/classes/interfaces across indexed code |
| `git_diff` | Inspect git changes (working/staged/all scope) |
| `test_failures` | Summarize failing tests from logs or run project tests |
| `run_checks` | Run lint/typecheck/test/build validation |

## Benchmark Results

Measured on a **real codebase** (WebLLM/Bonsai-WebGPU R&D repository — public), 3 scenarios (75K-98K tokens each), 3 repeats, live Claude Opus via Factory Droid.

| Mode | Accuracy | Token Reduction | Cost Reduction |
|------|----------|-----------------|----------------|
| Baseline (raw dump) | 100% | — | — |
| **MCP (unguided)** | **100%** | **43.3%** | **35.8%** |
| Guided (search plan) | 94.4% | 53.6% | 42.0% |

**Key findings:**
- **Zero accuracy loss** when the cloud model uses tools autonomously (unguided MCP mode)
- **36-42% cost reduction** measured in actual billed tokens (Anthropic pricing)
- On investigation tasks (finding bugs in 75K+ token logs), cost savings reach **50-67%**
- On dense, mostly-relevant code contexts, savings are minimal (~2-14%) — CG correctly adds less value when context is already focused
- Adds **15-25 seconds** per request (MCP indexing + tool calls). Negligible for 20-30 minute agent sessions

### Methodology
- Real files, not synthetic noise. Context is actual GPU kernel code, audit documents, and analysis reports
- Facts scattered at random positions (not head/tail) to avoid primacy/recency bias
- Ground truth is regex-checked against specific values in the codebase
- 95% confidence intervals computed via Student's t-distribution
- Reproducible: `npm run bench:oss` (local, no API key needed) or `npm run bench:realworld` (requires Droid CLI)
- Full results in `benchmark/realworld-3way-results.json`

## CLI Commands

```bash
context-guardian start          # Start proxy server (port 9119)
context-guardian mcp            # Start MCP server (port 9120)
context-guardian init           # Generate default config file
context-guardian sessions       # List recent proxy sessions
context-guardian compact        # Manual session compaction
context-guardian eval --prompt  # A/B evaluation of a prompt
context-guardian dry-run --file # Preview rewrite without cloud call
context-guardian check          # Verify Ollama + model availability
```

## Configuration

Create `.context-guardian.json` with `context-guardian init`, or pass CLI flags:

```bash
context-guardian start \
  --port 9119 \
  --threshold 8000 \      # tokens above this trigger interception
  --budget 4000 \         # max tokens in rewritten request
  --model qwen3.5:4b \    # local LLM model
  --endpoint http://localhost:11434  # Ollama URL
```

## Architecture

```
Agent (Claude Code, Cursor, Aider...)
  │
  ├─[MCP mode]─→ Context Guardian MCP Server ──→ Ollama (local)
  │               index_content / grep / search    ↓
  │               ←── tool results ────────────── chunks + embeddings
  │
  └─[Proxy mode]→ Context Guardian Proxy ──→ Cloud API (OpenAI/Anthropic)
                   intercept → rewrite → tool loop → response
```

**Local processing:** Chunking, classification (7 types), embedding (nomic-embed-text), cosine similarity search, entity extraction, session memory with SQLite persistence.

**Cloud forwarding:** OpenAI and Anthropic format detection, multi-round tool call loop (up to 10 rounds), streaming SSE synthesis, auto-compaction of tool loop context.

## License

MIT

## Author

Kuldeep Singh — [LinkedIn](https://www.linkedin.com/in/kuldeep-5ingh/)
