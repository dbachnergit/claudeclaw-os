// skills/appstoreconnect/index.ts
import { readFileSync } from 'fs';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import { applySchema } from './schema.js';
import { signAscJwt, type AscCredentials } from './jwt.js';
import { AscClient } from './client.js';
import { runPollOnce, type PollResult } from './poller.js';

export interface SkillEnv {
  ANTHROPIC_API_KEY: string;
  ASC_ISSUER_ID: string;
  ASC_KEY_ID: string;
  ASC_PRIVATE_KEY_PATH: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  ASC_APP_ID: string;
}

function expandHomePath(p: string): string {
  if (p.startsWith('~/')) return homedir() + p.slice(1);
  if (p === '~') return homedir();
  return p;
}

export async function pollAscNow(env: SkillEnv, dbPath: string): Promise<PollResult> {
  const db = new Database(dbPath);
  applySchema(db);

  const creds: AscCredentials = {
    issuerId: env.ASC_ISSUER_ID,
    keyId: env.ASC_KEY_ID,
    privateKeyPem: readFileSync(expandHomePath(env.ASC_PRIVATE_KEY_PATH), 'utf8'),
  };

  const client = new AscClient({
    getToken: () => signAscJwt(creds),
  });

  try {
    const result = await runPollOnce({ db, client, appId: env.ASC_APP_ID });
    return result;
  } finally {
    db.close();
  }
}
