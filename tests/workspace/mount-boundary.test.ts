import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  closeNativeDescriptor,
  openNativeRoot,
  openNativeTarget,
} from "../../src/workspace/native.js";
import { createGitCheckout } from "./fixtures.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

describe("mounted paths below the selected root", () => {
  it.skipIf(process.platform !== "win32")(
    "denies Windows junctions even when the target is inside the checkout",
    (context) => {
      const fixture = createGitCheckout();
      const other = createGitCheckout();
      cleanup.push(
        () => fixture.cleanup(),
        () => other.cleanup(),
      );
      try {
        fixture.symlink("mounted", other.root, "junction");
        fixture.symlink("inside", path.join(fixture.root, "src"), "junction");
      } catch {
        context.skip("UNAVAILABLE: Windows junction fixture could not be created");
        return;
      }
      const root = openNativeRoot(fixture.root);
      cleanup.push(() => closeNativeDescriptor(root));
      expect(() => openNativeTarget(root, "mounted/src/tracked.ts", "file")).toThrow();
      expect(() => openNativeTarget(root, "inside/tracked.ts", "file")).toThrow();
    },
  );

  it.skipIf(process.platform !== "linux")(
    "denies a Linux bind mount or reports fixture unavailable",
    (context) => {
      const fixture = createGitCheckout();
      const other = createGitCheckout();
      cleanup.push(
        () => fixture.cleanup(),
        () => other.cleanup(),
      );
      const mountpoint = path.join(fixture.root, "mounted");
      fs.mkdirSync(mountpoint);
      try {
        execFileSync("mount", ["--bind", other.root, mountpoint], {
          stdio: "ignore",
          timeout: 5_000,
        });
      } catch {
        context.skip("UNAVAILABLE: Linux bind-mount fixture requires mount capability");
        return;
      }
      cleanup.push(() => execFileSync("umount", [mountpoint], { stdio: "ignore", timeout: 5_000 }));
      const root = openNativeRoot(fixture.root);
      cleanup.push(() => closeNativeDescriptor(root));
      expect(() => openNativeTarget(root, "mounted/src/tracked.ts", "file")).toThrow();
    },
  );
});
