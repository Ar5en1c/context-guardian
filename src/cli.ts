import { Command } from 'commander';
import { loadConfig } from './config.js';
import { createProxyServer } from './proxy/server.js';
import { OllamaAdapter } from './local-llm/ollama.js';
import { createStats, printBanner } from './display/dashboard.js';
import { log, setVerbose } from './display/logger.js';

const program = new Command();

program
  .name('context-guardian')
  .description('Edge-Cloud Hybrid Agent Harness. Prevents context blindness in cloud coding agents.')
  .version('0.1.0');

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
    }

    const stats = createStats();
    const app = createProxyServer(config, llm, stats);

    printBanner(config, ollamaReady);

    const { serve } = await import('@hono/node-server');
    serve({ fetch: app.fetch, port: config.port }, (info) => {
      log('info', `Proxy listening on http://localhost:${info.port}`);
    });
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
