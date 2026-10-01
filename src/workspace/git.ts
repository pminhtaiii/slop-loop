import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

let executable: string | undefined;

function gitExecutable(): string {
  if (executable !== undefined) return executable;
  const filename = process.platform === "win32" ? "git.exe" : "git";
  const searchPath = process.env.Path ?? process.env.PATH ?? "";
  for (const directory of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, filename);
    try {
      const resolved = fs.realpathSync(candidate);
      if (!fs.statSync(resolved).isFile()) continue;
      fs.accessSync(resolved, fs.constants.X_OK);
      executable = resolved;
      return resolved;
    } catch {
      // Continue to the next trusted absolute PATH entry.
    }
  }
  throw new Error("Git executable unavailable");
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const permitted = new Set([
    "PATH",
    "SYSTEMROOT",
    "WINDIR",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "TMP",
    "TEMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ]);
  for (const [name, value] of Object.entries(process.env)) {
    if (permitted.has(name.toUpperCase()) && value !== undefined) environment[name] = value;
  }
  return environment;
}

/** Executes only runtime-owned Git argv against an absolute executable. */
export function runTrustedGit(
  cwd: string,
  args: readonly string[],
  maxBuffer = 1024 * 1024,
): Buffer {
  return execFileSync(gitExecutable(), ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    env: sanitizedEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer,
    timeout: 10_000,
    windowsHide: true,
  });
}
