import { afterEach, describe, it, expect } from 'vitest';
import {
  collectContextBundle,
  resolveSourcePaths,
  stripCodeFenceWrapper,
  synthesizeOperatingManual,
} from '../auto-extract-manual';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempHomes: string[] = [];
afterEach(() => {
  while (tempHomes.length) {
    const dir = tempHomes.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('auto-extract-manual config', () => {
  it('returns absolute paths to all known PatientScribe context sources', () => {
    const home = '/Users/dbachner';
    const paths = resolveSourcePaths(home);
    expect(paths.projectClaudeMd).toBe(`${home}/Projects/PatientScribe/CLAUDE.md`);
    expect(paths.brandFoundation).toContain('BrandFoundation.md');
    expect(paths.autoMemoryDir).toBe(
      `${home}/.claude/projects/-Users-dbachner-Projects-PatientScribe/memory`
    );
    expect(paths.vaultStrategyGlob).toBe(
      `${home}/vault/projects/PatientScribe/STRATEGY_*.md`
    );
    expect(paths.recentPlans).toBe(`${home}/Projects/PatientScribe/docs/Plans`);
  });

  it('derives the auto-memory slug from home rather than hardcoding it', () => {
    const paths = resolveSourcePaths('/Users/alice');
    expect(paths.autoMemoryDir).toBe(
      '/Users/alice/.claude/projects/-Users-alice-Projects-PatientScribe/memory'
    );
  });
});

describe('collectContextBundle', () => {
  it('reads each available source and returns a structured bundle', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aios-extract-'));
    tempHomes.push(home);
    mkdirSync(`${home}/Projects/PatientScribe/docs`, { recursive: true });
    writeFileSync(`${home}/Projects/PatientScribe/CLAUDE.md`, '# Project handbook\nMission: X');
    writeFileSync(
      `${home}/Projects/PatientScribe/docs/BrandFoundation.md`,
      '## Voice\nWarm, direct'
    );

    const paths = resolveSourcePaths(home);
    const bundle = await collectContextBundle(paths);

    expect(bundle.projectClaudeMd).toContain('Mission: X');
    expect(bundle.brandFoundation).toContain('Warm, direct');
    expect(bundle.missingSources).toEqual(
      expect.arrayContaining(['autoMemoryDir', 'vaultStrategyGlob', 'recentPlans'])
    );
  });
});

describe('stripCodeFenceWrapper', () => {
  it('strips a single outer ```markdown fence', () => {
    const wrapped = '```markdown\n# Hello\n\nBody text.\n```';
    expect(stripCodeFenceWrapper(wrapped)).toBe('# Hello\n\nBody text.\n');
  });

  it('strips a bare ``` fence', () => {
    const wrapped = '```\n# Hello\n```';
    expect(stripCodeFenceWrapper(wrapped)).toBe('# Hello\n');
  });

  it('leaves un-fenced content unchanged', () => {
    const plain = '# Hello\n\nBody text.\n';
    expect(stripCodeFenceWrapper(plain)).toBe(plain);
  });

  it('does not strip an inner fence in regular markdown', () => {
    const inner = '# Title\n\n```ts\nconst x = 1;\n```\n';
    expect(stripCodeFenceWrapper(inner)).toBe(inner);
  });
});

describe('synthesizeOperatingManual', () => {
  it('produces a manual object with all required files populated', async () => {
    const stubClient = {
      complete: async (_system: string, userPrompt: string) => {
        if (userPrompt.includes('product.md'))
          return '# Product\nPatient appointment intelligence';
        if (userPrompt.includes('customers.md')) return '# Customers\nCaregivers';
        if (userPrompt.includes('voice.md')) return '# Voice\nWarm, direct';
        if (userPrompt.includes('connections.md')) return '# Connections\n- gh\n- supabase';
        if (userPrompt.includes('decisions/log.md'))
          return '## 2026-04-29 V2 design system\nDecision: ...';
        return '';
      },
    };
    const bundle = {
      projectClaudeMd: '# Handbook',
      brandFoundation: '## Voice rules',
      autoMemoryFiles: [],
      vaultStrategy: [],
      recentPlans: [],
      missingSources: [],
    };
    const manual = await synthesizeOperatingManual(bundle, stubClient);
    expect(manual.product).toContain('appointment intelligence');
    expect(manual.customers).toContain('Caregivers');
    expect(manual.voice).toContain('Warm');
    expect(manual.connections).toContain('gh');
    expect(manual.decisionsBackfill).toContain('2026-04-29');
  });
});
