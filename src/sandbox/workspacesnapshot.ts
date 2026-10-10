import { WorkspaceBoundary } from "../workspace/boundary.js";
import { listWorkspaceMembers } from "../workspace/membership.js";
import { isDeniedRepositoryPath, parseRepositoryPath } from "../workspace/path-policy.js";
import { verifyWorkspace } from "../workspace/admission.js";
import type { SelectedWorkspace } from "../workspace/types.js";
import { createHash } from "node:crypto";
import type { VerificationSnapshot, Freshness } from "./types.js";
import type { SnapshotLimits, SnapshotSource } from "./snapshot.js";

export function excludedSnapshotPath(value: string): boolean {
  return (
    isDeniedRepositoryPath(value) ||
    value.toLowerCase().split("/").includes("node_modules") ||
    /^(?:dist|coverage)(?:\/|$)/i.test(value) ||
    /^native\/(?:.*\/)?build(?:\/|$)/i.test(value) ||
    /(?:^|\/)(?:\.npmrc|\.pnpmfile\.(?:c?js)|pnpm-workspace\.yaml)$/.test(value) ||
    /\.node$/i.test(value)
  );
}

/** Membership supplies names only. Every copied byte comes from a held Phase 4 safe handle. */
export function workspaceSnapshotSource(
  workspace: SelectedWorkspace,
  limits: SnapshotLimits,
  signal?: AbortSignal,
): SnapshotSource {
  const boundary = new WorkspaceBoundary();
  return {
    workspaceId: workspace.workspaceId,
    async entries() {
      signal?.throwIfAborted();
      if (!verifyWorkspace(workspace)) throw new Error("Workspace identity unavailable");
      const names = listWorkspaceMembers(workspace).filter((name) => !excludedSnapshotPath(name));
      if (names.length > limits.maxEntries) throw new Error("Snapshot entry limit exceeded");
      let total = 0;
      const entries: Awaited<ReturnType<SnapshotSource["entries"]>>[number][] = [];
      for (const name of names) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        signal?.throwIfAborted();
        if (parseRepositoryPath(name) === null) throw new Error("Unsafe snapshot path");
        const opened = boundary.openSnapshotRead(workspace.workspaceId, name);
        if (opened.kind !== "OPENED") throw new Error("Snapshot path authority unavailable");
        try {
          const target = opened.target;
          if (excludedSnapshotPath(target.canonicalPath))
            throw new Error("Snapshot alias targets excluded input");
          const metadata = target.metadata?.();
          if (!metadata) throw new Error("Snapshot metadata unavailable");
          if (metadata.size > limits.maxFileBytes) throw new Error("Snapshot file limit exceeded");
          total += metadata.size;
          if (total > limits.maxBytes) throw new Error("Snapshot byte limit exceeded");
          const bytes = target.read(metadata.size);
          const after = target.metadata?.();
          if (
            bytes.length !== metadata.size ||
            after?.size !== metadata.size ||
            after.mode !== metadata.mode
          )
            throw new Error("Snapshot capture race detected");
          entries.push({
            path: name,
            bytes,
            mode: metadata.mode,
            canonicalPath: target.canonicalPath,
          });
        } finally {
          opened.target.close();
        }
      }
      signal?.throwIfAborted();
      if (!verifyWorkspace(workspace)) throw new Error("Workspace identity unavailable");
      return entries;
    },
  };
}

/** Synchronous runtime freshness observation, outside the pure task reducer. */
export function compareWorkspaceCurrent(
  snapshot: VerificationSnapshot,
  workspace: SelectedWorkspace,
  limits: SnapshotLimits,
  deadlineAt = Number.POSITIVE_INFINITY,
): Freshness {
  const scan = () => {
    if (!verifyWorkspace(workspace)) throw new Error("Workspace identity unavailable");
    const names = listWorkspaceMembers(workspace).filter((name) => !excludedSnapshotPath(name));
    if (names.length > limits.maxEntries) throw new Error("Snapshot entry limit exceeded");
    const boundary = new WorkspaceBoundary();
    let total = 0;
    const entries = names
      .map((name) => {
        if (Date.now() >= deadlineAt) throw new Error("Freshness deadline expired");
        const opened = boundary.openSnapshotRead(workspace.workspaceId, name);
        if (opened.kind !== "OPENED") throw new Error("Snapshot path authority unavailable");
        try {
          if (excludedSnapshotPath(opened.target.canonicalPath))
            throw new Error("Snapshot alias targets excluded input");
          const metadata = opened.target.metadata?.();
          if (!metadata || metadata.size > limits.maxFileBytes)
            throw new Error("Snapshot metadata unavailable");
          total += metadata.size;
          if (total > limits.maxBytes) throw new Error("Snapshot byte limit exceeded");
          const bytes = opened.target.read(metadata.size);
          const after = opened.target.metadata?.();
          if (
            bytes.length !== metadata.size ||
            after?.size !== metadata.size ||
            after.mode !== metadata.mode
          )
            throw new Error("Snapshot capture race detected");
          return {
            path: name,
            bytes: bytes.length,
            mode: metadata.mode & 0o777,
            hash: createHash("sha256").update(bytes).digest("hex"),
            canonicalPath: opened.target.canonicalPath,
          };
        } finally {
          opened.target.close();
        }
      })
      .sort((a, b) => a.path.localeCompare(b.path));
    if (!verifyWorkspace(workspace) || Date.now() >= deadlineAt)
      throw new Error("Workspace authority unavailable");
    return JSON.stringify(entries);
  };
  try {
    const current = scan();
    if (current !== scan()) return "UNCONFIRMED";
    const expected = JSON.stringify(
      snapshot.entries.map(({ path, bytes, mode, hash, canonicalPath }) => ({
        path,
        bytes,
        mode,
        hash,
        canonicalPath: canonicalPath ?? path,
      })),
    );
    return workspace.workspaceId === snapshot.workspaceId &&
      limits.exclusionPolicyId === snapshot.exclusionPolicyId &&
      current === expected
      ? "CURRENT"
      : "STALE";
  } catch {
    return "UNCONFIRMED";
  }
}
