import type { SourceEvidence } from '../contracts/foundation/uc03.ts';
import { isCanonicalRelativePath, isProtectedPath, validateSourceEvidence } from '../contracts/foundation/uc03.ts';
import { journalSnapshotV02 } from '../approvals/control-v02.ts';
import { containsProtectedContent } from './docker-workspace-policy.ts';
import type { RepositoryReadOperationsOptions, TrustedFilesystemEntry } from './repository-types.ts';
export { containsProtectedContent };

export class ControlledRepositoryReader {
  private readonly guardCapability: RepositoryReadOperationsOptions['guardCapability'];
  private readonly fsPort: RepositoryReadOperationsOptions['fsPort'];
  private readonly limits: RepositoryReadOperationsOptions['limits'];
  private readonly expectedRevisionDigest?: string | undefined;
  private readonly workspaceRoot?: string | undefined;
  private readonly statePort: RepositoryReadOperationsOptions['statePort'];
  private readonly taskControl: RepositoryReadOperationsOptions['taskControl'];

  constructor(options: RepositoryReadOperationsOptions) {
    this.guardCapability = options.guardCapability;
    this.fsPort = options.fsPort;
    this.limits = options.limits;
    this.expectedRevisionDigest = options.expectedRevisionDigest;
    if (options.workspaceRoot !== undefined) {
      let root = options.workspaceRoot.replace(/\\/g, '/');
      while (root.endsWith('/') && root.length > 1 && !/^[a-zA-Z]:\/$/.test(root)) root = root.slice(0, -1);
      this.workspaceRoot = root;
    }
    this.statePort = options.statePort;
    this.taskControl = options.taskControl;
  }

  private checkReadHold(): void {
    if (!this.taskControl) {
      if (this.statePort) {
        throw new Error('TASK_CONTROL_REQUIRED: A task-control snapshot port is required for repository reads');
      }
      return;
    }
    const journalSnapshot = journalSnapshotV02(this.taskControl.getJournalSnapshot());
    if (!journalSnapshot) {
      throw new Error('INVALID_TASK_CONTROL_SNAPSHOT: Repository read requires a v0.2 task-control snapshot');
    }
    if (journalSnapshot.mode !== 'runnable' || journalSnapshot.holdRef !== null) {
      throw new Error(`TASK_PAUSED_OR_HELD: Task is not runnable (mode: ${journalSnapshot.mode}, holdRef: ${journalSnapshot.holdRef})`);
    }
    if (journalSnapshot.activeClaimId !== null) {
      throw new Error(`CLAIM_OPEN_READ_DENIED: Claim '${journalSnapshot.activeClaimId}' is open`);
    }
    const openClaim = journalSnapshot.claims.find((claim) => claim.status !== 'settled' && claim.status !== 'closed');
    if (openClaim) {
      throw new Error(`CLAIM_OPEN_READ_DENIED: Claim '${openClaim.claimId}' is open (${openClaim.status})`);
    }
  }

  private async recheckRevision(): Promise<string> {
    this.checkReadHold();
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

    this.checkReadHold();
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

      this.checkReadHold();
      const lstat = await this.fsPort.lstat(accumulatedPath);
      if (i < segments.length - 1 && lstat.isFile) {
        throw new Error(`INVALID_PATH: Ancestor '${accumulatedPath}' is a file, not a directory`);
      }

      this.checkReadHold();
      const resolved = await this.fsPort.realpath(accumulatedPath);
      lastResolved = this.assertResolvedPathContainment(accumulatedPath, resolved);
    }

    return { resolvedPath: lastResolved };
  }

  private createValidatedEvidence(filePath: string, content: string, revisionDigest: string): SourceEvidence {
    let boundedExcerpt = content;
    let truncated = false;
    if (Buffer.byteLength(content, 'utf-8') > this.limits.maxExcerptBytes) {
      const contentBytes = Buffer.from(content, 'utf-8');
      let excerptLength = this.limits.maxExcerptBytes;
      let codePointStart = excerptLength - 1;
      while (codePointStart > 0 && ((contentBytes[codePointStart] ?? 0) & 0b1100_0000) === 0b1000_0000) codePointStart--;
      const firstCodePointByte = contentBytes[codePointStart] ?? 0;
      const codePointLength = firstCodePointByte < 0x80 ? 1 : firstCodePointByte < 0xe0 ? 2 : firstCodePointByte < 0xf0 ? 3 : 4;
      if (codePointStart + codePointLength > excerptLength) excerptLength = codePointStart;
      boundedExcerpt = contentBytes.subarray(0, excerptLength).toString('utf-8');
      truncated = true;
    }
    const evidence: SourceEvidence = { path: filePath, revisionDigest, boundedExcerpt, resultCount: 1, truncated };
    const valid = validateSourceEvidence(evidence, { maxExcerptBytes: this.limits.maxExcerptBytes, maxResultCount: this.limits.maxResultCount });
    if (!valid.ok) throw new Error(`INVALID_SOURCE_EVIDENCE: ${valid.errors.map((e) => e.message).join('; ')}`);
    return valid.value;
  }

  async listDir(dirPath: string): Promise<readonly string[]> {
    this.checkReadHold();
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

        this.checkReadHold();
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
    this.checkReadHold();
    if (!isCanonicalRelativePath(filePath)) throw new Error(`WORKSPACE_ESCAPE: Path '${filePath}' must be a canonical relative path`);
    if (isProtectedPath(filePath)) throw new Error(`PROTECTED_PATH_FORBIDDEN: Path '${filePath}' is protected and cannot be read`);

    return await this.guardCapability.mediateRead({
      kind: 'read',
      targetPath: filePath,
      execute: async () => {
        const initialRevision = await this.recheckRevision();
        const preCheck = await this.checkPathContainment(filePath);

        this.checkReadHold();
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

        this.checkReadHold();
        const content = await this.fsPort.readTextFile(filePath, this.limits.maxFileSizeBytes);

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
    this.checkReadHold();
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
            this.checkReadHold();
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
                this.checkReadHold();
                const stat = await this.fsPort.stat(child);
                if (stat.isDirectory || (this.limits.maxFileSizeBytes !== undefined && stat.size > this.limits.maxFileSizeBytes)) continue;
                const preReadRev = await this.recheckRevision();
                if (preReadRev !== initialRevision) {
                  throw new Error(`REVISION_DRIFT: Revision changed from ${initialRevision} to ${preReadRev} before read in searchCode`);
                }

                this.checkReadHold();
                const content = await this.fsPort.readTextFile(child, this.limits.maxFileSizeBytes);

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
}
