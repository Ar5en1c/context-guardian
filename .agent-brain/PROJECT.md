# Context Guardian -- Project Overview

## What This Is
An Edge-Cloud Hybrid Agent Harness. A local CLI proxy that sits between any coding agent
(Claude Code, Aider, Cursor, OpenCode, Goose) and their cloud LLM API. When the agent
tries to context-stuff the cloud model with massive raw data, Context Guardian intercepts
the request, uses a local sub-8B LLM to extract intent and index the data, then rewrites
the prompt to force the cloud model to use deterministic RAG tools instead.

## The Problem It Solves
Cloud coding agents suffer "context blindness" -- they dump entire files, logs, and error
traces into prompts, causing goal degradation over long context windows. Research calls
this "Context Rot" (performance degrades at ~70% of advertised context window).

## How It Works
```
Agent -> POST /v1/chat/completions -> Context Guardian (localhost:9119)
  1. Count tokens in request
  2. Below threshold? -> passthrough to cloud API unchanged
  3. Above threshold? -> INTERCEPT:
     a. Local LLM extracts user's intent as single sentence
     b. Raw content chunked, classified, embedded, indexed in memory
     c. Prompt rewritten: raw dump -> clean task + tool definitions
     d. Forward to cloud API with tools injected
  4. Cloud calls a tool? -> serve from local index, continue conversation
  5. Stream response back to agent
```

## User Experience
```bash
npm install -g context-guardian
context-guardian start
# In another terminal:
OPENAI_BASE_URL=http://localhost:9119 aider --model gpt-4o
```

## Key Design Decisions
- Pure CLI tool, no web UI, no browser
- Node.js + TypeScript (Hono server, vitest tests)
- Ollama as default local LLM runtime (auto-uses MLX on Mac, CUDA on Linux)
- Default model: qwen3.5:4b (3.4GB, 97.5% tool-calling accuracy in benchmarks)
- OpenAI + Anthropic API compatible (covers ~95% of agents)
- Tools served from in-memory vector store, not persisted between requests
- Graceful degradation: if local LLM or interception fails, passthrough to cloud

## Target Users
Developers using any AI coding agent who want to prevent context overflow and
reduce cloud API costs by forcing structured retrieval instead of raw dumps.
