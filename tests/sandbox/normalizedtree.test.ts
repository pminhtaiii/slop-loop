import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { expect, it } from "vitest";
import { parseLockedGraph } from "../../src/sandbox/downloads.js";
import { verifyPackageTarball } from "../../src/sandbox/packagecontent.js";
import { verifyDependencyTree } from "../../src/sandbox/dependencytree.js";
import * as tree from "../../src/sandbox/dependencytree.js";
import * as scripts from "../../src/sandbox/offlinescripts.js";

async function fixture(mutation = "none", install = false) {
  const payloads = [
    {
      name: "consumer",
      version: "1.0.0",
      ...(install ? { scripts: { install: "echo approved" } } : {}),
    },
    { name: "tool", version: "1.0.0", bin: { tool: "run.js" } },
    { name: "tool", version: "2.0.0", bin: { tool: "run.js" } },
  ];
  const artifacts = [];
  const contents = [];
  for (const payload of payloads) {
    const pack = tar.pack();
    const manifest = JSON.stringify(payload);
    pack.entry({ name: "package/package.json", mode: 0o644 }, manifest);
    if (payload.bin) pack.entry({ name: "package/run.js", mode: 0o644 }, "#!/usr/bin/env node\n");
    pack.finalize();
    const chunks: Buffer[] = [];
    for await (const chunk of pack) chunks.push(Buffer.from(chunk));
    const bytes = gzipSync(Buffer.concat(chunks));
    const artifact = {
      name: payload.name,
      version: payload.version,
      integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
      tarball: `https://registry.npmjs.org/${payload.name}/-/${payload.name}-${payload.version}.tgz`,
    };
    artifacts.push(await verifyPackageTarball(artifact, bytes));
    contents.push(manifest);
  }
  const graph = parseLockedGraph(
    `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      consumer: {specifier: 1.0.0, version: 1.0.0(tool@1.0.0)}
      tool: {specifier: 2.0.0, version: 2.0.0}
packages:
  consumer@1.0.0:
    peerDependencies: {tool: '*'}
    resolution: {integrity: ${artifacts[0]!.integrity}}
  tool@1.0.0:
    resolution: {integrity: ${artifacts[1]!.integrity}}
  tool@2.0.0:
    resolution: {integrity: ${artifacts[2]!.integrity}}
snapshots:
  consumer@1.0.0(tool@1.0.0):
    dependencies: {tool: 1.0.0}
  consumer@1.0.0(tool@2.0.0):
    dependencies: {tool: 2.0.0}
  tool@1.0.0: {}
  tool@2.0.0: {}
`,
    '{"dependencies":{"consumer":"1.0.0","tool":"2.0.0"}}',
  );
  const pack = tar.pack();
  const consumer1 = ".pnpm/consumer@1.0.0_tool@1.0.0/node_modules";
  const consumer2 = ".pnpm/consumer@1.0.0_tool@2.0.0/node_modules";
  for (const parent of [consumer1, consumer2])
    pack.entry({ name: `${parent}/consumer/package.json`, mode: 0o644 }, contents[0]);
  for (const [version, content] of [
    ["1.0.0", contents[1]!],
    ["2.0.0", contents[2]!],
  ]) {
    const root = `.pnpm/tool@${version}/node_modules/tool`;
    pack.entry({ name: `${root}/package.json`, mode: 0o644 }, content);
    pack.entry({ name: `${root}/run.js`, mode: 0o755 }, "#!/usr/bin/env node\n");
  }
  const links = [
    ["consumer", `${consumer1}/consumer`],
    ["tool", ".pnpm/tool@2.0.0/node_modules/tool"],
    [".bin/tool", "../tool/run.js"],
    [`${consumer1}/tool`, "../../tool@1.0.0/node_modules/tool"],
    [`${consumer2}/tool`, "../../tool@2.0.0/node_modules/tool"],
    [`${consumer1}/.bin/tool`, "../tool/run.js"],
    [`${consumer2}/.bin/tool`, "../tool/run.js"],
  ];
  for (const [name, target] of links) {
    if (mutation === "missing-bin" && name === `${consumer2}/.bin/tool`) continue;
    pack.entry({
      name: name!,
      type: "symlink",
      linkname:
        mutation === "wrong-peer" && name === `${consumer2}/tool`
          ? "../../tool@1.0.0/node_modules/tool"
          : target!,
    });
  }
  if (mutation === "metadata")
    pack.entry({ name: ".modules.yaml", mode: 0o644 }, "arbitrary: true\n");
  if (mutation === "wrapper")
    pack.entry({ name: ".bin/unreviewed", mode: 0o755 }, "unchecked code");
  if (mutation === "sealed")
    pack.entry(
      { name: ".slop-loop-tree.json", mode: 0o644 },
      '{"recipe":"pnpm-12.5.1-closed-v1","linker":"isolated","bins":"relative-links"}\n',
    );
  pack.finalize();
  return { graph, artifacts, pack };
}

it("accepts complete multiversion peer contexts and their per-context executable links", async () => {
  const { graph, artifacts, pack } = await fixture();
  await expect(verifyDependencyTree(graph, artifacts, pack)).resolves.toBeUndefined();
});

it("issues an immutable content identity only for the complete closed recipe", async () => {
  const { graph, artifacts, pack } = await fixture("sealed");
  const receipt = await tree.validateDependencyTree(graph, artifacts, pack);
  expect(receipt.contentId).toMatch(/^[a-f0-9]{64}$/u);
  expect(receipt.recipe).toBe("pnpm-12.5.1-closed-v1");
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(tree.isValidatedTree(receipt)).toBe(true);
  expect(tree.isValidatedTree({ ...receipt })).toBe(false);
});

it("does not expand exact script approval across versions or peer contexts", async () => {
  const { graph, artifacts } = await fixture();
  const decisions = scripts.planOfflineScripts(graph, artifacts, []);
  expect(decisions).toHaveLength(0);
  expect(() =>
    scripts.planOfflineScripts(graph, artifacts, [
      {
        nodeKey: "consumer@1.0.0(tool@1.0.0)",
        integrity: artifacts[0]!.integrity,
        phase: "install",
        commandHash: "a".repeat(64),
      },
    ]),
  ).toThrow("Script policy does not match authenticated content");
});

it("requires independent exact approvals for each peer placement of authenticated lifecycle code", async () => {
  const { graph, artifacts } = await fixture("none", true);
  const approval = {
    nodeKey: "consumer@1.0.0(tool@1.0.0)",
    integrity: artifacts[0]!.integrity,
    phase: "install" as const,
    commandHash: createHash("sha256").update("echo approved").digest("hex"),
  };
  expect(() => scripts.planOfflineScripts(graph, artifacts, [approval])).toThrow(
    "Exact dependency script approval unavailable",
  );
  const plan = scripts.planOfflineScripts(graph, artifacts, [
    approval,
    { ...approval, nodeKey: "consumer@1.0.0(tool@2.0.0)" },
  ]);
  expect(plan.map((instruction) => instruction.nodeKey)).toEqual([
    "consumer@1.0.0(tool@1.0.0)",
    "consumer@1.0.0(tool@2.0.0)",
  ]);
});

it.each([
  ["missing-bin", "Missing dependency tree entry"],
  ["wrong-peer", "Dependency tree link mismatch"],
  ["metadata", "Unexpected dependency tree entry"],
  ["wrapper", "Unexpected dependency tree entry"],
])("rejects %s in a complete peer-context tree", async (mutation, reason) => {
  const { graph, artifacts, pack } = await fixture(mutation);
  await expect(verifyDependencyTree(graph, artifacts, pack)).rejects.toThrow(reason);
});
