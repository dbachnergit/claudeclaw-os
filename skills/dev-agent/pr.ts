// skills/dev-agent/pr.ts
//
// Parent-owned, idempotent draft-PR opener. The LLM subprocess never reaches
// here — it only makes local commits. The push (asserted never main), the
// gh pr create (hardcoded --draft --base main), and the terminal label
// cleanup are all non-LLM code, so the never-merge/never-push-main guarantee
// holds at the process boundary. Agent-authored spec text is run through the
// deterministic egress guard before any gh body is built.

import type { Exec } from './gh.js';
import { pushBranch, swapLabel } from './gh.js';
import { scrubForEgress } from './scrub.js';

export interface OpenPrArgs {
  repo: string;
  repoDir: string;
  issue: number;
  branch: string;
  specMd: string;
  exec: Exec;
  /** Best-effort red-green narrative the agent pastes in; scrubbed, not verified. */
  testEvidence?: string;
}

function buildBody(issue: number, specMd: string, testEvidence?: string): string {
  const spec = scrubForEgress(specMd);
  const evidence = testEvidence
    ? scrubForEgress(testEvidence)
    : '_No red-green narrative supplied by the agent._';
  return [
    `Fixes #${issue}`,
    '',
    '## Approved spec',
    spec,
    '',
    '## Test evidence (agent-supplied, best-effort — not parent-verified)',
    evidence,
    '',
    '---',
    '_Opened by the autonomous dev agent. Draft PR; never auto-merged. Review before merging._',
  ].join('\n');
}

/**
 * Open (or recover) a draft PR for the issue. Idempotent across partial
 * failure:
 *  - If an open PR already exists for the head branch, return it (a prior run
 *    pushed + created; only the DB write was lost). No push/create.
 *  - Else delete any stale remote branch, push fresh, then create the draft.
 * On success, strip the terminal labels. Returns the PR URL.
 */
export async function openPr({
  repo,
  repoDir,
  issue,
  branch,
  specMd,
  exec,
  testEvidence,
}: OpenPrArgs): Promise<string> {
  if (branch === 'main') {
    throw new Error('openPr refused: head branch must never be main');
  }

  // Idempotency: an existing open PR wins.
  const list = await exec('gh', [
    'pr',
    'list',
    '--repo',
    repo,
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'url',
  ]);
  if (list.code !== 0) throw new Error(`gh pr list failed: ${list.stderr.trim()}`);
  const existing = JSON.parse(list.stdout || '[]') as Array<{ url: string }>;
  if (existing.length > 0) {
    await stripTerminalLabels(repo, issue, exec);
    return existing[0].url.trim();
  }

  // Delete any stale remote branch BEFORE pushing fresh (recovery-safe;
  // ignore "ref does not exist"), then push and create.
  await exec('git', ['-C', repoDir, 'push', 'origin', '--delete', branch]);
  await pushBranch(repoDir, branch, exec);

  const create = await exec('gh', [
    'pr',
    'create',
    '--repo',
    repo,
    '--draft',
    '--base',
    'main',
    '--head',
    branch,
    '--title',
    `[dev-agent] Fix #${issue}`,
    '--body',
    buildBody(issue, specMd, testEvidence),
  ]);
  if (create.code !== 0) throw new Error(`gh pr create failed: ${create.stderr.trim()}`);

  await stripTerminalLabels(repo, issue, exec);
  return create.stdout.trim();
}

async function stripTerminalLabels(repo: string, issue: number, exec: Exec): Promise<void> {
  await swapLabel(repo, issue, ['agent:queue', 'status:in-flight'], [], exec);
}
