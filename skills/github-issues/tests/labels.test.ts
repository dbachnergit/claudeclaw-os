import { describe, it, expect } from 'vitest';
import { deriveLabels } from '../labels';

describe('deriveLabels', () => {
  it('maps testflight bug to expected labels', () => {
    expect(deriveLabels({ source: 'testflight_feedback', classification: 'bug' }))
      .toEqual(['source:testflight', 'type:bug']);
  });

  it('maps testflight_crash to source:testflight (collapses both crash and feedback)', () => {
    expect(deriveLabels({ source: 'testflight_crash', classification: 'bug' }))
      .toEqual(['source:testflight', 'type:bug']);
  });

  it('adds priority when provided', () => {
    expect(deriveLabels({ source: 'app_store_review', classification: 'feature_request', priority: 'p2' }))
      .toEqual(['source:appstore', 'type:feature', 'priority:p2']);
  });

  it('returns chore for praise', () => {
    expect(deriveLabels({ source: 'testflight_feedback', classification: 'praise' }))
      .toEqual(['source:testflight', 'type:chore']);
  });

  it('returns chore for confusion', () => {
    expect(deriveLabels({ source: 'app_store_review', classification: 'confusion' }))
      .toEqual(['source:appstore', 'type:chore']);
  });

  it('handles internal source', () => {
    expect(deriveLabels({ source: 'internal', classification: 'bug', priority: 'p0' }))
      .toEqual(['source:internal', 'type:bug', 'priority:p0']);
  });
});
