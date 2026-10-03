import fs from "node:fs";
import path from "node:path";

import type { TaskCapabilityCeiling, TrustedPathFacts } from "../policy/engine.js";
import type { ValidatedToolCall } from "../tools/registry.js";
import { nativeRootForWorkspace, workspaceForId } from "./admission.js";
import {
  isIgnoredWorkspacePath,
  isNestedWorkspacePath,
  listWorkspaceMembers,
  workspaceMemberEvidence,
} from "./membership.js";
import {
  closeNativeDescriptor,
  listNativeDirectory,
  nativeTargetIdentity,
  nativeTargetPath,
  openNativeChild,
  openNativeTarget,
  readNativeTarget,
} from "./native.js";
import { isDeniedRepositoryPath, parseRepositoryPath } from "./path-policy.js";
import type {
  OpenedDirectoryTarget,
  OpenedRegularTarget,
  MutationPathInspection,
  SelectedWorkspace,
  WorkspaceAccessResult,
} from "./types.js";

function canonicalRelativePath(root: string, openedPath: string): string | null {
  const nativePath =
    process.platform === "win32" && openedPath.startsWith("\\\\?\\")
      ? openedPath.slice(4)
      : openedPath;
  const relative = path.relative(root, nativePath);
  if (relative === "") return ".";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return null;
  return relative.split(path.sep).join("/");
}

function requestedPathFor(
  call: ValidatedToolCall,
): { path: string; kind: "file" | "directory" } | null {
  switch (call.name) {
    case "read_file":
      return { path: call.arguments.path, kind: "file" };
    case "list_files":
      return { path: call.arguments.path ?? ".", kind: "directory" };
    case "search_code":
      return { path: call.arguments.scope ?? ".", kind: "directory" };
    default:
      return null;
  }
}

type InspectedTarget = { fd: number; canonicalPath: string; identity: string };
type MemberSnapshot = {
  names: ReadonlySet<string>;
  directories: ReadonlySet<string>;
};

function memberSnapshot(members: readonly string[]): MemberSnapshot {
  const names = new Set(members);
  const directories = new Set<string>();
  for (const name of names) {
    let separator = name.indexOf("/");
    while (separator !== -1) {
      directories.add(name.slice(0, separator));
      separator = name.indexOf("/", separator + 1);
    }
  }
  return { names, directories };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function mutationSnapshot(
  root: string,
  normalized: string,
  operation: "update" | "create",
): readonly string[] | null {
  const components = normalized.split("/");
  const identities: string[] = [];
  for (let index = 0; index < components.length; index += 1) {
    const current = path.join(root, ...components.slice(0, index + 1));
    const final = index + 1 === components.length;
    try {
      const stat = fs.lstatSync(current, { bigint: true });
      if (
        stat.isSymbolicLink() ||
        (final && operation === "create") ||
        (final && (!stat.isFile() || stat.nlink !== 1n)) ||
        (!final && !stat.isDirectory())
      )
        return null;
      identities.push(`${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}`);
    } catch (error) {
      if (isMissing(error)) return final && operation === "create" ? identities : null;
      throw error;
    }
  }
  return identities;
}

function eligibleAlias(
  workspace: SelectedWorkspace,
  normalized: string,
  kind: "file" | "directory",
  members: MemberSnapshot,
): boolean {
  let aliasEligible =
    kind === "file"
      ? members.names.has(normalized)
      : normalized === "." || members.names.has(normalized) || members.directories.has(normalized);
  if (!aliasEligible) {
    const components = normalized.split("/");
    for (let count = 1; count < components.length; count += 1) {
      const prefix = components.slice(0, count).join("/");
      if (!members.names.has(prefix)) continue;
      try {
        if (fs.lstatSync(path.join(workspace.root, prefix)).isSymbolicLink()) {
          aliasEligible = true;
          break;
        }
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          continue;
        throw error;
      }
    }
  }
  return aliasEligible;
}

function validateOpened(
  workspace: SelectedWorkspace,
  fd: number,
  normalized: string,
  kind: "file" | "directory",
  members: MemberSnapshot,
): InspectedTarget | null {
  const opened = nativeTargetIdentity(fd);
  const canonicalPath = canonicalRelativePath(workspace.root, nativeTargetPath(fd));
  if (
    canonicalPath === null ||
    isDeniedRepositoryPath(canonicalPath) ||
    opened.directory !== (kind === "directory") ||
    (kind === "file" && opened.links !== 1) ||
    !eligibleAlias(workspace, normalized, kind, members)
  )
    return null;
  const member =
    kind === "file"
      ? members.names.has(canonicalPath)
      : canonicalPath === "." || members.directories.has(canonicalPath);
  if (!member) return null;
  const atPath = fs.statSync(path.join(workspace.root, canonicalPath), { bigint: true });
  if (opened.device !== atPath.dev.toString() || opened.inode !== atPath.ino.toString())
    return null;
  const atAlias = fs.statSync(path.join(workspace.root, normalized), { bigint: true });
  if (opened.device !== atAlias.dev.toString() || opened.inode !== atAlias.ino.toString())
    return null;
  return { fd, canonicalPath, identity: `${opened.device}:${opened.inode}` };
}

function inspect(
  workspace: SelectedWorkspace,
  requested: string,
  kind: "file" | "directory",
): InspectedTarget | null {
  const normalized = parseRepositoryPath(requested);
  if (normalized === null || isDeniedRepositoryPath(normalized)) return null;
  const rootFd = nativeRootForWorkspace(workspace);
  if (rootFd === null) throw new Error("Workspace identity unavailable");
  let fd: number;
  try {
    fd = openNativeTarget(rootFd, normalized, kind);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "WORKSPACE_OPEN_DENIED"
    )
      return null;
    throw error;
  }
  let retained = false;
  try {
    // Resolve the opened handle before the post-open workspace verification.
    nativeTargetPath(fd);
    const current = workspaceMemberEvidence(workspace, rootFd);
    if (current.rootFd !== rootFd) throw new Error("Workspace identity unavailable");
    const result = validateOpened(workspace, fd, normalized, kind, memberSnapshot(current.members));
    if (result === null) return null;
    retained = true;
    return result;
  } finally {
    if (!retained) closeNativeDescriptor(fd);
  }
}

function inspectAndClose(
  workspace: SelectedWorkspace,
  requested: string,
  kind: "file" | "directory",
): string | null {
  const target = inspect(workspace, requested, kind);
  if (target === null) return null;
  try {
    return target.canonicalPath;
  } finally {
    closeNativeDescriptor(target.fd);
  }
}

export class WorkspaceBoundary {
  inspectMutationPath(
    workspaceId: string,
    requestedPath: string,
    operation: "update" | "create",
  ): MutationPathInspection {
    const workspace = workspaceForId(workspaceId);
    if (workspace === null) return { kind: "UNAVAILABLE", reason: "IDENTITY_CHANGED" };
    const normalized = parseRepositoryPath(requestedPath);
    if (
      (operation !== "update" && operation !== "create") ||
      normalized === null ||
      normalized === "." ||
      isDeniedRepositoryPath(normalized)
    )
      return { kind: "FORBIDDEN", reason: "PATH_DENIED" };
    let parentFd: number | undefined;
    let targetFd: number | undefined;
    try {
      const rootFd = nativeRootForWorkspace(workspace);
      if (rootFd === null) return { kind: "UNAVAILABLE", reason: "IDENTITY_CHANGED" };
      const parentPath = normalized.split("/").slice(0, -1).join("/") || ".";
      parentFd = openNativeTarget(rootFd, parentPath, "directory");
      const parent = nativeTargetIdentity(parentFd);
      if (canonicalRelativePath(workspace.root, nativeTargetPath(parentFd)) !== parentPath)
        return { kind: "FORBIDDEN", reason: "TARGET_DENIED" };
      let targetIdentity: string | null = null;
      if (operation === "update") {
        targetFd = openNativeTarget(rootFd, normalized, "file");
        const target = nativeTargetIdentity(targetFd);
        if (canonicalRelativePath(workspace.root, nativeTargetPath(targetFd)) !== normalized)
          return { kind: "FORBIDDEN", reason: "TARGET_DENIED" };
        targetIdentity = `${target.device}:${target.inode}`;
      }
      const before = mutationSnapshot(workspace.root, normalized, operation);
      if (
        before === null ||
        isNestedWorkspacePath(workspace, normalized) ||
        isIgnoredWorkspacePath(workspace, normalized)
      )
        return { kind: "FORBIDDEN", reason: "TARGET_DENIED" };
      if (operation === "update" && !listWorkspaceMembers(workspace).includes(normalized))
        return { kind: "FORBIDDEN", reason: "TARGET_DENIED" };
      const after = mutationSnapshot(workspace.root, normalized, operation);
      if (nativeRootForWorkspace(workspace) !== rootFd)
        return { kind: "UNAVAILABLE", reason: "IDENTITY_CHANGED" };
      if (
        after === null ||
        before.length !== after.length ||
        before.some((identity, index) => identity !== after[index]) ||
        (operation === "update" && !listWorkspaceMembers(workspace).includes(normalized)) ||
        isIgnoredWorkspacePath(workspace, normalized) ||
        isNestedWorkspacePath(workspace, normalized)
      )
        return { kind: "FORBIDDEN", reason: "TARGET_DENIED" };
      const parentAtPath = fs.statSync(path.join(workspace.root, parentPath), { bigint: true });
      if (
        parent.device !== parentAtPath.dev.toString() ||
        parent.inode !== parentAtPath.ino.toString()
      )
        return { kind: "FORBIDDEN", reason: "TARGET_DENIED" };
      if (targetFd !== undefined) {
        const targetAtPath = fs.statSync(path.join(workspace.root, normalized), { bigint: true });
        if (targetIdentity !== `${targetAtPath.dev}:${targetAtPath.ino}`)
          return { kind: "FORBIDDEN", reason: "TARGET_DENIED" };
      }
      return {
        kind: "INSPECTED",
        canonicalPath: normalized,
        operation,
        parentIdentity: `${parent.device}:${parent.inode}`,
        targetIdentity,
      };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "WORKSPACE_OPEN_DENIED"
      )
        return { kind: "FORBIDDEN", reason: "TARGET_DENIED" };
      return { kind: "UNAVAILABLE", reason: "INSPECTION_FAILED" };
    } finally {
      if (targetFd !== undefined) closeNativeDescriptor(targetFd);
      if (parentFd !== undefined) closeNativeDescriptor(parentFd);
    }
  }

  factsFor(call: ValidatedToolCall, ceiling: TaskCapabilityCeiling): readonly TrustedPathFacts[] {
    const workspace = workspaceForId(ceiling.workspaceId);
    if (workspace === null) throw new Error("Workspace identity unavailable");
    const requested = requestedPathFor(call);
    if (requested === null) {
      if (call.name === "apply_patch") throw new Error("Mutation path extraction unavailable");
      return Object.freeze([]);
    }
    const canonicalPath = inspectAndClose(workspace, requested.path, requested.kind);
    return Object.freeze([
      Object.freeze({
        workspaceId: ceiling.workspaceId,
        requestedPath: requested.path,
        operation: "read" as const,
        canonicalPath: canonicalPath ?? ".",
        status: canonicalPath === null ? ("FORBIDDEN" as const) : ("ALLOWED" as const),
      }),
    ]);
  }

  openRegularRead(
    workspaceId: string,
    requestedPath: string,
  ): WorkspaceAccessResult<OpenedRegularTarget> {
    const workspace = workspaceForId(workspaceId);
    if (workspace === null) return { kind: "UNAVAILABLE", reason: "IDENTITY_CHANGED" };
    let opened: InspectedTarget | null;
    try {
      opened = inspect(workspace, requestedPath, "file");
    } catch {
      return { kind: "UNAVAILABLE", reason: "INSPECTION_FAILED" };
    }
    if (opened === null) return { kind: "FORBIDDEN", reason: "TARGET_DENIED" };
    let closed = false;
    return {
      kind: "OPENED",
      target: {
        kind: "regular",
        workspaceId,
        requestedPath,
        canonicalPath: opened.canonicalPath,
        identity: opened.identity,
        read(maxBytes: number): Buffer {
          if (
            closed ||
            !Number.isSafeInteger(maxBytes) ||
            maxBytes < 0 ||
            maxBytes > 4 * 1024 * 1024
          ) {
            throw new Error("Invalid native read");
          }
          const stillEligible = (): boolean => {
            let current: InspectedTarget | null;
            try {
              current = inspect(workspace, requestedPath, "file");
            } catch {
              return false;
            }
            if (current === null) return false;
            try {
              return (
                current.identity === opened.identity &&
                current.canonicalPath === opened.canonicalPath
              );
            } finally {
              closeNativeDescriptor(current.fd);
            }
          };
          if (!stillEligible()) throw new Error("Workspace target changed");
          const content = readNativeTarget(opened.fd, maxBytes);
          if (!stillEligible()) throw new Error("Workspace target changed");
          return content;
        },
        close(): void {
          if (!closed) {
            closed = true;
            closeNativeDescriptor(opened.fd);
          }
        },
      },
    };
  }

  openDirectory(
    workspaceId: string,
    requestedPath: string,
  ): WorkspaceAccessResult<OpenedDirectoryTarget> {
    const workspace = workspaceForId(workspaceId);
    if (workspace === null) return { kind: "UNAVAILABLE", reason: "IDENTITY_CHANGED" };
    let opened: InspectedTarget | null;
    try {
      opened = inspect(workspace, requestedPath, "directory");
    } catch {
      return { kind: "UNAVAILABLE", reason: "INSPECTION_FAILED" };
    }
    if (opened === null) return { kind: "FORBIDDEN", reason: "TARGET_DENIED" };
    let names: readonly string[];
    try {
      names = listNativeDirectory(opened.fd, 1024);
      if (names.length >= 1024) throw new Error("Directory enumeration limit reached");
    } catch {
      closeNativeDescriptor(opened.fd);
      return { kind: "UNAVAILABLE", reason: "INSPECTION_FAILED" };
    }
    let closed = false;
    const parentIsCurrent = (): boolean => {
      try {
        if (
          canonicalRelativePath(workspace.root, nativeTargetPath(opened.fd)) !==
          opened.canonicalPath
        )
          return false;
        for (const relative of [requestedPath, opened.canonicalPath]) {
          const atPath = fs.statSync(path.join(workspace.root, relative), { bigint: true });
          if (`${atPath.dev}:${atPath.ino}` !== opened.identity) return false;
        }
        return true;
      } catch {
        return false;
      }
    };
    const prepareEntries = (): readonly { name: string; canonicalPath: string }[] => {
      if (!parentIsCurrent()) throw new Error("Directory target changed");
      const rootFd = nativeRootForWorkspace(workspace);
      if (rootFd === null) throw new Error("Workspace identity unavailable");
      const before = workspaceMemberEvidence(workspace, rootFd);
      if (before.rootFd !== rootFd || !parentIsCurrent())
        throw new Error("Directory target changed");
      const members = memberSnapshot(before.members);
      const tryOpen = (name: string, kind: "file" | "directory"): number | null => {
        try {
          return openNativeChild(rootFd, opened.fd, name, kind);
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "WORKSPACE_OPEN_DENIED"
          )
            return null;
          throw error;
        }
      };
      const entries: Array<{
        name: string;
        alias: string;
        canonicalPath: string;
        identity: string;
        kind: "file" | "directory";
      }> = [];
      const visited = new Set([opened.identity]);
      for (const name of names) {
        if (name.includes("/") || name.includes("\\") || name === "." || name === "..") continue;
        const alias = requestedPath === "." ? name : `${requestedPath}/${name}`;
        if (parseRepositoryPath(alias) === null || isDeniedRepositoryPath(alias)) continue;
        const fileFd = tryOpen(name, "file");
        const fd = fileFd ?? tryOpen(name, "directory");
        if (fd === null) continue;
        try {
          const child = validateOpened(
            workspace,
            fd,
            alias,
            fileFd === null ? "directory" : "file",
            members,
          );
          if (
            child === null ||
            visited.has(child.identity) ||
            child.canonicalPath === "." ||
            child.canonicalPath === opened.canonicalPath ||
            opened.canonicalPath.startsWith(`${child.canonicalPath}/`)
          )
            continue;
          visited.add(child.identity);
          entries.push({
            name,
            alias,
            canonicalPath: child.canonicalPath,
            identity: child.identity,
            kind: fileFd === null ? "directory" : "file",
          });
        } finally {
          closeNativeDescriptor(fd);
        }
      }
      const after = workspaceMemberEvidence(workspace, rootFd);
      if (
        after.rootFd !== rootFd ||
        before.members.length !== after.members.length ||
        before.members.some((member, index) => member !== after.members[index]) ||
        !parentIsCurrent()
      )
        throw new Error("Directory target changed");
      const finalMembers = memberSnapshot(after.members);
      for (const entry of entries) {
        const fd = tryOpen(entry.name, entry.kind);
        if (fd === null) throw new Error("Directory target changed");
        try {
          const current = validateOpened(workspace, fd, entry.alias, entry.kind, finalMembers);
          if (
            current === null ||
            current.identity !== entry.identity ||
            current.canonicalPath !== entry.canonicalPath
          )
            throw new Error("Directory target changed");
        } finally {
          closeNativeDescriptor(fd);
        }
      }
      if (!parentIsCurrent()) throw new Error("Directory target changed");
      return Object.freeze(
        entries.map(({ name, canonicalPath }) => Object.freeze({ name, canonicalPath })),
      );
    };
    return {
      kind: "OPENED",
      target: {
        kind: "directory",
        workspaceId,
        requestedPath,
        canonicalPath: opened.canonicalPath,
        identity: opened.identity,
        entries(): readonly { name: string; canonicalPath: string }[] {
          if (closed) throw new Error("Directory target is closed");
          if (!parentIsCurrent()) throw new Error("Directory target changed");
          return prepareEntries();
        },
        close(): void {
          if (!closed) {
            closed = true;
            closeNativeDescriptor(opened.fd);
          }
        },
      },
    };
  }
}
