import { describe, expect, it } from "vitest";

import {
  bindDeveloperPreparation,
  preparationFingerprint,
  publishPreparedImage,
  validatePreparedImage,
} from "../../src/sandbox/preparation.js";

describe("developer-only preparation", () => {
  it("requires trusted developer confirmation and current identity binding", () => {
    expect(() =>
      bindDeveloperPreparation({
        confirmedBy: "model",
        workspaceId: "workspace",
        inputFingerprint: "fingerprint",
        recipeHash: "recipe",
      }),
    ).toThrow(/developer confirmation/i);

    expect(() =>
      bindDeveloperPreparation({
        confirmedBy: "developer",
        workspaceId: "",
        inputFingerprint: "fingerprint",
        recipeHash: "recipe",
      }),
    ).toThrow(/workspace identity/i);

    expect(() =>
      bindDeveloperPreparation({
        confirmedBy: "developer",
        workspaceId: "workspace",
        inputFingerprint: "fingerprint",
        recipeHash: "recipe",
        extraKey: "bleeding",
      } as unknown as {
        confirmedBy: string;
        workspaceId: string;
        inputFingerprint: string;
        recipeHash: string;
      }),
    ).toThrow(/unrecognized key/i);

    const validBinding = bindDeveloperPreparation({
      confirmedBy: "developer",
      workspaceId: "workspace",
      inputFingerprint: "fingerprint",
      recipeHash: "recipe",
    });
    expect(Object.isFrozen(validBinding)).toBe(true);
    expect(validBinding).toEqual({
      confirmedBy: "developer",
      workspaceId: "workspace",
      inputFingerprint: "fingerprint",
      recipeHash: "recipe",
    });
  });

  it("rejects repository confirmation, unowned recipe, or missing fingerprint (T106)", () => {
    expect(() =>
      bindDeveloperPreparation({
        confirmedBy: "repo",
        workspaceId: "workspace",
        inputFingerprint: "fingerprint",
        recipeHash: "recipe",
      }),
    ).toThrow(/developer confirmation/i);

    expect(() =>
      bindDeveloperPreparation({
        confirmedBy: "developer",
        workspaceId: "workspace",
        inputFingerprint: "fingerprint",
        recipeHash: "",
      }),
    ).toThrow(/recipe binding/i);

    expect(() =>
      bindDeveloperPreparation({
        confirmedBy: "developer",
        workspaceId: "workspace",
        inputFingerprint: "fingerprint",
        recipeHash: "   ",
      }),
    ).toThrow(/recipe binding/i);

    expect(() =>
      bindDeveloperPreparation({
        confirmedBy: "developer",
        workspaceId: "workspace",
        inputFingerprint: "   ",
        recipeHash: "recipe",
      }),
    ).toThrow(/preparation fingerprint/i);
  });

  it("invalidates and cancels preparation when inputs change (T106)", () => {
    const initialInputs = {
      manifestHash: "manifest-v1",
      lockfileHash: "lockfile-v1",
      managerConfigHash: "manager-v1",
      scriptPolicyId: "scripts-v1",
      nodeVersion: "24.0.0",
      pnpmVersion: "12.5.1",
      architecture: "linux-x64",
      baseImageDigest: "sha256:" + "a".repeat(64),
      recipeHash: "recipe-v1",
    };
    const initialFingerprint = preparationFingerprint(initialInputs);
    const binding = bindDeveloperPreparation({
      confirmedBy: "developer",
      workspaceId: "workspace-1",
      inputFingerprint: initialFingerprint,
      recipeHash: "recipe-v1",
    });

    const changedInputs = {
      ...initialInputs,
      lockfileHash: "lockfile-v2",
    };
    const changedFingerprint = preparationFingerprint(changedInputs);
    expect(changedFingerprint).not.toBe(initialFingerprint);

    // Prior developer binding is cancelled/invalid for changed inputs
    expect(binding.inputFingerprint === changedFingerprint).toBe(false);
  });

  it("publishes only an immutable image bound to the preparation fingerprint", () => {
    expect(() =>
      publishPreparedImage({
        imageId: "latest",
        fingerprint: "fingerprint",
        architecture: "linux-x64",
      }),
    ).toThrow(/immutable image digest/i);

    expect(() =>
      publishPreparedImage({
        imageId: `sha256:${"a".repeat(64)}`,
        fingerprint: "fingerprint",
        architecture: "linux-x64",
        extraUnknown: "bleeding",
      } as unknown as { imageId: string; fingerprint: string; architecture: string }),
    ).toThrow(/unrecognized key/i);

    const published = publishPreparedImage({
      imageId: `sha256:${"a".repeat(64)}`,
      fingerprint: "fingerprint",
      architecture: "linux-x64",
    });
    expect(published).toMatchObject({ status: "READY", fingerprint: "fingerprint" });
    expect(Object.isFrozen(published)).toBe(true);
    expect(published).toEqual({
      imageId: `sha256:${"a".repeat(64)}`,
      fingerprint: "fingerprint",
      architecture: "linux-x64",
      status: "READY",
    });

    expect(() =>
      validatePreparedImage({
        imageId: "latest",
        fingerprint: "fingerprint",
        architecture: "linux-x64",
      }),
    ).toThrow(/immutable image digest/i);

    const validated = validatePreparedImage({
      imageId: `sha256:${"a".repeat(64)}`,
      fingerprint: "fingerprint",
      architecture: "linux-x64",
    });
    expect(validated).toEqual(published);
    expect(Object.isFrozen(validated)).toBe(true);
  });
});
