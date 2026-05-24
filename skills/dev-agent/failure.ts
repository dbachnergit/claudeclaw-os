// skills/dev-agent/failure.ts
//
// Parent-owned give-up path: a failure must be LOUD, never silent and never a
// half-baked PR. Posts a structured diagnostic comment, swaps the labels to
// agent:stuck, and Telegram-notifies. Best-effort: each step is independent
// and a failure in one never throws past a logged error, so a single broken
// step can't strand the task without notifying the operator. Agent-authored
// diagnosis text is run through the egress guard before posting.

import type { Exec } from './gh.js';
import { commentOnIssue, swapLabel } from './gh.js';
import { scrubForEgress } from './scrub.js';

export interface GiveUpArgs {
  repo: string;
  issue: number;
  /** Parent-controlled give-up cause (budget / two-strike build / review cap). */
  reason: string;
  /** Agent-authored diagnosis — SCRUBBED before posting. */
  diagnosis: string;
  exec: Exec;
  notify: (message: string) => Promise<void> | void;
  /** Agent-authored "what was tried" — SCRUBBED before posting. */
  attempted?: string;
  /** The stage it stuck at (e.g. adversarial_review). */
  stuckAt?: string;
}

function buildComment(args: GiveUpArgs): string {
  const attempted = args.attempted ? scrubForEgress(args.attempted) : '_not recorded_';
  const diagnosis = args.diagnosis ? scrubForEgress(args.diagnosis) : '_not recorded_';
  return [
    '## Autonomous dev agent gave up',
    '',
    `**What was attempted:** ${attempted}`,
    '',
    `**Diagnosis:** ${diagnosis}`,
    '',
    `**Where it stuck:** ${args.stuckAt ?? 'unknown'}`,
    '',
    `**Reason:** ${args.reason}`,
    '',
    '---',
    '_This issue now needs a human (labeled `agent:stuck`). No PR was opened._',
  ].join('\n');
}

/**
 * Give up loudly. Comment → relabel agent:stuck → notify, each best-effort.
 */
export async function giveUp(args: GiveUpArgs): Promise<void> {
  const { repo, issue, reason, exec, notify } = args;

  try {
    await commentOnIssue(repo, issue, buildComment(args), exec);
  } catch (err) {
    console.error(`[dev-agent] giveUp: failed to comment on #${issue}:`, err);
  }

  try {
    await swapLabel(repo, issue, ['status:in-flight', 'agent:queue'], ['agent:stuck'], exec);
  } catch (err) {
    console.error(`[dev-agent] giveUp: failed to relabel #${issue}:`, err);
  }

  try {
    await notify(`Dev agent gave up on issue #${issue}: ${reason}`);
  } catch (err) {
    console.error(`[dev-agent] giveUp: failed to notify for #${issue}:`, err);
  }
}
