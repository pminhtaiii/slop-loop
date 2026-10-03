import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  selectWorkspace,
  closeWorkspace,
  nativeRootForWorkspace,
} from "../../src/workspace/admission.js";
import { WorkspaceBoundary } from "../../src/workspace/boundary.js";
import { createGitCheckout, symlinkFixtureAvailable } from "./fixtures.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

describe("real workspace facts", () => {
  it("preflights update and exclusive create with current parent and target identities", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const boundary = new WorkspaceBoundary();
    expect(
      boundary.inspectMutationPath(selected.workspace.workspaceId, "src/tracked.ts", "update"),
    ).toMatchObject({ kind: "INSPECTED", canonicalPath: "src/tracked.ts", operation: "update" });
    expect(
      boundary.inspectMutationPath(selected.workspace.workspaceId, "new.ts", "create"),
    ).toMatchObject({ kind: "INSPECTED", canonicalPath: "new.ts", targetIdentity: null });
    expect(
      boundary.inspectMutationPath(selected.workspace.workspaceId, "src/tracked.ts", "create"),
    ).toMatchObject({ kind: "FORBIDDEN" });
    expect(
      boundary.inspectMutationPath(selected.workspace.workspaceId, ".env", "create"),
    ).toMatchObject({ kind: "FORBIDDEN" });
    fixture.write(".gitignore", "*.log\n");
    expect(
      boundary.inspectMutationPath(selected.workspace.workspaceId, "ignored.log", "create"),
    ).toMatchObject({ kind: "FORBIDDEN" });
  }, 10_000);

  it("does not preflight a create inside a nested repository", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fs.mkdirSync(path.join(fixture.root, "nested"));
    fixture.git("-C", path.join(fixture.root, "nested"), "init", "-q");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    expect(
      new WorkspaceBoundary().inspectMutationPath(
        selected.workspace.workspaceId,
        "nested/new.ts",
        "create",
      ),
    ).toMatchObject({ kind: "FORBIDDEN" });
  });

  it.skipIf(process.platform !== "win32")("rejects a junction in a mutation parent", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fixture.symlink("linked", path.join(fixture.root, "src"), "junction");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    expect(
      new WorkspaceBoundary().inspectMutationPath(
        selected.workspace.workspaceId,
        "linked/new.ts",
        "create",
      ),
    ).toMatchObject({ kind: "FORBIDDEN" });
  });

  it("allows a member file and an implicit root scope", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const boundary = new WorkspaceBoundary();
    const ceiling = { workspaceId: selected.workspace.workspaceId } as Parameters<
      typeof boundary.factsFor
    >[1];
    expect(
      boundary.factsFor({ name: "read_file", arguments: { path: "src/tracked.ts" } }, ceiling),
    ).toMatchObject([
      { requestedPath: "src/tracked.ts", canonicalPath: "src/tracked.ts", status: "ALLOWED" },
    ]);
    expect(boundary.factsFor({ name: "list_files", arguments: {} }, ceiling)).toMatchObject([
      { requestedPath: ".", canonicalPath: ".", status: "ALLOWED" },
    ]);
  });

  it("forbids traversal, secret aliases, ignored paths, and missing members", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fixture.writeDeniedPaths();
    fixture.write(".gitignore", "*.log\n");
    fixture.write("hidden.log", "hidden\n");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const boundary = new WorkspaceBoundary();
    const ceiling = { workspaceId: selected.workspace.workspaceId } as Parameters<
      typeof boundary.factsFor
    >[1];
    for (const requested of ["../outside", ".env", "hidden.log", "missing.ts", ".git/config"]) {
      expect(
        boundary.factsFor({ name: "read_file", arguments: { path: requested } }, ceiling),
      ).toMatchObject([{ status: "FORBIDDEN" }]);
    }
  });

  it("returns unavailable facts for an unknown workspace identity", () => {
    const boundary = new WorkspaceBoundary();
    const ceiling = { workspaceId: "forged" } as Parameters<typeof boundary.factsFor>[1];
    expect(() => boundary.factsFor({ name: "list_files", arguments: {} }, ceiling)).toThrow();
  });

  it("does not classify a native identity inspection failure as a forbidden path", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const require = createRequire(import.meta.url);
    const native = require("../../native/workspace/build/Release/workspace_boundary.node") as {
      targetPath: (...arguments_: unknown[]) => string;
    };
    const original = native.targetPath;
    native.targetPath = () => {
      throw new Error("inspection unavailable");
    };
    try {
      const boundary = new WorkspaceBoundary();
      const ceiling = { workspaceId: selected.workspace.workspaceId } as Parameters<
        typeof boundary.factsFor
      >[1];
      expect(() =>
        boundary.factsFor({ name: "read_file", arguments: { path: "src/tracked.ts" } }, ceiling),
      ).toThrow();
    } finally {
      native.targetPath = original;
    }
  });

  it("does not issue forbidden facts when the held root fails post-open verification", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const rootFd = nativeRootForWorkspace(selected.workspace);
    expect(rootFd).not.toBeNull();
    const require = createRequire(import.meta.url);
    const native = require("../../native/workspace/build/Release/workspace_boundary.node") as {
      targetPath: (...arguments_: unknown[]) => string;
      targetIdentity: (...arguments_: unknown[]) => unknown;
    };
    const originalPath = native.targetPath;
    const originalIdentity = native.targetIdentity;
    let targetOpened = false;
    let rootChecksAfterOpen = 0;
    native.targetPath = (...args: unknown[]) => {
      targetOpened = true;
      return originalPath(...args);
    };
    native.targetIdentity = (...args: unknown[]) => {
      if (targetOpened && args[0] === rootFd && ++rootChecksAfterOpen === 1)
        throw new Error("root identity unavailable");
      return originalIdentity(...args);
    };
    try {
      const boundary = new WorkspaceBoundary();
      const ceiling = { workspaceId: selected.workspace.workspaceId } as Parameters<
        typeof boundary.factsFor
      >[1];
      expect(() =>
        boundary.factsFor({ name: "read_file", arguments: { path: "src/tracked.ts" } }, ceiling),
      ).toThrow("Workspace identity unavailable");
    } finally {
      native.targetPath = originalPath;
      native.targetIdentity = originalIdentity;
    }
  });

  it.skipIf(!symlinkFixtureAvailable("file"))(
    "rejects an ignored alias to an otherwise eligible file",
    () => {
      const fixture = createGitCheckout();
      cleanup.push(() => fixture.cleanup());
      fixture.write(".gitignore", "*.log\n");
      fixture.symlink("alias.log", "src/tracked.ts");
      const selected = selectWorkspace(fixture.root);
      expect(selected.kind).toBe("SELECTED");
      if (selected.kind !== "SELECTED") return;
      cleanup.push(() => closeWorkspace(selected.workspace));
      const boundary = new WorkspaceBoundary();
      const ceiling = { workspaceId: selected.workspace.workspaceId } as Parameters<
        typeof boundary.factsFor
      >[1];
      expect(
        boundary.factsFor({ name: "read_file", arguments: { path: "alias.log" } }, ceiling),
      ).toMatchObject([{ status: "FORBIDDEN" }]);
    },
  );

  it("denies a hard-linked file before any bytes are returned", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fs.linkSync(path.join(fixture.root, "src/tracked.ts"), path.join(fixture.root, "hard.ts"));
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const boundary = new WorkspaceBoundary();
    expect(
      boundary.openRegularRead(selected.workspace.workspaceId, "src/tracked.ts"),
    ).toMatchObject({ kind: "FORBIDDEN" });
  });

  it("enumerates eligible entries from a held directory and closes the handle", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fixture.write("src/extra.ts", "export const extra = true;\n");
    fixture.write("src/ignored.log", "hidden\n");
    fixture.write(".gitignore", "*.log\n");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const opened = new WorkspaceBoundary().openDirectory(selected.workspace.workspaceId, "src");
    expect(opened.kind).toBe("OPENED");
    if (opened.kind !== "OPENED") return;
    const entries = opened.target.entries().map((entry) => entry.name);
    expect(entries).toEqual(expect.arrayContaining(["tracked.ts", "extra.ts"]));
    expect(entries).not.toContain("ignored.log");
    opened.target.close();
    expect(() => opened.target.entries()).toThrow();
  });

  it("rejects entries when the retained parent directory is replaced", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const opened = new WorkspaceBoundary().openDirectory(selected.workspace.workspaceId, "src");
    expect(opened.kind).toBe("OPENED");
    if (opened.kind !== "OPENED") return;
    try {
      fs.renameSync(path.join(fixture.root, "src"), path.join(fixture.root, "old-src"));
      fs.mkdirSync(path.join(fixture.root, "src"));
      fixture.write("src/tracked.ts", "replacement\n");
      expect(() => opened.target.entries()).toThrow("Directory target changed");
    } finally {
      opened.target.close();
    }
  });

  it.skipIf(!symlinkFixtureAvailable("dir"))(
    "rejects entries after a directory alias is retargeted",
    () => {
      const fixture = createGitCheckout();
      cleanup.push(() => fixture.cleanup());
      fixture.write("other/tracked.ts", "other\n");
      fixture.symlink("src-link", "src", "dir");
      const selected = selectWorkspace(fixture.root);
      expect(selected.kind).toBe("SELECTED");
      if (selected.kind !== "SELECTED") return;
      cleanup.push(() => closeWorkspace(selected.workspace));
      const opened = new WorkspaceBoundary().openDirectory(
        selected.workspace.workspaceId,
        "src-link",
      );
      expect(opened.kind).toBe("OPENED");
      if (opened.kind !== "OPENED") return;
      try {
        fs.unlinkSync(path.join(fixture.root, "src-link"));
        fixture.symlink("src-link", "other", "dir");
        expect(() => opened.target.entries()).toThrow("Directory target changed");
      } finally {
        opened.target.close();
      }
    },
  );

  it("rejects a parent swap during child resolution", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const opened = new WorkspaceBoundary().openDirectory(selected.workspace.workspaceId, "src");
    expect(opened.kind).toBe("OPENED");
    if (opened.kind !== "OPENED") return;
    const require = createRequire(import.meta.url);
    const native = require("../../native/workspace/build/Release/workspace_boundary.node") as {
      openChild: (...arguments_: unknown[]) => number;
    };
    const original = native.openChild;
    let swapped = false;
    native.openChild = (...args: unknown[]) => {
      if (!swapped && args[2] === "tracked.ts") {
        swapped = true;
        fs.renameSync(path.join(fixture.root, "src"), path.join(fixture.root, "old-src"));
        fs.mkdirSync(path.join(fixture.root, "src"));
        fixture.write("src/tracked.ts", "replacement\n");
      }
      return original(...args);
    };
    try {
      expect(() => opened.target.entries()).toThrow("Directory target changed");
    } finally {
      native.openChild = original;
      opened.target.close();
    }
  });

  it("fails closed when Git membership changes while opening directory children", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fixture.write("src/transient.log", "temporary\n");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const opened = new WorkspaceBoundary().openDirectory(selected.workspace.workspaceId, "src");
    expect(opened.kind).toBe("OPENED");
    if (opened.kind !== "OPENED") return;
    const require = createRequire(import.meta.url);
    const native = require("../../native/workspace/build/Release/workspace_boundary.node") as {
      openChild: (...arguments_: unknown[]) => number;
    };
    const original = native.openChild;
    let changed = false;
    native.openChild = (...args: unknown[]) => {
      const result = original(...args);
      if (!changed && args[2] === "transient.log") {
        changed = true;
        fixture.write(".gitignore", "*.log\n");
      }
      return result;
    };
    try {
      expect(() => opened.target.entries()).toThrow("Directory target changed");
      const names = opened.target.entries().map((entry) => entry.name);
      expect(names).not.toContain("transient.log");
      expect(names).toContain("tracked.ts");
    } finally {
      native.openChild = original;
      opened.target.close();
    }
  });

  it("rejects an earlier child replaced while a later child opens", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fixture.write("src/extra.ts", "extra\n");
    fixture.write("outside.txt", "linked\n");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const opened = new WorkspaceBoundary().openDirectory(selected.workspace.workspaceId, "src");
    expect(opened.kind).toBe("OPENED");
    if (opened.kind !== "OPENED") return;
    const require = createRequire(import.meta.url);
    const native = require("../../native/workspace/build/Release/workspace_boundary.node") as {
      openChild: (...arguments_: unknown[]) => number;
    };
    const original = native.openChild;
    let firstName: string | null = null;
    let replaced = false;
    native.openChild = (...args: unknown[]) => {
      const name = String(args[2]);
      if (firstName === null) firstName = name;
      else if (!replaced && name !== firstName) {
        replaced = true;
        fs.unlinkSync(path.join(fixture.root, "src", firstName));
        fs.linkSync(
          path.join(fixture.root, "outside.txt"),
          path.join(fixture.root, "src", firstName),
        );
      }
      return original(...args);
    };
    try {
      expect(() => opened.target.entries()).toThrow("Directory target changed");
      expect(replaced).toBe(true);
    } finally {
      native.openChild = original;
      opened.target.close();
    }
  });

  it("rechecks the canonical location of a child before returning a directory snapshot", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fixture.write(".env", "secret\n");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const opened = new WorkspaceBoundary().openDirectory(selected.workspace.workspaceId, "src");
    expect(opened.kind).toBe("OPENED");
    if (opened.kind !== "OPENED") return;
    const require = createRequire(import.meta.url);
    const native = require("../../native/workspace/build/Release/workspace_boundary.node") as {
      openChild: (...arguments_: unknown[]) => number;
      openRelative: (rootFd: number, path: string, directory: boolean) => number;
    };
    const original = native.openChild;
    let opens = 0;
    native.openChild = (...args: unknown[]) => {
      if (args[2] === "tracked.ts" && ++opens === 2)
        return native.openRelative(Number(args[0]), ".env", false);
      return original(...args);
    };
    try {
      expect(() => opened.target.entries()).toThrow("Directory target changed");
      expect(opens).toBe(2);
    } finally {
      native.openChild = original;
      opened.target.close();
    }
  });

  it.skipIf(!symlinkFixtureAvailable("file"))(
    "rejects a child alias retarget to a denied path without changing its inode",
    () => {
      const fixture = createGitCheckout();
      cleanup.push(() => fixture.cleanup());
      fixture.write("src/extra.ts", "extra\n");
      fixture.git("add", "src/extra.ts");
      fixture.write(".gitignore", ".env\n");
      const selected = selectWorkspace(fixture.root);
      expect(selected.kind).toBe("SELECTED");
      if (selected.kind !== "SELECTED") return;
      cleanup.push(() => closeWorkspace(selected.workspace));
      const opened = new WorkspaceBoundary().openDirectory(selected.workspace.workspaceId, "src");
      expect(opened.kind).toBe("OPENED");
      if (opened.kind !== "OPENED") return;
      const require = createRequire(import.meta.url);
      const native = require("../../native/workspace/build/Release/workspace_boundary.node") as {
        openChild: (...arguments_: unknown[]) => number;
      };
      const original = native.openChild;
      let firstName: string | null = null;
      let retargeted = false;
      native.openChild = (...args: unknown[]) => {
        const name = String(args[2]);
        if (firstName === null) firstName = name;
        else if (!retargeted && name !== firstName) {
          retargeted = true;
          fs.renameSync(path.join(fixture.root, "src", firstName), path.join(fixture.root, ".env"));
          fixture.symlink(`src/${firstName}`, "../.env");
        }
        return original(...args);
      };
      try {
        expect(() => opened.target.entries()).toThrow("Directory target changed");
        expect(retargeted).toBe(true);
      } finally {
        native.openChild = original;
        opened.target.close();
      }
    },
  );

  it("revalidates child membership and identity for each directory snapshot", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fixture.write("src/transient.log", "temporary\n");
    fixture.write("src/replace.ts", "original\n");
    fixture.write("outside.txt", "linked\n");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const opened = new WorkspaceBoundary().openDirectory(selected.workspace.workspaceId, "src");
    expect(opened.kind).toBe("OPENED");
    if (opened.kind !== "OPENED") return;
    try {
      expect(opened.target.entries().map((entry) => entry.name)).toEqual(
        expect.arrayContaining(["transient.log", "replace.ts"]),
      );
      fixture.write(".gitignore", "*.log\n");
      fs.unlinkSync(path.join(fixture.root, "src/replace.ts"));
      fs.linkSync(
        path.join(fixture.root, "outside.txt"),
        path.join(fixture.root, "src/replace.ts"),
      );
      const names = opened.target.entries().map((entry) => entry.name);
      expect(names).not.toContain("transient.log");
      expect(names).not.toContain("replace.ts");
      expect(names).toContain("tracked.ts");
    } finally {
      opened.target.close();
    }
  });

  it.skipIf(!symlinkFixtureAvailable("dir"))(
    "rejects an alias retarget during child resolution",
    () => {
      const fixture = createGitCheckout();
      cleanup.push(() => fixture.cleanup());
      fixture.write("other/tracked.ts", "other\n");
      fixture.symlink("src-link", "src", "dir");
      const selected = selectWorkspace(fixture.root);
      expect(selected.kind).toBe("SELECTED");
      if (selected.kind !== "SELECTED") return;
      cleanup.push(() => closeWorkspace(selected.workspace));
      const opened = new WorkspaceBoundary().openDirectory(
        selected.workspace.workspaceId,
        "src-link",
      );
      expect(opened.kind).toBe("OPENED");
      if (opened.kind !== "OPENED") return;
      const require = createRequire(import.meta.url);
      const native = require("../../native/workspace/build/Release/workspace_boundary.node") as {
        openChild: (...arguments_: unknown[]) => number;
      };
      const original = native.openChild;
      let swapped = false;
      native.openChild = (...args: unknown[]) => {
        if (!swapped && args[2] === "tracked.ts") {
          swapped = true;
          fs.unlinkSync(path.join(fixture.root, "src-link"));
          fixture.symlink("src-link", "other", "dir");
        }
        return original(...args);
      };
      try {
        expect(() => opened.target.entries()).toThrow("Directory target changed");
      } finally {
        native.openChild = original;
        opened.target.close();
      }
    },
  );

  it("does not read a pinned file after its eligible alias changes", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const opened = new WorkspaceBoundary().openRegularRead(
      selected.workspace.workspaceId,
      "src/tracked.ts",
    );
    expect(opened.kind).toBe("OPENED");
    if (opened.kind !== "OPENED") return;
    try {
      fs.renameSync(path.join(fixture.root, "src/tracked.ts"), path.join(fixture.root, ".env"));
      fixture.write("src/tracked.ts", "replacement\n");
      expect(() => opened.target.read(128)).toThrow();
    } finally {
      opened.target.close();
    }
  });

  it("does not read a held file after Git ignore rules remove its membership", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fixture.write("ephemeral.log", "initial\n");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const opened = new WorkspaceBoundary().openRegularRead(
      selected.workspace.workspaceId,
      "ephemeral.log",
    );
    expect(opened.kind).toBe("OPENED");
    if (opened.kind !== "OPENED") return;
    try {
      fixture.write(".gitignore", "*.log\n");
      expect(() => opened.target.read(128)).toThrow("Workspace target changed");
    } finally {
      opened.target.close();
    }
  });

  it("fails closed when native directory enumeration reaches its internal cap", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const require = createRequire(import.meta.url);
    const native = require("../../native/workspace/build/Release/workspace_boundary.node") as {
      listDirectory: (...arguments_: unknown[]) => string[];
    };
    const original = native.listDirectory;
    native.listDirectory = () => Array.from({ length: 1024 }, (_, index) => `item-${index}`);
    try {
      expect(
        new WorkspaceBoundary().openDirectory(selected.workspace.workspaceId, "src"),
      ).toMatchObject({
        kind: "UNAVAILABLE",
      });
    } finally {
      native.listDirectory = original;
    }
  });

  it("does not omit an entry when its native inspection is unavailable", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const opened = new WorkspaceBoundary().openDirectory(selected.workspace.workspaceId, "src");
    expect(opened.kind).toBe("OPENED");
    if (opened.kind !== "OPENED") return;
    const require = createRequire(import.meta.url);
    const native = require("../../native/workspace/build/Release/workspace_boundary.node") as {
      openChild: (...arguments_: unknown[]) => number;
    };
    const original = native.openChild;
    native.openChild = (...args: unknown[]) => {
      if (args[2] === "tracked.ts")
        throw Object.assign(new Error("native inspection unavailable"), {
          code: "WORKSPACE_OPEN_UNAVAILABLE",
        });
      return original(...args);
    };
    try {
      expect(() => opened.target.entries()).toThrow("native inspection unavailable");
    } finally {
      native.openChild = original;
    }
    try {
      expect(opened.target.entries()).toContainEqual({
        name: "tracked.ts",
        canonicalPath: "src/tracked.ts",
      });
    } finally {
      opened.target.close();
    }
  });

  it.skipIf(!symlinkFixtureAvailable("dir"))(
    "allows an in-root directory symlink for listing",
    () => {
      const fixture = createGitCheckout();
      cleanup.push(() => fixture.cleanup());
      fixture.symlink("src-link", "src", "dir");
      const selected = selectWorkspace(fixture.root);
      expect(selected.kind).toBe("SELECTED");
      if (selected.kind !== "SELECTED") return;
      cleanup.push(() => closeWorkspace(selected.workspace));
      const boundary = new WorkspaceBoundary();
      const ceiling = { workspaceId: selected.workspace.workspaceId } as Parameters<
        typeof boundary.factsFor
      >[1];
      expect(
        boundary.factsFor({ name: "list_files", arguments: { path: "src-link" } }, ceiling),
      ).toMatchObject([{ status: "ALLOWED", canonicalPath: "src" }]);
      const opened = boundary.openDirectory(selected.workspace.workspaceId, "src-link");
      expect(opened.kind).toBe("OPENED");
      if (opened.kind === "OPENED") {
        try {
          expect(opened.target.entries()).toContainEqual({
            name: "tracked.ts",
            canonicalPath: "src/tracked.ts",
          });
        } finally {
          opened.target.close();
        }
      }
    },
  );

  it.skipIf(!symlinkFixtureAvailable("dir"))(
    "omits a directory symlink cycle from traversal",
    () => {
      const fixture = createGitCheckout();
      cleanup.push(() => fixture.cleanup());
      fixture.symlink("src/back", "..", "dir");
      const selected = selectWorkspace(fixture.root);
      expect(selected.kind).toBe("SELECTED");
      if (selected.kind !== "SELECTED") return;
      cleanup.push(() => closeWorkspace(selected.workspace));
      const opened = new WorkspaceBoundary().openDirectory(selected.workspace.workspaceId, "src");
      expect(opened.kind).toBe("OPENED");
      if (opened.kind !== "OPENED") return;
      try {
        const names = opened.target.entries().map((entry) => entry.name);
        expect(names).not.toContain("back");
      } finally {
        opened.target.close();
      }
    },
  );
});
