// skills/github-issues/promote.ts
//
// Thin wrapper around `gh issue create`. The injectable `exec` keeps tests
// fast and deterministic (no real subprocess, no GitHub round-trip).

import { spawn } from 'child_process';

export interface PromoteInput {
  title: string;
  body: string;
  labels: string[];
  repo: string;
  exec?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
}

const defaultExec = (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> =>
  new Promise((resolve) => {
    const p = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (result: { stdout: string; stderr: string; code: number }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    // null exit code means the process was killed by signal (SIGKILL/SIGTERM);
    // treat that as failure (1), not success (0).
    p.on('close', (code) => settle({ stdout, stderr, code: code ?? 1 }));
    // ENOENT (e.g. gh not installed) emits 'error' without 'close'. EPERM and
    // some platform-specific errors can race 'close' and 'error'; the settled
    // flag ensures we resolve exactly once.
    p.on('error', (err) => settle({ stdout, stderr: err.message, code: 1 }));
  });

export async function promoteToIssue(input: PromoteInput): Promise<string> {
  const exec = input.exec ?? defaultExec;
  const args: string[] = ['issue', 'create', '--repo', input.repo, '--title', input.title, '--body', input.body];
  for (const label of input.labels) {
    args.push('--label', label);
  }
  const { stdout, stderr, code } = await exec('gh', args);
  if (code !== 0) {
    throw new Error(`gh issue create failed: ${stderr.trim()}`);
  }
  return stdout.trim();
}
