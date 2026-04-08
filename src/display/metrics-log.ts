import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const LOG_DIR = '.context-guardian';
const METRICS_FILE = 'metrics.jsonl';

export interface MetricsEvent {
  timestamp: string;
  provider: 'openai' | 'anthropic';
  mode: 'passthrough' | 'intercept' | 'context_shape' | 'full_rewrite' | 'error';
  sessionId: string;
  model?: string;
  inputTokens: number;
  outputTokens?: number;
  tokenReduction?: number;
  goal?: string;
  note?: string;
}

export function logMetrics(event: MetricsEvent) {
  try {
    const dir = resolve(process.cwd(), LOG_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = resolve(dir, METRICS_FILE);
    appendFileSync(file, JSON.stringify(event) + '\n');
  } catch {
    // never crash proxy for logging
  }
}
