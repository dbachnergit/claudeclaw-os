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
}
