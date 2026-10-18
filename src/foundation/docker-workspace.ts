/**
 * UC-03 Phase 3 - Docker Workspace Identity, Lifecycle, and Command-View Admission
 *
 * Owned path: src/foundation/docker-workspace.ts
 * Feature: specs/001-verified-code-repair (Slice A of T006)
 *
 * Enforces interfaces.md repository-command view and Docker workspace boundary:
 * - Finite profile validation (non-root, read-only root, network none, safe mounts).
 * - Prepared immutable image identity and stable canonical volume identity on resume.
 * - Injected trusted host controller snapshot method is sole authority for canonical files.
 * - Command-view admission excludes protected paths/content before copying.
 * - Rejects required source containing protected content or missing (no silent redaction).
 * - Byte-identical admitted source/tests mounted read-only; changed revision invalidates views.
 * - Materialization spy receives permitted bytes only and read-only view identity.
 * - Missing controller snapshot/materializer fails closed; revision drift rejects view.
 *
 * Invariant: DockerLifecycleController represents trusted host capability simulation;
 * real kernel/container isolation proof is deferred to T024.
 */

import { createHash } from 'node:crypto';
import {
  type TaskWorkspace,
  type CommandView,
  type AdmittedFile,
  type ValidationError,
  type ValidationResult,
  computeCanonicalSha256,
  computeCommandViewDigest,
  isCanonicalRelativePath,
  isProtectedPath,
  validateCommandView,
  validateTaskWorkspace,
} from '../contracts/uc03.ts';

export interface DockerResourceLimits {
  readonly maxMemoryBytes: number;
  readonly maxCpuCores: number;
  readonly maxPids: number;
  readonly timeoutMs: number;
}

export interface DockerMountConfig {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

export interface DockerProfile {
  readonly profileId: string;
  readonly image: string;
  readonly imageDigest: string;
  readonly user: string;
  readonly readOnlyRootFilesystem: boolean;
  readonly network: 'none';
  readonly limits: DockerResourceLimits;
  readonly mounts: readonly DockerMountConfig[];
}

export type CanonicalFileKind = 'regular' | 'file' | 'symlink' | 'link' | string;

export interface CanonicalSnapshotEntry {
  readonly path: string;
  readonly kind: 'regular' | 'file' | 'symlink' | 'link' | string;
  readonly content?: string | Uint8Array;
  readonly digest: string;
  readonly linkTarget?: string;
}

export interface CanonicalRepositorySnapshot {
  readonly canonicalRevisionDigest: string;
  readonly entries: readonly CanonicalSnapshotEntry[];
  readonly requiredFiles?: readonly string[];
  readonly exclusionsPolicyVersion?: string;
}

export interface MaterializeViewParams {
  readonly view: CommandView;
  readonly files: Readonly<Record<string, string | Uint8Array>>;
}

export interface DockerLifecycleController {
  readonly provenance: 'mock' | 'real';
  createVolume(volumeId: string): Promise<void>;
  hasVolume(volumeId: string): Promise<boolean>;
  removeVolume(volumeId: string): Promise<void>;
  getCanonicalSnapshot?(workspaceId: string): Promise<CanonicalRepositorySnapshot>;
  materializeView?(params: MaterializeViewParams): Promise<void>;
}

export interface CreateWorkspaceParams {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly initialRevisionDigest: string;
  readonly profile: DockerProfile;
}

export interface ResumeWorkspaceParams {
  readonly workspace: TaskWorkspace;
  readonly profile: DockerProfile;
  readonly expectedRevisionDigest?: string;
}

export interface AdmitCommandViewParams {
  readonly workspaceId: string;
  readonly expectedRevisionDigest?: string;
  readonly canonicalRevisionDigest?: string;
  readonly requiredFiles?: readonly string[];
  readonly exclusionsPolicyVersion?: string;
}

const SHA256_HEX_REGEX = /^sha256:[a-f0-9]{64}$/;
const DANGEROUS_TARGET_RE = /(?:docker\.sock|^\/$|\.ssh|\.aws|\.env|\/etc\/shadow|eval\/uc03\/private|private\/grading|(?:^|\/)private(?:$|\/))/i;
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

export function computeWorkspaceVolumeIds(
  taskId: string,
  workspaceId: string
): { readonly repoVolumeId: string; readonly scratchVolumeId: string } {
  const tupleHash = computeCanonicalSha256([taskId, workspaceId]).slice('sha256:'.length);
  return {
    repoVolumeId: `vol-repo-${tupleHash}`,
    scratchVolumeId: `vol-scratch-${tupleHash}`,
  };
}

export function computeFileDigest(content: string | Buffer | Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function validateUserSpecification(userVal: unknown): ValidationError | null {
  if (typeof userVal !== 'string' || userVal.trim().length === 0) {
    return { path: 'profile.user', message: 'user must be non-root and non-empty string', code: 'NON_ROOT_USER_REQUIRED' };
  }
  const trimmed = userVal.trim();
  if (trimmed === 'root' || trimmed === '0' || trimmed === '0:0') {
    return { path: 'profile.user', message: 'user must be non-root', code: 'NON_ROOT_USER_REQUIRED' };
  }

  const parts = trimmed.split(':');
  if (parts.length > 2) {
    return { path: 'profile.user', message: 'user format must be [user|uid][:group|gid]', code: 'INVALID_USER' };
  }

  const [u, g] = parts;
  if (!u || u.trim().length === 0) {
    return { path: 'profile.user', message: 'user format must not have empty user part', code: 'INVALID_USER' };
  }

  // Validate user/uid part
  if (u.toLowerCase() === 'root') {
    return { path: 'profile.user', message: 'user must be non-root', code: 'NON_ROOT_USER_REQUIRED' };
  }
  if (/^\d+$/.test(u)) {
    if (/^0+$/.test(u)) {
      return { path: 'profile.user', message: 'numeric UID must be non-zero', code: 'NON_ROOT_USER_REQUIRED' };
    }
    const uid = Number(u);
    if (!Number.isSafeInteger(uid) || uid < 1 || uid > 4294967295) {
      return { path: 'profile.user', message: 'numeric UID is out of safe range', code: 'INVALID_USER' };
    }
  } else if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/.test(u)) {
    return { path: 'profile.user', message: `Invalid username format: ${u}`, code: 'INVALID_USER' };
  }

  // Validate group/gid part if specified
  if (g !== undefined) {
    if (g.trim().length === 0) {
      return { path: 'profile.user', message: 'user format must not have empty group part', code: 'INVALID_USER' };
    }
    if (g.toLowerCase() === 'root') {
      return { path: 'profile.user', message: 'group must be non-root', code: 'NON_ROOT_USER_REQUIRED' };
    }
    if (/^\d+$/.test(g)) {
      if (/^0+$/.test(g)) {
        return { path: 'profile.user', message: 'numeric GID must be non-zero', code: 'NON_ROOT_USER_REQUIRED' };
      }
      const gid = Number(g);
      if (!Number.isSafeInteger(gid) || gid < 1 || gid > 4294967295) {
        return { path: 'profile.user', message: 'numeric GID is out of safe range', code: 'INVALID_USER' };
      }
    } else if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/.test(g)) {
      return { path: 'profile.user', message: `Invalid group format: ${g}`, code: 'INVALID_USER' };
    }
  }

  return null;
}

export function validateDockerProfile(input: unknown): ValidationResult<DockerProfile> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ path: 'profile', message: 'Profile must be an object', code: 'INVALID_TYPE' }] };
  }
  const obj = input as Record<string, unknown>;
  const errors: ValidationError[] = [];

  const profileId = typeof obj['profileId'] === 'string' && obj['profileId'].trim() ? obj['profileId'].trim() : undefined;
  if (!profileId) errors.push({ path: 'profile.profileId', message: 'profileId must be a non-empty string', code: 'EMPTY_STRING' });

  const image = typeof obj['image'] === 'string' && obj['image'].trim() ? obj['image'].trim() : undefined;
  if (!image) errors.push({ path: 'profile.image', message: 'image must be a non-empty string', code: 'EMPTY_STRING' });

  const imageDigest = typeof obj['imageDigest'] === 'string' ? obj['imageDigest'].trim() : '';
  if (!SHA256_HEX_REGEX.test(imageDigest)) errors.push({ path: 'profile.imageDigest', message: 'imageDigest must be sha256 hex digest', code: 'IMMUTABLE_IMAGE_DIGEST_REQUIRED' });

  const userError = validateUserSpecification(obj['user']);
  if (userError) {
    errors.push(userError);
  }

  if (obj['readOnlyRootFilesystem'] !== true) errors.push({ path: 'profile.readOnlyRootFilesystem', message: 'readOnlyRootFilesystem must be true', code: 'READONLY_ROOT_REQUIRED' });
  if (obj['network'] !== 'none') errors.push({ path: 'profile.network', message: 'network must be "none"', code: 'NETWORK_NONE_REQUIRED' });

  const limits = obj['limits'];
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
    errors.push({ path: 'profile.limits', message: 'limits must be an object', code: 'INVALID_TYPE' });
  } else {
    const lim = limits as Record<string, unknown>;
    for (const k of ['timeoutMs', 'maxMemoryBytes', 'maxCpuCores', 'maxPids'] as const) {
      const val = lim[k];
      if (typeof val !== 'number' || !Number.isSafeInteger(val) || val <= 0) {
        errors.push({ path: `profile.limits.${k}`, message: `${k} must be a positive safe integer`, code: 'INVALID_LIMIT' });
      }
    }
  }

  const mounts = obj['mounts'];
  const validatedMounts: DockerMountConfig[] = [];
  if (!Array.isArray(mounts)) {
    errors.push({ path: 'profile.mounts', message: 'mounts must be an array', code: 'INVALID_TYPE' });
  } else {
    for (let i = 0; i < mounts.length; i++) {
      const m = mounts[i];
      if (typeof m !== 'object' || m === null || Array.isArray(m)) {
        errors.push({ path: `profile.mounts[${i}]`, message: 'Mount must be an object', code: 'INVALID_MOUNT' });
        continue;
      }
      const mObj = m as Record<string, unknown>;
      const target = typeof mObj['target'] === 'string' ? mObj['target'].trim() : '';
      const source = typeof mObj['source'] === 'string' ? mObj['source'].trim() : '';
      const readOnly = mObj['readOnly'] === true;
      if (!target || !source) {
        errors.push({ path: `profile.mounts[${i}]`, message: 'Mount requires source and target', code: 'INVALID_MOUNT' });
      } else if (DANGEROUS_TARGET_RE.test(target) || DANGEROUS_TARGET_RE.test(source)) {
        errors.push({ path: `profile.mounts[${i}]`, message: `Forbidden mount target or source: target=${target}, source=${source}`, code: 'DANGEROUS_MOUNT_FORBIDDEN' });
      } else if (!readOnly && (target === '/workspace/repo' || source.includes('repo') || source.includes('canonical'))) {
        errors.push({ path: `profile.mounts[${i}].readOnly`, message: 'Canonical repository volume cannot be mounted writable', code: 'READONLY_REPO_MOUNT_REQUIRED' });
      } else {
        validatedMounts.push({ source, target, readOnly });
      }
    }
  }

  if (errors.length > 0 || !profileId || !image || !limits) return { ok: false, errors };
  return { ok: true, value: { profileId, image, imageDigest, user: (obj['user'] as string).trim(), readOnlyRootFilesystem: true, network: 'none', limits: limits as unknown as DockerResourceLimits, mounts: validatedMounts } };
}

export class DockerWorkspaceManager {
  private readonly controller: DockerLifecycleController;
  private readonly workspaces = new Map<string, TaskWorkspace>();
  private readonly canonicalVolumes = new Map<string, { readonly repoVolumeId: string; readonly scratchVolumeId: string }>();
  private readonly canonicalRevisions = new Map<string, string>();
  private readonly activeViews = new Map<string, CommandView>();

  constructor(options: { readonly controller: DockerLifecycleController }) {
    if (!options || typeof options !== 'object' || !options.controller) {
      throw new Error('CONTROLLER_REQUIRED: Injected DockerLifecycleController is required');
    }
    this.controller = options.controller;
  }

  async createWorkspace(params: CreateWorkspaceParams): Promise<TaskWorkspace> {
    if (!params || typeof params !== 'object') {
      throw new Error('INVALID_WORKSPACE_PARAMS: params must be an object');
    }
    const profileRes = validateDockerProfile(params.profile);
    if (!profileRes.ok) throw new Error(`INVALID_DOCKER_PROFILE: ${profileRes.errors.map((e) => e.message).join('; ')}`);

    if (!SHA256_HEX_REGEX.test(params.initialRevisionDigest)) {
      throw new Error('INVALID_REVISION_DIGEST: initialRevisionDigest must be sha256 hex digest');
    }

    const { repoVolumeId, scratchVolumeId } = computeWorkspaceVolumeIds(params.taskId, params.workspaceId);

    const workspace: TaskWorkspace = {
      taskId: params.taskId,
      workspaceId: params.workspaceId,
      containerImageDigest: params.profile.imageDigest,
      repoVolumeId,
      scratchVolumeId,
      expectedRepoState: params.initialRevisionDigest,
    };
    const validWs = validateTaskWorkspace(workspace);
    if (!validWs.ok) throw new Error(`INVALID_TASK_WORKSPACE: ${validWs.errors.map((e) => e.message).join('; ')}`);

    if (this.workspaces.has(params.workspaceId)) {
      throw new Error(`WORKSPACE_ALREADY_EXISTS: Workspace '${params.workspaceId}' already exists; use resumeWorkspace`);
    }

    // Allocate volumes only after full parameter, profile, and workspace validation
    await this.controller.createVolume(repoVolumeId);
    await this.controller.createVolume(scratchVolumeId);

    this.workspaces.set(params.workspaceId, workspace);
    this.canonicalVolumes.set(params.workspaceId, { repoVolumeId, scratchVolumeId });
    this.canonicalRevisions.set(params.workspaceId, params.initialRevisionDigest);
    return workspace;
  }

  async resumeWorkspace(params: ResumeWorkspaceParams): Promise<TaskWorkspace> {
    if (!params || typeof params !== 'object') {
      throw new Error('INVALID_WORKSPACE_PARAMS: params must be an object');
    }
    const validWs = validateTaskWorkspace(params.workspace);
    if (!validWs.ok) throw new Error(`INVALID_TASK_WORKSPACE: ${validWs.errors.map((e) => e.message).join('; ')}`);
    const profileRes = validateDockerProfile(params.profile);
    if (!profileRes.ok) throw new Error(`INVALID_DOCKER_PROFILE: ${profileRes.errors.map((e) => e.message).join('; ')}`);

    if (params.expectedRevisionDigest !== undefined && !SHA256_HEX_REGEX.test(params.expectedRevisionDigest)) {
      throw new Error('INVALID_REVISION_DIGEST: expectedRevisionDigest must be sha256 hex digest');
    }

    if (params.workspace.containerImageDigest !== params.profile.imageDigest) {
      throw new Error(`IMAGE_DIGEST_MISMATCH: ${params.workspace.containerImageDigest} !== ${params.profile.imageDigest}`);
    }

    const expectedVolumeIds = computeWorkspaceVolumeIds(params.workspace.taskId, params.workspace.workspaceId);
    if (
      params.workspace.repoVolumeId !== expectedVolumeIds.repoVolumeId ||
      params.workspace.scratchVolumeId !== expectedVolumeIds.scratchVolumeId
    ) {
      throw new Error('VOLUME_IDENTITY_MISMATCH: Resumed workspace volume identities do not match canonical deterministic volume identities');
    }

    const recordedWs = this.workspaces.get(params.workspace.workspaceId);
    if (recordedWs && recordedWs.taskId !== params.workspace.taskId) {
      throw new Error(`VOLUME_IDENTITY_MISMATCH: Cross-task workspace identity drift detected: taskId '${params.workspace.taskId}' does not match recorded taskId '${recordedWs.taskId}'`);
    }
    const recorded = this.canonicalVolumes.get(params.workspace.workspaceId);
    if (recorded && (recorded.repoVolumeId !== params.workspace.repoVolumeId || recorded.scratchVolumeId !== params.workspace.scratchVolumeId)) {
      throw new Error('VOLUME_IDENTITY_MISMATCH: Resumed workspace volume identities do not match canonical recorded volumes');
    }
    if (!(await this.controller.hasVolume(params.workspace.repoVolumeId)) || !(await this.controller.hasVolume(params.workspace.scratchVolumeId))) {
      throw new Error('VOLUME_NOT_FOUND: Workspace volumes missing in lifecycle controller');
    }
    if (params.expectedRevisionDigest !== undefined && params.workspace.expectedRepoState !== params.expectedRevisionDigest) {
      throw new Error('REVISION_MISMATCH: Workspace repo state does not match expected revision');
    }

    const currentRev = this.canonicalRevisions.get(params.workspace.workspaceId);
    if (currentRev && currentRev !== params.workspace.expectedRepoState) this.invalidateViews(params.workspace.workspaceId);

    this.workspaces.set(params.workspace.workspaceId, params.workspace);
    this.canonicalVolumes.set(params.workspace.workspaceId, { repoVolumeId: params.workspace.repoVolumeId, scratchVolumeId: params.workspace.scratchVolumeId });
    this.canonicalRevisions.set(params.workspace.workspaceId, params.workspace.expectedRepoState);
    return params.workspace;
  }

  setCanonicalRevision(workspaceId: string, newRevisionDigest: string): void {
    this.canonicalRevisions.set(workspaceId, newRevisionDigest);
    this.invalidateViews(workspaceId);
  }

  invalidateViews(workspaceId: string): void {
    this.activeViews.delete(workspaceId);
  }

  getActiveCommandView(workspaceId: string): CommandView | null {
    const view = this.activeViews.get(workspaceId);
    if (!view) return null;
    const currentRev = this.canonicalRevisions.get(workspaceId);
    if (currentRev && view.canonicalRevisionDigest !== currentRev) {
      this.activeViews.delete(workspaceId);
      return null;
    }
    return view;
  }

  async admitCommandView(params: AdmitCommandViewParams): Promise<CommandView> {
    if (!params || typeof params !== 'object') {
      throw new Error('INVALID_ADMIT_PARAMS: params must be an object');
    }
    if (!params.workspaceId || typeof params.workspaceId !== 'string') {
      throw new Error('INVALID_WORKSPACE_ID: workspaceId must be a non-empty string');
    }

    const workspace = this.workspaces.get(params.workspaceId);
    if (!workspace) throw new Error(`WORKSPACE_NOT_FOUND: Workspace '${params.workspaceId}' not found`);

    const initialRev = this.canonicalRevisions.get(params.workspaceId) ?? workspace.expectedRepoState;

    // Caller self-authorized files are rejected / ignored; controller is sole authority.
    const requestedRev = params.expectedRevisionDigest ?? params.canonicalRevisionDigest;
    if (requestedRev !== undefined && requestedRev !== initialRev) {
      throw new Error(`STALE_COMMAND_VIEW: Requested revision ${requestedRev} does not match current canonical revision ${initialRev}`);
    }

    // Missing controller snapshot/materializer fails closed
    if (typeof this.controller.getCanonicalSnapshot !== 'function') {
      throw new Error('CONTROLLER_SNAPSHOT_METHOD_REQUIRED: Injected controller missing getCanonicalSnapshot method');
    }
    if (typeof this.controller.materializeView !== 'function') {
      throw new Error('CONTROLLER_MATERIALIZE_METHOD_REQUIRED: Injected controller missing materializeView method');
    }

    // Call trusted controller snapshot
    const snapshot = await this.controller.getCanonicalSnapshot(params.workspaceId);
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
    await this.controller.materializeView({
      view: commandView,
      files: Object.freeze({ ...permittedBytes }),
    });

    // Verify change during snapshot/materialization rejects view
    const revAfter = this.canonicalRevisions.get(params.workspaceId);
    if (revAfter !== initialRev) {
      this.activeViews.delete(params.workspaceId);
      throw new Error(`CANONICAL_REVISION_CHANGED: Canonical revision changed during snapshot/materialization from ${initialRev} to ${revAfter}`);
    }

    this.activeViews.set(params.workspaceId, commandView);
    return commandView;
  }
}
