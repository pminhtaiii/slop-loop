import { describe, expect, it } from "vitest";

import { parseLockedArtifacts, validateLockedArtifact } from "../../src/sandbox/downloads.js";

describe("trusted locked downloads", () => {
  it("extracts exact registry tarballs and integrity from a supported lockfile", () => {
    const lockfile = `
lockfileVersion: '9.0'
packages:
  pkg@1.2.3:
    resolution:
      integrity: sha512-${"a".repeat(86)}
      tarball: https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz
`;

    expect(parseLockedArtifacts(lockfile)).toEqual([
      {
        name: "pkg",
        version: "1.2.3",
        tarball: "https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz",
        integrity: `sha512-${"a".repeat(86)}`,
      },
    ]);
  });

  it.each([
    "git+https://github.com/example/pkg.git",
    "file:../pkg",
    "workspace:*",
    "https://evil.example/pkg.tgz",
  ])("rejects unsupported dependency source %s", (source) => {
    expect(() =>
      validateLockedArtifact({
        name: "pkg",
        version: "1.2.3",
        tarball: source,
        integrity: `sha512-${"a".repeat(86)}`,
      }),
    ).toThrow();
  });

  it("rejects missing integrity and non-exact versions", () => {
    expect(() =>
      validateLockedArtifact({
        name: "pkg",
        version: "latest",
        tarball: "https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz",
        integrity: "",
      }),
    ).toThrow();
  });
});

it("parses pnpm v9 inline resolutions and quoted scoped package identities", () => {
  expect(
    parseLockedArtifacts(`
lockfileVersion: '9.0'
packages:
  pkg@1.2.3:
    resolution: {integrity: sha512-YWJj}
  '@scope/pkg@2.0.0-beta.1':
    resolution: {integrity: sha512-ZGVm}
snapshots:
  pkg@1.2.3: {}
  '@scope/pkg@2.0.0-beta.1': {}
`),
  ).toEqual([
    {
      name: "pkg",
      version: "1.2.3",
      integrity: "sha512-YWJj",
      tarball: "https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz",
    },
    {
      name: "@scope/pkg",
      version: "2.0.0-beta.1",
      integrity: "sha512-ZGVm",
      tarball: "https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0-beta.1.tgz",
    },
  ]);
});

it.each(["", "/"])("strips pnpm peer suffixes with leading prefix '%s'", (prefix) => {
  expect(
    parseLockedArtifacts(`
packages:
  '${prefix}pkg@1.2.3(peer@4.0.0)':
    resolution: {integrity: sha512-YWJj}
  '${prefix}@scope/pkg@2.0.0-beta.1(@scope/peer@4.0.0(nested@5.0.0))(other@6.0.0)':
    resolution: {integrity: sha512-ZGVm}
`),
  ).toEqual([
    {
      name: "pkg",
      version: "1.2.3",
      integrity: "sha512-YWJj",
      tarball: "https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz",
    },
    {
      name: "@scope/pkg",
      version: "2.0.0-beta.1",
      integrity: "sha512-ZGVm",
      tarball: "https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0-beta.1.tgz",
    },
  ]);
});

it.each([
  "resolution: {tarball: 'https://evil.example/pkg.tgz', integrity: sha512-YWJj}",
  "resolution: {integrity: 123}",
  "resolution: {directory: '../pkg'}",
])("rejects unsupported or malformed pnpm resolution %s", (resolution) => {
  expect(() => parseLockedArtifacts(`packages:\n  pkg@1.2.3:\n    ${resolution}\n`)).toThrow();
});

it("reads package-manager and project documents in the reference pnpm lockfile", () => {
  const artifacts = parseLockedArtifacts(`---
lockfileVersion: '9.0'
packages:
  pnpm@12.5.1:
    resolution: {integrity: sha512-YWJj}
---
lockfileVersion: '9.0'
packages:
  '@scope/pkg@1.0.0':
    resolution: {integrity: sha512-ZGVm}
`);
  expect(artifacts.map(({ name, version }) => ({ name, version }))).toEqual([
    { name: "pnpm", version: "12.5.1" },
    { name: "@scope/pkg", version: "1.0.0" },
  ]);
});

it("rejects lockfiles with more than the bounded artifact count", { timeout: 30_000 }, () => {
  const packages = Array.from({ length: 10_001 }, (_, index) => {
    return `  pkg-${index}@1.0.0:\n    resolution: {integrity: sha512-YWJj}`;
  }).join("\n");

  expect(() => parseLockedArtifacts(`lockfileVersion: '9.0'\npackages:\n${packages}\n`)).toThrow(
    "Locked artifact count exceeds limit",
  );
});
