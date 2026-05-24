// Contract test suite for the Mission Control HTTP API.
//
// Why this exists: a frontend rewrite is in progress (web/ Vite project,
// rolling out PR-by-PR). The new frontend is built against the documented
// shape of every endpoint. If the backend ever drifts from that shape —
// renames a field, changes nullability, swaps a type — the rewrite breaks
// silently. These tests pin the response shape of every endpoint family
// the new frontend depends on, so any drift fails CI before it ships.
//
// Tests use Hono's `app.request()` so no real port is opened. The DB is
// the in-memory test DB initialized via `_initTestDatabase()`.
//
// Env vars are set by `src/test-env-setup.ts` (vitest setupFiles) so they
// land BEFORE config.ts evaluates at import time.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  createDevTask,
  claimNextDevTask,
  setDevTaskSpecDrafted,
  getDevTaskById,
} from './db.js';
import { buildDashboardApp } from './dashboard.js';
import type { Hono } from 'hono';

const TOKEN = 'test-contract-token';
const Q = '?token=' + TOKEN;

let app: Hono;

beforeAll(() => {
  app = buildDashboardApp(undefined) as unknown as Hono;
});

beforeEach(() => {
  _initTestDatabase();
});

async function get(path: string) {
  return app.request(path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN);
}

async function getNoToken(path: string) {
  return app.request(path);
}

// Tests fetch JSON we only describe shape-wise — typing as `any` keeps the
// assertions readable without forcing the real interfaces into the test file.
async function jsonOf(res: Response): Promise<any> {
  return res.json();
}

describe('auth gate', () => {
  it('rejects unauthorized GET without token', async () => {
    const res = await getNoToken('/api/health');
    expect(res.status).toBe(401);
    expect(await jsonOf(res)).toMatchObject({ error: 'Unauthorized' });
  });

  it('rejects unauthorized GET with wrong token', async () => {
    const res = await app.request('/api/health?token=wrong');
    expect(res.status).toBe(401);
  });

  it('accepts GET with correct token', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
  });

  it('responds 204 to OPTIONS preflight without token check', async () => {
    const res = await app.request('/api/health', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
  });

  // Regression: the SPA shell (`<script src="/assets/...">`) has no
  // token in the URL. If the auth middleware ever gates /assets/* the
  // bundle 401s and the dashboard goes blank — the symptom Mark hit
  // when the dashboard "wouldn't load" after a previous refactor.
  // Static assets must always be reachable without a token.
  it('serves /assets/* without a token (SPA bundle would 401 otherwise)', async () => {
    // Hit a path we know won't exist on disk, just to prove the auth
    // middleware ALLOWS the request through. Whether the file exists is
    // a separate concern handled by the /assets/* handler.
    const res = await app.request('/assets/some-bundle-that-doesnt-exist.js');
    // Acceptable outcomes: 200/204 (file served), 404 (handler ran and
    // didn't find it). NOT acceptable: 401 (middleware blocked it).
    expect(res.status).not.toBe(401);
  });

  it('serves /favicon.svg without a token', async () => {
    const res = await app.request('/favicon.svg');
    expect(res.status).not.toBe(401);
  });

  // Regression: SPA shell paths must be reachable without a token so a
  // hard-refresh of a token-stripped URL still loads the frontend, which
  // can recover the token from sessionStorage. If these 401, the user
  // sees raw JSON {"error":"Unauthorized"} on every refresh — exactly
  // the bug Mark hit. The HTML these serve has no embedded secret; the
  // frontend reads token from query string then falls back to storage.
  // Every client-side wouter route must be in this list.
  for (const path of [
    '/', '/warroom', '/mission', '/scheduled', '/agents',
    '/agents/comms/files', '/chat', '/memories', '/hive', '/usage',
    '/audit', '/settings',
  ]) {
    it(`serves SPA shell at ${path} without a token`, async () => {
      const res = await app.request(path);
      expect(res.status).not.toBe(401);
    });
  }

  // Legacy mode HTML embeds DASHBOARD_TOKEN, so those variants MUST stay
  // gated even though the path is exempt at the middleware. The handler
  // does an inline check.
  it('blocks legacy /warroom?mode=picker without a token (HTML embeds token)', async () => {
    const res = await app.request('/warroom?mode=picker');
    expect(res.status).toBe(401);
  });

  it('blocks legacy /warroom?mode=voice without a token (HTML embeds token)', async () => {
    const res = await app.request('/warroom?mode=voice');
    expect(res.status).toBe(401);
  });

  it('blocks legacy /warroom/text without a token (HTML embeds token)', async () => {
    const res = await app.request('/warroom/text?meetingId=wr_test');
    expect(res.status).toBe(401);
  });

  // Regression: the CSRF middleware reads its allowed-origin host from
  // the DASHBOARD_URL env var. If it reads from process.env directly
  // (instead of the config helper that also consults the .env file),
  // the production daemon — which doesn't have process.env populated
  // from .env — 403s every cross-origin POST from the Cloudflare tunnel.
  // src/test-env-setup.ts sets DASHBOARD_URL=https://dash.test.example
  // so this test exercises the right code path.
  it('allows POSTs with Origin matching DASHBOARD_URL', async () => {
    const res = await app.request('/api/mission/tasks?token=' + TOKEN, {
      method: 'POST',
      headers: { 'origin': 'https://dash.test.example', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'csrf test', prompt: 'csrf test' }),
    });
    // 200 (created) or 400 (validation) — anything but 403 means the
    // CSRF middleware let it through, which is what we're testing.
    expect(res.status).not.toBe(403);
  });

  it('blocks POSTs from disallowed origin', async () => {
    const res = await app.request('/api/mission/tasks?token=' + TOKEN, {
      method: 'POST',
      headers: { 'origin': 'https://evil.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'csrf test', prompt: 'csrf test' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/health', () => {
  it('returns the documented shape', async () => {
    const res = await get('/api/health');
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      contextPct: expect.any(Number),
      turns: expect.any(Number),
      compactions: expect.any(Number),
      sessionAge: expect.any(String),
      model: expect.any(String),
      telegramConnected: expect.any(Boolean),
      waConnected: expect.any(Boolean),
      slackConnected: expect.any(Boolean),
      killSwitches: expect.any(Object),
      killSwitchRefusals: expect.any(Object),
      warroom: expect.objectContaining({
        textOpenMeetings: expect.any(Number),
      }),
    });
  });

  it('killSwitches contains all 6 documented flags', async () => {
    const res = await get('/api/health');
    const body = await jsonOf(res);
    expect(body.killSwitches).toMatchObject({
      WARROOM_TEXT_ENABLED: expect.any(Boolean),
      WARROOM_VOICE_ENABLED: expect.any(Boolean),
      LLM_SPAWN_ENABLED: expect.any(Boolean),
      DASHBOARD_MUTATIONS_ENABLED: expect.any(Boolean),
      MISSION_AUTO_ASSIGN_ENABLED: expect.any(Boolean),
      SCHEDULER_ENABLED: expect.any(Boolean),
    });
  });
});

describe('GET /api/info', () => {
  it('returns botName, botUsername, pid, chatId', async () => {
    const res = await get('/api/info');
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      botName: expect.any(String),
      botUsername: expect.any(String),
      pid: expect.any(Number),
    });
    expect('chatId' in body).toBe(true);
  });
});

describe('GET /api/agents', () => {
  it('returns { agents: [] } even when no agents configured', async () => {
    const res = await get('/api/agents');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ agents: expect.any(Array) });
  });

  it('always includes main as first entry when present', async () => {
    const res = await get('/api/agents');
    const body = await jsonOf(res);
    if (body.agents.length > 0) {
      expect(body.agents[0]).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        running: expect.any(Boolean),
      });
    }
  });
});

describe('GET /api/tasks (scheduled)', () => {
  it('returns { tasks: [] }', async () => {
    const res = await get('/api/tasks');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ tasks: expect.any(Array) });
  });
});

describe('GET /api/mission/tasks', () => {
  it('returns { tasks: [] }', async () => {
    const res = await get('/api/mission/tasks');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ tasks: expect.any(Array) });
  });

  it('accepts ?agent and ?status filters', async () => {
    const res = await get('/api/mission/tasks?agent=main&status=queued');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.tasks).toBeInstanceOf(Array);
  });
});

describe('GET /api/mission/history', () => {
  it('returns paginated { tasks, total }', async () => {
    const res = await get('/api/mission/history?limit=5&offset=0');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      tasks: expect.any(Array),
      total: expect.any(Number),
    });
  });
});

describe('POST /api/mission/tasks', () => {
  it('rejects missing title with 400', async () => {
    const res = await app.request('/api/mission/tasks' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'test prompt' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing prompt with 400', async () => {
    const res = await app.request('/api/mission/tasks' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'test' }),
    });
    expect(res.status).toBe(400);
  });

  it('creates task with valid input and returns full task shape', async () => {
    const res = await app.request('/api/mission/tasks' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'contract test', prompt: 'do nothing', priority: 3 }),
    });
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body.task).toMatchObject({
      id: expect.any(String),
      title: 'contract test',
      prompt: 'do nothing',
      status: 'queued',
      priority: 3,
      created_by: 'dashboard',
      created_at: expect.any(Number),
    });
  });
});

describe('GET /api/mission/tasks/auto-assign-all route ordering', () => {
  // Regression test: this endpoint was shadowed by /:id/auto-assign for
  // months because route registration order was wrong. Lock it in.
  it('returns 200, not 404, when called as a static path', async () => {
    const res = await app.request('/api/mission/tasks/auto-assign-all' + Q, {
      method: 'POST',
    });
    // Must NOT be 404. May be 200 (assigned: 0) or 400 if no agents.
    expect(res.status).not.toBe(404);
  });
});

describe('GET /api/memories', () => {
  it('returns full memory dashboard payload', async () => {
    const res = await get('/api/memories?chatId=test');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      stats: expect.objectContaining({
        total: expect.any(Number),
        pinned: expect.any(Number),
        consolidations: expect.any(Number),
      }),
      fading: expect.any(Array),
      topAccessed: expect.any(Array),
      timeline: expect.any(Array),
      consolidations: expect.any(Array),
    });
  });
});

describe('GET /api/memories/list', () => {
  it('returns paginated memory list', async () => {
    const res = await get('/api/memories/list?chatId=test&limit=10&offset=0');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      memories: expect.any(Array),
      total: expect.any(Number),
    });
  });
});

describe('GET /api/tokens', () => {
  it('returns stats + costTimeline + recentUsage', async () => {
    const res = await get('/api/tokens?chatId=test');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      stats: expect.any(Object),
      costTimeline: expect.any(Array),
      recentUsage: expect.any(Array),
    });
    expect(body.stats).toMatchObject({
      todayInput: expect.any(Number),
      todayOutput: expect.any(Number),
      todayCost: expect.any(Number),
      todayTurns: expect.any(Number),
      allTimeCost: expect.any(Number),
      allTimeTurns: expect.any(Number),
    });
  });
});

describe('GET /api/hive-mind', () => {
  it('returns { entries: [] }', async () => {
    const res = await get('/api/hive-mind');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ entries: expect.any(Array) });
  });
});

describe('GET /api/audit', () => {
  it('returns { entries, total }', async () => {
    const res = await get('/api/audit?limit=10&offset=0');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      entries: expect.any(Array),
      total: expect.any(Number),
    });
  });
});

describe('GET /api/audit/blocked', () => {
  it('returns { entries: [] }', async () => {
    const res = await get('/api/audit/blocked?limit=5');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ entries: expect.any(Array) });
  });
});

describe('GET /api/security/status', () => {
  it('returns 200 with an object', async () => {
    const res = await get('/api/security/status');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toBeInstanceOf(Object);
  });
});

describe('GET /api/chat/history', () => {
  it('rejects missing chatId with 400', async () => {
    const res = await get('/api/chat/history');
    expect(res.status).toBe(400);
  });

  it('returns { turns: [] } with chatId', async () => {
    const res = await get('/api/chat/history?chatId=test&limit=10');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ turns: expect.any(Array) });
  });
});

describe('PATCH /api/agents/:id/model', () => {
  it('rejects missing model with 400', async () => {
    const res = await app.request('/api/agents/main/model' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid model with 400', async () => {
    const res = await app.request('/api/agents/main/model' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5' }),
    });
    expect(res.status).toBe(400);
  });

  it('main response includes restartRequired: false', async () => {
    const res = await app.request('/api/agents/main/model' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      ok: true,
      agent: 'main',
      model: 'claude-sonnet-4-6',
      restartRequired: false,
    });
  });
});

describe('avatar endpoints share error shape and status semantics', () => {
  // Twelve-byte canonical PNG header — the avatar PUT handler magic-byte
  // sniffs the first four bytes, so this is enough.
  const PNG_HEADER = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]);

  it('GET, PUT, DELETE all return JSON {error} on an invalid id', async () => {
    const get = await app.request('/api/agents/has%20space/avatar' + Q);
    expect(get.status).toBe(400);
    const getBody = await jsonOf(get);
    expect(getBody).toMatchObject({ error: expect.any(String) });

    const put = await app.request('/api/agents/has%20space/avatar' + Q, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: PNG_HEADER,
    });
    expect(put.status).toBe(400);
    expect(await jsonOf(put)).toMatchObject({ error: expect.any(String) });

    const del = await app.request('/api/agents/has%20space/avatar' + Q, { method: 'DELETE' });
    expect(del.status).toBe(400);
    expect(await jsonOf(del)).toMatchObject({ error: expect.any(String) });
  });

  it('GET on an unknown agent returns 404 (not 204)', async () => {
    const res = await app.request('/api/agents/totally_made_up_agent/avatar' + Q);
    expect(res.status).toBe(404);
    expect(await jsonOf(res)).toMatchObject({ error: 'agent not found' });
  });

  it('GET on main with no avatar resolved returns 204', async () => {
    // main always "exists" per agentExists; with no bundled or mutable
    // avatar in the test env, the resolver returns null → 204.
    const res = await app.request('/api/agents/main/avatar' + Q);
    expect([200, 204]).toContain(res.status);
    if (res.status === 204) {
      expect(res.headers.get('content-type') ?? '').not.toMatch(/text\/html/);
    }
  });
});

describe('PATCH /api/dashboard/settings standup_config', () => {
  async function patchStandupConfig(value: string) {
    return app.request('/api/dashboard/settings' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'standup_config', value }),
    });
  }

  it('accepts a well-formed payload', async () => {
    const res = await patchStandupConfig(JSON.stringify({
      agents: [{ id: 'main', enabled: true }, { id: 'comms', enabled: false }],
      maxSpeakers: 5,
    }));
    expect(res.status).toBe(200);
  });

  it('rejects non-JSON value with 400', async () => {
    const res = await patchStandupConfig('not json {');
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toMatch(/standup_config/);
  });

  it('rejects agents-not-an-array with 400', async () => {
    const res = await patchStandupConfig(JSON.stringify({ agents: 'nope', maxSpeakers: 5 }));
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toMatch(/agents must be an array/);
  });

  it('rejects an agent entry without an id with 400', async () => {
    const res = await patchStandupConfig(JSON.stringify({
      agents: [{ enabled: true }],
      maxSpeakers: 5,
    }));
    expect(res.status).toBe(400);
  });

  it('rejects maxSpeakers out of [1, 8] with 400', async () => {
    const res = await patchStandupConfig(JSON.stringify({
      agents: [{ id: 'main', enabled: true }],
      maxSpeakers: 99,
    }));
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toMatch(/maxSpeakers/);
  });
});

describe('GET /api/warroom/agents', () => {
  it('returns { agents: [...] } with main present', async () => {
    const res = await get('/api/warroom/agents');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.agents).toBeInstanceOf(Array);
    expect(body.agents.length).toBeGreaterThanOrEqual(1);
    expect(body.agents[0]).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      description: expect.any(String),
    });
  });
});

describe('GET /api/warroom/pin', () => {
  it('returns { ok, agent, mode }', async () => {
    const res = await get('/api/warroom/pin');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      ok: expect.any(Boolean),
      mode: expect.any(String),
    });
  });
});

describe('GET /api/meet/sessions', () => {
  it('returns { ok, active, recent }', async () => {
    const res = await get('/api/meet/sessions');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      active: expect.any(Array),
      recent: expect.any(Array),
    });
  });
});

describe('Cache-Control on /api/*', () => {
  it('every API response carries Cache-Control: no-store', async () => {
    const res = await get('/api/health');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('Security headers on /', () => {
  it('Referrer-Policy: no-referrer is set', async () => {
    const res = await get('/api/health');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('X-Frame-Options: DENY is set', async () => {
    const res = await get('/api/health');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('X-Content-Type-Options: nosniff is set', async () => {
    const res = await get('/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

// ── Dev-agent dashboard (Task 5.12) ──────────────────────────────────
//
// The spec-approval surface. GET /dev is a data-free SPA shell served
// unauthenticated like `/` (it reads ?token= and fetches the gated API
// at runtime); never inline spec/task data. The /api/dev/* surface is
// token-gated by the global middleware. The three human-gate POSTs are
// compare-and-swap: a no-op (stale tab / double click / interleaved
// transition) returns 409 with NO side effects (no label ops). Reject is
// a human decline that strips agent:queue + status:in-flight (and does
// NOT add agent:stuck); the gh mechanism is injected so the dashboard,
// which cannot import the skill's gh.ts, stays the label-policy owner.
describe('dev dashboard API (Task 5.12)', () => {
  let devApp: Hono;
  // Records every injected label-strip so the contract test can assert the
  // EXACT label operations (and that none happen on a 409 / non-reject).
  let stripped: Array<{ issueNumber: number; labels: string[] }>;

  beforeEach(() => {
    stripped = [];
    devApp = buildDashboardApp(undefined, {
      stripIssueLabels: async (issueNumber: number, labels: string[]) => {
        stripped.push({ issueNumber, labels });
      },
    }) as unknown as Hono;
  });

  function seedSpecDrafted(
    issueNumber: number,
    opts?: { title?: string; spec?: string },
  ): string {
    const id = `dev-${issueNumber}`;
    createDevTask(id, issueNumber, opts?.title ?? `Bug #${issueNumber}`);
    claimNextDevTask(); // queued → running (diagnosing)
    setDevTaskSpecDrafted(id, opts?.spec ?? '# Spec\nApply a guard clause.');
    return id;
  }

  async function devGet(path: string, withToken = true) {
    const url = withToken
      ? path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN
      : path;
    return devApp.request(url);
  }

  async function devPost(path: string, body?: unknown, withToken = true) {
    const url = withToken
      ? path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN
      : path;
    return devApp.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  describe('GET /api/dev/tasks', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await devGet('/api/dev/tasks', false);
      expect(res.status).toBe(401);
    });

    it('returns the task list with the token', async () => {
      seedSpecDrafted(101);
      const res = await devGet('/api/dev/tasks');
      expect(res.status).toBe(200);
      const body = await jsonOf(res);
      expect(Array.isArray(body.tasks)).toBe(true);
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0]).toMatchObject({ issue_number: 101, status: 'spec_drafted' });
    });

    it('excludes cancelled tasks', async () => {
      // A cancelled (off-switch) row must not surface in the dashboard list.
      createDevTask('dev-200', 200, 'Pulled bug');
      // Move it to a terminal cancelled state via the public helper path:
      // claim then complete as cancelled.
      claimNextDevTask();
      const { completeDevTask } = await import('./db.js');
      completeDevTask('dev-200', 'cancelled');
      seedSpecDrafted(201);
      const res = await devGet('/api/dev/tasks');
      const body = await jsonOf(res);
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].issue_number).toBe(201);
    });
  });

  describe('GET /dev shell', () => {
    it('serves an HTML shell without a token (like /)', async () => {
      const res = await devGet('/dev', false);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
    });

    it('never inlines task or spec data into the shell', async () => {
      const marker = 'UNIQUE-SPEC-MARKER-deadbeef';
      seedSpecDrafted(303, { title: 'UNIQUE-TITLE-cafe', spec: `# Spec\n${marker}` });
      const res = await devGet('/dev', false);
      const html = await res.text();
      expect(html).not.toContain(marker);
      expect(html).not.toContain('UNIQUE-TITLE-cafe');
      // The shell must not embed the dashboard token either.
      expect(html).not.toContain(TOKEN);
    });
  });

  describe('POST /api/dev/tasks/:id/approve', () => {
    it('approves a spec_drafted task → spec_approved', async () => {
      const id = seedSpecDrafted(110);
      const res = await devPost(`/api/dev/tasks/${id}/approve`, {});
      expect(res.status).toBe(200);
      expect(await jsonOf(res)).toMatchObject({ ok: true, status: 'spec_approved' });
      expect(getDevTaskById(id)?.status).toBe('spec_approved');
    });

    it('returns 409 on a second approve, leaving state intact and no label ops', async () => {
      const id = seedSpecDrafted(111);
      await devPost(`/api/dev/tasks/${id}/approve`, {});
      const res = await devPost(`/api/dev/tasks/${id}/approve`, {});
      expect(res.status).toBe(409);
      expect(getDevTaskById(id)?.status).toBe('spec_approved');
      expect(stripped).toHaveLength(0);
    });

    it('requires the token', async () => {
      const id = seedSpecDrafted(112);
      const res = await devPost(`/api/dev/tasks/${id}/approve`, {}, false);
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/dev/tasks/:id/request-changes', () => {
    it('returns the task to queued and persists the notes', async () => {
      const id = seedSpecDrafted(120);
      const res = await devPost(`/api/dev/tasks/${id}/request-changes`, {
        notes: 'Prefer a guard clause over the nested if.',
      });
      expect(res.status).toBe(200);
      expect(await jsonOf(res)).toMatchObject({ ok: true, status: 'queued' });
      const row = getDevTaskById(id);
      expect(row?.status).toBe('queued');
      expect(row?.review_notes).toBe('Prefer a guard clause over the nested if.');
    });

    it('rejects empty notes with 400 and does not transition', async () => {
      const id = seedSpecDrafted(121);
      const res = await devPost(`/api/dev/tasks/${id}/request-changes`, { notes: '   ' });
      expect(res.status).toBe(400);
      expect(getDevTaskById(id)?.status).toBe('spec_drafted');
    });

    it('rejects missing notes with 400', async () => {
      const id = seedSpecDrafted(122);
      const res = await devPost(`/api/dev/tasks/${id}/request-changes`, {});
      expect(res.status).toBe(400);
    });

    it('rejects oversized notes (> 4096 bytes) with 400', async () => {
      const id = seedSpecDrafted(123);
      const res = await devPost(`/api/dev/tasks/${id}/request-changes`, {
        notes: 'x'.repeat(4097),
      });
      expect(res.status).toBe(400);
      expect(getDevTaskById(id)?.status).toBe('spec_drafted');
    });

    it('strips control chars from notes before persisting', async () => {
      const id = seedSpecDrafted(124);
      const res = await devPost(`/api/dev/tasks/${id}/request-changes`, {
        notes: 'fix\x00 the\x07 bug',
      });
      expect(res.status).toBe(200);
      expect(getDevTaskById(id)?.review_notes).toBe('fix the bug');
    });

    it('returns 409 when the task is no longer spec_drafted', async () => {
      const id = seedSpecDrafted(125);
      await devPost(`/api/dev/tasks/${id}/approve`, {}); // → spec_approved
      const res = await devPost(`/api/dev/tasks/${id}/request-changes`, { notes: 'too late' });
      expect(res.status).toBe(409);
      expect(getDevTaskById(id)?.status).toBe('spec_approved');
    });
  });

  describe('POST /api/dev/tasks/:id/reject', () => {
    it('rejects a spec_drafted task and strips exactly agent:queue + status:in-flight', async () => {
      const id = seedSpecDrafted(130);
      const res = await devPost(`/api/dev/tasks/${id}/reject`, {});
      expect(res.status).toBe(200);
      expect(await jsonOf(res)).toMatchObject({ ok: true, status: 'rejected' });
      expect(getDevTaskById(id)?.status).toBe('rejected');
      expect(stripped).toHaveLength(1);
      expect(stripped[0].issueNumber).toBe(130);
      expect(stripped[0].labels).toEqual(['agent:queue', 'status:in-flight']);
      expect(stripped[0].labels).not.toContain('agent:stuck');
    });

    it('returns 409 on a second reject with NO label side effects', async () => {
      const id = seedSpecDrafted(131);
      await devPost(`/api/dev/tasks/${id}/reject`, {});
      stripped = []; // ignore the first (legitimate) strip
      const res = await devPost(`/api/dev/tasks/${id}/reject`, {});
      expect(res.status).toBe(409);
      expect(getDevTaskById(id)?.status).toBe('rejected');
      expect(stripped).toHaveLength(0);
    });

    it('returns 409 when rejecting after request-changes (no longer spec_drafted) with no label ops', async () => {
      const id = seedSpecDrafted(132);
      await devPost(`/api/dev/tasks/${id}/request-changes`, { notes: 'redo it' }); // → queued
      const res = await devPost(`/api/dev/tasks/${id}/reject`, {});
      expect(res.status).toBe(409);
      expect(getDevTaskById(id)?.status).toBe('queued');
      expect(stripped).toHaveLength(0);
    });

    it('requires the token', async () => {
      const id = seedSpecDrafted(133);
      const res = await devPost(`/api/dev/tasks/${id}/reject`, {}, false);
      expect(res.status).toBe(401);
      expect(stripped).toHaveLength(0);
    });
  });
});
