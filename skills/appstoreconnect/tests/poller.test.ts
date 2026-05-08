import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../schema';
import { runPollOnce } from '../poller';
import type { AscClient } from '../client';

const fakeClient = (rows: Array<{id:string; type:string; attributes:any}>): AscClient => ({
  listBetaFeedback: async () => rows,
  listBetaCrashFeedback: async () => [],
  listCustomerReviews: async () => [],
} as any);

describe('runPollOnce', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('inserts unseen feedback and skips duplicates', async () => {
    const rows = [{
      id: 'F1', type: 'betaFeedbackScreenshotSubmissions',
      attributes: { comment: 'crashes on save', testerEmail: 't@x.io', buildVersion: '98', screenshots: [], createdDate: '2026-05-07T18:00:00Z' }
    }];

    const result1 = await runPollOnce({ db, client: fakeClient(rows), appId: 'A1' });
    expect(result1.inserted).toBe(1);
    const result2 = await runPollOnce({ db, client: fakeClient(rows), appId: 'A1' });
    expect(result2.inserted).toBe(0);
    expect(result2.skipped).toBe(1);
  });

  it('records each row with status=pending_classification', async () => {
    const rows = [{
      id: 'F2', type: 'betaFeedbackScreenshotSubmissions',
      attributes: { comment: 'good app', testerEmail: 't2@x.io', buildVersion: '98', screenshots: [], createdDate: '2026-05-07T18:00:00Z' }
    }];
    await runPollOnce({ db, client: fakeClient(rows), appId: 'A1' });

    const row = db.prepare('SELECT * FROM asc_feedback WHERE asc_id = ?').get('F2') as any;
    expect(row.status).toBe('pending_classification');
    expect(row.tester_id).toBe('t2@x.io');
    expect(row.build_version).toBe('98');
    expect(row.text).toBe('good app');
  });
});
