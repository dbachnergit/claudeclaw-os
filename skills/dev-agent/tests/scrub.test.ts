import { describe, it, expect } from 'vitest';
import { scrubForEgress } from '../scrub.js';

describe('scrubForEgress', () => {
  it('passes clean technical prose through unchanged', () => {
    const clean = 'The save button crashes because the modelContext is nil on first launch.';
    expect(scrubForEgress(clean)).toBe(clean);
  });

  it('redacts PHI terms (reusing the comms-agent redactor)', () => {
    const out = scrubForEgress('Patient has type 2 diabetes and takes metformin.');
    expect(out.toLowerCase()).not.toContain('diabetes');
    expect(out).toContain('[redacted]');
  });

  it('redacts an Anthropic-style API key (reusing the secret scanner)', () => {
    const out = scrubForEgress('leaked key sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF in logs');
    expect(out).not.toContain('sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts both PHI and a secret in the same text', () => {
    const out = scrubForEgress('diabetes note; token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    expect(out.toLowerCase()).not.toContain('diabetes');
    expect(out).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    expect(out).toContain('[redacted]');
    expect(out).toContain('[REDACTED]');
  });
});
