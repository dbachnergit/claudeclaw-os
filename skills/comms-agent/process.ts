// skills/comms-agent/process.ts
//
// Process loop that picks up `pending_classification` rows from
// asc_feedback, drafts replies via the comms-agent, and persists them to
// asc_drafts. On success the feedback row is moved to `pending_approval`.
// On failure the feedback row is left alone so the next tick retries; the
// UNIQUE(feedback_id) constraint on asc_drafts prevents duplicate inserts
// if a partial transaction somehow committed.

import Database from 'better-sqlite3';
import { applySchema } from '../appstoreconnect/schema.js';
import { draftReplyForFeedback } from './index.js';

export interface ProcessOptions {
  dbPath: string;
  runAgent: (prompt: string) => Promise<string>;
  /** Test seam: override the time source. */
  now?: () => number;
  logger?: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

export interface ProcessResult {
  drafted: number;
  failed: number;
  errors: Array<{ feedbackId: number; message: string }>;
}

export async function processPendingFeedback(opts: ProcessOptions): Promise<ProcessResult> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const log = opts.logger ?? { info: () => {}, error: () => {} };

  const db = new Database(opts.dbPath);
  applySchema(db);
  db.pragma('foreign_keys = ON');

  // Pull rows that are pending_classification AND don't already have a draft
  // (LEFT JOIN guard against repeat drafting if the status update failed but
  // the insert succeeded on a previous run).
  const rows = db
    .prepare(
      `
    SELECT f.id, f.type, f.tester_id, f.build_version, f.text
    FROM asc_feedback f
    LEFT JOIN asc_drafts d ON d.feedback_id = f.id
    WHERE f.status = 'pending_classification' AND d.id IS NULL
  `,
    )
    .all() as Array<{
    id: number;
    type: string;
    tester_id: string | null;
    build_version: string | null;
    text: string | null;
  }>;

  if (rows.length === 0) {
    db.close();
    return { drafted: 0, failed: 0, errors: [] };
  }

  const insert = db.prepare(`
    INSERT INTO asc_drafts (feedback_id, classification, draft_subject, draft_body, suggested_issue_title, suggested_issue_body, suggested_priority, phi_flag, redacted_terms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStatus = db.prepare(
    `UPDATE asc_feedback SET status = 'pending_approval' WHERE id = ?`,
  );

  let drafted = 0;
  let failed = 0;
  const errors: Array<{ feedbackId: number; message: string }> = [];

  for (const row of rows) {
    try {
      // Heuristic: if tester_id looks like an email, we don't have a first name.
      // Otherwise, treat the tester_id as the first name (Apple's invitedTesters
      // attributes give us first/last in raw_json — extracting that is a future
      // refinement; for now use the simplest signal).
      const firstName = row.tester_id && !row.tester_id.includes('@') ? row.tester_id : null;
      const draft = await draftReplyForFeedback({
        feedbackText: row.text ?? '',
        buildVersion: row.build_version ?? 'unknown',
        testerFirstName: firstName,
        runAgent: opts.runAgent,
      });

      const tx = db.transaction(() => {
        insert.run(
          row.id,
          draft.classification,
          draft.draft_subject,
          draft.draft_body,
          draft.suggested_issue_title,
          draft.suggested_issue_body,
          draft.suggested_priority,
          draft.phi_flag ? 1 : 0,
          JSON.stringify(draft.redacted_terms),
          now(),
        );
        updateStatus.run(row.id);
      });
      tx();
      drafted++;
      log.info(
        { feedbackId: row.id, classification: draft.classification, phiFlag: draft.phi_flag },
        'comms-agent drafted',
      );
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ feedbackId: row.id, message });
      log.error({ feedbackId: row.id, err }, 'comms-agent draft failed');
      // Do not update asc_feedback.status — leave as pending_classification so
      // the next tick retries. UNIQUE(feedback_id) on asc_drafts prevents dup
      // inserts if a partial transaction somehow committed.
    }
  }

  db.close();
  return { drafted, failed, errors };
}
