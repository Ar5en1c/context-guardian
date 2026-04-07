import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const LOG_DIR = resolve(process.cwd(), '.context-guardian');
const LOG_FILE = resolve(LOG_DIR, 'log.md');

let initialized = false;

function ensureLogDir() {
  if (initialized) return;
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
  if (!existsSync(LOG_FILE)) {
    appendFileSync(LOG_FILE, '# Context Guardian Request Log\n\n');
  }
  initialized = true;
}

export function logRequest(
  action: 'intercept' | 'passthrough',
  adapter: 'openai' | 'anthropic',
  inputTokens: number,
  model: string,
  goal?: string,
  outputTokens?: number,
) {
  try {
    ensureLogDir();
    const ts = new Date().toISOString();
    const reduction = outputTokens != null
      ? ` | reduction: ${Math.round((1 - outputTokens / inputTokens) * 100)}% (${inputTokens} -> ${outputTokens})`
      : '';
    const goalStr = goal ? ` | goal: "${goal}"` : '';
    const line = `- \`${ts}\` **${action}** ${adapter}/${model} | ${inputTokens} tokens${reduction}${goalStr}\n`;
    appendFileSync(LOG_FILE, line);
  } catch {
    // never crash the proxy over logging
  }
}
