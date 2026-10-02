import { describe, expect, it } from "vitest";

import { isDeniedRepositoryPath, parseRepositoryPath } from "../../src/workspace/path-policy.js";

describe("repository path policy", () => {
  it.each([
    "../outside",
    "a/../b",
    "/etc/passwd",
    "C:/secret",
    "C:\\secret",
    "\\\\server\\share",
    "a\0b",
    "a//b",
    "a/./b",
    "a\\b",
    "src/file.txt:secret",
  ])("rejects unsafe relative syntax: %s", (value) =>
    expect(parseRepositoryPath(value)).toBeNull(),
  );

  it("normalizes only safe relative aliases", () => {
    expect(parseRepositoryPath("src/file.ts")).toBe("src/file.ts");
    expect(parseRepositoryPath(".")).toBe(".");
  });

  it.each([
    ".env",
    "dir/.env.local",
    ".ssh/id_ed25519",
    ".aws/credentials",
    "key.pem",
    "nested/id_rsa",
    ".git/config",
    "DIR/.ENV",
  ])("denies a secret or metadata alias: %s", (value) =>
    expect(isDeniedRepositoryPath(value)).toBe(true),
  );

  it("accepts an ordinary source path", () => {
    expect(isDeniedRepositoryPath("src/main.ts")).toBe(false);
  });
});
