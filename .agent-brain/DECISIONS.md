# Key Decisions

## 2026-04-07: Model Selection
- **Primary**: Qwen3.5 4B (3.4GB GGUF, 97.5% tool-calling accuracy per jdhodges.com eval)
- **Secondary**: Qwen3-Coder-Next (80B total / 3B active MoE, code-specific)
- **Fallback**: Phi-4 Mini 3.8B (smallest viable, ~2.5GB)
- **Why sub-8B**: Target is work laptops (8-16GB RAM). Must not compete for
  memory with the user's IDE, browser, and the agent itself.

## 2026-04-07: Ollama as Runtime
- Ollama 0.19+ uses Apple MLX on macOS (2x faster than previous Metal backend)
- On Linux/Windows, uses llama.cpp with CUDA/Vulkan
- Single install command, manages model downloads, has embedding endpoint
- Alternative llama.cpp server adapter planned for Sprint 3+

## 2026-04-07: No Web UI
- Product is a CLI tool only. Developers use it from terminal.
- Terminal dashboard shows stats via stderr.
- No React, no browser, no Electron.

## 2026-04-07: OpenAI-Compatible Proxy Pattern
- Users change ONE env var: OPENAI_BASE_URL=http://localhost:9119
- Works with any agent that uses OpenAI-compatible API (Aider, OpenCode, Cursor, etc.)
- Also supports Anthropic Messages API format on /v1/messages
- Zero code changes required in the user's agent.

## 2026-04-07: Graceful Degradation
- If local LLM fails -> passthrough to cloud unchanged
- If embeddings fail -> fall back to keyword search (zero vectors)
- If tool execution fails -> return error string as tool result
- If cloud forward fails -> return 502 with error message
- Never crash the proxy. Agent must always get a response.

## 2026-04-07: TurboQuant KV Research Applicability
- Our KV cache quantization research (INT8) from the parent project applies to
  extending context windows of these sub-8B models on constrained hardware.
- Not implemented in Sprint 1, but the Ollama runtime benefits from similar
  optimizations in its llama.cpp/MLX backends.
- Potential Sprint 4/5: custom GGUF quantization profiles for the guardian model.

## 2026-04-07: Tool Design Philosophy (from Claude Code leak analysis)
- Tools are permission-gated with independent input schemas
- Each tool is a pure function: (args, context) -> string
- Tool results are injected as tool messages, not stuffed into system prompt
- Cloud model must use tools to access data (no raw dumps in rewritten prompt)
