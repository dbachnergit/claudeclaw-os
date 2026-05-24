import { describe, it, expect, vi } from 'vitest';
import { worktreePath, branchName, createWorktree, removeWorktree } from '../worktree.js';
import type { Exec, ExecResult } from '../gh.js';

function stubExec(result: Partial<ExecResult> = {}): Exec & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ stdout: '', stderr: '', code: 0, ...result })) as unknown as Exec &
    ReturnType<typeof vi.fn>;
}

const ROOT = '/Users/x/Projects/ps-agent-worktrees';
const REPO = '/Users/x/Projects/PatientScribe';

describe('worktreePath / branchName', () => {
  it('builds an issue path under the configured worktree root', () => {
    expect(worktreePath(42, ROOT)).toBe('/Users/x/Projects/ps-agent-worktrees/issue-42');
  });

  it('builds the agent branch name', () => {
    expect(branchName(42)).toBe('agent/issue-42');
  });

  it('never resolves inside the Xcode-synced PatientScribe source tree', () => {
    const p = worktreePath(42, ROOT);
    expect(p.startsWith(ROOT)).toBe(true);
    expect(p.includes('/PatientScribe/PatientScribe')).toBe(false);
    expect(p.includes('/PatientScribe/issue-')).toBe(false);
  });
});

describe('createWorktree', () => {
  it('tears down any prior worktree, fetches, then adds a fresh branch off origin/main', async () => {
    const exec = stubExec();
    const result = await createWorktree({ issue: 42, repoDir: REPO, worktreeRoot: ROOT, exec });
    const path = '/Users/x/Projects/ps-agent-worktrees/issue-42';
    expect(result).toEqual({ path, branch: 'agent/issue-42' });

    const calls = exec.mock.calls.map((c) => c[1] as string[]);
    expect(calls).toEqual([
      ['-C', REPO, 'worktree', 'remove', '--force', path],
      ['-C', REPO, 'branch', '-D', 'agent/issue-42'],
      ['-C', REPO, 'fetch', 'origin'],
      ['-C', REPO, 'worktree', 'add', path, '-b', 'agent/issue-42', 'origin/main'],
    ]);
  });

  it('removes before it recreates (teardown precedes add)', async () => {
    const exec = stubExec();
    await createWorktree({ issue: 7, repoDir: REPO, worktreeRoot: ROOT, exec });
    const verbs = exec.mock.calls.map((c) => (c[1] as string[]).join(' '));
    const removeIdx = verbs.findIndex((v) => v.includes('worktree remove'));
    const addIdx = verbs.findIndex((v) => v.includes('worktree add'));
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(removeIdx);
  });

  it('throws if the fetch fails (cannot build on a stale tree)', async () => {
    // First two calls (teardown) succeed/ignored; the fetch returns non-zero.
    let n = 0;
    const exec = vi.fn(async () => {
      n += 1;
      return n === 3 ? { stdout: '', stderr: 'network down', code: 1 } : { stdout: '', stderr: '', code: 0 };
    }) as unknown as Exec;
    await expect(
      createWorktree({ issue: 9, repoDir: REPO, worktreeRoot: ROOT, exec }),
    ).rejects.toThrow(/fetch/i);
  });
});

describe('removeWorktree', () => {
  it('force-removes the worktree then deletes the branch', async () => {
    const exec = stubExec();
    await removeWorktree({ issue: 42, repoDir: REPO, worktreeRoot: ROOT, exec });
    const calls = exec.mock.calls.map((c) => c[1] as string[]);
    expect(calls).toEqual([
      ['-C', REPO, 'worktree', 'remove', '--force', '/Users/x/Projects/ps-agent-worktrees/issue-42'],
      ['-C', REPO, 'branch', '-D', 'agent/issue-42'],
    ]);
  });

  it('ignores "not found" errors (idempotent cleanup never throws)', async () => {
    const exec = stubExec({ code: 1, stderr: "fatal: '...' is not a working tree" });
    await expect(
      removeWorktree({ issue: 42, repoDir: REPO, worktreeRoot: ROOT, exec }),
    ).resolves.toBeUndefined();
  });
});
