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
