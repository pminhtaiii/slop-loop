import { createHash } from 'node:crypto';
import { computeCommandViewDigest, isCanonicalRelativePath, isProtectedPath, validateCommandView } from '../contracts/foundation/uc03.ts';
import type { AdmittedFile, CommandView, TaskWorkspace } from '../contracts/foundation/uc03.ts';
import type { AdmitCommandViewParams, CanonicalRepositorySnapshot, CanonicalSnapshotEntry, DockerLifecycleController, WorkspaceLease } from './docker-workspace-types.ts';
import { containsProtectedContent, computeFileDigest, SHA256_HEX_REGEX } from './docker-workspace-policy.ts';

interface DockerViewBuilderOperations {
  readonly getWorkspace: (workspaceId: string) => TaskWorkspace | undefined;
  readonly getCanonicalRevision: (workspaceId: string) => string | undefined;
  readonly acquireReadLease: (workspaceId: string, expectedRevision?: string) => Promise<WorkspaceLease>;
  readonly invalidateViews: (workspaceId: string) => void;
  readonly publishView: (workspaceId: string, view: CommandView) => void;
}

export async function buildDockerCommandView(
  params: AdmitCommandViewParams,
  controller: DockerLifecycleController,
  operations: DockerViewBuilderOperations
): Promise<CommandView> {
  if (!params || typeof params !== 'object') {
    throw new Error('INVALID_ADMIT_PARAMS: params must be an object');
  }
  if (!params.workspaceId || typeof params.workspaceId !== 'string') {
    throw new Error('INVALID_WORKSPACE_ID: workspaceId must be a non-empty string');
  }

  const workspace = operations.getWorkspace(params.workspaceId);
  if (!workspace) throw new Error(`WORKSPACE_NOT_FOUND: Workspace '${params.workspaceId}' not found`);

  const initialRev = operations.getCanonicalRevision(params.workspaceId) ?? workspace.expectedRepoState;

  // Caller self-authorized files are rejected / ignored; controller is sole authority.
  const requestedRev = params.expectedRevisionDigest ?? params.canonicalRevisionDigest;
  if (requestedRev !== undefined && requestedRev !== initialRev) {
    throw new Error(`STALE_COMMAND_VIEW: Requested revision ${requestedRev} does not match current canonical revision ${initialRev}`);
  }

  // Missing controller snapshot/materializer fails closed
  if (typeof controller.getCanonicalSnapshot !== 'function') {
    throw new Error('CONTROLLER_SNAPSHOT_METHOD_REQUIRED: Injected controller missing getCanonicalSnapshot method');
  }
  if (typeof controller.materializeView !== 'function') {
    throw new Error('CONTROLLER_MATERIALIZE_METHOD_REQUIRED: Injected controller missing materializeView method');
  }

  // Section 10 Case 20: Command-view builder participates in workspace gate
  const gateLease = await operations.acquireReadLease(params.workspaceId, requestedRev ?? initialRev);
  try {
    const snapshot: CanonicalRepositorySnapshot = await controller.getCanonicalSnapshot(params.workspaceId);
    if (!snapshot || typeof snapshot !== 'object') {
      throw new Error('INVALID_SNAPSHOT: Controller returned invalid snapshot');
    }

    // Verify trusted canonical revision
    if (!SHA256_HEX_REGEX.test(snapshot.canonicalRevisionDigest)) {
      throw new Error(`INVALID_REVISION_DIGEST: Snapshot revision '${snapshot.canonicalRevisionDigest}' must be a valid sha256 hex digest`);
    }
    if (snapshot.canonicalRevisionDigest !== initialRev) {
      throw new Error(`STALE_COMMAND_VIEW: Snapshot canonical revision ${snapshot.canonicalRevisionDigest} does not match workspace canonical revision ${initialRev}`);
    }

    const exclusionsPolicyVersion = params.exclusionsPolicyVersion ?? snapshot.exclusionsPolicyVersion ?? '0.1.0';

    if (!Array.isArray(snapshot.entries)) {
      throw new Error('INVALID_SNAPSHOT: snapshot.entries must be an array');
    }

    // Required files policy: combining snapshot policy with optional params policy
    const required = new Set<string>([
      ...(snapshot.requiredFiles ?? []),
      ...(params.requiredFiles ?? []),
    ]);

    // Index entries by canonical relative path
    const entriesByPath = new Map<string, CanonicalSnapshotEntry>();
    for (const entry of snapshot.entries) {
      if (!entry || typeof entry !== 'object') {
        throw new Error('INVALID_SNAPSHOT_ENTRY: Entry must be an object');
      }
      if (typeof entry.path !== 'string') {
        throw new Error('INVALID_SNAPSHOT_ENTRY: Entry path must be a string');
      }
      if (!isCanonicalRelativePath(entry.path)) {
        throw new Error(`WORKSPACE_ESCAPE: Path '${entry.path}' is not a canonical relative path`);
      }
      entriesByPath.set(entry.path, entry);
    }

    const admittedFiles: AdmittedFile[] = [];
    const trustedFileDigests: Record<string, string> = {};
    const permittedBytes: Record<string, string | Uint8Array> = {};
    const excludedFiles = new Set<string>();

    for (const entry of snapshot.entries) {
      const filePath = entry.path;
      const kind = entry.kind;
      const isRegular = kind === 'regular' || kind === 'file';
      const isLink = kind === 'symlink' || kind === 'link';

      if (!isRegular && !isLink) {
        throw new Error(`UNKNOWN_FILE_KIND: File '${filePath}' has unknown kind '${kind}'`);
      }

      let resolvedContent: string | Uint8Array;
      let resolvedDigest: string;

      if (isLink) {
        const target = entry.linkTarget;
        if (typeof target !== 'string' || target.trim().length === 0) {
          throw new Error(`UNSAFE_LINK_TARGET: Link '${filePath}' missing linkTarget`);
        }
        const trimmedTarget = target.trim();

        // Reject outside link targets
        if (!isCanonicalRelativePath(trimmedTarget) || trimmedTarget.startsWith('/') || trimmedTarget.includes('..')) {
          throw new Error(`UNSAFE_LINK_TARGET: Link '${filePath}' target '${trimmedTarget}' points outside repository`);
        }

        // Reject protected link targets
        if (isProtectedPath(trimmedTarget)) {
          throw new Error(`FORBIDDEN_LINK_TARGET: Link '${filePath}' target '${trimmedTarget}' points to protected path`);
        }

        const targetEntry = entriesByPath.get(trimmedTarget);
        if (!targetEntry) {
          throw new Error(`UNSAFE_LINK_TARGET: Link '${filePath}' target '${trimmedTarget}' not found in snapshot`);
        }

        const targetKind = targetEntry.kind;
        if (targetKind === 'symlink' || targetKind === 'link') {
          throw new Error(`UNSAFE_LINK_TARGET: Link '${filePath}' target '${trimmedTarget}' is a symlink (symlink link target rejected)`);
        }
        if (targetKind !== 'regular' && targetKind !== 'file') {
          throw new Error(`UNKNOWN_FILE_KIND: Link '${filePath}' target '${trimmedTarget}' has unknown kind '${targetKind}'`);
        }

        if (targetEntry.content === undefined || targetEntry.content === null) {
          throw new Error(`INVALID_SNAPSHOT_ENTRY: Link target '${trimmedTarget}' missing content`);
        }

        const targetStr = typeof targetEntry.content === 'string'
          ? targetEntry.content
          : Buffer.from(targetEntry.content).toString('utf8');

        if (containsProtectedContent(targetStr)) {
          throw new Error(`FORBIDDEN_LINK_TARGET: Link '${filePath}' target '${trimmedTarget}' contains protected content and is excluded`);
        }

        resolvedContent = targetEntry.content;
        resolvedDigest = targetEntry.digest;
      } else {
        if (entry.content === undefined || entry.content === null) {
          throw new Error(`INVALID_SNAPSHOT_ENTRY: Regular file '${filePath}' missing content`);
        }
        resolvedContent = entry.content;
        resolvedDigest = entry.digest;
      }

      // Verify file digest matches content
      if (!SHA256_HEX_REGEX.test(resolvedDigest)) {
        throw new Error(`INVALID_FILE_DIGEST: Digest for '${filePath}' must be sha256 hex digest`);
      }
      const computed = computeFileDigest(resolvedContent);
      if (computed !== resolvedDigest) {
        throw new Error(`FILE_DIGEST_MISMATCH: Digest for '${filePath}' (${resolvedDigest}) does not match content (${computed})`);
      }

      const protectedPath = isProtectedPath(filePath);
      const contentStr = typeof resolvedContent === 'string'
        ? resolvedContent
        : Buffer.from(resolvedContent).toString('utf8');
      const protectedContent = containsProtectedContent(contentStr);

      if (protectedPath || protectedContent) {
        if (required.has(filePath)) {
          if (protectedPath) {
            throw new Error(`PROTECTED_PATH_FORBIDDEN: Required check file '${filePath}' is a protected path and cannot be admitted`);
          }
          throw new Error(`REQUIRED_FILE_CONTAINS_PROTECTED_CONTENT: Required check file '${filePath}' contains protected content and cannot be silently redacted`);
        }
        excludedFiles.add(filePath);
        continue;
      }

      admittedFiles.push({ path: filePath, digest: resolvedDigest });
      trustedFileDigests[filePath] = resolvedDigest;
      permittedBytes[filePath] = resolvedContent;
    }

    // Required files validation: must be present and not excluded
    for (const reqPath of required) {
      if (excludedFiles.has(reqPath) || !entriesByPath.has(reqPath)) {
        throw new Error(`REQUIRED_FILE_EXCLUDED: Required check depends on excluded or missing file: '${reqPath}'`);
      }
    }

    if (admittedFiles.length === 0) {
      throw new Error('EMPTY_ADMITTED_FILES: No permitted files admitted to command view');
    }

    admittedFiles.sort((a, b) => a.path.localeCompare(b.path));

    const viewId = `view-${params.workspaceId}-${createHash('sha256').update(initialRev).digest('hex').slice(0, 12)}`;
    const partialView = {
      viewId,
      taskId: workspace.taskId,
      workspaceId: params.workspaceId,
      canonicalRevisionDigest: initialRev,
      admittedFiles,
      exclusionsPolicyVersion,
      scratchIdentity: workspace.scratchVolumeId,
      mountedReadOnly: true as const,
    };
    const viewDigest = computeCommandViewDigest(partialView);
    const commandView: CommandView = { ...partialView, viewDigest };

    const validation = validateCommandView(commandView, {
      currentCanonicalRevisionDigest: initialRev,
      currentExclusionsPolicyVersion: exclusionsPolicyVersion,
      expectedViewDigest: viewDigest,
      trustedFileDigests,
    });
    if (!validation.ok) {
      throw new Error(`INVALID_COMMAND_VIEW: ${validation.errors.map((e) => e.message).join('; ')}`);
    }

    // Materialize view on controller passing permitted bytes only and read-only view identity
    await controller.materializeView({
      view: commandView,
      files: Object.freeze({ ...permittedBytes }),
    });

    // Verify change during snapshot/materialization rejects view
    const revAfter = operations.getCanonicalRevision(params.workspaceId);
    if (revAfter !== initialRev) {
      operations.invalidateViews(params.workspaceId);
      throw new Error(`CANONICAL_REVISION_CHANGED: Canonical revision changed during snapshot/materialization from ${initialRev} to ${revAfter}`);
    }

    operations.publishView(params.workspaceId, commandView);
    return commandView;
  } finally {
    gateLease.release();
  }
}
