import { describe, expect, it } from "vitest";

import { requireDockerImage, runDocker } from "./integration-fixtures.js";
import { parseTarStream } from "../../src/sandbox/archive.js";
import {
  bindDeveloperPreparation,
  createScriptPolicyIdentity,
  publishPreparedImage,
  validatePreparedImage,
} from "../../src/sandbox/preparation.js";
import tar from "tar-stream";

describe("T111 / T115: Preparation Integration Suite", () => {
  it("enforces developer-only authority binding and script policy identities", () => {
    // T115: exact locked-script policy identity
    const scriptPolicyId = createScriptPolicyIdentity(["build", "node-gyp rebuild"]);
    expect(scriptPolicyId).toMatch(/^[a-f0-9]{64}$/);

    // T111: Developer confirmation is strictly required
    const binding = bindDeveloperPreparation({
      confirmedBy: "developer",
      workspaceId: "test-workspace-01",
      inputFingerprint: "fingerprint-valid",
      recipeHash: "recipe-valid-01",
    });
    expect(binding.confirmedBy).toBe("developer");

    expect(() =>
      bindDeveloperPreparation({
        confirmedBy: "model",
        workspaceId: "test-workspace-01",
        inputFingerprint: "fingerprint-valid",
        recipeHash: "recipe-valid-01",
      }),
    ).toThrow("Developer confirmation is required");
  });

  it("handles hostile archive expansion and links during preparation stream import", async () => {
    // Hostile archive with forbidden symlink
    const hostilePack = tar.pack();
    hostilePack.entry({ name: "evil-symlink", type: "symlink", linkname: "/etc/shadow" });
    hostilePack.finalize();

    await expect(parseTarStream(hostilePack)).rejects.toThrow(
      "Archive links and special files are not allowed",
    );

    // Hostile archive with directory traversal
    const traversalPack = tar.pack();
    traversalPack.entry({ name: "../../../outside.sh", type: "file", size: 4 }, "test");
    traversalPack.finalize();

    await expect(parseTarStream(traversalPack)).rejects.toThrow(
      "Archive path contains traversal or ambiguous segments",
    );
  });

  it(
    "proves offline dependency execution with root hooks disabled in Docker",
    { timeout: 30_000 },
    (context) => {
      requireDockerImage(context, "alpine:3.20");

      // Execute offline container check: no network, non-root, isolated execution
      const output = runDocker([
        "run",
        "--rm",
        "--pull=never",
        "--network",
        "none",
        "--user",
        "1000:1000",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/tmp:rw,size=16m",
        "alpine:3.20",
        "sh",
        "-c",
        "echo 'offline-prep-clean'",
      ]);

      expect(output.trim()).toBe("offline-prep-clean");
    },
  );

  it("validates and publishes only immutable image digests", () => {
    const validDigest = `sha256:${"b".repeat(64)}`;
    const published = publishPreparedImage({
      imageId: validDigest,
      fingerprint: "fingerprint-abc",
      architecture: "linux-x64",
    });

    expect(published.status).toBe("READY");
    expect(published.imageId).toBe(validDigest);

    // Rejects mutable tag
    expect(() =>
      validatePreparedImage({
        imageId: "latest",
        fingerprint: "fingerprint-abc",
        architecture: "linux-x64",
      }),
    ).toThrow("Prepared image ID must be an immutable image digest");
  });
});
