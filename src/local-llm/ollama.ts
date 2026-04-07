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
    const body: Record<string, unknown> = {
      model: this.model,
      prompt,
      stream: false,
      options: { temperature: 0, num_predict: 512 },
    };
    if (system) body.system = system;

    const res = await fetch(`${this.endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama generate failed: ${res.status} ${text}`);
    }

    const data = (await res.json()) as OllamaGenerateResponse;
    return data.response.trim();
  }

  async extractIntent(rawContent: string): Promise<string> {
    const truncated = rawContent.slice(0, 12000);
    const prompt = `Analyze the following input that was sent to an AI coding agent. Extract the user's PRIMARY OBJECTIVE in a single, actionable sentence. Ignore all raw data dumps (logs, file contents, stack traces) and focus only on what the user is actually asking to be done.

INPUT:
${truncated}

Respond with ONLY the extracted goal, nothing else. Example format:
"Fix the authentication timeout error in the /api/login endpoint"`;

    const system = 'You are a precise intent extraction system. Output only the goal sentence, no explanation.';

    try {
      return await this.generate(prompt, system);
    } catch (err) {
      log('error', `Intent extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      return 'Process the provided information and complete the requested task.';
    }
  }

  async classifyChunks(chunks: string[]): Promise<Array<{ label: string; chunk: string }>> {
    const results: Array<{ label: string; chunk: string }> = [];

    for (const chunk of chunks.slice(0, 20)) {
      const preview = chunk.slice(0, 2000);
      const prompt = `Classify this text chunk into exactly ONE category. Respond with ONLY the category label.

Categories: log, code, error, config, documentation, stacktrace, output, data, other

TEXT:
${preview}

CATEGORY:`;

      try {
        const label = (await this.generate(prompt)).toLowerCase().replace(/[^a-z]/g, '');
        const valid = ['log', 'code', 'error', 'config', 'documentation', 'stacktrace', 'output', 'data', 'other'];
        results.push({ label: valid.includes(label) ? label : 'other', chunk });
      } catch {
        results.push({ label: 'other', chunk });
      }
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
