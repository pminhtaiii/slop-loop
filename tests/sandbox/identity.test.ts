import { describe, expect, it } from "vitest";

import {
  createPreparationFingerprint,
  createScriptPolicyIdentity,
  validatePreparedImage,
} from "../../src/sandbox/preparation.js";

const inputs = {
  manifestHash: "manifest",
  lockfileHash: "lockfile",
  managerConfigHash: "manager",
  scriptPolicyId: "scripts-v1",
  nodeVersion: "24.0.0",
  pnpmVersion: "12.5.1",
  architecture: "linux-x64",
  baseImageDigest: "sha256:" + "a".repeat(64),
  recipeHash: "recipe",
} as const;

describe("sandbox preparation identities", () => {
  it("changes when dependency identity changes but not source code", () => {
    const baseline = createPreparationFingerprint(inputs);
    expect(createPreparationFingerprint(inputs)).toBe(baseline);
    expect(createPreparationFingerprint({ ...inputs, lockfileHash: "changed" })).not.toBe(baseline);
  });

  it("canonicalizes the exact script policy and rejects mutable image metadata", () => {
    expect(createScriptPolicyIdentity(["pkg@1.0.0:install"])).toBe(
      createScriptPolicyIdentity(["pkg@1.0.0:install"]),
    );
    expect(createScriptPolicyIdentity(["pkg@2.0.0:install"])).not.toBe(
      createScriptPolicyIdentity(["pkg@1.0.0:install"]),
    );
    expect(() =>
      validatePreparedImage({
        imageId: "latest",
        fingerprint: "fingerprint",
        architecture: "linux-x64",
      }),
    ).toThrow();
  });
});
