import type { Chunk } from '../index/chunker.js';
import type { ExtractedEntity } from '../index/entity-extractor.js';

export type TaskIntentType =
  | 'bug_fix'
  | 'incident_debug'
  | 'repo_understanding'
  | 'crosscutting_search'
  | 'migration'
  | 'refactor'
  | 'feature_work'
  | 'review'
  | 'unknown';

export type ScopeClass =
  | 'surgical'
  | 'focused_investigation'
  | 'module_survey'
  | 'repo_wide'
  | 'wide_refactor';

export type CorpusStatus = 'none' | 'thin' | 'adequate' | 'rich';

export interface TaskProfile {
  intentType: TaskIntentType;
  scopeClass: ScopeClass;
  focusTerms: string[];
  artifactTypes: string[];
  estimatedFiles: { min: number; max: number };
  estimatedToolCalls: { min: number; max: number };
  preferredEntryTools: string[];
  phasePlan: string[];
  corpusStatus: CorpusStatus;
  indexedChunkCount: number;
  bootstrapNeeded: boolean;
  bootstrapHint: string;
  executionLikely: boolean;
  confidence: number;
  rationale: string[];
}

export interface PromptScopeSignals {
  broadScopePrompt: boolean;
  repoWideRequest: boolean;
  moduleSurveyRequest: boolean;
  wideRefactorRequest: boolean;
  crossCuttingRequest: boolean;
  architectureRequest: boolean;
  rationale: string[];
}

export interface TaskProfileInput {
  goal: string;
  rawContent: string;
  chunks: Chunk[];
  entities: ExtractedEntity[];
  enabledTools: string[];
  priorSessionChunkCount?: number;
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'then', 'when', 'what',
  'where', 'which', 'explain', 'analyze', 'analyse', 'whole', 'entire', 'across', 'project',
  'repo', 'codebase', 'please', 'need', 'should', 'about', 'using', 'after', 'before',
  'find', 'debug', 'investigate', 'review', 'look', 'give', 'show', 'build', 'implement',
  'write', 'change', 'update', 'fix', 'make',
]);

const REPO_WIDE_PATTERNS = [
  /\bwhole codebase\b/i,
  /\bentire codebase\b/i,
  /\bwhole repo\b/i,
  /\bentire repo\b/i,
  /\banaly[sz]e (?:the )?(?:whole |entire )?(?:repo|codebase)\b/i,
  /\bunderstand (?:the )?(?:repo|codebase|architecture|system)\b/i,
  /\barchitecture\b/i,
  /\bsystem design\b/i,
  /\bsurvey (?:the )?(?:repo|codebase)\b/i,
  /\bmap (?:the )?(?:repo|codebase)\b/i,
  /\breview (?:the )?(?:whole |entire )?(?:repo|codebase)\b/i,
];

const MODULE_SURVEY_PATTERNS = [
  /\banaly[sz]e (?:the )?(auth|api|payment|billing|frontend|backend|gateway|database|service|worker|module|subsystem)\b/i,
  /\bunderstand (?:the )?(auth|api|payment|billing|frontend|backend|gateway|database|service|worker|module|subsystem)\b/i,
  /\btrace (?:the )?(auth|api|payment|billing|frontend|backend|gateway|database|service|worker|module|subsystem)\b/i,
  /\bfind all (?:the )?(auth|api|payment|billing|frontend|backend|gateway|database|service|worker|module|subsystem)\b/i,
];

const WIDE_REFACTOR_PATTERNS = [
  /\bmigrat(?:e|ion)\b/i,
  /\brename\b/i,
  /\brefactor\b/i,
  /\breplace\b/i,
  /\bupgrade\b/i,
  /\bconvert\b/i,
  /\bport\b/i,
];

const CROSS_CUTTING_PATTERNS = [
  /\bfind all\b/i,
  /\bevery occurrence\b/i,
  /\ball references\b/i,
  /\bacross (?:the )?(?:repo|project|codebase)\b/i,
  /\beverywhere\b/i,
  /\bthroughout (?:the )?(?:repo|project|codebase)\b/i,
];

export function detectPromptScopeSignals(text: string): PromptScopeSignals {
  const trimmed = text.trim();
  const rationale: string[] = [];
  const repoWideRequest = REPO_WIDE_PATTERNS.some((re) => re.test(trimmed));
  const moduleSurveyRequest = MODULE_SURVEY_PATTERNS.some((re) => re.test(trimmed));
  const wideRefactorRequest = WIDE_REFACTOR_PATTERNS.some((re) => re.test(trimmed))
    && CROSS_CUTTING_PATTERNS.some((re) => re.test(trimmed));
  const crossCuttingRequest = CROSS_CUTTING_PATTERNS.some((re) => re.test(trimmed));
  const architectureRequest = /\barchitecture\b|\bsystem design\b|\bhow .* works\b/i.test(trimmed);

  if (repoWideRequest) rationale.push('repo-wide request');
  if (moduleSurveyRequest) rationale.push('module survey request');
  if (wideRefactorRequest) rationale.push('wide refactor language');
  if (crossCuttingRequest) rationale.push('cross-cutting search language');
  if (architectureRequest) rationale.push('architecture request');

  return {
    broadScopePrompt: repoWideRequest || moduleSurveyRequest || wideRefactorRequest || crossCuttingRequest || architectureRequest,
    repoWideRequest,
    moduleSurveyRequest,
    wideRefactorRequest,
    crossCuttingRequest,
    architectureRequest,
    rationale,
  };
}

export function profileTask(input: TaskProfileInput): TaskProfile {
  const scopeSignals = detectPromptScopeSignals(`${input.goal}\n${input.rawContent.slice(0, 4000)}`);
  const lowerGoal = input.goal.toLowerCase();
  const labels = new Set(input.chunks.map((chunk) => chunk.label));
  const totalIndexedChunks = (input.priorSessionChunkCount || 0) + input.chunks.length;
  const rawSlice = input.rawContent.slice(0, 4000);
  const rawHasLogs = /(?:\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+|\[(?:info|warn|error|debug)\]|^(?:INFO|WARN|ERROR|DEBUG)\b|npm ERR!|stdout|stderr)/im.test(rawSlice);
  const rawHasErrors = /(?:\berror\b|\bfatal\b|\bpanic\b|\bexception\b|Traceback|TypeError|ReferenceError|SyntaxError|ENOENT|EACCES|ETIMEDOUT|ECONNREFUSED|ERR_[A-Z_]+)/i.test(rawSlice);
  const rawHasCode = /(?:^\s*(?:import|export|const|let|var|function|class|interface|type|def|fn|async)\b|=>)/m.test(rawSlice);

  const hasLogs = labels.has('log') || labels.has('output') || rawHasLogs;
  const hasErrors = labels.has('error') || labels.has('stacktrace') || rawHasErrors
    || input.entities.some((entity) => entity.type === 'error_message');
  const hasCode = labels.has('code') || rawHasCode || input.entities.some((entity) =>
    entity.type === 'file_path'
    || entity.type === 'function_name'
    || entity.type === 'class_name'
    || entity.type === 'module',
  );
  const hasConfig = labels.has('config')
    || input.entities.some((entity) => entity.type === 'config_key' || entity.type === 'env_var');

  const artifactTypes = [
    hasLogs ? 'logs' : null,
    hasErrors ? 'errors' : null,
    hasCode ? 'code' : null,
    hasConfig ? 'config' : null,
    ...[...labels]
      .filter((label) => !['log', 'output', 'error', 'stacktrace', 'code', 'config'].includes(label))
      .slice(0, 4),
  ].filter(Boolean) as string[];

  const hasExplicitFileAnchor = input.entities.some((entity) => entity.type === 'file_path');
  const hasExplicitSymbolAnchor = input.entities.some((entity) =>
    entity.type === 'function_name' || entity.type === 'class_name' || entity.type === 'module',
  );
  const focusTerms = extractFocusTerms(input.goal, input.entities);

  const migrationRequest = /\bmigrat(?:e|ion)\b/i.test(input.goal);
  const refactorRequest = /\brefactor\b|\brename\b|\breplace\b|\bupgrade\b|\bconvert\b/i.test(input.goal);
  const reviewRequest = /\breview\b|\baudit\b|\bsecurity\b/i.test(input.goal);
  const featureRequest = /\bimplement\b|\bbuild\b|\bcreate\b|\badd\b/i.test(input.goal);
  const incidentRequest = /\bdebug\b|\binvestigate\b|\broot cause\b|\bwhy\b|\btimeout\b|\berror\b|\bfailure\b|\bincident\b/i.test(input.goal);

  let intentType: TaskIntentType = 'unknown';
  if (migrationRequest) intentType = 'migration';
  else if (refactorRequest && scopeSignals.crossCuttingRequest) intentType = 'refactor';
  else if (scopeSignals.architectureRequest || scopeSignals.repoWideRequest) intentType = 'repo_understanding';
  else if (reviewRequest) intentType = 'review';
  else if (featureRequest) intentType = 'feature_work';
  else if (incidentRequest && (hasErrors || hasLogs)) intentType = 'incident_debug';
  else if (scopeSignals.crossCuttingRequest) intentType = 'crosscutting_search';
  else if (/\bfix\b|\bpatch\b|\bupdate\b|\bchange\b/i.test(input.goal)) intentType = 'bug_fix';

  let scopeClass: ScopeClass = 'surgical';
  if (migrationRequest && (scopeSignals.crossCuttingRequest || scopeSignals.repoWideRequest)) {
    scopeClass = 'wide_refactor';
  } else if (scopeSignals.repoWideRequest || scopeSignals.architectureRequest) {
    scopeClass = 'repo_wide';
  } else if (scopeSignals.moduleSurveyRequest || (scopeSignals.crossCuttingRequest && focusTerms.length > 0)) {
    scopeClass = 'module_survey';
  } else if (hasErrors || hasLogs || hasExplicitFileAnchor || hasExplicitSymbolAnchor) {
    scopeClass = 'focused_investigation';
  }

  const corpusStatus: CorpusStatus = totalIndexedChunks === 0
    ? 'none'
    : totalIndexedChunks < 6
      ? 'thin'
      : totalIndexedChunks < 20
        ? 'adequate'
        : 'rich';

  const bootstrapNeeded = ['module_survey', 'repo_wide', 'wide_refactor'].includes(scopeClass)
    && (corpusStatus === 'none' || corpusStatus === 'thin');

  const preferredEntryTools = buildPreferredEntryTools(scopeClass, hasLogs, hasErrors, hasCode, input.enabledTools);
  const estimatedFiles = estimateFiles(scopeClass, bootstrapNeeded);
  const estimatedToolCalls = estimateToolCalls(scopeClass, bootstrapNeeded);
  const phasePlan = buildPhasePlan(scopeClass, bootstrapNeeded, preferredEntryTools);
  const executionLikely = ['migration', 'refactor', 'feature_work', 'bug_fix'].includes(intentType);

  const rationale = [
    ...scopeSignals.rationale,
    hasErrors ? 'error evidence present' : '',
    hasLogs ? 'log evidence present' : '',
    hasCode ? 'code anchors present' : '',
    bootstrapNeeded ? 'corpus too thin for broad task' : '',
  ].filter(Boolean);

  const confidenceSignals = [
    scopeSignals.broadScopePrompt,
    hasExplicitFileAnchor,
    hasExplicitSymbolAnchor,
    hasErrors,
    hasLogs,
    hasCode,
    focusTerms.length > 0,
  ].filter(Boolean).length;
  const confidence = Number(Math.min(0.95, 0.45 + confidenceSignals * 0.07).toFixed(2));

  return {
    intentType,
    scopeClass,
    focusTerms,
    artifactTypes,
    estimatedFiles,
    estimatedToolCalls,
    preferredEntryTools,
    phasePlan,
    corpusStatus,
    indexedChunkCount: totalIndexedChunks,
    bootstrapNeeded,
    bootstrapHint: bootstrapNeeded
      ? 'The request is broader than the currently indexed corpus. Start with repo survey tools to gauge coverage and do not pretend you understand unindexed parts of the codebase.'
      : 'Indexed context appears sufficient for the predicted scope. Stay within the estimated tool budget and narrow quickly after the first survey step.',
    executionLikely,
    confidence,
    rationale,
  };
}

export function formatTaskProfileBlock(profile: TaskProfile): string {
  const lines = ['## TASK PROFILE'];
  lines.push(`Intent: ${profile.intentType}`);
  lines.push(`Scope: ${profile.scopeClass}`);
  lines.push(`Focus terms: ${profile.focusTerms.length > 0 ? profile.focusTerms.join(', ') : '(none detected)'}`);
  lines.push(`Artifacts: ${profile.artifactTypes.length > 0 ? profile.artifactTypes.join(', ') : '(unknown)'}`);
  lines.push(`Expected file span: ${profile.estimatedFiles.min}-${profile.estimatedFiles.max}`);
  lines.push(`Expected tool budget: ${profile.estimatedToolCalls.min}-${profile.estimatedToolCalls.max}`);
  lines.push(`Corpus status: ${profile.corpusStatus} (${profile.indexedChunkCount} indexed chunks available across current request + session)`);
  lines.push(`Bootstrap needed: ${profile.bootstrapNeeded ? 'yes' : 'no'}`);
  lines.push(`Execution likely: ${profile.executionLikely ? 'yes' : 'no'}`);
  lines.push(`Preferred entry tools: ${profile.preferredEntryTools.join(', ') || '(none)'}`);
  lines.push(`Confidence: ${profile.confidence}`);
  lines.push(`Bootstrap guidance: ${profile.bootstrapHint}`);
  if (profile.rationale.length > 0) {
    lines.push(`Rationale: ${profile.rationale.join('; ')}`);
  }
  lines.push('Phase plan:');
  for (const [index, phase] of profile.phasePlan.entries()) {
    lines.push(`${index + 1}. ${phase}`);
  }
  return lines.join('\n');
}

function buildPreferredEntryTools(
  scopeClass: ScopeClass,
  hasLogs: boolean,
  hasErrors: boolean,
  hasCode: boolean,
  enabledTools: string[],
): string[] {
  const enabled = new Set(enabledTools);
  const pick = (tools: string[]) => tools.filter((tool) => enabled.has(tool));

  switch (scopeClass) {
    case 'repo_wide':
      return pick(['repo_map', 'file_tree', 'symbol_find', 'grep', 'file_read', 'summary']);
    case 'wide_refactor':
      return pick(['repo_map', 'symbol_find', 'grep', 'file_read', 'git_diff', 'summary']);
    case 'module_survey':
      return pick(['repo_map', 'file_tree', 'symbol_find', 'grep', 'file_read', 'summary']);
    case 'focused_investigation':
      if (hasLogs && hasCode) return pick(['log_search', 'grep', 'file_read', 'summary']);
      if (hasErrors || hasLogs) return pick(['grep', 'log_search', 'file_read', 'summary']);
      return pick(['file_read', 'grep', 'summary']);
    case 'surgical':
    default:
      if (hasCode) return pick(['file_read', 'grep', 'summary']);
      return pick(['grep', 'summary']);
  }
}

function buildPhasePlan(
  scopeClass: ScopeClass,
  bootstrapNeeded: boolean,
  preferredEntryTools: string[],
): string[] {
  const firstTools = preferredEntryTools.slice(0, 3).join(', ') || 'available tools';

  if (bootstrapNeeded) {
    return [
      `Survey indexed coverage first with ${firstTools}`,
      'Confirm whether the currently indexed corpus is enough for the requested breadth',
      'Only proceed to deeper reads after the likely subsystem or file set is identified',
    ];
  }

  switch (scopeClass) {
    case 'repo_wide':
      return [
        `Map the repository surface with ${firstTools}`,
        'Reduce the task to the top candidate subsystems before reading files',
        'Keep later tool calls narrow and evidence-driven',
      ];
    case 'wide_refactor':
      return [
        `Locate all affected surfaces with ${firstTools}`,
        'Read representative files before proposing broad changes',
        'Sequence changes by dependency order instead of editing blindly',
      ];
    case 'module_survey':
      return [
        `Survey the target module with ${firstTools}`,
        'Pick the smallest candidate file set that answers the question',
        'Switch to file-level reads once the module boundaries are clear',
      ];
    case 'focused_investigation':
      return [
        `Use ${firstTools} to isolate the exact failing signal`,
        'Trace the failure into the most relevant code or config location',
        'Stop broad searching once the root cause path is clear',
      ];
    case 'surgical':
    default:
      return [
        `Use ${firstTools} to confirm the exact target`,
        'Read the minimum evidence needed before answering',
      ];
  }
}

function estimateFiles(scopeClass: ScopeClass, bootstrapNeeded: boolean) {
  switch (scopeClass) {
    case 'repo_wide':
      return bootstrapNeeded ? { min: 12, max: 50 } : { min: 10, max: 40 };
    case 'wide_refactor':
      return bootstrapNeeded ? { min: 10, max: 70 } : { min: 8, max: 60 };
    case 'module_survey':
      return bootstrapNeeded ? { min: 6, max: 20 } : { min: 5, max: 15 };
    case 'focused_investigation':
      return { min: 2, max: 8 };
    case 'surgical':
    default:
      return { min: 1, max: 3 };
  }
}

function estimateToolCalls(scopeClass: ScopeClass, bootstrapNeeded: boolean) {
  switch (scopeClass) {
    case 'repo_wide':
      return bootstrapNeeded ? { min: 8, max: 18 } : { min: 6, max: 15 };
    case 'wide_refactor':
      return bootstrapNeeded ? { min: 8, max: 20 } : { min: 7, max: 16 };
    case 'module_survey':
      return bootstrapNeeded ? { min: 6, max: 14 } : { min: 5, max: 12 };
    case 'focused_investigation':
      return { min: 4, max: 10 };
    case 'surgical':
    default:
      return { min: 2, max: 5 };
  }
}

function extractFocusTerms(goal: string, entities: ExtractedEntity[]): string[] {
  const seeded = entities
    .filter((entity) => ['file_path', 'function_name', 'class_name', 'module', 'config_key'].includes(entity.type))
    .map((entity) => normalizeFocusTerm(entity.value))
    .filter((term): term is string => Boolean(term));

  const fromGoal = goal
    .toLowerCase()
    .replace(/[^a-z0-9_./:-]+/g, ' ')
    .split(/\s+/)
    .map((term) => normalizeFocusTerm(term))
    .filter((term): term is string => typeof term === 'string' && !STOP_WORDS.has(term));

  return [...new Set([...seeded, ...fromGoal])].slice(0, 5);
}

function normalizeFocusTerm(term: string): string | null {
  const cleaned = term.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!cleaned) return null;
  if (cleaned.length < 3) return null;
  if (/^\d+$/.test(cleaned)) return null;
  return cleaned.slice(0, 60);
}
