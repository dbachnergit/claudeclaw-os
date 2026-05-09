import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../schema';

describe('asc-feedback schema', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('creates an asc_feedback table with the expected columns', () => {
    const row = db.prepare(`PRAGMA table_info(asc_feedback)`).all() as { name: string }[];
    const cols = row.map((r) => r.name).sort();
    expect(cols).toEqual([
      'asc_id',
      'build_version',
      'fetched_at',
      'github_issue_url',
      'id',
      'raw_json',
      'received_at',
      'screenshots_json',
      'status',
      'tester_id',
      'text',
      'type',
    ].sort());
  });

  it('enforces unique asc_id', () => {
    const insert = db.prepare(`
      INSERT INTO asc_feedback (asc_id, type, tester_id, build_version, text, screenshots_json, raw_json, status, received_at, fetched_at)
      VALUES (?, 'testflight_feedback', 't1', '98', 'hi', '[]', '{}', 'pending_classification', 1, 1)
    `);
    insert.run('A');
    expect(() => insert.run('A')).toThrow();
  });
});

describe('asc-drafts schema', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
  });

  // Helper to insert a parent feedback row and return its rowid.
  const insertFeedback = (ascId = 'F-DRAFT-1'): number => {
    const result = db.prepare(`
      INSERT INTO asc_feedback (asc_id, type, tester_id, build_version, text, screenshots_json, raw_json, status, received_at, fetched_at)
      VALUES (?, 'testflight_feedback', 't1', '98', 'broken save flow', '[]', '{}', 'pending_classification', 1, 1)
    `).run(ascId);
    return Number(result.lastInsertRowid);
  };

  it('creates an asc_drafts table with the expected columns', () => {
    const rows = db.prepare(`PRAGMA table_info(asc_drafts)`).all() as { name: string; type: string; notnull: number; dflt_value: string | null }[];
    const cols = rows.map((r) => r.name).sort();
    expect(cols).toEqual([
      'classification',
      'created_at',
      'draft_body',
      'draft_subject',
      'feedback_id',
      'id',
      'phi_flag',
      'redacted_terms',
      'status',
      'suggested_issue_body',
      'suggested_issue_title',
      'suggested_priority',
    ].sort());

    // Spot-check NOT NULL on the non-default columns and the defaults
    // we care about for backfill safety.
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.feedback_id.notnull).toBe(1);
    expect(byName.classification.notnull).toBe(1);
    expect(byName.draft_subject.notnull).toBe(1);
    expect(byName.draft_body.notnull).toBe(1);
    expect(byName.suggested_issue_title.notnull).toBe(1);
    expect(byName.suggested_issue_body.notnull).toBe(1);
    expect(byName.suggested_priority.notnull).toBe(1);
    expect(byName.phi_flag.notnull).toBe(1);
    expect(byName.redacted_terms.notnull).toBe(1);
    expect(byName.redacted_terms.dflt_value).toBe(`'[]'`);
    expect(byName.phi_flag.dflt_value).toBe('0');
    expect(byName.status.notnull).toBe(1);
  });

  it('configures feedback_id as a foreign key to asc_feedback(id)', () => {
    const fks = db.prepare(`PRAGMA foreign_key_list(asc_drafts)`).all() as { from: string; to: string; table: string }[];
    const feedbackFk = fks.find((f) => f.from === 'feedback_id');
    expect(feedbackFk).toBeDefined();
    expect(feedbackFk!.table).toBe('asc_feedback');
    expect(feedbackFk!.to).toBe('id');
  });

  it('rejects inserts with an invalid status (CHECK constraint)', () => {
    const fbId = insertFeedback();
    const insert = db.prepare(`
      INSERT INTO asc_drafts (feedback_id, classification, draft_subject, draft_body, suggested_issue_title, suggested_issue_body, suggested_priority, status, created_at)
      VALUES (?, 'bug', 'subj', 'body', 'title', 'issue body', 'P2', 'not_real', 1)
    `);
    expect(() => insert.run(fbId)).toThrow();
  });

  it('creates idx_asc_drafts_status and idx_asc_drafts_feedback_id', () => {
    const indexes = db.prepare(`PRAGMA index_list(asc_drafts)`).all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_asc_drafts_status');
    expect(names).toContain('idx_asc_drafts_feedback_id');
  });

  it('is idempotent: applySchema can be called twice without error', () => {
    expect(() => applySchema(db)).not.toThrow();
    // Sanity check: still works after the second apply.
    const rows = db.prepare(`PRAGMA table_info(asc_drafts)`).all() as { name: string }[];
    expect(rows.length).toBeGreaterThan(0);
  });

  it('accepts a valid insert with all required fields', () => {
    const fbId = insertFeedback('F-DRAFT-VALID');
    const insert = db.prepare(`
      INSERT INTO asc_drafts (feedback_id, classification, draft_subject, draft_body, suggested_issue_title, suggested_issue_body, suggested_priority, phi_flag, redacted_terms, status, created_at)
      VALUES (?, 'bug', 'Re: your feedback', 'Thanks for the report.', 'Save flow broken', 'Tester reports save fails on iOS 26.', 'P1', 0, '[]', 'pending_approval', 1715000000)
    `);
    expect(() => insert.run(fbId)).not.toThrow();

    const row = db.prepare(`SELECT * FROM asc_drafts WHERE feedback_id = ?`).get(fbId) as any;
    expect(row.classification).toBe('bug');
    expect(row.status).toBe('pending_approval');
    expect(row.phi_flag).toBe(0);
    expect(row.redacted_terms).toBe('[]');
  });

  it('enforces UNIQUE(feedback_id): one draft per feedback row', () => {
    const fbId = insertFeedback('F-DRAFT-UNIQUE');
    const insert = db.prepare(`
      INSERT INTO asc_drafts (feedback_id, classification, draft_subject, draft_body, suggested_issue_title, suggested_issue_body, suggested_priority, created_at)
      VALUES (?, 'bug', 's', 'b', 't', 'ib', 'P2', 1)
    `);
    insert.run(fbId);
    expect(() => insert.run(fbId)).toThrow();
  });
});
