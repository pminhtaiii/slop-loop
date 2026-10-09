import { describe, expect, it } from "vitest";

import { loadNativeWorkspaceBackend, validateNativeBackend } from "../../src/workspace/native.js";

describe("native workspace backend loader", () => {
  it("rejects a stale identity-v2 addon lacking snapshot metadata and larger reads", () => {
    const loaded = loadNativeWorkspaceBackend();
    expect(loaded.kind).toBe("READY");
    if (loaded.kind !== "READY") throw new Error("Current addon unavailable");
    expect(validateNativeBackend({ ...loaded.backend, capability: "identity-v2" })).toEqual({
      kind: "UNAVAILABLE",
      reason: "UNSUPPORTED_BACKEND",
    });
  });
  it("loads the addon only when its ABI, platform, architecture, and capability match", () => {
    const loaded = loadNativeWorkspaceBackend();
    expect(loaded).toMatchObject({
      kind: "READY",
      backend: {
        abi: 2,
        platform: process.platform,
        arch: process.arch,
        capability: "identity-v3",
      },
    });
    if (loaded.kind === "READY") expect(typeof loaded.backend.openChild).toBe("function");
  });

  it("rejects missing and incompatible backends", () => {
    expect(validateNativeBackend(null)).toMatchObject({ kind: "UNAVAILABLE" });
    const loaded = loadNativeWorkspaceBackend();
    expect(loaded.kind).toBe("READY");
    if (loaded.kind === "READY")
      expect(validateNativeBackend({ ...loaded.backend, probeWalk: undefined })).toMatchObject({
        kind: "UNAVAILABLE",
        reason: "UNSUPPORTED_BACKEND",
      });
    if (loaded.kind === "READY")
      expect(validateNativeBackend({ ...loaded.backend, openChild: undefined })).toMatchObject({
        kind: "UNAVAILABLE",
        reason: "UNSUPPORTED_BACKEND",
      });
    expect(
      validateNativeBackend({
        abi: 1,
        platform: process.platform,
        arch: process.arch,
        capability: "identity-v1",
      }),
    ).toMatchObject({ kind: "UNAVAILABLE", reason: "UNSUPPORTED_BACKEND" });
    expect(
      validateNativeBackend({
        abi: 2,
        platform: "darwin",
        arch: process.arch,
        capability: "identity-v2",
      }),
    ).toMatchObject({ kind: "UNAVAILABLE", reason: "UNSUPPORTED_BACKEND" });
  });
});
