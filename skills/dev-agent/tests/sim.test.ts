import { describe, it, expect, vi } from 'vitest';
import {
  parseDestinationUdid,
  parseDestinationName,
  resolveAndBootSimulator,
  shutdownSimulator,
} from '../sim.js';
import type { Exec, ExecResult } from '../gh.js';

const UDID_17 = 'SIM-UDID-17';
const UDID_17_PRO = 'SIM-UDID-17-PRO';

/** A simctl `list devices available -j` payload with two runtimes. */
const LIST_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [
      { udid: 'AAAA', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true },
      { udid: 'OLD17', name: 'iPhone 17', state: 'Shutdown', isAvailable: false },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
      { udid: UDID_17_PRO, name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true },
      { udid: UDID_17, name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
    ],
  },
});

/**
 * Routes by command so each test asserts the real simctl call sequence rather
 * than a single canned reply. `bootResult`/`listJson` let a test inject the
 * already-booted edge or a custom device set.
 */
function routedExec(opts: { listJson?: string; bootResult?: Partial<ExecResult> } = {}): Exec & ReturnType<typeof vi.fn> {
  const { listJson = LIST_JSON, bootResult = { code: 0 } } = opts;
  return vi.fn(async (cmd: string, args: string[]): Promise<ExecResult> => {
    if (cmd === 'xcrun' && args[1] === 'list') return { stdout: listJson, stderr: '', code: 0 };
    if (cmd === 'xcrun' && args[1] === 'boot') return { stdout: '', stderr: '', code: 0, ...bootResult };
    return { stdout: '', stderr: '', code: 0 };
  }) as unknown as Exec & ReturnType<typeof vi.fn>;
}

describe('parseDestinationUdid / parseDestinationName', () => {
  it('extracts the UDID from an id= destination', () => {
    expect(parseDestinationUdid(`platform=iOS Simulator,id=${UDID_17}`)).toBe(UDID_17);
    expect(parseDestinationUdid(`id=${UDID_17}`)).toBe(UDID_17);
  });

  it('returns null for a name-only destination', () => {
    expect(parseDestinationUdid('platform=iOS Simulator,name=iPhone 17')).toBeNull();
  });

  it('extracts the device name from a name= destination', () => {
    expect(parseDestinationName('platform=iOS Simulator,name=iPhone 17')).toBe('iPhone 17');
  });

  it('returns null when there is no name key', () => {
    expect(parseDestinationName(`id=${UDID_17}`)).toBeNull();
  });
});

describe('resolveAndBootSimulator', () => {
  it('resolves a name= destination to the first AVAILABLE exact-name match, boots it, and waits', async () => {
    const exec = routedExec();
    const dest = await resolveAndBootSimulator({ destination: 'platform=iOS Simulator,name=iPhone 17', exec });

    // Exact-name + available wins (skips the unavailable OLD17 and the "Pro" devices).
    expect(dest).toBe(`id=${UDID_17}`);

    const cmds = exec.mock.calls.map((c) => `${c[0]} ${c[1].join(' ')}`);
    expect(cmds.some((c) => c.startsWith('xcrun simctl list devices available'))).toBe(true);
    expect(cmds).toContain(`xcrun simctl boot ${UDID_17}`);
    // Must wait for the boot to finish so xcodebuild attaches instead of racing a boot.
    expect(cmds).toContain(`xcrun simctl bootstatus ${UDID_17} -b`);
  });

  it('passes an already-resolved id= destination straight through (no list), still booting it', async () => {
    const exec = routedExec();
    const dest = await resolveAndBootSimulator({ destination: `platform=iOS Simulator,id=${UDID_17}`, exec });

    expect(dest).toBe(`id=${UDID_17}`);
    const cmds = exec.mock.calls.map((c) => `${c[0]} ${c[1].join(' ')}`);
    expect(cmds.some((c) => c.includes('simctl list'))).toBe(false);
    expect(cmds).toContain(`xcrun simctl boot ${UDID_17}`);
  });

  it('treats an already-booted device as success (idempotent boot), not an error', async () => {
    const exec = routedExec({
      bootResult: { code: 149, stderr: 'Unable to boot device in current state: Booted' },
    });
    const dest = await resolveAndBootSimulator({ destination: 'platform=iOS Simulator,name=iPhone 17', exec });
    expect(dest).toBe(`id=${UDID_17}`);
    // Still confirms readiness after the no-op boot.
    const cmds = exec.mock.calls.map((c) => `${c[0]} ${c[1].join(' ')}`);
    expect(cmds).toContain(`xcrun simctl bootstatus ${UDID_17} -b`);
  });

  it('throws a loud error when no available device matches the name (never a silent hang)', async () => {
    const exec = routedExec({ listJson: JSON.stringify({ devices: {} }) });
    await expect(
      resolveAndBootSimulator({ destination: 'platform=iOS Simulator,name=iPhone 99', exec }),
    ).rejects.toThrow(/iPhone 99/);
  });

  it('throws when the boot genuinely fails (not the already-booted case)', async () => {
    const exec = routedExec({ bootResult: { code: 1, stderr: 'Invalid device state' } });
    await expect(
      resolveAndBootSimulator({ destination: 'platform=iOS Simulator,name=iPhone 17', exec }),
    ).rejects.toThrow(/boot/i);
  });
});

describe('shutdownSimulator', () => {
  it('shuts the device down by UDID (best-effort, tolerates already-shutdown)', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: 'Unable to shutdown device in current state: Shutdown', code: 149 })) as unknown as Exec;
    await shutdownSimulator(UDID_17, exec); // must not throw
    expect((exec as unknown as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['xcrun', ['simctl', 'shutdown', UDID_17]]);
  });
});
