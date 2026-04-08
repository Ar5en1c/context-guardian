import { encode } from 'gpt-tokenizer';
import { log } from '../display/logger.js';
import { detectPromptScopeSignals } from './task-profiler.js';

export interface InterceptPolicy {
  signal_score_threshold: number;
  min_context_shape_tokens: number;
  min_context_shape_lines: number;
  large_message_tokens: number;
  total_line_trigger: number;
  log_line_trigger: number;
  stacktrace_line_trigger: number;
  error_line_trigger: number;
  code_line_trigger: number;
  path_hint_trigger: number;
}

export const DEFAULT_INTERCEPT_POLICY: InterceptPolicy = {
  signal_score_threshold: 3,
  min_context_shape_tokens: 600,
  min_context_shape_lines: 60,
  large_message_tokens: 1400,
  total_line_trigger: 80,
  log_line_trigger: 60,
  stacktrace_line_trigger: 10,
  error_line_trigger: 8,
  code_line_trigger: 140,
  path_hint_trigger: 6,
};

export interface InterceptSignals {
  totalLines: number;
  logLikeLines: number;
  stacktraceLines: number;
  errorLines: number;
  codeLikeLines: number;
  pathHints: number;
  fencedCodeBlocks: number;
  mixedContext: boolean;
  semanticScore: number;
  broadScopePrompt: boolean;
  scopeHintReasons: string[];
}

export interface InterceptDecision {
  shouldIntercept: boolean;
  mode: 'passthrough' | 'context_shape' | 'full_rewrite';
  totalTokens: number;
  messageTokens: number[];
  largestMessageIndex: number;
  largestMessageTokens: number;
  reasons: string[];
  signals: InterceptSignals;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  if (text.length > 20000) {
    return Math.ceil(text.length / 3.5);
  }
  try {
    return encode(text).length;
  } catch {
    return Math.ceil(text.length / 3.5);
  }
}

export function normalizeMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        const rec = item as Record<string, unknown>;
        if (typeof rec.text === 'string') return rec.text;
        if (typeof rec.content === 'string') return rec.content;
        if (typeof rec.input === 'string') return rec.input;
        return JSON.stringify(rec);
      })
      .join('\n');
  }
  if (!content) return '';
  if (typeof content === 'object') return JSON.stringify(content);
  return String(content);
}

export function analyzeRequest(
  messages: Array<{ role: string; content: unknown }>,
  threshold: number,
  policy: InterceptPolicy = DEFAULT_INTERCEPT_POLICY,
): InterceptDecision {
  let totalTokens = 0;
  const messageTokens: number[] = [];
  let largestIndex = 0;
  let largestCount = 0;
  let totalLines = 0;
  let logLikeLines = 0;
  let stacktraceLines = 0;
  let errorLines = 0;
  let codeLikeLines = 0;
  let pathHints = 0;
  let fencedCodeBlocks = 0;
  const promptScope = detectPromptScopeSignals(
    messages
      .filter((msg) => msg.role !== 'system')
      .map((msg) => normalizeMessageContent(msg.content))
      .join('\n'),
  );

  const logLineRe = /(?:\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+|\[(?:info|warn|error|debug)\]|^(?:INFO|WARN|ERROR|DEBUG)\b|npm ERR!|stdout|stderr)/i;
  const stacktraceRe = /(?:^\s+at\s+\S+|^Traceback\b|^Caused by:|File ".*", line \d+|[a-zA-Z0-9_.-]+\.(?:ts|js|py|go|java|rs):\d+)/i;
  const errorLineRe = /(?:\berror\b|\bfatal\b|\bpanic\b|\bexception\b|TypeError|ReferenceError|SyntaxError|ENOENT|EACCES|ETIMEDOUT|ECONNREFUSED|ERR_[A-Z_]+)/i;
  const codeLineRe = /(?:^\s*(?:import|export|const|let|var|function|class|interface|type|def|fn|async)\b|=>|{\s*$|^\s*<\/?[A-Za-z][^>]*>$)/;
  const pathHintRe = /(?:\/[\w.-]+){2,}(?:\.\w+)?|[\w.-]+(?:[/\\][\w.-]+){2,}(?:\.\w+)?/g;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const content = normalizeMessageContent(msg.content);
    const tokens = countTokens(content);
    messageTokens.push(tokens);
    totalTokens += tokens;

    if (tokens > largestCount) {
      largestCount = tokens;
      largestIndex = i;
    }

    const signalContent = content.length > 20000
      ? `${content.slice(0, 10000)}\n${content.slice(-5000)}`
      : content;

    const lines = signalContent.split(/\r?\n/);
    totalLines += lines.length;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (logLineRe.test(line)) logLikeLines++;
      if (stacktraceRe.test(line)) stacktraceLines++;
      if (errorLineRe.test(line)) errorLines++;
      if (codeLineRe.test(line)) codeLikeLines++;
    }

    pathHints += (signalContent.match(pathHintRe) || []).length;
    fencedCodeBlocks += Math.floor((signalContent.match(/```/g) || []).length / 2);
  }

  const mixedSignals = [
    logLikeLines >= Math.max(5, Math.floor(policy.log_line_trigger / 3)),
    stacktraceLines >= Math.max(3, Math.floor(policy.stacktrace_line_trigger / 2)),
    errorLines >= Math.max(3, Math.floor(policy.error_line_trigger / 2)),
    codeLikeLines >= Math.max(12, Math.floor(policy.code_line_trigger / 4)),
  ].filter(Boolean).length >= 2;
  const debuggingBundle =
    (logLikeLines >= 12 && errorLines >= 6) ||
    (logLikeLines >= 12 && codeLikeLines >= 10) ||
    (errorLines >= 6 && codeLikeLines >= 10);

  const reasons: string[] = [];
  let semanticScore = 0;

  if (largestCount >= policy.large_message_tokens) {
    semanticScore += 1;
    reasons.push('dense single artifact');
  }
  if (totalLines >= policy.total_line_trigger) {
    semanticScore += 1;
    reasons.push('many structured lines');
  }
  if (logLikeLines >= policy.log_line_trigger) {
    semanticScore += 2;
    reasons.push('log-heavy context');
  }
  if (stacktraceLines >= policy.stacktrace_line_trigger) {
    semanticScore += 2;
    reasons.push('stacktrace-heavy context');
  }
  if (errorLines >= policy.error_line_trigger) {
    semanticScore += 1;
    reasons.push('error-dense context');
  }
  if (codeLikeLines >= policy.code_line_trigger) {
    semanticScore += 1;
    reasons.push('large code artifact');
  }
  if (pathHints >= policy.path_hint_trigger) {
    semanticScore += 1;
    reasons.push('many path hints');
  }
  if (mixedSignals) {
    semanticScore += 1;
    reasons.push('mixed debugging context');
  }
  if (debuggingBundle) {
    semanticScore += 2;
    reasons.push('debugging artifact bundle');
  }
  if (fencedCodeBlocks >= 2) {
    semanticScore += 1;
    reasons.push('multiple fenced artifacts');
  }

  const thresholdIntercept = totalTokens > threshold;
  const semanticIntercept = semanticScore >= policy.signal_score_threshold
    && (
      totalTokens >= policy.min_context_shape_tokens
      || totalLines >= policy.min_context_shape_lines
      || logLikeLines >= Math.max(40, Math.floor(policy.log_line_trigger * 0.75))
    );
  const shouldIntercept = thresholdIntercept || semanticIntercept;
  const mode: InterceptDecision['mode'] = thresholdIntercept
    ? 'full_rewrite'
    : semanticIntercept
      ? 'context_shape'
      : 'passthrough';

  if (shouldIntercept) {
    const detail = thresholdIntercept
      ? `threshold: ${totalTokens} tokens > ${threshold}`
      : `semantic score ${semanticScore} (${reasons.join(', ')})`;
    log('intercept', `Request routed to ${mode}: ${detail}`);
  } else {
    log('passthrough', `Request within budget: ${totalTokens} tokens (semantic score ${semanticScore})`);
  }

  return {
    shouldIntercept,
    mode,
    totalTokens,
    messageTokens,
    largestMessageIndex: largestIndex,
    largestMessageTokens: largestCount,
    reasons,
    signals: {
      totalLines,
      logLikeLines,
      stacktraceLines,
      errorLines,
      codeLikeLines,
      pathHints,
      fencedCodeBlocks,
      mixedContext: mixedSignals,
      semanticScore,
      broadScopePrompt: promptScope.broadScopePrompt,
      scopeHintReasons: promptScope.rationale,
    },
  };
}

export function extractRawContent(messages: Array<{ role: string; content: unknown }>): string {
  return messages
    .map((m) => {
      const content = normalizeMessageContent(m.content);
      return `[${m.role}]\n${content}`;
    })
    .join('\n\n');
}
