import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import Database from 'better-sqlite3';
import { processPendingFeedback } from '../process';
import { applySchema } from '../../appstoreconnect/schema';

interface SeedRow {
  asc_id: string;
  type?: 'testflight_feedback' | 'testflight_crash' | 'app_store_review';
  tester_id: string;
  build_version?: string;
  text: string;
  status?:
    | 'pending_classification'
    | 'pending_approval'
    | 'approved'
    | 'rejected'
    | 'sent'
    | 'error';
}

function validJson(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    classification: 'bug',
    draft_subject: 'Re: Crash on save',
    draft_body: "Thanks for the report. We'll look into the save crash.",
    suggested_issue_title: 'Save action crashes',
    suggested_issue_body: 'Reported in TestFlight build 71.\n\nFiled from AI OS.',
    suggested_priority: 'p1',
    phi_flag: false,
    ...overrides,
  });
}

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-process-'));
  return join(dir, 'test.db');
}

function seedFeedback(dbPath: string, rows: SeedRow[]): number[] {
  const db = new Database(dbPath);
  applySchema(db);
  const insert = db.prepare(`
    INSERT INTO asc_feedback (asc_id, type, tester_id, build_version, text, screenshots_json, raw_json, status, received_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, '[]', '{}', ?, ?, ?)
  `);
  const now = Math.floor(Date.now() / 1000);
  const ids: number[] = [];
  for (const r of rows) {
    const result = insert.run(
      r.asc_id,
      r.type ?? 'testflight_feedback',
      r.tester_id,
      r.build_version ?? '71',
      r.text,
      r.status ?? 'pending_classification',
      now,
      now,
    );
    ids.push(result.lastInsertRowid as number);
  }
  db.close();
  return ids;
}

function readDraft(dbPath: string, feedbackId: number): Record<string, unknown> | null {
  const db = new Database(dbPath);
  const row = db
    .prepare(`SELECT * FROM asc_drafts WHERE feedback_id = ?`)
    .get(feedbackId) as Record<string, unknown> | undefined;
  db.close();
  return row ?? null;
}

function readFeedbackStatus(dbPath: string, feedbackId: number): string {
  const db = new Database(dbPath);
  const row = db
    .prepare(`SELECT status FROM asc_feedback WHERE id = ?`)
    .get(feedbackId) as { status: string };
  db.close();
  return row.status;
}

describe('processPendingFeedback', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeDbPath();
  });

  it('returns zero counts when there are no rows at all', async () => {
    const db = new Database(dbPath);
    applySchema(db);
    db.close();

    const runAgent = vi.fn();
    const result = await processPendingFeedback({ dbPath, runAgent });
    expect(result).toEqual({ drafted: 0, failed: 0, errors: [] });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('drafts a single pending row and updates feedback status', async () => {
    const [feedbackId] = seedFeedback(dbPath, [
      {
        asc_id: 'a-1',
        tester_id: 'Sam',
        build_version: '71',
        text: 'App crashes when I tap save',
      },
    ]);

    const runAgent = vi.fn().mockResolvedValue(validJson());
    const result = await processPendingFeedback({ dbPath, runAgent });

    expect(result.drafted).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);

    const draft = readDraft(dbPath, feedbackId);
    expect(draft).not.toBeNull();
    expect(draft!.classification).toBe('bug');
    expect(draft!.suggested_priority).toBe('p1');
    expect(draft!.draft_subject).toBe('Re: Crash on save');

    expect(readFeedbackStatus(dbPath, feedbackId)).toBe('pending_approval');
  });

  it('skips a feedback row that already has a draft (idempotent retry)', async () => {
    const [feedbackId] = seedFeedback(dbPath, [
      {
        asc_id: 'a-1',
        tester_id: 'Sam',
        build_version: '71',
        text: 'App crashes when I tap save',
      },
    ]);

    // Pre-insert a draft as if a previous tick had succeeded the insert but
    // failed before the status update flipped to pending_approval.
    const db = new Database(dbPath);
    db.prepare(
      `
      INSERT INTO asc_drafts (feedback_id, classification, draft_subject, draft_body, suggested_issue_title, suggested_issue_body, suggested_priority, phi_flag, redacted_terms, created_at)
      VALUES (?, 'bug', 'Re: Pre', 'body', 'title', 'body2', 'p1', 0, '[]', ?)
    `,
    ).run(feedbackId, Math.floor(Date.now() / 1000));
    db.close();

    const runAgent = vi.fn().mockResolvedValue(validJson());
    const result = await processPendingFeedback({ dbPath, runAgent });

    expect(result).toEqual({ drafted: 0, failed: 0, errors: [] });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('records a failure and leaves the feedback row pending when the agent throws', async () => {
    const [feedbackId] = seedFeedback(dbPath, [
      {
        asc_id: 'a-1',
        tester_id: 'Sam',
        build_version: '71',
        text: 'Generic feedback',
      },
    ]);

    const runAgent = vi.fn().mockRejectedValue(new Error('boom'));
    const result = await processPendingFeedback({ dbPath, runAgent });

    expect(result.drafted).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].feedbackId).toBe(feedbackId);
    expect(result.errors[0].message).toBe('boom');

    expect(readDraft(dbPath, feedbackId)).toBeNull();
    expect(readFeedbackStatus(dbPath, feedbackId)).toBe('pending_classification');
  });

  it('flags PHI-laden text and records the caught terms as JSON', async () => {
    const [feedbackId] = seedFeedback(dbPath, [
      {
        asc_id: 'a-phi',
        tester_id: 'Sam',
        build_version: '71',
        text: 'I take Lisinopril every morning and the app keeps crashing',
      },
    ]);

    const runAgent = vi.fn().mockResolvedValue(validJson({ phi_flag: false }));
    const result = await processPendingFeedback({ dbPath, runAgent });
    expect(result.drafted).toBe(1);

    const draft = readDraft(dbPath, feedbackId);
    expect(draft).not.toBeNull();
    expect(draft!.phi_flag).toBe(1);

    const terms = JSON.parse(draft!.redacted_terms as string);
    expect(Array.isArray(terms)).toBe(true);
    expect(terms).toContain('lisinopril');
  });

  it('passes null first name when tester_id is an email address', async () => {
    seedFeedback(dbPath, [
      {
        asc_id: 'a-email',
        tester_id: 'someone@example.com',
        build_version: '71',
        text: 'Generic feedback',
      },
    ]);

    const runAgent = vi.fn().mockResolvedValue(validJson());
    await processPendingFeedback({ dbPath, runAgent });

    const promptArg = runAgent.mock.calls[0][0] as string;
    expect(promptArg).toContain('Tester first name: unknown');
    expect(promptArg).not.toContain('someone@example.com');
  });

  it('passes the tester_id as the first name when it does not look like an email', async () => {
    seedFeedback(dbPath, [
      {
        asc_id: 'a-name',
        tester_id: 'Sam',
        build_version: '71',
        text: 'Generic feedback',
      },
    ]);

    const runAgent = vi.fn().mockResolvedValue(validJson());
    await processPendingFeedback({ dbPath, runAgent });

    const promptArg = runAgent.mock.calls[0][0] as string;
    expect(promptArg).toContain('Tester first name: Sam');
  });
});
