import type Database from 'better-sqlite3';
import type { AscClient, AscPagedResponse, AscResource } from './client.js';

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

type SourceKind = 'feedback' | 'crash' | 'review';

interface PollSource {
  kind: SourceKind;
  type: 'testflight_feedback' | 'testflight_crash' | 'app_store_review';
  load: () => Promise<AscPagedResponse>;
}

function buildVersionLookup(included: AscResource[] | undefined): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const inc of included ?? []) {
    if (inc.type === 'builds' && inc.attributes && typeof (inc.attributes as { version?: unknown }).version === 'string') {
      lookup.set(inc.id, String((inc.attributes as { version: string }).version));
    }
  }
  return lookup;
}

function deriveText(kind: SourceKind, a: Record<string, unknown>): string {
  // App Store reviews carry both a title and a body; the title is short and
  // is part of how testers describe the issue, so prepend it. TestFlight
  // feedback uses `comment`; crash submissions sometimes have `text`.
  if (kind === 'review') {
    const title = typeof a.title === 'string' ? a.title : '';
    const body = typeof a.body === 'string' ? a.body : '';
    return title && body ? `${title}\n\n${body}` : title || body;
  }
  return (a.comment as string | undefined) ?? (a.text as string | undefined) ?? '';
}

function deriveTesterId(kind: SourceKind, a: Record<string, unknown>): string {
  // Apple exposes a tester email on TestFlight resources but only a public
  // nickname on App Store reviews (no PII surface). Phase 4's reply step
  // uses asc_id (review id) to address responses, so the nickname is just
  // for display.
  if (kind === 'review') {
    return (a.reviewerNickname as string | undefined) ?? 'anonymous';
  }
  return (a.email as string | undefined)
    ?? (a.testerEmail as string | undefined)
    ?? (a.testerId as string | undefined)
    ?? 'unknown';
}

export async function runPollOnce(opts: PollOptions): Promise<PollResult> {
  const { db, client, appId } = opts;
  const errors: string[] = [];
  let inserted = 0;
  let skipped = 0;
  if (!appId) {
    errors.push('config: ASC_APP_ID is not set; skip poll');
    return { inserted, skipped, errors };
  }
  const insert = db.prepare(`
    INSERT OR IGNORE INTO asc_feedback
      (asc_id, type, tester_id, build_version, text, screenshots_json, raw_json, status, received_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_classification', ?, ?)
  `);

  const sources: PollSource[] = [
    { kind: 'feedback', type: 'testflight_feedback', load: () => client.listBetaFeedback(appId) },
    { kind: 'crash',    type: 'testflight_crash',    load: () => client.listBetaCrashFeedback(appId) },
    { kind: 'review',   type: 'app_store_review',    load: () => client.listCustomerReviews(appId) },
  ];

  for (const src of sources) {
    try {
      const response = await src.load();
      const buildById = buildVersionLookup(response.included);

      for (const item of response.data) {
        const a = (item.attributes as Record<string, unknown> | undefined) ?? {};
        const parsed = typeof a.createdDate === 'string'
          ? Math.floor(new Date(a.createdDate).getTime() / 1000)
          : NaN;
        const receivedAt = Number.isFinite(parsed) ? parsed : Math.floor(Date.now() / 1000);
        const fetchedAt = Math.floor(Date.now() / 1000);
        const buildId = item.relationships?.build?.data?.id;
        const buildVersion = buildId ? buildById.get(buildId) ?? 'unknown' : 'unknown';
        const screenshots = Array.isArray((a as { screenshots?: unknown[] }).screenshots)
          ? (a as { screenshots: unknown[] }).screenshots
          : [];
        const result = insert.run(
          item.id,
          src.type,
          deriveTesterId(src.kind, a),
          buildVersion,
          deriveText(src.kind, a),
          JSON.stringify(screenshots),
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
