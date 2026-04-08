import type { LocalLLMAdapter } from './adapter.js';
import { createHash } from 'node:crypto';
import { log } from '../display/logger.js';

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
}

interface OllamaEmbedResponse {
  embeddings: number[][];
}

export class OllamaAdapter implements LocalLLMAdapter {
  name = 'ollama';
  private endpoint: string;
  private model: string;
  private embedModel: string;
  private lastCallAt = 0;
  private intentCache = new Map<string, string>();
  private classifyCache = new Map<string, string>();
  private embedCache = new Map<string, number[]>();

  constructor(endpoint: string, model: string, embedModel: string) {
    this.endpoint = endpoint.replace(/\/$/, '');
    this.model = model;
    this.embedModel = embedModel;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/api/tags`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private getKeepAlive(): string {
    const idleMs = Date.now() - this.lastCallAt;
    if (idleMs > 5 * 60 * 1000) return '30m';
    if (idleMs > 60 * 1000) return '20m';
    return '10m';
  }

  private async postChat(
    messages: Array<{ role: string; content: string }>,
    numPredict: number,
    stop: string[] | undefined,
    timeoutMs: number,
    retries = 1,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      think: false,
      keep_alive: this.getKeepAlive(),
      options: {
        temperature: 0,
        num_predict: numPredict,
        ...(stop ? { stop } : {}),
      },
    };

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(`${this.endpoint}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Ollama chat failed: ${res.status} ${text}`);
        }

        const data = (await res.json()) as { message?: { content?: string } };
        this.lastCallAt = Date.now();
        return stripThinkTags(data.message?.content || '').trim();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < retries) {
          await sleep(120 * (attempt + 1));
        }
      }
    }

    throw lastError || new Error('Ollama chat failed');
  }

  private async generate(prompt: string, system?: string): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    return this.postChat(messages, 512, undefined, 30000, 1);
  }

  async extractIntent(rawContent: string): Promise<string> {
    // Capture both the front and the tail so late user asks are not lost behind dumps
    const truncated = rawContent.length <= 4500
      ? rawContent
      : `${rawContent.slice(0, 2600)}\n...\n${rawContent.slice(-1800)}`;
    const intentKey = stableHash(truncated);
    const cached = this.intentCache.get(intentKey);
    if (cached) return cached;
    const prompt = `Extract the user's PRIMARY OBJECTIVE from this AI coding agent input. ONE sentence only.

INPUT:
${truncated}

OBJECTIVE:`;

    const system = 'Extract the goal in one sentence. No explanation, no thinking, no preamble. /no_think';

    try {
      const result = await this.generateFast(prompt, system);
      // Clean up common artifacts
      const cleaned = result.replace(/^["']|["']$/g, '').replace(/^objective:\s*/i, '').trim() || 'Process the provided information and complete the requested task.';
      setLru(this.intentCache, intentKey, cleaned, 256);
      return cleaned;
    } catch (err) {
      log('error', `Intent extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      return 'Process the provided information and complete the requested task.';
    }
  }

  // Fast generation with aggressive token limits for classification/extraction tasks
  private async generateFast(prompt: string, system?: string): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    return this.postChat(messages, 80, ['\n\n', '\n'], 12000, 1);
  }

  async classifyChunks(chunks: string[]): Promise<Array<{ label: string; chunk: string }>> {
    const valid = ['log', 'code', 'error', 'config', 'documentation', 'stacktrace', 'output', 'data', 'other'];
    const toProcess = chunks.slice(0, 30);

    // First try fast heuristic classification (no LLM call needed)
    const results: Array<{ label: string; chunk: string }> = toProcess.map((chunk) => ({
      label: heuristicClassify(chunk),
      chunk,
    }));

    // Only call LLM for chunks classified as 'other' by heuristic
    const unknowns = results.filter((r) => r.label === 'other');
    if (unknowns.length === 0) return results;

    const BATCH_SIZE = 5;
    for (let i = 0; i < unknowns.length; i += BATCH_SIZE) {
      const batch = unknowns.slice(i, i + BATCH_SIZE);
      const promises = batch.map(async (item) => {
        const cacheKey = stableHash(item.chunk);
        const cached = this.classifyCache.get(cacheKey);
        if (cached) {
          item.label = cached;
          return;
        }
        const preview = item.chunk.slice(0, 1500);
        const prompt = `Classify into ONE category: log, code, error, config, documentation, stacktrace, output, data, other\n\nTEXT:\n${preview}\n\nCATEGORY:`;
        try {
          const label = (await this.generateFast(prompt, 'Respond with ONLY the category label. /no_think')).toLowerCase().replace(/[^a-z]/g, '');
          item.label = valid.includes(label) ? label : 'other';
          setLru(this.classifyCache, cacheKey, item.label, 4000);
        } catch {
          // keep 'other'
        }
      });
      await Promise.all(promises);
    }

    return results;
  }

  async summarize(text: string, maxTokens = 200): Promise<string> {
    const truncated = text.slice(0, 8000);
    const prompt = `Summarize the following text concisely in ${maxTokens} words or less. Focus on key facts, errors, and actionable information.

TEXT:
${truncated}

SUMMARY:`;

    try {
      return await this.generate(prompt);
    } catch {
      return text.slice(0, 500);
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = new Array(texts.length);
    const misses: Array<{ index: number; key: string; text: string }> = [];
    for (let i = 0; i < texts.length; i++) {
      const key = stableHash(texts[i]);
      const cached = this.embedCache.get(key);
      if (cached) {
        out[i] = cached.slice();
      } else {
        misses.push({ index: i, key, text: texts[i] });
      }
    }

    if (misses.length === 0) {
      return out;
    }

    try {
      const res = await fetch(`${this.endpoint}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.embedModel, input: misses.map((m) => m.text), keep_alive: this.getKeepAlive() }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        throw new Error(`Ollama embed failed: ${res.status}`);
      }

      const data = (await res.json()) as OllamaEmbedResponse;
      this.lastCallAt = Date.now();
      const embeddings = data.embeddings || [];
      for (let i = 0; i < misses.length; i++) {
        const m = misses[i];
        const emb = (embeddings[i] || []).slice();
        out[m.index] = emb;
        setLru(this.embedCache, m.key, emb, 6000);
      }
      for (let i = 0; i < out.length; i++) {
        if (!out[i]) out[i] = new Array(384).fill(0);
      }
      return out;
    } catch (err) {
      log('warn', `Embedding failed, using zero vectors: ${err instanceof Error ? err.message : String(err)}`);
      for (const m of misses) {
        out[m.index] = new Array(384).fill(0);
      }
      for (let i = 0; i < out.length; i++) {
        if (!out[i]) out[i] = new Array(384).fill(0);
      }
      return out;
    }
  }
}

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function setLru<T>(map: Map<string, T>, key: string, value: T, maxSize: number) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size <= maxSize) return;
  const first = map.keys().next().value;
  if (first) map.delete(first);
}

function heuristicClassify(text: string): string {
  const lower = text.toLowerCase();
  const lines = text.split('\n').slice(0, 20);

  if (/^\s*(error|err|fatal|panic|exception)/im.test(text)) return 'error';
  if (/^traceback|^\s+at\s+|\.go:\d+|\.ts:\d+|\.py:\d+|\.java:\d+|File ".*", line \d+/im.test(text)) return 'stacktrace';

  const logPatterns = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|^\[(info|warn|error|debug)\]|^(INFO|WARN|ERROR|DEBUG)\s/m;
  if (logPatterns.test(text)) return 'log';

  const codePatterns = /^(import |from |export |const |let |var |function |class |def |fn |pub |async |interface |type )/m;
  if (codePatterns.test(text) || (text.includes('{') && text.includes('}') && text.includes(';'))) return 'code';

  if (/^\s*[\[{]/.test(text.trim()) && /[}\]]\s*$/.test(text.trim())) return 'config';
  if (/^\s*(#+ |---|\*\*|> )/.test(text)) return 'documentation';

  const outputPatterns = /^\$\s|^>\s|^root@|^user@|^\+\+\+|^---/m;
  if (outputPatterns.test(text)) return 'output';

  return 'other';
}
