import { describe, it, expect, vi } from 'vitest';
import { giveUp } from '../failure.js';
import type { Exec } from '../gh.js';

const REPO = 'dbachnergit/PatientScribe';

function okExec(): Exec & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })) as unknown as Exec &
    ReturnType<typeof vi.fn>;
}

const findCall = (exec: ReturnType<typeof vi.fn>, pred: (cmd: string, args: string[]) => boolean) =>
  exec.mock.calls.find((c) => pred(c[0] as string, c[1] as string[]));

const commentBody = (exec: ReturnType<typeof vi.fn>): string => {
  const args = findCall(exec, (cmd, a) => cmd === 'gh' && a[0] === 'issue' && a[1] === 'comment')?.[1] as string[];
  return args[args.indexOf('--body') + 1];
};

describe('giveUp', () => {
  it('posts a structured comment with the four diagnostic sections', async () => {
    const exec = okExec();
    await giveUp({
      repo: REPO,
      issue: 42,
      reason: 'three adversarial rounds without convergence',
      diagnosis: 'The crash is in the save path; root cause unclear.',
      attempted: 'Added a nil guard and a regression test.',
      stuckAt: 'adversarial_review',
      exec,
      notify: vi.fn(),
    });
    const body = commentBody(exec);
    expect(body).toMatch(/attempted/i);
    expect(body).toMatch(/diagnosis/i);
    expect(body).toMatch(/stuck/i);
    expect(body).toMatch(/reason/i);
    expect(body).toContain('three adversarial rounds without convergence');
  });

  it('strips status:in-flight and agent:queue and adds agent:stuck', async () => {
    const exec = okExec();
    await giveUp({ repo: REPO, issue: 42, reason: 'r', diagnosis: 'd', exec, notify: vi.fn() });
    const editArgs = findCall(exec, (cmd, a) => cmd === 'gh' && a[0] === 'issue' && a[1] === 'edit')?.[1] as string[];
    expect(editArgs).toBeDefined();
    const removed = editArgs.filter((_, i) => editArgs[i - 1] === '--remove-label');
    const added = editArgs.filter((_, i) => editArgs[i - 1] === '--add-label');
    expect(removed).toEqual(expect.arrayContaining(['status:in-flight', 'agent:queue']));
    expect(added).toEqual(['agent:stuck']);
  });

  it('notifies the operator with the issue number', async () => {
    const exec = okExec();
    const notify = vi.fn();
    await giveUp({ repo: REPO, issue: 42, reason: 'budget', diagnosis: 'd', exec, notify });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][0])).toContain('42');
  });

  it('redacts PHI and secrets out of the diagnosis before posting', async () => {
    const exec = okExec();
    await giveUp({
      repo: REPO,
      issue: 42,
      reason: 'r',
      diagnosis: 'Patient diabetes context; token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 leaked.',
      exec,
      notify: vi.fn(),
    });
    const body = commentBody(exec);
    expect(body.toLowerCase()).not.toContain('diabetes');
    expect(body).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    expect(body).toContain('[redacted]');
    expect(body).toContain('[REDACTED]');
  });

  it('is best-effort: a failing comment does not prevent the label swap or notify', async () => {
    // gh issue comment fails (non-zero); edit + notify must still happen.
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[1] === 'comment') return { stdout: '', stderr: 'closed', code: 1 };
      return { stdout: '', stderr: '', code: 0 };
    }) as unknown as Exec & ReturnType<typeof vi.fn>;
    const notify = vi.fn();
    await expect(
      giveUp({ repo: REPO, issue: 42, reason: 'r', diagnosis: 'd', exec, notify }),
    ).resolves.toBeUndefined();
    expect(findCall(exec, (cmd, a) => cmd === 'gh' && a[1] === 'edit')).toBeDefined();
    expect(notify).toHaveBeenCalled();
  });
});
