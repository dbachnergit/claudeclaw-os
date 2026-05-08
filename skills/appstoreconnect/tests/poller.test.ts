import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../schema.js';
import { runPollOnce } from '../poller.js';
import type { AscClient, AscPagedResponse } from '../client.js';

type DataItem = { id: string; type: string; attributes?: Record<string, unknown>; relationships?: Record<string, { data?: { id: string; type: string } | null }> };

const fakeClient = (
  feedback: AscPagedResponse = { data: [] },
  crash: AscPagedResponse = { data: [] },
  review: AscPagedResponse = { data: [] },
): AscClient => ({
  listBetaFeedback: async () => feedback,
  listBetaCrashFeedback: async () => crash,
  listCustomerReviews: async () => review,
} as any);

const feedbackResource = (overrides: Partial<DataItem> & { id: string }): DataItem => ({
  type: 'betaFeedbackScreenshotSubmissions',
  attributes: {},
  ...overrides,
});

describe('runPollOnce', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('inserts unseen feedback and skips duplicates', async () => {
    const feedback: AscPagedResponse = {
      data: [feedbackResource({
        id: 'F1',
        attributes: { comment: 'crashes on save', email: 't@x.io', createdDate: '2026-05-07T18:00:00Z' },
      })],
    };

    const result1 = await runPollOnce({ db, client: fakeClient(feedback), appId: 'A1' });
    expect(result1.inserted).toBe(1);
    const result2 = await runPollOnce({ db, client: fakeClient(feedback), appId: 'A1' });
    expect(result2.inserted).toBe(0);
    expect(result2.skipped).toBe(1);
  });

  it('records each row with status=pending_classification and Apple-shape email', async () => {
    const feedback: AscPagedResponse = {
      data: [feedbackResource({
        id: 'F2',
        attributes: { comment: 'good app', email: 't2@x.io', createdDate: '2026-05-07T18:00:00Z' },
      })],
    };
    await runPollOnce({ db, client: fakeClient(feedback), appId: 'A1' });

    const row = db.prepare('SELECT * FROM asc_feedback WHERE asc_id = ?').get('F2') as any;
    expect(row.status).toBe('pending_classification');
    expect(row.tester_id).toBe('t2@x.io');
    expect(row.text).toBe('good app');
  });

  it('resolves build_version from included[] via relationships.build.data.id', async () => {
    const feedback: AscPagedResponse = {
      data: [feedbackResource({
        id: 'F-BUILD',
        attributes: { comment: 'on build 96', email: 't@x.io', createdDate: '2026-05-07T18:00:00Z' },
        relationships: { build: { data: { id: 'BUILD-96', type: 'builds' } } },
      })],
      included: [
        { id: 'BUILD-96', type: 'builds', attributes: { version: '96' } },
      ],
    };
    await runPollOnce({ db, client: fakeClient(feedback), appId: 'A1' });

    const row = db.prepare('SELECT build_version FROM asc_feedback WHERE asc_id = ?').get('F-BUILD') as any;
    expect(row.build_version).toBe('96');
  });

  it('falls back to "unknown" when the build relationship or included is missing', async () => {
    const feedback: AscPagedResponse = {
      data: [feedbackResource({
        id: 'F-NOBUILD',
        attributes: { comment: 'no build relationship', email: 't@x.io', createdDate: '2026-05-07T18:00:00Z' },
      })],
    };
    await runPollOnce({ db, client: fakeClient(feedback), appId: 'A1' });

    const row = db.prepare('SELECT build_version FROM asc_feedback WHERE asc_id = ?').get('F-NOBUILD') as any;
    expect(row.build_version).toBe('unknown');
  });

  it('ingests customer reviews with title+body and reviewerNickname', async () => {
    const review: AscPagedResponse = {
      data: [{
        id: 'R1',
        type: 'customerReviews',
        attributes: {
          title: 'Love it',
          body: 'Best app I have used in years.',
          rating: 5,
          reviewerNickname: 'happyuser',
          createdDate: '2026-05-08T12:00:00Z',
        },
      }],
    };
    const result = await runPollOnce({
      db,
      client: fakeClient({ data: [] }, { data: [] }, review),
      appId: 'A1',
    });
    expect(result.inserted).toBe(1);

    const row = db.prepare('SELECT * FROM asc_feedback WHERE asc_id = ?').get('R1') as any;
    expect(row.type).toBe('app_store_review');
    expect(row.tester_id).toBe('happyuser');
    expect(row.text).toContain('Love it');
    expect(row.text).toContain('Best app');
    expect(row.build_version).toBe('unknown');
  });

  it('uses anonymous when reviewerNickname is missing', async () => {
    const review: AscPagedResponse = {
      data: [{
        id: 'R2',
        type: 'customerReviews',
        attributes: { body: 'just a body', rating: 3, createdDate: '2026-05-08T12:00:00Z' },
      }],
    };
    await runPollOnce({ db, client: fakeClient({ data: [] }, { data: [] }, review), appId: 'A1' });
    const row = db.prepare('SELECT tester_id FROM asc_feedback WHERE asc_id = ?').get('R2') as any;
    expect(row.tester_id).toBe('anonymous');
  });

  it('falls back to current time when createdDate is malformed', async () => {
    const feedback: AscPagedResponse = {
      data: [feedbackResource({
        id: 'F3',
        attributes: { comment: 'oops', email: 't3@x.io', createdDate: 'not-a-date' },
      })],
    };
    const before = Math.floor(Date.now() / 1000);
    await runPollOnce({ db, client: fakeClient(feedback), appId: 'A1' });
    const after = Math.floor(Date.now() / 1000);

    const row = db.prepare('SELECT received_at FROM asc_feedback WHERE asc_id = ?').get('F3') as any;
    expect(Number.isFinite(row.received_at)).toBe(true);
    expect(row.received_at).toBeGreaterThan(0);
    expect(row.received_at).toBeGreaterThanOrEqual(before - 5);
    expect(row.received_at).toBeLessThanOrEqual(after + 5);
  });

  it('isolates per-source errors and still inserts rows from healthy sources', async () => {
    const crash: AscPagedResponse = {
      data: [feedbackResource({
        id: 'C1',
        type: 'betaFeedbackCrashSubmissions',
        attributes: { email: 'c@x.io', createdDate: '2026-05-07T18:00:00Z' },
      })],
    };
    const partialClient = {
      listBetaFeedback: async () => { throw new Error('boom'); },
      listBetaCrashFeedback: async () => crash,
      listCustomerReviews: async () => ({ data: [] }),
    } as any as AscClient;

    const result = await runPollOnce({ db, client: partialClient, appId: 'A1' });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('feedback');
    expect(result.errors[0]).toContain('boom');
    expect(result.inserted).toBe(1);
  });

  it('skips with a config error when appId is empty', async () => {
    const result = await runPollOnce({ db, client: fakeClient(), appId: '' });
    expect(result.inserted).toBe(0);
    expect(result.errors[0]).toMatch(/ASC_APP_ID/);
  });
});
