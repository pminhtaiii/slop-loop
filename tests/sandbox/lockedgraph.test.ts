import { expect, it } from "vitest";
import * as downloads from "../../src/sandbox/downloads.js";
import fs from "node:fs";
import { createHash } from "node:crypto";

const graph = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      fixture: {specifier: 1.0.0, version: 1.0.0}
packages:
  fixture@1.0.0:
    resolution: {integrity: sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==}
snapshots:
  fixture@1.0.0: {}
`;
it("rejects unsupported executable configuration instead of silently reading only packages", () => {
  expect(() =>
    downloads.parseLockedGraph(
      graph + "configDependencies: {evil: 'git+ssh://invalid'}\n",
      '{"dependencies":{"fixture":"1.0.0"}}',
    ),
  ).toThrow("Unsupported locked graph");
});
it("validates the entire current reference graph including the pinned manager document", () => {
  const parsed = downloads.parseLockedGraph(
    fs.readFileSync("pnpm-lock.yaml", "utf8"),
    fs.readFileSync("package.json", "utf8"),
  );
  expect(parsed.artifacts.some((a) => a.name === "vitest" && a.version === "3.2.7")).toBe(true);
  expect(JSON.parse(parsed.manifest)).not.toHaveProperty("scripts");
});
it("rejects a malformed digest before fetch admission", () => {
  expect(() =>
    downloads.parseLockedGraph(
      graph.replace(
        "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
        "sha512-AA==",
      ),
      '{"dependencies":{"fixture":"1.0.0"}}',
    ),
  ).toThrow("Locked artifact digest encoding is invalid");
});
it("rejects credentials and nonstandard ports in exact artifact URLs", () => {
  const artifact = {
    name: "fixture",
    version: "1.0.0",
    integrity: "sha512-AAAA",
    tarball: "https://unused:fixture@registry.npmjs.org/fixture/-/fixture-1.0.0.tgz",
  };
  expect(() => downloads.validateLockedArtifact(artifact)).toThrow(
    "Locked artifact destination is unsafe",
  );
  expect(() =>
    downloads.validateLockedArtifact({
      ...artifact,
      tarball: "https://registry.npmjs.org:444/fixture/-/fixture-1.0.0.tgz",
    }),
  ).toThrow("Locked artifact destination is unsafe");
});
it("checks actual downloaded bytes instead of accepting a syntactically valid integrity string", () => {
  const bytes = Buffer.from("locked registry bytes");
  const artifact = {
    name: "fixture",
    version: "1.0.0",
    integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    tarball: "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz",
  };
  expect(() =>
    downloads.verifyArtifactBytes(artifact, Buffer.from("corrupt registry bytes")),
  ).toThrow("Artifact integrity failure");
  expect(() => downloads.verifyArtifactBytes(artifact, bytes)).not.toThrow();
});

it("rejects unsupported peer sources at graph admission", () => {
  const peerGraph = graph.replace(
    "    resolution:",
    "    peerDependencies: {evil: 'git+ssh://invalid'}\n    resolution:",
  );
  expect(() =>
    downloads.parseLockedGraph(peerGraph, '{"dependencies":{"fixture":"1.0.0"}}'),
  ).toThrow("Unsupported dependency source");
});

it("rejects peer-context identities whose resolved peer is absent from the frozen graph", () => {
  const absentPeer = graph
    .replace("version: 1.0.0}", "version: 1.0.0(peer@2.0.0)}")
    .replace("  fixture@1.0.0: {}", "  fixture@1.0.0(peer@2.0.0): {}");
  expect(() =>
    downloads.parseLockedGraph(absentPeer, '{"dependencies":{"fixture":"1.0.0"}}'),
  ).toThrow("Missing locked peer");
});

it("rejects a declared resolved peer context without its matching dependency edge", () => {
  const peers = graph
    .replace("version: 1.0.0}", "version: 1.0.0(peer@2.0.0)}")
    .replace("    resolution:", "    peerDependencies: {peer: '^2.0.0'}\n    resolution:")
    .replace(
      "snapshots:",
      "  peer@2.0.0:\n    resolution: {integrity: sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==}\nsnapshots:",
    )
    .replace("  fixture@1.0.0: {}", "  fixture@1.0.0(peer@2.0.0): {}\n  peer@2.0.0: {}");
  expect(() => downloads.parseLockedGraph(peers, '{"dependencies":{"fixture":"1.0.0"}}')).toThrow(
    "Locked peer edge mismatch",
  );
});

it("rejects a manager importer that lacks its pinned package and snapshot", () => {
  const manager = graph.replace(
    "    dependencies:\n      fixture: {specifier: 1.0.0, version: 1.0.0}",
    "    configDependencies: {}\n    packageManagerDependencies:\n      pnpm: {specifier: 12.5.1, version: 12.5.1}",
  );
  expect(() =>
    downloads.parseLockedGraph(manager + "\n---\n" + graph, '{"dependencies":{"fixture":"1.0.0"}}'),
  ).toThrow("Missing locked package manager");
});
