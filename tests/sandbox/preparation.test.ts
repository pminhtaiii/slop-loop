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
  });

  it("publishes only an immutable image bound to the preparation fingerprint", () => {
    expect(() =>
      publishPreparedImage({
        imageId: "latest",
        fingerprint: "fingerprint",
        architecture: "linux-x64",
      }),
    ).toThrow(/immutable image digest/i);

    expect(
      publishPreparedImage({
        imageId: `sha256:${"a".repeat(64)}`,
        fingerprint: "fingerprint",
        architecture: "linux-x64",
      }),
    ).toMatchObject({ status: "READY", fingerprint: "fingerprint" });
  });
});
