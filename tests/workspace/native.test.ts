import { describe, expect, it } from "vitest";

import { loadNativeWorkspaceBackend, validateNativeBackend } from "../../src/workspace/native.js";

describe("native workspace backend loader", () => {
  it("loads the addon only when its ABI, platform, architecture, and capability match", () => {
    const loaded = loadNativeWorkspaceBackend();
    expect(loaded).toMatchObject({
      kind: "READY",
      backend: {
        abi: 1,
        platform: process.platform,
        arch: process.arch,
        capability: "identity-v1",
      },
    });
  });

  it("rejects missing and incompatible backends", () => {
    expect(validateNativeBackend(null)).toMatchObject({ kind: "UNAVAILABLE" });
    expect(
      validateNativeBackend({
        abi: 2,
        platform: process.platform,
        arch: process.arch,
        capability: "identity-v1",
      }),
    ).toMatchObject({ kind: "UNAVAILABLE", reason: "UNSUPPORTED_BACKEND" });
    expect(
      validateNativeBackend({
        abi: 1,
        platform: "darwin",
        arch: process.arch,
        capability: "identity-v1",
      }),
    ).toMatchObject({ kind: "UNAVAILABLE", reason: "UNSUPPORTED_BACKEND" });
  });
});
