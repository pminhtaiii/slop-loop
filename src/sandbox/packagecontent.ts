import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { z } from "zod";
import { parseTarStream, sanitizeArchivePath, type TarReadableSource } from "./archive.js";
import { validateLockedArtifact, verifyArtifactBytes, type LockedArtifact } from "./downloads.js";

export interface PackageFile {
  readonly path: string;
  readonly bytes: number;
  readonly mode: number;
  readonly hash: string;
}

export interface VerifiedPackage {
  readonly identity: string;
  readonly integrity: string;
  readonly files: readonly PackageFile[];
  readonly bins: Readonly<Record<string, string>>;
  readonly scripts: Readonly<Record<string, string>>;
}

const issued = new WeakSet<VerifiedPackage>();

/** Inspect actual SRI-verified bytes without extracting untrusted paths on the host. */
export async function verifyPackageTarball(
  input: LockedArtifact,
  downloaded: Buffer,
): Promise<VerifiedPackage> {
  const artifact = validateLockedArtifact(input);
  if (downloaded.length > 128 * 1024 * 1024) throw new Error("Artifact byte limit exceeded");
  const bytes = Buffer.from(downloaded);
  verifyArtifactBytes(artifact, bytes);
  const files: PackageFile[] = [];
  let manifest: Buffer | undefined;
  const compressed = Readable.from([bytes]);
  const expanded = createGunzip();
  compressed.pipe(expanded);
  await parseTarStream(expanded, { maxBytes: 128 * 1024 * 1024 }, async (entry, stream, mode) => {
    if (!entry.path.startsWith("package/")) throw new Error("Unsupported package archive root");
    const path = sanitizeArchivePath(entry.path.slice("package/".length));
    if (mode !== 0o644 && mode !== 0o755) throw new Error("Unsupported package file mode");
    if (path === "package.json" && entry.size > 1024 * 1024)
      throw new Error("Package manifest exceeds limit");
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let actual = 0;
    for await (const chunk of stream) {
      const value: unknown = chunk;
      if (!(value instanceof Uint8Array)) throw new Error("Package payload is not binary");
      const part = Buffer.from(value);
      actual += part.length;
      if (actual > entry.size) throw new Error("Package payload size mismatch");
      hash.update(part);
      if (path === "package.json") chunks.push(part);
    }
    if (actual !== entry.size) throw new Error("Package payload size mismatch");
    if (path === "package.json") manifest = Buffer.concat(chunks);
    files.push(Object.freeze({ path, bytes: actual, mode, hash: hash.digest("hex") }));
  });
  if (!manifest) throw new Error("Package manifest is required");
  const metadata: unknown = JSON.parse(manifest.toString("utf8"));
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("name" in metadata) ||
    metadata.name !== artifact.name ||
    !("version" in metadata) ||
    metadata.version !== artifact.version
  )
    throw new Error("Package identity mismatch");
  const execution = z
    .object({
      bin: z
        .union([z.string().max(2048), z.record(z.string().max(214), z.string().max(2048))])
        .optional(),
      scripts: z.record(z.string().max(214), z.string().max(8192)).optional(),
      directories: z.object({ bin: z.unknown().optional() }).passthrough().optional(),
    })
    .parse(metadata);
  if (execution.directories?.bin !== undefined)
    throw new Error("Unsupported directory bin manifest");
  const bins: Record<string, string> = {};
  const declared =
    typeof execution.bin === "string"
      ? { [artifact.name.split("/").at(-1)!]: execution.bin }
      : (execution.bin ?? {});
  if (Object.keys(declared).length > 128) throw new Error("Package bin limit exceeded");
  for (const [name, target] of Object.entries(declared)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error("Unsafe package bin name");
    const normalized = sanitizeArchivePath(target.startsWith("./") ? target.slice(2) : target);
    if (!files.some((file) => file.path === normalized))
      throw new Error("Missing package bin file");
    bins[name] = normalized;
  }
  const scripts: Record<string, string> = {};
  for (const name of ["preinstall", "install", "postinstall"]) {
    const command = execution.scripts?.[name];
    if (command !== undefined) scripts[name] = command;
  }
  if (!scripts.install && !scripts.preinstall && files.some((file) => file.path === "binding.gyp"))
    scripts.install = "node-gyp rebuild";
  const result = Object.freeze({
    identity: `${artifact.name}@${artifact.version}`,
    integrity: artifact.integrity,
    files: Object.freeze(files.sort((a, b) => a.path.localeCompare(b.path, "en"))),
    bins: Object.freeze(bins),
    scripts: Object.freeze(scripts),
  });
  issued.add(result);
  return result;
}

/** Package-file comparison only; it does not authorize execution of an entire virtual store. */
export function validateNormalizedPackage(
  verified: VerifiedPackage,
  observed: readonly PackageFile[],
): void {
  if (!issued.has(verified)) throw new Error("Untrusted package content manifest");
  const actual = new Map<string, PackageFile>();
  for (const file of observed) {
    const path = sanitizeArchivePath(file.path);
    if (actual.has(path.toLowerCase())) throw new Error("Normalized package content mismatch");
    actual.set(path.toLowerCase(), file);
  }
  if (actual.size !== verified.files.length) throw new Error("Normalized package content mismatch");
  for (const file of verified.files) {
    const candidate = actual.get(file.path.toLowerCase());
    if (
      !candidate ||
      candidate.path !== file.path ||
      candidate.hash !== file.hash ||
      candidate.bytes !== file.bytes ||
      candidate.mode !== file.mode
    )
      throw new Error("Normalized package content mismatch");
  }
}

/** Hash every actual exported file; callers cannot substitute precomputed observation hashes. */
export async function verifyNormalizedPackageTar(
  verified: VerifiedPackage,
  source: TarReadableSource,
): Promise<void> {
  if (!issued.has(verified)) throw new Error("Untrusted package content manifest");
  const observed: PackageFile[] = [];
  const entries = await parseTarStream(
    source,
    { maxBytes: 128 * 1024 * 1024 },
    async (entry, stream, mode) => {
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of stream) {
        const value: unknown = chunk;
        if (!(value instanceof Uint8Array)) throw new Error("Package payload is not binary");
        const part = Buffer.from(value);
        bytes += part.length;
        if (bytes > entry.size) throw new Error("Package payload size mismatch");
        hash.update(part);
      }
      if (bytes !== entry.size) throw new Error("Package payload size mismatch");
      observed.push(Object.freeze({ path: entry.path, mode, bytes, hash: hash.digest("hex") }));
    },
  );
  const directories = new Set<string>();
  for (const file of verified.files) {
    const segments = file.path.split("/");
    for (let end = 1; end < segments.length; end++)
      directories.add(segments.slice(0, end).join("/"));
  }
  if (
    entries.some(
      (entry) =>
        entry.kind === "directory" && (!directories.has(entry.path) || entry.mode !== 0o755),
    )
  )
    throw new Error("Normalized package directory mismatch");
  validateNormalizedPackage(verified, observed);
}
