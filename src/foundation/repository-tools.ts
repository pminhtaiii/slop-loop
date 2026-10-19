/**
 * UC-03 Phase 3 - Controlled Repository Tools (Slice A of T007)
 *
 * Owned path: src/foundation/repository-tools.ts
 * Feature: specs/001-verified-code-repair
 *
 * Implements read/list/search public boundary for RepositoryPort:
 * - Requires explicit injected ExecutionGuard capability and trusted filesystem port.
 * - Genuine guard mediation of read effects (zero IO on denial).
 * - Canonical relative path and resolved symlink/junction containment for every file, directory, and ancestor.
 * - Immediate pre-read recheck (TOCTOU protection) and stale revision drift detection.
 * - Post-read identity and revision revalidation before returning evidence.
 * - Exclusion of protected paths and embedded secrets (zero leak into evidence).
 * - Finite bounds on output/excerpts/result counts with SourceEvidence validation.
 * - Mutation/execution methods fail-closed NOT_IMPLEMENTED for later slices.
 */

import type {
  RepositoryPort,
  PortIdentity,
  PortProvenance,
  SourceEvidence,
  ApplyPatchAction,
  RunCommandAction,
  CheckDefinition,
  CheckResult,
} from '../contracts/uc03.ts';
import {
  isCanonicalRelativePath,
  isProtectedPath,
  validateSourceEvidence,
} from '../contracts/uc03.ts';

export interface FileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly size: number;
}

export interface TrustedFilesystemEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

export interface TrustedFilesystemPort extends PortIdentity {
  stat(canonicalPath: string): Promise<FileStat>;
  lstat(canonicalPath: string): Promise<FileStat>;
  realpath(canonicalPath: string): Promise<string>;
  readDir(canonicalPath: string): Promise<readonly TrustedFilesystemEntry[]>;
  readTextFile(canonicalPath: string): Promise<string>;
  getCurrentRevisionDigest(): Promise<string>;
}

export interface GuardedReadOperation<T = unknown> {
  readonly kind: 'list' | 'read' | 'search';
  readonly targetPath?: string | undefined;
  readonly query?: string | undefined;
  readonly execute: () => Promise<T>;
}

export interface ExecutionGuardReadCapability extends PortIdentity {
  readonly capabilityId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  mediateRead<T>(operation: GuardedReadOperation<T>): Promise<T>;
}

export interface RepositoryReadLimits {
  readonly maxExcerptBytes: number;
  readonly maxResultCount: number;
  readonly maxFileSizeBytes?: number | undefined;
}

export interface ControlledRepositoryToolsOptions {
  readonly guardCapability: ExecutionGuardReadCapability;
  readonly fsPort: TrustedFilesystemPort;
  readonly limits: RepositoryReadLimits;
  readonly expectedRevisionDigest?: string | undefined;
  readonly provenance?: PortProvenance | undefined;
  readonly workspaceRoot?: string | undefined;
}

const EMBEDDED_SECRET_PATTERNS: readonly RegExp[] = [
  /MARKER_SECRET[A-Za-z0-9_-]*/i,
  /marker[-_]?secret/i,
  /-----BEGIN[ A-Z0-9_-]+KEY-----/,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/i,
  /sk-[A-Za-z0-9-_]{20,}/,
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/,
  /(?:token|secret|password|api[_-]?key|access[_-]?token)[\s:=]+['"][A-Za-z0-9_-]{8,}['"]/i,
];

export function containsProtectedContent(content: string): boolean {
  return typeof content === 'string' && content.length > 0 && EMBEDDED_SECRET_PATTERNS.some((re) => re.test(content));
}

export class ControlledRepositoryTools implements RepositoryPort {
  readonly provenance: PortProvenance;
  private readonly guardCapability: ExecutionGuardReadCapability;
  private readonly fsPort: TrustedFilesystemPort;
  private readonly limits: RepositoryReadLimits;
  private readonly expectedRevisionDigest?: string | undefined;
  private readonly workspaceRoot?: string | undefined;

  constructor(options: ControlledRepositoryToolsOptions) {
    if (!options || typeof options !== 'object') throw new Error('INVALID_OPTIONS: Options must be an object');
    if (!options.guardCapability?.mediateRead) throw new Error('MISSING_GUARD_CAPABILITY: Required injected ExecutionGuard capability must be provided');
    if (!options.fsPort?.readTextFile) throw new Error('MISSING_FILESYSTEM_PORT: Required trusted filesystem port must be provided');
    if (!options.limits || typeof options.limits !== 'object') throw new Error('MISSING_LIMITS: Explicit finite limits must be provided');

    const { maxExcerptBytes, maxResultCount } = options.limits;
    if (typeof maxExcerptBytes !== 'number' || maxExcerptBytes <= 0 || !Number.isSafeInteger(maxExcerptBytes)) {
      throw new Error('INVALID_LIMITS: maxExcerptBytes must be a positive integer');
    }
    if (typeof maxResultCount !== 'number' || maxResultCount <= 0 || !Number.isSafeInteger(maxResultCount)) {
      throw new Error('INVALID_LIMITS: maxResultCount must be a positive integer');
    }

    const prov = options.provenance ?? options.fsPort.provenance;
    if (prov !== 'real' && prov !== 'mock') throw new Error('INVALID_PROVENANCE: Provenance must be real or mock');

    this.provenance = prov;
    this.guardCapability = options.guardCapability;
    this.fsPort = options.fsPort;
    this.limits = options.limits;
    this.expectedRevisionDigest = options.expectedRevisionDigest;

    if (options.workspaceRoot !== undefined) {
      if (typeof options.workspaceRoot !== 'string' || options.workspaceRoot.trim().length === 0) {
        throw new Error('INVALID_OPTIONS: workspaceRoot must be a non-empty string if provided');
      }
      let root = options.workspaceRoot.replace(/\\/g, '/');
      while (root.endsWith('/') && root.length > 1 && !/^[a-zA-Z]:\/$/.test(root)) {
        root = root.slice(0, -1);
      }
      this.workspaceRoot = root;
    }
  }

  private async recheckRevision(): Promise<string> {
    const currentRev = await this.fsPort.getCurrentRevisionDigest();
    if (typeof currentRev !== 'string' || currentRev.trim().length === 0) {
      throw new Error('INVALID_REVISION_DIGEST: Current revision digest must be a non-empty string');
    }
    if (this.expectedRevisionDigest !== undefined && currentRev !== this.expectedRevisionDigest) {
      throw new Error(`STALE_REVISION: REVISION_DRIFT: Expected revision ${this.expectedRevisionDigest} but got ${currentRev}`);
    }
    return currentRev;
  }

  private assertResolvedPathContainment(originalPath: string, resolvedTarget: string): string {
    if (typeof resolvedTarget !== 'string') {
      throw new Error(`WORKSPACE_ESCAPE: Path '${originalPath}' resolved to invalid non-string path`);
    }

    const normalized = resolvedTarget.replace(/\\/g, '/');

    if (originalPath === '' || originalPath === '.') {
      if (this.workspaceRoot !== undefined) {
        if (normalized === '' || normalized === '.' || normalized === this.workspaceRoot) {
          return this.workspaceRoot;
        }
        const rootPrefix = this.workspaceRoot.endsWith('/') ? this.workspaceRoot : `${this.workspaceRoot}/`;
        if (normalized.startsWith(rootPrefix)) {
          return normalized;
        }
        throw new Error(`WORKSPACE_ESCAPE: Repository root resolved to '${resolvedTarget}' which escapes workspace root '${this.workspaceRoot}'`);
      }
      if (normalized === '' || normalized === '.') {
        return '';
      }
      if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.includes('..') || normalized.startsWith('../') || normalized === '..') {
        throw new Error(`WORKSPACE_ESCAPE: Repository root resolved to '${resolvedTarget}' which escapes repository root`);
      }
      return normalized;
    }

    if (normalized.length === 0) {
      throw new Error(`WORKSPACE_ESCAPE: Path '${originalPath}' resolved to empty path`);
    }

    if (this.workspaceRoot !== undefined) {
      if (isCanonicalRelativePath(normalized)) {
        if (isProtectedPath(normalized)) {
          throw new Error(`FORBIDDEN_LINK_TARGET: Path '${originalPath}' resolved to protected path '${normalized}'`);
        }
        const rootPrefix = this.workspaceRoot.endsWith('/') ? this.workspaceRoot : `${this.workspaceRoot}/`;
        return `${rootPrefix}${normalized}`;
      }

      const isExactMatch = normalized === this.workspaceRoot;
      const rootPrefix = this.workspaceRoot.endsWith('/') ? this.workspaceRoot : `${this.workspaceRoot}/`;
      const isChild = normalized.startsWith(rootPrefix);
      if (!isExactMatch && !isChild) {
        throw new Error(`WORKSPACE_ESCAPE: Path '${originalPath}' resolved to '${resolvedTarget}' which escapes workspace root '${this.workspaceRoot}'`);
      }
      const relativeToRoot = isExactMatch ? '' : normalized.slice(rootPrefix.length);
      if (relativeToRoot.length > 0) {
        if (relativeToRoot.includes('..') || relativeToRoot.startsWith('../') || relativeToRoot === '..') {
          throw new Error(`WORKSPACE_ESCAPE: Path '${originalPath}' resolved to '${resolvedTarget}' which escapes workspace root`);
        }
        if (isProtectedPath(relativeToRoot)) {
          throw new Error(`FORBIDDEN_LINK_TARGET: Path '${originalPath}' resolved to protected path '${relativeToRoot}'`);
        }
      }
      return normalized;
    }

    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.includes('..') || normalized.startsWith('../') || normalized === '..') {
      throw new Error(`WORKSPACE_ESCAPE: Path '${originalPath}' resolved to '${resolvedTarget}' which escapes repository root`);
    }
    if (normalized.length > 0) {
      if (!isCanonicalRelativePath(normalized)) {
        throw new Error(`WORKSPACE_ESCAPE: Path '${originalPath}' resolved to non-canonical path '${resolvedTarget}'`);
      }
      if (isProtectedPath(normalized)) {
        throw new Error(`FORBIDDEN_LINK_TARGET: Path '${originalPath}' resolved to protected path '${normalized}'`);
      }
    }
    return normalized;
  }

  private async checkPathContainment(targetPath: string): Promise<{ readonly resolvedPath: string }> {
    const normalizedTarget = targetPath === '.' ? '' : targetPath;
    if (normalizedTarget.length > 0) {
      if (!isCanonicalRelativePath(normalizedTarget)) {
        throw new Error(`WORKSPACE_ESCAPE: Path '${targetPath}' must be a canonical relative path`);
      }
      if (isProtectedPath(normalizedTarget)) {
        throw new Error(`PROTECTED_PATH_FORBIDDEN: Path '${targetPath}' is protected and cannot be accessed`);
      }
    }

    const rootReal = await this.fsPort.realpath('');
    this.assertResolvedPathContainment('', rootReal);

    if (normalizedTarget.length === 0) {
      return { resolvedPath: rootReal };
    }

    const segments = normalizedTarget.split('/');
    let accumulatedPath = '';
    let lastResolved = '';

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg === undefined) continue;
      accumulatedPath = accumulatedPath.length === 0 ? seg : `${accumulatedPath}/${seg}`;

      if (!isCanonicalRelativePath(accumulatedPath)) {
        throw new Error(`WORKSPACE_ESCAPE: Ancestor path '${accumulatedPath}' is not a canonical relative path`);
      }
      if (isProtectedPath(accumulatedPath)) {
        throw new Error(`PROTECTED_PATH_FORBIDDEN: Path '${targetPath}' contains protected path '${accumulatedPath}'`);
      }

      const lstat = await this.fsPort.lstat(accumulatedPath);
      if (i < segments.length - 1 && lstat.isFile) {
        throw new Error(`INVALID_PATH: Ancestor '${accumulatedPath}' is a file, not a directory`);
      }

      const resolved = await this.fsPort.realpath(accumulatedPath);
      lastResolved = this.assertResolvedPathContainment(accumulatedPath, resolved);
    }

    return { resolvedPath: lastResolved };
  }

  private createValidatedEvidence(filePath: string, content: string, revisionDigest: string): SourceEvidence {
    let boundedExcerpt = content;
    let truncated = false;
    if (Buffer.byteLength(content, 'utf-8') > this.limits.maxExcerptBytes) {
      boundedExcerpt = Buffer.from(content, 'utf-8').subarray(0, this.limits.maxExcerptBytes).toString('utf-8');
      truncated = true;
    }
    const evidence: SourceEvidence = { path: filePath, revisionDigest, boundedExcerpt, resultCount: 1, truncated };
    const valid = validateSourceEvidence(evidence, { maxExcerptBytes: this.limits.maxExcerptBytes, maxResultCount: this.limits.maxResultCount });
    if (!valid.ok) throw new Error(`INVALID_SOURCE_EVIDENCE: ${valid.errors.map((e) => e.message).join('; ')}`);
    return valid.value;
  }

  async listDir(dirPath: string): Promise<readonly string[]> {
    const normalized = dirPath === '' || dirPath === '.' ? '' : dirPath;
    if (normalized.length > 0) {
      if (!isCanonicalRelativePath(normalized)) throw new Error(`WORKSPACE_ESCAPE: Path '${dirPath}' is not a canonical relative path`);
      if (isProtectedPath(normalized)) throw new Error(`PROTECTED_PATH_FORBIDDEN: Path '${dirPath}' is protected and cannot be listed`);
    }

    return await this.guardCapability.mediateRead({
      kind: 'list',
      targetPath: normalized,
      execute: async () => {
        const initialRevision = await this.recheckRevision();
        const preCheck = await this.checkPathContainment(normalized);

        const preListRevision = await this.recheckRevision();
        if (preListRevision !== initialRevision) {
          throw new Error(`REVISION_DRIFT: Revision changed from ${initialRevision} to ${preListRevision} before listDir`);
        }
        const immediateCheck = await this.checkPathContainment(normalized);
        if (immediateCheck.resolvedPath !== preCheck.resolvedPath) {
          throw new Error(`TOCTOU_RESOLUTION_SWAP: Path '${dirPath}' resolution changed from '${preCheck.resolvedPath}' to '${immediateCheck.resolvedPath}' before listDir`);
        }

        const entries = await this.fsPort.readDir(normalized);

        const postListRevision = await this.recheckRevision();
        if (postListRevision !== initialRevision) {
          throw new Error(`REVISION_DRIFT: Revision changed from ${initialRevision} to ${postListRevision} during listDir`);
        }
        const postCheck = await this.checkPathContainment(normalized);
        if (postCheck.resolvedPath !== immediateCheck.resolvedPath) {
          throw new Error(`TOCTOU_RESOLUTION_SWAP: Path '${dirPath}' resolution changed from '${immediateCheck.resolvedPath}' to '${postCheck.resolvedPath}' after listDir`);
        }

        const filtered: string[] = [];
        for (const entry of entries) {
          const child = normalized.length > 0 ? `${normalized}/${entry.name}` : entry.name;
          if (isProtectedPath(child)) continue;

          try {
            await this.checkPathContainment(child);
          } catch {
            continue;
          }

          filtered.push(entry.name);
          if (filtered.length >= this.limits.maxResultCount) break;
        }
        filtered.sort();
        return filtered;
      },
    });
  }

  async readFile(filePath: string): Promise<SourceEvidence> {
    if (!isCanonicalRelativePath(filePath)) throw new Error(`WORKSPACE_ESCAPE: Path '${filePath}' must be a canonical relative path`);
    if (isProtectedPath(filePath)) throw new Error(`PROTECTED_PATH_FORBIDDEN: Path '${filePath}' is protected and cannot be read`);

    return await this.guardCapability.mediateRead({
      kind: 'read',
      targetPath: filePath,
      execute: async () => {
        const initialRevision = await this.recheckRevision();
        const preCheck = await this.checkPathContainment(filePath);

        const stat = await this.fsPort.stat(filePath);
        if (stat.isDirectory) throw new Error(`INVALID_FILE: Path '${filePath}' is a directory, not a file`);
        if (this.limits.maxFileSizeBytes !== undefined && stat.size > this.limits.maxFileSizeBytes) {
          throw new Error(`FILE_TOO_LARGE: File '${filePath}' exceeds maxFileSizeBytes limit`);
        }

        const preReadRevision = await this.recheckRevision();
        if (preReadRevision !== initialRevision) {
          throw new Error(`REVISION_DRIFT: Revision changed from ${initialRevision} to ${preReadRevision} before read`);
        }
        const immediateCheck = await this.checkPathContainment(filePath);
        if (immediateCheck.resolvedPath !== preCheck.resolvedPath) {
          throw new Error(`TOCTOU_RESOLUTION_SWAP: Path '${filePath}' resolution changed from '${preCheck.resolvedPath}' to '${immediateCheck.resolvedPath}' before read`);
        }

        const content = await this.fsPort.readTextFile(filePath);

        const postReadRevision = await this.recheckRevision();
        if (postReadRevision !== initialRevision) {
          throw new Error(`REVISION_DRIFT: Revision changed from ${initialRevision} to ${postReadRevision} during read`);
        }
        const postCheck = await this.checkPathContainment(filePath);
        if (postCheck.resolvedPath !== immediateCheck.resolvedPath) {
          throw new Error(`TOCTOU_RESOLUTION_SWAP: Path '${filePath}' resolution changed from '${immediateCheck.resolvedPath}' to '${postCheck.resolvedPath}' after read`);
        }

        if (containsProtectedContent(content)) {
          throw new Error(`PROTECTED_CONTENT_FORBIDDEN: File '${filePath}' contains protected content and cannot be admitted into evidence`);
        }
        return this.createValidatedEvidence(filePath, content, postReadRevision);
      },
    });
  }

  async searchCode(query: string): Promise<readonly SourceEvidence[]> {
    if (typeof query !== 'string' || query.length === 0) throw new Error('INVALID_QUERY: Search query must be a non-empty string');

    return await this.guardCapability.mediateRead({
      kind: 'search',
      query,
      execute: async () => {
        const initialRevision = await this.recheckRevision();
        await this.checkPathContainment('');
        const results: SourceEvidence[] = [];
        const queue: string[] = [''];

        while (queue.length > 0 && results.length < this.limits.maxResultCount) {
          const currentDir = queue.shift();
          if (currentDir === undefined) break;

          try {
            await this.checkPathContainment(currentDir);
          } catch {
            continue;
          }

          const preDirRevision = await this.recheckRevision();
          if (preDirRevision !== initialRevision) {
            throw new Error(`REVISION_DRIFT: Revision changed from ${initialRevision} to ${preDirRevision} before readDir in searchCode`);
          }

          let entries: readonly TrustedFilesystemEntry[];
          try {
            entries = await this.fsPort.readDir(currentDir);
          } catch {
            continue;
          }

          const postDirRevision = await this.recheckRevision();
          if (postDirRevision !== initialRevision) {
            throw new Error(`REVISION_DRIFT: Revision changed from ${initialRevision} to ${postDirRevision} after readDir in searchCode`);
          }
          try {
            await this.checkPathContainment(currentDir);
          } catch {
            continue;
          }

          for (const entry of entries) {
            const child = currentDir.length > 0 ? `${currentDir}/${entry.name}` : entry.name;
            if (isProtectedPath(child)) continue;

            if (entry.isDirectory) {
              try {
                await this.checkPathContainment(child);
                queue.push(child);
              } catch {
                continue;
              }
            } else if (entry.isFile || entry.isSymbolicLink) {
              try {
                const preCheck = await this.checkPathContainment(child);
                const preReadRev = await this.recheckRevision();
                if (preReadRev !== initialRevision) {
                  throw new Error(`REVISION_DRIFT: Revision changed from ${initialRevision} to ${preReadRev} before read in searchCode`);
                }

                const content = await this.fsPort.readTextFile(child);

                const postReadRev = await this.recheckRevision();
                if (postReadRev !== initialRevision) {
                  throw new Error(`REVISION_DRIFT: Revision changed from ${initialRevision} to ${postReadRev} after read in searchCode`);
                }
                const postCheck = await this.checkPathContainment(child);
                if (postCheck.resolvedPath !== preCheck.resolvedPath) {
                  continue;
                }

                if (containsProtectedContent(content) || !content.includes(query)) continue;
                results.push(this.createValidatedEvidence(child, content, postReadRev));
                if (results.length >= this.limits.maxResultCount) break;
              } catch (err: unknown) {
                if (err instanceof Error && (err.message.includes('REVISION_DRIFT') || err.message.includes('STALE_REVISION'))) {
                  throw err;
                }
                continue;
              }
            }
          }
        }

        const finalRevision = await this.recheckRevision();
        if (finalRevision !== initialRevision) {
          throw new Error(`REVISION_DRIFT: Revision changed from ${initialRevision} to ${finalRevision} at end of searchCode`);
        }

        return results;
      },
    });
  }

  async applyPatch(patch: ApplyPatchAction): Promise<{ readonly applied: boolean; readonly newRevisionDigest: string }> {
    void patch;
    throw new Error('NOT_IMPLEMENTED: applyPatch is not implemented in T007-a slice');
  }

  async runCommand(action: RunCommandAction): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
    void action;
    throw new Error('NOT_IMPLEMENTED: runCommand is not implemented in T007-a slice');
  }

  async runTests(check: CheckDefinition): Promise<CheckResult> {
    void check;
    throw new Error('NOT_IMPLEMENTED: runTests is not implemented in T007-a slice');
  }

  async inspectDiff(baseRevisionDigest: string): Promise<{ readonly diff: string; readonly diffDigest: string; readonly changedFiles: readonly string[] }> {
    void baseRevisionDigest;
    throw new Error('NOT_IMPLEMENTED: inspectDiff is not implemented in T007-a slice');
  }
}
