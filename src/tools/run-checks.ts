import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerTool } from './registry.js';

const execFileAsync = promisify(execFile);

type CheckAction = 'lint' | 'typecheck' | 'test' | 'build';

registerTool({
  definition: {
    name: 'run_checks',
    description: 'Run safe project validation checks (lint, typecheck, test, build). Executes only known project scripts or safe fallback commands.',
    mode: 'execute',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['lint', 'typecheck', 'test', 'build'],
          description: 'Which project check to run',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Timeout in seconds (default 180)',
        },
      },
      required: ['action'],
    },
  },

  handler: async (args: Record<string, unknown>): Promise<string> => {
    const action = String(args.action || '') as CheckAction;
    const timeoutSeconds = Number(args.timeout_seconds) || 180;
    if (!['lint', 'typecheck', 'test', 'build'].includes(action)) {
      return 'Error: action must be one of lint, typecheck, test, build';
    }

    const command = resolveCheckCommand(action, process.cwd());
    if (!command) {
      return `No safe command found for "${action}". Add a matching npm script in package.json.`;
    }

    const timeoutMs = Math.max(10, timeoutSeconds) * 1000;
    const startedAt = Date.now();
    try {
      const result = await execFileAsync(command.bin, command.args, {
        cwd: process.cwd(),
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 8,
      });

      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      return [
        `Check: ${action}`,
        `Status: success`,
        `Command: ${command.bin} ${command.args.join(' ')}`,
        `DurationMs: ${Date.now() - startedAt}`,
        '',
        output.slice(-4000) || '(no output)',
      ].join('\n');
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string; signal?: string | null; code?: number | string };
      const output = [e.stdout || '', e.stderr || '', e.message || ''].filter(Boolean).join('\n').trim();
      return [
        `Check: ${action}`,
        `Status: failed`,
        `Command: ${command.bin} ${command.args.join(' ')}`,
        `DurationMs: ${Date.now() - startedAt}`,
        `Exit: ${String(e.code || e.signal || 'error')}`,
        '',
        output.slice(-4000) || '(no output)',
      ].join('\n');
    }
  },
});

export interface CheckCommand {
  bin: string;
  args: string[];
}

export function resolveCheckCommand(action: CheckAction, cwd: string): CheckCommand | null {
  const scripts = readPackageScripts(cwd);

  if (action === 'typecheck') {
    if (scripts.typecheck) return npmRun('typecheck');
    if (scripts.lint && /\btsc\b/.test(scripts.lint)) return npmRun('lint');
    return { bin: 'npx', args: ['tsc', '--noEmit'] };
  }

  if (scripts[action]) return npmRun(action);
  return null;
}

function readPackageScripts(cwd: string): Record<string, string> {
  const path = resolve(cwd, 'package.json');
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { scripts?: Record<string, string> };
    return parsed.scripts || {};
  } catch {
    return {};
  }
}

function npmRun(script: string): CheckCommand {
  return { bin: 'npm', args: ['run', script, '--silent'] };
}
