import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerTool } from './registry.js';

const execFileAsync = promisify(execFile);

registerTool({
  definition: {
    name: 'git_diff',
    description: 'Inspect git changes (working tree, staged, or all) for current project. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['working', 'staged', 'all'],
          description: 'Diff scope (default working)',
        },
        file: { type: 'string', description: 'Optional file path filter' },
        max_chars: { type: 'number', description: 'Max characters to return (default 6000)' },
      },
      required: [],
    },
  },

  handler: async (args: Record<string, unknown>): Promise<string> => {
    const scope = String(args.scope || 'working');
    const file = String(args.file || '').trim();
    const maxChars = Math.max(500, Number(args.max_chars) || 6000);

    try {
      const status = await runGit(['status', '--short']);
      const statusText = status.stdout.trim();
      const sections: string[] = ['## git status --short', statusText || '(clean)'];

      if (scope === 'working' || scope === 'all') {
        const diff = await runGit(['diff', ...(file ? ['--', file] : [])]);
        sections.push('## git diff (working)', clipOutput(diff.stdout || '(no diff)', maxChars));
      }
      if (scope === 'staged' || scope === 'all') {
        const diffCached = await runGit(['diff', '--cached', ...(file ? ['--', file] : [])]);
        sections.push('## git diff --cached', clipOutput(diffCached.stdout || '(no staged diff)', maxChars));
      }

      return sections.join('\n\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `git_diff failed: ${msg}`;
    }
  },
});

async function runGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd: process.cwd(),
    timeout: 15000,
    maxBuffer: 1024 * 1024 * 4,
  });
}

function clipOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n... [truncated ${text.length - maxChars} chars]`;
}
