import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  closeNativeDescriptor,
  listNativeDirectory,
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
