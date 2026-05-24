import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  _testGetDb,
  createDevTask,
  getDevTaskByIssue,
  getDevTaskById,
  listDevTasks,
  claimNextDevTask,
  setDevTaskStage,
  setDevTaskSpecDrafted,
  approveDevTask,
  requestChangesDevTask,
  rejectDevTask,
  completeDevTask,
  setDevTaskWorktree,
  getTerminalDevTasksWithWorktree,
  clearDevTaskWorktree,
  incrementDevTaskReviewRounds,
  addDevTaskCost,
  resetStuckDevTasks,
  type DevTask,
} from '../../../src/db.js';

/**
 * Task 5.8 — typed dev_tasks CRUD, the claimable-state claim, the CAS
 * human-gate transitions, the terminal-worktree sweep helpers, and the
 * active-only startup recovery. All operate on the module-level db
 * singleton via _initTestDatabase (same path as the mission helpers).
 */

/** Arrange a row in an arbitrary precise state without fighting claim order. */
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

describe('dev_tasks helpers', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  describe('createDevTask + lookups', () => {
    it('creates a queued row with stage_checkpoint=queued and finds it by issue and id', () => {
      createDevTask('d1', 101, 'Crash on save');
      const byIssue = getDevTaskByIssue(101);
      expect(byIssue?.id).toBe('d1');
      expect(byIssue?.status).toBe('queued');
      expect(byIssue?.stage_checkpoint).toBe('queued');
      expect(byIssue?.issue_title).toBe('Crash on save');
      expect(getDevTaskById('d1')?.issue_number).toBe(101);
    });

    it('getDevTaskByIssue returns null for an unknown issue', () => {
      expect(getDevTaskByIssue(999)).toBeNull();
    });

    it('listDevTasks can exclude cancelled rows', () => {
      createDevTask('d1', 101, 'A');
      createDevTask('d2', 102, 'B');
      completeDevTask('d2', 'cancelled');
      const all = listDevTasks();
      const visible = listDevTasks({ excludeCancelled: true });
      expect(all.map((t) => t.id).sort()).toEqual(['d1', 'd2']);
      expect(visible.map((t) => t.id)).toEqual(['d1']);
    });
  });

  describe('claimNextDevTask', () => {
    it('claims a queued row into running/diagnosing and stamps started_at', () => {
      createDevTask('d1', 101, 'A');
      const claimed = claimNextDevTask();
      expect(claimed?.id).toBe('d1');
      expect(claimed?.status).toBe('running');
      expect(claimed?.stage).toBe('diagnosing');
      expect(claimed?.started_at).toBeGreaterThan(0);
    });

    it('claims a spec_approved row into running/implementing', () => {
      seed({ id: 'd1', issue_number: 101, status: 'spec_approved', stage_checkpoint: 'spec_approved' });
      const claimed = claimNextDevTask();
      expect(claimed?.status).toBe('running');
      expect(claimed?.stage).toBe('implementing');
    });

    it('does not re-claim a row already running (serialization)', () => {
      createDevTask('d1', 101, 'A');
      expect(claimNextDevTask()?.id).toBe('d1');
      expect(claimNextDevTask()).toBeNull();
    });

    it('returns null when nothing is claimable', () => {
      seed({ id: 'd1', issue_number: 101, status: 'spec_drafted' });
      expect(claimNextDevTask()).toBeNull();
    });
  });

  describe('stage + spec-drafted writers', () => {
    it('setDevTaskStage updates the display-only stage', () => {
      createDevTask('d1', 101, 'A');
      claimNextDevTask();
      setDevTaskStage('d1', 'self_review');
      expect(getDevTaskById('d1')?.stage).toBe('self_review');
    });

    it('setDevTaskSpecDrafted stores the spec and parks the task at spec_drafted', () => {
      createDevTask('d1', 101, 'A');
      claimNextDevTask();
      setDevTaskSpecDrafted('d1', '# Spec\nfix it');
      const t = getDevTaskById('d1');
      expect(t?.status).toBe('spec_drafted');
      expect(t?.spec_md).toBe('# Spec\nfix it');
      expect(t?.stage).toBeNull();
    });
  });

  describe('CAS human-gate transitions', () => {
    it('approveDevTask moves spec_drafted → spec_approved and sets checkpoint', () => {
      seed({ id: 'd1', issue_number: 101, status: 'spec_drafted' });
      expect(approveDevTask('d1')).toBe(1);
      const t = getDevTaskById('d1');
      expect(t?.status).toBe('spec_approved');
      expect(t?.stage_checkpoint).toBe('spec_approved');
    });

    it('requestChangesDevTask moves spec_drafted → queued and stores notes', () => {
      seed({ id: 'd1', issue_number: 101, status: 'spec_drafted' });
      expect(requestChangesDevTask('d1', 'Out of scope; narrow it')).toBe(1);
      const t = getDevTaskById('d1');
      expect(t?.status).toBe('queued');
      expect(t?.review_notes).toBe('Out of scope; narrow it');
    });

    it('rejectDevTask moves spec_drafted → rejected (terminal)', () => {
      seed({ id: 'd1', issue_number: 101, status: 'spec_drafted' });
      expect(rejectDevTask('d1')).toBe(1);
      const t = getDevTaskById('d1');
      expect(t?.status).toBe('rejected');
      expect(t?.completed_at).toBeGreaterThan(0);
    });

    it('a transition on a row no longer spec_drafted changes 0 rows (approve-after-reject)', () => {
      seed({ id: 'd1', issue_number: 101, status: 'spec_drafted' });
      expect(rejectDevTask('d1')).toBe(1);
      expect(approveDevTask('d1')).toBe(0);
      expect(getDevTaskById('d1')?.status).toBe('rejected');
    });

    it('reject-after-request-changes changes 0 rows (no longer spec_drafted)', () => {
      seed({ id: 'd1', issue_number: 101, status: 'spec_drafted' });
      expect(requestChangesDevTask('d1', 'notes')).toBe(1);
      expect(rejectDevTask('d1')).toBe(0);
      expect(getDevTaskById('d1')?.status).toBe('queued');
    });
  });

  describe('completeDevTask terminals', () => {
    it('persists pr_open with pr_url and completed_at', () => {
      createDevTask('d1', 101, 'A');
      completeDevTask('d1', 'pr_open', 'https://github.com/o/r/pull/5');
      const t = getDevTaskById('d1');
      expect(t?.status).toBe('pr_open');
      expect(t?.pr_url).toBe('https://github.com/o/r/pull/5');
      expect(t?.completed_at).toBeGreaterThan(0);
    });

    it('persists stuck with an error and completed_at', () => {
      createDevTask('d1', 101, 'A');
      completeDevTask('d1', 'stuck', null, 'budget exceeded');
      const t = getDevTaskById('d1');
      expect(t?.status).toBe('stuck');
      expect(t?.error).toBe('budget exceeded');
      expect(t?.completed_at).toBeGreaterThan(0);
    });
  });

  describe('worktree persistence + terminal sweep', () => {
    it('setDevTaskWorktree persists path/branch and clearDevTaskWorktree nulls them', () => {
      createDevTask('d1', 101, 'A');
      setDevTaskWorktree('d1', '/root/issue-101', 'agent/issue-101');
      let t = getDevTaskById('d1');
      expect(t?.worktree_path).toBe('/root/issue-101');
      expect(t?.branch).toBe('agent/issue-101');
      clearDevTaskWorktree('d1');
      t = getDevTaskById('d1');
      expect(t?.worktree_path).toBeNull();
      expect(t?.branch).toBeNull();
    });

    it('getTerminalDevTasksWithWorktree returns only terminal rows that still hold a worktree', () => {
      // terminal + worktree → swept
      seed({ id: 'rejected-wt', issue_number: 201, status: 'rejected', worktree_path: '/w/201', branch: 'agent/issue-201' });
      seed({ id: 'pr-wt', issue_number: 202, status: 'pr_open', worktree_path: '/w/202', branch: 'agent/issue-202' });
      // terminal but already cleared → not returned
      seed({ id: 'stuck-clean', issue_number: 203, status: 'stuck', worktree_path: null });
      // non-terminal with a worktree → not returned
      seed({ id: 'drafted-wt', issue_number: 204, status: 'spec_drafted', worktree_path: '/w/204' });
      const swept = getTerminalDevTasksWithWorktree().map((t) => t.id).sort();
      expect(swept).toEqual(['pr-wt', 'rejected-wt']);
    });
  });

  describe('review-round + cost accounting', () => {
    it('incrementDevTaskReviewRounds bumps the counter and addDevTaskCost accumulates', () => {
      createDevTask('d1', 101, 'A');
      incrementDevTaskReviewRounds('d1');
      incrementDevTaskReviewRounds('d1');
      addDevTaskCost('d1', 1.25);
      addDevTaskCost('d1', 0.75);
      const t = getDevTaskById('d1');
      expect(t?.review_rounds).toBe(2);
      expect(t?.cost_usd).toBeCloseTo(2.0, 5);
    });
  });

  describe('resetStuckDevTasks', () => {
    it('resets running rows to checkpoint, zeroes review_rounds, preserves cost, and leaves idle/terminal rows alone', () => {
      // A: running with checkpoint queued, cost+rounds set → reset to queued
      seed({ id: 'A', issue_number: 301, status: 'running', stage: 'self_review', stage_checkpoint: 'queued', review_rounds: 2, cost_usd: 1.5 });
      // B: running with checkpoint spec_approved → reset to spec_approved
      seed({ id: 'B', issue_number: 302, status: 'running', stage: 'implementing', stage_checkpoint: 'spec_approved', review_rounds: 1, cost_usd: 3.0 });
      // C: spec_drafted (human pause) → untouched
      seed({ id: 'C', issue_number: 303, status: 'spec_drafted' });
      // D: pr_open (terminal) → untouched
      seed({ id: 'D', issue_number: 304, status: 'pr_open' });
      // E: spec_approved (already claimable) → untouched
      seed({ id: 'E', issue_number: 305, status: 'spec_approved', stage_checkpoint: 'spec_approved' });

      const count = resetStuckDevTasks();
      expect(count).toBe(2);

      const a = getDevTaskById('A');
      expect(a?.status).toBe('queued');
      expect(a?.stage).toBeNull();
      expect(a?.review_rounds).toBe(0);
      expect(a?.cost_usd).toBeCloseTo(1.5, 5);

      const b = getDevTaskById('B');
      expect(b?.status).toBe('spec_approved');
      expect(b?.stage).toBeNull();
      expect(b?.review_rounds).toBe(0);
      expect(b?.cost_usd).toBeCloseTo(3.0, 5);

      expect(getDevTaskById('C')?.status).toBe('spec_drafted');
      expect(getDevTaskById('D')?.status).toBe('pr_open');
      expect(getDevTaskById('E')?.status).toBe('spec_approved');
    });
  });
});
