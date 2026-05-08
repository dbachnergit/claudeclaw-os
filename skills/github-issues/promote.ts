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
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    // ENOENT (e.g. gh not installed) emits 'error' without 'close'. Convert
    // that into a non-zero result so promoteToIssue throws instead of hanging.
    p.on('error', (err) => resolve({ stdout, stderr: err.message, code: 1 }));
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
