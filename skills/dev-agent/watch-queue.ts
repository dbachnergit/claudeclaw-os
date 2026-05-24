// skills/dev-agent/watch-queue.ts
//
// Turns nominated issues (carrying all of agent:queue + type:bug + priority:p3)
// into queued dev_tasks rows, idempotently. The dedup source of truth is the
// dev_tasks ROW (any status), never the label — so a leftover agent:queue on
// an issue that already has a row never triggers a doomed re-insert.
//
// Label lifecycle: a fresh nomination keeps agent:queue (the dev-agent-owned
// marker, never swapped away until terminal) and is NOT given status:in-flight
// here — that is added alongside agent:queue only at CLAIM, so a batch of N
// nominations never shows N in-flight. A terminal row that still carries a
// stray agent:queue is self-healed (both labels stripped) to stop the loop.
//
// The dev_tasks helpers live in src/db.ts (single schema source) but a skill
// source file cannot import from src (tsc rootDir + runtime path). They are
// INJECTED via the `db` deps bundle — src/index.ts wires the real
// singleton-backed helpers; tests inject the real helpers after
// _initTestDatabase, or stubs.

import { randomUUID } from 'crypto';
import type { Exec } from './gh.js';
import { listQueuedIssues, swapLabel } from './gh.js';

const TERMINAL: ReadonlySet<string> = new Set(['pr_open', 'stuck', 'rejected', 'cancelled']);

/** The subset of src/db.ts helpers the watcher needs (injected). */
export interface WatchQueueDb {
  getDevTaskByIssue: (issueNumber: number) => { status: string } | null;
  createDevTask: (id: string, issueNumber: number, issueTitle: string) => void;
}

export interface WatchQueueResult {
  queued: number;
  skipped: number;
  errors: string[];
}

export async function watchQueue({
  repo,
  exec,
  db,
}: {
  repo: string;
  exec: Exec;
  db: WatchQueueDb;
}): Promise<WatchQueueResult> {
  let queued = 0;
  let skipped = 0;
  const errors: string[] = [];

  const issues = await listQueuedIssues(repo, exec);

  for (const issue of issues) {
    try {
      const existing = db.getDevTaskByIssue(issue.number);

      if (!existing) {
        // Fresh nomination → queued row. Leave agent:queue intact; do NOT add
        // status:in-flight (that happens at claim, one task at a time).
        db.createDevTask(randomUUID(), issue.number, issue.title);
        queued += 1;
      } else if (TERMINAL.has(existing.status)) {
        // A previously-attempted issue still wearing agent:queue would re-list
        // every tick. Self-heal: strip both labels (no insert — issue_number is
        // globally UNIQUE; re-nomination requires deleting the row first).
        await swapLabel(repo, issue.number, ['agent:queue', 'status:in-flight'], [], exec);
        skipped += 1;
      } else {
        // Non-terminal row already tracks this issue; the lifecycle owns its
        // labels. Touch nothing.
        skipped += 1;
      }
    } catch (err) {
      errors.push(`#${issue.number}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { queued, skipped, errors };
}
