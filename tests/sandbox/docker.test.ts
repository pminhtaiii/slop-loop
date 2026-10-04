import { resolve } from "node:path";
import { expect, it } from "vitest";

import { DockerSandboxBackend } from "../../src/sandbox/docker.js";
import { DEFAULT_SANDBOX_LIMITS } from "../../src/sandbox/config.js";
import type { VerificationSnapshot } from "../../src/sandbox/types.js";

const snapshot: VerificationSnapshot = {
  formatVersion: 1,
  workspaceId: "workspace",
  exclusionPolicyId: "default",
  entries: [{ path: "index.ts", bytes: 1, mode: 0o644, hash: "hash", content: Buffer.from("x") }],
  totalBytes: 1,
  snapshotId: "snapshot",
};

it("builds a non-root, offline, read-only Docker invocation with bounded writable mounts", async () => {
  let argv: readonly string[] = [];
  const backend = new DockerSandboxBackend({
    readiness: () => ({ networkDisabled: true, limitsEnforced: true, readOnlyMounts: true }),
    inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
    copySnapshot: () => resolve("staging", "mount"),
    run: (args) => {
      argv = args;
      return Promise.resolve({ id: "container", output: "", exitCode: 0 });
    },
    stopAndRemove: () => Promise.resolve("CONFIRMED"),
  });

  await backend.executeCheck({
    snapshot,
    image: {
      imageId: "sha256:" + "a".repeat(64),
      fingerprint: "fingerprint",
      architecture: "linux-x64",
      status: "READY",
    },
    target: {
      check: "tests",
      argv: ["pnpm", "test"],
      profileSetId: "profiles-v1",
      targetId: "tests:ordinary",
      taskId: "task",
      attemptId: "attempt",
      nativeIdentity: "native",
    },
    limits: DEFAULT_SANDBOX_LIMITS,
    runtime: { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 },
  });

  expect(argv).toEqual(
    expect.arrayContaining([
      "--user",
      "1000:1000",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--label",
      "slop-loop.owner=verification",
      "--label",
      "slop-loop.taskId=task",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=268435456",
      "--tmpfs",
      "/workspace:rw,nosuid,nodev,size=2147483648",
    ]),
  );
});

it("blocks the next run when cleanup cannot be confirmed", async () => {
  const backend = new DockerSandboxBackend({
    readiness: () => ({ networkDisabled: true, limitsEnforced: true, readOnlyMounts: true }),
    inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
    copySnapshot: () => resolve("staging", "mount"),
    run: () => Promise.resolve({ id: "container", output: "", exitCode: 0 }),
    stopAndRemove: () => Promise.resolve("UNCERTAIN"),
  });
  const input = {
    snapshot,
    image: {
      imageId: "sha256:" + "a".repeat(64),
      fingerprint: "fingerprint",
      architecture: "linux-x64",
      status: "READY" as const,
    },
    target: {
      check: "tests",
      argv: ["pnpm", "test"],
      profileSetId: "profiles-v1",
      targetId: "tests:ordinary",
      taskId: "task",
      attemptId: "attempt",
      nativeIdentity: "native",
    },
    limits: DEFAULT_SANDBOX_LIMITS,
    runtime: { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 },
  };

  await expect(backend.executeCheck(input)).resolves.toMatchObject({
    cleanup: "UNCERTAIN",
  });
  await expect(backend.executeCheck(input)).rejects.toThrow(/runtime not ready/i);
});
