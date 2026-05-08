import { describe, it, expect } from 'vitest';
import { collectContextBundle, resolveSourcePaths } from '../auto-extract-manual';
import { writeFileSync, mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
});

describe('collectContextBundle', () => {
  it('reads each available source and returns a structured bundle', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aios-extract-'));
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
