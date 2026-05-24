// skills/dev-agent/index.ts
//
// The serialized queue processor: one tick = watch the queue, sweep terminal
// worktrees, then (if not already busy) claim ONE task, re-check the off-switch,
// mark it in-flight, rebuild a fresh worktree, and run the staged workflow. All
// privileged GitHub/git mutations stay in parent (non-LLM) code; the subprocess
// only edits code and runs local tests.
//
// This is a skill SOURCE file: it CANNOT import from src/. The dev_tasks db
// helpers are INJECTED via the `db` bundle (the watch-queue.ts pattern); the
// base runAgent is INJECTED and wrapped per-worktree by makeDevRunAgent. The
// parent-owned skill functions (watchQueue / worktree / runWorkflow / build
// verify / pr / failure) are imported intra-skill and exposed as test seams.
// src/index.ts (Task 5.13) wires the real singleton-backed helpers + runAgent.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type { Exec } from './gh.js';
import { getIssueLabels, swapLabel } from './gh.js';
import { createWorktree, removeWorktree, type WorktreeArgs } from './worktree.js';
import { watchQueue, type WatchQueueDb } from './watch-queue.js';
import { runBuildVerify } from './build-verify.js';
import { openPr } from './pr.js';
import { giveUp } from './failure.js';
import {
  runWorkflow,
  type DevAgentConfig,
  type DevRunAgent,
  type DevStage,
  type RunWorkflowArgs,
  type WorkflowBudget,
  type WorkflowOutcome,
  type WorkflowTask,
} from './workflow.js';

export type { DevAgentConfig } from './workflow.js';

const DEV_MODEL = 'claude-opus-4-7';
const NOOP = (): void => {};

/** Default budget: 90-min wall clock + a generous stage cap. */
const DEFAULT_BUDGET: WorkflowBudget = { wallClockMs: 90 * 60 * 1000, maxStages: 50 };

// agents/dev lives at <repoRoot>/agents/dev; this module runs at
// skills/dev-agent/index.{ts,js}, so it is two directories up.
const AGENTS_DEV_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents', 'dev');

/**
 * Mirror of src/agent.ts RunAgentOptions. A skill SOURCE file cannot import
 * from src/, so we restate the structural shape; the real `runAgent` (whose
 * options param IS RunAgentOptions) is assignable to BaseRunAgent because the
 * two shapes match field-for-field.
 */
export interface DevAgentRunOptions {
  cwd?: string;
  appendInstructions?: string;
  mcpAllowlist?: string[];
  mcpToolAllowlist?: string[];
  nativeToolPolicy?: {
    baseTools?: string[];
    disallowedTools?: string[];
    deniedBashPatterns: string[];
    network?: { allowManagedDomainsOnly?: boolean; allowLocalBinding?: boolean };
  };
  fsPolicy?: { allowedRoots: string[]; deniedReadGlobs: string[] };
}

/** The injected base runner (src/agent.ts runAgent), restated structurally. */
export type BaseRunAgent = (
  message: string,
  sessionId: string | undefined,
  onTyping: () => void,
  onProgress?: (event: { type: string; description: string }) => void,
  model?: string,
  abortController?: AbortController,
  onStreamText?: (accumulatedText: string) => void,
  mcpAllowlist?: string[],
  options?: DevAgentRunOptions,
) => Promise<{ text: string | null; usage: { totalCostUsd: number } | null }>;

/** The full set of injected dev_tasks helpers the processor + workflow need. */
export interface ProcessorDb extends WatchQueueDb {
  claimNextDevTask: () => WorkflowTask | null;
  completeDevTask: (id: string, status: 'pr_open' | 'stuck' | 'cancelled', prUrl?: string | null, error?: string | null) => void;
  setDevTaskWorktree: (id: string, worktreePath: string, branch: string) => void;
  getTerminalDevTasksWithWorktree: () => Array<{ id: string; issue_number: number; worktree_path: string | null }>;
  clearDevTaskWorktree: (id: string) => void;
  // Forwarded into runWorkflow (the WorkflowDb subset):
  setDevTaskSpecDrafted: (id: string, specMd: string) => void;
  setDevTaskStage: (id: string, stage: DevStage) => void;
  incrementDevTaskReviewRounds: (id: string) => void;
  addDevTaskCost: (id: string, deltaUsd: number) => void;
}

/** Test seams: default to the real skill functions, stubbed in unit tests. */
export interface ProcessOverrides {
  watchQueue?: typeof watchQueue;
  createWorktree?: (args: WorktreeArgs) => Promise<{ path: string; branch: string }>;
  removeWorktree?: (args: WorktreeArgs) => Promise<void>;
  runWorkflow?: (args: RunWorkflowArgs) => Promise<WorkflowOutcome>;
  makeDevRunAgent?: (baseRunAgent: BaseRunAgent, worktreePath: string) => DevRunAgent;
  budget?: WorkflowBudget;
}

export interface ProcessDevQueueArgs {
  db: ProcessorDb;
  config: DevAgentConfig;
  runAgent: BaseRunAgent;
  exec: Exec;
  notify: (message: string) => Promise<void> | void;
  overrides?: ProcessOverrides;
}

export interface ProcessResult {
  processed: number;
  queued: number;
  failed: number;
  errors: string[];
}

/**
 * Build the worktree-bound dev runner. Loads the dev personality + tool policy
 * from agents/dev/ ONCE and bakes them into the full RunAgentOptions so every
 * call carries cwd, appended instructions, both allowlists, the native-tool
 * policy (incl. network), and the per-issue filesystem confinement. The base
 * runner is injected so tests never hit the live SDK.
 */
export function makeDevRunAgent(baseRunAgent: BaseRunAgent, worktreePath: string): DevRunAgent {
  const appendInstructions = fs.readFileSync(path.join(AGENTS_DEV_DIR, 'CLAUDE.md'), 'utf-8');
  const mcp = JSON.parse(fs.readFileSync(path.join(AGENTS_DEV_DIR, 'mcp-allowlist.json'), 'utf-8')) as {
    servers: string[];
    allowedTools: string[];
  };
  const policy = JSON.parse(fs.readFileSync(path.join(AGENTS_DEV_DIR, 'native-tool-policy.json'), 'utf-8')) as {
    baseTools: string[];
    disallowedTools: string[];
    deniedBashPatterns: string[];
    deniedReadGlobs: string[];
    network?: { allowManagedDomainsOnly?: boolean; allowLocalBinding?: boolean };
  };

  const options: DevAgentRunOptions = {
    cwd: worktreePath,
    appendInstructions,
    mcpAllowlist: mcp.servers,
    mcpToolAllowlist: mcp.allowedTools,
    nativeToolPolicy: {
      baseTools: policy.baseTools,
      disallowedTools: policy.disallowedTools,
      deniedBashPatterns: policy.deniedBashPatterns,
      network: policy.network,
    },
    fsPolicy: { allowedRoots: [worktreePath], deniedReadGlobs: policy.deniedReadGlobs },
  };

  return async (prompt, abortController) => {
    const r = await baseRunAgent(prompt, undefined, NOOP, undefined, DEV_MODEL, abortController, undefined, undefined, options);
    return { text: r.text, usage: r.usage };
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function devLink(issue: number, suffix: string): string {
  return `Dev agent: issue #${issue} ${suffix}. Review on the /dev dashboard.`;
}

/**
 * One processor tick. Returns the comms-compatible result shape so the cron's
 * failure counter (Task 5.13) works. At most one task runs at a time
 * (in-module devBusy + the transactional claim).
 */
let devBusy = false;

export async function processDevQueue({
  db,
  config,
  runAgent,
  exec,
  notify,
  overrides = {},
}: ProcessDevQueueArgs): Promise<ProcessResult> {
  const _watchQueue = overrides.watchQueue ?? watchQueue;
  const _createWorktree = overrides.createWorktree ?? createWorktree;
  const _removeWorktree = overrides.removeWorktree ?? removeWorktree;
  const _runWorkflow = overrides.runWorkflow ?? runWorkflow;
  const _makeDevRunAgent = overrides.makeDevRunAgent ?? makeDevRunAgent;
  const budget = overrides.budget ?? DEFAULT_BUDGET;

  const errors: string[] = [];
  let processed = 0;
  let queued = 0;

  // 1. Turn fresh nominations into queued rows (idempotent, label-self-healing).
  try {
    const w = await _watchQueue({ db, repo: config.repo, exec });
    queued = w.queued;
    errors.push(...w.errors);
  } catch (err) {
    errors.push(`watchQueue: ${errMsg(err)}`);
  }

  // 2. Sweep terminal rows that still hold a worktree (covers reject, whose
  //    teardown lives here in the cron worker, never in the Hono handler).
  try {
    for (const t of db.getTerminalDevTasksWithWorktree()) {
      await _removeWorktree({ issue: t.issue_number, repoDir: config.iosRepoDir, worktreeRoot: config.worktreeRoot, exec });
      db.clearDevTaskWorktree(t.id);
    }
  } catch (err) {
    errors.push(`sweep: ${errMsg(err)}`);
  }

  // 3. One task at a time.
  if (devBusy) return { processed, queued, failed: errors.length, errors };
  const task = db.claimNextDevTask();
  if (!task) return { processed, queued, failed: errors.length, errors };

  devBusy = true;
  try {
    // 4. Off-switch reconcile: agent:queue must STILL be present (it is never
    //    swapped away during the active lifecycle, so legitimate re-claims pass).
    const labels = await getIssueLabels(config.repo, task.issue_number, exec);
    if (!labels.includes('agent:queue')) {
      db.completeDevTask(task.id, 'cancelled');
      try {
        await swapLabel(config.repo, task.issue_number, ['status:in-flight'], [], exec);
      } catch (err) {
        errors.push(`#${task.issue_number} cancel-cleanup: ${errMsg(err)}`);
      }
      return { processed, queued, failed: errors.length, errors };
    }

    // 5. Mark the single running task in-flight, KEEPING agent:queue.
    await swapLabel(config.repo, task.issue_number, [], ['status:in-flight'], exec);

    // 6. Rebuild a fresh worktree and persist its path BEFORE any work runs
    //    (so the terminal sweep always has something to clean).
    const { path: wtPath, branch } = await _createWorktree({
      issue: task.issue_number,
      repoDir: config.iosRepoDir,
      worktreeRoot: config.worktreeRoot,
      exec,
    });
    db.setDevTaskWorktree(task.id, wtPath, branch);

    // 7. Drive the staged workflow with the worktree-bound dev runner.
    const abortController = new AbortController();
    const outcome = await _runWorkflow({
      task: { ...task, worktree_path: wtPath, branch },
      config,
      db,
      runAgent: _makeDevRunAgent(runAgent, wtPath),
      exec,
      runBuildVerify,
      openPr,
      giveUp,
      notify,
      abortController,
      budget,
    });
    processed = 1;

    // 8. Handle the terminal. runWorkflow has ALREADY persisted the terminal
    //    status (pr_open/stuck), so teardown after this point can never leave a
    //    re-runnable `running` row. (giveUp already notified on stuck.)
    if (outcome === 'spec_drafted') {
      await notify(devLink(task.issue_number, 'is awaiting your spec approval'));
    } else if (outcome === 'pr_open') {
      await notify(devLink(task.issue_number, 'opened a draft PR'));
      await _removeWorktree({ issue: task.issue_number, repoDir: config.iosRepoDir, worktreeRoot: config.worktreeRoot, exec });
      db.clearDevTaskWorktree(task.id);
    } else {
      await _removeWorktree({ issue: task.issue_number, repoDir: config.iosRepoDir, worktreeRoot: config.worktreeRoot, exec });
      db.clearDevTaskWorktree(task.id);
    }
  } catch (err) {
    errors.push(`#${task.issue_number}: ${errMsg(err)}`);
  } finally {
    devBusy = false;
  }

  return { processed, queued, failed: errors.length, errors };
}
