import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { expect, it } from "vitest";
import { parseLockedGraph } from "../../src/sandbox/downloads.js";
import { verifyPackageTarball } from "../../src/sandbox/packagecontent.js";
import * as tree from "../../src/sandbox/dependencytree.js";

async function setup(extra = false, bin = false, binTarget = "../fixture/run.js", attack = "none") {
  const manifest = bin
    ? '{"name":"fixture","version":"1.0.0","bin":{"fixture":"run.js"}}'
    : '{"name":"fixture","version":"1.0.0"}';
  const archive = tar.pack();
  archive.entry({ name: "package/package.json", mode: 0o644 }, manifest);
  if (bin) archive.entry({ name: "package/run.js", mode: 0o644 }, "#!/usr/bin/env node\n");
  archive.finalize();
  const chunks: Buffer[] = [];
  for await (const part of archive) chunks.push(Buffer.from(part));
  const bytes = gzipSync(Buffer.concat(chunks));
  const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
  const graph = parseLockedGraph(
    `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      fixture: {specifier: 1.0.0, version: 1.0.0}
packages:
  fixture@1.0.0:
    resolution: {integrity: ${integrity}}
snapshots:
  fixture@1.0.0: {}
`,
    '{"dependencies":{"fixture":"1.0.0"}}',
  );
  const verified = await verifyPackageTarball(graph.artifacts[0]!, bytes);
  const exported = tar.pack();
  const manifestPath = ".pnpm/fixture@1.0.0/node_modules/fixture/package.json";
  if (attack !== "missing")
    exported.entry(
      { name: manifestPath, mode: attack === "mode" ? 0o755 : 0o644 },
      attack === "modified" ? "altered package bytes" : manifest,
    );
  if (attack === "duplicate") exported.entry({ name: manifestPath, mode: 0o644 }, manifest);
  if (attack === "hardlink") exported.entry({ name: "hard", type: "link", linkname: manifestPath });
  exported.entry({
    name: "fixture",
    type: "symlink",
    linkname:
      attack === "escape"
        ? "../../outside"
        : attack === "cycle"
          ? "fixture/../.pnpm/fixture@1.0.0/node_modules/fixture"
          : ".pnpm/fixture@1.0.0/node_modules/fixture",
  });
  if (bin) {
    exported.entry(
      { name: ".pnpm/fixture@1.0.0/node_modules/fixture/run.js", mode: 0o755 },
      "#!/usr/bin/env node\n",
    );
    exported.entry({ name: ".bin/fixture", type: "symlink", linkname: binTarget });
  }
  if (extra) exported.entry({ name: ".bin/extra", mode: 0o755 }, "unexpected executable");
  exported.finalize();
  return { graph, verified, exported };
}

it("requires all exported entries to belong to the exact locked tree", async () => {
  const fixture = await setup(true);
  await expect(
    tree.verifyDependencyTree(fixture.graph, [fixture.verified], fixture.exported),
  ).rejects.toThrow("Unexpected dependency tree entry");
});

it.each([
  ["missing", "Missing dependency tree entry"],
  ["modified", "Dependency tree content mismatch"],
  ["mode", "Dependency tree content mismatch"],
  ["duplicate", "Archive contains duplicate paths"],
  ["hardlink", "Archive links and special files are not allowed"],
  ["escape", "Dependency tree link mismatch"],
  ["cycle", "Dependency tree link mismatch"],
])("rejects actual full-tree archive with %s entries", async (attack, reason) => {
  const fixture = await setup(false, false, "../fixture/run.js", attack);
  await expect(
    tree.verifyDependencyTree(fixture.graph, [fixture.verified], fixture.exported),
  ).rejects.toThrow(reason);
});

it("verifies signed bin content with the trusted executable-mode transformation and exact root bin link", async () => {
  const fixture = await setup(false, true);
  await expect(
    tree.verifyDependencyTree(fixture.graph, [fixture.verified], fixture.exported),
  ).resolves.toBeUndefined();
});

it("rejects a link whose lexical normalization hides traversal through an earlier symlink", async () => {
  const fixture = await setup(
    false,
    true,
    "../fixture/../.pnpm/fixture@1.0.0/node_modules/fixture/run.js",
  );
  await expect(
    tree.verifyDependencyTree(fixture.graph, [fixture.verified], fixture.exported),
  ).rejects.toThrow("Dependency tree link mismatch");
});

it("accepts full package bytes plus exactly bound root links without granting execution authority", async () => {
  const fixture = await setup();
  await expect(
    tree.verifyDependencyTree(fixture.graph, [fixture.verified], fixture.exported),
  ).resolves.toBeUndefined();
});

it("rejects duplicate verified identities rather than selecting one manifest", async () => {
  const fixture = await setup();
  await expect(
    tree.verifyDependencyTree(
      fixture.graph,
      [fixture.verified, fixture.verified],
      fixture.exported,
    ),
  ).rejects.toThrow("Duplicate verified package identity");
});

it("enforces the aggregate entry cap while deriving expected placements", async () => {
  const fixture = await setup();
  await expect(
    tree.verifyDependencyTree(fixture.graph, [fixture.verified], fixture.exported, {
      maxEntries: 1,
    }),
  ).rejects.toThrow("Dependency tree limit exceeded");
});
