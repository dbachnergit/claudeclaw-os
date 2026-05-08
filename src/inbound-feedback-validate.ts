// Validation helper for the POST /api/lanes/inbound-feedback/:id/approve
// route. Lives in its own tiny module so the test suite can exercise the
// validation contract without importing the full dashboard.ts (which pulls
// in the bot, Telegram, war room, and the rest of the world).
//
// The route in src/dashboard.ts owns the env resolution and the call into
// promoteFeedbackRow; this file owns just the request-shape contract.

export type Classification = 'bug' | 'feature_request' | 'praise' | 'confusion';
export type Priority = 'p0' | 'p1' | 'p2' | 'p3';

export interface ApproveRequest {
  classification: Classification;
  title: string;
  body: string;
  priority?: Priority;
}

export type ValidateResult =
  | { ok: true; value: ApproveRequest }
  | { ok: false; error: string };

const CLASSIFICATIONS: ReadonlyArray<Classification> = [
  'bug',
  'feature_request',
  'praise',
  'confusion',
];

const PRIORITIES: ReadonlyArray<Priority> = ['p0', 'p1', 'p2', 'p3'];

/**
 * Validate the parsed JSON body of the approve route. Returns either a
 * normalized request (title trimmed) or a specific error string suitable
 * for a 400 response. Does NOT do env resolution — the caller does that
 * after this passes.
 */
export function validateApproveRequest(raw: unknown): ValidateResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'invalid body' };
  }
  const body = raw as Record<string, unknown>;

  const classification = body.classification;
  if (typeof classification !== 'string' || !CLASSIFICATIONS.includes(classification as Classification)) {
    return {
      ok: false,
      error: 'classification must be one of: bug, feature_request, praise, confusion',
    };
  }

  const title = body.title;
  if (typeof title !== 'string') {
    return { ok: false, error: 'title must be a string' };
  }
  const trimmedTitle = title.trim();
  if (trimmedTitle.length === 0) {
    return { ok: false, error: 'title cannot be empty' };
  }
  if (trimmedTitle.length > 255) {
    return { ok: false, error: 'title must be 255 characters or fewer' };
  }

  const issueBody = body.body;
  if (typeof issueBody !== 'string') {
    return { ok: false, error: 'body must be a string' };
  }

  let priority: Priority | undefined;
  if (body.priority !== undefined && body.priority !== null && body.priority !== '') {
    if (typeof body.priority !== 'string' || !PRIORITIES.includes(body.priority as Priority)) {
      return {
        ok: false,
        error: 'priority must be one of: p0, p1, p2, p3',
      };
    }
    priority = body.priority as Priority;
  }

  return {
    ok: true,
    value: {
      classification: classification as Classification,
      title: trimmedTitle,
      body: issueBody,
      priority,
    },
  };
}

/**
 * Parse the URL `:id` param. Returns null unless the input is a positive
 * integer. asc_feedback ids are AUTOINCREMENT, so 0 and negatives are
 * never valid. Floats would silently coerce inside SQLite (`WHERE id = ?`
 * truncates to int), fetching the wrong row — reject them at the boundary.
 */
export function parseFeedbackId(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}
