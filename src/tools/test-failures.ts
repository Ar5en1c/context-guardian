import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerTool } from './registry.js';
import type { ToolContext } from './registry.js';
import { collectSearchChunks } from './utils.js';

const execFileAsync = promisify(execFile);

registerTool({
  definition: {
    name: 'test_failures',
    description: 'Summarize failing tests/errors from indexed logs, or run project tests and extract failures.',
    mode: 'execute',
    parameters: {
      type: 'object',
      properties: {
        run: { type: 'boolean', description: 'Run test command before extraction (default false)' },
        command: { type: 'string', description: 'Optional safe test command override (e.g. "npm run test --silent")' },
        limit: { type: 'number', description: 'Max failure lines to return (default 20)' },
      },
      required: [],
    },
  },

  handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
    const run = Boolean(args.run);
    const command = String(args.command || '').trim();
    const limit = Math.max(1, Number(args.limit) || 20);

    let corpus = '';
    if (run) {
      const output = await runTests(command);
      corpus = output;
      if (ctx.sessionStore && output.trim()) {
        ctx.sessionStore.addChunks(
          [{
            id: `test-output-${Date.now()}`,
            text: output,
            label: 'output',
            startOffset: 0,
            endOffset: output.length,
            metadata: { source: 'test_failures' },
          }],
          [[]],
          ctx.sessionId,
        );
      }
    } else {
      const chunks = collectSearchChunks(ctx, { includeSession: true, sessionLimit: 500 });
      corpus = chunks
        .filter((c) => ['error', 'stacktrace', 'output', 'log'].includes(c.label))
        .map((c) => c.text)
        .join('\n');
    }

    if (!corpus.trim()) return 'No test output available.';

    const failures = extractFailureLines(corpus, limit);
    if (failures.length === 0) {
      return 'No obvious failures found in available test output.';
    }

    return [
      `Failure lines: ${failures.length}`,
      ...failures.map((line, i) => `${i + 1}. ${line}`),
    ].join('\n');
  },
});

const FAILURE_PATTERNS = [
  /FAIL(?:ED)?/i,
  /AssertionError/i,
  /TypeError/i,
  /ReferenceError/i,
  /SyntaxError/i,
  /\bERR(?:OR)?\b/i,
  /at .*:\d+:\d+/,
  /not toBe|toEqual|expected .* to/i,
];

export function extractFailureLines(text: string, limit = 20): string[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (!FAILURE_PATTERNS.some((p) => p.test(line))) continue;
    const normalized = line.slice(0, 260);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

async function runTests(command: string): Promise<string> {
  const resolved = resolveTestCommand(command);
  if (!resolved) {
    return 'No safe test command resolved. Provide command like "npm run test --silent".';
  }
  try {
    const { stdout, stderr } = await execFileAsync(resolved.bin, resolved.args, {
      cwd: process.cwd(),
      timeout: 180000,
      maxBuffer: 1024 * 1024 * 12,
    });
    return [stdout, stderr].filter(Boolean).join('\n');
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return [e.stdout || '', e.stderr || '', e.message || ''].filter(Boolean).join('\n');
  }
}

export function resolveTestCommand(command: string): { bin: string; args: string[] } | null {
  if (!command) return { bin: 'npm', args: ['run', 'test', '--silent'] };
  const trimmed = command.trim();
  const allowed = [
    /^npm run test(?:\s+--silent)?$/i,
    /^npm test(?:\s+--silent)?$/i,
    /^pnpm test$/i,
    /^yarn test$/i,
    /^pytest(?:\s+.+)?$/i,
    /^vitest(?:\s+.+)?$/i,
  ];
  if (!allowed.some((p) => p.test(trimmed))) return null;

  const [bin, ...args] = trimmed.split(/\s+/);
  return { bin, args };
}
