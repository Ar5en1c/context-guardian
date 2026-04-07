import type { LocalLLMAdapter } from './adapter.js';
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

  private async generate(prompt: string, system?: string): Promise<string> {
    // Use /api/chat instead of /api/generate -- the generate API ignores think=false for qwen3.5
    const messages: Array<{ role: string; content: string }> = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      think: false,
      options: { temperature: 0, num_predict: 512 },
    };

    const res = await fetch(`${this.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama chat failed: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { message?: { content?: string } };
    const content = data.message?.content || '';
    return stripThinkTags(content).trim();
  }

  async extractIntent(rawContent: string): Promise<string> {
    const truncated = rawContent.slice(0, 12000);
    const prompt = `Analyze the following input that was sent to an AI coding agent. Extract the user's PRIMARY OBJECTIVE in a single, actionable sentence. Ignore all raw data dumps (logs, file contents, stack traces) and focus only on what the user is actually asking to be done.

INPUT:
${truncated}

Respond with ONLY the extracted goal, nothing else. Example format:
"Fix the authentication timeout error in the /api/login endpoint"`;

    const system = 'You are a precise intent extraction system. Output only the goal sentence, no explanation. /no_think';

    try {
      return await this.generate(prompt, system);
    } catch (err) {
      log('error', `Intent extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      return 'Process the provided information and complete the requested task.';
    }
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
        const preview = item.chunk.slice(0, 1500);
        const prompt = `/no_think\nClassify this text into exactly ONE category. Respond with ONLY the label.\nCategories: log, code, error, config, documentation, stacktrace, output, data, other\n\nTEXT:\n${preview}\n\nCATEGORY:`;
        try {
          const label = (await this.generate(prompt)).toLowerCase().replace(/[^a-z]/g, '');
          item.label = valid.includes(label) ? label : 'other';
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
    try {
      const res = await fetch(`${this.endpoint}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.embedModel, input: texts }),
      });

      if (!res.ok) {
        throw new Error(`Ollama embed failed: ${res.status}`);
      }

      const data = (await res.json()) as OllamaEmbedResponse;
      return data.embeddings;
    } catch (err) {
      log('warn', `Embedding failed, using zero vectors: ${err instanceof Error ? err.message : String(err)}`);
      return texts.map(() => new Array(384).fill(0));
    }
  }
}

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
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
