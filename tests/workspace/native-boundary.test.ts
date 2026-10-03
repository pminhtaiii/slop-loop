import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { selectWorkspace, closeWorkspace } from "../../src/workspace/admission.js";
import { WorkspaceBoundary } from "../../src/workspace/boundary.js";
import {
  closeNativeDescriptor,
  listNativeDirectory,
  openNativeChild,
  openNativeRoot,
  openNativeTarget,
  readNativeTarget,
} from "../../src/workspace/native.js";
import { createGitCheckout, symlinkFixtureAvailable } from "./fixtures.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

describe("native workspace open", () => {
  it("opens an eligible relative file through a held root", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const rootFd = openNativeRoot(fixture.root);
    cleanup.push(() => closeNativeDescriptor(rootFd));
    const fd = openNativeTarget(rootFd, "src/tracked.ts", "file");
    cleanup.push(() => closeNativeDescriptor(fd));
    expect(readNativeTarget(fd, 128).toString("utf8")).toContain("tracked");
  });

  it("opens a child from the retained parent after its original path is replaced", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const root = openNativeRoot(fixture.root);
    cleanup.push(() => closeNativeDescriptor(root));
    const parent = openNativeTarget(root, "src", "directory");
    cleanup.push(() => closeNativeDescriptor(parent));
    fs.renameSync(path.join(fixture.root, "src"), path.join(fixture.root, "old-src"));
    fs.mkdirSync(path.join(fixture.root, "src"));
    fixture.write("src/tracked.ts", "replacement\n");
    const child = openNativeChild(root, parent, "tracked.ts", "file");
    try {
      expect(readNativeTarget(child, 128).toString("utf8")).toContain("tracked");
      expect(readNativeTarget(child, 128).toString("utf8")).not.toContain("replacement");
    } finally {
      closeNativeDescriptor(child);
    }
  });

  it.skipIf(!symlinkFixtureAvailable("file"))(
    "resolves a retained child symlink to an eligible sibling within the held root",
    () => {
      const fixture = createGitCheckout();
      cleanup.push(() => fixture.cleanup());
      fixture.write("other/eligible.ts", "sibling\n");
      fixture.symlink("src/to-other.ts", "../other/eligible.ts");
      const root = openNativeRoot(fixture.root);
      cleanup.push(() => closeNativeDescriptor(root));
      const parent = openNativeTarget(root, "src", "directory");
      cleanup.push(() => closeNativeDescriptor(parent));
      const child = openNativeChild(root, parent, "to-other.ts", "file");
      try {
        expect(readNativeTarget(child, 128).toString("utf8")).toBe("sibling\n");
      } finally {
        closeNativeDescriptor(child);
      }
    },
  );

  it("classifies a file request for the workspace root as denied", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const root = openNativeRoot(fixture.root);
    cleanup.push(() => closeNativeDescriptor(root));
    let failure: unknown;
    try {
      openNativeTarget(root, ".", "file");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "WORKSPACE_OPEN_DENIED" });
  });

  it.skipIf(!symlinkFixtureAvailable("file"))(
    "opens a relative alias whose target remains inside the held root",
    () => {
      const fixture = createGitCheckout();
      cleanup.push(() => fixture.cleanup());
      fixture.symlink("relative.ts", "src/tracked.ts");
      const root = openNativeRoot(fixture.root);
      cleanup.push(() => closeNativeDescriptor(root));
      const fd = openNativeTarget(root, "relative.ts", "file");
      try {
        expect(readNativeTarget(fd, 128).toString("utf8")).toContain("tracked");
      } finally {
        closeNativeDescriptor(fd);
      }
    },
  );

  it.skipIf(!symlinkFixtureAvailable("file"))(
    "opens an absolute alias to the canonical physical checkout root",
    () => {
      const fixture = createGitCheckout();
      cleanup.push(() => fixture.cleanup());
      fixture.symlink(
        "absolute.ts",
        path.join(fs.realpathSync.native(fixture.root), "src/tracked.ts"),
      );
      const root = openNativeRoot(fixture.root);
      cleanup.push(() => closeNativeDescriptor(root));
      const fd = openNativeTarget(root, "absolute.ts", "file");
      try {
        expect(readNativeTarget(fd, 128).toString("utf8")).toContain("tracked");
      } finally {
        closeNativeDescriptor(fd);
      }
    },
  );

  it.skipIf(!symlinkFixtureAvailable("dir"))(
    "classifies a file alias to the workspace root as denied",
    () => {
      const fixture = createGitCheckout();
      cleanup.push(() => fixture.cleanup());
      fixture.symlink("root-alias.ts", fs.realpathSync.native(fixture.root), "dir");
      const root = openNativeRoot(fixture.root);
      cleanup.push(() => closeNativeDescriptor(root));
      let failure: unknown;
      try {
        openNativeTarget(root, "root-alias.ts", "file");
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "WORKSPACE_OPEN_DENIED" });
    },
  );

  it.skipIf(!symlinkFixtureAvailable("file"))(
    "rejects escape through a symlink even after an eligible alias is swapped",
    () => {
      const fixture = createGitCheckout();
      const outside = createGitCheckout();
      cleanup.push(
        () => fixture.cleanup(),
        () => outside.cleanup(),
      );
      const rootFd = openNativeRoot(fixture.root);
      cleanup.push(() => closeNativeDescriptor(rootFd));
      fixture.symlink("alias.ts", "src/tracked.ts");
      const fd = openNativeTarget(rootFd, "alias.ts", "file");
      closeNativeDescriptor(fd);
      fs.rmSync(path.join(fixture.root, "alias.ts"));
      fixture.symlink("alias.ts", path.join(outside.root, "src/tracked.ts"));
      expect(() => openNativeTarget(rootFd, "alias.ts", "file")).toThrow();
    },
  );

  it.skipIf(!symlinkFixtureAvailable("file"))(
    "stops a held read after its alias changes to ignored or secret content",
    () => {
      const fixture = createGitCheckout();
      cleanup.push(() => fixture.cleanup());
      fixture.writeDeniedPaths();
      fixture.write(".gitignore", "*.log\n");
      fixture.write("ignored.log", "ignored\n");
      fixture.symlink("alias.ts", "src/tracked.ts");
      const selected = selectWorkspace(fixture.root);
      expect(selected.kind).toBe("SELECTED");
      if (selected.kind !== "SELECTED") return;
      cleanup.push(() => closeWorkspace(selected.workspace));
      const boundary = new WorkspaceBoundary();
      for (const target of ["ignored.log", ".env"]) {
        const opened = boundary.openRegularRead(selected.workspace.workspaceId, "alias.ts");
        expect(opened.kind).toBe("OPENED");
        if (opened.kind !== "OPENED") return;
        try {
          fs.rmSync(path.join(fixture.root, "alias.ts"));
          fixture.symlink("alias.ts", target);
          expect(() => opened.target.read(128)).toThrow("Workspace target changed");
        } finally {
          opened.target.close();
          fs.rmSync(path.join(fixture.root, "alias.ts"));
          fixture.symlink("alias.ts", "src/tracked.ts");
        }
      }
    },
  );

  it.skipIf(!symlinkFixtureAvailable("file"))(
    "does not collapse an uninspected symlink target component before opening",
    () => {
      const fixture = createGitCheckout();
      cleanup.push(() => fixture.cleanup());
      fixture.symlink("alias.ts", "missing/../src/tracked.ts");
      const root = openNativeRoot(fixture.root);
      cleanup.push(() => closeNativeDescriptor(root));
      expect(() => openNativeTarget(root, "alias.ts", "file")).toThrow();
    },
  );

  it("rejects traversal independently of TypeScript validation", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const rootFd = openNativeRoot(fixture.root);
    cleanup.push(() => closeNativeDescriptor(rootFd));
    expect(() => openNativeTarget(rootFd, "../outside", "file")).toThrow();
    expect(() => openNativeTarget(rootFd, ".git/config", "file")).toThrow();
    expect(() => openNativeTarget(rootFd, ".GIT/config", "file")).toThrow();
    expect(() => openNativeTarget(rootFd, "src/tracked.ts:stream", "file")).toThrow();
  });

  it("rejects a hard-linked target and a directory requested as a regular file", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fs.linkSync(path.join(fixture.root, "src/tracked.ts"), path.join(fixture.root, "hard.ts"));
    const root = openNativeRoot(fixture.root);
    cleanup.push(() => closeNativeDescriptor(root));
    expect(() => openNativeTarget(root, "hard.ts", "file")).toThrow();
    expect(() => openNativeTarget(root, "src", "file")).toThrow();
  });

  it.skipIf(process.platform !== "linux")("rejects a Linux FIFO without blocking", (context) => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    try {
      execFileSync("mkfifo", [path.join(fixture.root, "pipe")], { timeout: 5_000 });
    } catch {
      context.skip("UNAVAILABLE: mkfifo fixture could not be created");
      return;
    }
    const root = openNativeRoot(fixture.root);
    cleanup.push(() => closeNativeDescriptor(root));
    expect(() => openNativeTarget(root, "pipe", "file")).toThrow();
  });

  it.skipIf(!symlinkFixtureAvailable("dir"))("rejects a directory symlink cycle", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fixture.symlink("src/cycle", "../src/cycle", "dir");
    const root = openNativeRoot(fixture.root);
    cleanup.push(() => closeNativeDescriptor(root));
    expect(() => openNativeTarget(root, "src/cycle/tracked.ts", "file")).toThrow();
  });

  it("enumerates from an opened directory with a fixed entry limit", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const root = openNativeRoot(fixture.root);
    cleanup.push(() => closeNativeDescriptor(root));
    const directory = openNativeTarget(root, "src", "directory");
    cleanup.push(() => closeNativeDescriptor(directory));
    expect(listNativeDirectory(directory, 10)).toContain("tracked.ts");
    expect(listNativeDirectory(directory, 0)).toEqual([]);
  });

  it("rejects a Node-owned descriptor without entering the platform backend", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const nodeFd = fs.openSync(fixture.root, "r");
    cleanup.push(() => fs.closeSync(nodeFd));
    expect(() => openNativeTarget(nodeFd, "src/tracked.ts", "file")).toThrow();
  });

  it("preserves raw line endings and control bytes in a native read", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fs.writeFileSync(path.join(fixture.root, "bytes.txt"), Buffer.from([65, 13, 10, 66, 26, 67]));
    const root = openNativeRoot(fixture.root);
    cleanup.push(() => closeNativeDescriptor(root));
    const target = openNativeTarget(root, "bytes.txt", "file");
    cleanup.push(() => closeNativeDescriptor(target));
    expect(readNativeTarget(target, 16)).toEqual(Buffer.from([65, 13, 10, 66, 26, 67]));
  });

  it("does not let a closed target token access a later reused descriptor", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fixture.write("src/other.ts", "other\n");
    const root = openNativeRoot(fixture.root);
    cleanup.push(() => closeNativeDescriptor(root));
    const first = openNativeTarget(root, "src/tracked.ts", "file");
    closeNativeDescriptor(first);
    const second = openNativeTarget(root, "src/other.ts", "file");
    cleanup.push(() => closeNativeDescriptor(second));
    expect(() => readNativeTarget(first, 64)).toThrow();
    expect(readNativeTarget(second, 64).toString("utf8")).toBe("other\n");
  });
});
