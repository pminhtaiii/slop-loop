import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import tar, { type Headers } from "tar-stream";
import { expect, it } from "vitest";
import { parseLockedGraph } from "../../src/sandbox/downloads.js";
import { verifyPackageTarball } from "../../src/sandbox/packagecontent.js";
import { isValidatedTree, validateDependencyTree } from "../../src/sandbox/dependencytree.js";
import { normalizePnpmOutput } from "../../src/sandbox/normalization.js";

async function fixture(mutation = "none") {
  const manifest = '{"name":"tool","version":"1.0.0","bin":{"tool":"run.js"}}';
  const payload = tar.pack();
  payload.entry({ name: "package/package.json", mode: 0o644 }, manifest);
  payload.entry({ name: "package/run.js", mode: 0o644 }, "#!/usr/bin/env node\n");
  payload.finalize();
  const parts: Buffer[] = [];
  for await (const part of payload) parts.push(Buffer.from(part));
  const bytes = gzipSync(Buffer.concat(parts));
  const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
  const pkg = await verifyPackageTarball(
    {
      name: "tool",
      version: "1.0.0",
      integrity,
      tarball: "https://registry.npmjs.org/tool/-/tool-1.0.0.tgz",
    },
    bytes,
  );
  const lock = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      tool: {specifier: 1.0.0, version: 1.0.0}
packages:
  tool@1.0.0:
    resolution: {integrity: ${integrity}}
snapshots:
  tool@1.0.0: {}
`;
  const managerPrelude = `lockfileVersion: '9.0'
importers:
  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm: {specifier: 12.5.1, version: 12.5.1}
packages:
  pnpm@12.5.1:
    resolution: {integrity: ${integrity}}
snapshots:
  pnpm@12.5.1: {}
---
`;
  const graph = parseLockedGraph(
    mutation === "manager-prelude" ? managerPrelude + lock : lock,
    '{"dependencies":{"tool":"1.0.0"}}',
  );
  const raw = tar.pack();
  raw.entry({
    name: "node_modules",
    type: "directory",
    mode: mutation === "envelope-mode" ? 0o700 : 0o755,
  });
  const entry = (header: Headers, body?: string) =>
    raw.entry({ ...header, name: "node_modules/" + header.name }, body);
  // Physical manager slots are deliberately independent from canonical graph slots.
  const root = ".pnpm/physical-slot/node_modules/tool";
  entry({ name: `${root}/package.json`, mode: 0o644 }, manifest);
  entry(
    { name: `${root}/run.js`, mode: mutation === "mode" ? 0o644 : 0o755 },
    mutation === "bytes" ? "malicious executable" : "#!/usr/bin/env node\n",
  );
  entry({ name: "tool", type: "symlink", mode: 0o777, linkname: root });
  if (mutation === "wrapper") entry({ name: ".bin/tool", mode: 0o755 }, "unchecked wrapper");
  else if (mutation !== "missing-bin")
    entry({
      name: ".bin/tool",
      type: "symlink",
      mode: 0o777,
      linkname: mutation === "escape" ? "../../outside.js" : "../tool/run.js",
    });
  entry(
    { name: ".pnpm/lock.yaml", mode: 0o644 },
    mutation === "lock" ? lock.replace("version: 1.0.0", "version: 2.0.0") : lock,
  );
  if (mutation !== "missing-metadata")
    entry(
      { name: ".modules.yaml", mode: 0o644 },
      JSON.stringify({
        hoistedDependencies: {},
        hoistPattern: [],
        publicHoistPattern: [],
        included: { dependencies: true, devDependencies: true, optionalDependencies: true },
        layoutVersion: 5,
        nodeLinker: "isolated",
        packageManager: "pnpm@12.5.1",
        pendingBuilds: [],
        skipped: [],
        prunedAt: "Fri, 09 Oct 2026 07:22:29 GMT",
        storeDir: "/tmp/store/v11",
        virtualStoreDir: "/preparation/node_modules/.pnpm",
        virtualStoreDirMaxLength: 120,
        ...(mutation === "metadata" ? { arbitrary: "ignored code" } : {}),
      }),
    );
  if (mutation === "extra") entry({ name: "unclassified.js", mode: 0o644 }, "extra");
  if (mutation === "directory") entry({ name: "unclassified", type: "directory", mode: 0o755 });
  if (mutation === "package-extra") entry({ name: `${root}/injected.js`, mode: 0o644 }, "injected");
  if (mutation === "mixed-envelope") raw.entry({ name: "outside.js", mode: 0o644 }, "extra root");
  raw.finalize();
  return { graph, packages: [pkg], raw };
}

it("normalizes authenticated physical pnpm output and validates the complete emitted tree", async () => {
  const { graph, packages, raw } = await fixture();
  const result = await normalizePnpmOutput(graph, packages, raw);
  expect(isValidatedTree(result.tree)).toBe(true);
  const replay = await validateDependencyTree(graph, packages, Readable.from([result.tar]));
  expect(replay.contentId).toBe(result.tree.contentId);
});

it.each([
  "bytes",
  "mode",
  "wrapper",
  "metadata",
  "extra",
  "missing-bin",
  "escape",
  "lock",
  "missing-metadata",
  "directory",
  "package-extra",
  "mixed-envelope",
  "envelope-mode",
])("blocks %s before emitting any normalized tree", async (mutation) => {
  const { graph, packages, raw } = await fixture(mutation);
  await expect(normalizePnpmOutput(graph, packages, raw)).rejects.toThrow();
});

it("binds the receipt to the bytes of the raw archive actually consumed", async () => {
  const { graph, packages, raw } = await fixture();
  const chunks: Buffer[] = [];
  for await (const chunk of raw) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  const result = await normalizePnpmOutput(graph, packages, Readable.from([bytes]));
  expect(result.sourceContentId).toBe(createHash("sha256").update(bytes).digest("hex"));
});

it("authenticates the application lock when pnpm omits the manager prelude from its virtual store", async () => {
  const { graph, packages, raw } = await fixture("manager-prelude");
  await expect(normalizePnpmOutput(graph, packages, raw)).resolves.toMatchObject({
    tree: { recipe: "pnpm-12.5.1-closed-v1" },
  });
});

it("produces identical sanitized bytes for identical authenticated output", async () => {
  const first = await fixture();
  const second = await fixture();
  const a = await normalizePnpmOutput(first.graph, first.packages, first.raw);
  const b = await normalizePnpmOutput(second.graph, second.packages, second.raw);
  expect(b.tar).toEqual(a.tar);
});

async function peerFixture(wrongPeer = false) {
  const payloads = [
    { name: "consumer", version: "1.0.0" },
    { name: "tool", version: "1.0.0", bin: { tool: "run.js" } },
    { name: "tool", version: "2.0.0", bin: { tool: "run.js" } },
  ];
  const packages = [];
  const manifests = payloads.map((payload) => JSON.stringify(payload));
  for (const [index, payload] of payloads.entries()) {
    const pack = tar.pack();
    pack.entry({ name: "package/package.json", mode: 0o644 }, manifests[index]);
    if (payload.bin) pack.entry({ name: "package/run.js", mode: 0o644 }, "#!/usr/bin/env node\n");
    pack.finalize();
    const parts: Buffer[] = [];
    for await (const part of pack) parts.push(Buffer.from(part));
    const bytes = gzipSync(Buffer.concat(parts));
    packages.push(
      await verifyPackageTarball(
        {
          name: payload.name,
          version: payload.version,
          integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
          tarball: `https://registry.npmjs.org/${payload.name}/-/${payload.name}-${payload.version}.tgz`,
        },
        bytes,
      ),
    );
  }
  const lock = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      consumer: {specifier: 1.0.0, version: 1.0.0(tool@1.0.0)}
      tool: {specifier: 2.0.0, version: 2.0.0}
packages:
  consumer@1.0.0:
    peerDependencies: {tool: '*'}
    resolution: {integrity: ${packages[0]!.integrity}}
  tool@1.0.0:
    resolution: {integrity: ${packages[1]!.integrity}}
  tool@2.0.0:
    resolution: {integrity: ${packages[2]!.integrity}}
snapshots:
  consumer@1.0.0(tool@1.0.0):
    dependencies: {tool: 1.0.0}
  consumer@1.0.0(tool@2.0.0):
    dependencies: {tool: 2.0.0}
  tool@1.0.0: {}
  tool@2.0.0: {}
`;
  const graph = parseLockedGraph(lock, '{"dependencies":{"consumer":"1.0.0","tool":"2.0.0"}}');
  const raw = tar.pack();
  raw.entry({ name: "node_modules", type: "directory", mode: 0o755 });
  const entry = (header: Headers, body?: string) =>
    raw.entry({ ...header, name: "node_modules/" + header.name }, body);
  for (const slot of ["consumer-short-a", "consumer-short-b"])
    entry({ name: `.pnpm/${slot}/node_modules/consumer/package.json`, mode: 0o644 }, manifests[0]);
  for (const [slot, index] of [
    ["tool-short-a", 1],
    ["tool-short-b", 2],
  ] as const) {
    entry({ name: `.pnpm/${slot}/node_modules/tool/package.json`, mode: 0o644 }, manifests[index]);
    entry({ name: `.pnpm/${slot}/node_modules/tool/run.js`, mode: 0o755 }, "#!/usr/bin/env node\n");
  }
  const links = [
    ["consumer", ".pnpm/consumer-short-a/node_modules/consumer"],
    ["tool", ".pnpm/tool-short-b/node_modules/tool"],
    [".bin/tool", "../tool/run.js"],
    [".pnpm/consumer-short-a/node_modules/tool", "../../tool-short-a/node_modules/tool"],
    [
      ".pnpm/consumer-short-b/node_modules/tool",
      `../../tool-short-${wrongPeer ? "a" : "b"}/node_modules/tool`,
    ],
    [".pnpm/consumer-short-a/node_modules/.bin/tool", "../tool/run.js"],
    [".pnpm/consumer-short-b/node_modules/.bin/tool", "../tool/run.js"],
  ];
  for (const [name, linkname] of links)
    entry({ name: name!, type: "symlink", mode: 0o777, linkname: linkname! });
  entry({ name: ".pnpm/lock.yaml", mode: 0o644 }, lock);
  entry(
    { name: ".modules.yaml", mode: 0o644 },
    JSON.stringify({
      hoistedDependencies: {},
      hoistPattern: [],
      publicHoistPattern: [],
      included: { dependencies: true, devDependencies: true, optionalDependencies: true },
      layoutVersion: 5,
      nodeLinker: "isolated",
      packageManager: "pnpm@12.5.1",
      pendingBuilds: [],
      skipped: [],
      prunedAt: "Fri, 09 Oct 2026 07:22:29 GMT",
      storeDir: "/tmp/store/v11",
      virtualStoreDir: "/preparation/node_modules/.pnpm",
      virtualStoreDirMaxLength: 120,
    }),
  );
  raw.finalize();
  return { graph, packages, raw };
}

it("maps shortened physical slots to exact multiversion peer contexts and context bins", async () => {
  const { graph, packages, raw } = await peerFixture();
  const result = await normalizePnpmOutput(graph, packages, raw);
  expect(isValidatedTree(result.tree)).toBe(true);
  await expect(
    validateDependencyTree(graph, packages, Readable.from([result.tar])),
  ).resolves.toMatchObject({ contentId: result.tree.contentId });
});

it("blocks a duplicate physical peer context instead of inventing the missing context", async () => {
  const { graph, packages, raw } = await peerFixture(true);
  await expect(normalizePnpmOutput(graph, packages, raw)).rejects.toThrow(
    "authenticated pnpm placement",
  );
});
