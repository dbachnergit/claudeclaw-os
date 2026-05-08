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
