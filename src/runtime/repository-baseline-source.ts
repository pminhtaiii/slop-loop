/**
 * T033 — retained initial repository content for host-composition §7.
 *
 * Distinct from the UC-04 baseline *evidence* writer (`baseline-evidence-adapter.ts`): that one
 * records investigation evidence in owner storage, while this source only measures the retained
 * initial tree that a later diff (T032) compares current bytes against.
 *
 * The trusted catalog/config supplies the immutable retained tree (a caller-owned directory
 * outside task/model/container write authority) and its complete admitted manifest. Facts are
 * measured with the T022 snapshot primitives and the T022 refusal type. Nothing is generated
 * from the current post-patch workspace, and no method writes to the retention directory.
 */
import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { computeCanonicalSha256, isCanonicalRelativePath, isProtectedPath } from '../contracts/foundation/uc03.ts';
import { SHA256_HEX_REGEX, computeFileDigest, containsProtectedContent } from '../foundation/docker-workspace-policy.ts';
import { WorkspaceFilesystemPort } from '../foundation/host-filesystem-port.ts';
import type { TrustedFilesystemEntry, TrustedFilesystemPort } from '../foundation/repository-types.ts';
import { TrustedHostSnapshotError, isSupportedSnapshotPlatform } from './trusted-host-snapshot.ts';
import type { TrustedHostSnapshotRefusal } from './trusted-host-snapshot.ts';

export interface RepositoryBaselineBinding {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  /** Measured revision digest of the retained initial tree. */
  readonly baseRevision: string;
}

export interface RepositoryBaselineManifestEntry {
  readonly path: string;
  /** Raw-byte sha256, matching `WorkspaceFilesystemPort.getCurrentRevisionDigest`. */
  readonly digest: string;
  readonly sizeBytes: number;
}

export interface RepositoryBaselineManifest {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly baseRevision: string;
  readonly entries: readonly RepositoryBaselineManifestEntry[];
  readonly manifestDigest: string;
}

export interface RepositoryBaselineFile {
  readonly path: string;
  readonly content: string;
  readonly digest: string;
  readonly sizeBytes: number;
}

export interface RepositoryBaselineSource {
  loadManifest(binding: RepositoryBaselineBinding): Promise<RepositoryBaselineManifest>;
  readBaselineFile(binding: RepositoryBaselineBinding, path: string): Promise<RepositoryBaselineFile>;
}

export interface RepositoryBaselineSourceOptions {
  /** Retained initial tree; it must not sit inside writable task authority. */
  readonly root: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  /** Revision digest measured from the retained tree when it was prepared, before execution admission. */
  readonly baseRevision: string;
  readonly manifest: readonly RepositoryBaselineManifestEntry[];
  readonly maxFileBytes: number;
  /** When supplied, a retention directory inside this writable root is refused. */
  readonly taskWorkspaceRoot?: string | undefined;
}

function fail(code: TrustedHostSnapshotRefusal, message: string): never {
  throw new TrustedHostSnapshotError(code, message);
}

function requireText(value: unknown, code: TrustedHostSnapshotRefusal, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(code, `${field} must be a non-empty string`);
  return value;
}

function comparePaths(left: RepositoryBaselineManifestEntry, right: RepositoryBaselineManifestEntry): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function normalizeManifest(manifest: unknown, maxFileBytes: number): readonly RepositoryBaselineManifestEntry[] {
  if (!Array.isArray(manifest) || manifest.length === 0) fail('INVALID_CONFIGURATION', 'the admitted manifest must be a non-empty array');
  const seen = new Set<string>();
  const out: RepositoryBaselineManifestEntry[] = [];
  for (const item of manifest) {
    if (!item || typeof item !== 'object') fail('INVALID_CONFIGURATION', 'each manifest entry must be an object');
    const path = requireText(item.path, 'INVALID_CONFIGURATION', 'manifest path');
    if (!isCanonicalRelativePath(path)) fail('INVALID_CONFIGURATION', `manifest path '${path}' must be canonical and repository-relative`);
    if (isProtectedPath(path)) fail('INVALID_CONFIGURATION', `manifest path '${path}' is protected`);
    if (seen.has(path)) fail('INVALID_CONFIGURATION', `manifest path '${path}' is duplicated`);
    seen.add(path);
    const digest = requireText(item.digest, 'INVALID_CONFIGURATION', `manifest digest for '${path}'`);
    if (!SHA256_HEX_REGEX.test(digest)) fail('INVALID_CONFIGURATION', `manifest digest for '${path}' must be a sha256 digest`);
    const sizeBytes: unknown = item.sizeBytes;
    if (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0) fail('INVALID_CONFIGURATION', `manifest size for '${path}' must be a non-negative safe integer`);
    if ((sizeBytes as number) > maxFileBytes) fail('INVALID_CONFIGURATION', `manifest size for '${path}' exceeds maxFileBytes`);
    out.push(Object.freeze({ path, digest, sizeBytes: sizeBytes as number }));
  }
  out.sort(comparePaths);
  return Object.freeze(out);
}

async function lstatOrFail(filesystem: TrustedFilesystemPort, path: string) {
  try {
    return await filesystem.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('MISSING_FILE', `baseline file '${path}' is missing from retention`);
    fail('UNREADABLE_FILE', `baseline file '${path}' could not be inspected`);
  }
}

async function realpathOrFail(filesystem: TrustedFilesystemPort, path: string): Promise<string> {
  try {
    return await filesystem.realpath(path);
  } catch {
    fail('UNREADABLE_FILE', `baseline file '${path}' could not be resolved`);
  }
}

async function readDirOrFail(filesystem: TrustedFilesystemPort, dir: string): Promise<readonly TrustedFilesystemEntry[]> {
  try {
    return await filesystem.readDir(dir);
  } catch {
    fail('UNREADABLE_FILE', `baseline directory '${dir || '.'}' could not be listed`);
  }
}

export function createRepositoryBaselineSource(options: RepositoryBaselineSourceOptions): RepositoryBaselineSource {
  if (!options || typeof options !== 'object') fail('INVALID_CONFIGURATION', 'options are required');
  const root = requireText(options.root, 'INVALID_CONFIGURATION', 'root');
  const taskId = requireText(options.taskId, 'INVALID_CONFIGURATION', 'taskId');
  const workspaceId = requireText(options.workspaceId, 'INVALID_CONFIGURATION', 'workspaceId');
  const repositoryId = requireText(options.repositoryId, 'INVALID_CONFIGURATION', 'repositoryId');
  const baseRevision = requireText(options.baseRevision, 'INVALID_CONFIGURATION', 'baseRevision');
  if (!SHA256_HEX_REGEX.test(baseRevision)) fail('INVALID_CONFIGURATION', 'baseRevision must be a sha256 digest');
  const maxFileBytes = options.maxFileBytes;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) fail('INVALID_CONFIGURATION', 'maxFileBytes must be a positive safe integer');
  const entries = normalizeManifest(options.manifest, maxFileBytes);
  const writableRoot = options.taskWorkspaceRoot;
  if (writableRoot !== undefined) {
    // shortcut: the writable-root exclusion is lexical, upgrade to realpath comparison when
    // retention and workspace roots are guaranteed to exist at static preflight.
    const within = relative(resolve(writableRoot), resolve(root));
    if (within === '' || (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within))) {
      fail('INVALID_CONFIGURATION', 'the retained baseline must live outside writable task authority');
    }
  }

  const byPath: ReadonlyMap<string, RepositoryBaselineManifestEntry> = new Map(entries.map(entry => [entry.path, entry]));
  const manifestDigest = computeCanonicalSha256(entries);

  const openRetention = (): TrustedFilesystemPort => {
    const info = statSync(root, { throwIfNoEntry: false });
    if (!info?.isDirectory()) fail('MISSING_FILE', `retained baseline '${root}' is unavailable`);
    return new WorkspaceFilesystemPort({ root });
  };

  const measureRevision = async (filesystem: TrustedFilesystemPort): Promise<string> => {
    const digest = await filesystem.getCurrentRevisionDigest();
    if (typeof digest !== 'string' || !SHA256_HEX_REGEX.test(digest)) fail('REVISION_MISMATCH', 'the retained tree returned a malformed revision digest');
    return digest;
  };

  const measureFile = async (filesystem: TrustedFilesystemPort, entry: RepositoryBaselineManifestEntry): Promise<string> => {
    const link = await lstatOrFail(filesystem, entry.path);
    if (link.isSymbolicLink) fail('LINKED_ESCAPE', `baseline file '${entry.path}' is a symbolic link or junction`);
    if (!link.isFile) fail('MISSING_FILE', `baseline file '${entry.path}' is not a regular file`);
    if (link.size > maxFileBytes) fail('OVERSIZED_FILE', `baseline file '${entry.path}' exceeds ${maxFileBytes} bytes`);
    // A link or junction anywhere above the file resolves elsewhere; containment requires identity.
    if ((await realpathOrFail(filesystem, entry.path)) !== entry.path) fail('LINKED_ESCAPE', `baseline file '${entry.path}' resolves outside its retained path`);

    let content: string;
    try {
      content = await filesystem.readTextFile(entry.path, maxFileBytes);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('FILE_TOO_LARGE')) fail('OVERSIZED_FILE', `baseline file '${entry.path}' exceeds ${maxFileBytes} bytes`);
      fail('UNREADABLE_FILE', `baseline file '${entry.path}' could not be read`);
    }
    if (content.includes('\0') || content.includes('�')) fail('UNREADABLE_FILE', `baseline file '${entry.path}' is not UTF-8 text`);
    if (containsProtectedContent(content)) fail('PROTECTED_CONTENT', `baseline file '${entry.path}' contains protected content`);
    if (computeFileDigest(content) !== entry.digest) fail('REVISION_MISMATCH', `retained baseline file '${entry.path}' no longer matches its recorded digest`);
    return content;
  };

  const walk = async (filesystem: TrustedFilesystemPort, dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const item of await readDirOrFail(filesystem, dir)) {
      const child = dir === '' ? item.name : `${dir}/${item.name}`;
      if (item.isSymbolicLink) fail('LINKED_ESCAPE', `retained baseline '${child}' is a symbolic link or junction`);
      if (isProtectedPath(child)) fail('PROTECTED_CONTENT', `retained baseline '${child}' is a protected path`);
      if (item.isDirectory) out.push(...(await walk(filesystem, child)));
      else if (item.isFile) out.push(child);
      else fail('UNREADABLE_FILE', `retained baseline '${child}' is not a regular file or directory`);
    }
    return out;
  };

  const assertBinding = (binding: RepositoryBaselineBinding): void => {
    if (!binding || typeof binding !== 'object') fail('INVALID_REQUEST', 'a baseline binding is required');
    requireText(binding.taskId, 'INVALID_REQUEST', 'taskId');
    requireText(binding.workspaceId, 'INVALID_REQUEST', 'workspaceId');
    requireText(binding.repositoryId, 'INVALID_REQUEST', 'repositoryId');
    requireText(binding.baseRevision, 'INVALID_REQUEST', 'baseRevision');
    if (binding.taskId !== taskId || binding.workspaceId !== workspaceId || binding.repositoryId !== repositoryId) {
      fail('IDENTITY_MISMATCH', 'the binding does not match the configured task, workspace, or repository');
    }
    if (binding.baseRevision !== baseRevision) fail('REVISION_MISMATCH', `binding base revision '${binding.baseRevision}' is not the retained '${baseRevision}'`);
  };

  return Object.freeze({
    async loadManifest(binding: RepositoryBaselineBinding): Promise<RepositoryBaselineManifest> {
      if (!isSupportedSnapshotPlatform(process.platform)) fail('UNSUPPORTED_PLATFORM', `trusted baseline measurement is unsupported on '${process.platform}'`);
      assertBinding(binding);
      const filesystem = openRetention();

      const actual = (await walk(filesystem, '')).sort();
      const recorded = entries.map(entry => entry.path);
      if (actual.length !== recorded.length || actual.some((path, index) => path !== recorded[index])) {
        fail('INVALID_CONFIGURATION', 'the retained tree and the admitted manifest do not list exactly the same files');
      }

      const revision = await measureRevision(filesystem);
      if (revision !== baseRevision) fail('REVISION_MISMATCH', `retained revision '${revision}' does not match the recorded base '${baseRevision}'`);
      for (const entry of entries) await measureFile(filesystem, entry);
      // Re-measure after the reads: any write during measurement refuses the whole manifest.
      if ((await measureRevision(filesystem)) !== revision) fail('REVISION_DRIFT', 'the retained tree changed during baseline measurement');

      return Object.freeze({ taskId, workspaceId, repositoryId, baseRevision, entries, manifestDigest });
    },

    async readBaselineFile(binding: RepositoryBaselineBinding, path: string): Promise<RepositoryBaselineFile> {
      if (!isSupportedSnapshotPlatform(process.platform)) fail('UNSUPPORTED_PLATFORM', `trusted baseline measurement is unsupported on '${process.platform}'`);
      assertBinding(binding);
      if (typeof path !== 'string' || !isCanonicalRelativePath(path)) fail('INVALID_REQUEST', `'${String(path)}' must be a canonical repository-relative path`);
      if (isProtectedPath(path)) fail('PROTECTED_CONTENT', `baseline path '${path}' is protected`);
      const entry = byPath.get(path);
      if (!entry) fail('INVALID_REQUEST', `'${path}' is not part of the admitted baseline manifest`);

      const content = await measureFile(openRetention(), entry);
      return Object.freeze({ path, content, digest: entry.digest, sizeBytes: entry.sizeBytes });
    },
  });
}
