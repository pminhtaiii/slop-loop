import tar from "tar-stream";
import { Transform, type TransformCallback, type Readable } from "node:stream";

/** Raw grammar gate precedes tar-stream: hidden PAX/GNU/sparse records never reach normalization. */
class TarGrammarGate extends Transform {
  private header = Buffer.alloc(0);
  private remaining = 0;
  private headers = 0;
  private zeros = 0;
  private declaredBytes = 0;
  constructor(private readonly limits: ArchiveLimits) {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.remaining > 0) {
          const count = Math.min(this.remaining, chunk.length - offset);
          this.push(chunk.subarray(offset, offset + count));
          this.remaining -= count;
          offset += count;
          continue;
        }
        const count = Math.min(512 - this.header.length, chunk.length - offset);
        this.header = Buffer.concat([this.header, chunk.subarray(offset, offset + count)]);
        offset += count;
        if (this.header.length !== 512) continue;
        const header = this.header;
        this.header = Buffer.alloc(0);
        if (++this.headers * 512 > 16 * 1024 * 1024)
          throw new Error("Archive metadata exceeds limit");
        if (header.every((byte) => byte === 0)) {
          this.zeros++;
        } else {
          if (this.zeros) throw new Error("Archive trailing records are unsupported");
          const type = header[156];
          if (type === 120 || type === 103 || type === 76 || type === 75 || type === 83)
            throw new Error("Archive extensions are unsupported");
          if (
            type !== 0 &&
            type !== 48 &&
            type !== 53 &&
            !(type === 50 && this.limits.allowRelativeSymlinks)
          )
            throw new Error("Archive links and special files are not allowed");
          const encoded = header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
          if (!/^[0-7]+$/u.test(encoded) || header[124]! & 0x80)
            throw new Error("Archive size encoding is unsupported");
          const size = Number.parseInt(encoded, 8);
          if (!Number.isSafeInteger(size) || size > (this.limits.maxFileBytes ?? 128 * 1024 * 1024))
            throw new Error("Archive entry exceeds file limit");
          if (type === 53 && size !== 0)
            throw new Error("Archive directory payload is unsupported");
          if (type === 50 && size !== 0) throw new Error("Archive link payload is unsupported");
          this.declaredBytes += size;
          if (this.declaredBytes > (this.limits.maxBytes ?? 4 * 1024 * 1024 * 1024))
            throw new Error("Archive expansion exceeds limit");
          this.remaining = Math.ceil(size / 512) * 512;
        }
        this.push(header);
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error("Archive grammar failure"));
    }
  }
  override _flush(callback: TransformCallback): void {
    callback(
      this.header.length || this.remaining || this.zeros < 2
        ? new Error("Archive truncated")
        : undefined,
    );
  }
}

export interface ArchiveEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink" | "hardlink" | "fifo" | "socket";
  readonly size: number;
  readonly mode?: number;
  readonly target?: string;
}

export interface ArchiveLimits {
  readonly maxFileBytes?: number;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly allowRelativeSymlinks?: boolean;
}

export interface TarReadableSource {
  pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  destroy?(error?: Error): unknown;
}

/**
 * Sanitizes and validates an archive entry path to ensure it is a safe relative POSIX path.
 * Rejects absolute paths, Windows drive letters, backslashes, and traversal segments (..).
 */
export function sanitizeArchivePath(path: string): string {
  if (
    path.length === 0 ||
    Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
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

/**
 * Validates a collection of in-memory archive entries against bounded resource limits.
 * Enforces maximum entry counts, total uncompressed bytes, individual file size limits,
 * path uniqueness, and prohibits special files or symlinks.
 */
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
  consumeFile?: (entry: ArchiveEntry, stream: Readable, mode: number) => Promise<void>,
): Promise<readonly ArchiveEntry[]> {
  const maxFileBytes = limits.maxFileBytes ?? 128 * 1024 * 1024;
  const maxEntries = limits.maxEntries ?? 50_000;
  const maxBytes = limits.maxBytes ?? 4 * 1024 * 1024 * 1024;

  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  const extract = tar.extract();
  const grammar = new TarGrammarGate(limits);

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown) => {
      if (!settled) {
        settled = true;
        source.destroy?.();
        grammar.destroy();
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

        if (
          kind !== "file" &&
          kind !== "directory" &&
          !(kind === "symlink" && limits.allowRelativeSymlinks)
        ) {
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

        const entry = Object.freeze({
          path,
          kind,
          size,
          ...(consumeFile ? { mode: header.mode ?? 0 } : {}),
          ...(kind === "symlink" ? { target: header.linkname ?? "" } : {}),
        });
        entries.push(entry);

        stream.on("error", fail);
        if (kind === "file" && consumeFile) {
          consumeFile(entry, stream, header.mode ?? 0).then(() => next(), fail);
        } else {
          stream.on("end", () => next());
          stream.resume();
        }
      } catch (err) {
        fail(err);
      }
    });

    extract.on("finish", () => {
      if (!settled) {
        const kinds = new Map(entries.map((entry) => [entry.path.toLowerCase(), entry.kind]));
        for (const entry of entries) {
          const segments = entry.path.toLowerCase().split("/");
          for (let end = 1; end < segments.length; end++) {
            const parent = kinds.get(segments.slice(0, end).join("/"));
            if (parent !== undefined && parent !== "directory") {
              fail(new Error("Archive parent is not a directory"));
              return;
            }
          }
        }
        settled = true;
        resolve(Object.freeze(entries));
      }
    });

    extract.on("error", fail);
    grammar.on("error", fail);
    source.on?.("error", fail);

    source.pipe(grammar).pipe(extract);
  });
}
