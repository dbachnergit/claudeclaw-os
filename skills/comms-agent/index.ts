// skills/comms-agent/index.ts
//
// Entry point for the comms-agent skill. Exposes the typed contract the
// dashboard caller will use, plus the PHI redactor. The actual LLM call
// lands in Task 4.3 — this scaffold only defines the seam.

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

export async function draftReplyForFeedback(_input: DraftInput): Promise<DraftOutput> {
  throw new Error('draftReplyForFeedback not yet implemented (Task 4.3)');
}
