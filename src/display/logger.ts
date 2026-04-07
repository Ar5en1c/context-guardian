import chalk from 'chalk';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug' | 'intercept' | 'passthrough' | 'compact';

let verbose = false;

export function setVerbose(v: boolean) {
  verbose = v;
}

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

export function log(level: LogLevel, msg: string, meta?: Record<string, unknown>) {
  if (level === 'debug' && !verbose) return;

  const prefix: Record<LogLevel, string> = {
    info: chalk.blue('[info]'),
    warn: chalk.yellow('[warn]'),
    error: chalk.red('[error]'),
    debug: chalk.gray('[debug]'),
    intercept: chalk.magenta('[intercept]'),
    passthrough: chalk.green('[pass]'),
    compact: chalk.cyan('[compact]'),
  };

  const line = `${chalk.dim(ts())} ${prefix[level]} ${msg}`;
  process.stderr.write(line + '\n');

  if (meta && verbose) {
    for (const [k, v] of Object.entries(meta)) {
      process.stderr.write(`  ${chalk.dim(k + ':')} ${JSON.stringify(v)}\n`);
    }
  }
}
