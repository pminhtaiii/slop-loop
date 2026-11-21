/**
 * Real TrustedFilesystemPort over one workspace directory.
 *
 * Paths in and out are canonical workspace-relative paths, so resolution results feed
 * ControlledRepositoryReader's containment check directly: a link that leaves the
 * workspace resolves to an absolute path and is refused there.
 */
import { randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { mkdir, open, lstat, opendir, readdir, readlink, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import type { PortProvenance } from '../contracts/foundation/uc03.ts';
import { computeCanonicalSha256, isCanonicalRelativePath, isProtectedPath } from '../contracts/foundation/uc03.ts';
import { computeFileDigest } from './docker-workspace-policy.ts';
import type { FileStat, QuestionRepositoryOperationControl, TrustedFilesystemEntry, TrustedFilesystemPort } from './repository-types.ts';

export interface WorkspaceFilesystemPortOptions {
  readonly root: string;
  readonly provenance?: PortProvenance;
}

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

function toFileStat(info: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number }): FileStat {
  return { isFile: info.isFile(), isDirectory: info.isDirectory(), isSymbolicLink: info.isSymbolicLink(), size: info.size };
}

export type ProbeRead = (buffer: Buffer, offset: number, length: number, position: number) => Promise<number>;

/** Short reads are legal, so keep reading until the window is full or EOF. */
export async function readProbe(probe: Buffer, read: ProbeRead): Promise<number> {
  let total = 0;
  while (total < probe.length) {
    const bytesRead = await read(probe, total, probe.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total;
}

function checkControl(control: QuestionRepositoryOperationControl): void {
  if (
    !control ||
    typeof control !== 'object' ||
    !control.signal ||
    typeof control.signal.aborted !== 'boolean' ||
    typeof control.deadlineEpochMs !== 'number' ||
    !Number.isFinite(control.deadlineEpochMs) ||
    control.deadlineEpochMs <= 0
  ) {
    throw new Error('INVALID_CONTROL: Filesystem operation control is malformed');
  }
  if (control.signal.aborted) throw new Error('CANCELLED: Filesystem operation was cancelled');
  if (Date.now() >= control.deadlineEpochMs) throw new Error('DEADLINE_EXCEEDED: Filesystem operation deadline elapsed');
}

/** `lstat` that reports absence as `undefined`; the promise API has no `throwIfNoEntry`. */
async function lstatOptional(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
    throw error;
  }
}

function positiveLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

async function readBoundedBytes(handle: Awaited<ReturnType<typeof open>>, maxBytes: number, control?: QuestionRepositoryOperationControl): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) throw new Error('INVALID_LIMITS: maxBytes must be a safe bounded byte count');
  const chunks: Buffer[] = [];
  let total = 0;
  const ceiling = maxBytes + 1;
  while (total < ceiling) {
    if (control) checkControl(control);
    const buffer = Buffer.alloc(Math.min(64 * 1024, ceiling - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, total);
    if (control) checkControl(control);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new Error('FILE_TOO_LARGE: Read exceeded byte limit');
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

export class WorkspaceFilesystemPort implements TrustedFilesystemPort {
  readonly provenance: PortProvenance;
  private readonly root: string;

  constructor(options: WorkspaceFilesystemPortOptions) {
    if (!options || typeof options.root !== 'string' || !options.root.trim()) throw new Error('INVALID_OPTIONS: root must be a non-empty path');
    // Canonicalize once so containment compares realpath results against the real root, not a lexical path.
    this.root = realpathSync(resolve(options.root));
    this.provenance = options.provenance ?? 'real';
    if (this.provenance !== 'real' && this.provenance !== 'mock') throw new Error('INVALID_PROVENANCE: Provenance must be real or mock');
  }

  private absolute(canonicalPath: string): string {
    if (canonicalPath === '' || canonicalPath === '.') return this.root;
    if (!isCanonicalRelativePath(canonicalPath)) throw new Error(`WORKSPACE_ESCAPE: Path '${canonicalPath}' must be a canonical relative path`);
    return join(this.root, ...canonicalPath.split('/'));
  }

  /** Workspace-relative when inside the root; the absolute target otherwise, which containment refuses. */
  private relativeToRoot(absoluteTarget: string): string {
    if (absoluteTarget === this.root) return '';
    const prefix = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
    return absoluteTarget.startsWith(prefix) ? toPosix(absoluteTarget.slice(prefix.length)) : toPosix(absoluteTarget);
  }

  private async checkedAbsolute(canonicalPath: string, control?: QuestionRepositoryOperationControl): Promise<string> {
    const expected = this.absolute(canonicalPath);
    if (control) checkControl(control);
    const resolved = await realpath(expected);
    if (control) checkControl(control);
    if (resolved !== expected) throw new Error('WORKSPACE_ESCAPE: Controlled traversal must stay on canonical workspace paths');
    return resolved;
  }

  async stat(canonicalPath: string, control?: QuestionRepositoryOperationControl): Promise<FileStat> {
    if (control) checkControl(control);
    const result = toFileStat(await stat(this.absolute(canonicalPath)));
    if (control) checkControl(control);
    return result;
  }

  async lstat(canonicalPath: string, control?: QuestionRepositoryOperationControl): Promise<FileStat> {
    if (control) checkControl(control);
    const result = toFileStat(await lstat(this.absolute(canonicalPath)));
    if (control) checkControl(control);
    return result;
  }

  async realpath(canonicalPath: string, control?: QuestionRepositoryOperationControl): Promise<string> {
    if (control) checkControl(control);
    const result = this.relativeToRoot(await realpath(this.absolute(canonicalPath)));
    if (control) checkControl(control);
    return result;
  }

  async readDir(canonicalPath: string, control?: QuestionRepositoryOperationControl): Promise<readonly TrustedFilesystemEntry[]> {
    if (control) {
      checkControl(control);
      throw new Error('BOUNDED_DIRECTORY_REQUIRED: Controlled directory enumeration must use readDirBounded');
    }
    const entries = await readdir(this.absolute(canonicalPath), { withFileTypes: true });
    return entries.map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  }

  async readDirBounded(canonicalPath: string, maxEntries: number, control: QuestionRepositoryOperationControl): Promise<readonly TrustedFilesystemEntry[]> {
    if (!positiveLimit(maxEntries)) throw new Error('INVALID_LIMITS: maxEntries must be a positive safe integer');
    checkControl(control);
    const directory = await opendir(await this.checkedAbsolute(canonicalPath, control));
    const entries: TrustedFilesystemEntry[] = [];
    for await (const entry of directory) {
      checkControl(control);
      if (entries.length >= maxEntries) throw new Error('DIRECTORY_TOO_LARGE: Directory exceeded its bounded entry allowance');
      entries.push({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymbolicLink: entry.isSymbolicLink(),
      });
    }
    checkControl(control);
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return Object.freeze(entries.map(entry => Object.freeze(entry)));
  }

  async readTextFile(canonicalPath: string, maxBytes?: number, control?: QuestionRepositoryOperationControl): Promise<string> {
    if (control) {
      checkControl(control);
      if (maxBytes === undefined) throw new Error('BOUNDED_READ_REQUIRED: A controlled text read needs maxBytes');
    }
    const handle = await open(this.absolute(canonicalPath), 'r');
    try {
      if (control) checkControl(control);
      if (maxBytes === undefined) {
        return await handle.readFile({ encoding: 'utf8' });
      }
      const bytes = await readBoundedBytes(handle, maxBytes, control);
      if (control) checkControl(control);
      return bytes.toString('utf8');
    } finally {
      await handle.close();
    }
  }

  /** Deterministic tree digest: sorted `path\0fileDigest\n` lines, symlinks skipped. */
  async getCurrentRevisionDigest(maxBytes?: number, control?: QuestionRepositoryOperationControl): Promise<string> {
    if (control) {
      checkControl(control);
      throw new Error('BOUNDED_DIGEST_REQUIRED: Controlled digest traversal must use getCurrentRevisionDigestBounded');
    }
    const lines: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await this.readDir(dir);
      for (const entry of entries) {
        const child = dir === '' ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory) await walk(child);
        else if (entry.isFile) lines.push(`${child}\0${computeFileDigest(await this.readBytes(child, maxBytes))}\n`);
      }
    };
    await walk('');
    lines.sort();
    return computeCanonicalSha256(lines.join(''));
  }

  async getCurrentRevisionDigestBounded(
    limits: Readonly<{ maxEntries: number; maxFiles: number; maxBytes: number }>,
    control: QuestionRepositoryOperationControl,
    observeFile?: (path: string, bytes: Buffer, digest: string) => void,
  ): Promise<string> {
    if (!limits || !positiveLimit(limits.maxEntries) || !positiveLimit(limits.maxFiles) || !positiveLimit(limits.maxBytes)) {
      throw new Error('INVALID_LIMITS: bounded digest limits must be positive safe integers');
    }
    let entryCount = 0;
    let fileCount = 0;
    let byteCount = 0;
    const lines: string[] = [];
    const pending = [''];
    while (pending.length > 0) {
      checkControl(control);
      if (entryCount >= limits.maxEntries) throw new Error('SCAN_LIMIT: Revision digest exceeded its entry allowance');
      const dir = pending.shift();
      if (dir === undefined) break;
      const remainingEntries = limits.maxEntries - entryCount;
      const entries = await this.readDirBounded(dir, remainingEntries, control);
      checkControl(control);
      entryCount += entries.length;
      for (const entry of entries) {
        checkControl(control);
        const child = dir.length > 0 ? `${dir}/${entry.name}` : entry.name;
        const pathBytes = Buffer.byteLength(child, 'utf8');
        if (byteCount + pathBytes > limits.maxBytes) throw new Error('SCAN_LIMIT: Revision digest exceeded its byte allowance');
        byteCount += pathBytes;
        if (entry.isSymbolicLink) continue;
        if (entry.isDirectory) {
          pending.push(child);
          continue;
        }
        if (!entry.isFile) continue;
        if (fileCount >= limits.maxFiles) throw new Error('SCAN_LIMIT: Revision digest exceeded its file allowance');
        const digestBytes = Buffer.byteLength('sha256:' + '0'.repeat(64), 'utf8');
        if (byteCount + digestBytes > limits.maxBytes) throw new Error('SCAN_LIMIT: Revision digest exceeded its byte allowance');
        const remainingBytes = limits.maxBytes - byteCount - digestBytes;
        const bytes = await this.readBytes(child, remainingBytes, control);
        checkControl(control);
        byteCount += bytes.byteLength + digestBytes;
        if (byteCount > limits.maxBytes) throw new Error('SCAN_LIMIT: Revision digest exceeded its byte allowance');
        fileCount += 1;
        const digest = computeFileDigest(bytes);
        lines.push(`${child}\0${digest}\n`);
        observeFile?.(child, bytes, digest);
      }
    }
    lines.sort();
    checkControl(control);
    return computeCanonicalSha256(lines.join(''));
  }

  /** Raw bytes for trusted host mirroring; shares the bounded read and controlled containment checks. */
  async readBytes(canonicalPath: string, maxBytes?: number, control?: QuestionRepositoryOperationControl): Promise<Buffer> {
    const path = await this.checkedAbsolute(canonicalPath, control);
    const expected = await lstat(path, { bigint: true });
    if (!expected.isFile()) throw new Error('WORKSPACE_ESCAPE: Byte reads require a regular file');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat({ bigint: true });
      // Linux can resolve the descriptor itself without traversing mutable parents a second time.
      if (process.platform === 'linux' && (await readlink(`/proc/self/fd/${handle.fd}`)) !== path) throw new Error('WORKSPACE_ESCAPE: Byte read descriptor is outside its canonical path');
      const current = await lstat(await this.checkedAbsolute(canonicalPath, control), { bigint: true });
      if (!opened.isFile() || !current.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.dev !== current.dev || opened.ino !== current.ino) {
        throw new Error('WORKSPACE_ESCAPE: Byte read source changed');
      }
      if (control) checkControl(control);
      if (maxBytes === undefined) {
        if (control) throw new Error('UNBOUNDED_READ_DENIED: A controlled byte read needs maxBytes');
        return await handle.readFile();
      }
      const bytes = await readBoundedBytes(handle, maxBytes, control);
      if (control) checkControl(control);
      return bytes;
    } finally {
      await handle.close();
    }
  }

  /**
   * Writes one admitted patch target's bytes under the host tree with no effect outside it.
   *
   * Every existing ancestor is canonicalized and required to resolve to its own lexical path before
   * anything is created, so a link that leaves the workspace is refused with zero effects. Missing
   * parents are then created one level at a time, rechecking containment after each. The final write
   * never follows a final-component link: an exclusive temp file in the same directory is created
   * with `O_NOFOLLOW`, written, fsynced and renamed over the target, so a swapped-in link can never
   * redirect the bytes. This is the real-tier patch receiver's only write; the caller has already
   * admitted the path, measured the base revision and computed every output byte.
   */
  async writeFile(canonicalPath: string, content: string, maxBytes: number): Promise<void> {
    if (!isCanonicalRelativePath(canonicalPath) || isProtectedPath(canonicalPath)) throw new Error(`WORKSPACE_ESCAPE: '${canonicalPath}' is not a writable canonical path`);
    const bytes = Buffer.from(content, 'utf8');
    if (!positiveLimit(maxBytes) || bytes.byteLength > maxBytes) throw new Error('FILE_TOO_LARGE: Patch target exceeds its byte limit');
    const segments = canonicalPath.split('/');
    const target = join(this.root, ...segments);
    const parent = await this.ensureContainedParent(segments.slice(0, -1));
    const existing = await lstatOptional(target);
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error(`WORKSPACE_ESCAPE: Patch target '${canonicalPath}' is not a regular file`);
    const temporary = join(parent, `.${basename(target)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
        if (bytesWritten <= 0) throw new Error('WORKSPACE_ESCAPE: Patch target write made no progress');
        offset += bytesWritten;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // Recheck the parent immediately before the rename: a swapped ancestor must not receive the file.
      if ((await realpath(parent)) !== parent) throw new Error('WORKSPACE_ESCAPE: Patch target parent leaves the canonical workspace');
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  /**
   * Removes one canonical file under the root without following a final link. Used only to roll back
   * a file a failed patch transaction created; an absent target is a no-op, and a directory or link in
   * the final position is refused.
   */
  async removeFile(canonicalPath: string): Promise<void> {
    if (!isCanonicalRelativePath(canonicalPath) || isProtectedPath(canonicalPath)) throw new Error(`WORKSPACE_ESCAPE: '${canonicalPath}' is not a removable canonical path`);
    const target = this.absolute(canonicalPath);
    const existing = await lstatOptional(target);
    if (!existing) return;
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`WORKSPACE_ESCAPE: Patch target '${canonicalPath}' is not a regular file`);
    if ((await realpath(target)) !== target) throw new Error('WORKSPACE_ESCAPE: Patch target leaves the canonical workspace');
    await rm(target);
  }

  /**
   * The canonical absolute parent directory for `segments`, creating any missing level under the
   * root one at a time and rechecking containment after each creation, so a link out of the
   * workspace is refused before it can receive anything.
   */
  private async ensureContainedParent(segments: readonly string[]): Promise<string> {
    const prefix = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
    let current = this.root;
    for (const segment of segments) {
      const next = join(current, segment);
      const resolved = await realpath(next).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (resolved === null) {
        await mkdir(next, 0o755);
        // The created level must be a real directory inside the canonical root, never a link.
        if ((await realpath(next)) !== next || !next.startsWith(prefix)) throw new Error('WORKSPACE_ESCAPE: Patch target parent leaves the canonical workspace');
      } else if (resolved !== next || !next.startsWith(prefix)) {
        throw new Error('WORKSPACE_ESCAPE: Patch target parent leaves the canonical workspace');
      }
      current = next;
    }
    return current;
  }
}
