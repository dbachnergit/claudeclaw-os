// skills/comms-agent/index.ts
//
// Entry point for the comms-agent skill. Exposes the typed contract the
// dashboard caller will use, plus the PHI redactor.
//
// `draftReplyForFeedback` does three things:
//   1. Pre-redacts the tester's text via the programmatic redactor so no raw
//      health term ever reaches the LLM.
//   2. Builds the agent prompt and calls an injected `runAgent` seam (real
//      LLM in production, stub in tests).
//   3. Parses and validates the JSON output, forcing `phi_flag = true`
//      whenever the redactor caught anything (defense in depth).

import { redactPhi } from './phi-redact.js';

export { redactPhi } from './phi-redact.js';
export type { RedactionResult } from './phi-redact.js';

export interface DraftInput {
  feedbackText: string;
  buildVersion: string;
  testerFirstName: string | null;
  /** Test/runtime seam: the caller injects how the agent prompt is executed. */
  runAgent: (prompt: string) => Promise<string>;
}

export interface DraftOutput {
  classification: 'bug' | 'feature_request' | 'praise' | 'confusion';
  draft_subject: string;
  draft_body: string;
  suggested_issue_title: string;
  suggested_issue_body: string;
  suggested_priority: 'p0' | 'p1' | 'p2' | 'p3';
  phi_flag: boolean;
  /** Mirrors RedactionResult.redactedTermsFound so downstream UI can show what was caught. */
  redacted_terms: string[];
}

const ALLOWED_CLASSIFICATIONS = ['bug', 'feature_request', 'praise', 'confusion'] as const;
const ALLOWED_PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;

type Classification = (typeof ALLOWED_CLASSIFICATIONS)[number];
type Priority = (typeof ALLOWED_PRIORITIES)[number];

/** Strip a leading/trailing markdown fence (```json ... ```) and surrounding whitespace. */
function stripFence(raw: string): string {
  let s = raw.trim();
  // Leading fence: ``` or ```json (optional newline after).
  s = s.replace(/^```(?:json)?\s*\n?/i, '');
  // Trailing fence.
  s = s.replace(/\n?```\s*$/i, '');
  return s.trim();
}

function truncateForError(s: string, max = 500): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}... [truncated, ${s.length} chars total]`;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function buildPrompt(args: {
  testerFirstName: string | null;
  buildVersion: string;
  redactedText: string;
  redactedCount: number;
}): string {
  const { testerFirstName, buildVersion, redactedText, redactedCount } = args;
  const name = testerFirstName && testerFirstName.trim().length > 0 ? testerFirstName : 'unknown';

  const lines: string[] = [];
  lines.push(
    'Inbound TestFlight feedback to draft a reply for. Health terms have already been redacted from the feedback text below; you will see [redacted] markers where they were caught. Treat each [redacted] as opaque — do not attempt to guess the original.'
  );
  lines.push('');
  lines.push(`Tester first name: ${name}`);
  lines.push(`Build version: ${buildVersion}`);
  lines.push('');
  if (redactedCount > 0) {
    lines.push(
      `Note: ${redactedCount} health-related term(s) were redacted from this feedback. The dashboard will show the human reviewer a PHI-flagged badge regardless of your phi_flag decision.`
    );
    lines.push('');
  }
  lines.push('Feedback text:');
  lines.push('"""');
  lines.push(redactedText);
  lines.push('"""');
  lines.push('');
  lines.push('Follow your agent CLAUDE.md exactly. Output the JSON only, no preamble, no markdown fence.');
  return lines.join('\n');
}

export async function draftReplyForFeedback(input: DraftInput): Promise<DraftOutput> {
  // 1. Pre-redact the tester's text. The LLM will only see the redacted version.
  const { redactedText, redactedTermsFound } = redactPhi(input.feedbackText);

  // 2. Build the prompt. Only redactedText goes in — never the original.
  const prompt = buildPrompt({
    testerFirstName: input.testerFirstName,
    buildVersion: input.buildVersion,
    redactedText,
    redactedCount: redactedTermsFound.length,
  });

  // 3. Call the injected agent seam.
  const raw = await input.runAgent(prompt);

  // 4. Strip any markdown fence and surrounding whitespace, then parse.
  const stripped = stripFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(`Failed to parse agent JSON output: ${truncateForError(stripped)}`);
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`Agent JSON output is not an object: ${truncateForError(stripped)}`);
  }

  const obj = parsed as Record<string, unknown>;

  // 5. Validate each required field with a descriptive error.
  if (!isString(obj.classification)) {
    throw new Error('Agent JSON missing required string field: classification');
  }
  if (!ALLOWED_CLASSIFICATIONS.includes(obj.classification as Classification)) {
    throw new Error(
      `Agent returned invalid classification "${obj.classification}". Must be one of: ${ALLOWED_CLASSIFICATIONS.join(', ')}`
    );
  }

  if (!isString(obj.draft_subject)) {
    throw new Error('Agent JSON missing required string field: draft_subject');
  }
  if (!isString(obj.draft_body)) {
    throw new Error('Agent JSON missing required string field: draft_body');
  }
  if (!isString(obj.suggested_issue_title)) {
    throw new Error('Agent JSON missing required string field: suggested_issue_title');
  }
  if (!isString(obj.suggested_issue_body)) {
    throw new Error('Agent JSON missing required string field: suggested_issue_body');
  }

  if (!isString(obj.suggested_priority)) {
    throw new Error('Agent JSON missing required string field: suggested_priority');
  }
  if (!ALLOWED_PRIORITIES.includes(obj.suggested_priority as Priority)) {
    throw new Error(
      `Agent returned invalid suggested_priority "${obj.suggested_priority}". Must be one of: ${ALLOWED_PRIORITIES.join(', ')}`
    );
  }

  if (!isBool(obj.phi_flag)) {
    throw new Error('Agent JSON missing required boolean field: phi_flag');
  }

  // 6. Defense in depth: if the redactor caught anything, force phi_flag=true.
  const phiFlag = obj.phi_flag || redactedTermsFound.length > 0;

  return {
    classification: obj.classification as Classification,
    draft_subject: obj.draft_subject,
    draft_body: obj.draft_body,
    suggested_issue_title: obj.suggested_issue_title,
    suggested_issue_body: obj.suggested_issue_body,
    suggested_priority: obj.suggested_priority as Priority,
    phi_flag: phiFlag,
    redacted_terms: redactedTermsFound,
  };
}
