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

/**
 * The owner's measurement of the same snapshot this builder is about to materialize (T025).
 *
 * Host-composition §5: owner admission facts and the Docker view must describe *the same measured
 * snapshot*, and neither side may rewrite a value to satisfy the other. So this is compared, never
 * merged — a disagreement refuses before the executor or materializer is reached, which is why the
 * known literal exclusions/scratch mismatch must be corrected at the UC-04 producer rather than
 * papered over here.
 *
 * The accepted measurement also yields the host-owned isolation record below, so the owner's
 * reference reaches `admissionCommandView` as a capability rather than as a caller-supplied string.
 */
export interface OwnerCommandViewMeasurementV02 {
  readonly canonicalRevision: string;
  readonly exclusionsPolicyVersion: string;
  readonly scratchIdentity: string;
  readonly admittedFiles: readonly AdmittedFile[];
  readonly mountedReadOnly: true;
  readonly isolationProfileRef: string;
}

/**
 * Host-composition §9: the isolation record a successful build issues for the view it published.
 * Object identity in a module-private set is the capability — a caller cannot construct one.
 */
export interface MeasuredCommandViewIsolation {
  readonly viewId: string;
  readonly viewDigest: string;
  readonly isolationProfileRef: string;
}

const measuredCommandViews = new WeakSet<MeasuredCommandViewIsolation>();

export function isMeasuredCommandViewIsolation(value: unknown): value is MeasuredCommandViewIsolation {
  return value !== null && typeof value === 'object' && measuredCommandViews.has(value as MeasuredCommandViewIsolation);
}

export interface IssuedCommandView {
  readonly view: CommandView;
  /** Absent when the build had no owner measurement, so there is no isolation to hand off. */
  readonly measured?: MeasuredCommandViewIsolation;
}

export type CommandViewOwnerBindingParams = AdmitCommandViewParams & {
  /** Absent for legacy/controlled callers; when present its facts are authoritative. */
  readonly ownerView?: OwnerCommandViewMeasurementV02 | undefined;
  /** The trusted execution profile the owner measurement must name; requires `ownerView`. */
  readonly trustedIsolationProfileRef?: string | undefined;
};

function ownerViewMismatch(
  params: CommandViewOwnerBindingParams,
  observed: { revision: string; exclusionsPolicyVersion: string; scratchIdentity: string; admittedFiles: readonly AdmittedFile[] },
): string | null {
  const owner = params.ownerView;
  if (owner === undefined) {
    // A trusted profile with nothing to compare against is a caller bug, not a skipped check.
    return params.trustedIsolationProfileRef === undefined ? null : 'trustedIsolationProfileRef requires an owner view measurement';
  }
  if (!owner || typeof owner !== 'object') return 'owner view measurement must be an object';
  if (typeof owner.isolationProfileRef !== 'string' || owner.isolationProfileRef.length === 0 || owner.isolationProfileRef.length > 256)
    return 'owner isolationProfileRef must be a bounded non-empty string';
  if (params.trustedIsolationProfileRef !== undefined && owner.isolationProfileRef !== params.trustedIsolationProfileRef)
    return `owner isolationProfileRef ${owner.isolationProfileRef} does not match trusted profile ${params.trustedIsolationProfileRef}`;
  if (owner.mountedReadOnly !== true) return 'owner view must declare mountedReadOnly';
  if (owner.canonicalRevision !== observed.revision) return `revision ${owner.canonicalRevision} does not match measured ${observed.revision}`;
  if (owner.exclusionsPolicyVersion !== observed.exclusionsPolicyVersion) return `exclusions policy ${owner.exclusionsPolicyVersion} does not match measured ${observed.exclusionsPolicyVersion}`;
  if (owner.scratchIdentity !== observed.scratchIdentity) return 'scratch identity differs from the measured workspace scratch';
  if (!Array.isArray(owner.admittedFiles)) return 'owner admittedFiles must be an array';
  // Owner data is untrusted: a malformed entry must yield a mismatch string, not a raw TypeError.
  const ownerDigests = new Map<string, string>();
  for (const file of owner.admittedFiles as readonly unknown[]) {
    if (!file || typeof file !== 'object') return 'owner admitted files must be path and digest entries';
    const { path, digest } = file as AdmittedFile;
    if (typeof path !== 'string' || typeof digest !== 'string') return 'owner admitted files must be path and digest entries';
    if (ownerDigests.has(path)) return 'admitted file inventory differs from the measured snapshot';
    ownerDigests.set(path, digest);
  }
  if (ownerDigests.size !== observed.admittedFiles.length) return 'admitted file inventory differs from the measured snapshot';
  for (const file of observed.admittedFiles) {
    if (ownerDigests.get(file.path) !== file.digest) return `admitted digest for '${file.path}' differs from the measured snapshot`;
  }
  return null;
}

export async function buildDockerCommandView(params: CommandViewOwnerBindingParams, controller: DockerLifecycleController, operations: DockerViewBuilderOperations): Promise<IssuedCommandView> {
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
    const required = new Set<string>([...(snapshot.requiredFiles ?? []), ...(params.requiredFiles ?? [])]);

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

        const targetStr = typeof targetEntry.content === 'string' ? targetEntry.content : Buffer.from(targetEntry.content).toString('utf8');

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
      const contentStr = typeof resolvedContent === 'string' ? resolvedContent : Buffer.from(resolvedContent).toString('utf8');
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
      throw new Error(`INVALID_COMMAND_VIEW: ${validation.errors.map(e => e.message).join('; ')}`);
    }

    // Owner/view agreement is checked after the view is measured but before anything is mutated, so
    // a mismatch costs zero executor calls and leaves view/accounting state untouched.
    const mismatch = ownerViewMismatch(params, {
      revision: initialRev,
      exclusionsPolicyVersion,
      scratchIdentity: workspace.scratchVolumeId,
      admittedFiles,
    });
    if (mismatch !== null) throw new Error(`OWNER_VIEW_MISMATCH: ${mismatch}`);

    // Materialization replaces the view volume, so any earlier view for this revision must stop
    // being selectable before that destructive step, even if the replacement write then fails.
    operations.invalidateViews(params.workspaceId);
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
    // Issued only from an accepted owner measurement of the published view: a build with no
    // ownerView hands back no record, so lifting for isolation refuses instead of defaulting.
    if (params.ownerView === undefined) return { view: commandView };
    const measured: MeasuredCommandViewIsolation = Object.freeze({
      viewId: commandView.viewId,
      viewDigest: commandView.viewDigest,
      isolationProfileRef: params.ownerView.isolationProfileRef,
    });
    measuredCommandViews.add(measured);
    return { view: commandView, measured };
  } finally {
    gateLease.release();
  }
}
