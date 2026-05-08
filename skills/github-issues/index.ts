// skills/github-issues/index.ts
//
// Entry point for the github-issues skill. Glues together labels.ts
// (label derivation) and promote.ts (gh CLI wrapper) with a SQLite
// read+update around them.

import Database from 'better-sqlite3';
import { promoteToIssue } from './promote.js';
import { deriveLabels, type Source, type Classification, type Priority } from './labels.js';

export interface PromoteFeedbackInput {
  dbPath: string;
  feedbackId: number;
  classification: Classification;
  title: string;
  body: string;
  repo: string;
  priority?: Priority;
  // Test seam: same shape as PromoteInput['exec'] in promote.ts.
  exec?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
}

export async function promoteFeedbackRow(input: PromoteFeedbackInput): Promise<string> {
  const db = new Database(input.dbPath);
  try {
    const row = db.prepare('SELECT type, status, github_issue_url FROM asc_feedback WHERE id = ?').get(input.feedbackId) as
      | { type: string; status: string; github_issue_url: string | null }
      | undefined;
    if (!row) {
      throw new Error(`asc_feedback row ${input.feedbackId} not found`);
    }
    // Idempotency guard: if the row was already promoted (e.g. concurrent
    // submit from a second browser tab), return the existing URL instead of
    // creating a duplicate GitHub Issue. gh issue create is not idempotent.
    if (row.status === 'approved' && row.github_issue_url) {
      return row.github_issue_url;
    }
    const labels = deriveLabels({
      source: row.type as Source,
      classification: input.classification,
      priority: input.priority,
    });
    const url = await promoteToIssue({
      title: input.title,
      body: input.body,
      labels,
      repo: input.repo,
      exec: input.exec,
    });
    db.prepare(
      'UPDATE asc_feedback SET status = ?, github_issue_url = ? WHERE id = ?'
    ).run('approved', url, input.feedbackId);
    return url;
  } finally {
    db.close();
  }
}
