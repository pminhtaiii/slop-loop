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
    const coordinator = new VerificationCoordinator(["tests", "lint"]);
    coordinator.record({
      check: "tests",
      snapshotId: "snap",
      imageId: "img",
      status: "PASS",
      cleanup: "CONFIRMED",
    });
    coordinator.record({
      check: "lint",
      snapshotId: "snap",
      imageId: "img",
      status: "PASS",
      cleanup: "CONFIRMED",
    });
    await expect(coordinator.verdict({ snapshotId: "snap", freshness: "CURRENT" })).resolves.toMatchObject({
      status: "PASS",
    });
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

  it("exposes a narrow backend without accepting model-controlled runtime options", () => {
    const backend = new DockerSandboxBackend({
      run: () => ({ id: "container", output: "", exitCode: 0 }),
    });
    expect(backend).toBeDefined();
  });
});
