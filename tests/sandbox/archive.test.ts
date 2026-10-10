import { describe, expect, it } from "vitest";

import { sanitizeArchivePath, validateArchiveEntries } from "../../src/sandbox/archive.js";

describe("preparation archive boundary", () => {
  it("rejects PAX metadata before the maintained parser normalizes it", async () => {
    const { parseTarStream } = await import("../../src/sandbox/archive.js");
    const tar = (await import("tar-stream")).default;
    const pack = tar.pack();
    const header = { name: "package/index.js", pax: { comment: "unsupported extension" } };
    pack.entry(header, "fixture");
    pack.finalize();
    await expect(parseTarStream(pack)).rejects.toThrow("Archive extensions are unsupported");
  });
  it.each(["../outside", "/absolute", "C:\\temp\\file", "dir\\file"])(
    "rejects unsafe tar path %s",
    (path) => {
      expect(() => sanitizeArchivePath(path)).toThrow();
    },
  );

  it("normalizes safe POSIX paths without allowing traversal", () => {
    expect(sanitizeArchivePath("dir/file.txt")).toBe("dir/file.txt");
    expect(() => sanitizeArchivePath("dir/../file.txt")).toThrow();
  });

  it("rejects links, special files, duplicate paths, and expansion overflow", () => {
    expect(() =>
      validateArchiveEntries([{ path: "link", kind: "symlink", size: 0, target: "../../outside" }]),
    ).toThrow();
    expect(() =>
      validateArchiveEntries([
        { path: "a", kind: "file", size: 1 },
        { path: "a", kind: "file", size: 1 },
      ]),
    ).toThrow();
    expect(() =>
      validateArchiveEntries([{ path: "large", kind: "file", size: 129 * 1024 * 1024 }], {
        maxFileBytes: 128 * 1024 * 1024,
      }),
    ).toThrow();
  });

  it("parses valid tar streams without extracting to host filesystem", async () => {
    const { parseTarStream } = await import("../../src/sandbox/archive.js");
    const tar = (await import("tar-stream")).default;
    const pack = tar.pack();

    pack.entry({ name: "package/index.js", type: "file", size: 14 }, "console.log();");
    pack.entry({ name: "package/src", type: "directory" });
    pack.finalize();

    const entries = await parseTarStream(pack);
    expect(entries).toEqual([
      { path: "package/index.js", kind: "file", size: 14 },
      { path: "package/src", kind: "directory", size: 0 },
    ]);
  });

  it("rejects hostile entries in tar streams (symlinks, path traversal, overflow)", async () => {
    const { parseTarStream } = await import("../../src/sandbox/archive.js");
    const tar = (await import("tar-stream")).default;

    // Test symlink rejection
    const packWithSymlink = tar.pack();
    packWithSymlink.entry({ name: "bad-link", type: "symlink", linkname: "/etc/passwd" });
    packWithSymlink.finalize();
    await expect(parseTarStream(packWithSymlink)).rejects.toThrow(
      "Archive links and special files are not allowed",
    );

    // Test traversal rejection
    const packWithTraversal = tar.pack();
    packWithTraversal.entry({ name: "../evil.sh", type: "file", size: 5 }, "malic");
    packWithTraversal.finalize();
    await expect(parseTarStream(packWithTraversal)).rejects.toThrow(
      "Archive path contains traversal or ambiguous segments",
    );

    // Test entry size overflow
    const packWithSizeLimit = tar.pack();
    packWithSizeLimit.entry({ name: "big.dat", type: "file", size: 200 }, Buffer.alloc(200));
    packWithSizeLimit.finalize();
    await expect(parseTarStream(packWithSizeLimit, { maxFileBytes: 100 })).rejects.toThrow(
      "Archive entry exceeds file limit",
    );
  });
});
