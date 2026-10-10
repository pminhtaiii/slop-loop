import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { parseTarStream, sanitizeArchivePath, type ArchiveEntry } from "./archive.js";

type CheckedEntry = ArchiveEntry & { readonly hash?: string };
export interface CheckedImport {
  readonly root: string;
  readonly entries: number;
}
const imports = new WeakSet<object>();
const ownership = new WeakMap<
  object,
  { root: string; identity: fs.Stats; created: readonly string[] }
>();
export function isCheckedImport(value: unknown): value is CheckedImport {
  return typeof value === "object" && value !== null && imports.has(value);
}
export function removeCheckedImport(value: unknown): "CONFIRMED" | "UNCERTAIN" {
  if (!isCheckedImport(value)) return "UNCERTAIN";
  const owned = ownership.get(value);
  if (!owned) return "UNCERTAIN";
  try {
    const current = fs.lstatSync(owned.root);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== owned.identity.dev ||
      current.ino !== owned.identity.ino
    )
      return "UNCERTAIN";
    for (const filename of [...owned.created].reverse()) {
      if (!filename.startsWith(owned.root + path.sep)) return "UNCERTAIN";
      const stat = fs.lstatSync(filename);
      if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmdirSync(filename);
      else fs.unlinkSync(filename);
    }
    fs.rmdirSync(owned.root);
    imports.delete(value);
    ownership.delete(value);
    return "CONFIRMED";
  } catch {
    return "UNCERTAIN";
  }
}

/** Runs inside a fresh trusted recipient, before any dependency code. Host use is fixture-only. */
export async function importCheckedArchive(
  source: Readable,
  manifest: readonly CheckedEntry[],
  privateParent: string,
  signal: AbortSignal,
  envelope?: "node_modules",
): Promise<CheckedImport> {
  signal.throwIfAborted();
  const parent = fs.lstatSync(privateParent);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    path.resolve(privateParent) !== privateParent
  )
    throw new Error("Import parent authority unavailable");
  if (manifest.length > 50_000) throw new Error("Import entry limit exceeded");
  const expected = new Map<string, CheckedEntry>();
  const folded = new Set<string>();
  for (const entry of manifest) {
    sanitizeArchivePath(entry.path);
    if (
      folded.has(entry.path.toLowerCase()) ||
      !["file", "directory", "symlink"].includes(entry.kind)
    )
      throw new Error("Import manifest unsupported");
    if (entry.kind === "file" && !/^[a-f0-9]{64}$/u.test(entry.hash ?? ""))
      throw new Error("Import manifest lacks content identity");
    folded.add(entry.path.toLowerCase());
    expected.set(entry.path, entry);
  }
  const root = fs.mkdtempSync(path.join(privateParent, "checked-"));
  fs.chmodSync(root, 0o700);
  const identity = fs.lstatSync(root);
  const created: string[] = [];
  const seen = new Set<string>();
  const links: CheckedEntry[] = [];
  const checkRoot = (): void => {
    signal.throwIfAborted();
    const current = fs.lstatSync(root);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.ino !== identity.ino ||
      current.dev !== identity.dev
    )
      throw new Error("Import root identity changed");
  };
  const ensureParents = (relative: string): void => {
    checkRoot();
    const parts = relative.split("/");
    for (let i = 1; i < parts.length; i++) {
      const directory = path.join(root, ...parts.slice(0, i));
      if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { mode: 0o700 });
        created.push(directory);
      }
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Import symlink parent rejected");
    }
  };
  const onAbort = (): void => {
    source.destroy(new Error("Import cancelled"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const unwrap = (entry: ArchiveEntry): ArchiveEntry => {
    if (!envelope) return entry;
    if (!entry.path.startsWith(envelope + "/")) throw new Error("Import archive envelope mismatch");
    return { ...entry, path: entry.path.slice(envelope.length + 1) };
  };
  try {
    const parsed = await parseTarStream(
      source,
      { allowRelativeSymlinks: true },
      async (raw, stream) => {
        const entry = unwrap(raw);
        checkRoot();
        const approved = expected.get(entry.path);
        if (
          !approved ||
          seen.has(entry.path) ||
          entry.kind !== approved.kind ||
          entry.size !== approved.size ||
          entry.mode !== approved.mode ||
          entry.target !== approved.target
        )
          throw new Error("Import manifest mismatch");
        seen.add(entry.path);
        if (entry.kind === "symlink") {
          links.push(approved);
          return;
        }
        ensureParents(entry.path);
        const target = path.join(root, ...entry.path.split("/"));
        if (entry.kind === "directory") {
          if (!fs.existsSync(target)) {
            fs.mkdirSync(target, { mode: 0o700 });
            created.push(target);
          }
          if (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink())
            throw new Error("Import directory mismatch");
          return;
        }
        const descriptor = fs.openSync(
          target,
          fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_WRONLY |
            (fs.constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        created.push(target);
        const hash = createHash("sha256");
        let written = 0;
        try {
          for await (const value of stream) {
            checkRoot();
            const bytes: Buffer = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
            written += bytes.length;
            if (written > approved.size) throw new Error("Import content mismatch");
            hash.update(bytes);
            let offset = 0;
            while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset);
          }
          if (written !== approved.size || hash.digest("hex") !== approved.hash)
            throw new Error("Import content mismatch");
          fs.fchmodSync(descriptor, approved.mode ?? 0o644);
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
      },
    );
    if (
      envelope &&
      !parsed.some(
        (entry) => entry.path === envelope && entry.kind === "directory" && entry.mode === 0o755,
      )
    )
      throw new Error("Import archive envelope mismatch");
    for (const raw of parsed) {
      if (envelope && raw.path === envelope) continue;
      const entry = unwrap(raw);
      if (entry.kind === "file") continue;
      const approved = expected.get(entry.path);
      if (
        !approved ||
        approved.kind !== entry.kind ||
        approved.target !== entry.target ||
        approved.mode !== entry.mode
      )
        throw new Error("Import manifest mismatch");
      seen.add(entry.path);
      if (entry.kind === "symlink") links.push(approved);
      else {
        ensureParents(entry.path);
        const directory = path.join(root, ...entry.path.split("/"));
        if (!fs.existsSync(directory)) {
          fs.mkdirSync(directory, { mode: 0o700 });
          created.push(directory);
        }
        if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink())
          throw new Error("Import directory mismatch");
      }
    }
    if (seen.size !== expected.size) throw new Error("Import missing entries");
    // Resolve every prefix through the complete manifest before creating any link.
    for (const entry of links) {
      let resolved = entry.path;
      const visited = new Set<string>();
      for (;;) {
        if (visited.has(resolved)) throw new Error("Import link cycle");
        visited.add(resolved);
        const parts = resolved.split("/");
        let changed = false;
        for (let i = 1; i <= parts.length; i++) {
          const prefix = parts.slice(0, i).join("/");
          const candidate = expected.get(prefix);
          if (candidate?.kind !== "symlink") continue;
          const target = candidate.target ?? "";
          if (
            !target ||
            target.includes("\\") ||
            target.startsWith("/") ||
            /^[A-Za-z]:/u.test(target) ||
            Array.from(target).some((character) => character.charCodeAt(0) < 32)
          )
            throw new Error("Import link escape");
          resolved = path.posix.normalize(
            path.posix.join(path.posix.dirname(prefix), target, ...parts.slice(i)),
          );
          sanitizeArchivePath(resolved);
          changed = true;
          break;
        }
        if (!changed) {
          const target = path.join(root, ...resolved.split("/"));
          if (!fs.existsSync(target)) throw new Error("Import dangling link");
          break;
        }
      }
    }
    for (const entry of links) {
      ensureParents(entry.path);
      const target = path.join(root, ...entry.path.split("/"));
      fs.symlinkSync(entry.target ?? "", target);
      created.push(target);
    }
    checkRoot();
    const receipt = Object.freeze({ root, entries: seen.size });
    imports.add(receipt);
    ownership.set(receipt, { root, identity, created: Object.freeze([...created]) });
    return receipt;
  } catch (error) {
    source.destroy();
    // No recursive deletion: remove only individually created entries inside the held root.
    for (const target of created.reverse()) {
      if (!target.startsWith(root + path.sep))
        throw new Error("Import cleanup identity unavailable");
      const stat = fs.lstatSync(target);
      if (stat.isDirectory()) fs.rmdirSync(target);
      else fs.unlinkSync(target);
    }
    fs.rmdirSync(root);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
