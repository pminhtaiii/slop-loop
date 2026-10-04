export interface ArchiveEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink" | "hardlink" | "fifo" | "socket";
  readonly size: number;
  readonly target?: string;
}

export function sanitizeArchivePath(path: string): string {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    /^[A-Za-z]:/u.test(path) ||
    path.startsWith("/") ||
    path.startsWith("//")
  )
    throw new TypeError("Archive path must be a relative POSIX path");
  const parts = path.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new TypeError("Archive path contains traversal or ambiguous segments");
  }
  return parts.join("/");
}

export function validateArchiveEntries(
  entries: readonly ArchiveEntry[],
  limits: {
    readonly maxFileBytes?: number;
    readonly maxEntries?: number;
    readonly maxBytes?: number;
  } = {},
): readonly ArchiveEntry[] {
  const maxFileBytes = limits.maxFileBytes ?? 128 * 1024 * 1024;
  const maxEntries = limits.maxEntries ?? 50_000;
  const maxBytes = limits.maxBytes ?? 4 * 1024 * 1024 * 1024;
  if (entries.length > maxEntries) throw new Error("Archive entry count exceeds limit");
  const seen = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    const path = sanitizeArchivePath(entry.path);
    if (seen.has(path.toLowerCase())) throw new Error("Archive contains duplicate paths");
    seen.add(path.toLowerCase());
    if (entry.kind !== "file" && entry.kind !== "directory") {
      throw new Error("Archive links and special files are not allowed");
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > maxFileBytes) {
      throw new Error("Archive entry exceeds file limit");
    }
    total += entry.size;
    if (total > maxBytes) throw new Error("Archive expansion exceeds limit");
  }
  return Object.freeze(
    entries.map((entry) => Object.freeze({ ...entry, path: sanitizeArchivePath(entry.path) })),
  );
}
