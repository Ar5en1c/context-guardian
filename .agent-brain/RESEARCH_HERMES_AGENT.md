# Research: Hermes Agent by NousResearch (April 2026)

## What It Is
A self-improving, persistent AI agent framework written in Python, MIT licensed.
NOT a competitor to Context Guardian -- they solve different problems at different layers.

- GitHub: https://github.com/NousResearch/hermes-agent
- Docs: https://hermes-agent.nousresearch.com/docs/
- Released: February 2026, rapidly growing

## Architecture
- Standalone autonomous agent (CLI, Telegram, Discord, Slack, etc.)
- 47+ built-in tools, MCP support, programmatic tool calling
- Works with 200+ models (Nous Portal, OpenRouter, OpenAI, Anthropic, Ollama)
- 6 terminal backends: local, Docker, SSH, Daytona, Singularity, Modal
- Skills system: agent creates reusable procedures from experience, self-improves them

## 5-Layer Memory System
1. **Persistent Memory**: MEMORY.md + USER.md files on disk, updated after every session
2. **Session Memory**: FTS5 (SQLite full-text search) index of all past sessions
3. **Procedural Skills**: Markdown files in ~/.hermes/skills/ encoding learned procedures
4. **User Model (Honcho)**: Dialectic user modeling -- builds theory of mind about user
5. **Short-term**: Standard LLM context window for current conversation

## Related Projects
- **Hermes 3 models**: 8B, 70B, 405B (Llama 3.1 fine-tunes). Specifically trained for
  tool calling, structured output, agentic behavior. Available on Ollama.
- **Hermes-Function-Calling toolkit**: https://github.com/NousResearch/Hermes-Function-Calling
  Uses `<tool_call>` tag prompt format. Battle-tested for function calling.
- **hermes-function-calling-v1 dataset**: HuggingFace training data for fine-tuning

## Comparison with Context Guardian

| Dimension | Hermes Agent | Context Guardian |
|-----------|-------------|-----------------|
| Category | Standalone agent | Transparent proxy middleware |
| Problem | AI amnesia (forgetting between sessions) | Context blindness (choking on massive dumps) |
| Architecture | Self-contained full agent | Invisible middleware between agents and cloud |
| User interaction | Direct | Invisible -- user talks to their own agent |
| Language | Python | TypeScript |
| Memory | 5-layer persistent | Ephemeral in-memory per request |
| Relationship | IS the agent | Sits BETWEEN agent and cloud |

## Verdict: COMPLEMENT, DON'T COMPETE
A user could run Hermes Agent -> through Context Guardian -> to cloud.
They stack, they don't compete.

## Integration Opportunities (Priority Order)
1. **HIGH: Benchmark Hermes 3 8B as local model** -- specifically fine-tuned for tool calling.
   Just `ollama pull hermes3:8b` and swap in config. May outperform Qwen3.5 4B on tool tasks
   but costs more RAM (~5.5GB vs 3.4GB).
2. **HIGH: Steal FTS5 session persistence** -- SQLite FTS5 for past interaction indexing.
   Low overhead, makes Context Guardian remember across sessions.
3. **MEDIUM: Adopt Hermes function-calling prompt format** -- `<tool_call>` tags are
   battle-tested. Could improve cloud model's tool-calling reliability.
4. **MEDIUM: Skills caching concept** -- cache successful compression strategies,
   reuse when similar context dumps arrive.
5. **LOW: MCP server mode** -- expose Context Guardian as MCP tool for agent frameworks.
