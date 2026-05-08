// skills/github-issues/labels.ts
//
// Pure mapping from inbound feedback row attributes to the GitHub label
// taxonomy created on the PatientScribe repo (Phase 3.1).
//
// No I/O. No external imports. Safe to call from anywhere.

export type Source =
  | 'testflight_feedback'
  | 'testflight_crash'
  | 'app_store_review'
  | 'internal';

export type Classification = 'bug' | 'feature_request' | 'praise' | 'confusion';

export type Priority = 'p0' | 'p1' | 'p2' | 'p3';

export interface DeriveInput {
  source: Source;
  classification: Classification;
  priority?: Priority;
}

function sourceLabel(source: Source): string {
  switch (source) {
    case 'testflight_feedback':
    case 'testflight_crash':
      return 'source:testflight';
    case 'app_store_review':
      return 'source:appstore';
    case 'internal':
      return 'source:internal';
  }
}

function typeLabel(classification: Classification): string {
  switch (classification) {
    case 'bug':
      return 'type:bug';
    case 'feature_request':
      return 'type:feature';
    case 'praise':
    case 'confusion':
      return 'type:chore';
  }
}

export function deriveLabels(input: DeriveInput): string[] {
  const labels: string[] = [sourceLabel(input.source), typeLabel(input.classification)];
  if (input.priority) {
    labels.push(`priority:${input.priority}`);
  }
  return labels;
}
