import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { promoteFeedbackRow } from '../index';

function makeDb(): { dbPath: string } {
  // We need a real on-disk DB because better-sqlite3 wants a path.
  // Tests use a tmp file that the OS cleans up.
  const tmpdir = require('os').tmpdir();
  const path = require('path');
  const fs = require('fs');
  const dbPath = path.join(tmpdir, `aios-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE asc_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asc_id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      tester_id TEXT NOT NULL,
      build_version TEXT NOT NULL,
      text TEXT NOT NULL,
      screenshots_json TEXT NOT NULL DEFAULT '[]',
      raw_json TEXT NOT NULL,
      status TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL,
      github_issue_url TEXT
    );
  `);
  db.prepare(`
    INSERT INTO asc_feedback (asc_id, type, tester_id, build_version, text, raw_json, status, received_at, fetched_at)
    VALUES ('asc-1', 'testflight_feedback', 'tester@example.com', '76', 'Crash on save', '{}', 'pending_classification', 1000, 1000)
  `).run();
  db.close();
  return { dbPath };
}

describe('promoteFeedbackRow', () => {
  it('creates issue, updates row to approved, stores URL', async () => {
    const { dbPath } = makeDb();
    const exec = vi.fn().mockResolvedValue({
      stdout: 'https://github.com/dbachnergit/PatientScribe/issues/100\n',
      stderr: '',
      code: 0,
    });

    const url = await promoteFeedbackRow({
      dbPath,
      feedbackId: 1,
      classification: 'bug',
      title: 'Crash on save',
      body: 'Reproduces every time.',
      repo: 'dbachnergit/PatientScribe',
      priority: 'p1',
      exec,
    });

    expect(url).toBe('https://github.com/dbachnergit/PatientScribe/issues/100');

    // Verify gh got the right labels
    expect(exec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--label', 'source:testflight', '--label', 'type:bug', '--label', 'priority:p1'])
    );

    // Verify row updated
    const db = new Database(dbPath);
    const row = db.prepare('SELECT status, github_issue_url FROM asc_feedback WHERE id = 1').get() as { status: string; github_issue_url: string };
    db.close();
    expect(row.status).toBe('approved');
    expect(row.github_issue_url).toBe('https://github.com/dbachnergit/PatientScribe/issues/100');
  });

  it('throws when row id is missing, leaves DB unchanged', async () => {
    const { dbPath } = makeDb();
    const exec = vi.fn();

    await expect(promoteFeedbackRow({
      dbPath,
      feedbackId: 9999,
      classification: 'bug',
      title: 't', body: 'b',
      repo: 'x/y',
      exec,
    })).rejects.toThrow(/row 9999 not found/);

    expect(exec).not.toHaveBeenCalled();

    // First row should still be pending
    const db = new Database(dbPath);
    const row = db.prepare('SELECT status, github_issue_url FROM asc_feedback WHERE id = 1').get() as { status: string; github_issue_url: string | null };
    db.close();
    expect(row.status).toBe('pending_classification');
    expect(row.github_issue_url).toBeNull();
  });

  it('does not update row when gh promotion fails', async () => {
    const { dbPath } = makeDb();
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: 'rate limited', code: 1 });

    await expect(promoteFeedbackRow({
      dbPath,
      feedbackId: 1,
      classification: 'bug',
      title: 't', body: 'b',
      repo: 'x/y',
      exec,
    })).rejects.toThrow(/rate limited/);

    const db = new Database(dbPath);
    const row = db.prepare('SELECT status, github_issue_url FROM asc_feedback WHERE id = 1').get() as { status: string; github_issue_url: string | null };
    db.close();
    expect(row.status).toBe('pending_classification');
    expect(row.github_issue_url).toBeNull();
  });
});
