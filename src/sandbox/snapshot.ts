import type { SelectedWorkspace } from "../workspace/types.js";
import { workspaceSnapshotSource } from "./workspacesnapshot.js";
import { createHash } from "node:crypto";
import type { Freshness, VerificationSnapshot } from "./types.js";

export interface SnapshotSource {
  readonly workspaceId: string;
  entries(): Promise<
    readonly {
      readonly path: string;
      readonly bytes: Buffer;
      readonly mode: number;
      readonly canonicalPath?: string;
      readonly kind?: "file" | "symlink" | "fifo" | "socket";
      readonly linkTarget?: string;
    }[]
  >;
}
export interface SnapshotLimits {
  readonly exclusionPolicyId: string;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxFileBytes: number;
}

function safePath(value: string): boolean {
  if (value.length === 0 || /^[a-z]:/iu.test(value)) return false;
  return !value
    .split("/")
    .some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        part === ".git" ||
        part === "node_modules" ||
        part.includes("\0") ||
        part.includes("\\") ||
        /^\.env(?:\.|$)/u.test(part),
    );
}

function isGeneratedOutput(value: string): boolean {
  return (
    /^(?:dist|coverage)(?:\/|$)/iu.test(value) ||
    (/^native\//iu.test(value) && /(?:^|\/)build(?:\/|$)/iu.test(value.slice(7)))
  );
}

async function captureOnce(
  source: SnapshotSource | SelectedWorkspace,
  limits: SnapshotLimits,
): Promise<VerificationSnapshot> {
  const adapter = "entries" in source ? source : workspaceSnapshotSource(source, limits);
  const raw = await adapter.entries();
  const included = raw.filter((entry) => {
    if (!safePath(entry.path)) throw new Error("Unsafe snapshot path");
    return !isGeneratedOutput(entry.path);
  });
  if (included.length > limits.maxEntries) throw new Error("Snapshot entry limit exceeded");
  let totalBytes = 0;
  const entries = included
    .map((entry) => {
      if (entry.kind !== undefined && entry.kind !== "file")
        throw new Error("Unsupported snapshot entry type");
      if (entry.linkTarget !== undefined) throw new Error("Symlink snapshot entries are forbidden");
      if (entry.bytes.byteLength > limits.maxFileBytes)
        throw new Error("Snapshot file limit exceeded");
      totalBytes += entry.bytes.byteLength;
      if (totalBytes > limits.maxBytes) throw new Error("Snapshot byte limit exceeded");
      const content = Buffer.from(entry.bytes);
      const immutable = Buffer.from(content);
      return Object.freeze({
        path: entry.path,
        bytes: content.byteLength,
        mode: entry.mode & 0o777,
        canonicalPath: entry.canonicalPath ?? entry.path,
        hash: createHash("sha256").update(content).digest("hex"),
        get content() {
          return Buffer.from(immutable);
        },
      });
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(entries.map((entry) => entry.path.toLowerCase())).size !== entries.length)
    throw new Error("Snapshot path collision");
  const identity = JSON.stringify(
    entries.map(({ path, bytes, mode, hash, canonicalPath }) => ({
      path,
      bytes,
      mode,
      hash,
      canonicalPath,
    })),
  );
  return Object.freeze({
    formatVersion: 1,
    workspaceId: source.workspaceId,
    exclusionPolicyId: limits.exclusionPolicyId,
    entries: Object.freeze(entries),
    totalBytes,
    snapshotId: createHash("sha256")
      .update(`snapshot-v1:${source.workspaceId}:${limits.exclusionPolicyId}:${identity}`)
      .digest("hex"),
  });
}

export async function captureSnapshot(
  source: SnapshotSource | SelectedWorkspace,
  limits: SnapshotLimits,
  signal?: AbortSignal,
): Promise<VerificationSnapshot> {
  signal?.throwIfAborted();
  source = "entries" in source ? source : workspaceSnapshotSource(source, limits, signal);
  const captured = await captureOnce(source, limits);
  signal?.throwIfAborted();
  const rescan = await captureOnce(source, limits);
  signal?.throwIfAborted();
  if (captured.snapshotId !== rescan.snapshotId) throw new Error("Snapshot capture race detected");
  return captured;
}

export async function captureSnapshotWithRetries(
  source: SnapshotSource | SelectedWorkspace,
  limits: SnapshotLimits,
  attempts = 3,
  signal?: AbortSignal,
): Promise<VerificationSnapshot> {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3)
    throw new RangeError("Snapshot attempts must be between 1 and 3");
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await captureSnapshot(source, limits, signal);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Snapshot capture race detected")
        throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Snapshot capture failed");
}

export async function compareCurrent(
  snapshot: VerificationSnapshot,
  source: SnapshotSource | SelectedWorkspace,
  limits: SnapshotLimits,
  signal?: AbortSignal,
): Promise<Freshness> {
  try {
    const current = await captureSnapshot(source, limits, signal);
    return current.snapshotId === snapshot.snapshotId ? "CURRENT" : "STALE";
  } catch {
    return "UNCONFIRMED";
  }
}
