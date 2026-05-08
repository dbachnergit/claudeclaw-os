import { describe, it, expect } from 'vitest';
import { resolveSourcePaths } from '../auto-extract-manual';

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
