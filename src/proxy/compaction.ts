// 3-tier compaction system (inspired by Claude Code's architecture)
// Tier 1 - Microcompaction: Tool results hot tail (last 3 inline) + cold storage
// Tier 2 - Auto-compaction: Trigger at 80% of context budget
// Tier 3 - Manual compaction: /compact command in CLI

import type { SessionStore, CoreMemory } from '../index/session-store.js';
import type { LocalLLMAdapter } from '../local-llm/adapter.js';
import { countTokens } from './interceptor.js';
import { log } from '../display/logger.js';

const HOT_TAIL_SIZE = 3;
const AUTO_COMPACT_THRESHOLD = 0.8;
// Reserve tokens for the model output + compaction prompt itself
const OUTPUT_RESERVE = 2000;
const MIN_EFFECTIVE_BUDGET = 400;
const AUTO_COMPACT_COOLDOWN_MS = 15_000;

export interface CompactionConfig {
  contextBudget: number;
  hotTailSize?: number;
  autoThreshold?: number;
}

export function shouldAutoCompact(
  currentTokens: number,
  config: CompactionConfig,
): boolean {
  if (config.contextBudget <= 0) return true;
  const threshold = config.autoThreshold ?? AUTO_COMPACT_THRESHOLD;
  const effectiveBudget = Math.max(MIN_EFFECTIVE_BUDGET, config.contextBudget - OUTPUT_RESERVE);
  return currentTokens > effectiveBudget * threshold;
}

export function autoCompactThresholdTokens(config: CompactionConfig): number {
  if (config.contextBudget <= 0) return 0;
  const threshold = config.autoThreshold ?? AUTO_COMPACT_THRESHOLD;
  const effectiveBudget = Math.max(MIN_EFFECTIVE_BUDGET, config.contextBudget - OUTPUT_RESERVE);
  return Math.round(effectiveBudget * threshold);
}

export function microcompactToolResults(
  sessionStore: SessionStore,
  sessionId?: string,
): { hotResults: string; frozenCount: number } {
  sessionStore.freezeOldToolResults(HOT_TAIL_SIZE, sessionId);
  const hotResults = sessionStore.getHotToolResults(HOT_TAIL_SIZE, sessionId);

  if (hotResults.length === 0) {
    return { hotResults: '', frozenCount: 0 };
  }

  const lines = hotResults.map((r) =>
    `[${r.toolName}] query="${r.query}" -> ${r.result.slice(0, 500)}${r.result.length > 500 ? '...(truncated, full result in cold storage)' : ''}`,
  );

  const frozenCount = sessionStore.getToolResultTokenCount(sessionId);

  return {
    hotResults: lines.join('\n'),
    frozenCount,
  };
}

export async function autoCompact(
  sessionStore: SessionStore,
  llm: LocalLLMAdapter,
  currentMessages: Array<{ role: string; content: string }>,
  config: CompactionConfig,
  sessionId?: string,
): Promise<{ compacted: boolean; coreMemory: CoreMemory | null; summaryMessage: string }> {
  const currentTokens = currentMessages.reduce((sum, m) => sum + countTokens(m.content), 0);

  if (!shouldAutoCompact(currentTokens, config)) {
    return { compacted: false, coreMemory: null, summaryMessage: '' };
  }

  const existingMemory = sessionStore.getCoreMemory(sessionId);
  const compactedAt = existingMemory?.compactedAt ? Date.parse(existingMemory.compactedAt) : 0;
  if (compactedAt && Number.isFinite(compactedAt) && Date.now() - compactedAt < AUTO_COMPACT_COOLDOWN_MS) {
    return { compacted: false, coreMemory: existingMemory || null, summaryMessage: '' };
  }

  log('compact', `Auto-compaction triggered: ${currentTokens} tokens > ${autoCompactThresholdTokens(config)} threshold`);

  const conversationText = currentMessages
    .map((m) => `[${m.role}]: ${m.content.slice(0, 2000)}`)
    .join('\n---\n');

  return runCompaction(sessionStore, llm, conversationText, sessionId, existingMemory || undefined);
}

export async function manualCompact(
  sessionStore: SessionStore,
  llm: LocalLLMAdapter,
  sourceText: string,
  sessionId?: string,
): Promise<{ compacted: boolean; coreMemory: CoreMemory | null; summaryMessage: string }> {
  let conversationText = sourceText.trim();
  if (!conversationText) {
    const recentChunks = sessionStore.getRecentChunks(200, sessionId);
    conversationText = recentChunks
      .map((c) => `[chunk:${c.label}] ${c.text.slice(0, 500)}`)
      .join('\n---\n');
  }

  if (!conversationText) {
    return { compacted: false, coreMemory: null, summaryMessage: 'No session content available to compact.' };
  }

  log('compact', `Manual compaction started for session ${sessionId || sessionStore.currentSessionId}`);
  return runCompaction(sessionStore, llm, conversationText, sessionId);
}

async function runCompaction(
  sessionStore: SessionStore,
  llm: LocalLLMAdapter,
  conversationText: string,
  sessionId?: string,
  existingMemoryInput?: CoreMemory,
): Promise<{ compacted: boolean; coreMemory: CoreMemory | null; summaryMessage: string }> {
  // Build compaction prompt: ask local LLM to summarize the conversation state

  const existingMemory = existingMemoryInput || sessionStore.getCoreMemory(sessionId);
  const memoryContext = existingMemory
    ? `\nPREVIOUS STATE:\nGoal: ${existingMemory.goal}\nFiles: ${existingMemory.filesTouched.join(', ')}\nDecisions: ${existingMemory.decisions.join('; ')}\nErrors: ${existingMemory.errorsFixed.join('; ')}\nPending: ${existingMemory.pendingTasks.join('; ')}`
    : '';

  const compactionPrompt = `Summarize this conversation state into a structured working state. Be precise and actionable.
${memoryContext}

CONVERSATION:
${conversationText.slice(0, 6000)}

Respond in this EXACT format:
GOAL: <one sentence objective>
FILES: <comma-separated file paths mentioned>
DECISIONS: <key technical decisions made, semicolon-separated>
ERRORS: <errors encountered and how fixed, semicolon-separated>
PENDING: <remaining tasks, semicolon-separated>
NEXT: <single most important next action>`;

  try {
    const result = await llm.summarize(compactionPrompt, 300);
    const parsed = parseCompactionResult(result);

    // Merge with existing memory
    sessionStore.updateCoreMemory({
      ...parsed,
      toolResultCount: existingMemory?.toolResultCount ?? 0,
      compactedAt: new Date().toISOString(),
    }, sessionId);

    // Freeze old tool results
    microcompactToolResults(sessionStore, sessionId);

    const summaryMessage = `[COMPACTION BOUNDARY - Previous context summarized]
${sessionStore.formatCoreMemoryBlock(sessionId)}
Continue from where we left off. The session state above is authoritative.`;

    log('compact', 'Compaction completed -> core memory updated');
    return { compacted: true, coreMemory: parsed, summaryMessage };
  } catch (err) {
    log('error', `Auto-compaction failed: ${err instanceof Error ? err.message : String(err)}`);
    return { compacted: false, coreMemory: null, summaryMessage: '' };
  }
}

function parseCompactionResult(text: string): CoreMemory {
  const get = (prefix: string): string => {
    const match = text.match(new RegExp(`${prefix}:\\s*(.+?)(?:\\n|$)`, 'i'));
    return match?.[1]?.trim() || '';
  };

  const split = (s: string): string[] =>
    s.split(/[;,]/).map((x) => x.trim()).filter(Boolean);

  return {
    goal: get('GOAL') || 'Continue the current task',
    filesTouched: split(get('FILES')),
    decisions: split(get('DECISIONS')),
    errorsFixed: split(get('ERRORS')),
    pendingTasks: split(get('PENDING')),
    nextStep: get('NEXT') || '',
    toolResultCount: 0,
  };
}
