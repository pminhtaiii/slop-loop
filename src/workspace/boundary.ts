import fs from "node:fs";
import path from "node:path";

import type { TaskCapabilityCeiling, TrustedPathFacts } from "../policy/engine.js";
import type { ValidatedToolCall } from "../tools/registry.js";
import { nativeRootForWorkspace, workspaceForId } from "./admission.js";
import { listWorkspaceMembers } from "./membership.js";
import {
  closeNativeDescriptor,
  listNativeDirectory,
  nativeTargetIdentity,
  nativeTargetPath,
  openNativeTarget,
  readNativeTarget,
} from "./native.js";
import { isDeniedRepositoryPath, parseRepositoryPath } from "./path-policy.js";
import type {
  OpenedDirectoryTarget,
  OpenedRegularTarget,
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

function inspect(
  workspace: SelectedWorkspace,
  requested: string,
  kind: "file" | "directory",
): InspectedTarget | null {
  const normalized = parseRepositoryPath(requested);
  if (normalized === null || isDeniedRepositoryPath(normalized)) return null;
  const members = listWorkspaceMembers(workspace);
  let aliasEligible =
    kind === "file"
      ? members.includes(normalized)
      : normalized === "." ||
        members.includes(normalized) ||
        members.some((name) => name.startsWith(`${normalized}/`));
  if (!aliasEligible) {
    const components = normalized.split("/");
    for (let count = 1; count < components.length; count += 1) {
      const prefix = components.slice(0, count).join("/");
      if (!members.includes(prefix)) continue;
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
  if (!aliasEligible) return null;
  const nativeRoot = nativeRootForWorkspace(workspace);
  if (nativeRoot === null) throw new Error("Workspace identity unavailable");
  let fd: number;
  try {
    fd = openNativeTarget(nativeRoot, normalized, kind);
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
    const opened = nativeTargetIdentity(fd);
    const canonicalPath = canonicalRelativePath(workspace.root, nativeTargetPath(fd));
    if (
      canonicalPath === null ||
      isDeniedRepositoryPath(canonicalPath) ||
      opened.directory !== (kind === "directory") ||
      (kind === "file" && opened.links !== 1)
    )
      return null;
    const member =
      kind === "file"
        ? members.includes(canonicalPath)
        : canonicalPath === "." || members.some((name) => name.startsWith(`${canonicalPath}/`));
    if (!member) return null;
    const atPath = fs.statSync(path.join(workspace.root, canonicalPath), { bigint: true });
    if (opened.device !== atPath.dev.toString() || opened.inode !== atPath.ino.toString())
      return null;
    retained = true;
    return { fd, canonicalPath, identity: `${opened.device}:${opened.inode}` };
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
            const currentWorkspace = workspaceForId(workspaceId);
            if (currentWorkspace !== workspace) return false;
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
    let next = 0;
    const visited = new Set([opened.identity]);
    return {
      kind: "OPENED",
      target: {
        kind: "directory",
        workspaceId,
        requestedPath,
        canonicalPath: opened.canonicalPath,
        identity: opened.identity,
        nextEntry(): { name: string; canonicalPath: string } | null {
          if (closed) throw new Error("Directory target is closed");
          while (next < names.length) {
            const name = names[next++];
            if (
              name === undefined ||
              name.includes("/") ||
              name.includes("\\") ||
              name === "." ||
              name === ".."
            )
              continue;
            const alias = requestedPath === "." ? name : `${requestedPath}/${name}`;
            const child =
              inspect(workspace, alias, "file") ?? inspect(workspace, alias, "directory");
            if (child === null) continue;
            try {
              if (
                visited.has(child.identity) ||
                child.canonicalPath === "." ||
                child.canonicalPath === opened.canonicalPath ||
                opened.canonicalPath.startsWith(`${child.canonicalPath}/`)
              )
                continue;
              visited.add(child.identity);
              return { name, canonicalPath: child.canonicalPath };
            } finally {
              closeNativeDescriptor(child.fd);
            }
          }
          return null;
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
