import { describe, it, expect, vi } from 'vitest';
import { openPr } from '../pr.js';
import type { Exec } from '../gh.js';

const REPO = 'dbachnergit/PatientScribe';
const REPODIR = '/Users/x/Projects/PatientScribe';

/** Smart stub: scripts gh pr list / pr create; defaults git ops to success. */
function makeExec(
  opts: { existingPrUrls?: string[]; createFails?: boolean; createUrl?: string; deleteFails?: boolean } = {},
): Exec & ReturnType<typeof vi.fn> {
  return vi.fn(async (cmd: string, args: string[]) => {
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      return {
        stdout: JSON.stringify((opts.existingPrUrls ?? []).map((url) => ({ url }))),
        stderr: '',
        code: 0,
      };
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
      return opts.createFails
        ? { stdout: '', stderr: 'create failed', code: 1 }
        : { stdout: `${opts.createUrl ?? 'https://github.com/o/r/pull/7'}\n`, stderr: '', code: 0 };
    }
    if (cmd === 'git' && args.includes('--delete')) {
      return opts.deleteFails
        ? { stdout: '', stderr: 'remote ref does not exist', code: 1 }
        : { stdout: '', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  }) as unknown as Exec & ReturnType<typeof vi.fn>;
}

const findCall = (exec: ReturnType<typeof vi.fn>, pred: (cmd: string, args: string[]) => boolean) =>
  exec.mock.calls.find((c) => pred(c[0] as string, c[1] as string[]));

const createArgs = (exec: ReturnType<typeof vi.fn>) =>
  findCall(exec, (cmd, args) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'create')?.[1] as
    | string[]
    | undefined;

describe('openPr', () => {
  it('opens a DRAFT PR against main from the agent branch and returns the trimmed URL', async () => {
    const exec = makeExec({ createUrl: 'https://github.com/dbachnergit/PatientScribe/pull/55' });
    const url = await openPr({ repo: REPO, repoDir: REPODIR, issue: 42, branch: 'agent/issue-42', specMd: 'Fix it', exec });
    expect(url).toBe('https://github.com/dbachnergit/PatientScribe/pull/55');
    const args = createArgs(exec)!;
    expect(args).toContain('--draft');
    expect(args.slice(args.indexOf('--base'), args.indexOf('--base') + 2)).toEqual(['--base', 'main']);
    expect(args.slice(args.indexOf('--head'), args.indexOf('--head') + 2)).toEqual(['--head', 'agent/issue-42']);
    expect(args.slice(args.indexOf('--repo'), args.indexOf('--repo') + 2)).toEqual(['--repo', REPO]);
  });

  it('refuses a main head and performs no exec calls', async () => {
    const exec = makeExec();
    await expect(
      openPr({ repo: REPO, repoDir: REPODIR, issue: 1, branch: 'main', specMd: 's', exec }),
    ).rejects.toThrow(/main/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('deletes any stale remote branch BEFORE pushing fresh (recovery-safe ordering)', async () => {
    const exec = makeExec();
    await openPr({ repo: REPO, repoDir: REPODIR, issue: 42, branch: 'agent/issue-42', specMd: 's', exec });
    const verbs = exec.mock.calls.map((c) => `${c[0]} ${(c[1] as string[]).join(' ')}`);
    const deleteIdx = verbs.findIndex((v) => v.includes('push origin --delete'));
    const pushIdx = verbs.findIndex((v) => /push origin agent\/issue-42$/.test(v));
    const createIdx = verbs.findIndex((v) => v.includes('pr create'));
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(pushIdx).toBeGreaterThan(deleteIdx);
    expect(createIdx).toBeGreaterThan(pushIdx);
  });

  it('is idempotent: when an open PR already exists, returns it without pushing or creating', async () => {
    const exec = makeExec({ existingPrUrls: ['https://github.com/o/r/pull/9'] });
    const url = await openPr({ repo: REPO, repoDir: REPODIR, issue: 42, branch: 'agent/issue-42', specMd: 's', exec });
    expect(url).toBe('https://github.com/o/r/pull/9');
    expect(findCall(exec, (cmd, args) => cmd === 'gh' && args[1] === 'create')).toBeUndefined();
    expect(findCall(exec, (cmd, args) => cmd === 'git' && args.includes('push') && !args.includes('--delete'))).toBeUndefined();
  });

  it('throws when gh pr create fails (so a recovered run can retry cleanly)', async () => {
    const exec = makeExec({ createFails: true });
    await expect(
      openPr({ repo: REPO, repoDir: REPODIR, issue: 42, branch: 'agent/issue-42', specMd: 's', exec }),
    ).rejects.toThrow(/create/i);
  });

  it('proceeds even when the stale-branch delete fails (not-found is ignored)', async () => {
    const exec = makeExec({ deleteFails: true, createUrl: 'https://github.com/o/r/pull/3' });
    const url = await openPr({ repo: REPO, repoDir: REPODIR, issue: 42, branch: 'agent/issue-42', specMd: 's', exec });
    expect(url).toBe('https://github.com/o/r/pull/3');
  });

  it('strips agent:queue and status:in-flight on pr_open (terminal label cleanup)', async () => {
    const exec = makeExec();
    await openPr({ repo: REPO, repoDir: REPODIR, issue: 42, branch: 'agent/issue-42', specMd: 's', exec });
    const editArgs = findCall(exec, (cmd, args) => cmd === 'gh' && args[0] === 'issue' && args[1] === 'edit')?.[1] as string[];
    expect(editArgs).toBeDefined();
    expect(editArgs.filter((_, i) => editArgs[i - 1] === '--remove-label')).toEqual(
      expect.arrayContaining(['agent:queue', 'status:in-flight']),
    );
    expect(editArgs).not.toContain('--add-label');
  });

  it('redacts PHI and secrets out of the PR body before posting', async () => {
    const exec = makeExec();
    const dirty = 'Patient has diabetes. Leaked sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF in the spec.';
    await openPr({ repo: REPO, repoDir: REPODIR, issue: 42, branch: 'agent/issue-42', specMd: dirty, exec });
    const args = createArgs(exec)!;
    const body = args[args.indexOf('--body') + 1];
    expect(body).toContain('Fixes #42');
    expect(body.toLowerCase()).not.toContain('diabetes');
    expect(body).not.toContain('sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF');
    expect(body).toContain('[redacted]');
    expect(body).toContain('[REDACTED]');
  });
});
