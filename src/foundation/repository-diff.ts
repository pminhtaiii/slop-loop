/**
 * T032 — bounded repository diff measurement for host-composition §7.
 *
 * Both sides are measured: the retained initial tree (T033 `RepositoryBaselineSource`) and the
 * current tree through the injected trusted filesystem port under the guarded read authority.
 * No caller-supplied bytes, no Git process, no hooks or config, and nothing is written.
 *
 * shortcut: a file without a trailing newline is emitted as if it had one (no "\ No newline"
 * marker) and each changed file is one whole-file hunk; upgrade to byte-exact hunks when a
 * downstream consumer must apply the patch rather than review it.
 */
import { computeCanonicalSha256, isCanonicalRelativePath, isProtectedPath } from '../contracts/foundation/uc03.ts';
import { SHA256_HEX_REGEX, computeFileDigest, containsProtectedContent } from './docker-workspace-policy.ts';
import type { ExecutionGuardReadCapability, TrustedFilesystemPort } from './repository-types.ts';
import type { RepositoryBaselineBinding, RepositoryBaselineSource } from '../runtime/repository-baseline-source.ts';
import { TrustedHostSnapshotError } from '../runtime/trusted-host-snapshot.ts';
import type { TrustedHostSnapshotRefusal } from '../runtime/trusted-host-snapshot.ts';

export interface RepositoryDiffSourceOptions {
  readonly baseline: RepositoryBaselineSource;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  /** Per-file read bound; a larger current or retained file refuses rather than truncating. */
  readonly maxFileBytes: number;
  /** Finite bound on the emitted diff bytes; exceeding it refuses rather than truncating. */
  readonly maxDiffBytes: number;
}

export interface RepositoryDiffMeasurementOptions extends RepositoryDiffSourceOptions {
  /** The caller's claimed base; the retained source must record exactly this revision and identity. */
  readonly binding: RepositoryBaselineBinding;
  readonly filesystem: TrustedFilesystemPort;
  readonly guard: ExecutionGuardReadCapability;
}

export interface RepositoryDiffMeasurement {
  readonly diff: string;
  readonly diffDigest: string;
  readonly changedFiles: readonly string[];
}

function fail(code: TrustedHostSnapshotRefusal, message: string): never {
  throw new TrustedHostSnapshotError(code, message);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail('INVALID_CONFIGURATION', `${field} must be a non-empty string`);
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail('INVALID_CONFIGURATION', `${field} must be a positive safe integer`);
  return value as number;
}

function fileLines(content: string): readonly string[] {
  if (content === '') return [];
  return (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n');
}

/** One whole-file hunk per changed path; `/dev/null` carries the absent side of an add or delete. */
function renderFile(path: string, before: string | null, after: string | null): string {
  const oldLines = before === null ? [] : fileLines(before);
  const newLines = after === null ? [] : fileLines(after);
  const lines = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ ${after === null ? '/dev/null' : `b/${path}`}`];
  lines.push(oldLines.length === 0 ? `@@ -0,0 +1,${newLines.length} @@` : newLines.length === 0 ? `@@ -1,${oldLines.length} +0,0 @@` : `@@ -1,${oldLines.length} +1,${newLines.length} @@`);
  for (const line of oldLines) lines.push(`-${line}`);
  for (const line of newLines) lines.push(`+${line}`);
  return lines.join('\n');
}

/** Validates a diff source against its guard capability; used both here and at construction. */
export function assertRepositoryDiffSource(source: RepositoryDiffSourceOptions, guard: ExecutionGuardReadCapability): { readonly maxFileBytes: number; readonly maxDiffBytes: number } {
  if (!source || typeof source !== 'object') fail('INVALID_CONFIGURATION', 'options are required');
  const { baseline } = source;
  if (!baseline || typeof baseline.loadManifest !== 'function' || typeof baseline.readBaselineFile !== 'function') {
    fail('INVALID_CONFIGURATION', 'a retained repository baseline source is required');
  }
  requireText(source.taskId, 'taskId');
  requireText(source.workspaceId, 'workspaceId');
  requireText(source.repositoryId, 'repositoryId');
  const maxFileBytes = requirePositiveInteger(source.maxFileBytes, 'maxFileBytes');
  const maxDiffBytes = requirePositiveInteger(source.maxDiffBytes, 'maxDiffBytes');
  if (guard.taskId !== source.taskId || guard.workspaceId !== source.workspaceId) {
    fail('IDENTITY_MISMATCH', 'the guarded read capability does not match the task or workspace');
  }
  return { maxFileBytes, maxDiffBytes };
}

export async function measureRepositoryDiff(options: RepositoryDiffMeasurementOptions): Promise<RepositoryDiffMeasurement> {
  if (!options || typeof options !== 'object') fail('INVALID_CONFIGURATION', 'options are required');
  const { baseline, filesystem, guard } = options;
  if (!guard || typeof guard.mediateRead !== 'function') fail('INVALID_CONFIGURATION', 'a guarded read capability is required');
  const { maxFileBytes, maxDiffBytes } = assertRepositoryDiffSource(options, guard);
  if (!filesystem || typeof filesystem.readDir !== 'function' || typeof filesystem.readTextFile !== 'function' || typeof filesystem.getCurrentRevisionDigest !== 'function') {
    fail('INVALID_CONFIGURATION', 'a trusted filesystem port is required');
  }
  const binding = options.binding;
  if (!binding || typeof binding !== 'object') fail('INVALID_REQUEST', 'a baseline binding is required');
  if (typeof binding.baseRevision !== 'string' || !SHA256_HEX_REGEX.test(binding.baseRevision)) {
    fail('INVALID_REQUEST', 'the base revision must be a sha256 digest');
  }
  // The binding is the caller's claim; it must name this measurement.
  if (binding.taskId !== options.taskId || binding.workspaceId !== options.workspaceId || binding.repositoryId !== options.repositoryId) {
    fail('IDENTITY_MISMATCH', 'the baseline binding does not match the task, workspace, or repository');
  }

  // The retained manifest re-measures its own tree, so a missing, mutated or wrong-base baseline
  // refuses here before any current-side byte is read.
  const manifest = await baseline.loadManifest(binding);
  const baseDigest = new Map(manifest.entries.map(entry => [entry.path, entry.digest]));

  return await guard.mediateRead({
    kind: 'list',
    targetPath: '',
    execute: async (): Promise<RepositoryDiffMeasurement> => {
      const initialRevision = await measureRevision(filesystem, maxFileBytes);

      const walk = async (dir: string): Promise<string[]> => {
        const found: string[] = [];
        for (const entry of await readDirOrFail(filesystem, dir)) {
          const child = dir === '' ? entry.name : `${dir}/${entry.name}`;
          if (!isCanonicalRelativePath(child)) fail('INVALID_REQUEST', 'a current path is not a canonical repository-relative path');
          if (entry.isSymbolicLink) fail('LINKED_ESCAPE', `current path '${child}' is a symbolic link or junction`);
          if (isProtectedPath(child)) fail('PROTECTED_CONTENT', `current path '${child}' is protected`);
          if (entry.isDirectory) found.push(...(await walk(child)));
          else if (entry.isFile) found.push(child);
          else fail('UNREADABLE_FILE', `current path '${child}' is not a regular file or directory`);
        }
        return found;
      };

      const currentPaths = (await walk('')).sort();
      // shortcut: every current file is read under the per-file bound, so an unchanged oversized
      // file also refuses; upgrade to a streamed digest when admitted repositories can exceed it.
      const currentContent = new Map<string, string>();
      for (const path of currentPaths) {
        const content = await measureCurrentFile(filesystem, path, maxFileBytes);
        if (baseDigest.get(path) !== computeFileDigest(content)) currentContent.set(path, content);
      }

      const changedFiles: string[] = [];
      for (const path of currentPaths) if (currentContent.has(path)) changedFiles.push(path);
      const deleted: string[] = [];
      for (const entry of manifest.entries) {
        if (currentContent.has(entry.path)) continue;
        if (!currentPaths.includes(entry.path)) deleted.push(entry.path);
      }
      for (const path of deleted) changedFiles.push(path);
      changedFiles.sort();

      const chunks: string[] = [];
      let bytes = 0;
      for (const path of changedFiles) {
        const after = currentContent.get(path) ?? null;
        const before = baseDigest.get(path) === undefined ? null : (await baseline.readBaselineFile(binding, path)).content;
        const chunk = renderFile(path, before, after);
        bytes += Buffer.byteLength(chunk, 'utf8') + 1;
        if (bytes > maxDiffBytes) fail('OVERSIZED_FILE', `the repository diff exceeds ${maxDiffBytes} bytes`);
        chunks.push(chunk);
      }

      // Re-measure after the reads: any write during measurement refuses the whole diff.
      if ((await measureRevision(filesystem, maxFileBytes)) !== initialRevision) fail('REVISION_DRIFT', 'the repository revision changed during diff measurement');

      const diff = chunks.length === 0 ? '' : `${chunks.join('\n')}\n`;
      return Object.freeze({ diff, diffDigest: computeCanonicalSha256(diff), changedFiles: Object.freeze(changedFiles) });
    },
  });
}

async function measureRevision(filesystem: TrustedFilesystemPort, maxFileBytes: number): Promise<string> {
  let digest: string;
  try {
    digest = await filesystem.getCurrentRevisionDigest(maxFileBytes);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('FILE_TOO_LARGE')) fail('OVERSIZED_FILE', `a repository file exceeds ${maxFileBytes} bytes`);
    throw error;
  }
  if (typeof digest !== 'string' || !SHA256_HEX_REGEX.test(digest)) fail('REVISION_MISMATCH', 'the filesystem returned a malformed revision digest');
  return digest;
}

async function readDirOrFail(filesystem: TrustedFilesystemPort, dir: string) {
  try {
    return await filesystem.readDir(dir);
  } catch {
    fail('UNREADABLE_FILE', `current directory '${dir || '.'}' could not be listed`);
  }
}

async function measureCurrentFile(filesystem: TrustedFilesystemPort, path: string, maxFileBytes: number): Promise<string> {
  let link;
  try {
    link = await filesystem.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('MISSING_FILE', `current file '${path}' disappeared during measurement`);
    fail('UNREADABLE_FILE', `current file '${path}' could not be inspected`);
  }
  if (link.isSymbolicLink) fail('LINKED_ESCAPE', `current file '${path}' is a symbolic link or junction`);
  if (!link.isFile) fail('MISSING_FILE', `current file '${path}' is not a regular file`);
  if (link.size > maxFileBytes) fail('OVERSIZED_FILE', `current file '${path}' exceeds ${maxFileBytes} bytes`);
  let resolved: string;
  try {
    resolved = await filesystem.realpath(path);
  } catch {
    fail('UNREADABLE_FILE', `current file '${path}' could not be resolved`);
  }
  // A link or junction anywhere above the file resolves elsewhere; containment requires identity.
  if (resolved !== path) fail('LINKED_ESCAPE', `current file '${path}' resolves outside its repository path`);

  let content: string;
  try {
    content = await filesystem.readTextFile(path, maxFileBytes);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('FILE_TOO_LARGE')) fail('OVERSIZED_FILE', `current file '${path}' exceeds ${maxFileBytes} bytes`);
    fail('UNREADABLE_FILE', `current file '${path}' could not be read`);
  }
  if (content.includes('\0') || content.includes('�')) fail('UNREADABLE_FILE', `current file '${path}' is not UTF-8 text`);
  // Name the path only: protected bytes must never reach a refusal message.
  if (containsProtectedContent(content)) fail('PROTECTED_CONTENT', `current file '${path}' contains protected content`);
  return content;
}
