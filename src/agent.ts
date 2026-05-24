import fs from 'fs';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  HookCallback,
  HookInput,
  HookJSONOutput,
  SandboxSettings,
} from '@anthropic-ai/claude-agent-sdk';

import { AGENT_MAX_TURNS, PROJECT_ROOT, agentCwd } from './config.js';
import { readEnvFile } from './env.js';
import { classifyError, AgentError } from './errors.js';
import { logger } from './logger.js';
import { getScrubbedSdkEnv } from './security.js';
import { requireEnabled } from './kill-switches.js';

// ── MCP server loading ──────────────────────────────────────────────
// The Agent SDK's settingSources loads CLAUDE.md and permissions from
// project/user settings, but does NOT load mcpServers from those files.
// We read them ourselves and pass them via the `mcpServers` option.

export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Merge MCP server configs from user settings (~/.claude/settings.json) and
 * project settings (.claude/settings.json in cwd), optionally filtered by
 * an allowlist (e.g. from an agent's agent.yaml `mcp_servers` field).
 *
 * Exported so the voice bridge can reuse the exact same loader the text
 * bot uses — keeping behavior consistent across channels.
 */
export function loadMcpServers(allowlist?: string[], projectCwd?: string): Record<string, McpStdioConfig> {
  const merged: Record<string, McpStdioConfig> = {};

  // Load from project settings (.claude/settings.json in cwd). `projectCwd`
  // lets callers (e.g. the voice bridge) target a specific sub-agent's
  // settings file without needing the module-level `agentCwd` to be set.
  const projectSettings = path.join(projectCwd ?? agentCwd ?? PROJECT_ROOT, '.claude', 'settings.json');
  // Load from user settings (~/.claude/settings.json)
  const userSettings = path.join(
    process.env.HOME ?? '/tmp',
    '.claude',
    'settings.json',
  );

  for (const file of [userSettings, projectSettings]) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const servers = raw?.mcpServers;
      if (servers && typeof servers === 'object') {
        for (const [name, config] of Object.entries(servers)) {
          const cfg = config as Record<string, unknown>;
          if (cfg.command && typeof cfg.command === 'string') {
            merged[name] = {
              command: cfg.command,
              ...(cfg.args ? { args: cfg.args as string[] } : {}),
              ...(cfg.env ? { env: cfg.env as Record<string, string> } : {}),
            };
          }
        }
      }
    } catch {
      // File doesn't exist or is invalid — skip
    }
  }

  // If an allowlist is provided, only keep the MCPs in that list
  if (allowlist) {
    const allowed = new Set(allowlist);
    for (const name of Object.keys(merged)) {
      if (!allowed.has(name)) delete merged[name];
    }
  }

  return merged;
}

// ── Dev-agent tool policy (Task 5.8a) ───────────────────────────────
// These types carry the dev subprocess's confinement policy from the
// caller (skills/dev-agent makeDevRunAgent) into the SDK query(). They are
// additive: existing callers omit `options` and behavior is unchanged.

/**
 * Filesystem confinement for the subprocess. `cwd` alone is NOT a sandbox
 * (a prompt-injected agent can still Read/cat absolute paths), so we feed
 * these to the SDK sandbox AND to the PreToolUse path guard.
 */
export interface FsConfinementPolicy {
  /** Absolute roots the subprocess may read/write under (the worktree). */
  allowedRoots: string[];
  /** Glob patterns that are always denied (e.g. `**\/.env*`, `**\/.ssh/**`). */
  deniedReadGlobs: string[];
}

/**
 * SDK native-tool policy. Under `bypassPermissions` the live tool-level
 * controls are `tools`/`disallowedTools` (bound the set) plus a PreToolUse
 * deny hook (block remote-mutating Bash command strings); `network` maps to
 * the OS-level sandbox.network egress block.
 */
export interface NativeToolPolicy {
  /** Base built-in tool set → SDK `tools` (NOT `allowedTools`, which is auto-approve-only). */
  baseTools?: string[];
  /** Tools removed from the model's context entirely → SDK `disallowedTools`. */
  disallowedTools?: string[];
  /** Bash command substrings that the PreToolUse hook denies. */
  deniedBashPatterns: string[];
  /** OS-level network egress confinement → sandbox.network. */
  network?: {
    allowManagedDomainsOnly?: boolean;
    allowLocalBinding?: boolean;
  };
}

/**
 * Additive options seam for `runAgent`. Carries the worktree cwd, appended
 * dev instructions, the two tool policies (MCP-server + native), and the
 * filesystem confinement. Omitted by every existing caller.
 */
export interface RunAgentOptions {
  cwd?: string;
  appendInstructions?: string;
  /** MCP server names to load (server-level; feeds loadMcpServers). */
  mcpAllowlist?: string[];
  /** Fully-qualified `mcp__*` tool names the PreToolUse hook permits. */
  mcpToolAllowlist?: string[];
  nativeToolPolicy?: NativeToolPolicy;
  fsPolicy?: FsConfinementPolicy;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
  /** True if the SDK auto-compacted context during this turn */
  didCompact: boolean;
  /** Token count before compaction (if it happened) */
  preCompactTokens: number | null;
  /**
   * The cache_read_input_tokens from the LAST API call in the turn.
   * Unlike the cumulative cacheReadInputTokens, this reflects the actual
   * context window size (cumulative overcounts on multi-step tool-use turns).
   */
  lastCallCacheRead: number;
  /**
   * The input_tokens from the LAST API call in the turn.
   * This is the actual context window size: system prompt + conversation
   * history + tool results for that call. Use this for context warnings.
   */
  lastCallInputTokens: number;
}

/** Progress event emitted during agent execution for Telegram feedback. */
export interface AgentProgressEvent {
  type: 'task_started' | 'task_completed' | 'tool_active';
  description: string;
}

/** Map SDK tool names to human-readable labels. */
const TOOL_LABELS: Record<string, string> = {
  Read: 'Reading file',
  Write: 'Writing file',
  Edit: 'Editing file',
  Bash: 'Running command',
  Grep: 'Searching code',
  Glob: 'Finding files',
  WebSearch: 'Web search',
  WebFetch: 'Fetching page',
  Agent: 'Sub-agent',
  NotebookEdit: 'Editing notebook',
  AskUserQuestion: 'User question',
};

function toolLabel(toolName: string): string {
  if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName];
  // MCP tools: mcp__server__tool → "server: tool"
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    return parts.length >= 3 ? `${parts[1]}: ${parts.slice(2).join(' ')}` : toolName;
  }
  return toolName;
}

export interface AgentResult {
  text: string | null;
  newSessionId: string | undefined;
  usage: UsageInfo | null;
  aborted?: boolean;
}

/**
 * A minimal AsyncIterable that yields a single user message then closes.
 * This is the format the Claude Agent SDK expects for its `prompt` parameter.
 * The SDK drives the agentic loop internally (tool use, multi-step reasoning)
 * and surfaces a final `result` event when done.
 */
async function* singleTurn(text: string): AsyncGenerator<{
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}> {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  };
}

// ── Dev-agent confinement enforcement (Task 5.8a) ───────────────────
// Helpers backing the PreToolUse hook and sandbox wiring. Pure, no I/O.

/** Path-shaped argument keys on MCP (XcodeBuildMCP) tool calls. */
const MCP_PATH_ARG_KEYS = [
  'projectPath',
  'workspacePath',
  'derivedDataPath',
  'outputPath',
  'resultBundlePath',
  'path',
  'file_path',
];

/**
 * Compile a glob (`**` crosses separators, `*` stays within a segment) to a
 * RegExp that matches anywhere in a path or command string. Used for the
 * secret-dotfile deny globs (`**\/.env*`, `**\/.ssh/**`, ...).
 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`(^|/)${re}$`);
}

function matchesAnyGlob(s: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(s));
}

/** True if `target` resolves to, or under, one of the allowed roots. */
function isUnderRoots(target: string, roots: string[]): boolean {
  const resolved = path.resolve(target);
  return roots.some((r) => {
    const root = path.resolve(r);
    return resolved === root || resolved.startsWith(root + path.sep);
  });
}

interface PreToolUsePolicy {
  deniedBashPatterns?: string[];
  allowedRoots?: string[];
  deniedReadGlobs?: string[];
  mcpToolAllowlist?: string[];
}

/**
 * Build the dev subprocess's PreToolUse deny hook. Fires regardless of
 * `permissionMode` (unlike `canUseTool` under bypassPermissions), so this is
 * the live tool-level control:
 *  - MCP tools must be in the allowlist; their path args must stay in-tree.
 *  - Bash command strings matching a remote-mutating pattern (or referencing
 *    a denied path) are blocked.
 *  - Read/Edit/Write outside the worktree, or of a secret dotfile, are blocked.
 */
function makePreToolUseHook(policy: PreToolUsePolicy): HookCallback {
  const deny = (reason: string): HookJSONOutput => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
  const allow: HookJSONOutput = { continue: true };

  return async (input: HookInput): Promise<HookJSONOutput> => {
    const toolName = (input as { tool_name?: string }).tool_name ?? '';
    const toolInput = ((input as { tool_input?: unknown }).tool_input ?? {}) as Record<string, unknown>;

    if (toolName.startsWith('mcp__')) {
      if (policy.mcpToolAllowlist && !policy.mcpToolAllowlist.includes(toolName)) {
        return deny(`MCP tool ${toolName} is not in the dev allowlist`);
      }
      if (policy.allowedRoots) {
        for (const key of MCP_PATH_ARG_KEYS) {
          const v = toolInput[key];
          if (typeof v === 'string' && v.length > 0 && !isUnderRoots(v, policy.allowedRoots)) {
            return deny(`MCP arg ${key} resolves outside the worktree`);
          }
        }
      }
      return allow;
    }

    if (toolName === 'Bash') {
      const cmd = typeof toolInput.command === 'string' ? toolInput.command : '';
      if (policy.deniedBashPatterns?.some((p) => cmd.includes(p))) {
        return deny('Bash command matches a denied (remote-mutating) pattern');
      }
      if (policy.deniedReadGlobs && matchesAnyGlob(cmd, policy.deniedReadGlobs)) {
        return deny('Bash command references a denied path');
      }
      return allow;
    }

    if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
      const raw = typeof toolInput.file_path === 'string'
        ? toolInput.file_path
        : typeof toolInput.path === 'string'
          ? toolInput.path
          : '';
      if (raw) {
        const abs = path.resolve(raw);
        if (policy.deniedReadGlobs && matchesAnyGlob(abs, policy.deniedReadGlobs)) {
          return deny(`Path ${raw} matches a denied glob`);
        }
        if (policy.allowedRoots && !isUnderRoots(abs, policy.allowedRoots)) {
          return deny(`Path ${raw} is outside the worktree`);
        }
      }
      return allow;
    }

    return allow;
  };
}

/**
 * Run a single user message through Claude Code and return the result.
 *
 * Uses `resume` to continue the same session across Telegram messages,
 * giving Claude persistent context without re-sending history.
 *
 * Auth: The SDK spawns the `claude` CLI subprocess which reads OAuth auth
 * from ~/.claude/ automatically (the same auth used in the terminal).
 * No explicit token needed if you're already logged in via `claude login`.
 * Optionally override with CLAUDE_CODE_OAUTH_TOKEN in .env.
 *
 * @param message    The user's text (may include transcribed voice prefix)
 * @param sessionId  Claude Code session ID to resume, or undefined for new session
 * @param onTyping   Called every TYPING_REFRESH_MS while waiting — sends typing action to Telegram
 * @param onProgress Called when sub-agents start/complete — sends status updates to Telegram
 */
export async function runAgent(
  message: string,
  sessionId: string | undefined,
  onTyping: () => void,
  onProgress?: (event: AgentProgressEvent) => void,
  model?: string,
  abortController?: AbortController,
  onStreamText?: (accumulatedText: string) => void,
  mcpAllowlist?: string[],
  options?: RunAgentOptions,
): Promise<AgentResult> {
  // Centralized kill-switch enforcement. Throws KillSwitchDisabledError if
  // LLM_SPAWN_ENABLED has been flipped off — caller is expected to surface
  // a "feature disabled" message rather than retry. This is the SINGLE
  // chokepoint for Telegram, scheduler, mission worker, and any other
  // path that ends up here; the war-room and voice paths have their own
  // requireEnabled calls at their own SDK boundaries.
  requireEnabled('LLM_SPAWN_ENABLED');

  // Read secrets from .env without polluting process.env.
  // CLAUDE_CODE_OAUTH_TOKEN is optional — the subprocess finds auth via ~/.claude/
  // automatically. Only needed if you want to override which account is used.
  const secrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  // Strip secret-shaped env vars (DASHBOARD_TOKEN, third-party API keys,
  // DB_ENCRYPTION_KEY, etc.) before handing process.env to the SDK
  // subprocess. A prompt-injected agent that calls `env` or `cat .env`
  // can otherwise read every credential the parent process holds.
  const sdkEnv = getScrubbedSdkEnv(secrets);

  let newSessionId: string | undefined;
  let resultText: string | null = null;
  let usage: UsageInfo | null = null;
  let didCompact = false;
  let preCompactTokens: number | null = null;
  let lastCallCacheRead = 0;
  let lastCallInputTokens = 0;
  let streamedText = '';

  // Refresh typing indicator on an interval while Claude works.
  // Telegram's "typing..." action expires after ~5s.
  const typingInterval = setInterval(onTyping, 4000);

  // Dev-agent seam (Task 5.8a). The options object (when present) carries the
  // worktree cwd, appended dev instructions, and the tool/filesystem policy.
  // Existing callers pass nothing, so every derived value is inert for them.
  const effectiveCwd = options?.cwd ?? agentCwd ?? PROJECT_ROOT;
  const effectiveMcpAllowlist = options?.mcpAllowlist ?? mcpAllowlist;

  const fsPolicy = options?.fsPolicy;
  const netPolicy = options?.nativeToolPolicy?.network;
  let sandbox: SandboxSettings | undefined;
  if (fsPolicy || netPolicy) {
    sandbox = {
      enabled: true,
      ...(fsPolicy
        ? { filesystem: { allowWrite: fsPolicy.allowedRoots, denyRead: fsPolicy.deniedReadGlobs } }
        : {}),
      ...(netPolicy
        ? {
            network: {
              ...(netPolicy.allowManagedDomainsOnly !== undefined
                ? { allowManagedDomainsOnly: netPolicy.allowManagedDomainsOnly }
                : {}),
              ...(netPolicy.allowLocalBinding !== undefined
                ? { allowLocalBinding: netPolicy.allowLocalBinding }
                : {}),
            },
          }
        : {}),
    };
  }

  const preToolUseHook =
    options?.nativeToolPolicy || options?.fsPolicy || options?.mcpToolAllowlist
      ? makePreToolUseHook({
          deniedBashPatterns: options.nativeToolPolicy?.deniedBashPatterns,
          allowedRoots: options.fsPolicy?.allowedRoots,
          deniedReadGlobs: options.fsPolicy?.deniedReadGlobs,
          mcpToolAllowlist: options.mcpToolAllowlist,
        })
      : undefined;

  try {
    // Load MCP servers from project + user settings files, filtered by agent
    // allowlist. The dev seam targets the worktree's .claude/settings.json via cwd.
    const mcpServers = loadMcpServers(effectiveMcpAllowlist, options?.cwd);
    const mcpServerNames = Object.keys(mcpServers);
    logger.info(
      { sessionId: sessionId ?? 'new', messageLen: message.length, mcpServers: mcpServerNames },
      'Starting agent query',
    );

    // SDK Options.mcpServers expects Record<string, McpServerConfig>
    const mcpServerSpecs = mcpServerNames.length > 0 ? mcpServers : undefined;

    for await (const event of query({
      prompt: singleTurn(message),
      options: {
        // cwd = dev worktree (seam) > agent directory > project root.
        // Claude Code loads CLAUDE.md from cwd via settingSources: ['project'].
        cwd: effectiveCwd,

        // Resume the previous session for this chat (persistent context)
        resume: sessionId,

        // 'project' loads CLAUDE.md from cwd; 'user' loads ~/.claude/skills/ and user settings
        settingSources: ['project', 'user'],

        // Dev seam: append the dev personality to the claude_code preset prompt.
        ...(options?.appendInstructions
          ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: options.appendInstructions } }
          : {}),

        // Dev seam: bound the native tool set. `tools` restricts WHICH tools
        // exist; `disallowedTools` removes them from context. `allowedTools` is
        // auto-approve-only and is deliberately NOT used here.
        ...(options?.nativeToolPolicy?.baseTools ? { tools: options.nativeToolPolicy.baseTools } : {}),
        ...(options?.nativeToolPolicy?.disallowedTools ? { disallowedTools: options.nativeToolPolicy.disallowedTools } : {}),

        // Dev seam: OS-level filesystem + network isolation for spawned Bash.
        ...(sandbox ? { sandbox } : {}),

        // Dev seam: PreToolUse deny hook (remote-mutating Bash, out-of-tree
        // reads/writes, non-allowlisted MCP tools). Fires under bypassPermissions.
        ...(preToolUseHook ? { hooks: { PreToolUse: [{ hooks: [preToolUseHook] }] } } : {}),

        // Skip all permission prompts — this is a trusted personal bot on your own machine
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,

        // Cap agentic turns to prevent runaway tool-use loops (e.g. retrying
        // stale cookies 40+ times). Configurable via AGENT_MAX_TURNS in .env.
        ...(AGENT_MAX_TURNS > 0 ? { maxTurns: AGENT_MAX_TURNS } : {}),

        // Pass secrets to the subprocess without polluting our own process.env
        env: sdkEnv,

        // MCP servers loaded from .claude/settings.json and ~/.claude/settings.json
        ...(mcpServerSpecs ? { mcpServers: mcpServerSpecs } : {}),

        // Stream partial text so Telegram can show progressive updates
        includePartialMessages: !!onStreamText,

        // Model override (e.g. 'claude-haiku-4-5', 'claude-sonnet-4-5')
        ...(model ? { model } : {}),

        // Abort support — signals the SDK to kill the subprocess
        ...(abortController ? { abortController } : {}),
      },
    })) {
      const ev = event as Record<string, unknown>;

      if (ev['type'] === 'system' && ev['subtype'] === 'init') {
        newSessionId = ev['session_id'] as string;
        logger.info({ newSessionId }, 'Session initialized');
      }

      // Detect auto-compaction (context window was getting full)
      if (ev['type'] === 'system' && ev['subtype'] === 'compact_boundary') {
        didCompact = true;
        const meta = ev['compact_metadata'] as { trigger: string; pre_tokens: number } | undefined;
        preCompactTokens = meta?.pre_tokens ?? null;
        logger.warn(
          { trigger: meta?.trigger, preCompactTokens },
          'Context window compacted',
        );
      }

      // Track per-call token usage and detect tool use from assistant message events.
      // Each assistant message represents one API call; its usage reflects
      // that single call's context size (not cumulative across the turn).
      if (ev['type'] === 'assistant') {
        const msg = ev['message'] as Record<string, unknown> | undefined;
        const msgUsage = msg?.['usage'] as Record<string, number> | undefined;
        const callCacheRead = msgUsage?.['cache_read_input_tokens'] ?? 0;
        const callInputTokens = msgUsage?.['input_tokens'] ?? 0;
        if (callCacheRead > 0) {
          lastCallCacheRead = callCacheRead;
        }
        if (callInputTokens > 0) {
          lastCallInputTokens = callInputTokens;
        }

        // Extract tool_use blocks from assistant content for progress reporting
        if (onProgress) {
          const content = msg?.['content'] as Array<{ type: string; name?: string }> | undefined;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_use' && block.name) {
                onProgress({ type: 'tool_active', description: toolLabel(block.name) });
              }
            }
          }
        }
      }

      // Sub-agent lifecycle events — surface to Telegram for user feedback
      if (ev['type'] === 'system' && ev['subtype'] === 'task_started' && onProgress) {
        const desc = (ev['description'] as string) ?? 'Sub-agent started';
        onProgress({ type: 'task_started', description: desc });
      }
      if (ev['type'] === 'system' && ev['subtype'] === 'task_notification' && onProgress) {
        const summary = (ev['summary'] as string) ?? 'Sub-agent finished';
        const status = (ev['status'] as string) ?? 'completed';
        onProgress({
          type: 'task_completed',
          description: status === 'failed' ? `Failed: ${summary}` : summary,
        });
      }

      // Stream text deltas for progressive Telegram updates.
      // Only stream the outermost assistant response (parent_tool_use_id === null)
      // to avoid showing internal tool-use reasoning.
      if (ev['type'] === 'stream_event' && onStreamText && ev['parent_tool_use_id'] === null) {
        const streamEvent = ev['event'] as Record<string, unknown> | undefined;
        if (streamEvent?.['type'] === 'content_block_delta') {
          const delta = streamEvent['delta'] as Record<string, unknown> | undefined;
          if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string') {
            streamedText += delta['text'];
            onStreamText(streamedText);
          }
        }
        if (streamEvent?.['type'] === 'message_start') {
          streamedText = '';
        }
      }

      if (ev['type'] === 'result') {
        resultText = (ev['result'] as string | null | undefined) ?? null;

        // Extract usage info from result event
        const evUsage = ev['usage'] as Record<string, number> | undefined;
        if (evUsage) {
          usage = {
            inputTokens: evUsage['input_tokens'] ?? 0,
            outputTokens: evUsage['output_tokens'] ?? 0,
            cacheReadInputTokens: evUsage['cache_read_input_tokens'] ?? 0,
            totalCostUsd: (ev['total_cost_usd'] as number) ?? 0,
            didCompact,
            preCompactTokens,
            lastCallCacheRead,
            lastCallInputTokens,
          };
          logger.info(
            {
              inputTokens: usage.inputTokens,
              cacheReadTokens: usage.cacheReadInputTokens,
              lastCallCacheRead: usage.lastCallCacheRead,
              lastCallInputTokens: usage.lastCallInputTokens,
              costUsd: usage.totalCostUsd,
              didCompact,
            },
            'Turn usage',
          );
        }

        logger.info(
          { hasResult: !!resultText, subtype: ev['subtype'] },
          'Agent result received',
        );
      }
    }
  } catch (err) {
    if (abortController?.signal.aborted) {
      logger.info('Agent query aborted by user');
      return { text: null, newSessionId, usage, aborted: true };
    }

    // Classify the error and attach context-aware metadata
    const contextTokens = lastCallInputTokens || lastCallCacheRead || 0;
    const classified = classifyError(err, contextTokens || undefined);
    logger.error(
      { category: classified.category, recovery: classified.recovery, originalMsg: (err as Error)?.message },
      'Agent query failed (classified)',
    );
    throw classified;
  } finally {
    clearInterval(typingInterval);
  }

  return { text: resultText, newSessionId, usage };
}

// ── Retry wrapper ─────────────────────────────────────────────────

const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MULTIPLIER = 4; // 2s, 8s

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the agent with automatic retry for transient errors.
 * Only retries errors where recovery.shouldRetry is true.
 * Calls onRetry before each retry so the caller can notify the user.
 */
export async function runAgentWithRetry(
  message: string,
  sessionId: string | undefined,
  onTyping: () => void,
  onProgress?: (event: AgentProgressEvent) => void,
  model?: string,
  abortController?: AbortController,
  onStreamText?: (accumulatedText: string) => void,
  onRetry?: (attempt: number, error: AgentError) => void,
  fallbackModels?: string[],
  mcpAllowlist?: string[],
): Promise<AgentResult> {
  let lastError: AgentError | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const currentModel =
        attempt === 0 ? model
        : lastError?.recovery.shouldSwitchModel && fallbackModels?.length
          ? fallbackModels[Math.min(attempt - 1, fallbackModels.length - 1)]
          : model;

      return await runAgent(
        message, sessionId, onTyping, onProgress,
        currentModel, abortController, onStreamText,
        mcpAllowlist,
      );
    } catch (err) {
      if (!(err instanceof AgentError)) throw err;
      lastError = err;

      // Don't retry non-retryable errors or if aborted
      if (!err.recovery.shouldRetry || abortController?.signal.aborted) {
        throw err;
      }

      // Don't retry past the limit
      if (attempt >= MAX_RETRIES) {
        throw err;
      }

      const delayMs = Math.min(
        BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, attempt),
        60000,
      );
      // Add jitter (0-25% of delay)
      const jitter = Math.random() * delayMs * 0.25;

      logger.warn(
        { attempt: attempt + 1, category: err.category, delayMs: Math.round(delayMs + jitter) },
        'Retrying agent query',
      );

      onRetry?.(attempt + 1, err);
      await sleep(delayMs + jitter);
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError ?? new Error('Retry loop exhausted');
}
