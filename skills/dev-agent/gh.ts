// skills/dev-agent/gh.ts
//
// The single stubbable boundary for every GitHub + git shell-out the dev
// agent's PARENT process makes. The subprocess never reaches here: all
// remote-mutating calls (label swaps, comments, branch push) live in
// parent-owned code so the privilege boundary holds even if the LLM tries to
// push or open a PR itself.
//
// `runExec` extends the proven github-issues spawn wrapper with AbortSignal +
// per-command timeout support, so a hung xcodebuild/git/gh aborts to a
// give-up instead of wedging the single-task `devBusy` loop forever (the
// wall-clock budget alone cannot interrupt a blocking parent shell-out).

import { spawn } from 'child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  cwd?: string;
}

export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

/** Thrown when a command exceeds its `timeoutMs`; the child is killed. */
export class ExecTimeoutError extends Error {
  constructor(
    public readonly command: string,
    public readonly timeoutMs: number,
  ) {
    super(`exec timed out after ${timeoutMs}ms: ${command}`);
    this.name = 'ExecTimeoutError';
  }
}

/** Thrown when the provided AbortSignal fires (or was already aborted). */
export class ExecAbortedError extends Error {
  constructor(public readonly command: string) {
    super(`exec aborted: ${command}`);
    this.name = 'ExecAbortedError';
  }
}

// Grace period between SIGTERM and the SIGKILL escalation.
const KILL_GRACE_MS = 2000;

export const runExec: Exec = (cmd, args, opts = {}) =>
  new Promise<ExecResult>((resolve, reject) => {
    const { signal, timeoutMs, cwd } = opts;

    // Already-aborted signal: reject promptly, never spawn.
    if (signal?.aborted) {
      reject(new ExecAbortedError(cmd));
      return;
    }

    const child = spawn(cmd, args, cwd ? { cwd } : {});
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => finishKill(new ExecAbortedError(cmd));

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const settleResolve = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };
    const settleReject = (e: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    };

    // Escalating kill: SIGTERM now, SIGKILL after a grace period. The kill
    // timer is unref'd so it never keeps the event loop (or a test) alive.
    const finishKill = (err: Error) => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, KILL_GRACE_MS);
      if (typeof killTimer.unref === 'function') killTimer.unref();
      settleReject(err);
    };

    if (signal) signal.addEventListener('abort', onAbort);
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => finishKill(new ExecTimeoutError(cmd, timeoutMs)), timeoutMs);
    }

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    // null exit code means killed by signal; treat as failure (1), matching
    // the github-issues wrapper. A settled promise (timeout/abort) wins.
    child.on('close', (code) => settleResolve({ stdout, stderr, code: code ?? 1 }));
    // ENOENT (e.g. gh/git not installed) emits 'error' without 'close'.
    child.on('error', (err) => settleResolve({ stdout, stderr: err.message, code: 1 }));
  });

// ── Typed helpers (parent-owned GitHub/git mutations) ──────────────────────

export interface QueuedIssue {
  number: number;
  title: string;
}

/**
 * List open issues carrying ALL THREE trigger labels. Server-side label
 * filtering means every returned issue is a valid nomination.
 */
export async function listQueuedIssues(repo: string, exec: Exec): Promise<QueuedIssue[]> {
  const { stdout, stderr, code } = await exec('gh', [
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--label',
    'agent:queue',
    '--label',
    'type:bug',
    '--label',
    'priority:p3',
    '--json',
    'number,title',
    '--limit',
    '100',
  ]);
  if (code !== 0) throw new Error(`gh issue list failed: ${stderr.trim()}`);
  const raw = JSON.parse(stdout || '[]') as Array<{ number: number; title: string }>;
  return raw.map((i) => ({ number: i.number, title: i.title }));
}

/** Remove and/or add labels on an issue in a single `gh issue edit`. */
export async function swapLabel(
  repo: string,
  issue: number,
  remove: string[],
  add: string[],
  exec: Exec,
): Promise<void> {
  const args = ['issue', 'edit', String(issue), '--repo', repo];
  for (const label of remove) args.push('--remove-label', label);
  for (const label of add) args.push('--add-label', label);
  const { stderr, code } = await exec('gh', args);
  if (code !== 0) throw new Error(`gh issue edit failed: ${stderr.trim()}`);
}

/** Post a comment body to an issue. */
export async function commentOnIssue(
  repo: string,
  issue: number,
  body: string,
  exec: Exec,
): Promise<void> {
  const { stderr, code } = await exec('gh', [
    'issue',
    'comment',
    String(issue),
    '--repo',
    repo,
    '--body',
    body,
  ]);
  if (code !== 0) throw new Error(`gh issue comment failed: ${stderr.trim()}`);
}

/**
 * Push the agent branch. Hard guard: refuses `main` (the never-push-to-main
 * invariant is enforced in non-LLM code, not just prompt discipline).
 */
export async function pushBranch(repoDir: string, branch: string, exec: Exec): Promise<void> {
  if (branch === 'main') {
    throw new Error('pushBranch refused: the dev agent must never push to main');
  }
  const { stderr, code } = await exec('git', ['-C', repoDir, 'push', 'origin', branch]);
  if (code !== 0) throw new Error(`git push failed: ${stderr.trim()}`);
}
