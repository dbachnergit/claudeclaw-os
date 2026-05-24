import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  _initTestDatabase,
  _testGetDb,
  claimNextDevTask,
  getDevTaskById,
  setDevTaskSpecDrafted,
  setDevTaskStage,
  incrementDevTaskReviewRounds,
  addDevTaskCost,
  completeDevTask,
  resetStuckDevTasks,
  type DevTask,
} from '../../../src/db.js';
import { ExecTimeoutError } from '../gh.js';
import { runWorkflow, type DevAgentConfig } from '../workflow.js';

/**
 * Task 5.9 staged orchestrator. Uses the REAL dev_tasks helpers (in-memory db
 * via _initTestDatabase) so terminal persistence and restart behavior are
 * high-fidelity, while runAgent / runBuildVerify / openPr / giveUp / notify /
 * exec are stubbed (the parent-owned boundaries).
 */

const CONFIG: DevAgentConfig = {
  repo: 'owner/repo',
  iosRepoDir: '/repo',
  worktreeRoot: '/wt-root',
  scheme: 'PatientScribe',
  simDestination: 'platform=iOS Simulator,name=iPhone 16',
};

const BUDGET = { wallClockMs: 90 * 60 * 1000, maxStages: 20 };

function seed(row: Partial<DevTask> & { id: string; issue_number: number }): void {
  const full = {
    issue_title: 'Seeded',
    status: 'queued',
    stage: null,
    stage_checkpoint: 'queued',
    review_notes: null,
    spec_md: null,
    worktree_path: null,
    branch: null,
    pr_url: null,
    review_rounds: 0,
    cost_usd: 0,
    error: null,
    created_at: 1700000000,
    started_at: null,
    completed_at: null,
    ...row,
  };
  const cols = Object.keys(full);
  _testGetDb()
    .prepare(`INSERT INTO dev_tasks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => (full as Record<string, unknown>)[c]));
}

const db = {
  setDevTaskSpecDrafted,
  setDevTaskStage,
  incrementDevTaskReviewRounds,
  addDevTaskCost,
  completeDevTask,
};

const okBuild = { ok: true, compiled: true, newWarnings: [], testsPassed: true, reasons: [] as string[] };

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    db,
    runAgent: vi.fn(async () => ({ text: 'WORK DONE\nREVIEW_STATUS: CLEAN', usage: { totalCostUsd: 0.5 } })),
    exec: vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('diff')) {
        return { code: 0, stdout: 'PatientScribe/Tests/FooTests.swift\nPatientScribe/Foo.swift', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    }),
    runBuildVerify: vi.fn(async () => ({ ...okBuild })),
    openPr: vi.fn(async () => 'https://github.com/owner/repo/pull/7'),
    giveUp: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    ...overrides,
  };
}

/** Seed + claim a queued row so the workflow sees stage='diagnosing'. */
function claimQueued(issue: number, id = `d${issue}`): DevTask {
  seed({ id, issue_number: issue, status: 'queued', stage_checkpoint: 'queued' });
  return claimNextDevTask()!;
}

/** Seed + claim a spec_approved row so the workflow sees stage='implementing'. */
function claimApproved(issue: number, specMd: string, id = `d${issue}`): DevTask {
  seed({
    id,
    issue_number: issue,
    status: 'spec_approved',
    stage_checkpoint: 'spec_approved',
    spec_md: specMd,
    worktree_path: `/wt-root/issue-${issue}`,
    branch: `agent/issue-${issue}`,
  });
  return claimNextDevTask()!;
}

describe('runWorkflow', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  it('queued-origin claim diagnoses and parks at spec_drafted with the agent spec', async () => {
    const task = claimQueued(201);
    const deps = makeDeps();

    const result = await runWorkflow({ task, config: CONFIG, abortController: new AbortController(), budget: BUDGET, ...deps });

    expect(result).toBe('spec_drafted');
    const row = getDevTaskById('d201')!;
    expect(row.status).toBe('spec_drafted');
    expect(row.spec_md).toContain('WORK DONE');
    expect(row.cost_usd).toBeCloseTo(0.5);
    expect(deps.runAgent).toHaveBeenCalledTimes(1);
    expect(deps.openPr).not.toHaveBeenCalled();
  });

  it('spec_approved-origin claim reaches pr_open through review, verify, and the evidence gate', async () => {
    const task = claimApproved(202, 'Fix the crash.');
    const deps = makeDeps();

    const result = await runWorkflow({ task, config: CONFIG, abortController: new AbortController(), budget: BUDGET, ...deps });

    expect(result).toBe('pr_open');
    const row = getDevTaskById('d202')!;
    expect(row.status).toBe('pr_open');
    expect(row.pr_url).toBe('https://github.com/owner/repo/pull/7');
    expect(row.completed_at).not.toBeNull();
    expect(row.review_rounds).toBe(1); // converged on round 1
    expect(deps.runBuildVerify).toHaveBeenCalledTimes(1);
    expect(deps.openPr).toHaveBeenCalledTimes(1);
    // cost = implement (0.5) + one review (0.5)
    expect(row.cost_usd).toBeCloseTo(1.0);
  });

  it('passes the iOS repo + build config through to openPr', async () => {
    const task = claimApproved(203, 'Fix it.');
    const deps = makeDeps();
    await runWorkflow({ task, config: CONFIG, abortController: new AbortController(), budget: BUDGET, ...deps });

    expect(deps.openPr).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'owner/repo',
        repoDir: '/repo',
        issue: 203,
        branch: 'agent/issue-203',
        specMd: 'Fix it.',
      }),
    );
  });

  it('gives up as stuck (no PR) when build verification fails twice', async () => {
    const task = claimApproved(204, 'Fix it.');
    const deps = makeDeps({
      runBuildVerify: vi.fn(async () => ({ ok: false, compiled: false, newWarnings: [], testsPassed: false, reasons: ['compile failed'] })),
    });

    const result = await runWorkflow({ task, config: CONFIG, abortController: new AbortController(), budget: BUDGET, ...deps });

    expect(result).toBe('stuck');
    const row = getDevTaskById('d204')!;
    expect(row.status).toBe('stuck');
    expect(row.error).toBeTruthy();
    expect(row.completed_at).not.toBeNull();
    expect(deps.runBuildVerify).toHaveBeenCalledTimes(2); // two-strike
    expect(deps.openPr).not.toHaveBeenCalled();
    expect(deps.giveUp).toHaveBeenCalledTimes(1);
  });

  it('routes a hung build (ExecTimeoutError) to stuck via giveUp, never opening a PR', async () => {
    const task = claimApproved(205, 'Fix it.');
    const deps = makeDeps({
      runBuildVerify: vi.fn(async () => {
        throw new ExecTimeoutError('xcodebuild', 1000);
      }),
    });

    const result = await runWorkflow({ task, config: CONFIG, abortController: new AbortController(), budget: BUDGET, ...deps });

    expect(result).toBe('stuck');
    expect(getDevTaskById('d205')!.status).toBe('stuck');
    expect(deps.giveUp).toHaveBeenCalledTimes(1);
    expect(deps.openPr).not.toHaveBeenCalled();
  });

  it('gives up at adversarial-review round 3 when the agent never converges', async () => {
    const task = claimApproved(206, 'Fix it.');
    const deps = makeDeps({
      runAgent: vi.fn(async () => ({ text: 'still has problems\nREVIEW_STATUS: ISSUES', usage: { totalCostUsd: 0.1 } })),
    });

    const result = await runWorkflow({ task, config: CONFIG, abortController: new AbortController(), budget: BUDGET, ...deps });

    expect(result).toBe('stuck');
    const row = getDevTaskById('d206')!;
    expect(row.status).toBe('stuck');
    expect(row.review_rounds).toBe(3);
    expect(deps.openPr).not.toHaveBeenCalled();
    expect(deps.giveUp).toHaveBeenCalledTimes(1);
  });

  it('gives up as stuck when the stage budget is exceeded', async () => {
    const task = claimApproved(207, 'Fix it.');
    const deps = makeDeps();

    const result = await runWorkflow({
      task,
      config: CONFIG,
      abortController: new AbortController(),
      budget: { wallClockMs: 90 * 60 * 1000, maxStages: 1 },
      ...deps,
    });

    expect(result).toBe('stuck');
    expect(getDevTaskById('d207')!.status).toBe('stuck');
    expect(deps.openPr).not.toHaveBeenCalled();
  });

  it('gives up when the diff touches no test file and the spec has no opt-out', async () => {
    const task = claimApproved(208, 'Fix it.');
    const deps = makeDeps({
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('diff')) {
          return { code: 0, stdout: 'PatientScribe/Foo.swift', stderr: '' }; // no test file
        }
        return { code: 0, stdout: '', stderr: '' };
      }),
    });

    const result = await runWorkflow({ task, config: CONFIG, abortController: new AbortController(), budget: BUDGET, ...deps });

    expect(result).toBe('stuck');
    expect(getDevTaskById('d208')!.status).toBe('stuck');
    expect(deps.openPr).not.toHaveBeenCalled();
  });

  it('reaches pr_open with no test file when the spec marks the bug not-unit-testable', async () => {
    const task = claimApproved(209, 'This is a UI-only change, not-unit-testable.');
    const deps = makeDeps({
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('diff')) {
          return { code: 0, stdout: 'PatientScribe/Foo.swift', stderr: '' }; // no test file
        }
        return { code: 0, stdout: '', stderr: '' };
      }),
    });

    const result = await runWorkflow({ task, config: CONFIG, abortController: new AbortController(), budget: BUDGET, ...deps });

    expect(result).toBe('pr_open');
    expect(deps.openPr).toHaveBeenCalledTimes(1);
  });

  it('persists the terminal pr_open status before teardown so a restart does not re-run it', async () => {
    const task = claimApproved(210, 'Fix it.');
    const deps = makeDeps();
    await runWorkflow({ task, config: CONFIG, abortController: new AbortController(), budget: BUDGET, ...deps });

    expect(getDevTaskById('d210')!.status).toBe('pr_open');
    // A simulated restart-recovery must NOT touch the terminal row.
    const reset = resetStuckDevTasks();
    expect(reset).toBe(0);
    expect(getDevTaskById('d210')!.status).toBe('pr_open');
  });

  it('threads abortController.signal into the parent shell-outs', async () => {
    const task = claimApproved(211, 'Fix it.');
    const ac = new AbortController();
    let buildSignal: AbortSignal | undefined;
    let execSignal: AbortSignal | undefined;
    const deps = makeDeps({
      runBuildVerify: vi.fn(async (a: { signal?: AbortSignal }) => {
        buildSignal = a.signal;
        return { ...okBuild };
      }),
      exec: vi.fn(async (cmd: string, args: string[], opts?: { signal?: AbortSignal }) => {
        execSignal = opts?.signal;
        if (cmd === 'git' && args.includes('diff')) {
          return { code: 0, stdout: 'PatientScribe/Tests/FooTests.swift', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      }),
    });

    await runWorkflow({ task, config: CONFIG, abortController: ac, budget: BUDGET, ...deps });

    expect(buildSignal).toBe(ac.signal);
    expect(execSignal).toBe(ac.signal);
    ac.abort();
    expect(buildSignal?.aborted).toBe(true);
  });
});
