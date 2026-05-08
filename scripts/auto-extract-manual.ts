// Auto-extract PatientScribe operating manual.
//
// Pulls source-of-truth context (CLAUDE.md, BrandFoundation.md, auto-memory,
// vault strategy notes, recent plans) and synthesizes draft operating-manual
// markdown via the Anthropic API.

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
