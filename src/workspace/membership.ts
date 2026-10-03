import fs from "node:fs";
import path from "node:path";

import { nativeRootForWorkspace, verifyWorkspace } from "./admission.js";
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

function existsForMembership(name: string, strict: boolean): boolean {
  if (!strict) return fs.existsSync(name);
  try {
    fs.lstatSync(name);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

function hasNestedRepository(
  root: string,
  name: string,
  blockedPrefixes: Set<string>,
  strict = false,
): boolean {
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
    } catch (error) {
      if (strict) throw error;
      blockedPrefixes.add(directory);
      return true;
    }
    if (existsForMembership(path.join(directory, ".git"), strict)) {
      blockedPrefixes.add(directory);
      return true;
    }
    if (
      existsForMembership(path.join(directory, "HEAD"), strict) &&
      existsForMembership(path.join(directory, "objects"), strict) &&
      existsForMembership(path.join(directory, "refs"), strict)
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
      } catch (error) {
        if (strict) throw error;
        blockedPrefixes.add(directory);
        return true;
      }
    }
  }
  return false;
}

export function workspaceMemberEvidence(
  workspace: SelectedWorkspace,
  verifiedRootFd?: number,
): { readonly rootFd: number; readonly members: readonly string[] } {
  const rootFd = verifiedRootFd ?? nativeRootForWorkspace(workspace);
  if (rootFd === null || rootFd === undefined) throw new Error("Workspace identity unavailable");
  const entries = nulNames(
    gitOutput(workspace.root, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--stage",
      "-t",
      "-z",
      "--full-name",
    ]),
  );
  const gitlinks = new Set<string>();
  const names = new Set<string>();
  for (const entry of entries) {
    const untracked = entry.startsWith("? ");
    const staged = untracked
      ? null
      : /^[HSMRC] ([0-7]{6}) [0-9a-f]{40,64} [0-3]\t(.*)$/su.exec(entry);
    if (!untracked && staged === null) throw new Error("Invalid Git index entry");
    const name = untracked ? entry.slice(2) : staged?.[2];
    if (name === undefined || name.length === 0) throw new Error("Invalid Git index entry");
    if (staged?.[1] === "160000") gitlinks.add(name);
    else names.add(name);
  }
  const gitlinkNames = [...gitlinks];
  const blockedPrefixes = new Set<string>();
  const members = Object.freeze(
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
  if (nativeRootForWorkspace(workspace) !== rootFd)
    throw new Error("Workspace identity unavailable");
  return { rootFd, members };
}

export function listWorkspaceMembers(workspace: SelectedWorkspace): readonly string[] {
  return workspaceMemberEvidence(workspace).members;
}

export function isWorkspaceMember(workspace: SelectedWorkspace, requestedPath: string): boolean {
  return listWorkspaceMembers(workspace).includes(requestedPath);
}

/** Reject an ancestor that is another repository before planning a new file. */
export function isNestedWorkspacePath(
  workspace: SelectedWorkspace,
  requestedPath: string,
): boolean {
  if (!verifyWorkspace(workspace)) throw new Error("Workspace identity unavailable");
  return hasNestedRepository(workspace.root, requestedPath, new Set(), true);
}

/** Git applies ignore rules to prospective create paths as well as existing files. */
export function isIgnoredWorkspacePath(
  workspace: SelectedWorkspace,
  requestedPath: string,
): boolean {
  if (!verifyWorkspace(workspace)) throw new Error("Workspace identity unavailable");
  try {
    runTrustedGit(workspace.root, [
      "-C",
      workspace.root,
      "check-ignore",
      "-q",
      "--",
      requestedPath,
    ]);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 1)
      return false;
    throw error;
  }
}
