# Open Source Research: What to Reuse, What to Avoid

## Sources Analyzed
1. Claude Code leaked architecture (512K lines, reverse-engineered compaction system)
2. Aider repository mapping (tree-sitter, PageRank symbol graph)
3. OpenCode (Go/TypeScript, session persistence, subagent delegation)
4. MemGPT/Letta (tiered memory as OS, self-editing context)
5. Karpathy LLM Knowledge Base (compile-once markdown library)
6. Anthropic Cookbook (context engineering: compaction, tool clearing, memory)

---

## 1. Claude Code Compaction System (CRITICAL -- must adopt)

**What they do (from DecodeClaude reverse engineering):**

Three-layer compaction:
- **Microcompaction**: Bulky tool outputs saved to disk, only a "hot tail" of recent results stays in context. Older results become references: "stored on disk, retrievable by path."
- **Auto-compaction**: Headroom accounting. Reserve space for output + compaction itself. When free space < reserved, trigger compaction.
- **Manual compaction**: `/compact` at task boundaries with optional focus hint.

**Compaction contract (the summary MUST contain):**
- User intent (what was asked, what changed)
- Key technical decisions and concepts
- Files touched and why
- Errors encountered and how fixed
- Pending tasks and exact current state
- Next step matching most recent user intent

**Post-compaction rehydration:**
1. Boundary marker
2. Summary message (compressed working state)
3. Re-read 5 most recently accessed files
4. Restore todo list
5. Continuation message: "Continue from where we left off"

**What we should steal (MIT-safe concepts, not code):**
- The 3-tier approach (micro/auto/manual) is an architecture pattern, not copyrightable
- The compaction contract checklist -- we need our local LLM to produce this exact structure
- The hot-tail / cold-storage split for tool results
- Headroom accounting (don't compact tiny sessions, reserve output space)
- The continuation message pattern

**What we do differently:**
- Our local LLM does the compaction, not the cloud model
- We store compacted state in SQLite, not in the message history
- We can be more aggressive because we have the full index in vector store

---

## 2. Aider Repository Mapping (ADOPT the concept)

**What they do:**
- Tree-sitter parses source files for all language types
- Extracts definitions (classes, functions, methods) and references
- Builds a directed graph: file A references symbol from file B
- Uses PageRank to rank most "important" files in the codebase
- Sends a condensed "repo map" as context: file paths + key symbols + relationships
- Fits 1000+ file repos into ~2K tokens of structured context

**License:** Apache-2.0 (fully open, can study and reimplement)

**What we should adopt:**
- The concept of a "repo map" -- a condensed structural overview, NOT full file contents
- Tree-sitter for language-aware parsing (npm: `tree-sitter`, `web-tree-sitter`)
- PageRank-style relevance: files that are referenced by many other files are more important
- Send the map as persistent context so the cloud model knows what exists without seeing it

**What we do differently:**
- Our local LLM builds the map, not the CLI
- We cache the map in SQLite and only re-parse changed files
- We use embeddings to find relevant parts of the map for the current task

---

## 3. MemGPT/Letta Tiered Memory (ADOPT the architecture)

**What they do:**
- Treat LLM as an OS: context window = RAM, files = disk
- Three tiers: core memory (always in context), recall memory (searchable), archival memory (long-term)
- The LLM itself decides what to move between tiers via tool calls
- Self-editing: LLM can modify its own core memory blocks

**License:** Apache-2.0 (Letta)

**What we should adopt:**
- The tiered approach: hot (in-context) / warm (in SQLite, searchable) / cold (on disk, archived)
- The idea that the LOCAL LLM manages its own memory -- it decides what's important enough to keep
- Session-level core memory: a 500-token block that's always included (current goal, files touched, decisions made)
- Archival search: the local LLM can query past sessions when it recognizes a recurring pattern

**What we do differently:**
- MemGPT uses the cloud model to manage memory. We use the LOCAL model.
- MemGPT's self-editing is powerful but risky. We use structured blocks that the local LLM fills in.
- We don't need the full OS metaphor -- we need just enough to track progress across requests.

---

## 4. Karpathy's Knowledge Base (ADOPT the pattern)

**What he does:**
- "Compile-once, query many" -- raw information is processed into markdown documents once
- Each document is an authoritative, structured summary of a topic
- The LLM acts as a "research librarian" maintaining the library
- No RAG retrieval step -- the compiled docs ARE the context
- qmd tool: raw input -> structured markdown -> file

**What we should adopt:**
- The "compile-once" idea for session memory. When the local LLM processes logs/code/errors, it should produce a structured summary document that persists.
- The structured markdown format: `## Goal`, `## Files`, `## Decisions`, `## Errors`, `## Next`
- The idea of the local LLM as librarian, not just classifier

**What we do differently:**
- Karpathy's is manual (he runs qmd). Ours is automatic on every interception.
- His is topic-based. Ours is session-based (one "compiled" doc per session).

---

## 5. OpenCode Session Persistence (REFERENCE implementation)

**What they do (from PR #1842, #7756):**
- Sessions persist agent state (which agent, which model, conversation history)
- Subagent-to-subagent delegation with budgets
- Hierarchical session navigation
- `opencode-mem` plugin: SQLite + vector search for persistent memory

**License:** MIT (OpenCode), MIT (opencode-mem)

**What we should note:**
- They solved session persistence in Go/TypeScript -- validates our SQLite approach
- Their subagent delegation with budgets is relevant for our multi-round tool loops
- The `opencode-mem` plugin (SQLite + vectors) is exactly what our SessionStore already does

---

## 6. Anthropic Cookbook: Context Engineering (OFFICIAL best practices)

**Three strategies (published, free to use):**
1. **Compaction**: Summarize conversation, replace messages with summary
2. **Tool clearing**: Replace old tool results with placeholders after they've been used
3. **Memory**: Persist key facts to external storage, inject on demand

**Key insight from Anthropic:**
> "Compaction works best when you have a clear contract for what the summary must contain."

---

## Summary: What We Build Next

### Architecture to implement (inspired by all sources, original implementation):

```
REQUEST COMES IN
    |
    v
SESSION JOURNAL (new, inspired by Claude Code + Karpathy)
    |-- Read previous session state from SQLite
    |-- "Core memory" block (always in context): goal, files, decisions, errors, next step
    |-- Feed core memory to local LLM alongside new request
    |
    v
INTERCEPTION + REWRITE (existing, enhanced)
    |-- Local LLM now has session context (knows what was tried before)
    |-- Classifies new data against EXISTING index (don't re-index known content)
    |-- Produces entity hints: "grep for 'ETIMEDOUT'", "read jwt-validator.ts"
    |
    v
COMPACTION CHECK (new, inspired by Claude Code)
    |-- Count tokens in hot context + tool results
    |-- If > 80% of budget: compact
    |-- Compaction = local LLM summarizes into structured working state
    |-- Hot tail: keep last 3 tool results inline
    |-- Cold storage: older results in SQLite, referenced by ID
    |
    v
FORWARD TO CLOUD (existing)
    |-- Rewritten prompt includes: core memory + task + tools + entity hints
    |-- Cloud model gets precise context, not raw dumps
    |
    v
POST-RESPONSE UPDATE (new, inspired by MemGPT)
    |-- Local LLM updates session journal: what was done, what changed, next step
    |-- Persist to SQLite for next request
```

### Traps to avoid (learned from research):
1. **Don't summarize everything** -- Claude Code only compacts when necessary. Small sessions should NOT be compacted.
2. **Don't let the cloud model manage memory** -- That burns tokens. The local LLM does it.
3. **Don't build a full repo map upfront** -- Aider's tree-sitter parse is expensive. Do it lazily per-file when referenced.
4. **Don't use FTS5 for semantic search** -- Our embeddings + cosine similarity is better. FTS is a fallback.
5. **Don't over-classify** -- Heuristic classification covers 80%+ of cases. LLM classification is slow and often wrong on edge cases.
6. **Don't try to be MemGPT** -- Full self-editing memory is overkill. Structured blocks that the local LLM fills in are enough.
