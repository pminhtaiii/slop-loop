import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import tar from "tar-stream";

import {
  parseTarStream,
  sanitizeArchivePath,
  validateArchiveEntries,
} from "../../src/sandbox/archive.js";

async function withTypeflag(pack: ReturnType<typeof tar.pack>, type: string): Promise<Readable> {
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  bytes[156] = type.charCodeAt(0);
  bytes.fill(32, 148, 156);
  const checksum = bytes.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  bytes.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return Readable.from([bytes]);
}

describe("preparation archive boundary", () => {
  it.each(["package/日本語.js", "package/" + "a".repeat(120)])(
    "accepts a local PAX path for %s across chunk boundaries",
    async (name) => {
      const pack = tar.pack();
      const header = { name, pax: { mtime: "123.456" } };
      pack.entry(header, "fixture");
      pack.finalize();
      const chunks: Buffer[] = [];
      for await (const chunk of pack) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const source = Readable.from(Array.from(bytes, (byte) => Buffer.from([byte])));
      await expect(parseTarStream(source)).resolves.toEqual([
        { path: name, kind: "file", size: 7 },
      ]);
    },
  );

  it("accepts PAX linkpath only through the permitted symlink flow", async () => {
    const name = "package/日本語-link",
      target = "a".repeat(120);
    const pack = tar.pack();
    pack.entry({ name, type: "symlink", linkname: target });
    pack.finalize();
    await expect(parseTarStream(pack, { allowRelativeSymlinks: true })).resolves.toEqual([
      { path: name, kind: "symlink", size: 0, target },
    ]);
    const denied = tar.pack();
    denied.entry({ name, type: "symlink", linkname: target });
    denied.finalize();
    await expect(parseTarStream(denied)).rejects.toThrow(
      "Archive links and special files are not allowed",
    );
  });

  it.each(["size", "uid", "GNU.sparse.map", "comment"])(
    "rejects unsupported PAX key %s",
    async (key) => {
      const pack = tar.pack();
      const header = { name: "package/index.js", pax: { [key]: "1" } };
      pack.entry(header, "fixture");
      pack.finalize();
      await expect(parseTarStream(pack)).rejects.toThrow("Archive extensions are unsupported");
    },
  );

  it.each([
    "13 mtime=123\n",
    "8 path=a\n",
    "10 path=aX",
    "10 path=a\ntrailing",
    "10 path=a\n10 path=b\n",
  ])("rejects unsupported or malformed local PAX records %j", async (records) => {
    const pack = tar.pack();
    pack.entry({ name: "PaxHeader" }, records);
    pack.entry({ name: "package/index.js" }, "fixture");
    pack.finalize();
    await expect(parseTarStream(await withTypeflag(pack, "x"))).rejects.toThrow(
      "Archive extensions are unsupported",
    );
  });

  it.each(["g", "L", "K", "S"])("continues rejecting extension typeflag %s", async (type) => {
    const pack = tar.pack();
    pack.entry({ name: "package/index.js" }, "fixture");
    pack.finalize();
    await expect(parseTarStream(await withTypeflag(pack, type))).rejects.toThrow(
      "Archive extensions are unsupported",
    );
  });

  it("applies path validation to a supported PAX path", async () => {
    const pack = tar.pack();
    pack.entry({ name: "../日本語.js" }, "fixture");
    pack.finalize();
    await expect(parseTarStream(pack)).rejects.toThrow("Archive path contains traversal");
  });

  it("bounds PAX payload bytes as metadata before parsing records", async () => {
    const pack = tar.pack();
    pack.entry({ name: "PaxHeader" }, Buffer.alloc(16 * 1024 * 1024));
    pack.finalize();
    await expect(parseTarStream(await withTypeflag(pack, "x"))).rejects.toThrow(
      "Archive metadata exceeds limit",
    );
  });

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
