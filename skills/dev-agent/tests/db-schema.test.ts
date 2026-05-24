import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase, _testGetDb } from '../../../src/db.js';

/**
 * Task 5.1, dev_tasks table is the single schema source in src/db.ts's
 * startup CREATE TABLE block. These tests issue raw SQL against the
 * in-memory db (same init path as production) to prove the column set and
 * the integrity constraints, before the typed helpers (Task 5.8) exist.
 */

/** Minimal valid row insert; overrides let each test poke one constraint. */
function insertRow(overrides: Record<string, unknown> = {}): void {
  const row = {
    id: 'dev-1',
    issue_number: 101,
    issue_title: 'Crash on save',
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
    ...overrides,
  };
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  _testGetDb()
    .prepare(`INSERT INTO dev_tasks (${cols.join(', ')}) VALUES (${placeholders})`)
    .run(...cols.map((c) => (row as Record<string, unknown>)[c]));
}

describe('dev_tasks schema', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('exposes the full lifecycle column set', () => {
    const cols = (
      _testGetDb().prepare(`PRAGMA table_info(dev_tasks)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(new Set(cols)).toEqual(
      new Set([
        'id',
        'issue_number',
        'issue_title',
        'status',
        'stage',
        'stage_checkpoint',
        'review_notes',
        'spec_md',
        'worktree_path',
        'branch',
        'pr_url',
        'review_rounds',
        'cost_usd',
        'error',
        'created_at',
        'started_at',
        'completed_at',
      ]),
    );
  });

  it('accepts a well-formed row', () => {
    expect(() => insertRow()).not.toThrow();
  });

  it('rejects a duplicate issue_number (UNIQUE)', () => {
    insertRow({ id: 'dev-1', issue_number: 202 });
    expect(() => insertRow({ id: 'dev-2', issue_number: 202 })).toThrow(/UNIQUE/i);
  });

  it('rejects an unknown status (CHECK)', () => {
    expect(() => insertRow({ id: 'dev-bad', issue_number: 303, status: 'bogus' })).toThrow(
      /CHECK/i,
    );
  });

  it('rejects an unknown stage_checkpoint (CHECK)', () => {
    expect(() =>
      insertRow({ id: 'dev-bad2', issue_number: 404, stage_checkpoint: 'pr_open' }),
    ).toThrow(/CHECK/i);
  });

  it('defaults review_rounds to 0 and cost_usd to 0', () => {
    _testGetDb()
      .prepare(
        `INSERT INTO dev_tasks (id, issue_number, issue_title, status, stage_checkpoint, created_at)
         VALUES (?, ?, ?, 'queued', 'queued', ?)`,
      )
      .run('dev-def', 505, 'Defaults check', 1700000000);
    const row = _testGetDb()
      .prepare(`SELECT review_rounds, cost_usd FROM dev_tasks WHERE id = ?`)
      .get('dev-def') as { review_rounds: number; cost_usd: number };
    expect(row.review_rounds).toBe(0);
    expect(row.cost_usd).toBe(0);
  });
});
