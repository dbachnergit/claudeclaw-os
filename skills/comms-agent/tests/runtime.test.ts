import { describe, it, expect, vi } from 'vitest';
import { makeRunAgent } from '../runtime';

describe('makeRunAgent', () => {
  it('passes the agent CLAUDE.md as system prompt and the raw prompt as userPrompt', async () => {
    const invoke = vi.fn().mockResolvedValue('ok');
    const run = makeRunAgent({ apiKey: 'unused', invoke });

    const result = await run('hello world');
    expect(result).toBe('ok');

    expect(invoke).toHaveBeenCalledTimes(1);
    const arg = invoke.mock.calls[0][0] as {
      system: string;
      userPrompt: string;
      model: string;
    };
    expect(arg.system).toContain('PHI guardrail');
    expect(arg.userPrompt).toBe('hello world');
  });

  it('defaults to claude-opus-4-7', async () => {
    const invoke = vi.fn().mockResolvedValue('ok');
    const run = makeRunAgent({ apiKey: 'unused', invoke });

    await run('anything');
    const arg = invoke.mock.calls[0][0] as { model: string };
    expect(arg.model).toBe('claude-opus-4-7');
  });

  it('honors a model override', async () => {
    const invoke = vi.fn().mockResolvedValue('ok');
    const run = makeRunAgent({ apiKey: 'unused', model: 'claude-sonnet-4-5', invoke });

    await run('anything');
    const arg = invoke.mock.calls[0][0] as { model: string };
    expect(arg.model).toBe('claude-sonnet-4-5');
  });
});
