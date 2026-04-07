# Research Notes

## Context Rot / Context Blindness
- LLMs degrade reliably at ~70% of advertised context window (Morph research, March 2026)
- "Lost in the middle" effect: models lose track of instructions buried in large contexts
- Claude Code's leaked source shows even Anthropic fights this with a 3-layer memory system
- Industry term: "Agent Suicide by Context" (StackOne, Jan 2026)

## Claude Code Leak (March 31, 2026)
- 512K lines TypeScript accidentally published via npm source map
- Key finding: 44 permission-gated tools, parallel tool calls, dynamic prompt assembly
- Three-layer memory: in-context, persisted summaries (CLAUDE.md), self-healing verification
- Reference repos:
  - github.com/dadiaomengmeimei/claude-code-sourcemap-learning-notebook
  - github.com/beita6969/claude-code (buildable research fork)
  - github.com/ComeOnOliver/claude-code-analysis

## Open Source Coding Agents (Integration Targets)
- **Aider**: Python, git-first, OpenAI-compatible. Most popular OSS. `--openai-api-base` flag.
- **OpenCode**: Go, 75+ providers, MCP support. `OPENAI_BASE_URL` env var.
- **Goose**: Rust (Block/Square), extensible via MCP servers.
- **Cline CLI**: TS, terminal-native, multi-agent orchestration.
- **Claude Code**: Proprietary but uses standard Anthropic API.

## Relevant Open Source Projects
- **RelayPlane/proxy**: TS, MIT. OpenAI-compatible proxy for AI agents. Good reference for SSE streaming.
- **LiteLLM**: Python SDK + proxy. 100+ LLM providers. Good for understanding multi-provider routing.
- **mcp-agent** (LastMile): Python MCP orchestrator framework.
- **EdgeVec**: Rust/WASM browser-native vector DB.
- **ruvector**: Rust/Node enterprise vector DB.
- **Embrix**: Lightweight local 384-dim embeddings for Node.js.

## Sub-8B Model Benchmarks (April 2026)
Source: jdhodges.com "I Tested 13 Local LLMs on Tool Calling" (March 2026)
- Qwen3.5 4B: 97.5% tool calling accuracy, 3.4 GB GGUF
- Gemma 4 4B: ~90%, strong agentic tool calling
- Phi-4 Mini 3.8B: ~85%, smallest viable
- Llama 3.2 8B: ~88%, solid all-rounder
- Qwen3-Coder-Next: 80B/3B active MoE, code-specific, ~5GB GGUF

## Local LLM Runtimes (April 2026)
- Ollama 0.19: Switched to MLX on Mac = 2x faster. Best DX (one command install).
- llama.cpp: Fastest single-user inference. Manual GGUF management.
- MLX-LM: Apple-native, fastest on M-series. Python only.
- LM Studio: GUI-first, good for testing. Not headless-friendly.
