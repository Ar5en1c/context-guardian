import { encode } from 'gpt-tokenizer';
import { log } from '../display/logger.js';

export interface InterceptDecision {
  shouldIntercept: boolean;
  totalTokens: number;
  messageTokens: number[];
  largestMessageIndex: number;
  largestMessageTokens: number;
}

export function countTokens(text: string): number {
  try {
    return encode(text).length;
  } catch {
    return Math.ceil(text.length / 3.5);
  }
}

export function analyzeRequest(
  messages: Array<{ role: string; content: unknown }>,
  threshold: number,
): InterceptDecision {
  let totalTokens = 0;
  const messageTokens: number[] = [];
  let largestIndex = 0;
  let largestCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const content = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);
    const tokens = countTokens(content);
    messageTokens.push(tokens);
    totalTokens += tokens;

    if (tokens > largestCount) {
      largestCount = tokens;
      largestIndex = i;
    }
  }

  const shouldIntercept = totalTokens > threshold;

  if (shouldIntercept) {
    log('intercept', `Request exceeds threshold: ${totalTokens} tokens > ${threshold} threshold`);
  } else {
    log('passthrough', `Request within budget: ${totalTokens} tokens`);
  }

  return {
    shouldIntercept,
    totalTokens,
    messageTokens,
    largestMessageIndex: largestIndex,
    largestMessageTokens: largestCount,
  };
}

export function extractRawContent(messages: Array<{ role: string; content: unknown }>): string {
  return messages
    .map((m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `[${m.role}]\n${content}`;
    })
    .join('\n\n');
}
