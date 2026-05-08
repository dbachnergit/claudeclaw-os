// Auto-extract PatientScribe operating manual.
//
// Pulls source-of-truth context (CLAUDE.md, BrandFoundation.md, auto-memory,
// vault strategy notes, recent plans) and synthesizes draft operating-manual
// markdown via the Anthropic API.

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { glob } from 'glob';

export interface SourcePaths {
  projectClaudeMd: string;
  brandFoundation: string;
  autoMemoryDir: string;
  vaultStrategyGlob: string;
  recentPlans: string;
}

export function resolveSourcePaths(home: string): SourcePaths {
  return {
    projectClaudeMd: `${home}/Projects/PatientScribe/CLAUDE.md`,
    brandFoundation: `${home}/Projects/PatientScribe/docs/BrandFoundation.md`,
    autoMemoryDir: `${home}/.claude/projects/-Users-dbachner-Projects-PatientScribe/memory`,
    vaultStrategyGlob: `${home}/vault/projects/PatientScribe/STRATEGY_*.md`,
    recentPlans: `${home}/Projects/PatientScribe/docs/Plans`,
  };
}

export interface ContextBundle {
  projectClaudeMd: string | null;
  brandFoundation: string | null;
  autoMemoryFiles: { path: string; content: string }[];
  vaultStrategy: { path: string; content: string }[];
  recentPlans: { path: string; content: string }[];
  missingSources: string[];
}

export async function collectContextBundle(paths: SourcePaths): Promise<ContextBundle> {
  const missing: string[] = [];

  const read = (p: string, key: string): string | null => {
    if (!existsSync(p)) {
      missing.push(key);
      return null;
    }
    return readFileSync(p, 'utf8');
  };

  const readDir = (dir: string, key: string): { path: string; content: string }[] => {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      missing.push(key);
      return [];
    }
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ path: `${dir}/${f}`, content: readFileSync(`${dir}/${f}`, 'utf8') }));
  };

  const vaultMatches = await glob(paths.vaultStrategyGlob);
  const vaultStrategy = vaultMatches.map((p) => ({
    path: p,
    content: readFileSync(p, 'utf8'),
  }));
  if (vaultStrategy.length === 0) missing.push('vaultStrategyGlob');

  return {
    projectClaudeMd: read(paths.projectClaudeMd, 'projectClaudeMd'),
    brandFoundation: read(paths.brandFoundation, 'brandFoundation'),
    autoMemoryFiles: readDir(paths.autoMemoryDir, 'autoMemoryDir'),
    vaultStrategy,
    recentPlans: readDir(paths.recentPlans, 'recentPlans'),
    missingSources: missing,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Synthesis
// ─────────────────────────────────────────────────────────────────────────

// ModelClient takes the cacheable system prompt and a per-file user prompt
// as separate arguments. The real Anthropic-backed client uses prompt
// caching on the system block so the large shared context (CLAUDE.md +
// BrandFoundation + memory + strategy + plans) is paid for once across
// all five synthesis calls.
export interface ModelClient {
  complete(system: string, userPrompt: string): Promise<string>;
}

export interface OperatingManual {
  product: string;
  customers: string;
  voice: string;
  connections: string;
  decisionsBackfill: string;
}

function buildBaseContext(bundle: ContextBundle): string {
  return [
    bundle.projectClaudeMd ? `## CLAUDE.md\n${bundle.projectClaudeMd}` : '',
    bundle.brandFoundation ? `## BrandFoundation.md\n${bundle.brandFoundation}` : '',
    bundle.autoMemoryFiles.map((f) => `## ${f.path}\n${f.content}`).join('\n\n'),
    bundle.vaultStrategy.map((f) => `## ${f.path}\n${f.content}`).join('\n\n'),
    bundle.recentPlans
      .slice(-15)
      .map((f) => `## ${f.path}\n${f.content.slice(0, 4000)}`)
      .join('\n\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function synthesizeOperatingManual(
  bundle: ContextBundle,
  client: ModelClient
): Promise<OperatingManual> {
  const baseContext = buildBaseContext(bundle);

  const ask = (file: string, instruction: string) =>
    client.complete(
      baseContext,
      `Write ${file}. ${instruction}\nOutput markdown only.`
    );

  return {
    product: await ask(
      'docs/operating-manual/context/product.md',
      'Capture the product mission, the strategic north star, and the niche we serve.'
    ),
    customers: await ask(
      'docs/operating-manual/context/customers.md',
      'Describe the primary user (caregiver), the secondary user (patient), known constraints (PHI, privacy stance).'
    ),
    voice: await ask(
      'docs/operating-manual/context/voice.md',
      'Document the voice and tone rules. Include 3-5 short examples of approved phrasing and 3-5 examples of phrasing to avoid.'
    ),
    connections: await ask(
      'docs/operating-manual/connections.md',
      'List every tool, service, MCP server, skill, and external system the AI OS needs to know about. Format as a registry.'
    ),
    decisionsBackfill: await ask(
      'docs/operating-manual/decisions/log.md',
      'Backfill the decisions log with the 10 most important architectural decisions you can infer from the plans. Append-only format. Date them when known.'
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Anthropic-backed ModelClient
// ─────────────────────────────────────────────────────────────────────────

// Lazy-imported so the test suite (which only uses the stub client) does
// not need a real ANTHROPIC_API_KEY.
async function buildAnthropicClient(): Promise<ModelClient> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Add it to ~/Projects/PatientScribe-AI-OS/.env before running extract-manual.'
    );
  }
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  // Cache the large shared system context once. All five synthesis calls
  // share the same system prompt; the Anthropic API will charge cache-write
  // pricing on the first call and cache-read pricing on the four after.
  return {
    async complete(system: string, userPrompt: string): Promise<string> {
      const message = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: [
          {
            type: 'text',
            text: system,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: userPrompt }],
      });
      const text = message.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      return text;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load .env from the AI OS repo root. Importing dotenv/config has a
  // side effect of reading process.cwd()/.env, which is what we want
  // when invoked via `npm run extract-manual`.
  await import('dotenv/config');

  const { homedir } = await import('os');
  const { mkdirSync, writeFileSync } = await import('fs');

  const home = homedir();
  const paths = resolveSourcePaths(home);
  const bundle = await collectContextBundle(paths);

  if (bundle.missingSources.length) {
    console.warn(
      `Missing sources, manual will be thinner: ${bundle.missingSources.join(', ')}`
    );
  }

  const client = await buildAnthropicClient();
  const manual = await synthesizeOperatingManual(bundle, client);

  const root = `${home}/Projects/PatientScribe/docs/operating-manual`;
  mkdirSync(`${root}/context`, { recursive: true });
  mkdirSync(`${root}/decisions`, { recursive: true });
  mkdirSync(`${root}/references`, { recursive: true });

  writeFileSync(`${root}/context/product.md`, manual.product);
  writeFileSync(`${root}/context/customers.md`, manual.customers);
  writeFileSync(`${root}/context/voice.md`, manual.voice);
  writeFileSync(`${root}/connections.md`, manual.connections);
  writeFileSync(`${root}/decisions/log.md`, manual.decisionsBackfill);

  console.log(`Wrote draft manual to ${root}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
