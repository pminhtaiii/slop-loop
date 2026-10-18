/**
 * UC-03 Phase 3 - Docker Workspace Identity, Lifecycle, and Command-View Admission
 *
 * Owned path: src/foundation/docker-workspace.ts
 * Feature: specs/001-verified-code-repair (Slice A of T006)
 *
 * Enforces interfaces.md repository-command view and Docker workspace boundary:
 * - Finite profile validation (non-root, read-only root, network none, safe mounts).
 * - Prepared immutable image identity and stable canonical volume identity on resume.
 * - Command-view admission excludes protected paths/content before copying.
 * - Rejects required source containing protected content (no silent redaction).
 * - Byte-identical admitted source/tests mounted read-only; changed revision invalidates views.
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

export function computeFileDigest(content: string | Buffer): string {
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

export interface DockerLifecycleController {
  readonly provenance: 'mock' | 'real';
  createVolume(volumeId: string): Promise<void>;
  hasVolume(volumeId: string): Promise<boolean>;
  removeVolume(volumeId: string): Promise<void>;
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
  readonly canonicalRevisionDigest: string;
  readonly canonicalFiles: Readonly<Record<string, string>>;
  readonly requiredFiles?: readonly string[];
  readonly exclusionsPolicyVersion?: string;
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

    const repoVolumeId = `vol-repo-${params.taskId}-${params.workspaceId}`;
    const scratchVolumeId = `vol-scratch-${params.taskId}-${params.workspaceId}`;

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
    const workspace = this.workspaces.get(params.workspaceId);
    if (!workspace) throw new Error(`WORKSPACE_NOT_FOUND: Workspace '${params.workspaceId}' not found`);

    const currentRev = this.canonicalRevisions.get(params.workspaceId) ?? workspace.expectedRepoState;
    if (params.canonicalRevisionDigest !== currentRev) {
      throw new Error(`STALE_COMMAND_VIEW: Requested revision ${params.canonicalRevisionDigest} does not match current canonical revision ${currentRev}`);
    }

    const exclusionsPolicyVersion = params.exclusionsPolicyVersion ?? '0.1.0';
    const required = new Set(params.requiredFiles ?? []);
    const admittedFiles: AdmittedFile[] = [];
    const trustedFileDigests: Record<string, string> = {};
    const excludedFiles = new Set<string>();

    for (const [filePath, content] of Object.entries(params.canonicalFiles)) {
      if (!isCanonicalRelativePath(filePath)) throw new Error(`WORKSPACE_ESCAPE: Path '${filePath}' is not a canonical relative path`);
      const protectedPath = isProtectedPath(filePath);
      const protectedContent = containsProtectedContent(content);

      if (protectedPath || protectedContent) {
        if (required.has(filePath)) {
          if (protectedPath) throw new Error(`PROTECTED_PATH_FORBIDDEN: Required check file '${filePath}' is a protected path and cannot be admitted`);
          throw new Error(`REQUIRED_FILE_CONTAINS_PROTECTED_CONTENT: Required check file '${filePath}' contains protected content and cannot be silently redacted`);
        }
        excludedFiles.add(filePath);
        continue;
      }

      const digest = computeFileDigest(content);
      admittedFiles.push({ path: filePath, digest });
      trustedFileDigests[filePath] = digest;
    }

    for (const reqPath of required) {
      if (excludedFiles.has(reqPath) || !(reqPath in params.canonicalFiles)) {
        throw new Error(`REQUIRED_FILE_EXCLUDED: Required check depends on excluded or missing file: '${reqPath}'`);
      }
    }
    if (admittedFiles.length === 0) throw new Error('EMPTY_ADMITTED_FILES: No permitted files admitted to command view');

    admittedFiles.sort((a, b) => a.path.localeCompare(b.path));
    const viewId = `view-${params.workspaceId}-${createHash('sha256').update(params.canonicalRevisionDigest).digest('hex').slice(0, 12)}`;
    const partialView = {
      viewId,
      taskId: workspace.taskId,
      workspaceId: params.workspaceId,
      canonicalRevisionDigest: params.canonicalRevisionDigest,
      admittedFiles,
      exclusionsPolicyVersion,
      scratchIdentity: workspace.scratchVolumeId,
      mountedReadOnly: true as const,
    };
    const viewDigest = computeCommandViewDigest(partialView);
    const commandView: CommandView = { ...partialView, viewDigest };

    const validation = validateCommandView(commandView, {
      currentCanonicalRevisionDigest: params.canonicalRevisionDigest,
      currentExclusionsPolicyVersion: exclusionsPolicyVersion,
      expectedViewDigest: viewDigest,
      trustedFileDigests,
    });
    if (!validation.ok) throw new Error(`INVALID_COMMAND_VIEW: ${validation.errors.map((e) => e.message).join('; ')}`);

    this.activeViews.set(params.workspaceId, commandView);
    return commandView;
  }
}
