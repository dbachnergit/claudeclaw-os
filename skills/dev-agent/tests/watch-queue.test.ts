import { describe, it, expect, vi, beforeEach } from 'vitest';
import { watchQueue } from '../watch-queue.js';
import {
  _initTestDatabase,
  getDevTaskByIssue,
  createDevTask,
  completeDevTask,
  type DevTask,
} from '../../../src/db.js';
import type { Exec } from '../gh.js';

const REPO = 'dbachnergit/PatientScribe';

// The watcher receives its db helpers by injection; tests wire the REAL
// singleton-backed helpers (high-fidelity) against the in-memory db.
const realDb = { getDevTaskByIssue, createDevTask };

/** Stub exec: returns the configured issue list for `gh issue list`. */
function makeExec(issues: Array<{ number: number; title: string }>): Exec & ReturnType<typeof vi.fn> {
  return vi.fn(async (cmd: string, args: string[]) => {
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      return { stdout: JSON.stringify(issues), stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  }) as unknown as Exec & ReturnType<typeof vi.fn>;
}

const editCalls = (exec: ReturnType<typeof vi.fn>) =>
  exec.mock.calls.filter((c) => c[0] === 'gh' && (c[1] as string[])[0] === 'issue' && (c[1] as string[])[1] === 'edit');

describe('watchQueue', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('queues fresh nominations, leaving agent:queue and NOT adding status:in-flight', async () => {
    const exec = makeExec([
      { number: 101, title: 'Crash on save' },
      { number: 102, title: 'Wrong date' },
    ]);
    const result = await watchQueue({ repo: REPO, exec, db: realDb });

    expect(result.queued).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
    expect(getDevTaskByIssue(101)?.status).toBe('queued');
    expect(getDevTaskByIssue(102)?.status).toBe('queued');
    // No label mutation at queue time (in-flight is added only at claim).
    expect(editCalls(exec)).toHaveLength(0);
  });

  it('is idempotent: a second tick over the same still-queued rows queues nothing and touches no labels', async () => {
    const issues = [{ number: 101, title: 'A' }, { number: 102, title: 'B' }];
    await watchQueue({ repo: REPO, exec: makeExec(issues), db: realDb });

    const exec2 = makeExec(issues);
    const result = await watchQueue({ repo: REPO, exec: exec2, db: realDb });

    expect(result.queued).toBe(0);
    expect(result.skipped).toBe(2);
    expect(editCalls(exec2)).toHaveLength(0); // non-terminal rows: labels untouched
  });

  it('self-heals a stray nomination on a terminal row: strips both labels, no insert, no UNIQUE violation', async () => {
    createDevTask('done-303', 303, 'C');
    completeDevTask('done-303', 'pr_open', 'https://github.com/o/r/pull/1');

    const exec = makeExec([{ number: 303, title: 'C' }]);
    const result = await watchQueue({ repo: REPO, exec, db: realDb });

    expect(result.queued).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toEqual([]);
    // The terminal row is untouched (still pr_open) and not duplicated.
    const row = getDevTaskByIssue(303) as DevTask;
    expect(row.status).toBe('pr_open');
    // The stray agent:queue (and status:in-flight) are stripped to stop the loop.
    const edits = editCalls(exec);
    expect(edits).toHaveLength(1);
    const args = edits[0][1] as string[];
    const removed = args.filter((_, i) => args[i - 1] === '--remove-label');
    expect(removed).toEqual(expect.arrayContaining(['agent:queue', 'status:in-flight']));
    expect(args).not.toContain('--add-label');
  });

  it('records a per-issue error without aborting the whole tick', async () => {
    // gh issue edit fails on the terminal self-heal; the run still returns.
    createDevTask('done-404', 404, 'D');
    completeDevTask('done-404', 'stuck', null, 'gave up');
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { stdout: JSON.stringify([{ number: 404, title: 'D' }]), stderr: '', code: 0 };
      }
      if (cmd === 'gh' && args[1] === 'edit') return { stdout: '', stderr: 'boom', code: 1 };
      return { stdout: '', stderr: '', code: 0 };
    }) as unknown as Exec & ReturnType<typeof vi.fn>;

    const result = await watchQueue({ repo: REPO, exec, db: realDb });
    expect(result.errors.length).toBe(1);
  });
});
