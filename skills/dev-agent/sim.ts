// skills/dev-agent/sim.ts
//
// Parent-owned simulator resolver + boot, used by the build-verify gate. The
// live hang root cause: the PatientScribe scheme marks its test bundle
// parallelizable, so `xcodebuild test` with a by-NAME (and ambiguous, multiple
// "iPhone 17") destination tries to CLONE and cold-boot simulators itself. That
// clone-boot path stalls under the headless launchd daemon context (idle, no
// device booted, no abort until the 30 min timeout). The deterministic fix is
// to boot ONE concrete device out-of-band here and hand xcodebuild an
// `id=<UDID>` destination, so it attaches to a ready device instead of cloning.
//
// Resolution is deliberately strict (exact-name, must be available) and LOUD on
// no match, so a misconfiguration surfaces as a give-up, never a silent hang.

import type { Exec } from './gh.js';

/** Bound the boot wait so a wedged CoreSimulator aborts to a give-up. */
export const BOOT_TIMEOUT_MS = 4 * 60 * 1000;

/** Extract the UDID from an `id=<UDID>` destination, else null. */
export function parseDestinationUdid(destination: string): string | null {
  const m = /(?:^|,)\s*id=([^,]+)/.exec(destination);
  return m ? m[1].trim() : null;
}

/** Extract the device name from a `name=<NAME>` destination, else null. */
export function parseDestinationName(destination: string): string | null {
  const m = /(?:^|,)\s*name=([^,]+)/.exec(destination);
  return m ? m[1].trim() : null;
}

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
}

/** Flatten `simctl list devices -j` runtime buckets into one device array. */
function flattenDevices(listJson: string): SimctlDevice[] {
  const parsed = JSON.parse(listJson || '{}') as { devices?: Record<string, SimctlDevice[]> };
  return Object.values(parsed.devices ?? {}).flat();
}

export interface ResolveBootArgs {
  /** The configured destination (`name=...` or already `id=...`). */
  destination: string;
  exec: Exec;
  signal?: AbortSignal;
  bootTimeoutMs?: number;
}

/**
 * Resolve the configured destination to a concrete, BOOTED device and return an
 * `id=<UDID>` destination string. A `name=` destination resolves to the first
 * AVAILABLE exact-name match from `simctl list`; an `id=` destination is used
 * as-is. The device is then booted (idempotent: an already-booted device is not
 * an error) and waited on via `bootstatus -b` so the subsequent xcodebuild
 * attaches to a ready device. Throws if the name matches no available device or
 * the boot genuinely fails.
 */
export async function resolveAndBootSimulator({
  destination,
  exec,
  signal,
  bootTimeoutMs = BOOT_TIMEOUT_MS,
}: ResolveBootArgs): Promise<string> {
  const opts = { signal, timeoutMs: bootTimeoutMs };

  let udid = parseDestinationUdid(destination);
  if (!udid) {
    const name = parseDestinationName(destination);
    if (!name) throw new Error(`cannot resolve simulator: destination has neither id= nor name= (${destination})`);

    const list = await exec('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { signal });
    if (list.code !== 0) throw new Error(`simctl list failed: ${list.stderr.trim()}`);
    const match = flattenDevices(list.stdout).find((d) => d.isAvailable && d.name === name);
    if (!match) throw new Error(`no available simulator matches name "${name}"`);
    udid = match.udid;
  }

  // Idempotent boot: an already-booted device exits non-zero with a known
  // message; that is the desired end state, not a failure.
  const boot = await exec('xcrun', ['simctl', 'boot', udid], opts);
  if (boot.code !== 0 && !/current state:\s*Booted/i.test(boot.stderr)) {
    throw new Error(`simctl boot failed for ${udid}: ${boot.stderr.trim()}`);
  }

  // Block until the device is fully booted so xcodebuild does not race a boot.
  await exec('xcrun', ['simctl', 'bootstatus', udid, '-b'], opts);

  return `id=${udid}`;
}

/** Best-effort shutdown by UDID. Tolerates an already-shutdown device. */
export async function shutdownSimulator(udid: string, exec: Exec): Promise<void> {
  await exec('xcrun', ['simctl', 'shutdown', udid]);
}
