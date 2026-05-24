import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentError } from './errors.js';

// Mock the SDK query function before importing agent
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('./config.js', () => ({
  AGENT_MAX_TURNS: 30,
  PROJECT_ROOT: '/tmp/test',
  agentCwd: undefined,
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import fs from 'fs';
import { runAgent, runAgentWithRetry } from './agent.js';
import type { RunAgentOptions } from './agent.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockQuery = query as any;
const noop = () => {};

/**
 * Create a mock async iterable that yields events then closes.
 */
function mockQueryEvents(events: Array<Record<string, unknown>>) {
  return async function* () {
    for (const ev of events) {
      yield ev;
    }
  };
}

function resultEvent(text: string) {
  return {
    type: 'result',
    result: text,
    subtype: 'result',
    usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 500 },
    total_cost_usd: 0.01,
  };
}

describe('runAgentWithRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns result on first try when no error', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockQuery.mockReturnValue(mockQueryEvents([
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      resultEvent('Hello!'),
    ])() as any);

    const result = await runAgentWithRetry('hi', undefined, noop);
    expect(result.text).toBe('Hello!');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error and succeeds on second attempt', async () => {
    const retryableError = new AgentError('rate_limit', {
      shouldRetry: true,
      shouldNewChat: false,
      shouldSwitchModel: false,
      retryAfterMs: 100,
      userMessage: 'Rate limited. Retrying in 30s...',
    });

    let callCount = 0;
    mockQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw retryableError;
      return mockQueryEvents([
        { type: 'system', subtype: 'init', session_id: 'sess-1' },
        resultEvent('Recovered!'),
      ])();
    });

    const onRetry = vi.fn();
    const result = await runAgentWithRetry(
      'hi', undefined, noop, undefined, undefined, undefined, undefined, onRetry,
    );

    expect(result.text).toBe('Recovered!');
    expect(callCount).toBe(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.objectContaining({ category: 'rate_limit' }));
  }, 15000);

  it('does not retry non-retryable errors', async () => {
    const authError = new AgentError('auth', {
      shouldRetry: false,
      shouldNewChat: false,
      shouldSwitchModel: false,
      retryAfterMs: 0,
      userMessage: 'Auth failed',
    });

    mockQuery.mockImplementation(() => { throw authError; });

    await expect(runAgentWithRetry('hi', undefined, noop)).rejects.toThrow(AgentError);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('gives up after max retries', async () => {
    const retryableError = new AgentError('subprocess_crash', {
      shouldRetry: true,
      shouldNewChat: false,
      shouldSwitchModel: false,
      retryAfterMs: 100,
      userMessage: 'Subprocess crashed',
    });

    mockQuery.mockImplementation(() => { throw retryableError; });

    const onRetry = vi.fn();
    await expect(
      runAgentWithRetry('hi', undefined, noop, undefined, undefined, undefined, undefined, onRetry),
    ).rejects.toThrow(AgentError);

    // 1 initial + 2 retries = 3 total calls
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  }, 30000);

  it('returns aborted result when abort controller is pre-aborted', async () => {
    const abortCtrl = new AbortController();
    abortCtrl.abort();

    // The SDK returns {aborted: true} when pre-aborted, runAgent returns it directly
    mockQuery.mockReturnValue(mockQueryEvents([
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      resultEvent('partial'),
    ])() as any);

    // When abort is signalled before query, runAgent catches and returns aborted
    // We mock this by having query throw the abort-detected error
    mockQuery.mockImplementation(() => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });

    const result = await runAgentWithRetry(
      'hi', undefined, noop, undefined, undefined, abortCtrl,
    );
    expect(result.aborted).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('non-AgentError exceptions are classified then thrown', async () => {
    // The SDK throws a TypeError. runAgent wraps it via classifyError into an AgentError.
    mockQuery.mockImplementation(() => { throw new TypeError('unexpected'); });

    await expect(
      runAgentWithRetry('hi', undefined, noop),
    ).rejects.toThrow(AgentError);
    // classifyError wraps TypeError into AgentError('unknown') which is not retryable
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('uses fallback model on shouldSwitchModel errors', async () => {
    const overloadedError = new AgentError('overloaded', {
      shouldRetry: true,
      shouldNewChat: false,
      shouldSwitchModel: true,
      retryAfterMs: 100,
      userMessage: 'Overloaded',
    });

    let callCount = 0;
    const capturedModels: (string | undefined)[] = [];
    mockQuery.mockImplementation((opts: unknown) => {
      callCount++;
      const options = (opts as Record<string, unknown>)?.options as Record<string, unknown> | undefined;
      capturedModels.push(options?.model as string | undefined);
      if (callCount === 1) throw overloadedError;
      return mockQueryEvents([
        { type: 'system', subtype: 'init', session_id: 'sess-1' },
        resultEvent('Fallback worked'),
      ])();
    });

    const result = await runAgentWithRetry(
      'hi', undefined, noop, undefined,
      'claude-opus-4-6', undefined, undefined, undefined,
      ['claude-sonnet-4-6', 'claude-haiku-4-5'],
    );

    expect(result.text).toBe('Fallback worked');
    expect(capturedModels[0]).toBe('claude-opus-4-6');
    expect(capturedModels[1]).toBe('claude-sonnet-4-6');
  }, 15000);
});

// ── Task 5.8a runAgent options seam ─────────────────────────────────
// The dev agent runs inside a per-issue worktree with appended dev
// instructions and a hard tool policy. These tests prove the OPTIONS are
// WIRED into query() (not that the OS actually denies egress; that proof
// is the Task 5.14 integration smoke test, per the PRD honesty note).

const HOME = process.env.HOME ?? '/tmp';

/** Capture the single `options` object handed to query(). */
function captureQueryOptions(): { get: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  mockQuery.mockImplementation((arg: unknown) => {
    captured = ((arg as Record<string, unknown>)?.options ?? {}) as Record<string, unknown>;
    return mockQueryEvents([
      { type: 'system', subtype: 'init', session_id: 'sess-dev' },
      resultEvent('done'),
    ])();
  });
  return { get: () => captured };
}

/** Invoke the registered PreToolUse hook with a synthetic tool call. */
async function callHook(
  opts: Record<string, unknown>,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<{ permissionDecision?: string }> {
  const hooks = opts.hooks as
    | { PreToolUse?: Array<{ hooks: Array<(i: unknown, id: string, o: { signal: AbortSignal }) => Promise<unknown>> }> }
    | undefined;
  const cb = hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (!cb) throw new Error('no PreToolUse hook registered');
  const out = (await cb(
    { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, tool_use_id: 't1' },
    't1',
    { signal: new AbortController().signal },
  )) as { hookSpecificOutput?: { permissionDecision?: string } };
  return { permissionDecision: out.hookSpecificOutput?.permissionDecision };
}

const WORKTREE = '/tmp/ps-agent-worktrees/issue-42';

const DEV_OPTIONS: RunAgentOptions = {
  cwd: WORKTREE,
  appendInstructions: 'You are the dev agent. Never push.',
  mcpAllowlist: ['XcodeBuildMCP'],
  mcpToolAllowlist: [
    'mcp__XcodeBuildMCP__build_sim',
    'mcp__XcodeBuildMCP__test_sim',
    'mcp__XcodeBuildMCP__list_schemes',
    'mcp__XcodeBuildMCP__show_build_settings',
  ],
  nativeToolPolicy: {
    baseTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'TodoWrite'],
    disallowedTools: ['WebFetch', 'WebSearch'],
    deniedBashPatterns: ['git push', 'git remote', 'gh pr', 'gh issue', 'gh repo', 'gh api -X', 'gh api --method'],
    network: { allowManagedDomainsOnly: true, allowLocalBinding: true },
  },
  fsPolicy: {
    allowedRoots: [WORKTREE],
    deniedReadGlobs: ['**/.env*', '**/.ssh/**', '**/.aws/**', '**/.config/**', '**/.claude/**'],
  },
};

function runDev(options: RunAgentOptions) {
  return runAgent('fix the bug', undefined, noop, undefined, 'claude-opus-4-7', undefined, undefined, undefined, options);
}

describe('runAgent options seam (Task 5.8a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('routes cwd into query() so file ops land in the worktree', async () => {
    const opts = captureQueryOptions();
    await runDev(DEV_OPTIONS);
    expect(opts.get().cwd).toBe(WORKTREE);
  });

  it('appends dev instructions as a claude_code preset system prompt', async () => {
    const opts = captureQueryOptions();
    await runDev(DEV_OPTIONS);
    expect(opts.get().systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'You are the dev agent. Never push.',
    });
  });

  it('bounds the native tool set via SDK tools + disallowedTools (not allowedTools)', async () => {
    const opts = captureQueryOptions();
    await runDev(DEV_OPTIONS);
    expect(opts.get().tools).toEqual(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'TodoWrite']);
    expect(opts.get().disallowedTools).toEqual(['WebFetch', 'WebSearch']);
    // allowedTools is auto-approve-only and must NOT be used to bound the set
    expect(opts.get().allowedTools).toBeUndefined();
  });

  it('wires network egress confinement into sandbox.network', async () => {
    const opts = captureQueryOptions();
    await runDev(DEV_OPTIONS);
    const sandbox = opts.get().sandbox as { network?: Record<string, unknown> };
    expect(sandbox.network?.allowManagedDomainsOnly).toBe(true);
    expect(sandbox.network?.allowLocalBinding).toBe(true);
  });

  it('wires filesystem confinement into sandbox.filesystem', async () => {
    const opts = captureQueryOptions();
    await runDev(DEV_OPTIONS);
    const sandbox = opts.get().sandbox as { enabled?: boolean; filesystem?: Record<string, unknown> };
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.filesystem?.allowWrite).toEqual([WORKTREE]);
    expect(sandbox.filesystem?.denyRead).toEqual(DEV_OPTIONS.fsPolicy!.deniedReadGlobs);
  });

  it('PreToolUse hook denies remote-mutating Bash commands', async () => {
    const opts = captureQueryOptions();
    await runDev(DEV_OPTIONS);
    expect((await callHook(opts.get(), 'Bash', { command: 'git push origin main' })).permissionDecision).toBe('deny');
    expect((await callHook(opts.get(), 'Bash', { command: 'gh pr create --draft' })).permissionDecision).toBe('deny');
    expect((await callHook(opts.get(), 'Bash', { command: 'git remote add x y' })).permissionDecision).toBe('deny');
  });

  it('PreToolUse hook allows ordinary local Bash', async () => {
    const opts = captureQueryOptions();
    await runDev(DEV_OPTIONS);
    expect((await callHook(opts.get(), 'Bash', { command: 'git commit -m wip' })).permissionDecision).not.toBe('deny');
  });

  it('PreToolUse hook denies reads outside the worktree and of secret dotfiles', async () => {
    const opts = captureQueryOptions();
    await runDev(DEV_OPTIONS);
    expect((await callHook(opts.get(), 'Read', { file_path: `${HOME}/Projects/PatientScribe-AI-OS/.env` })).permissionDecision).toBe('deny');
    expect((await callHook(opts.get(), 'Bash', { command: 'cat ../.env' })).permissionDecision).toBe('deny');
    expect((await callHook(opts.get(), 'Bash', { command: 'cat ~/.ssh/id_rsa' })).permissionDecision).toBe('deny');
    expect((await callHook(opts.get(), 'Read', { file_path: '/etc/passwd' })).permissionDecision).toBe('deny');
  });

  it('PreToolUse hook allows reads and writes inside the worktree', async () => {
    const opts = captureQueryOptions();
    await runDev(DEV_OPTIONS);
    expect((await callHook(opts.get(), 'Read', { file_path: `${WORKTREE}/src/Foo.swift` })).permissionDecision).not.toBe('deny');
    expect((await callHook(opts.get(), 'Write', { file_path: `${WORKTREE}/Tests/FooTests.swift` })).permissionDecision).not.toBe('deny');
  });

  it('PreToolUse hook denies MCP tools not in the allowlist, allows build tools', async () => {
    const opts = captureQueryOptions();
    await runDev(DEV_OPTIONS);
    expect((await callHook(opts.get(), 'mcp__XcodeBuildMCP__screenshot', {})).permissionDecision).toBe('deny');
    expect((await callHook(opts.get(), 'mcp__XcodeBuildMCP__debug_attach_sim', {})).permissionDecision).toBe('deny');
    expect((await callHook(opts.get(), 'mcp__XcodeBuildMCP__build_sim', { projectPath: `${WORKTREE}/App.xcodeproj` })).permissionDecision).not.toBe('deny');
  });

  it('PreToolUse hook denies allowed MCP calls whose path args escape the worktree', async () => {
    const opts = captureQueryOptions();
    await runDev(DEV_OPTIONS);
    expect((await callHook(opts.get(), 'mcp__XcodeBuildMCP__build_sim', { projectPath: '/Users/someone/Other/App.xcodeproj' })).permissionDecision).toBe('deny');
  });

  it('mcpAllowlist filters the loaded MCP server set to the allowlist', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        mcpServers: {
          XcodeBuildMCP: { command: 'xcodebuildmcp' },
          SomeOtherServer: { command: 'other' },
        },
      }),
    );
    const opts = captureQueryOptions();
    await runDev(DEV_OPTIONS);
    const servers = opts.get().mcpServers as Record<string, unknown> | undefined;
    expect(servers).toBeDefined();
    expect(Object.keys(servers!)).toEqual(['XcodeBuildMCP']);
  });

  it('omitting options preserves current behavior (no sandbox/hooks/tool bound)', async () => {
    const opts = captureQueryOptions();
    await runAgentWithRetry('hi', undefined, noop);
    expect(opts.get().cwd).toBe('/tmp/test'); // PROJECT_ROOT fallback
    expect(opts.get().sandbox).toBeUndefined();
    expect(opts.get().hooks).toBeUndefined();
    expect(opts.get().tools).toBeUndefined();
    expect(opts.get().disallowedTools).toBeUndefined();
    expect(opts.get().systemPrompt).toBeUndefined();
  });
});
