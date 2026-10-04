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
