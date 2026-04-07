export interface LocalLLMAdapter {
  name: string;
  isAvailable(): Promise<boolean>;
  extractIntent(rawContent: string): Promise<string>;
  classifyChunks(chunks: string[]): Promise<Array<{ label: string; chunk: string }>>;
  summarize(text: string, maxTokens?: number): Promise<string>;
  embed(texts: string[]): Promise<number[][]>;
}
