/**
 * One-off: populate asc_feedback.build_version for rows where it's
 * "unknown" by re-fetching betaFeedbackScreenshotSubmissions /
 * betaFeedbackCrashSubmissions with ?include=build and matching by
 * asc_id. Safe to run multiple times.
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { signAscJwt, type AscCredentials } from '../skills/appstoreconnect/jwt.js';
import { AscClient } from '../skills/appstoreconnect/client.js';
import { readEnvFile } from '../src/env.js';

const env = readEnvFile(['ASC_ISSUER_ID', 'ASC_KEY_ID', 'ASC_PRIVATE_KEY_PATH', 'ASC_APP_ID']);
const expandHomePath = (p: string) => p.startsWith('~/') ? homedir() + p.slice(1) : p;
const creds: AscCredentials = {
  issuerId: env.ASC_ISSUER_ID,
  keyId: env.ASC_KEY_ID,
  privateKeyPem: readFileSync(expandHomePath(env.ASC_PRIVATE_KEY_PATH), 'utf8'),
};
const client = new AscClient({ getToken: () => signAscJwt(creds) });
const db = new Database(path.resolve('store/claudeclaw.db'));

const sources = [
  { type: 'testflight_feedback', loader: () => client.listBetaFeedback(env.ASC_APP_ID) },
  { type: 'testflight_crash', loader: () => client.listBetaCrashFeedback(env.ASC_APP_ID) },
] as const;

const update = db.prepare(`UPDATE asc_feedback SET build_version = ? WHERE asc_id = ? AND build_version = 'unknown'`);
let updated = 0;

for (const src of sources) {
  const response = await src.loader();
  const buildById = new Map<string, string>();
  for (const inc of response.included ?? []) {
    if (inc.type === 'builds' && typeof (inc.attributes as any)?.version === 'string') {
      buildById.set(inc.id, String((inc.attributes as any).version));
    }
  }
  for (const item of response.data) {
    const buildId = item.relationships?.build?.data?.id;
    if (!buildId) continue;
    const version = buildById.get(buildId);
    if (!version) continue;
    const result = update.run(version, item.id);
    updated += result.changes;
  }
}

console.log(`Backfilled build_version on ${updated} row(s)`);
db.close();
