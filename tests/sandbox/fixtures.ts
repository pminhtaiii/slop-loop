import {
  DEFAULT_SANDBOX_LIMITS,
  type TrustedSandboxConfiguration,
} from "../../src/sandbox/config.js";
import type {
  PreparedImageRecord,
  SandboxLimits,
  VerificationSnapshot,
} from "../../src/sandbox/types.js";

export function sandboxLimits(overrides: Partial<SandboxLimits> = {}): SandboxLimits {
  return Object.freeze({ ...DEFAULT_SANDBOX_LIMITS, ...overrides });
}

export function trustedConfiguration(
  overrides?: Partial<TrustedSandboxConfiguration>,
): TrustedSandboxConfiguration {
  return Object.freeze({
    limits: DEFAULT_SANDBOX_LIMITS,
    engine: Object.freeze({ kind: "local" as const }),
    approvedRegistries: Object.freeze(["https://registry.npmjs.org"]),
    profiles: Object.freeze({
      ordinary: Object.freeze({ argv: Object.freeze(["pnpm", "test"]) }),
    }),
    ...overrides,
  });
}

export function verificationProfile(
  overrides?: Partial<{ readonly argv: readonly string[]; readonly check: string }>,
): { readonly argv: readonly string[]; readonly check: string } {
  return Object.freeze({
    argv: Object.freeze(["pnpm", "test"]),
    check: "tests",
    ...overrides,
  });
}

export function preparedImage(overrides: Partial<PreparedImageRecord> = {}): PreparedImageRecord {
  return Object.freeze({
    imageId: "sha256:" + "a".repeat(64),
    fingerprint: "fingerprint-v1",
    architecture: "linux-x64",
    status: "READY" as const,
    ...overrides,
  });
}

export function finiteClock(start = 0) {
  let now = start;
  return Object.freeze({
    now: () => now,
    advance: (milliseconds: number) => {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
        throw new RangeError("Invalid clock advance");
      now += milliseconds;
      return now;
    },
  });
}

export function lateOutput(value: string, limit = DEFAULT_SANDBOX_LIMITS.maxOutputBytes): string {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("Invalid output limit");
  return value.slice(0, limit);
}

export function boundedOutput(value = ""): string {
  return lateOutput(value, DEFAULT_SANDBOX_LIMITS.maxOutputBytes);
}

export function controlledCheckout(
  files: Readonly<Record<string, string>> = { "index.ts": "export {}" },
): VerificationSnapshot {
  const entries = Object.entries(files).map(([path, content]) => ({
    path,
    bytes: Buffer.byteLength(content),
    mode: 0o644,
    hash: "fixture-hash",
    content: Buffer.from(content),
  }));
  return Object.freeze({
    formatVersion: 1 as const,
    workspaceId: "fixture-workspace",
    exclusionPolicyId: "fixture-exclusions-v1",
    entries: Object.freeze(entries),
    totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    snapshotId: "fixture-snapshot",
  });
}

export function artifactRegistry(artifacts: readonly string[] = ["pkg@1.0.0"]): readonly string[] {
  if (artifacts.length > 10_000) throw new RangeError("Artifact fixture is unbounded");
  return Object.freeze([...artifacts]);
}

export function ownedResource(id = "fixture-resource") {
  if (id.length === 0 || id.length > 128) throw new RangeError("Invalid resource ID");
  return Object.freeze({ id, owner: "sandbox-fixture" as const });
}
