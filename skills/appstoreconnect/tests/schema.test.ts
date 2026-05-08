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
