import { Command } from 'commander';
import { loadConfig } from './config.js';
import { createProxyServer } from './proxy/server.js';
import { OllamaAdapter } from './local-llm/ollama.js';
import { createStats, printBanner } from './display/dashboard.js';
import { log, setVerbose } from './display/logger.js';

async function ensureModelPulled(endpoint: string, model: string) {
  try {
    const res = await fetch(`${endpoint}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
    });
    if (res.ok) return;

    log('info', `Model ${model} not found locally. Pulling...`);
    const pullRes = await fetch(`${endpoint}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: false }),
    });
    if (pullRes.ok) {
      log('info', `Model ${model} pulled successfully.`);
    } else {
      log('warn', `Failed to pull ${model}: ${pullRes.status}. Run manually: ollama pull ${model}`);
    }
  } catch {
    log('warn', `Could not check/pull model ${model}. Run manually: ollama pull ${model}`);
  }
}

const program = new Command();

program
  .name('context-guardian')
  .description('Edge-Cloud Hybrid Agent Harness. Prevents context blindness in cloud coding agents.')
  .version('0.3.0');

program
  .command('start')
  .description('Start the Context Guardian proxy')
  .option('-p, --port <number>', 'Proxy port', '9119')
  .option('-t, --threshold <number>', 'Token threshold for interception', '8000')
  .option('-m, --model <string>', 'Local LLM model name', 'qwen3.5:4b')
  .option('-e, --endpoint <string>', 'Ollama endpoint', 'http://localhost:11434')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .option('--budget <number>', 'Max tokens in rewritten requests', '4000')
  .action(async (opts) => {
    const config = loadConfig({
      port: Number(opts.port),
      threshold_tokens: Number(opts.threshold),
      context_budget: Number(opts.budget),
      verbose: opts.verbose,
      local_llm: {
        backend: 'ollama',
        model: opts.model,
        endpoint: opts.endpoint,
        embed_model: 'nomic-embed-text',
      },
    });

    setVerbose(config.verbose);

    const llm = new OllamaAdapter(
      config.local_llm.endpoint,
      config.local_llm.model,
      config.local_llm.embed_model,
    );

    const ollamaReady = await llm.isAvailable();
    if (!ollamaReady) {
      log('warn', `Ollama not detected at ${config.local_llm.endpoint}. Interception will use fallback behavior.`);
      log('warn', 'Start Ollama and run: ollama pull ' + config.local_llm.model);
    } else {
      await ensureModelPulled(config.local_llm.endpoint, config.local_llm.model);
      await ensureModelPulled(config.local_llm.endpoint, config.local_llm.embed_model);
    }

    const { SessionStore } = await import('./index/session-store.js');
    const sessionStore = new SessionStore();
    await sessionStore.ensureReady();
    sessionStore.pruneOldSessions(7);
    log('info', `Session: ${sessionStore.currentSessionId}`);

    const stats = createStats();
    const app = createProxyServer(config, llm, stats, sessionStore);

    printBanner(config, ollamaReady);

    const { serve } = await import('@hono/node-server');
    serve({ fetch: app.fetch, port: config.port }, (info) => {
      log('info', `Proxy listening on http://localhost:${info.port}`);
    });
  });

program
  .command('eval')
  .description('A/B evaluation: run same prompt with and without interception, compare results')
  .requiredOption('--prompt <text>', 'The prompt to test')
  .option('--model <string>', 'Cloud model to test against', 'gpt-4o-mini')
  .option('--threshold <number>', 'Token threshold', '100')
  .option('-m, --local-model <string>', 'Local LLM model', 'qwen3.5:4b')
  .option('-e, --endpoint <string>', 'Ollama endpoint', 'http://localhost:11434')
  .action(async (opts) => {
    const { OllamaAdapter } = await import('./local-llm/ollama.js');
    const { analyzeRequest, extractRawContent, countTokens } = await import('./proxy/interceptor.js');
    const { rewriteRequest } = await import('./proxy/rewriter.js');
    const { VectorStore } = await import('./index/store.js');
    const { loadConfig } = await import('./config.js');

    await import('./tools/log-search.js');
    await import('./tools/file-read.js');
    await import('./tools/grep.js');
    await import('./tools/summary.js');
    await import('./tools/repo-map.js');
    await import('./tools/file-tree.js');
    await import('./tools/symbol-find.js');
    await import('./tools/git-diff.js');
    await import('./tools/test-failures.js');
    await import('./tools/run-checks.js');

    const config = loadConfig({ threshold_tokens: Number(opts.threshold) });
    const llm = new OllamaAdapter(opts.endpoint, opts.localModel, 'nomic-embed-text');
    const store = new VectorStore();

    const prompt = opts.prompt;
    const tokenCount = countTokens(prompt);
    process.stderr.write(`\nPrompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}\n`);
    process.stderr.write(`Tokens: ${tokenCount}\n\n`);

    // Without proxy (raw)
    process.stderr.write('--- WITHOUT PROXY (raw) ---\n');
    process.stderr.write(`Would send ${tokenCount} tokens directly to ${opts.model}\n\n`);

    // With proxy (intercepted)
    process.stderr.write('--- WITH PROXY (intercepted) ---\n');
    const messages = [{ role: 'user', content: prompt }];
    const rawContent = extractRawContent(messages);
    const decision = analyzeRequest(messages, config.threshold_tokens, config.intercept_policy);

    if (!decision.shouldIntercept) {
      process.stderr.write(`Would passthrough unchanged (semantic score ${decision.signals.semanticScore}).\n`);
      return;
    }

    process.stderr.write(`Route mode: ${decision.mode} (${decision.reasons.join(', ') || 'threshold'})\n`);

    const rewrite = await rewriteRequest(rawContent, messages, llm, store, config.tools, config.context_budget, {
      routeMode: decision.mode,
      decisionReasons: decision.reasons,
    });

    process.stderr.write(`\nGoal extracted: "${rewrite.goal}"\n`);
    process.stderr.write(`Task profile: intent=${rewrite.taskProfile.intentType} scope=${rewrite.taskProfile.scopeClass} files=${rewrite.taskProfile.estimatedFiles.min}-${rewrite.taskProfile.estimatedFiles.max} tools=${rewrite.taskProfile.estimatedToolCalls.min}-${rewrite.taskProfile.estimatedToolCalls.max} corpus=${rewrite.taskProfile.corpusStatus}${rewrite.taskProfile.bootstrapNeeded ? ' bootstrap=yes' : ''}\n`);
    process.stderr.write(`Deterministic bootstrap: ${rewrite.bootstrap.ran ? `yes (${rewrite.bootstrap.toolNames.join(', ')})` : 'no'}\n`);
    process.stderr.write(`Rewrite ROI: ${rewrite.roi.shouldRewrite ? 'use rewrite' : 'prefer passthrough'} (${rewrite.roi.reason})\n`);
    process.stderr.write(`Chunks indexed: ${rewrite.chunksIndexed}\n`);
    process.stderr.write(`Token reduction: ${rewrite.inputTokens} -> ${rewrite.outputTokens} (${Math.round((1 - rewrite.outputTokens / rewrite.inputTokens) * 100)}%)\n`);
    process.stderr.write(`Tools injected: ${rewrite.toolNames.join(', ')}\n`);
    process.stderr.write(`Timing: intent=${rewrite.timingMs.intent.toFixed(0)}ms classify=${rewrite.timingMs.classification.toFixed(0)}ms embed=${rewrite.timingMs.embedding.toFixed(0)}ms total=${rewrite.timingMs.total.toFixed(0)}ms\n`);
    process.stderr.write(`\n--- REWRITTEN SYSTEM PROMPT ---\n${rewrite.messages[0].content}\n`);
    process.stderr.write(`\n--- REWRITTEN USER PROMPT ---\n${rewrite.messages[1].content}\n`);
  });

program
  .command('dry-run')
  .description('Show what would be rewritten for a given input file, without forwarding to cloud')
  .requiredOption('--file <path>', 'Path to a file containing the raw content to analyze')
  .option('-m, --model <string>', 'Local LLM model', 'qwen3.5:4b')
  .option('-e, --endpoint <string>', 'Ollama endpoint', 'http://localhost:11434')
  .option('-t, --threshold <number>', 'Token threshold', '100')
  .action(async (opts) => {
    const { readFileSync } = await import('node:fs');
    const { OllamaAdapter } = await import('./local-llm/ollama.js');
    const { countTokens } = await import('./proxy/interceptor.js');
    const { rewriteRequest } = await import('./proxy/rewriter.js');
    const { VectorStore } = await import('./index/store.js');
    const { loadConfig } = await import('./config.js');

    await import('./tools/log-search.js');
    await import('./tools/file-read.js');
    await import('./tools/grep.js');
    await import('./tools/summary.js');
    await import('./tools/repo-map.js');
    await import('./tools/file-tree.js');
    await import('./tools/symbol-find.js');
    await import('./tools/git-diff.js');
    await import('./tools/test-failures.js');
    await import('./tools/run-checks.js');

    const config = loadConfig({ threshold_tokens: Number(opts.threshold) });
    const llm = new OllamaAdapter(opts.endpoint, opts.model, 'nomic-embed-text');
    const store = new VectorStore();

    let content: string;
    try {
      content = readFileSync(opts.file, 'utf-8');
    } catch (err) {
      process.stderr.write(`Cannot read file: ${opts.file}\n`);
      process.exit(1);
    }

    const tokenCount = countTokens(content);
    process.stderr.write(`File: ${opts.file} (${tokenCount} tokens)\n\n`);

    const messages = [{ role: 'user' as const, content }];
    const rewrite = await rewriteRequest(content, messages, llm, store, config.tools, config.context_budget);

    process.stderr.write(`Goal: "${rewrite.goal}"\n`);
    process.stderr.write(`Task profile: intent=${rewrite.taskProfile.intentType} scope=${rewrite.taskProfile.scopeClass} files=${rewrite.taskProfile.estimatedFiles.min}-${rewrite.taskProfile.estimatedFiles.max} tools=${rewrite.taskProfile.estimatedToolCalls.min}-${rewrite.taskProfile.estimatedToolCalls.max} corpus=${rewrite.taskProfile.corpusStatus}${rewrite.taskProfile.bootstrapNeeded ? ' bootstrap=yes' : ''}\n`);
    process.stderr.write(`Deterministic bootstrap: ${rewrite.bootstrap.ran ? `yes (${rewrite.bootstrap.toolNames.join(', ')})` : 'no'}\n`);
    process.stderr.write(`Rewrite ROI: ${rewrite.roi.shouldRewrite ? 'use rewrite' : 'prefer passthrough'} (${rewrite.roi.reason})\n`);
    process.stderr.write(`Chunks: ${rewrite.chunksIndexed}\n`);
    process.stderr.write(`Reduction: ${rewrite.inputTokens} -> ${rewrite.outputTokens} tokens (${Math.round((1 - rewrite.outputTokens / rewrite.inputTokens) * 100)}%)\n`);
    process.stderr.write(`Timing: ${rewrite.timingMs.total.toFixed(0)}ms total\n\n`);

    process.stdout.write(JSON.stringify({ goal: rewrite.goal, taskProfile: rewrite.taskProfile, bootstrap: rewrite.bootstrap, roi: rewrite.roi, messages: rewrite.messages, tools: rewrite.toolNames, timing: rewrite.timingMs }, null, 2));
    process.stdout.write('\n');
  });

program
  .command('init')
  .description('Generate a guardian.config.json in the current directory')
  .action(async () => {
    const { writeFileSync, existsSync } = await import('node:fs');
    const path = 'guardian.config.json';
    if (existsSync(path)) {
      process.stderr.write(`${path} already exists. Delete it first to regenerate.\n`);
      process.exit(1);
    }
    const defaultConfig = {
      port: 9119,
      threshold_tokens: 8000,
      context_budget: 4000,
      intercept_policy: {
        signal_score_threshold: 3,
        min_context_shape_tokens: 600,
        min_context_shape_lines: 60,
        large_message_tokens: 1400,
        total_line_trigger: 80,
        log_line_trigger: 60,
        stacktrace_line_trigger: 10,
        error_line_trigger: 8,
        code_line_trigger: 140,
        path_hint_trigger: 6,
      },
      local_llm: {
        backend: 'ollama',
        model: 'qwen3.5:4b',
        endpoint: 'http://localhost:11434',
        embed_model: 'nomic-embed-text',
      },
      cloud: {
        openai_base: 'https://api.openai.com/v1',
        anthropic_base: 'https://api.anthropic.com',
      },
      tools: ['log_search', 'file_read', 'grep', 'summary', 'repo_map', 'file_tree', 'symbol_find', 'git_diff', 'test_failures', 'run_checks'],
      tool_policy: {
        allow_execution: true,
        allowed_execute_tools: ['run_checks', 'test_failures'],
      },
      verbose: false,
    };
    writeFileSync(path, JSON.stringify(defaultConfig, null, 2) + '\n');
    process.stderr.write(`Created ${path}\n`);
  });

program
  .command('mcp')
  .description('Start as an MCP (Model Context Protocol) server, exposing RAG tools')
  .option('-p, --port <number>', 'MCP server port', '9120')
  .option('-m, --model <string>', 'Local LLM model name', 'qwen3.5:4b')
  .option('-e, --endpoint <string>', 'Ollama endpoint', 'http://localhost:11434')
  .action(async (opts) => {
    const { createMCPServer } = await import('./mcp/server.js');
    const { OllamaAdapter } = await import('./local-llm/ollama.js');

    const llm = new OllamaAdapter(opts.endpoint, opts.model, 'nomic-embed-text');
    const { app } = createMCPServer(llm);

    const { serve } = await import('@hono/node-server');
    const port = Number(opts.port);
    serve({ fetch: app.fetch, port }, () => {
      log('info', `MCP server listening on http://localhost:${port}/mcp`);
      log('info', `Add to your MCP client: { "url": "http://localhost:${port}/mcp" }`);
    });
  });

program
  .command('sessions')
  .description('List recent proxy sessions with chunk counts')
  .option('-l, --limit <number>', 'Number of sessions to show', '20')
  .action(async (opts) => {
    const { SessionStore } = await import('./index/session-store.js');
    const store = new SessionStore();
    await store.ensureReady();
    const sessions = store.listSessions(Number(opts.limit));
    store.close();

    if (sessions.length === 0) {
      process.stderr.write('No sessions found. Start the proxy to create sessions.\n');
      return;
    }

    process.stderr.write(`\n  Recent sessions (${sessions.length}):\n\n`);
    for (const s of sessions) {
      const goal = s.goal ? ` -- ${s.goal.slice(0, 60)}` : '';
      process.stderr.write(`  ${s.id}  chunks:${s.chunkCount}  reqs:${s.requestCount}  ${s.lastActive}${goal}\n`);
    }
    process.stderr.write('\n');
  });

program
  .command('compact')
  .description('Manually compact a session into core memory state')
  .option('-s, --session <id>', 'Session ID to compact (defaults to most recent)')
  .option('-m, --model <string>', 'Local LLM model name', 'qwen3.5:4b')
  .option('-e, --endpoint <string>', 'Ollama endpoint', 'http://localhost:11434')
  .action(async (opts) => {
    const { SessionStore } = await import('./index/session-store.js');
    const { manualCompact } = await import('./proxy/compaction.js');
    const { OllamaAdapter } = await import('./local-llm/ollama.js');

    const bootstrap = new SessionStore();
    await bootstrap.ensureReady();
    const recent = bootstrap.listSessions(1);
    const targetSessionId = opts.session || recent[0]?.id;
    bootstrap.close();

    if (!targetSessionId) {
      process.stderr.write('No sessions found. Start the proxy first to collect session data.\n');
      process.exit(1);
    }

    const store = new SessionStore(targetSessionId);
    await store.ensureReady();

    const llm = new OllamaAdapter(opts.endpoint, opts.model, 'nomic-embed-text');
    const recentChunks = store.getRecentChunks(200).map((c) => `[chunk:${c.label}] ${c.text.slice(0, 600)}`);
    const hotToolResults = store.getHotToolResults(20).map((r) => `[tool:${r.toolName}] query="${r.query}" ${r.result.slice(0, 600)}`);
    const sourceText = [...recentChunks, ...hotToolResults].join('\n---\n');

    const result = await manualCompact(store, llm, sourceText, targetSessionId);
    if (!result.compacted) {
      process.stderr.write(`Compaction skipped: ${result.summaryMessage || 'insufficient session data'}\n`);
      store.close();
      return;
    }

    process.stderr.write(`Compacted session: ${targetSessionId}\n\n`);
    process.stderr.write(`${store.formatCoreMemoryBlock(targetSessionId)}\n\n`);
    store.close();
  });

program
  .command('check')
  .description('Check if Ollama and required models are available')
  .option('-e, --endpoint <string>', 'Ollama endpoint', 'http://localhost:11434')
  .option('-m, --model <string>', 'Model to check', 'qwen3.5:4b')
  .action(async (opts) => {
    const llm = new OllamaAdapter(opts.endpoint, opts.model, 'nomic-embed-text');

    process.stderr.write('Checking Ollama availability...\n');
    const available = await llm.isAvailable();

    if (!available) {
      process.stderr.write(`  Ollama: NOT FOUND at ${opts.endpoint}\n`);
      process.stderr.write('  Install: https://ollama.ai\n');
      process.exit(1);
    }

    process.stderr.write(`  Ollama: OK at ${opts.endpoint}\n`);

    process.stderr.write(`  Testing model: ${opts.model}...\n`);
    try {
      const result = await llm.extractIntent('Fix the login bug in auth.ts');
      process.stderr.write(`  Model: OK (response: "${result.slice(0, 80)}...")\n`);
    } catch (err) {
      process.stderr.write(`  Model: FAILED - ${err instanceof Error ? err.message : String(err)}\n`);
      process.stderr.write(`  Run: ollama pull ${opts.model}\n`);
      process.exit(1);
    }

    process.stderr.write(`  Testing embeddings: nomic-embed-text...\n`);
    try {
      const embeddings = await llm.embed(['test']);
      process.stderr.write(`  Embeddings: OK (dim=${embeddings[0]?.length || 0})\n`);
    } catch (err) {
      process.stderr.write(`  Embeddings: FAILED - run: ollama pull nomic-embed-text\n`);
    }

    process.stderr.write('\nAll checks passed. Ready to start.\n');
  });

program.parse();
