import fs from "node:fs";
import path from "node:path";

import { verifyWorkspace } from "./admission.js";
import { runTrustedGit } from "./git.js";
import type { SelectedWorkspace } from "./types.js";

function gitOutput(root: string, arguments_: readonly string[]): Buffer {
  return runTrustedGit(root, ["-C", root, ...arguments_], 16 * 1024 * 1024);
}

function nulNames(output: Buffer): string[] {
  if (output.length === 0) return [];
  if (output.at(-1) !== 0) throw new Error("Invalid NUL-delimited Git output");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
    .decode(output.subarray(0, -1))
    .split("\0");
}

function hasNestedRepository(root: string, name: string, blockedPrefixes: Set<string>): boolean {
  const components = name.split("/");
  let directory = root;
  for (const component of components.slice(0, -1)) {
    directory = path.join(directory, component);
    if (blockedPrefixes.has(directory)) return true;
    try {
      const prefix = fs.lstatSync(directory);
      if (prefix.isSymbolicLink() || !prefix.isDirectory()) {
        blockedPrefixes.add(directory);
        return true;
      }
    } catch {
      blockedPrefixes.add(directory);
      return true;
    }
    if (fs.existsSync(path.join(directory, ".git"))) {
      blockedPrefixes.add(directory);
      return true;
    }
    if (
      fs.existsSync(path.join(directory, "HEAD")) &&
      fs.existsSync(path.join(directory, "objects")) &&
      fs.existsSync(path.join(directory, "refs"))
    ) {
      try {
        if (
          runTrustedGit(root, ["-C", directory, "rev-parse", "--is-bare-repository"])
            .toString("utf8")
            .trim() === "true"
        ) {
          blockedPrefixes.add(directory);
          return true;
        }
      } catch {
        blockedPrefixes.add(directory);
        return true;
      }
    }
  }
  return false;
}

export function listWorkspaceMembers(workspace: SelectedWorkspace): readonly string[] {
  if (!verifyWorkspace(workspace)) throw new Error("Workspace identity unavailable");
  const tracked = nulNames(
    gitOutput(workspace.root, ["ls-files", "--cached", "--stage", "-z", "--full-name"]),
  );
  const gitlinks = new Set<string>();
  const names = new Set<string>();
  for (const entry of tracked) {
    const tab = entry.indexOf("\t");
    if (tab < 0) throw new Error("Invalid Git index entry");
    const name = entry.slice(tab + 1);
    if (entry.startsWith("160000 ")) gitlinks.add(name);
    else names.add(name);
  }
  for (const name of nulNames(
    gitOutput(workspace.root, ["ls-files", "--others", "--exclude-standard", "-z", "--full-name"]),
  )) {
    names.add(name);
  }
  const gitlinkNames = [...gitlinks];
  const blockedPrefixes = new Set<string>();
  return Object.freeze(
    [...names]
      .filter(
        (name) =>
          name !== ".git" &&
          !name.split("/").includes(".git") &&
          !gitlinkNames.some((gitlink) => name === gitlink || name.startsWith(`${gitlink}/`)) &&
          !hasNestedRepository(workspace.root, name, blockedPrefixes),
      )
      .sort(),
  );
}

export function isWorkspaceMember(workspace: SelectedWorkspace, requestedPath: string): boolean {
  return listWorkspaceMembers(workspace).includes(requestedPath);
}
