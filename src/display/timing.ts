import { log } from './logger.js';

export interface TimingReport {
  totalMs: number;
  intentExtractionMs: number;
  chunkingMs: number;
  classificationMs: number;
  embeddingMs: number;
  cloudForwardMs: number;
  toolExecutionMs: number;
}

export class Timer {
  private marks = new Map<string, number>();
  private durations = new Map<string, number>();

  mark(name: string) {
    this.marks.set(name, performance.now());
  }

  measure(name: string, startMark: string) {
    const start = this.marks.get(startMark);
    if (start == null) return;
    this.durations.set(name, performance.now() - start);
  }

  get(name: string): number {
    return this.durations.get(name) ?? 0;
  }

  report(): TimingReport {
    return {
      totalMs: this.get('total'),
      intentExtractionMs: this.get('intent'),
      chunkingMs: this.get('chunking'),
      classificationMs: this.get('classification'),
      embeddingMs: this.get('embedding'),
      cloudForwardMs: this.get('cloud'),
      toolExecutionMs: this.get('tools'),
    };
  }

  print() {
    const r = this.report();
    const parts = [
      `total: ${r.totalMs.toFixed(0)}ms`,
      r.intentExtractionMs > 0 ? `intent: ${r.intentExtractionMs.toFixed(0)}ms` : null,
      r.chunkingMs > 0 ? `chunk: ${r.chunkingMs.toFixed(0)}ms` : null,
      r.classificationMs > 0 ? `classify: ${r.classificationMs.toFixed(0)}ms` : null,
      r.embeddingMs > 0 ? `embed: ${r.embeddingMs.toFixed(0)}ms` : null,
      r.cloudForwardMs > 0 ? `cloud: ${r.cloudForwardMs.toFixed(0)}ms` : null,
      r.toolExecutionMs > 0 ? `tools: ${r.toolExecutionMs.toFixed(0)}ms` : null,
    ].filter(Boolean);
    log('info', `Timing: ${parts.join(' | ')}`);
  }
}
