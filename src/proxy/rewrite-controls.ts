import type { VectorStore } from '../index/store.js';
import type { LocalLLMAdapter } from '../local-llm/adapter.js';
import type { SessionStore } from '../index/session-store.js';
import { getTool } from '../tools/registry.js';
import { countTokens } from './interceptor.js';
import type { ScopeClass, TaskProfile } from './task-profiler.js';
import { log } from '../display/logger.js';

export interface BootstrapPlanStep {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface BootstrapStepResult {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  output: string;
}

export interface BootstrapResult {
  ran: boolean;
  stepCount: number;
  toolNames: string[];
  totalTokens: number;
  summaryBlock: string;
}

export interface RewriteROI {
  shouldRewrite: boolean;
  reason: string;
  tokenSavings: number;
  tokenReduction: number;
}

const BROAD_SCOPES = new Set<ScopeClass>(['module_survey', 'repo_wide', 'wide_refactor']);
const BOOTSTRAP_READ_TOOLS = new Set(['repo_map', 'file_tree', 'symbol_find', 'grep', 'log_search', 'file_read', 'git_diff']);
const MAX_BOOTSTRAP_STEPS = 2;
const MAX_STEP_CHARS = 750;

export async function runDeterministicBootstrap(
  taskProfile: TaskProfile,
  searchPlan: BootstrapPlanStep[],
  ctx: { store: VectorStore; llm: LocalLLMAdapter; sessionStore?: SessionStore; sessionId?: string },
): Promise<BootstrapResult> {
  if (!BROAD_SCOPES.has(taskProfile.scopeClass)) {
    return emptyBootstrap();
  }

  const candidateSteps = searchPlan
    .filter((step) => BOOTSTRAP_READ_TOOLS.has(step.tool))
    .slice(0, MAX_BOOTSTRAP_STEPS);

  if (candidateSteps.length === 0) {
    return emptyBootstrap();
  }

  const executed: BootstrapStepResult[] = [];

  for (const step of candidateSteps) {
    const tool = getTool(step.tool);
    if (!tool || tool.definition.mode === 'execute') continue;

    try {
      const output = await tool.handler(step.args, ctx);
      const trimmed = trimForPrompt(output, MAX_STEP_CHARS);
      executed.push({
        tool: step.tool,
        args: step.args,
        reason: step.reason,
        output: trimmed,
      });

      if (ctx.sessionStore) {
        try {
          const query = step.args.query || step.args.pattern || step.args.topic || '';
          ctx.sessionStore.addToolResult(step.tool, String(query), trimmed, countTokens(trimmed), ctx.sessionId);
        } catch {
          // non-critical
        }
      }
    } catch (err) {
      log('warn', `Bootstrap tool ${step.tool} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (executed.length === 0) {
    return emptyBootstrap();
  }

  const summaryBlock = [
    '## DETERMINISTIC BOOTSTRAP',
    'The local harness already executed the first survey steps for this broad task. Start from these results before making additional tool calls.',
    '',
    ...executed.flatMap((step, index) => [
      `${index + 1}. ${step.tool}(${JSON.stringify(step.args)}) -- ${step.reason}`,
      step.output,
      '',
    ]),
  ].join('\n').trim();

  return {
    ran: true,
    stepCount: executed.length,
    toolNames: executed.map((step) => step.tool),
    totalTokens: countTokens(summaryBlock),
    summaryBlock,
  };
}

export function evaluateRewriteROI(input: {
  inputTokens: number;
  outputTokens: number;
  taskProfile: TaskProfile;
  routeMode: 'passthrough' | 'context_shape' | 'full_rewrite';
  decisionReasons: string[];
  bootstrap: BootstrapResult;
}): RewriteROI {
  const tokenSavings = input.inputTokens - input.outputTokens;
  const tokenReduction = input.inputTokens > 0
    ? Number((tokenSavings / input.inputTokens).toFixed(4))
    : 0;
  const broadScope = BROAD_SCOPES.has(input.taskProfile.scopeClass);
  const noisyContext = input.taskProfile.artifactTypes.includes('logs')
    || input.taskProfile.artifactTypes.includes('errors')
    || input.decisionReasons.some((reason) =>
      ['log-heavy context', 'stacktrace-heavy context', 'mixed debugging context', 'debugging artifact bundle', 'error-dense context'].includes(reason),
    );

  if (broadScope || input.bootstrap.ran) {
    return {
      shouldRewrite: true,
      reason: input.bootstrap.ran
        ? 'broad-scope task received deterministic bootstrap context'
        : 'broad-scope task benefits from structured retrieval guidance',
      tokenSavings,
      tokenReduction,
    };
  }

  if (input.inputTokens >= 1200) {
    return {
      shouldRewrite: true,
      reason: 'large prompt still benefits from context shaping',
      tokenSavings,
      tokenReduction,
    };
  }

  if (tokenSavings >= 250 || tokenReduction >= 0.25) {
    return {
      shouldRewrite: true,
      reason: 'rewrite provides material token savings',
      tokenSavings,
      tokenReduction,
    };
  }

  if (noisyContext && input.inputTokens >= 600 && input.outputTokens <= Math.ceil(input.inputTokens * 1.15)) {
    return {
      shouldRewrite: true,
      reason: 'dense debugging context warrants guided retrieval despite limited token savings',
      tokenSavings,
      tokenReduction,
    };
  }

  if (input.routeMode === 'context_shape' && input.inputTokens >= 700 && input.outputTokens <= Math.ceil(input.inputTokens * 1.1)) {
    return {
      shouldRewrite: true,
      reason: 'semantic intercept on moderately large dense context remains worthwhile',
      tokenSavings,
      tokenReduction,
    };
  }

  return {
    shouldRewrite: false,
    reason: 'small or focused prompt with weak rewrite ROI',
    tokenSavings,
    tokenReduction,
  };
}

function emptyBootstrap(): BootstrapResult {
  return {
    ran: false,
    stepCount: 0,
    toolNames: [],
    totalTokens: 0,
    summaryBlock: '',
  };
}

function trimForPrompt(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  const clipped = normalized.slice(0, maxChars).trimEnd();
  return `${clipped}\n... [truncated bootstrap result]`;
}
