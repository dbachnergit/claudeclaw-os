import { describe, it, expect, vi } from 'vitest';
import {
  captureWarnings,
  evaluate,
  runBuildVerify,
  DEFAULT_PROJECT_PATH,
} from '../build-verify.js';
import type { Exec, ExecResult } from '../gh.js';

const WORKTREE = '/Users/x/Projects/ps-agent-worktrees/issue-42';
const SCHEME = 'PatientScribe';
const DEST = 'platform=iOS Simulator,name=iPhone 16';

const warnAt = (line: number) =>
  `/repo/PatientScribe/Foo.swift:${line}:10: warning: variable 'x' was never used; consider replacing with '_'`;

function stubExec(result: Partial<ExecResult> = {}): Exec & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ stdout: '', stderr: '', code: 0, ...result })) as unknown as Exec &
    ReturnType<typeof vi.fn>;
}

describe('captureWarnings', () => {
  it('extracts a line-number-insensitive fingerprint per compiler warning', () => {
    const fps = captureWarnings(warnAt(42));
    expect(fps.size).toBe(1);
    expect([...fps][0]).toContain('/repo/PatientScribe/Foo.swift');
    expect([...fps][0]).toContain("variable 'x' was never used");
    expect([...fps][0]).not.toContain('42');
  });

  it('produces the SAME fingerprint when the same warning shifts line number', () => {
    const a = captureWarnings(warnAt(42));
    const b = captureWarnings(warnAt(88));
    expect([...a]).toEqual([...b]);
  });

  it('returns an empty set for clean output', () => {
    expect(captureWarnings('Build succeeded\n** BUILD SUCCEEDED **').size).toBe(0);
  });
});

describe('evaluate', () => {
  const baseline = captureWarnings(warnAt(42));

  it('is ok for a clean compile and green tests', () => {
    const r = evaluate({ buildOutput: '', buildCode: 0, testOutput: '', testCode: 0, baselineWarnings: new Set() });
    expect(r.ok).toBe(true);
    expect(r.compiled).toBe(true);
    expect(r.testsPassed).toBe(true);
    expect(r.newWarnings).toEqual([]);
  });

  it('is ok when a warning is present in the baseline (not new)', () => {
    const r = evaluate({ buildOutput: warnAt(42), buildCode: 0, testOutput: '', testCode: 0, baselineWarnings: baseline });
    expect(r.ok).toBe(true);
    expect(r.newWarnings).toEqual([]);
  });

  it('is ok when the same baseline warning re-emits at a shifted line', () => {
    const r = evaluate({ buildOutput: warnAt(88), buildCode: 0, testOutput: '', testCode: 0, baselineWarnings: baseline });
    expect(r.ok).toBe(true);
    expect(r.newWarnings).toEqual([]);
  });

  it('is NOT ok when a warning absent from the baseline appears', () => {
    const newWarn = `/repo/PatientScribe/Bar.swift:5:1: warning: unused result of call to foo()`;
    const r = evaluate({ buildOutput: newWarn, buildCode: 0, testOutput: '', testCode: 0, baselineWarnings: baseline });
    expect(r.ok).toBe(false);
    expect(r.newWarnings).toHaveLength(1);
    expect(r.reasons.join(' ')).toMatch(/warning/i);
  });

  it('is NOT ok when a test fails', () => {
    const r = evaluate({ buildOutput: '', buildCode: 0, testOutput: 'Test Suite failed', testCode: 65, baselineWarnings: new Set() });
    expect(r.ok).toBe(false);
    expect(r.testsPassed).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/test/i);
  });

  it('is NOT ok when the compile exits non-zero', () => {
    const r = evaluate({ buildOutput: 'error: cannot find type', buildCode: 65, testOutput: '', testCode: 0, baselineWarnings: new Set() });
    expect(r.ok).toBe(false);
    expect(r.compiled).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/compile/i);
  });
});

describe('runBuildVerify', () => {
  it('shells scheme-scoped xcodebuild build then test in the worktree, threading the signal', async () => {
    const exec = stubExec({ code: 0 });
    const ac = new AbortController();
    await runBuildVerify({
      worktreePath: WORKTREE,
      scheme: SCHEME,
      simDestination: DEST,
      baselineWarnings: new Set(),
      exec,
      signal: ac.signal,
    });

    expect(exec.mock.calls[0][0]).toBe('xcodebuild');
    expect(exec.mock.calls[0][1]).toEqual([
      'build',
      '-project',
      DEFAULT_PROJECT_PATH,
      '-scheme',
      SCHEME,
      '-destination',
      DEST,
    ]);
    expect(exec.mock.calls[1][1]).toEqual([
      'test',
      '-project',
      DEFAULT_PROJECT_PATH,
      '-scheme',
      SCHEME,
      '-destination',
      DEST,
    ]);
    // Both run in the worktree, bounded, and abortable.
    const opts = exec.mock.calls[0][2] as { cwd?: string; timeoutMs?: number; signal?: AbortSignal };
    expect(opts.cwd).toBe(WORKTREE);
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(opts.signal).toBe(ac.signal);
  });

  it('skips the test run and reports failure when the build fails', async () => {
    const exec = stubExec({ code: 65, stderr: 'error: build failed' });
    const r = await runBuildVerify({
      worktreePath: WORKTREE,
      scheme: SCHEME,
      simDestination: DEST,
      baselineWarnings: new Set(),
      exec,
    });
    expect(exec).toHaveBeenCalledTimes(1); // build only; test skipped
    expect(r.ok).toBe(false);
    expect(r.compiled).toBe(false);
  });

  it('is ok end-to-end for a clean build + green tests with no new warnings', async () => {
    const exec = stubExec({ code: 0, stdout: 'Build succeeded' });
    const r = await runBuildVerify({
      worktreePath: WORKTREE,
      scheme: SCHEME,
      simDestination: DEST,
      baselineWarnings: new Set(),
      exec,
    });
    expect(r.ok).toBe(true);
  });
});
