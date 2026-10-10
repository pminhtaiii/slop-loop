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

it("cannot pass a process-truncated zero-exit result", async () => {
  const backend = new DockerSandboxBackend({
    readiness: () => ({ networkDisabled: true, limitsEnforced: true, readOnlyMounts: true }),
    inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
    copySnapshot: () => resolve("staging", "mount"),
    run: () =>
      Promise.resolve({
        id: "container",
        output: "é",
        exitCode: 0,
        truncated: true,
        terminationReason: "OUTPUT_LIMIT" as const,
      }),
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
      profileSetId: "profiles",
      targetId: "tests:ordinary",
      taskId: "task",
      attemptId: "attempt",
      nativeIdentity: "native",
    },
    limits: { ...DEFAULT_SANDBOX_LIMITS, maxOutputBytes: 3 },
    runtime: { signal: new AbortController().signal, deadlineAt: Date.now() + 30000 },
  });
  expect(evidence).toMatchObject({
    status: "FAIL",
    truncated: true,
    terminationReason: "OUTPUT_LIMIT",
    output: "é",
  });
});

it("cannot pass an adapter result without explicit termination and truncation metadata", async () => {
  const backend = new DockerSandboxBackend({
    readiness: () => ({ networkDisabled: true, limitsEnforced: true, readOnlyMounts: true }),
    inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
    copySnapshot: () => resolve("staging", "mount"),
    // @ts-expect-error incomplete adapter result must fail closed at runtime
    run: () => Promise.resolve({ id: "container", output: "", exitCode: 0 }),
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
      profileSetId: "profiles",
      targetId: "tests:ordinary",
      taskId: "task",
      attemptId: "attempt",
      nativeIdentity: "native",
    },
    limits: DEFAULT_SANDBOX_LIMITS,
    runtime: { signal: new AbortController().signal, deadlineAt: Date.now() + 30000 },
  });
  expect(evidence.status).toBe("FAIL");
});

it("cleans the registered resource instead of a mismatching returned identity", async () => {
  const removed: string[] = [];
  const backend = new DockerSandboxBackend({
    readiness: () => ({ networkDisabled: true, limitsEnforced: true, readOnlyMounts: true }),
    inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
    copySnapshot: () => resolve("staging", "mount"),
    registerResource: () => "registered-container",
    run: () =>
      Promise.resolve({
        id: "other-container",
        output: "",
        exitCode: 0,
        truncated: false,
        terminationReason: "EXITED" as const,
      }),
    stopAndRemove: (id) => {
      removed.push(id);
      return Promise.resolve("CONFIRMED");
    },
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
      profileSetId: "profiles",
      targetId: "tests:ordinary",
      taskId: "task",
      attemptId: "attempt",
      nativeIdentity: "native",
    },
    limits: DEFAULT_SANDBOX_LIMITS,
    runtime: { signal: new AbortController().signal, deadlineAt: Date.now() + 30000 },
  });
  expect(removed).toEqual(["registered-container"]);
});

it("builds a non-root, offline, read-only Docker invocation with bounded writable mounts", async () => {
  let argv: readonly string[] = [];
  const backend = new DockerSandboxBackend({
    readiness: () => ({ networkDisabled: true, limitsEnforced: true, readOnlyMounts: true }),
    inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
    copySnapshot: () => resolve("staging", "mount"),
    run: (args) => {
      argv = args;
      return Promise.resolve({
        id: "container",
        output: "",
        exitCode: 0,
        truncated: false,
        terminationReason: "EXITED" as const,
      });
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
      "/tmp:rw,nosuid,nodev,noexec,size=268435456,uid=1000,gid=1000,mode=0700",
      "--tmpfs",
      "/workspace:rw,nosuid,nodev,size=2147483648,uid=1000,gid=1000,mode=0700",
    ]),
  );
});

it("blocks the next run when cleanup cannot be confirmed", async () => {
  const backend = new DockerSandboxBackend({
    readiness: () => ({ networkDisabled: true, limitsEnforced: true, readOnlyMounts: true }),
    inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
    copySnapshot: () => resolve("staging", "mount"),
    run: () =>
      Promise.resolve({
        id: "container",
        output: "",
        exitCode: 0,
        truncated: false,
        terminationReason: "EXITED" as const,
      }),
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
      return Promise.resolve({
        id: registeredId,
        output: "",
        exitCode: 0,
        truncated: false,
        terminationReason: "EXITED" as const,
      });
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
      return Promise.resolve({
        id: runtime.resourceId ?? "container",
        output: "",
        exitCode: 0,
        truncated: false,
        terminationReason: "EXITED" as const,
      });
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
    run: () =>
      Promise.resolve({
        id: "container",
        output: "",
        exitCode: 0,
        truncated: false,
        terminationReason: "EXITED" as const,
      }),
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
    run: () =>
      Promise.resolve({
        id: "container",
        output: "output exceeds limit",
        exitCode: 1,
        truncated: false,
        terminationReason: "EXITED" as const,
      }),
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

it("uses a bounded writable clone layout and preserves real native-prelude metadata", async () => {
  let launched: readonly string[] = [];
  const backend = new DockerSandboxBackend({
    readiness: () => ({ networkDisabled: true, limitsEnforced: true, readOnlyMounts: true }),
    inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
    copySnapshot: () => resolve("staging", "mount"),
    run: (argv) => {
      launched = argv;
      return Promise.resolve({
        id: "container",
        output: "",
        exitCode: 0,
        truncated: false,
        terminationReason: "EXITED",
        nativePrelude: "NOT_REQUIRED",
      });
    },
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
      check: "build",
      argv: ["pnpm", "build"],
      profileSetId: "profile",
      targetId: "build:build",
      taskId: "task",
      attemptId: "attempt",
      nativeIdentity: "none",
    },
    limits: DEFAULT_SANDBOX_LIMITS,
    runtime: { signal: new AbortController().signal, deadlineAt: Date.now() + 30000 },
  });
  expect(launched[launched.indexOf("--workdir") + 1]).toBe("/workspace");
  expect(launched).toContain("--memory-swap");
  expect(launched[launched.indexOf("--memory-swap") + 1]).toBe(
    String(DEFAULT_SANDBOX_LIMITS.memoryBytes),
  );
  expect(launched).toContain("--log-driver=none");
  expect(evidence.nativePrelude).toBe("NOT_REQUIRED");
});

function checkInput(signal = new AbortController().signal) {
  return {
    snapshot,
    image: {
      imageId: "sha256:" + "a".repeat(64),
      fingerprint: "fingerprint",
      architecture: "linux-x64",
      status: "READY" as const,
    },
    target: {
      check: "build",
      argv: ["pnpm", "build"],
      profileSetId: "profile",
      targetId: "build:build",
      taskId: "task",
      attemptId: "attempt",
      nativeIdentity: "native",
    },
    limits: DEFAULT_SANDBOX_LIMITS,
    runtime: { signal, deadlineAt: Date.now() + 30000 },
  };
}
it("cleans an aborted launch without a cleanup acknowledgement and retains uncertainty", async () => {
  const controller = new AbortController();
  const removed: string[] = [];
  let released = false;
  const backend = new DockerSandboxBackend({
    readiness: () => ({ networkDisabled: true, limitsEnforced: true, readOnlyMounts: true }),
    inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
    registerResource: () => "owned-aborted-launch",
    copySnapshot: () => resolve("staging", "mount"),
    releaseSnapshot: () => {
      released = true;
      return Promise.resolve("CONFIRMED");
    },
    run: () => {
      controller.abort();
      return Promise.reject(new Error("launch cancelled after container creation"));
    },
    stopAndRemove: (id) => {
      removed.push(id);
      return Promise.resolve("UNCERTAIN");
    },
  });
  const input = checkInput(controller.signal);
  await expect(backend.executeCheck(input)).rejects.toThrow(
    "launch cancelled after container creation",
  );
  expect(removed).toEqual(["owned-aborted-launch"]);
  expect(released).toBe(false);
  expect(await backend.readiness(input.image, input.limits)).toEqual({
    status: "BLOCKED",
    reason: "CLEANUP_UNCONFIRMED",
  });
});
it("retains staging cleanup uncertainty after cancellation during materialization", async () => {
  const controller = new AbortController();
  const acknowledgements: string[] = [];
  const backend = new DockerSandboxBackend({
    readiness: () => ({ networkDisabled: true, limitsEnforced: true, readOnlyMounts: true }),
    inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
    copySnapshot: () => {
      controller.abort();
      return resolve("staging", "mount");
    },
    releaseSnapshot: () => Promise.resolve("UNCERTAIN"),
    run: () => Promise.reject(new Error("must not run")),
    stopAndRemove: () => Promise.resolve("CONFIRMED"),
  });
  const input = checkInput(controller.signal);
  await expect(
    backend.executeCheck({
      ...input,
      runtime: {
        ...input.runtime,
        cleanup: {
          hold: () => (status) => {
            acknowledgements.push(status);
            return true;
          },
        },
      },
    }),
  ).rejects.toThrow("Sandbox deadline expired");
  expect(acknowledgements).toContain("UNCERTAIN");
  expect(await backend.readiness(input.image, input.limits)).toEqual({
    status: "BLOCKED",
    reason: "CLEANUP_UNCONFIRMED",
  });
});
it("cannot classify a failed native prelude as PASS even with zero process exit", async () => {
  const backend = new DockerSandboxBackend({
    readiness: () => ({ networkDisabled: true, limitsEnforced: true, readOnlyMounts: true }),
    inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
    copySnapshot: () => resolve("staging", "mount"),
    run: () =>
      Promise.resolve({
        id: "container",
        output: "",
        exitCode: 0,
        truncated: false,
        terminationReason: "EXITED" as const,
        nativePrelude: "FAIL" as const,
      }),
    stopAndRemove: () => Promise.resolve("CONFIRMED"),
  });
  expect(await backend.executeCheck(checkInput())).toMatchObject({
    status: "FAIL",
    nativePrelude: "FAIL",
  });
});
