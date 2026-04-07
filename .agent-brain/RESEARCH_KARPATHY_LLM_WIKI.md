# Research: Karpathy's LLM Wiki (April 2026)

## What It Is
A conceptual pattern document (~2,500 words) published as a GitHub Gist by Andrej Karpathy.
NOT a code repo, library, or tool. It describes a pattern for personal knowledge management
where an LLM incrementally builds and maintains a persistent wiki of markdown files.

- URL: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- Published: ~April 2-4, 2026

## Core Idea
Instead of RAG (re-deriving knowledge from raw docs on every query), the LLM "compiles"
knowledge once into structured, interlinked markdown pages and keeps them current.

## Three-Layer Architecture
1. **Raw Sources** -- immutable source documents (articles, papers, data)
2. **The Wiki** -- LLM-generated markdown files (summaries, entity pages, cross-references)
3. **The Schema** -- config doc (e.g., CLAUDE.md) telling the LLM how to maintain the wiki

## Three Operations
1. **Ingest** -- drop a new source, LLM creates summary page, updates index + related pages
2. **Query** -- ask questions against the wiki; good answers filed as new pages
3. **Lint** -- periodic health-check: contradictions, stale claims, orphan pages

## Key Infrastructure
- `index.md` -- content catalog (replaces vector search at moderate scale ~100 sources)
- `log.md` -- chronological append-only record of operations
- Obsidian as reading/viewing IDE
- `qmd` (https://github.com/tobi/qmd) -- TypeScript CLI with hybrid BM25/vector search + MCP server

## Relevance to Context Guardian: LOW
These solve different problems: LLM Wiki = personal knowledge management (async, batch);
Context Guardian = real-time coding agent prompt compression (millisecond-scale).

## Ideas Worth Stealing
1. **"Compile once, query many"** -- maintain persistent codebase index, don't re-analyze every time
2. **index.md pattern** -- human-readable manifest of what's in the knowledge base
3. **log.md pattern** -- append-only log of what's been processed/cached
4. **Schema layer** -- a CONTEXT_GUARDIAN.md that instructs the local model on compression strategies
5. **Lint operation** -- periodic validation that cached codebase index is still accurate

## Watch: qmd Tool
- https://github.com/tobi/qmd
- TypeScript CLI with hybrid BM25/vector search for markdown files
- Has MCP server mode
- Claims 95%+ token reduction
- Same ecosystem as Context Guardian
- Could serve as search backend component

## Verdict
Learn from the pattern, don't integrate it. Steal the persistent index + log concepts for
Sprint 3+ when we add cross-request persistence. Watch qmd as a potential component.
