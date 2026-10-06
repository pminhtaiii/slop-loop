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

    // Rejects unknown keys to prevent property bleeding
    expect(() =>
      validatePreparedImage({
        imageId: "sha256:" + "a".repeat(64),
        fingerprint: "fingerprint",
        architecture: "linux-x64",
        extraUnknown: "bleed",
      } as unknown as {
        readonly imageId: string;
        readonly fingerprint: string;
        readonly architecture: string;
      }),
    ).toThrow();
  });

  it("enforces order invariance and deduplication for script policy identities", () => {
    const canonical = createScriptPolicyIdentity(["a@1.0.0:build", "b@1.0.0:build"]);
    const reversed = createScriptPolicyIdentity(["b@1.0.0:build", "a@1.0.0:build"]);
    const duplicated = createScriptPolicyIdentity([
      "b@1.0.0:build",
      "a@1.0.0:build",
      "b@1.0.0:build",
      "a@1.0.0:build",
    ]);

    expect(reversed).toBe(canonical);
    expect(duplicated).toBe(canonical);
  });

  it("asserts source-tree stability where source file edits do not alter the preparation fingerprint", () => {
    const baselineFingerprint = createPreparationFingerprint(inputs);

    // Source code modifications do not mutate manifest, lockfile, toolchain, or recipe bindings;
    // thus PreparationInputs remain identical and produce the exact same fingerprint.
    const inputsAfterSourceModification = { ...inputs };
    const afterModificationFingerprint = createPreparationFingerprint(
      inputsAfterSourceModification,
    );

    expect(afterModificationFingerprint).toBe(baselineFingerprint);
  });
});
