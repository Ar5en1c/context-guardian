import chalk from 'chalk';
import type { Config } from '../config.js';

export interface Stats {
  intercepted: number;
  passedThrough: number;
  tokensSaved: number;
  lastIntercept: {
    inTokens: number;
    outTokens: number;
    goal: string;
    toolsInjected: string[];
  } | null;
}

export function createStats(): Stats {
  return {
    intercepted: 0,
    passedThrough: 0,
    tokensSaved: 0,
    lastIntercept: null,
  };
}

export function printBanner(config: Config, ollamaReady: boolean) {
  const lines = [
    '',
    chalk.bold.cyan('  Context Guardian') + chalk.dim(` v0.3.0`),
    '',
    `  ${chalk.dim('Local LLM:')}  ${ollamaReady ? chalk.green('ollama') : chalk.yellow('not detected')} / ${config.local_llm.model}`,
    `  ${chalk.dim('Proxy:')}     ${chalk.white(`http://localhost:${config.port}`)}`,
    `  ${chalk.dim('Threshold:')} ${config.threshold_tokens} tokens`,
    `  ${chalk.dim('Budget:')}    ${config.context_budget} tokens per rewritten request`,
    '',
    chalk.dim('  Usage: set OPENAI_BASE_URL=http://localhost:' + config.port + ' in your agent'),
    '',
    chalk.dim('  Waiting for requests...'),
    '',
  ];
  process.stderr.write(lines.join('\n'));
}

export function printStats(stats: Stats) {
  const lines = [
    '',
    chalk.dim('─'.repeat(56)),
    `  ${chalk.bold('Intercepted:')} ${stats.intercepted}  ${chalk.bold('Passed:')} ${stats.passedThrough}  ${chalk.bold('Tokens saved:')} ${stats.tokensSaved.toLocaleString()}`,
  ];

  if (stats.lastIntercept) {
    const li = stats.lastIntercept;
    lines.push('');
    lines.push(`  ${chalk.dim('Last intercept:')}`);
    lines.push(`    ${chalk.dim('IN:')}  ${li.inTokens.toLocaleString()} tokens`);
    lines.push(`    ${chalk.dim('OUT:')} ${li.outTokens.toLocaleString()} tokens`);
    lines.push(`    ${chalk.dim('Goal:')} ${li.goal}`);
    lines.push(`    ${chalk.dim('Tools:')} ${li.toolsInjected.join(', ')}`);
  }

  lines.push(chalk.dim('─'.repeat(56)));
  lines.push('');
  process.stderr.write(lines.join('\n'));
}
