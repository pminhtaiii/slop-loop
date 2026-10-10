import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureSnapshot,
  compareCurrent,
  captureSnapshotWithRetries,
} from "../../src/sandbox/snapshot.js";
import { selectWorkspace, closeWorkspace } from "../../src/workspace/admission.js";
import { createGitCheckout } from "../workspace/fixtures.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
const limits = {
  exclusionPolicyId: "reference-v1",
  maxEntries: 100,
  maxBytes: 20 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
};
function checkout() {
  const fixture = createGitCheckout();
  cleanups.push(() => fixture.cleanup());
  const selection = selectWorkspace(fixture.root);
  if (selection.kind !== "SELECTED") throw new Error("Required native workspace unavailable");
  cleanups.push(() => closeWorkspace(selection.workspace));
  return { fixture, workspace: selection.workspace };
}
describe("trusted workspace snapshot capture", () => {
  it("never reads excluded secrets, dependencies, generated native output or nested repositories", async () => {
    const { fixture, workspace } = checkout();
    fixture.writeDeniedPaths();
    fixture.write("node_modules/untrusted.js", "ignored dependency");
    fixture.write("native/workspace/build/old.node", "ignored addon");
    fixture.write("dist/out.js", "ignored output");
    fixture.write("nested/hidden.ts", "other repository");
    fixture.git("-C", path.join(fixture.root, "nested"), "init", "-q");
    const snapshot = await captureSnapshot(workspace, limits);
    expect(snapshot.entries.map((entry) => entry.path)).toEqual(["src/tracked.ts"]);
  });
  it("rejects hard-linked inputs and unavailable workspace authority", async () => {
    const { fixture, workspace } = checkout();
    fs.linkSync(path.join(fixture.root, "src/tracked.ts"), path.join(fixture.root, "alias.ts"));
    await expect(captureSnapshot(workspace, limits)).rejects.toThrow(
      "Snapshot path authority unavailable",
    );
    closeWorkspace(workspace);
    await expect(captureSnapshot(workspace, limits)).rejects.toThrow(
      "Workspace identity unavailable",
    );
  });
  it("bounds file/count/total bytes and observes cancellation during safe traversal", async () => {
    const { fixture, workspace } = checkout();
    fixture.write("a.ts", "oversized");
    await expect(captureSnapshot(workspace, { ...limits, maxEntries: 1 })).rejects.toThrow(
      "Snapshot entry limit exceeded",
    );
    await expect(captureSnapshot(workspace, { ...limits, maxFileBytes: 1 })).rejects.toThrow(
      "Snapshot file limit exceeded",
    );
    await expect(captureSnapshot(workspace, { ...limits, maxBytes: 1 })).rejects.toThrow(
      "Snapshot byte limit exceeded",
    );
    const controller = new AbortController();
    const capturing = captureSnapshot(workspace, limits, controller.signal);
    setImmediate(() => controller.abort(new Error("capture cancelled")));
    await expect(capturing).rejects.toThrow("capture cancelled");
  });
});

describe("snapshot security retry discipline", () => {
  it("does not retry missing path authority as capture instability", async () => {
    let calls = 0;
    const source = {
      workspaceId: "workspace",
      entries: () => {
        calls += 1;
        throw new Error("Snapshot path authority unavailable");
      },
    };
    await expect(captureSnapshotWithRetries(source, limits)).rejects.toThrow(
      "Snapshot path authority unavailable",
    );
    expect(calls).toBe(1);
  });
});

describe("working-tree freshness", () => {
  it("copies edited tracked and eligible untracked bytes through safe workspace handles", async () => {
    const { fixture, workspace } = checkout();
    fixture.write("src/tracked.ts", "export const edited = 2;\n");
    fixture.write("src/new.ts", "export const added = 3;\n");
    const snapshot = await captureSnapshot(workspace, limits);
    expect(snapshot.entries.map((entry) => entry.path)).toEqual(["src/new.ts", "src/tracked.ts"]);
    expect(
      snapshot.entries.find((entry) => entry.path === "src/tracked.ts")?.content.toString(),
    ).toBe("export const edited = 2;\n");
    expect(await compareCurrent(snapshot, workspace, limits)).toBe("CURRENT");
    fixture.write("src/new.ts", "export const added = 4;\n");
    expect(await compareCurrent(snapshot, workspace, limits)).toBe("STALE");
    closeWorkspace(workspace);
    expect(await compareCurrent(snapshot, workspace, limits)).toBe("UNCONFIRMED");
  });
});

it("captures source above the read-tool cap and detects actual mode changes", async () => {
  const { fixture, workspace } = checkout();
  const source = path.join(fixture.root, "large.ts");
  fs.writeFileSync(source, Buffer.alloc(4 * 1024 * 1024 + 1, 65));
  const snapshot = await captureSnapshot(workspace, limits);
  expect(snapshot.entries.find((entry) => entry.path === "large.ts")?.bytes).toBe(
    4 * 1024 * 1024 + 1,
  );
  try {
    fs.chmodSync(source, 0o444);
    expect(await compareCurrent(snapshot, workspace, limits)).toBe("STALE");
  } finally {
    fs.chmodSync(source, 0o644);
  }
});
