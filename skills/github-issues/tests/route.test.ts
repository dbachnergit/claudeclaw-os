// Tests for the inbound-feedback approve route's request-shape contract.
//
// We deliberately test the validation helper (src/inbound-feedback-validate.ts)
// directly rather than booting the full Hono app: dashboard.ts imports the
// bot, war room, Telegram client, etc. — none of which are needed to verify
// the JSON contract this route exposes. Pulling all of that into a small
// validator test is expensive and brittle.
//
// The route itself in src/dashboard.ts is a thin wrapper around the helper
// + readEnvFile + promoteFeedbackRow. Both of those have their own tests
// (env.ts is exercised throughout the codebase; promoteFeedbackRow has its
// own tests/index.test.ts), so the only thing left to cover here is shape.

import { describe, it, expect } from 'vitest';
import {
  validateApproveRequest,
  parseFeedbackId,
} from '../../../src/inbound-feedback-validate.js';

describe('parseFeedbackId', () => {
  it('returns the number for valid integer-ish strings', () => {
    expect(parseFeedbackId('42')).toBe(42);
    expect(parseFeedbackId('1')).toBe(1);
    expect(parseFeedbackId('0')).toBe(0);
  });

  it('returns null for NaN', () => {
    expect(parseFeedbackId('abc')).toBeNull();
    expect(parseFeedbackId('not-a-number')).toBeNull();
    expect(parseFeedbackId('1.2.3')).toBeNull();
  });

  it('returns null for non-finite values', () => {
    expect(parseFeedbackId('Infinity')).toBeNull();
    expect(parseFeedbackId('-Infinity')).toBeNull();
  });
});

describe('validateApproveRequest', () => {
  const valid = {
    classification: 'bug',
    title: 'Crash when saving recording',
    body: '> some quoted feedback\n\n— tester, build 76',
  };

  it('accepts a fully-valid payload without priority', () => {
    const result = validateApproveRequest(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.classification).toBe('bug');
      expect(result.value.title).toBe('Crash when saving recording');
      expect(result.value.priority).toBeUndefined();
    }
  });

  it('accepts each of the four classifications', () => {
    for (const c of ['bug', 'feature_request', 'praise', 'confusion'] as const) {
      const result = validateApproveRequest({ ...valid, classification: c });
      expect(result.ok).toBe(true);
    }
  });

  it('accepts each of the four priorities', () => {
    for (const p of ['p0', 'p1', 'p2', 'p3'] as const) {
      const result = validateApproveRequest({ ...valid, priority: p });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.priority).toBe(p);
    }
  });

  it('treats empty-string priority as omitted', () => {
    const result = validateApproveRequest({ ...valid, priority: '' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.priority).toBeUndefined();
  });

  it('treats null priority as omitted', () => {
    const result = validateApproveRequest({ ...valid, priority: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.priority).toBeUndefined();
  });

  it('trims the title before storing', () => {
    const result = validateApproveRequest({ ...valid, title: '   Crash on save   ' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.title).toBe('Crash on save');
  });

  it('rejects a non-object body', () => {
    expect(validateApproveRequest(null).ok).toBe(false);
    expect(validateApproveRequest(undefined).ok).toBe(false);
    expect(validateApproveRequest('string').ok).toBe(false);
    expect(validateApproveRequest(42).ok).toBe(false);
  });

  it('rejects an unknown classification', () => {
    const result = validateApproveRequest({ ...valid, classification: 'urgent' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/classification/);
  });

  it('rejects a non-string classification', () => {
    const result = validateApproveRequest({ ...valid, classification: 1 });
    expect(result.ok).toBe(false);
  });

  it('rejects an empty title (after trim)', () => {
    const result = validateApproveRequest({ ...valid, title: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/title/);
  });

  it('rejects a non-string title', () => {
    const result = validateApproveRequest({ ...valid, title: 42 });
    expect(result.ok).toBe(false);
  });

  it('rejects a title longer than 255 characters', () => {
    const result = validateApproveRequest({ ...valid, title: 'a'.repeat(256) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/255/);
  });

  it('accepts a title of exactly 255 characters', () => {
    const result = validateApproveRequest({ ...valid, title: 'a'.repeat(255) });
    expect(result.ok).toBe(true);
  });

  it('rejects a non-string body', () => {
    const result = validateApproveRequest({ ...valid, body: 42 });
    expect(result.ok).toBe(false);
  });

  it('accepts an empty body string', () => {
    // The spec says "any length" — an empty body is allowed.
    const result = validateApproveRequest({ ...valid, body: '' });
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown priority value', () => {
    const result = validateApproveRequest({ ...valid, priority: 'urgent' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/priority/);
  });

  it('rejects a non-string priority', () => {
    const result = validateApproveRequest({ ...valid, priority: 1 });
    expect(result.ok).toBe(false);
  });
});
