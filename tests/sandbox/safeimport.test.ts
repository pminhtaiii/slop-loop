import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import tar from "tar-stream";
import { Readable } from "node:stream";
import * as importer from "../../src/sandbox/safeimport.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it.skipIf(process.platform === "win32")(
  "imports only checked regular bytes and materializes in-root links last",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "slop-loop-import-fixture-"));
    roots.push(root);
    const pack = tar.pack();
    pack.entry({ name: "package/run.js", mode: 0o755 }, "signed bytes");
    pack.entry({ name: "alias", mode: 0o777, type: "symlink", linkname: "package/run.js" });
    pack.finalize();
    const manifest = [
      {
        path: "package/run.js",
        kind: "file" as const,
        size: 12,
        mode: 0o755,
        hash: createHash("sha256").update("signed bytes").digest("hex"),
      },
      { path: "alias", kind: "symlink" as const, size: 0, mode: 0o777, target: "package/run.js" },
    ];
    const imported = await importer.importCheckedArchive(
      Readable.from(pack),
      manifest,
      root,
      new AbortController().signal,
    );
    expect(fs.readFileSync(path.join(imported.root, "package/run.js"), "utf8")).toBe(
      "signed bytes",
    );
    expect(imported.entries).toBe(2);
  },
);

it("rejects changed link metadata before any link is materialized", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slop-loop-import-fixture-"));
  roots.push(root);
  const pack = tar.pack();
  pack.entry({ name: "alias", type: "symlink", mode: 0o755, linkname: "missing" });
  pack.finalize();
  await expect(
    importer.importCheckedArchive(
      Readable.from(pack),
      [{ path: "alias", kind: "symlink", size: 0, mode: 0o777, target: "missing" }],
      root,
      new AbortController().signal,
    ),
  ).rejects.toThrow("Import manifest mismatch");
  expect(fs.readdirSync(root)).toEqual([]);
});

it("rejects DEL control bytes in authenticated link targets through path grammar", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slop-loop-import-fixture-"));
  roots.push(root);
  const target = "missing\x7f";
  const pack = tar.pack();
  pack.entry({ name: "alias", type: "symlink", mode: 0o777, linkname: target });
  pack.finalize();
  await expect(
    importer.importCheckedArchive(
      Readable.from(pack),
      [{ path: "alias", kind: "symlink", size: 0, mode: 0o777, target }],
      root,
      new AbortController().signal,
    ),
  ).rejects.toThrow("Archive path must be a relative POSIX path");
  expect(fs.readdirSync(root)).toEqual([]);
});

it("imports authenticated regular bytes on the current platform", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slop-loop-import-fixture-"));
  roots.push(root);
  const pack = tar.pack();
  pack.entry({ name: "package/run.js", mode: 0o644 }, "signed bytes");
  pack.finalize();
  const imported = await importer.importCheckedArchive(
    Readable.from(pack),
    [
      {
        path: "package/run.js",
        kind: "file",
        size: 12,
        mode: 0o644,
        hash: createHash("sha256").update("signed bytes").digest("hex"),
      },
    ],
    root,
    new AbortController().signal,
  );
  expect(importer.isCheckedImport(imported)).toBe(true);
  expect(fs.readFileSync(path.join(imported.root, "package/run.js"), "utf8")).toBe("signed bytes");
  expect(importer.removeCheckedImport(imported)).toBe("CONFIRMED");
  expect(fs.readdirSync(root)).toEqual([]);
});

it("imports a checked Docker dependency envelope without copying its wrapper into the image tree", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slop-loop-import-fixture-"));
  roots.push(root);
  const pack = tar.pack();
  pack.entry({ name: "node_modules", type: "directory", mode: 0o755 });
  pack.entry({ name: "node_modules/package/run.js", mode: 0o644 }, "signed bytes");
  pack.finalize();
  const imported = await importer.importCheckedArchive(
    Readable.from(pack),
    [
      {
        path: "package/run.js",
        kind: "file",
        size: 12,
        mode: 0o644,
        hash: createHash("sha256").update("signed bytes").digest("hex"),
      },
    ],
    root,
    new AbortController().signal,
    "node_modules",
  );
  expect(fs.readFileSync(path.join(imported.root, "package/run.js"), "utf8")).toBe("signed bytes");
});

it("rejects a mismatched payload and removes only its own partial import", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slop-loop-import-fixture-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "unrelated"), "keep");
  const pack = tar.pack();
  pack.entry({ name: "file", mode: 0o644 }, "hostile");
  pack.finalize();
  await expect(
    importer.importCheckedArchive(
      Readable.from(pack),
      [{ path: "file", kind: "file", size: 7, mode: 0o644, hash: "a".repeat(64) }],
      root,
      new AbortController().signal,
    ),
  ).rejects.toThrow("Import content mismatch");
  expect(fs.readdirSync(root)).toEqual(["unrelated"]);
});
