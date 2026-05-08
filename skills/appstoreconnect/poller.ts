import type Database from 'better-sqlite3';
import type { AscClient, AscResource } from './client';

export interface PollOptions {
  db: Database.Database;
  client: AscClient;
  appId: string;
}

export interface PollResult {
  inserted: number;
  skipped: number;
  errors: string[];
}

export async function runPollOnce(opts: PollOptions): Promise<PollResult> {
  const { db, client } = opts;
  const errors: string[] = [];
  let inserted = 0;
  let skipped = 0;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO asc_feedback
      (asc_id, type, tester_id, build_version, text, screenshots_json, raw_json, status, received_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_classification', ?, ?)
  `);

  const sources: Array<{ kind: string; load: () => Promise<AscResource[]>; type: string }> = [
    { kind: 'feedback', load: () => client.listBetaFeedback(), type: 'testflight_feedback' },
    { kind: 'crash', load: () => client.listBetaCrashFeedback(), type: 'testflight_crash' },
  ];

  for (const src of sources) {
    try {
      const items = await src.load();
      for (const item of items) {
        const a = (item.attributes as any) ?? {};
        const parsed = a.createdDate ? Math.floor(new Date(a.createdDate).getTime() / 1000) : NaN;
        const receivedAt = Number.isFinite(parsed) ? parsed : Math.floor(Date.now() / 1000);
        const fetchedAt = Math.floor(Date.now() / 1000);
        const result = insert.run(
          item.id,
          src.type,
          a.testerEmail ?? a.testerId ?? 'unknown',
          a.buildVersion ?? 'unknown',
          a.comment ?? a.text ?? '',
          JSON.stringify(a.screenshots ?? []),
          JSON.stringify(item),
          receivedAt,
          fetchedAt
        );
        if (result.changes > 0) inserted++;
        else skipped++;
      }
    } catch (e) {
      errors.push(`${src.kind}: ${(e as Error).message}`);
    }
  }

  return { inserted, skipped, errors };
}
