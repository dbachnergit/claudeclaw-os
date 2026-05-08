import type Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

export function applySchema(db: Database.Database): void {
  const sql = readFileSync(
    join(here, '..', '..', 'store', 'migrations', '2026-05-08-asc-feedback.sql'),
    'utf8'
  );
  db.exec(sql);
}
