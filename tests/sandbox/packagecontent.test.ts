import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { Readable } from "node:stream";
import * as content from "../../src/sandbox/packagecontent.js";

async function fixture(version = "1.0.0") {
  const pack = tar.pack();
  pack.entry(
    { name: "package/package.json", mode: 0o644 },
    JSON.stringify({ name: "fixture", version }),
  );
  pack.entry({ name: "package/bin/run.js", mode: 0o755 }, "fixture bytes");
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk));
  const bytes = gzipSync(Buffer.concat(chunks));
  const artifact = {
    name: "fixture",
    version,
    tarball: `https://registry.npmjs.org/fixture/-/fixture-${version}.tgz`,
    integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
  };
  return { bytes, artifact };
}
it("binds exact package contents to verified tarball bytes and rejects an extra executable", async () => {
  const f = await fixture();
  const verified = await content.verifyPackageTarball(f.artifact, f.bytes);
  expect(verified.files.find((f) => f.path === "bin/run.js")).toMatchObject({
    bytes: 13,
    mode: 0o755,
  });
  const observed = [
    ...verified.files,
    { path: "extra.js", bytes: 1, mode: 0o755, hash: "a".repeat(64) },
  ];
  expect(() => content.validateNormalizedPackage(verified, observed)).toThrow(
    "Normalized package content mismatch",
  );
  expect(() => content.validateNormalizedPackage(verified, verified.files)).not.toThrow();
});

it("derives bin paths and lifecycle scripts only from SRI-verified package metadata", async () => {
  const pack = tar.pack();
  pack.entry(
    { name: "package/package.json", mode: 0o644 },
    '{"name":"fixture","version":"1.0.0","bin":{"fixture":"bin.js"},"scripts":{"postinstall":"node bin.js"}}',
  );
  pack.entry({ name: "package/bin.js", mode: 0o644 }, "#!/usr/bin/env node\n");
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk));
  const bytes = gzipSync(Buffer.concat(chunks));
  const f = await fixture();
  const verified = await content.verifyPackageTarball(
    { ...f.artifact, integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") },
    bytes,
  );
  expect(verified.bins).toEqual({ fixture: "bin.js" });
  expect(verified.scripts).toEqual({ postinstall: "node bin.js" });
});

it("rejects control characters before content can become a filesystem path", async () => {
  const f = await fixture();
  const verified = await content.verifyPackageTarball(f.artifact, f.bytes);
  expect(() =>
    content.validateNormalizedPackage(verified, [
      { ...verified.files[0]!, path: "bin\u0000/run.js" },
    ]),
  ).toThrow("Archive path must be a relative POSIX path");
});

it("derives comparison facts from actual normalized payload bytes, rejecting a modified executable", async () => {
  const f = await fixture();
  const verified = await content.verifyPackageTarball(f.artifact, f.bytes);
  const pack = tar.pack();
  pack.entry({ name: "package.json", mode: 0o644 }, '{"name":"fixture","version":"1.0.0"}');
  pack.entry({ name: "bin/run.js", mode: 0o755 }, "tampered file");
  pack.finalize();
  await expect(content.verifyNormalizedPackageTar(verified, pack)).rejects.toThrow(
    "Normalized package content mismatch",
  );
  await expect(
    content.verifyNormalizedPackageTar(verified, Readable.from([Buffer.alloc(0)])),
  ).rejects.toThrow("Archive truncated");
});

it("retains the SRI identity checked at entry when the caller later mutates the artifact", async () => {
  const f = await fixture();
  const expected = f.artifact.integrity;
  const pending = content.verifyPackageTarball(f.artifact, f.bytes);
  f.artifact.integrity = "sha512-" + "A".repeat(86) + "==";
  expect((await pending).integrity).toBe(expected);
});

it.each(["missing", "extra", "modified", "mode", "duplicate", "symlink"] as const)(
  "rejects actual normalized archive with %s content",
  async (attack) => {
    const f = await fixture();
    const verified = await content.verifyPackageTarball(f.artifact, f.bytes);
    const pack = tar.pack();
    pack.entry({ name: "package.json", mode: 0o644 }, '{"name":"fixture","version":"1.0.0"}');
    if (attack !== "missing") {
      pack.entry(
        { name: "bin/run.js", mode: attack === "mode" ? 0o644 : 0o755 },
        attack === "modified" ? "hostile bytes" : "fixture bytes",
      );
    }
    if (attack === "extra" || attack === "duplicate") {
      pack.entry(
        { name: attack === "extra" ? "extra.js" : "bin/run.js", mode: 0o755 },
        "hostile bytes",
      );
    }
    if (attack === "symlink")
      pack.entry({ name: "escape", type: "symlink", linkname: "../../host" });
    pack.finalize();
    const reason =
      attack === "duplicate"
        ? "Archive contains duplicate paths"
        : attack === "symlink"
          ? "Archive links and special files are not allowed"
          : "Normalized package content mismatch";
    await expect(content.verifyNormalizedPackageTar(verified, pack)).rejects.toThrow(reason);
  },
);

it("accepts a complete independently materialized package and denies forged authority", async () => {
  const f = await fixture();
  const verified = await content.verifyPackageTarball(f.artifact, f.bytes);
  const pack = tar.pack();
  pack.entry({ name: "package.json", mode: 0o644 }, '{"name":"fixture","version":"1.0.0"}');
  pack.entry({ name: "bin/run.js", mode: 0o755 }, "fixture bytes");
  pack.finalize();
  await expect(content.verifyNormalizedPackageTar(verified, pack)).resolves.toBeUndefined();
  expect(() => content.validateNormalizedPackage({ ...verified }, verified.files)).toThrow(
    "Untrusted package content manifest",
  );
});

it("rejects an unexpected directory rather than silently discarding normalized tree entries", async () => {
  const f = await fixture();
  const verified = await content.verifyPackageTarball(f.artifact, f.bytes);
  const pack = tar.pack();
  pack.entry({ name: "package.json", mode: 0o644 }, '{"name":"fixture","version":"1.0.0"}');
  pack.entry({ name: "bin/run.js", mode: 0o755 }, "fixture bytes");
  pack.entry({ name: "unexpected", type: "directory", mode: 0o755 });
  pack.finalize();
  await expect(content.verifyNormalizedPackageTar(verified, pack)).rejects.toThrow(
    "Normalized package directory mismatch",
  );
});

it("does not substitute one version's payload for another locked identity", async () => {
  const first = await fixture();
  const second = await fixture("2.0.0");
  const one = await content.verifyPackageTarball(first.artifact, first.bytes);
  const two = await content.verifyPackageTarball(second.artifact, second.bytes);
  expect(two.identity).toBe("fixture@2.0.0");
  expect(() => content.validateNormalizedPackage(two, one.files)).toThrow(
    "Normalized package content mismatch",
  );
});

it("rejects a signed archive using a regular file as a parent directory", async () => {
  const pack = tar.pack();
  pack.entry({ name: "package/package.json", mode: 0o644 }, '{"name":"fixture","version":"1.0.0"}');
  pack.entry({ name: "package/a", mode: 0o644 }, "regular parent");
  pack.entry({ name: "package/a/b", mode: 0o644 }, "child");
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk));
  const bytes = gzipSync(Buffer.concat(chunks));
  const f = await fixture();
  await expect(
    content.verifyPackageTarball(
      { ...f.artifact, integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") },
      bytes,
    ),
  ).rejects.toThrow("Archive parent is not a directory");
});
