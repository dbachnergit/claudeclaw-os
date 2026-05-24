// skills/dev-agent/worktree.ts
//
// Per-issue git worktree manager. Each task works in its own worktree rooted
// at <worktreeRoot>/issue-<N>, a sibling fully OUTSIDE the Xcode-synced
// PatientScribe/PatientScribe/ tree (respects the 2026-04-15 "Multiple
// commands produce" incident). createWorktree always tears down any prior
// worktree first, so a crash-recovered task is rebuilt from a clean
// origin/main (the recovery invariant: never resume on a half-built tree).

import type { Exec } from './gh.js';

/** Absolute worktree path for an issue under the configured root. */
export function worktreePath(issue: number, worktreeRoot: string): string {
  return `${worktreeRoot}/issue-${issue}`;
}

/** The fixed agent branch name for an issue. */
export function branchName(issue: number): string {
  return `agent/issue-${issue}`;
}

export interface WorktreeArgs {
  issue: number;
  repoDir: string;
  worktreeRoot: string;
  exec: Exec;
}

/**
 * Force-remove the worktree and delete its branch. Idempotent: a missing
 * worktree/branch is ignored (best-effort cleanup, never throws), so it is
 * safe to call unconditionally before a create and from the terminal sweep.
 */
export async function removeWorktree({
  issue,
  repoDir,
  worktreeRoot,
  exec,
}: WorktreeArgs): Promise<void> {
  const path = worktreePath(issue, worktreeRoot);
  const branch = branchName(issue);
  // Ignore non-zero exits: "not a working tree" / "branch not found" mean
  // there was nothing to clean, which is the desired end state.
  await exec('git', ['-C', repoDir, 'worktree', 'remove', '--force', path]);
  await exec('git', ['-C', repoDir, 'branch', '-D', branch]);
}

/**
 * Build a fresh worktree: idempotent teardown → fetch origin → add a new
 * agent branch off origin/main. Throws if the fetch or add fails (cannot
 * proceed on a stale or conflicting tree). Returns the path + branch so the
 * caller can persist them immediately (setDevTaskWorktree).
 */
export async function createWorktree({
  issue,
  repoDir,
  worktreeRoot,
  exec,
}: WorktreeArgs): Promise<{ path: string; branch: string }> {
  const path = worktreePath(issue, worktreeRoot);
  const branch = branchName(issue);

  // Always rebuild fresh: clean any residue from a prior/crashed attempt.
  await removeWorktree({ issue, repoDir, worktreeRoot, exec });

  const fetch = await exec('git', ['-C', repoDir, 'fetch', 'origin']);
  if (fetch.code !== 0) throw new Error(`git fetch failed: ${fetch.stderr.trim()}`);

  const add = await exec('git', [
    '-C',
    repoDir,
    'worktree',
    'add',
    path,
    '-b',
    branch,
    'origin/main',
  ]);
  if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim()}`);

  return { path, branch };
}
