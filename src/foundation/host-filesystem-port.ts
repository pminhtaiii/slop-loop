/**
 * Real TrustedFilesystemPort over one workspace directory.
 *
 * Paths in and out are canonical workspace-relative paths, so resolution results feed
 * ControlledRepositoryReader's containment check directly: a link that leaves the
 * workspace resolves to an absolute path and is refused there.
 */
import { realpathSync } from 'node:fs';
import { open, lstat, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { PortProvenance } from '../contracts/foundation/uc03.ts';
import { computeCanonicalSha256, isCanonicalRelativePath } from '../contracts/foundation/uc03.ts';
import { computeFileDigest } from './docker-workspace-policy.ts';
import type { FileStat, TrustedFilesystemEntry, TrustedFilesystemPort } from './repository-types.ts';

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

  async stat(canonicalPath: string): Promise<FileStat> {
    return toFileStat(await stat(this.absolute(canonicalPath)));
  }

  async lstat(canonicalPath: string): Promise<FileStat> {
    return toFileStat(await lstat(this.absolute(canonicalPath)));
  }

  async realpath(canonicalPath: string): Promise<string> {
    return this.relativeToRoot(await realpath(this.absolute(canonicalPath)));
  }

  async readDir(canonicalPath: string): Promise<readonly TrustedFilesystemEntry[]> {
    const entries = await readdir(this.absolute(canonicalPath), { withFileTypes: true });
    return entries.map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  }

  async readTextFile(canonicalPath: string, maxBytes?: number): Promise<string> {
    const handle = await open(this.absolute(canonicalPath), 'r');
    try {
      if (maxBytes === undefined) return await handle.readFile({ encoding: 'utf8' });
      const probe = Buffer.alloc(maxBytes + 1);
      const bytesRead = await readProbe(probe, async (buffer, offset, length, position) => (await handle.read(buffer, offset, length, position)).bytesRead);
      if (bytesRead > maxBytes) throw new Error(`FILE_TOO_LARGE: Path '${canonicalPath}' exceeds ${maxBytes} bytes`);
      return probe.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  /** Deterministic tree digest: sorted `path\0fileDigest\n` lines, symlinks skipped. */
  async getCurrentRevisionDigest(maxBytes?: number): Promise<string> {
    const lines: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await this.readDir(dir)) {
        const child = dir === '' ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory) await walk(child);
        else if (entry.isFile) lines.push(`${child}\0${computeFileDigest(await this.readBytes(child, maxBytes))}\n`);
      }
    };
    await walk('');
    lines.sort();
    return computeCanonicalSha256(lines.join(''));
  }

  private async readBytes(canonicalPath: string, maxBytes?: number): Promise<Buffer> {
    const handle = await open(this.absolute(canonicalPath), 'r');
    try {
      if (maxBytes === undefined) return await handle.readFile();
      const probe = Buffer.alloc(maxBytes + 1);
      const bytesRead = await readProbe(probe, async (buffer, offset, length, position) => (await handle.read(buffer, offset, length, position)).bytesRead);
      if (bytesRead > maxBytes) throw new Error(`FILE_TOO_LARGE: Path '${canonicalPath}' exceeds ${maxBytes} bytes`);
      return probe.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
}
