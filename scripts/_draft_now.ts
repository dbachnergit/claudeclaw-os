/**
 * One-off: run the comms-agent draft pass once against
 * ./store/claudeclaw.db, drafting all pending_classification rows that
 * don't already have a draft. Useful for manual backfill before Task 4.6
 * (dashboard) ships, or after a long downtime where the cron skipped.
 *
 * Reads ANTHROPIC_API_KEY via readEnvFile (same path as the cron) so it
 * does not require process.env to be populated.
 */
import path from 'path';
import { readEnvFile } from '../src/env.js';
import { processPendingFeedback, makeRunAgent } from '../skills/comms-agent/index.js';

const env = readEnvFile(['ANTHROPIC_API_KEY']);
if (!env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set in .env — refusing to run');
  process.exit(1);
}

const dbPath = path.resolve('store/claudeclaw.db');
const runAgent = makeRunAgent({ apiKey: env.ANTHROPIC_API_KEY });

const result = await processPendingFeedback({
  dbPath,
  runAgent,
  logger: {
    info: (...args: unknown[]) => console.log('[info]', ...args),
    error: (...args: unknown[]) => console.error('[error]', ...args),
  },
});

console.log(JSON.stringify(result, null, 2));
