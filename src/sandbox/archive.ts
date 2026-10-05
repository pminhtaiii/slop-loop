import tar from "tar-stream";

export interface ArchiveEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink" | "hardlink" | "fifo" | "socket";
  readonly size: number;
  readonly target?: string;
}

export interface ArchiveLimits {
  readonly maxFileBytes?: number;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

export interface TarReadableSource {
  pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  destroy?(error?: Error): unknown;
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
  limits: ArchiveLimits = {},
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

/**
 * Bounded tar stream parser that processes tar archives in memory without host extraction.
 * Rejects illegal paths, special files, links, duplicate paths, and bounded size overruns.
 */
export async function parseTarStream(
  source: TarReadableSource,
  limits: ArchiveLimits = {},
): Promise<readonly ArchiveEntry[]> {
  const maxFileBytes = limits.maxFileBytes ?? 128 * 1024 * 1024;
  const maxEntries = limits.maxEntries ?? 50_000;
  const maxBytes = limits.maxBytes ?? 4 * 1024 * 1024 * 1024;

  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  const extract = tar.extract();

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown) => {
      if (!settled) {
        settled = true;
        source.destroy?.();
        extract.destroy();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    extract.on("entry", (header, stream, next) => {
      try {
        if (entries.length >= maxEntries) {
          throw new Error("Archive entry count exceeds limit");
        }

        const rawPath = header.name;
        const path = sanitizeArchivePath(rawPath);
        if (seen.has(path.toLowerCase())) {
          throw new Error("Archive contains duplicate paths");
        }
        seen.add(path.toLowerCase());

        let kind: ArchiveEntry["kind"];
        if (header.type === "file") kind = "file";
        else if (header.type === "directory") kind = "directory";
        else if (header.type === "symlink") kind = "symlink";
        else if (header.type === "link") kind = "hardlink";
        else if (header.type === "fifo") kind = "fifo";
        else throw new Error("Archive links and special files are not allowed");

        if (kind !== "file" && kind !== "directory") {
          throw new Error("Archive links and special files are not allowed");
        }

        const size = header.size ?? 0;
        if (!Number.isSafeInteger(size) || size < 0 || size > maxFileBytes) {
          throw new Error("Archive entry exceeds file limit");
        }

        totalBytes += size;
        if (totalBytes > maxBytes) {
          throw new Error("Archive expansion exceeds limit");
        }

        entries.push(Object.freeze({ path, kind, size }));

        // Drain stream without writing to disk
        stream.on("end", () => next());
        stream.resume();
      } catch (err) {
        fail(err);
      }
    });

    extract.on("finish", () => {
      if (!settled) {
        settled = true;
        resolve(Object.freeze(entries));
      }
    });

    extract.on("error", fail);
    source.on?.("error", fail);

    source.pipe(extract);
  });
}
