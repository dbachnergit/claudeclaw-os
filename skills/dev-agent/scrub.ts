// skills/dev-agent/scrub.ts
//
// Deterministic egress guard for any agent-authored text bound for GitHub
// (PR bodies, issue comments). Prompt discipline in agents/dev/CLAUDE.md is
// the hint; THIS is the control. Reuses the existing redactors rather than
// reimplementing a divergent one: redactPhi (the comms-agent 22-test PHI
// redactor) then the secret scan + redactSecrets. Applied ONLY in
// parent-owned pr.ts / failure.ts, never in the subprocess.

import { redactPhi } from '../comms-agent/phi-redact.js';
import { scanForSecrets, redactSecrets } from './secret-redact.js';

/** PHI-redact, then secret-scan-and-redact. Order: PHI first, secrets second. */
export function scrubForEgress(text: string): string {
  const phiScrubbed = redactPhi(text).redactedText;
  const secrets = scanForSecrets(phiScrubbed);
  return redactSecrets(phiScrubbed, secrets);
}
