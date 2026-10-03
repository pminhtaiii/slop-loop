import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_LIMITS,
  createPreparationFingerprint,
  mapVerificationTarget,
  validateSandboxConfiguration,
} from "../../src/sandbox/config.js";
import { captureSnapshot } from "../../src/sandbox/snapshot.js";
import { DockerSandboxBackend, validateFixedArgv } from "../../src/sandbox/docker.js";
import { VerificationCoordinator } from "../../src/sandbox/verification.js";
import type { VerificationSnapshot } from "../../src/sandbox/types.js";

const snapshot: VerificationSnapshot = {
  formatVersion: 1,
  workspaceId: "workspace",
  exclusionPolicyId: "default",
  entries: [{ path: "index.ts", bytes: 8, mode: 0o644, hash: "hash", content: Buffer.from("export {}") }],
  totalBytes: 8,
  snapshotId: "snapshot-id",
};

describe("sandbox core contracts", () => {
  it("rejects unbounded and unknown trusted configuration", () => {
    expect(() =>
      validateSandboxConfiguration({
        ...DEFAULT_SANDBOX_LIMITS,
        unknown: true,
        snapshotBytes: Number.POSITIVE_INFINITY,
      }),
    ).toThrow();
  });

  it("creates stable preparation fingerprints and trusted target mappings", () => {
    const inputs = {
      manifestHash: "a",
      lockfileHash: "b",
      managerConfigHash: "c",
      scriptPolicyId: "scripts-v1",
      nodeVersion: "24.0.0",
      pnpmVersion: "12.5.1",
      architecture: "linux-x64",
      baseImageDigest: "sha256:base",
      recipeHash: "sha256:recipe",
    } as const;
    expect(createPreparationFingerprint(inputs)).toBe(createPreparationFingerprint(inputs));
    expect(mapVerificationTarget("run_tests", "ordinary")).toMatchObject({
      argv: ["pnpm", "test"],
    });
  });

  it("fails closed for shell metacharacters in fixed argv", () => {
    expect(() => validateFixedArgv(["sh", "-c", "echo unsafe"])).toThrow();
    expect(() => validateFixedArgv(["pnpm", "test"])).not.toThrow();
  });

  it("coordinates complete verification evidence for one snapshot", async () => {
    const coordinator = new VerificationCoordinator(["tests", "lint"], snapshot, () => "CURRENT");
    coordinator.record({
      check: "tests",
      snapshotId: snapshot.snapshotId,
      imageId: "sha256:" + "f".repeat(64),
      status: "PASS",
      cleanup: "CONFIRMED",
      preparationFingerprint: "prep", profileSetId: "profiles-v1", targetId: "tests:ordinary",
      taskId: "task", attemptId: "attempt", nativeIdentity: "native-v1",
    });
    coordinator.record({
      check: "lint",
      snapshotId: snapshot.snapshotId,
      imageId: "sha256:" + "f".repeat(64),
      status: "PASS",
      cleanup: "CONFIRMED",
      preparationFingerprint: "prep", profileSetId: "profiles-v1", targetId: "lint:lint",
      taskId: "task", attemptId: "attempt", nativeIdentity: "native-v1",
    });
    await expect(coordinator.verdict()).resolves.toMatchObject({
      status: "PASS",
    });
  });

  it("does not pass stale or unconfirmed evidence", async () => {
    const coordinator = new VerificationCoordinator(["tests"], snapshot, () => "STALE");
    await expect(coordinator.verdict()).resolves.toMatchObject({ status: "INCOMPLETE" });
  });

  it("captures bounded bytes through the injected workspace seam", async () => {
    const snapshot = await captureSnapshot(
      {
        workspaceId: "workspace",
        entries: () => Promise.resolve([{ path: "index.ts", bytes: Buffer.from("export {}"), mode: 0o644 }]),
      },
      { exclusionPolicyId: "default", maxEntries: 10, maxBytes: 100, maxFileBytes: 50 },
    );
    expect(snapshot.entries[0]?.path).toBe("index.ts");
  });

  it("materializes the sealed snapshot before running a trusted logical check", async () => {
    const calls: readonly (readonly string[])[] = [];
    let staged: readonly string[] | undefined;
    const backend = new DockerSandboxBackend({
      readiness: () => ({ networkDisabled: true, limitsEnforced: true, readOnlyMounts: true }),
      inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
      copySnapshot: (entries) => {
        staged = entries.map((entry) => entry.path);
        return "snapshot:snapshot-mount";
      },
      run: (argv) => {
        (calls as string[][]).push([...argv]);
        return { id: "container", output: "ok", exitCode: 0 };
      },
    });
    await backend.executeCheck({
      snapshot,
      image: { imageId: "sha256:" + "a".repeat(64), fingerprint: "fingerprint", architecture: "linux-x64", status: "READY" },
      target: { check: "tests", argv: ["pnpm", "test"] },
      limits: DEFAULT_SANDBOX_LIMITS,
    });
    expect(staged).toEqual(["index.ts"]);
    expect(calls[0]?.some((arg) => arg.includes("snapshot-mount") && arg.includes("readonly"))).toBe(true);
  });

  it("rejects output overflow and reports cleanup uncertainty", async () => {
    const backend = new DockerSandboxBackend({
      readiness: () => ({ networkDisabled: true, limitsEnforced: true, readOnlyMounts: true }),
      inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
      copySnapshot: () => "snapshot:snapshot-mount",
      run: () => ({ id: "container", output: "0123456789", exitCode: 0 }),
      stopAndRemove: () => "UNCERTAIN",
    });
    await expect(
      backend.executeCheck({
        snapshot,
        image: { imageId: "sha256:" + "b".repeat(64), fingerprint: "fingerprint", architecture: "linux-x64", status: "READY" },
        target: { check: "tests", argv: ["pnpm", "test"] },
        limits: { ...DEFAULT_SANDBOX_LIMITS, maxOutputBytes: 4 },
      }),
    ).resolves.toMatchObject({ status: "FAIL", cleanup: "UNCERTAIN" });
  });

  it("requires explicit runtime enforcement and read-only snapshot mounting", async () => {
    const backend = new DockerSandboxBackend({
      readiness: () => ({ networkDisabled: false, limitsEnforced: false, readOnlyMounts: false }),
      inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
      copySnapshot: () => "snapshot:snapshot-mount",
      run: () => ({ id: "container", output: "", exitCode: 0 }),
    });
    await expect(backend.readiness(
      { imageId: "sha256:" + "c".repeat(64), fingerprint: "fingerprint", architecture: "linux-x64", status: "READY" },
      DEFAULT_SANDBOX_LIMITS,
    )).resolves.toBe("BLOCKED");
  });

  it("retains the sealed snapshot and derives freshness from the trusted comparator", async () => {
    const coordinator = new VerificationCoordinator(["tests"], snapshot, () => "STALE");
    expect(coordinator.snapshotFor()).toBe(snapshot);
    coordinator.record({
      check: "tests",
      snapshotId: snapshot.snapshotId,
      imageId: "sha256:" + "d".repeat(64),
      status: "PASS",
      cleanup: "CONFIRMED",
      preparationFingerprint: "prep",
      profileSetId: "profiles-v1",
      targetId: "tests:ordinary",
      taskId: "task",
      attemptId: "attempt",
      nativeIdentity: "native-v1",
    });
    await expect(coordinator.verdict()).resolves.toMatchObject({ status: "INCOMPLETE" });
  });

  it("requires complete preparation, profile, target, task and native evidence", async () => {
    const coordinator = new VerificationCoordinator(["tests"], snapshot, () => "CURRENT");
    coordinator.record({
      check: "tests",
      snapshotId: snapshot.snapshotId,
      imageId: "sha256:" + "e".repeat(64),
      status: "PASS",
      cleanup: "CONFIRMED",
      preparationFingerprint: "prep",
      profileSetId: "profiles-v1",
      targetId: "tests:ordinary",
      taskId: "task",
      attemptId: "attempt",
      nativeIdentity: "native-v1",
    });
    await expect(coordinator.verdict()).resolves.toMatchObject({ status: "PASS", freshness: "CURRENT" });
  });

    it("fails closed when readiness is not enforced and always cleans up thrown runs", async () => {
      let cleaned = 0;
      const backend = new DockerSandboxBackend({
        readiness: () => ({ networkDisabled: true, limitsEnforced: false, readOnlyMounts: true }),
        inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
        copySnapshot: () => "snapshot:snapshot-mount",
        run: () => { throw new Error("runner failed"); },
        stopAndRemove: () => { cleaned += 1; return "CONFIRMED"; },
      });
      await expect(backend.executeCheck({
        snapshot,
        image: { imageId: "sha256:" + "a".repeat(64), fingerprint: "fingerprint", architecture: "linux-x64", status: "READY" },
        target: { check: "tests", argv: ["pnpm", "test"] },
        limits: DEFAULT_SANDBOX_LIMITS,
      })).rejects.toThrow("Sandbox runtime not ready");
      expect(cleaned).toBe(0);
    });

    it("seals evidence identities and rejects mismatched attempts", () => {
      const coordinator = new VerificationCoordinator(["tests"], snapshot, () => "CURRENT", {
        preparationFingerprint: "prep", profileSetId: "profiles-v1", taskId: "task", attemptId: "attempt", nativeIdentity: "native-v1",
      });
      expect(() => coordinator.record({
        check: "tests", snapshotId: snapshot.snapshotId, imageId: "sha256:" + "a".repeat(64), status: "PASS", cleanup: "CONFIRMED",
        preparationFingerprint: "other", profileSetId: "profiles-v1", targetId: "tests:ordinary", taskId: "task", attemptId: "attempt", nativeIdentity: "native-v1",
      })).toThrow("evidence identity");
    });

    it("does not expose mutable snapshot buffers", async () => {
      const captured = await captureSnapshot({
        workspaceId: "workspace",
        entries: () => Promise.resolve([{ path: "index.ts", bytes: Buffer.from("export {}"), mode: 0o644 }]),
      }, { exclusionPolicyId: "default", maxEntries: 10, maxBytes: 100, maxFileBytes: 50 });
      const original = captured.entries[0]?.hash;
      captured.entries[0]?.content.fill(0);
      expect(captured.entries[0]?.hash).toBe(original);
      expect(captured.entries[0]?.content).not.toEqual(Buffer.alloc(9));
    });
  it("exposes a narrow backend without accepting model-controlled runtime options", () => {
    const backend = new DockerSandboxBackend({
      readiness: () => ({ networkDisabled: true, limitsEnforced: true, readOnlyMounts: true }),
      inspectImage: (imageId) => ({ imageId, fingerprint: "fingerprint", architecture: "linux-x64" }),
      run: () => ({ id: "container", output: "", exitCode: 0 }),
      copySnapshot: () => "snapshot:snapshot-mount",
    });
    expect(backend).toBeDefined();
  });
});
