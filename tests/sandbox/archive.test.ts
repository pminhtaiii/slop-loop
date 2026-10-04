import { describe, expect, it } from "vitest";

import { sanitizeArchivePath, validateArchiveEntries } from "../../src/sandbox/archive.js";

describe("preparation archive boundary", () => {
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
});
