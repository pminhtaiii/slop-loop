import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GitCheckoutFixture {
  readonly root: string;
  git(...args: string[]): string;
  write(relativePath: string, contents: string): void;
  symlink(relativePath: string, target: string, kind?: "file" | "dir" | "junction"): void;
  writeDeniedPaths(): void;
  cleanup(): void;
}

export function createGitCheckout(): GitCheckoutFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slop-loop-workspace-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: root,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
      ),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (relativePath: string, contents: string): void => {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  };
  const symlink = (
    relativePath: string,
    target: string,
    kind: "file" | "dir" | "junction" = "file",
  ): void => {
    const alias = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.symlinkSync(target, alias, kind);
  };
  git("init", "-q");
  write("src/tracked.ts", "export const tracked = true;\n");
  git("add", "src/tracked.ts");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "initial",
  );
  return {
    root,
    git,
    write,
    symlink,
    writeDeniedPaths(): void {
      write(".env", "fixture-secret\n");
      write(".ssh/id_ed25519", "fixture-key\n");
      write(".aws/credentials", "fixture-credentials\n");
    },
    cleanup(): void {
      const base = path.resolve(os.tmpdir());
      const resolved = path.resolve(root);
      if (
        path.dirname(resolved) !== base ||
        !path.basename(resolved).startsWith("slop-loop-workspace-")
      ) {
        throw new Error("Fixture cleanup escaped the temporary directory");
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}
