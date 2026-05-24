import { describe, it, expect, vi } from 'vitest';
import { realpathSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runExec,
  ExecTimeoutError,
  ExecAbortedError,
  listQueuedIssues,
  swapLabel,
  commentOnIssue,
  pushBranch,
  getIssueLabels,
  type Exec,
  type ExecResult,
} from '../gh.js';

const NODE = process.execPath;

/** A vi.fn-backed exec stub returning a fixed result. */
function stubExec(result: Partial<ExecResult> = {}): Exec & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ stdout: '', stderr: '', code: 0, ...result })) as unknown as Exec &
    ReturnType<typeof vi.fn>;
}

describe('runExec', () => {
  it('resolves with stdout, stderr, and exit code for a normal command', async () => {
    const r = await runExec(NODE, ['-e', "process.stdout.write('hi'); process.stderr.write('e')"]);
    expect(r.stdout).toBe('hi');
    expect(r.stderr).toBe('e');
    expect(r.code).toBe(0);
  });

  it('surfaces a non-zero exit code without throwing', async () => {
    const r = await runExec(NODE, ['-e', 'process.exit(3)']);
    expect(r.code).toBe(3);
  });

  it('runs in the provided cwd', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gh-cwd-')));
    const r = await runExec(
      NODE,
      ['-e', 'process.stdout.write(require("fs").realpathSync(process.cwd()))'],
      { cwd: dir },
    );
    expect(r.stdout).toBe(dir);
  });

  it('kills a hung child and rejects with ExecTimeoutError once timeoutMs elapses', async () => {
    await expect(
      runExec(NODE, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(ExecTimeoutError);
  });

  it('rejects promptly with ExecAbortedError when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(runExec(NODE, ['-e', '0'], { signal: ac.signal })).rejects.toBeInstanceOf(
      ExecAbortedError,
    );
  });

  it('kills a running child and rejects with ExecAbortedError when aborted mid-flight', async () => {
    const ac = new AbortController();
    const p = runExec(NODE, ['-e', 'setInterval(() => {}, 1000)'], { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toBeInstanceOf(ExecAbortedError);
  });
});

describe('listQueuedIssues', () => {
  it('queries open issues carrying all three trigger labels and parses the rows', async () => {
    const exec = stubExec({
      stdout: JSON.stringify([
        { number: 12, title: 'Crash on save' },
        { number: 13, title: 'Wrong date' },
      ]),
    });
    const issues = await listQueuedIssues('owner/repo', exec);
    expect(exec).toHaveBeenCalledWith('gh', [
      'issue',
      'list',
      '--repo',
      'owner/repo',
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
    expect(issues).toEqual([
      { number: 12, title: 'Crash on save' },
      { number: 13, title: 'Wrong date' },
    ]);
  });

  it('throws with stderr when gh exits non-zero', async () => {
    const exec = stubExec({ code: 1, stderr: 'gh: not authenticated' });
    await expect(listQueuedIssues('owner/repo', exec)).rejects.toThrow(/not authenticated/);
  });
});

describe('swapLabel', () => {
  it('builds a gh issue edit with remove and add label flags', async () => {
    const exec = stubExec();
    await swapLabel('owner/repo', 42, ['agent:queue', 'status:in-flight'], ['agent:stuck'], exec);
    expect(exec).toHaveBeenCalledWith('gh', [
      'issue',
      'edit',
      '42',
      '--repo',
      'owner/repo',
      '--remove-label',
      'agent:queue',
      '--remove-label',
      'status:in-flight',
      '--add-label',
      'agent:stuck',
    ]);
  });

  it('throws with stderr when gh exits non-zero', async () => {
    const exec = stubExec({ code: 1, stderr: 'label not found' });
    await expect(swapLabel('owner/repo', 42, ['x'], [], exec)).rejects.toThrow(/label not found/);
  });
});

describe('commentOnIssue', () => {
  it('posts a comment body to the issue', async () => {
    const exec = stubExec();
    await commentOnIssue('owner/repo', 7, 'Diagnosis: foo', exec);
    expect(exec).toHaveBeenCalledWith('gh', [
      'issue',
      'comment',
      '7',
      '--repo',
      'owner/repo',
      '--body',
      'Diagnosis: foo',
    ]);
  });

  it('throws with stderr when gh exits non-zero', async () => {
    const exec = stubExec({ code: 1, stderr: 'issue closed' });
    await expect(commentOnIssue('owner/repo', 7, 'x', exec)).rejects.toThrow(/issue closed/);
  });
});

describe('pushBranch', () => {
  it('pushes the agent branch from the repo dir', async () => {
    const exec = stubExec();
    await pushBranch('/repo/dir', 'agent/issue-42', exec);
    expect(exec).toHaveBeenCalledWith('git', [
      '-C',
      '/repo/dir',
      'push',
      'origin',
      'agent/issue-42',
    ]);
  });

  it('refuses to push the main branch (hard guard) without calling exec', async () => {
    const exec = stubExec();
    await expect(pushBranch('/repo/dir', 'main', exec)).rejects.toThrow(/main/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('throws with stderr when the push exits non-zero', async () => {
    const exec = stubExec({ code: 1, stderr: 'rejected: non-fast-forward' });
    await expect(pushBranch('/repo/dir', 'agent/issue-9', exec)).rejects.toThrow(
      /non-fast-forward/,
    );
  });
});

describe('getIssueLabels', () => {
  it('returns the live label names for an issue', async () => {
    const exec = stubExec({
      code: 0,
      stdout: JSON.stringify({ labels: [{ name: 'agent:queue' }, { name: 'type:bug' }, { name: 'priority:p3' }] }),
    });
    const labels = await getIssueLabels('owner/repo', 42, exec);
    expect(labels).toEqual(['agent:queue', 'type:bug', 'priority:p3']);
    expect(exec).toHaveBeenCalledWith('gh', [
      'issue',
      'view',
      '42',
      '--repo',
      'owner/repo',
      '--json',
      'labels',
    ]);
  });

  it('returns an empty array when the issue has no labels', async () => {
    const exec = stubExec({ code: 0, stdout: JSON.stringify({ labels: [] }) });
    expect(await getIssueLabels('owner/repo', 7, exec)).toEqual([]);
  });

  it('throws with stderr on a non-zero exit', async () => {
    const exec = stubExec({ code: 1, stderr: 'could not resolve issue' });
    await expect(getIssueLabels('owner/repo', 7, exec)).rejects.toThrow(/could not resolve issue/);
  });
});
