// skills/dev-agent/workflow.ts
//
// The staged orchestrator that drives the hard-wired superpowers sequence:
//   diagnosing -> (human gate) -> implementing -> adversarial_review -> verifying -> PR
// under a wall-clock + stage budget. The LLM subprocess only edits code and runs
// local tests for its own feedback; the PARENT owns the authoritative gates:
//   - the build-verify gate (runBuildVerify) the LLM cannot fake
//   - the TDD-evidence gate (diff must touch a test file, unless the spec opted out)
//   - the draft-PR open (openPr) and the give-up path (giveUp)
// so the never-merge / never-push guarantee holds at the process boundary.
//
// This is a skill SOURCE file: it CANNOT import from src/. The dev_tasks db
// helpers, the wrapped dev runAgent runner, and the parent-owned ops are all
// INJECTED (the watch-queue.ts pattern). src/index.ts (Task 5.13) wires the
// real singleton-backed helpers; unit tests inject the real helpers (after
// _initTestDatabase) plus stubs.

import type { Exec } from './gh.js';
import { ExecTimeoutError, ExecAbortedError } from './gh.js';
import { worktreePath, branchName } from './worktree.js';
import { captureWarnings, DEFAULT_PROJECT_PATH, BUILD_TIMEOUT_MS, type BuildVerifyResult, type RunBuildVerifyArgs } from './build-verify.js';
import type { OpenPrArgs } from './pr.js';
import type { GiveUpArgs } from './failure.js';

/** Per-issue, per-build settings the helpers need (single typed bundle). */
export interface DevAgentConfig {
  repo: string;
  iosRepoDir: string;
  worktreeRoot: string;
  scheme: string;
  simDestination: string;
}

/** The display-only progress sub-state while a task is running. */
export type DevStage = 'diagnosing' | 'implementing' | 'self_review' | 'adversarial_review' | 'verifying';

/** Result the wrapped dev runner returns (subset of AgentResult). */
export interface DevRunResult {
  text: string | null;
  usage: { totalCostUsd: number } | null;
}

/** The worktree-bound dev runner (makeDevRunAgent output), injected. */
export type DevRunAgent = (prompt: string) => Promise<DevRunResult>;

/** The subset of src/db.ts helpers the workflow writes through (injected). */
export interface WorkflowDb {
  setDevTaskSpecDrafted: (id: string, specMd: string) => void;
  setDevTaskStage: (id: string, stage: DevStage) => void;
  incrementDevTaskReviewRounds: (id: string) => void;
  addDevTaskCost: (id: string, deltaUsd: number) => void;
  completeDevTask: (id: string, status: 'pr_open' | 'stuck', prUrl?: string | null, error?: string | null) => void;
}

/** The claimed task the workflow operates on (minimal shape, no src import). */
export interface WorkflowTask {
  id: string;
  issue_number: number;
  issue_title: string;
  /** 'diagnosing' (queued claim) or 'implementing' (spec_approved claim). */
  stage: string | null;
  spec_md: string | null;
  review_notes: string | null;
  branch: string | null;
  worktree_path: string | null;
}

export interface WorkflowBudget {
  wallClockMs: number;
  maxStages: number;
}

export interface RunWorkflowArgs {
  task: WorkflowTask;
  config: DevAgentConfig;
  db: WorkflowDb;
  /** Worktree-bound dev runner; every stage goes through it. */
  runAgent: DevRunAgent;
  /** Stubbable git/build exec; the workflow binds the abort signal onto it. */
  exec: Exec;
  /** Parent-owned authoritative build gate. */
  runBuildVerify: (args: RunBuildVerifyArgs) => Promise<BuildVerifyResult>;
  /** Parent-owned idempotent draft-PR opener. */
  openPr: (args: OpenPrArgs) => Promise<string>;
  /** Parent-owned loud give-up (comment + relabel + notify). */
  giveUp: (args: GiveUpArgs) => Promise<void>;
  /** Telegram notify (passed to giveUp). */
  notify: (message: string) => Promise<void> | void;
  abortController: AbortController;
  budget: WorkflowBudget;
}

export type WorkflowOutcome = 'spec_drafted' | 'pr_open' | 'stuck';

const GIT_TIMEOUT_MS = 60 * 1000;
const MAX_REVIEW_ROUNDS = 3;

/** Converged when the adversarial review reports no blocking issues. */
export function reviewConverged(text: string | null): boolean {
  if (!text) return false;
  return /REVIEW_STATUS:\s*CLEAN/i.test(text);
}

/** True if any changed path is a Swift test file or under a test directory. */
export function touchesTestFile(changedPaths: string[]): boolean {
  return changedPaths.some(
    (p) => /(^|\/)[^/]*Tests?\.swift$/.test(p) || /(^|\/)Tests?\//.test(p),
  );
}

/** The approved spec's explicit opt-out from the test-evidence requirement. */
export function specSaysNotUnitTestable(specMd: string | null): boolean {
  if (!specMd) return false;
  return /not-unit-testable/i.test(specMd);
}

/** Internal: a controlled give-up with a reason + the stage it stuck at. */
class GiveUpError extends Error {
  constructor(
    public readonly reason: string,
    public readonly stuckAt: DevStage,
  ) {
    super(reason);
    this.name = 'GiveUpError';
  }
}

function diagnosePrompt(task: WorkflowTask): string {
  const notes = task.review_notes
    ? `\n\nThe human reviewer requested changes to your prior plan. Address these notes:\n${task.review_notes}`
    : '';
  return [
    `Diagnose and plan a fix for issue #${task.issue_number}: "${task.issue_title}".`,
    'Read docs/CodebaseMap.md first. Use the brainstorming skill if scope is unclear, then writing-plans to produce the spec.',
    'Do NOT write implementation code yet. Output only the plan/spec; a human will approve it before you implement.',
    'If the bug genuinely cannot be unit-tested, say so explicitly with the phrase "not-unit-testable" and why.',
    notes,
  ].join('\n');
}

function implementPrompt(task: WorkflowTask, specMd: string | null): string {
  return [
    `Implement the approved fix for issue #${task.issue_number} using test-driven-development.`,
    'Write the failing test first, watch it fail, then the minimal fix. Commit locally only.',
    'Then self-review with requesting-code-review and address what you find.',
    specMd ? `\nApproved spec:\n${specMd}` : '',
  ].join('\n');
}

function reviewPrompt(round: number): string {
  return [
    `Adversarial self-review round ${round} of ${MAX_REVIEW_ROUNDS}: run the code-review skill against your current diff.`,
    'If you find blocking issues, fix them. End your message with "REVIEW_STATUS: CLEAN" only when no blocking issues remain, otherwise end with "REVIEW_STATUS: ISSUES".',
  ].join('\n');
}

function addressFindingsPrompt(reviewText: string | null): string {
  return [
    'Address the blocking issues from the review above, keeping tests green. Commit locally only.',
    reviewText ? `\nReview findings:\n${reviewText}` : '',
  ].join('\n');
}

function fixBuildPrompt(reasons: string[]): string {
  return [
    'The parent-owned build/test gate FAILED. Fix the cause and keep all tests green. Commit locally only.',
    `Reasons: ${reasons.join('; ')}`,
  ].join('\n');
}

/**
 * Drive a claimed task to a terminal outcome. A queued-origin claim diagnoses
 * and parks at spec_drafted (awaiting the human). A spec_approved-origin claim
 * implements, self-reviews, passes the parent gates, and opens a draft PR, or
 * gives up (stuck) on budget overrun / two-strike build / non-converging
 * review / missing test evidence / a timed-out parent command. Terminal
 * dev_tasks writes are explicit and happen BEFORE the Task 5.10 teardown, so a
 * restart never re-runs a finished task.
 */
export async function runWorkflow({
  task,
  config,
  db,
  runAgent,
  exec,
  runBuildVerify,
  openPr,
  giveUp,
  notify,
  abortController,
  budget,
}: RunWorkflowArgs): Promise<WorkflowOutcome> {
  const startedAt = Date.now();
  let stagesUsed = 0;
  let lastAgentText: string | null = null;
  let lastReviewText: string | null = null;

  const wt = task.worktree_path ?? worktreePath(task.issue_number, config.worktreeRoot);
  const branch = task.branch ?? branchName(task.issue_number);

  // Every parent shell-out carries the abort signal, so a wall-clock budget
  // abort (or operator abort) interrupts a hung xcodebuild/git/gh.
  const boundExec: Exec = (cmd, args, opts = {}) => exec(cmd, args, { ...opts, signal: abortController.signal });

  // Arm the wall-clock budget: aborting the controller interrupts in-flight
  // shell-outs; consumeStage() also checks elapsed time between agent stages.
  const timer = setTimeout(() => abortController.abort(), budget.wallClockMs);

  function consumeStage(stuckAt: DevStage): void {
    if (abortController.signal.aborted) throw new GiveUpError('aborted (budget or operator)', stuckAt);
    if (Date.now() - startedAt > budget.wallClockMs) throw new GiveUpError('wall-clock budget exceeded', stuckAt);
    if (stagesUsed >= budget.maxStages) throw new GiveUpError('stage budget exceeded', stuckAt);
    stagesUsed += 1;
  }

  async function runStage(prompt: string, stuckAt: DevStage): Promise<DevRunResult> {
    consumeStage(stuckAt);
    const r = await runAgent(prompt);
    db.addDevTaskCost(task.id, r.usage?.totalCostUsd ?? 0);
    lastAgentText = r.text;
    return r;
  }

  async function captureBaseline(): Promise<Set<string>> {
    const baseArgs = ['-project', DEFAULT_PROJECT_PATH, '-scheme', config.scheme, '-destination', config.simDestination];
    const build = await boundExec('xcodebuild', ['build', ...baseArgs], { cwd: wt, timeoutMs: BUILD_TIMEOUT_MS });
    return captureWarnings(`${build.stdout}\n${build.stderr}`);
  }

  try {
    // ── Diagnose stage (queued-origin claim) ────────────────────────
    if (task.stage === 'diagnosing') {
      const r = await runStage(diagnosePrompt(task), 'diagnosing');
      db.setDevTaskSpecDrafted(task.id, r.text ?? '');
      return 'spec_drafted';
    }

    // ── Implement stages (spec_approved-origin claim) ───────────────
    db.setDevTaskStage(task.id, 'implementing');
    const baselineWarnings = await captureBaseline();
    await runStage(implementPrompt(task, task.spec_md), 'implementing');

    db.setDevTaskStage(task.id, 'adversarial_review');
    for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
      const review = await runStage(reviewPrompt(round), 'adversarial_review');
      lastReviewText = review.text;
      db.incrementDevTaskReviewRounds(task.id);
      if (reviewConverged(review.text)) break;
      if (round === MAX_REVIEW_ROUNDS) {
        throw new GiveUpError(`adversarial review did not converge after ${MAX_REVIEW_ROUNDS} rounds`, 'adversarial_review');
      }
      await runStage(addressFindingsPrompt(review.text), 'adversarial_review');
    }

    // ── Parent-owned build-verify gate (two-strike) ─────────────────
    db.setDevTaskStage(task.id, 'verifying');
    const verifyArgs: RunBuildVerifyArgs = {
      worktreePath: wt,
      scheme: config.scheme,
      simDestination: config.simDestination,
      baselineWarnings,
      exec: boundExec,
      signal: abortController.signal,
    };
    let build = await runBuildVerify(verifyArgs);
    if (!build.ok) {
      await runStage(fixBuildPrompt(build.reasons), 'verifying');
      build = await runBuildVerify(verifyArgs);
    }
    if (!build.ok) {
      throw new GiveUpError(`build verification failed twice: ${build.reasons.join('; ')}`, 'verifying');
    }

    // ── Parent-owned TDD-evidence gate ──────────────────────────────
    const diff = await boundExec('git', ['-C', wt, 'diff', '--name-only', 'origin/main'], { timeoutMs: GIT_TIMEOUT_MS });
    const changed = diff.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!touchesTestFile(changed) && !specSaysNotUnitTestable(task.spec_md)) {
      throw new GiveUpError(
        'no test evidence: the diff touches no test file and the spec did not mark the bug not-unit-testable',
        'verifying',
      );
    }

    // ── Parent-owned draft PR (idempotent) ──────────────────────────
    const prUrl = await openPr({
      repo: config.repo,
      repoDir: config.iosRepoDir,
      issue: task.issue_number,
      branch,
      specMd: task.spec_md ?? '',
      exec: boundExec,
      testEvidence: lastReviewText ?? undefined,
    });
    db.completeDevTask(task.id, 'pr_open', prUrl);
    return 'pr_open';
  } catch (err) {
    const reason =
      err instanceof GiveUpError ? err.reason
      : err instanceof ExecTimeoutError ? `a parent command timed out: ${err.command}`
      : err instanceof ExecAbortedError ? 'the task was aborted (budget)'
      : `unexpected workflow error: ${err instanceof Error ? err.message : String(err)}`;
    const stuckAt: DevStage =
      err instanceof GiveUpError ? err.stuckAt : (task.stage as DevStage) ?? 'implementing';

    await giveUp({
      repo: config.repo,
      issue: task.issue_number,
      reason,
      diagnosis: task.spec_md ?? lastReviewText ?? lastAgentText ?? 'no diagnosis captured',
      exec: boundExec,
      notify,
      attempted: lastAgentText ?? undefined,
      stuckAt,
    });
    db.completeDevTask(task.id, 'stuck', null, reason);
    return 'stuck';
  } finally {
    clearTimeout(timer);
  }
}
