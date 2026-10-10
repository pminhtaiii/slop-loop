import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface PreparationDockerCli {
  readonly prefix: readonly string[];
  dispose(): void;
}

/** One invocation owns an empty private CLI configuration; Docker cannot fall back to the developer home. */
export function createPreparationDockerCli(): PreparationDockerCli {
  if (process.platform !== "win32" && process.platform !== "linux")
    throw new Error("Local Docker unavailable");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slop-loop-preparation-cli-"));
  const filename = path.join(root, "config.json");
  const directory = fs.lstatSync(root);
  let disposed = false;
  try {
    fs.chmodSync(root, 0o700);
    if (process.platform === "win32")
      execFileSync(
        "icacls",
        [
          root,
          "/inheritance:r",
          "/grant:r",
          `${os.userInfo().username}:(OI)(CI)F`,
          "*S-1-5-18:(OI)(CI)F",
        ],
        { shell: false, timeout: 5000, stdio: "ignore" },
      );
    fs.writeFileSync(filename, "{}\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (fs.existsSync(filename)) fs.unlinkSync(filename);
    fs.rmdirSync(root);
    throw error;
  }
  const config = fs.lstatSync(filename);
  const same = (left: fs.Stats, right: fs.Stats) =>
    left.dev === right.dev && left.ino === right.ino;
  const endpoint =
    process.platform === "win32"
      ? "npipe:////./pipe/dockerDesktopLinuxEngine"
      : "unix:///var/run/docker.sock";
  return Object.freeze({
    prefix: Object.freeze(["--host", endpoint, "--config", root]),
    dispose: () => {
      if (disposed) return;
      try {
        const currentRoot = fs.lstatSync(root);
        if (
          !currentRoot.isDirectory() ||
          currentRoot.isSymbolicLink() ||
          !same(directory, currentRoot)
        )
          throw new Error("CLI ownership changed");
        const children = fs.readdirSync(root);
        if (children.length !== 1 || children[0] !== "config.json")
          throw new Error("CLI configuration changed");
        const currentConfig = fs.lstatSync(filename);
        if (
          !currentConfig.isFile() ||
          currentConfig.isSymbolicLink() ||
          currentConfig.nlink !== 1 ||
          !same(config, currentConfig) ||
          currentConfig.size !== 3 ||
          fs.readFileSync(filename, "utf8") !== "{}\n"
        )
          throw new Error("CLI configuration changed");
        fs.unlinkSync(filename);
        fs.rmdirSync(root);
        disposed = true;
      } catch {
        throw new Error("Preparation CLI cleanup unconfirmed");
      }
    },
  });
}
