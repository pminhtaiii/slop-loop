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

it("registers resource with docker port and ensures slop-loop ownership prefix", async () => {
  let passedRuntime: { resourceId?: string } | undefined;
  let passedArgv: readonly string[] = [];
  const registeredId = "slop-loop-registered-12345";
  let registerCalled = false;

  const backendWithRegister = new DockerSandboxBackend({
    readiness: () => ({ networkDisabled: true, limitsEnforced: true, readOnlyMounts: true }),
    inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
    copySnapshot: () => resolve("staging", "mount"),
    registerResource: () => {
      registerCalled = true;
      return registeredId;
    },
    run: (args, _limits, runtime) => {
      passedArgv = args;
      passedRuntime = runtime;
      return Promise.resolve({ id: registeredId, output: "", exitCode: 0 });
    },
    stopAndRemove: () => Promise.resolve("CONFIRMED"),
  });

  await backendWithRegister.executeCheck({
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

  expect(registerCalled).toBe(true);
  expect(passedRuntime?.resourceId).toBe(registeredId);
  expect(passedArgv).toContain(`slop-loop.containerId=${registeredId}`);

  // Test fallback without registerResource has slop-loop ownership prefix
  const backendWithoutRegister = new DockerSandboxBackend({
    readiness: () => ({ networkDisabled: true, limitsEnforced: true, readOnlyMounts: true }),
    inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
    copySnapshot: () => resolve("staging", "mount"),
    run: (_args, _limits, runtime) => {
      passedRuntime = runtime;
      return Promise.resolve({ id: runtime.resourceId ?? "container", output: "", exitCode: 0 });
    },
    stopAndRemove: () => Promise.resolve("CONFIRMED"),
  });

  await backendWithoutRegister.executeCheck({
    snapshot,
    image: {
      imageId: "sha256:" + "a".repeat(64),
      fingerprint: "fingerprint",
      architecture: "linux-x64",
      status: "READY",
    },
    target: {
      check: "lint",
      argv: ["pnpm", "lint"],
      profileSetId: "profiles-v1",
      targetId: "lint:lint",
      taskId: "task",
      attemptId: "attempt",
      nativeIdentity: "native",
    },
    limits: DEFAULT_SANDBOX_LIMITS,
    runtime: { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 },
  });

  expect(passedRuntime?.resourceId).toBeDefined();
  expect(passedRuntime?.resourceId).toMatch(/^slop-loop-[0-9a-f-]+$/);
});

it("validates targets against approved profiles and rejects unapproved commands", async () => {
  const backend = new DockerSandboxBackend({
    readiness: () => ({ networkDisabled: true, limitsEnforced: true, readOnlyMounts: true }),
    inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
    copySnapshot: () => resolve("staging", "mount"),
    run: () => Promise.resolve({ id: "container", output: "", exitCode: 0 }),
    stopAndRemove: () => Promise.resolve("CONFIRMED"),
  });

  const baseInput = {
    snapshot,
    image: {
      imageId: "sha256:" + "a".repeat(64),
      fingerprint: "fingerprint",
      architecture: "linux-x64",
      status: "READY" as const,
    },
    limits: DEFAULT_SANDBOX_LIMITS,
    runtime: { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 },
  };

  // Valid targets: typecheck and build
  await expect(
    backend.executeCheck({
      ...baseInput,
      target: {
        check: "typecheck",
        argv: ["pnpm", "typecheck"],
        profileSetId: "profiles-v1",
        targetId: "typecheck:typecheck",
        taskId: "task",
        attemptId: "attempt",
        nativeIdentity: "native",
      },
    }),
  ).resolves.toMatchObject({ check: "typecheck", status: "PASS" });

  await expect(
    backend.executeCheck({
      ...baseInput,
      target: {
        check: "build",
        argv: ["pnpm", "build"],
        profileSetId: "profiles-v1",
        targetId: "build:build",
        taskId: "task",
        attemptId: "attempt",
        nativeIdentity: "native",
      },
    }),
  ).resolves.toMatchObject({ check: "build", status: "PASS" });

  // Invalid targets
  await expect(
    backend.executeCheck({
      ...baseInput,
      target: {
        check: "custom",
        argv: ["pnpm", "custom"],
        profileSetId: "profiles-v1",
        targetId: "custom:custom",
        taskId: "task",
        attemptId: "attempt",
        nativeIdentity: "native",
      },
    }),
  ).rejects.toThrow("Unapproved logical verification target");

  await expect(
    backend.executeCheck({
      ...baseInput,
      target: {
        check: "tests",
        argv: ["pnpm", "test", "--all"],
        profileSetId: "profiles-v1",
        targetId: "tests:ordinary",
        taskId: "task",
        attemptId: "attempt",
        nativeIdentity: "native",
      },
    }),
  ).rejects.toThrow("Unapproved logical verification target");
});

it("records exit code and truncation state in verification evidence", async () => {
  const backend = new DockerSandboxBackend({
    readiness: () => ({ networkDisabled: true, limitsEnforced: true, readOnlyMounts: true }),
    inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
    copySnapshot: () => resolve("staging", "mount"),
    run: () => Promise.resolve({ id: "container", output: "output exceeds limit", exitCode: 1 }),
    stopAndRemove: () => Promise.resolve("CONFIRMED"),
  });

  const evidence = await backend.executeCheck({
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
    limits: { ...DEFAULT_SANDBOX_LIMITS, maxOutputBytes: 5 },
    runtime: { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 },
  });

  expect(evidence.exitCode).toBe(1);
  expect(evidence.truncated).toBe(true);
  expect(evidence.status).toBe("FAIL");
});
