import { describe, expect, it } from "vitest";
import path from "node:path";

import { selectWorkspace, closeWorkspace } from "../../src/workspace/admission.js";
import { WorkspaceBoundary } from "../../src/workspace/boundary.js";
import { createGitCheckout, symlinkFixtureAvailable } from "./fixtures.js";

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

  it.skipIf(!symlinkFixtureAvailable("file"))(
    "accepts an eligible in-root alias and denies an alias to a secret or outside target",
    () => {
      const fixture = createGitCheckout();
      const outside = createGitCheckout();
      try {
        fixture.writeDeniedPaths();
        fixture.symlink("good.ts", "src/tracked.ts");
        fixture.symlink("secret.ts", ".env");
        fixture.symlink("outside.ts", path.join(outside.root, "src/tracked.ts"));
        const selected = selectWorkspace(fixture.root);
        expect(selected.kind).toBe("SELECTED");
        if (selected.kind !== "SELECTED") return;
        try {
          const boundary = new WorkspaceBoundary();
          const ceiling = { workspaceId: selected.workspace.workspaceId } as Parameters<
            typeof boundary.factsFor
          >[1];
          const fact = (alias: string) =>
            boundary.factsFor({ name: "read_file", arguments: { path: alias } }, ceiling)[0];
          expect(fact("good.ts")).toMatchObject({
            status: "ALLOWED",
            canonicalPath: "src/tracked.ts",
          });
          expect(fact("secret.ts")).toMatchObject({ status: "FORBIDDEN" });
          expect(fact("outside.ts")).toMatchObject({ status: "FORBIDDEN" });
        } finally {
          closeWorkspace(selected.workspace);
        }
      } finally {
        fixture.cleanup();
        outside.cleanup();
      }
    },
  );
});
