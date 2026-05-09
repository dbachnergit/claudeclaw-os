import type Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Resolves to <project-root>/store/migrations/. schema.ts must remain
// two directory levels below the project root for this path to be correct.
const here = dirname(fileURLToPath(import.meta.url));

export function applySchema(db: Database.Database): void {
  const sql = readFileSync(
    join(here, '..', '..', 'store', 'migrations', '2026-05-08-asc-feedback.sql'),
    'utf8'
  );
  db.exec(sql);

  // 2026-05-08 issue-link migration: add github_issue_url column only if
  // it doesn't exist. SQLite ALTER TABLE ADD COLUMN is not idempotent, so
  // we PRAGMA-check before applying.
  const cols = db.prepare(`PRAGMA table_info(asc_feedback)`).all() as { name: string }[];
  const hasIssueUrl = cols.some((c) => c.name === 'github_issue_url');
  if (!hasIssueUrl) {
    const linkSql = readFileSync(
      join(here, '..', '..', 'store', 'migrations', '2026-05-08-asc-feedback-issue-link.sql'),
      'utf8'
    );
    db.exec(linkSql);
  }

  // 2026-05-08 asc-drafts migration: ephemeral working-state table holding
  // comms-agent drafts awaiting human approval. The SQL is self-idempotent
  // (CREATE TABLE / CREATE INDEX IF NOT EXISTS), so it's safe to run on
  // every applySchema call without a PRAGMA guard.
  const draftsSql = readFileSync(
    join(here, '..', '..', 'store', 'migrations', '2026-05-08-asc-drafts.sql'),
    'utf8'
  );
  db.exec(draftsSql);
}
