import { createHash } from "node:crypto";
import type { Freshness, VerificationSnapshot } from "./types.js";

export interface SnapshotSource {
  readonly workspaceId: string;
  entries(): Promise<readonly { readonly path: string; readonly bytes: Buffer; readonly mode: number }[]>;
}
export interface SnapshotLimits {
  readonly exclusionPolicyId: string;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxFileBytes: number;
}

function safePath(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !value.includes("\\") &&
    !value.split("/").some((part) => part === "" || part === "." || part === ".." || part.includes("\0"));
}

export async function captureSnapshot(source: SnapshotSource, limits: SnapshotLimits): Promise<VerificationSnapshot> {
  const raw = await source.entries();
  if (raw.length > limits.maxEntries) throw new Error("Snapshot entry limit exceeded");
  let totalBytes = 0;
  const entries = raw.map((entry) => {
    if (!safePath(entry.path)) throw new Error("Unsafe snapshot path");
    if (entry.bytes.byteLength > limits.maxFileBytes) throw new Error("Snapshot file limit exceeded");
    totalBytes += entry.bytes.byteLength;
    if (totalBytes > limits.maxBytes) throw new Error("Snapshot byte limit exceeded");
    const content = Buffer.from(entry.bytes);
    return {
      path: entry.path,
      bytes: content.byteLength,
      mode: entry.mode & 0o777,
      hash: createHash("sha256").update(content).digest("hex"),
      content,
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length)
    throw new Error("Snapshot path collision");
  const identity = JSON.stringify(entries.map(({ path, bytes, mode, hash }) => ({ path, bytes, mode, hash })));
  return Object.freeze({
    formatVersion: 1,
    workspaceId: source.workspaceId,
    exclusionPolicyId: limits.exclusionPolicyId,
    entries: Object.freeze(entries),
    totalBytes,
    snapshotId: createHash("sha256").update(`snapshot-v1:${source.workspaceId}:${limits.exclusionPolicyId}:${identity}`).digest("hex"),
  });
}

export async function captureSnapshotWithRetries(
  source: SnapshotSource,
  limits: SnapshotLimits,
  attempts = 3,
): Promise<VerificationSnapshot> {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3)
    throw new RangeError("Snapshot attempts must be between 1 and 3");
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await captureSnapshot(source, limits);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Snapshot capture failed");
}

export async function compareCurrent(
  snapshot: VerificationSnapshot,
  source: SnapshotSource,
  limits: SnapshotLimits,
): Promise<Freshness> {
  try {
    const current = await captureSnapshot(source, limits);
    return current.snapshotId === snapshot.snapshotId ? "CURRENT" : "STALE";
  } catch {
    return "UNCONFIRMED";
  }
}
