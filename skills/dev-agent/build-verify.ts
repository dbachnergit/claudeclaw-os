// skills/dev-agent/build-verify.ts
//
// The deterministic, PARENT-executed compile + scoped-test gate the LLM
// subprocess cannot fake. The agent's own build_sim use during TDD is
// iterative feedback only; THIS is the authoritative gate that openPr is
// conditioned on. Scheme-scoping to the app target avoids the watchOS-target
// failure noted in the iOS CLAUDE.md.
//
// Warnings are diffed against a baseline captured from the PRISTINE worktree
// (origin/main, before any agent edit) so pre-existing repo warnings don't
// block every PR. Fingerprints deliberately EXCLUDE the line number, so
// editing lines above an unchanged warning doesn't make it look "new".

import type { Exec } from './gh.js';

/** iOS project, relative to the worktree root (the repo's standard layout). */
export const DEFAULT_PROJECT_PATH = 'PatientScribe/PatientScribe.xcodeproj';

/** A wedged simulator/compile must abort to a give-up, not hang devBusy. */
export const BUILD_TIMEOUT_MS = 30 * 60 * 1000;

// Compiler diagnostics: "<file>:<line>[:<col>]: warning: <message>".
const WARNING_RE = /^(.+?):\d+:(?:\d+:)?\s*warning:\s*(.+)$/;

/**
 * Line-number-insensitive warning fingerprints: `<file>:<normalized-message>`.
 * Dropping line/col means a pre-existing warning that merely shifted position
 * is still recognized as baseline, not flagged as new.
 */
export function captureWarnings(buildOutput: string): Set<string> {
  const set = new Set<string>();
  for (const raw of buildOutput.split('\n')) {
    const m = WARNING_RE.exec(raw.trim());
    if (m) {
      const file = m[1].trim();
      const message = m[2].trim();
      set.add(`${file}:${message}`);
    }
  }
  return set;
}

export interface BuildVerifyResult {
  ok: boolean;
  compiled: boolean;
  newWarnings: string[];
  testsPassed: boolean;
  reasons: string[];
}

export interface EvaluateInput {
  buildOutput: string;
  buildCode: number;
  testOutput: string;
  testCode: number;
  baselineWarnings: Set<string>;
}

/**
 * Pure verdict from captured output + exit codes. `ok` requires a clean
 * compile, ZERO warnings new relative to baseline, and passing tests.
 */
export function evaluate({
  buildOutput,
  buildCode,
  testCode,
  baselineWarnings,
}: EvaluateInput): BuildVerifyResult {
  const reasons: string[] = [];

  const compiled = buildCode === 0;
  if (!compiled) reasons.push('compile failed');

  const candidate = captureWarnings(buildOutput);
  const newWarnings = [...candidate].filter((w) => !baselineWarnings.has(w));
  if (newWarnings.length > 0) reasons.push(`new warnings (${newWarnings.length})`);

  const testsPassed = testCode === 0;
  // Only blame tests once the build actually compiled — otherwise the compile
  // failure is the real (and only) cause.
  if (compiled && !testsPassed) reasons.push('tests failed');

  const ok = compiled && newWarnings.length === 0 && testsPassed;
  return { ok, compiled, newWarnings, testsPassed, reasons };
}

export interface RunBuildVerifyArgs {
  worktreePath: string;
  scheme: string;
  simDestination: string;
  baselineWarnings: Set<string>;
  exec: Exec;
  signal?: AbortSignal;
  projectPath?: string;
}

/**
 * Parent-owned gate: scheme-scoped `xcodebuild build` then `xcodebuild test`
 * in the worktree, bounded by BUILD_TIMEOUT_MS and abortable via `signal`. A
 * failed build short-circuits the (slow) test run.
 */
export async function runBuildVerify({
  worktreePath,
  scheme,
  simDestination,
  baselineWarnings,
  exec,
  signal,
  projectPath = DEFAULT_PROJECT_PATH,
}: RunBuildVerifyArgs): Promise<BuildVerifyResult> {
  const opts = { cwd: worktreePath, timeoutMs: BUILD_TIMEOUT_MS, signal };
  const baseArgs = ['-project', projectPath, '-scheme', scheme, '-destination', simDestination];

  const build = await exec('xcodebuild', ['build', ...baseArgs], opts);
  if (build.code !== 0) {
    return evaluate({
      buildOutput: `${build.stdout}\n${build.stderr}`,
      buildCode: build.code,
      testOutput: '',
      testCode: 1,
      baselineWarnings,
    });
  }

  const test = await exec('xcodebuild', ['test', ...baseArgs], opts);
  return evaluate({
    buildOutput: `${build.stdout}\n${build.stderr}`,
    buildCode: build.code,
    testOutput: `${test.stdout}\n${test.stderr}`,
    testCode: test.code,
    baselineWarnings,
  });
}
