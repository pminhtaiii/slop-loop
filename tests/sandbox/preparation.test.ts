import { describe, expect, it } from "vitest";

import { bindDeveloperPreparation, publishPreparedImage } from "../../src/sandbox/preparation.js";

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
  });
});
