// skills/comms-agent/runtime.ts
//
// Anthropic SDK adapter that fulfills the `runAgent: (prompt) => Promise<string>`
// seam used by `draftReplyForFeedback`. Loads the agent personality
// (agents/comms/CLAUDE.md) once at module init and uses it as the system
// prompt on every call.
//
// Why direct SDK and not `runAgent` from src/agent.ts: that primitive spawns
// a Claude Code subprocess with full MCP/tool access — overkill for a
// stateless system+user → JSON completion, and incompatible with the cron's
// "run quietly in the main process" need.

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

// Read the agent personality once at module load. The path is relative
// to the compiled .js: skills/comms-agent/runtime.js → ../../agents/comms/CLAUDE.md.
function loadSystemPrompt(): string {
  return readFileSync(join(here, '..', '..', 'agents', 'comms', 'CLAUDE.md'), 'utf8');
}

export interface RuntimeOptions {
  apiKey: string;
  /** Defaults to claude-opus-4-7. */
  model?: string;
  /** Test seam: when provided, replaces the real SDK call. */
  invoke?: (input: { system: string; userPrompt: string; model: string }) => Promise<string>;
}

export function makeRunAgent(opts: RuntimeOptions): (prompt: string) => Promise<string> {
  const model = opts.model ?? 'claude-opus-4-7';
  const system = loadSystemPrompt();

  if (opts.invoke) {
    const inject = opts.invoke;
    return (prompt: string) => inject({ system, userPrompt: prompt, model });
  }

  const client = new Anthropic({ apiKey: opts.apiKey });
  return async (prompt: string) => {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    // The SDK returns a content array; concatenate text blocks only.
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n')
      .trim();
    if (!text) throw new Error('Empty response from Anthropic API');
    return text;
  };
}
