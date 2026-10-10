import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { z } from "zod";
import { parseTarStream, type ArchiveEntry } from "./archive.js";

export interface PreparationProducer {
  readonly actionId: string;
  readonly resourceId: string;
  readonly generation: number;
  readonly engineId: string;
}
export interface ProducerTransferPort {
  quiesce(producer: PreparationProducer, signal: AbortSignal): Promise<void>;
  pause(producer: PreparationProducer, signal: AbortSignal): Promise<void>;
  inspect(producer: PreparationProducer, signal: AbortSignal): Promise<unknown>;
  export(producer: PreparationProducer, signal: AbortSignal): Promise<Readable>;
}
export interface FrozenArchive {
  readonly producer: PreparationProducer;
  readonly contentId: string;
  readonly bytes: number;
  readonly entries: readonly (ArchiveEntry & { readonly hash?: string })[];
  open(): Readable;
  dispose(): void;
}
const issued = new WeakSet<object>();
export function isFrozenArchive(value: unknown): value is FrozenArchive {
  return typeof value === "object" && value !== null && issued.has(value);
}
const inspectionSchema = z.strictObject({
  actionId: z.string().min(1),
  resourceId: z.string().min(1),
  generation: z.number().int().positive(),
  engineId: z.string().min(1),
  paused: z.literal(true),
  quiescent: z.literal(true),
});

function assertInspection(value: unknown, producer: PreparationProducer): void {
  const parsed = inspectionSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.actionId !== producer.actionId ||
    parsed.data.resourceId !== producer.resourceId ||
    parsed.data.generation !== producer.generation ||
    parsed.data.engineId !== producer.engineId
  )
    throw new Error("Frozen producer identity unavailable");
}

function checkLinks(entries: readonly ArchiveEntry[]): void {
  const targets = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let end = 1; end < segments.length; end++) {
      const parent = segments.slice(0, end).join("/");
      if (!targets.has(parent)) targets.set(parent, { path: parent, kind: "directory", size: 0 });
    }
  }
  for (const entry of entries) {
    if (entry.kind !== "symlink") continue;
    let current = entry.path;
    const visited = new Set<string>();
    for (let count = 0; count <= targets.size; count++) {
      if (visited.has(current)) throw new Error("Archive link cycle");
      visited.add(current);
      const segments = current.split("/");
      let candidate: ArchiveEntry | undefined;
      let suffix: string[] = [];
      for (let end = 1; end <= segments.length; end++) {
        const prefix = targets.get(segments.slice(0, end).join("/"));
        if (prefix?.kind === "symlink") {
          candidate = prefix;
          suffix = segments.slice(end);
          break;
        }
      }
      if (!candidate) {
        const terminal = targets.get(current);
        if (!terminal || (terminal.kind !== "file" && terminal.kind !== "directory"))
          throw new Error("Archive link target missing");
        break;
      }
      const target = candidate.target ?? "";
      if (
        !target ||
        target.startsWith("/") ||
        target.includes("\\") ||
        /^[A-Za-z]:/u.test(target) ||
        [...target].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        path.posix.normalize(target) !== target
      )
        throw new Error("Archive link escape");
      current = path.posix.join(path.posix.dirname(candidate.path), target, ...suffix);
      if (current === ".." || current.startsWith("../")) throw new Error("Archive link escape");
    }
  }
}

/** Opaque private relay only: untrusted paths are never extracted on the host. */
export async function freezeAndSeal(
  input: PreparationProducer,
  port: ProducerTransferPort,
  signal: AbortSignal,
  privateRelayRoot: string = os.tmpdir(),
): Promise<FrozenArchive> {
  const producer = Object.freeze({ ...input });
  signal.throwIfAborted();
  await port.quiesce(producer, signal);
  signal.throwIfAborted();
  await port.pause(producer, signal);
  assertInspection(await port.inspect(producer, signal), producer);
  signal.throwIfAborted();
  const source = await port.export(producer, signal);
  if (signal.aborted) {
    source.destroy();
    signal.throwIfAborted();
  }
  let root: string;
  try {
    const parent = fs.lstatSync(privateRelayRoot);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      fs.realpathSync(privateRelayRoot) !== path.resolve(privateRelayRoot)
    )
      throw new Error("Private relay authority unavailable");
    root = fs.mkdtempSync(path.join(privateRelayRoot, "slop-loop-transfer-"));
  } catch (error) {
    source.destroy();
    throw error;
  }
  let fd: number | undefined;
  try {
    fs.chmodSync(root, 0o700);
    if (process.platform === "win32")
      execFileSync(
        "icacls",
        [
          root,
          "/inheritance:r",
          "/grant:r",
          `${os.userInfo().username}:(OI)(CI)F`,
          "*S-1-5-18:(OI)(CI)F",
        ],
        { shell: false, timeout: 5000, stdio: "ignore" },
      );
    const filename = path.join(root, "relay.tar");
    fd = fs.openSync(filename, "wx", 0o600);
    const descriptor = fd;
    const hash = createHash("sha256");
    let bytes = 0;
    const fileHashes = new Map<string, string>();
    const relay = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          signal.throwIfAborted();
          bytes += chunk.length;
          if (bytes > 4 * 1024 ** 3) throw new Error("Preparation transfer limit exceeded");
          let offset = 0;
          while (offset < chunk.length)
            offset += fs.writeSync(descriptor, chunk, offset, chunk.length - offset);
          hash.update(chunk);
          callback(null, chunk);
        } catch (error) {
          callback(error instanceof Error ? error : new Error("Transfer failed"));
        }
      },
    });
    const abort = () => source.destroy(new Error("Preparation transfer cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    source.on("error", (error) => relay.destroy(error));
    let entries: readonly ArchiveEntry[];
    try {
      entries = await parseTarStream(
        source.pipe(relay),
        { allowRelativeSymlinks: true },
        async (entry, stream) => {
          const fileHash = createHash("sha256");
          let actual = 0;
          for await (const part of stream) {
            const value: unknown = part;
            if (!(value instanceof Uint8Array)) throw new Error("Transfer payload is not binary");
            actual += value.byteLength;
            if (actual > entry.size) throw new Error("Transfer payload size mismatch");
            fileHash.update(value);
          }
          if (actual !== entry.size) throw new Error("Transfer payload size mismatch");
          fileHashes.set(entry.path, fileHash.digest("hex"));
        },
      );
    } finally {
      signal.removeEventListener("abort", abort);
      source.destroy();
    }
    checkLinks(entries);
    assertInspection(await port.inspect(producer, signal), producer);
    signal.throwIfAborted();
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    fd = undefined;
    fs.chmodSync(filename, 0o400);
    const stat = fs.lstatSync(filename);
    let disposed = false;
    const receipt = Object.freeze({
      producer,
      bytes,
      contentId: hash.digest("hex"),
      entries: Object.freeze(
        entries.map((entry) =>
          Object.freeze({
            ...entry,
            ...(fileHashes.has(entry.path) ? { hash: fileHashes.get(entry.path)! } : {}),
          }),
        ),
      ),
      open: () => {
        if (disposed) throw new Error("Frozen archive unavailable");
        const current = fs.lstatSync(filename);
        if (
          !current.isFile() ||
          current.isSymbolicLink() ||
          current.ino !== stat.ino ||
          current.dev !== stat.dev ||
          current.size !== bytes ||
          current.nlink !== 1
        )
          throw new Error("Frozen archive changed");
        return fs.createReadStream(filename);
      },
      dispose: () => {
        if (disposed) return;
        fs.unlinkSync(filename);
        fs.rmdirSync(root);
        disposed = true;
        issued.delete(receipt);
      },
    });
    issued.add(receipt);
    return receipt;
  } catch (error) {
    source.destroy();
    if (fd !== undefined) fs.closeSync(fd);
    const filename = path.join(root, "relay.tar");
    if (fs.existsSync(filename)) fs.unlinkSync(filename);
    fs.rmdirSync(root);
    throw error;
  }
}
