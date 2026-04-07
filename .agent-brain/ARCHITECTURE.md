# Architecture

## Directory Structure
```
context-guardian/
  .agent-brain/           # <-- THIS FOLDER: persistent knowledge for AI agents
  src/
    cli.ts                # Commander-based CLI entry point (start, check commands)
    config.ts             # Zod schema + config file loader (guardian.config.json)
    proxy/
      server.ts           # Hono HTTP server, route handlers, tool call loop
      interceptor.ts      # Token counting (gpt-tokenizer), threshold decision logic
      rewriter.ts         # Intent extraction -> chunk -> index -> prompt rewrite
      streaming.ts        # SSE passthrough for streaming responses
      adapters/
        openai.ts         # OpenAI /v1/chat/completions format handler
        anthropic.ts      # Anthropic /v1/messages format handler
    local-llm/
      adapter.ts          # Interface: extractIntent, classifyChunks, summarize, embed
      ollama.ts           # Ollama HTTP client (generate, embed endpoints)
    index/
      chunker.ts          # Recursive text splitter (paragraph > line > sentence > char)
      store.ts            # In-memory vector store: cosine similarity + keyword search
    tools/
      registry.ts         # Tool definition registry + OpenAI format converter
      log-search.ts       # Search indexed logs by query + severity
      file-read.ts        # Read specific file content by path/keyword
      grep.ts             # Regex/literal pattern search across all chunks
      summary.ts          # LLM-generated summaries by topic/category
    display/
      dashboard.ts        # Terminal banner, stats printing
      logger.ts           # Structured stderr logging with chalk colors
  test/                   # Vitest tests (38 passing as of Sprint 1)
  bin/
    context-guardian.js    # #!/usr/bin/env node shim
```

## Data Flow (Interception Path)
```
Request -> interceptor.analyzeRequest() -> decision.shouldIntercept?
  YES -> rewriter.rewriteRequest():
    1. llm.extractIntent(rawContent)     -> goal string
    2. chunker.chunkText(rawContent)     -> Chunk[]
    3. llm.classifyChunks(chunks)        -> labeled Chunk[]
    4. llm.embed(chunks)                 -> embeddings[][]
    5. store.addBatch(chunks, embeddings)
    6. buildSystemPrompt(goal, tools)    -> rewritten system message
    7. buildUserPrompt(goal, preview)    -> rewritten user message
    8. toOpenAIToolFormat(toolDefs)      -> tools array
  -> forward rewritten request to cloud
  -> if cloud calls tools:
     -> getTool(name).handler(args, { store, llm })
     -> append tool results to conversation
     -> forward continuation to cloud
  -> return final response to agent
```

## Key Interfaces
```typescript
interface LocalLLMAdapter {
  extractIntent(rawContent: string): Promise<string>;
  classifyChunks(chunks: string[]): Promise<Array<{ label: string; chunk: string }>>;
  summarize(text: string, maxTokens?: number): Promise<string>;
  embed(texts: string[]): Promise<number[][]>;
}

interface Chunk {
  id: string;
  text: string;
  label: string;  // log | code | error | config | documentation | stacktrace | output | data | other
  startOffset: number;
  endOffset: number;
  metadata: Record<string, string>;
}
```

## Dependencies (minimal)
- hono + @hono/node-server: HTTP server
- gpt-tokenizer: Token counting
- eventsource-parser: SSE stream parsing
- commander: CLI argument parsing
- chalk: Terminal colors
- zod: Config validation
