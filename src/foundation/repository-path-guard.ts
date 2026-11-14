import { isCanonicalRelativePath, isProtectedPath } from '../contracts/foundation/uc03.ts';
import type { TrustedFilesystemPort } from './repository-types.ts';

export interface RepositoryPathGuardOptions {
  readonly fsPort: TrustedFilesystemPort;
  readonly workspaceRoot: string | undefined;
  readonly checkReadHold: () => void;
}

export class RepositoryPathGuard {
  private readonly fsPort: TrustedFilesystemPort;
  private readonly workspaceRoot: string | undefined;
  private readonly checkReadHold: () => void;

  constructor(options: RepositoryPathGuardOptions) {
    this.fsPort = options.fsPort;
    this.workspaceRoot = options.workspaceRoot;
    this.checkReadHold = options.checkReadHold;
  }

  assertResolvedPathContainment(originalPath: string, resolvedTarget: string): string {
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

  checkOperationControl(control: { readonly signal: AbortSignal; readonly deadlineEpochMs: number } | undefined): void {
    if (!control) return;
    if (control.signal.aborted) throw new Error('CANCELLED: Repository operation was cancelled');
    if (Date.now() >= control.deadlineEpochMs) throw new Error('DEADLINE_EXCEEDED: Repository operation deadline elapsed');
  }

  async checkPathContainment(
    targetPath: string,
    control?: { readonly signal: AbortSignal; readonly deadlineEpochMs: number },
  ): Promise<{ readonly resolvedPath: string }> {
    const normalizedTarget = targetPath === '.' ? '' : targetPath;
    if (normalizedTarget.length > 0) {
      if (!isCanonicalRelativePath(normalizedTarget)) {
        throw new Error(`WORKSPACE_ESCAPE: Path '${targetPath}' must be a canonical relative path`);
      }
      if (isProtectedPath(normalizedTarget)) {
        throw new Error(`PROTECTED_PATH_FORBIDDEN: Path '${targetPath}' is protected and cannot be accessed`);
      }
    }

    this.checkOperationControl(control);
    this.checkReadHold();
    const rootReal = await this.fsPort.realpath('', control);
    this.checkOperationControl(control);
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

      this.checkOperationControl(control);
      this.checkReadHold();
      const lstat = await this.fsPort.lstat(accumulatedPath, control);
      this.checkOperationControl(control);
      if (i < segments.length - 1 && lstat.isFile) {
        throw new Error(`INVALID_PATH: Ancestor '${accumulatedPath}' is a file, not a directory`);
      }

      this.checkOperationControl(control);
      this.checkReadHold();
      const resolved = await this.fsPort.realpath(accumulatedPath, control);
      this.checkOperationControl(control);
      lastResolved = this.assertResolvedPathContainment(accumulatedPath, resolved);
    }

    return { resolvedPath: lastResolved };
  }

}
