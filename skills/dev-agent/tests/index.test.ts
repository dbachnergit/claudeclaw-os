import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  _initTestDatabase,
  createDevTask,
  getDevTaskByIssue,
  getDevTaskById,
  claimNextDevTask,
  setDevTaskSpecDrafted,
  setDevTaskStage,
  incrementDevTaskReviewRounds,
  addDevTaskCost,
  completeDevTask,
  setDevTaskWorktree,
  getTerminalDevTasksWithWorktree,
  clearDevTaskWorktree,
  type DevTask,
} from '../../../src/db.js';
import { _testGetDb } from '../../../src/db.js';
import { processDevQueue, makeDevRunAgent, type ProcessorDb } from '../index.js';
import type { WorkflowOutcome, RunWorkflowArgs } from '../workflow.js';

/**
 * Task 5.10 serialized queue processor. Real dev_tasks helpers (in-memory db)
 * + real makeDevRunAgent (loads the real agents/dev policy files) so the full
 * RunAgentOptions wiring is proven, while watchQueue / createWorktree /
 * removeWorktree / runWorkflow and the gh exec are stubbed at the boundary.
 */

const CONFIG = {
  repo: 'owner/repo',
  iosRepoDir: '/ios-repo',
  worktreeRoot: '/wt-root',
  scheme: 'PatientScribe',
  simDestination: 'platform=iOS Simulator,name=iPhone 16',
};

const realDb: ProcessorDb = {
  getDevTaskByIssue,
  createDevTask,
  claimNextDevTask,
  completeDevTask,
  setDevTaskWorktree,
  getTerminalDevTasksWithWorktree,
  clearDevTaskWorktree,
  setDevTaskSpecDrafted,
  setDevTaskStage,
  incrementDevTaskReviewRounds,
  addDevTaskCost,
};

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

/** Build the standard stubbed dependency set with per-test overrides. */
function makeOverrides(over: Record<string, unknown> = {}) {
  return {
    watchQueue: vi.fn(async () => ({ queued: 0, skipped: 0, errors: [] as string[] })),
    createWorktree: vi.fn(async (a: { issue: number }) => ({ path: `/wt-root/issue-${a.issue}`, branch: `agent/issue-${a.issue}` })),
    removeWorktree: vi.fn(async () => {}),
    runWorkflow: vi.fn(async (_args: RunWorkflowArgs): Promise<WorkflowOutcome> => 'spec_drafted'),
    budget: { wallClockMs: 1000, maxStages: 5 },
    ...over,
  };
}

/** exec stub: gh issue view returns labels; everything else is a no-op success. */
function makeExec(labels: string[] = ['agent:queue', 'type:bug', 'priority:p3']) {
  return vi.fn(async (cmd: string, args: string[]) => {
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') {
      return { code: 0, stdout: JSON.stringify({ labels: labels.map((name) => ({ name })) }), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
}

const baseRunAgent = vi.fn(async () => ({ text: 'agent output', usage: { totalCostUsd: 0 } }));
const notify = vi.fn(async () => {});

describe('processDevQueue', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  it('claims a queued task, marks it in-flight (keeping agent:queue), and runs the workflow', async () => {
    createDevTask('d1', 301, 'Crash');
    const exec = makeExec();
    const overrides = makeOverrides();

    const result = await processDevQueue({ db: realDb, config: CONFIG, runAgent: baseRunAgent, exec, notify, overrides });

    expect(result.processed).toBe(1);
    expect(overrides.runWorkflow).toHaveBeenCalledTimes(1);
    // status:in-flight ADDED alongside agent:queue (agent:queue not removed).
    const inflightEdit = exec.mock.calls.find(
      (c) => c[0] === 'gh' && c[1][0] === 'issue' && c[1][1] === 'edit',
    );
    expect(inflightEdit?.[1]).toContain('--add-label');
    expect(inflightEdit?.[1]).toContain('status:in-flight');
    expect(inflightEdit?.[1]).not.toContain('--remove-label');
  });

  it('wraps the injected base runAgent with the full RunAgentOptions via makeDevRunAgent', async () => {
    createDevTask('d2', 302, 'Crash');
    const exec = makeExec();
    let capturedRunner: RunWorkflowArgs['runAgent'] | undefined;
    const overrides = makeOverrides({
      runWorkflow: vi.fn(async (args: RunWorkflowArgs): Promise<WorkflowOutcome> => {
        capturedRunner = args.runAgent;
        return 'spec_drafted';
      }),
    });

    await processDevQueue({ db: realDb, config: CONFIG, runAgent: baseRunAgent, exec, notify, overrides });

    const ac = new AbortController();
    await capturedRunner!('do the thing', ac);
    expect(baseRunAgent).toHaveBeenCalledWith(
      'do the thing',
      undefined,
      expect.any(Function),
      undefined,
      'claude-opus-4-7',
      ac,
      undefined,
      undefined,
      expect.objectContaining({
        cwd: '/wt-root/issue-302',
        appendInstructions: expect.stringContaining('Dev Agent'),
        mcpAllowlist: ['XcodeBuildMCP'],
        mcpToolAllowlist: expect.arrayContaining(['mcp__XcodeBuildMCP__build_sim']),
        nativeToolPolicy: expect.objectContaining({
          disallowedTools: expect.arrayContaining(['WebFetch', 'WebSearch']),
          network: expect.objectContaining({ allowManagedDomainsOnly: true }),
        }),
        fsPolicy: expect.objectContaining({ allowedRoots: ['/wt-root/issue-302'] }),
      }),
    );
  });

  it('threads config into the worktree, runWorkflow, and persists the worktree before work runs', async () => {
    createDevTask('d3', 303, 'Crash');
    const exec = makeExec();
    let worktreeAtRun: string | null = null;
    const overrides = makeOverrides({
      runWorkflow: vi.fn(async (args: RunWorkflowArgs): Promise<WorkflowOutcome> => {
        worktreeAtRun = getDevTaskById('d3')!.worktree_path; // persisted BEFORE runWorkflow
        expect(args.config.scheme).toBe('PatientScribe');
        expect(args.config.iosRepoDir).toBe('/ios-repo');
        return 'spec_drafted';
      }),
    });

    await processDevQueue({ db: realDb, config: CONFIG, runAgent: baseRunAgent, exec, notify, overrides });

    expect(overrides.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ issue: 303, repoDir: '/ios-repo', worktreeRoot: '/wt-root' }),
    );
    expect(worktreeAtRun).toBe('/wt-root/issue-303');
  });

  it('cancels the task without running the workflow when agent:queue was pulled after queueing', async () => {
    createDevTask('d4', 304, 'Crash');
    const exec = makeExec(['type:bug', 'priority:p3']); // agent:queue removed
    const overrides = makeOverrides();

    await processDevQueue({ db: realDb, config: CONFIG, runAgent: baseRunAgent, exec, notify, overrides });

    expect(getDevTaskById('d4')!.status).toBe('cancelled');
    expect(overrides.runWorkflow).not.toHaveBeenCalled();
    expect(overrides.createWorktree).not.toHaveBeenCalled();
  });

  it('re-claims an approved (spec_approved) task because agent:queue was never removed', async () => {
    seed({ id: 'd5', issue_number: 305, status: 'spec_approved', stage_checkpoint: 'spec_approved', spec_md: 'plan' });
    const exec = makeExec(); // agent:queue still present
    const overrides = makeOverrides({
      runWorkflow: vi.fn(async (): Promise<WorkflowOutcome> => 'pr_open'),
    });

    const result = await processDevQueue({ db: realDb, config: CONFIG, runAgent: baseRunAgent, exec, notify, overrides });

    expect(result.processed).toBe(1);
    expect(overrides.runWorkflow).toHaveBeenCalledTimes(1);
    expect(getDevTaskById('d5')!.status).not.toBe('cancelled');
  });

  it('sweeps a terminal rejected row that still holds a worktree, leaving spec_drafted untouched', async () => {
    seed({ id: 'r1', issue_number: 401, status: 'rejected', worktree_path: '/wt-root/issue-401', branch: 'agent/issue-401' });
    seed({ id: 's1', issue_number: 402, status: 'spec_drafted', worktree_path: '/wt-root/issue-402', branch: 'agent/issue-402' });
    const exec = makeExec();
    const overrides = makeOverrides();

    await processDevQueue({ db: realDb, config: CONFIG, runAgent: baseRunAgent, exec, notify, overrides });

    expect(overrides.removeWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ issue: 401, repoDir: '/ios-repo', worktreeRoot: '/wt-root' }),
    );
    expect(getDevTaskById('r1')!.worktree_path).toBeNull(); // cleared
    expect(getDevTaskById('s1')!.worktree_path).toBe('/wt-root/issue-402'); // untouched
  });

  it('notifies and does NOT tear down on a spec_drafted outcome', async () => {
    createDevTask('d6', 306, 'Crash');
    const exec = makeExec();
    const overrides = makeOverrides({ runWorkflow: vi.fn(async (): Promise<WorkflowOutcome> => 'spec_drafted') });

    await processDevQueue({ db: realDb, config: CONFIG, runAgent: baseRunAgent, exec, notify, overrides });

    expect(notify).toHaveBeenCalledTimes(1);
    // removeWorktree only called by the (empty) terminal sweep, never for spec_drafted teardown.
    expect(overrides.removeWorktree).not.toHaveBeenCalled();
  });

  it('tears down the worktree on a pr_open outcome', async () => {
    createDevTask('d7', 307, 'Crash');
    const exec = makeExec();
    const overrides = makeOverrides({ runWorkflow: vi.fn(async (): Promise<WorkflowOutcome> => 'pr_open') });

    await processDevQueue({ db: realDb, config: CONFIG, runAgent: baseRunAgent, exec, notify, overrides });

    expect(overrides.removeWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ issue: 307 }),
    );
    expect(getDevTaskById('d7')!.worktree_path).toBeNull();
  });

  it('claims nothing when no task is queued', async () => {
    const exec = makeExec();
    const overrides = makeOverrides();
    const result = await processDevQueue({ db: realDb, config: CONFIG, runAgent: baseRunAgent, exec, notify, overrides });
    expect(result.processed).toBe(0);
    expect(overrides.runWorkflow).not.toHaveBeenCalled();
  });
});

describe('makeDevRunAgent', () => {
  it('loads the dev personality and policy and passes them on every call', async () => {
    const base = vi.fn(async (..._args: unknown[]) => ({ text: 'ok', usage: { totalCostUsd: 0.2 } }));
    const runner = makeDevRunAgent(base, '/wt-root/issue-99');

    const r = await runner('hello');

    expect(r).toEqual({ text: 'ok', usage: { totalCostUsd: 0.2 } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = base.mock.calls[0][8] as any;
    expect(opts.cwd).toBe('/wt-root/issue-99');
    expect(opts.fsPolicy.allowedRoots).toEqual(['/wt-root/issue-99']);
    expect(opts.fsPolicy.deniedReadGlobs).toContain('**/.env*');
    expect(opts.nativeToolPolicy.deniedBashPatterns).toContain('git push');
  });
});
