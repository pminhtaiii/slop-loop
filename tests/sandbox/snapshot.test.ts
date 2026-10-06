import { describe, expect, it } from "vitest";

import {
  captureSnapshot,
  captureSnapshotWithRetries,
  type SnapshotSource,
} from "../../src/sandbox/snapshot.js";

const limits = {
  exclusionPolicyId: "default",
  maxEntries: 2,
  maxBytes: 10,
  maxFileBytes: 8,
};

describe("safe snapshot capture", () => {
  it("hashes copied bytes and exposes defensive content copies", async () => {
    const source: SnapshotSource = {
      workspaceId: "workspace",
      entries: () =>
        Promise.resolve([{ path: "index.ts", bytes: Buffer.from("export {}"), mode: 0o755 }]),
    };

    const snapshot = await captureSnapshot(source, { ...limits, maxBytes: 32, maxFileBytes: 32 });
    const entry = snapshot.entries[0];
    expect(entry?.hash).toBe("f4c5cf9bb78e85f15dc27180260637cf24b2a24bc39e0788783a3accc4dde614");
    if (entry === undefined) return;
    const content = entry.content;
    content[0] = 0;
    expect(entry.content[0]).not.toBe(0);
  });

  it("rejects unsafe links, special files, excluded paths, and bounds violations", async () => {
    for (const path of [
      ".git/config",
      "nested/.git/config",
      "nested/.git",
      "node_modules/pkg/index.js",
      "src/node_modules/pkg/index.js",
      "sub/node_modules",
      "../outside",
      ".env",
      "nested/.env",
      "nested/.env.local",
      "foo//bar",
      "trailing/",
      "/absolute",
      "win\\path",
    ]) {
      await expect(
        captureSnapshot(
          {
            workspaceId: "workspace",
            entries: () => Promise.resolve([{ path, bytes: Buffer.from("x"), mode: 0o644 }]),
          },
          limits,
        ),
      ).rejects.toThrow();
    }
    await expect(
      captureSnapshot(
        {
          workspaceId: "workspace",
          entries: () =>
            Promise.resolve([{ path: "a", bytes: Buffer.from("123456789"), mode: 0o644 }]),
        },
        limits,
      ),
    ).rejects.toThrow();
    for (const kind of ["symlink", "fifo", "socket"] as const) {
      await expect(
        captureSnapshot(
          {
            workspaceId: "workspace",
            entries: () =>
              Promise.resolve([{ path: "entry", bytes: Buffer.from("x"), mode: 0o644, kind }]),
          },
          limits,
        ),
      ).rejects.toThrow();
    }
  });

  it("retries observed capture races and fails closed after three unstable attempts", async () => {
    let calls = 0;
    const source: SnapshotSource = {
      workspaceId: "workspace",
      entries: () => {
        calls += 1;
        return Promise.resolve([
          {
            path: "index.ts",
            bytes: Buffer.from(calls % 2 === 0 ? "stable" : "changed"),
            mode: 0o644,
          },
        ]);
      },
    };
    await expect(captureSnapshotWithRetries(source, { ...limits, maxBytes: 32 })).rejects.toThrow();
    expect(calls).toBe(6);
  });

  it("omits generated outputs regardless of case before applying snapshot limits", async () => {
    const generatedPaths = [
      "dist",
      "dist/bundle.js",
      "DIST/bundle.js",
      "coverage",
      "coverage/lcov.info",
      "Coverage/lcov.info",
      "native/build",
      "native/build/addon.node",
      "native/addon/build/Release/addon.node",
      "native/addon/BUILD/Release/addon.node",
      "NATIVE/addon/Build/Release/addon.node",
    ];
    const snapshot = await captureSnapshot(
      {
        workspaceId: "workspace",
        entries: () =>
          Promise.resolve([
            { path: "index.ts", bytes: Buffer.from("x"), mode: 0o644 },
            ...generatedPaths.map((path) => ({ path, bytes: Buffer.alloc(32), mode: 0o644 })),
          ]),
      },
      { ...limits, maxEntries: 1, maxBytes: 1, maxFileBytes: 1 },
    );
    expect(snapshot.entries.map(({ path }) => path)).toEqual(["index.ts"]);
    expect(snapshot.totalBytes).toBe(1);
  });

  it.each(["dist/../secret", "DIST/.env", "coverage//file", "native/build/./addon.node"])(
    "still rejects unsafe paths within generated outputs: %s",
    async (path) => {
      await expect(
        captureSnapshot(
          {
            workspaceId: "workspace",
            entries: () => Promise.resolve([{ path, bytes: Buffer.from("x"), mode: 0o644 }]),
          },
          limits,
        ),
      ).rejects.toThrow("Unsafe snapshot path");
    },
  );

  it("rejects case collisions on linux paths", async () => {
    const source: SnapshotSource = {
      workspaceId: "workspace",
      entries: () =>
        Promise.resolve([
          { path: "file.txt", bytes: Buffer.from("a"), mode: 0o644 },
          { path: "FILE.TXT", bytes: Buffer.from("b"), mode: 0o644 },
        ]),
    };
    await expect(
      captureSnapshot(source, { ...limits, maxEntries: 10, maxBytes: 32, maxFileBytes: 32 }),
    ).rejects.toThrow("Snapshot path collision");
  });
});
