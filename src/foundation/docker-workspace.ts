/**
 * UC-03 Phase 3 - Docker Workspace Identity, Lifecycle, and Command-View Admission
 *
 * Owned path: src/foundation/docker-workspace.ts
 * Feature: specs/001-verified-code-repair (Slice B of T006)
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
 * - Structured command executor through required injected Docker controller spy only.
 * - Exact narrow container execution plan: non-root, read-only root, network none, drop capabilities, no-new-privileges.
 * - Exact immutable view volume mounted RO at /workspace/repo and scratch only writable at /workspace/scratch.
 * - Canonical repository volume never accessible to command execution containers.
 * - Command view freshness enforced before and after await; repository drift invalidates views.
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
  type ExecutionLimits,
  type RunCommandAction,
  computeCanonicalSha256,
  computeCommandViewDigest,
  isCanonicalRelativePath,
  isProtectedPath,
  validateCommandView,
  validateTaskWorkspace,
  validateExecutionLimits,
  validateNormalizedAction,
} from '../contracts/uc03.ts';

export interface DockerResourceLimits {
  readonly maxMemoryBytes: number;
  readonly maxCpuCores: number;
  readonly maxPids: number;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number | undefined;
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

export interface DockerContainerPlan {
  readonly image: string;
  readonly imageDigest: string;
  readonly user: string;
  readonly readOnlyRootFilesystem: true;
  readonly network: 'none';
  readonly dropCapabilities: readonly string[];
  readonly noNewPrivileges: true;
  readonly mounts: readonly DockerMountConfig[];
  readonly executable: string;
  readonly argv: readonly string[];
  readonly workingDirectory: string;
  readonly env: Readonly<Record<string, string>>;
  readonly limits: ExecutionLimits;
}

export interface ContainerExecutionOutput {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface StructuredExecutionResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly outcome: 'success' | 'failure' | 'timeout' | 'error';
  readonly plan: DockerContainerPlan;
  readonly truncated: boolean;
}

export interface ExecuteCommandParams {
  readonly workspaceId: string;
  readonly action?: RunCommandAction | undefined;
  readonly executable?: string | undefined;
  readonly argv?: readonly string[] | undefined;
  readonly workingDirectory?: string | undefined;
  readonly limits: ExecutionLimits;
  readonly view?: CommandView | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly profile?: DockerProfile | undefined;
}

export interface DockerLifecycleController {
  readonly provenance: 'mock' | 'real';
  createVolume(volumeId: string): Promise<void>;
  hasVolume(volumeId: string): Promise<boolean>;
  removeVolume(volumeId: string): Promise<void>;
  getCanonicalSnapshot?(workspaceId: string): Promise<CanonicalRepositorySnapshot>;
  materializeView?(params: MaterializeViewParams): Promise<void>;
  executeContainer?(plan: DockerContainerPlan): Promise<ContainerExecutionOutput>;
  executePlan?(plan: DockerContainerPlan): Promise<ContainerExecutionOutput>;
  cleanup?(): Promise<void> | void;
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

export interface DockerEnvironmentPolicy {
  readonly allowedKeys?: readonly string[] | ReadonlySet<string> | undefined;
}

const PRIVATE_IMMUTABLE_CONTAINER_ENV_KEYS: readonly string[] = Object.freeze([
  'PYTHONPATH',
  'PYTHONDONTWRITEBYTECODE',
  'PYTHONUNBUFFERED',
  'TMPDIR',
  'HOME',
  'PATH',
]);

const PRIVATE_IMMUTABLE_CONTAINER_ENV_KEY_SET: ReadonlySet<string> = new Set(
  PRIVATE_IMMUTABLE_CONTAINER_ENV_KEYS
);

export const IMMUTABLE_CONTAINER_ENV_KEYS: ReadonlySet<string> = Object.freeze(
  new Set(PRIVATE_IMMUTABLE_CONTAINER_ENV_KEYS)
);

const LOADER_HOOK_RE = /^(?:LD_|DYLD_|PYTHON|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|PERL5|RUBY|BASH_ENV|ENV$|PROMPT_COMMAND)/i;

export function isLoaderHook(key: string): boolean {
  if (typeof key !== 'string') return false;
  return LOADER_HOOK_RE.test(key.trim());
}

export function isImmutableEnvKey(key: string): boolean {
  if (typeof key !== 'string') return false;
  return PRIVATE_IMMUTABLE_CONTAINER_ENV_KEY_SET.has(key.trim());
}

export const ALLOWED_EXECUTABLES: ReadonlySet<string> = new Set(['pytest', 'python', 'python3']);

const PRIVATE_DEFAULT_CONTAINER_ENV: Readonly<Record<string, string>> = Object.freeze({
  PYTHONPATH: '/workspace/repo',
  PYTHONDONTWRITEBYTECODE: '1',
  PYTHONUNBUFFERED: '1',
  TMPDIR: '/workspace/scratch',
  HOME: '/workspace/scratch',
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
});

export const DEFAULT_CONTAINER_ENV: Readonly<Record<string, string>> = Object.freeze({
  ...PRIVATE_DEFAULT_CONTAINER_ENV,
});

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

const SHELL_METACHARS_RE = /[;&|><`$\r\n]/;
const FORBIDDEN_ENV_KEYS = /(?:TOKEN|SECRET|KEY|PASSWORD|AUTH|CREDENTIAL|API|AWS|GITHUB|OPENAI|ANTHROPIC|GEMINI)/i;

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
    if (lim['maxOutputBytes'] !== undefined) {
      const val = lim['maxOutputBytes'];
      if (typeof val !== 'number' || !Number.isSafeInteger(val) || val <= 0) {
        errors.push({ path: 'profile.limits.maxOutputBytes', message: 'maxOutputBytes must be a positive safe integer', code: 'INVALID_LIMIT' });
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
      } else if (target !== '/workspace/repo' && target !== '/workspace/scratch') {
        errors.push({ path: `profile.mounts[${i}].target`, message: `Arbitrary mount target forbidden: ${target}`, code: 'ARBITRARY_MOUNT_TARGET_FORBIDDEN' });
      } else if (source.startsWith('/') || source.startsWith('\\') || /^[a-zA-Z]:/.test(source) || source.startsWith('.') || source.includes('..') || source.includes('~')) {
        errors.push({ path: `profile.mounts[${i}].source`, message: `Host bind mount forbidden: ${source}`, code: 'HOST_BIND_MOUNT_FORBIDDEN' });
      } else if (target === '/workspace/scratch' && readOnly) {
        errors.push({ path: `profile.mounts[${i}].readOnly`, message: 'Scratch volume must be mounted writable', code: 'WRITABLE_SCRATCH_MOUNT_REQUIRED' });
      } else if (target === '/workspace/scratch' && (source.includes('repo') || source.includes('canonical'))) {
        errors.push({ path: `profile.mounts[${i}].source`, message: 'Canonical repository volume cannot be mounted at scratch', code: 'READONLY_REPO_MOUNT_REQUIRED' });
      } else {
        validatedMounts.push({ source, target, readOnly });
      }
    }
    const seenTargets = new Set<string>();
    for (const m of validatedMounts) {
      if (seenTargets.has(m.target)) {
        errors.push({ path: 'profile.mounts', message: `Duplicate mount target forbidden: ${m.target}`, code: 'DUPLICATE_MOUNT_TARGET_FORBIDDEN' });
      }
      seenTargets.add(m.target);
    }
  }

  if (errors.length > 0 || !profileId || !image || !limits) return { ok: false, errors };
  const limObj = limits as Record<string, unknown>;
  const validatedLimits: DockerResourceLimits = {
    timeoutMs: limObj['timeoutMs'] as number,
    maxMemoryBytes: limObj['maxMemoryBytes'] as number,
    maxCpuCores: limObj['maxCpuCores'] as number,
    maxPids: limObj['maxPids'] as number,
    ...(limObj['maxOutputBytes'] !== undefined
      ? { maxOutputBytes: limObj['maxOutputBytes'] as number }
      : {}),
  };
  return { ok: true, value: { profileId, image, imageDigest, user: (obj['user'] as string).trim(), readOnlyRootFilesystem: true, network: 'none', limits: validatedLimits, mounts: validatedMounts } };
}

export function truncateUtf8(
  str: string,
  maxBytes: number
): { readonly text: string; readonly byteLength: number; readonly truncated: boolean } {
  const canonical = str.toWellFormed();
  if (maxBytes <= 0) {
    return { text: '', byteLength: 0, truncated: canonical.length > 0 };
  }
  const totalBytes = Buffer.byteLength(canonical, 'utf8');
  if (totalBytes <= maxBytes) {
    return { text: canonical, byteLength: totalBytes, truncated: false };
  }

  let accumulatedText = '';
  let accumulatedBytes = 0;

  for (const codePoint of canonical) {
    const cpBytes = Buffer.byteLength(codePoint, 'utf8');
    if (accumulatedBytes + cpBytes > maxBytes) {
      return {
        text: accumulatedText,
        byteLength: accumulatedBytes,
        truncated: true,
      };
    }
    accumulatedText += codePoint;
    accumulatedBytes += cpBytes;
  }

  return {
    text: accumulatedText,
    byteLength: accumulatedBytes,
    truncated: true,
  };
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

  getCanonicalRevision(workspaceId: string): string | undefined {
    return this.canonicalRevisions.get(workspaceId);
  }

  getWorkspace(workspaceId: string): TaskWorkspace | undefined {
    return this.workspaces.get(workspaceId);
  }

  getController(): DockerLifecycleController {
    return this.controller;
  }

  createCommandExecutor(
    profile?: DockerProfile,
    environmentPolicy?:
      | DockerEnvironmentPolicy
      | readonly string[]
      | ReadonlySet<string>
      | {
          readonly environmentPolicy?: DockerEnvironmentPolicy | undefined;
          readonly allowedEnvKeys?: readonly string[] | ReadonlySet<string> | undefined;
        }
  ): StructuredCommandExecutor {
    let resolvedPolicy: DockerEnvironmentPolicy | readonly string[] | ReadonlySet<string> | undefined;
    let resolvedAllowedKeys: readonly string[] | ReadonlySet<string> | undefined;

    if (environmentPolicy !== undefined) {
      if (
        typeof environmentPolicy === 'object' &&
        environmentPolicy !== null &&
        !(environmentPolicy instanceof Set) &&
        !Array.isArray(environmentPolicy) &&
        ('environmentPolicy' in environmentPolicy || 'allowedEnvKeys' in environmentPolicy)
      ) {
        resolvedPolicy = environmentPolicy.environmentPolicy;
        resolvedAllowedKeys = environmentPolicy.allowedEnvKeys;
      } else {
        resolvedPolicy = environmentPolicy as DockerEnvironmentPolicy | readonly string[] | ReadonlySet<string>;
      }
    }

    return new StructuredCommandExecutor({
      manager: this,
      controller: this.controller,
      profile,
      environmentPolicy: resolvedPolicy,
      allowedEnvKeys: resolvedAllowedKeys,
    });
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

export interface StructuredCommandExecutorOptions {
  readonly manager: DockerWorkspaceManager;
  readonly controller?: DockerLifecycleController | undefined;
  readonly profile?: DockerProfile | undefined;
  readonly environmentPolicy?: DockerEnvironmentPolicy | readonly string[] | ReadonlySet<string> | undefined;
  readonly allowedEnvKeys?: readonly string[] | ReadonlySet<string> | undefined;
}

export class StructuredCommandExecutor {
  private readonly manager: DockerWorkspaceManager;
  private readonly controller: DockerLifecycleController;
  private readonly trustedProfile?: DockerProfile | undefined;
  private readonly allowedEnvKeys: ReadonlySet<string>;

  constructor(options: StructuredCommandExecutorOptions) {
    if (!options || typeof options !== 'object' || !options.manager) {
      throw new Error('MANAGER_REQUIRED: DockerWorkspaceManager is required for StructuredCommandExecutor');
    }
    this.manager = options.manager;
    this.controller = options.controller ?? options.manager.getController();
    if (!this.controller) {
      throw new Error('CONTROLLER_REQUIRED: Injected DockerLifecycleController is required');
    }

    let rawAllowed: unknown;
    if (options.environmentPolicy !== undefined) {
      if (Array.isArray(options.environmentPolicy) || options.environmentPolicy instanceof Set) {
        rawAllowed = options.environmentPolicy;
      } else if (typeof options.environmentPolicy === 'object' && options.environmentPolicy !== null) {
        rawAllowed = (options.environmentPolicy as DockerEnvironmentPolicy).allowedKeys;
      } else {
        throw new Error('INVALID_ENVIRONMENT_POLICY: environmentPolicy must be an object or collection of allowed keys');
      }
    } else if (options.allowedEnvKeys !== undefined) {
      rawAllowed = options.allowedEnvKeys;
    }

    if (rawAllowed !== undefined) {
      if (!Array.isArray(rawAllowed) && !(rawAllowed instanceof Set)) {
        throw new Error('INVALID_ENVIRONMENT_POLICY: allowedKeys must be an array or Set of strings');
      }
      const validatedSet = new Set<string>();
      for (const item of rawAllowed) {
        if (typeof item !== 'string' || item.trim().length === 0) {
          throw new Error('INVALID_ENVIRONMENT_POLICY: Environment key must be a non-empty string');
        }
        const key = item.trim();
        if (isImmutableEnvKey(key)) {
          throw new Error(`INVALID_ENVIRONMENT_POLICY: Cannot allowlist immutable runtime environment variable '${key}'`);
        }
        if (isLoaderHook(key)) {
          throw new Error(`INVALID_ENVIRONMENT_POLICY: Cannot allowlist loader/interpreter hook variable '${key}'`);
        }
        if (FORBIDDEN_ENV_KEYS.test(key)) {
          throw new Error(`INVALID_ENVIRONMENT_POLICY: Cannot allowlist forbidden secret or credential pattern '${key}'`);
        }
        validatedSet.add(key);
      }
      this.allowedEnvKeys = Object.freeze(validatedSet);
    } else {
      this.allowedEnvKeys = Object.freeze(new Set<string>());
    }
    if (options.profile !== undefined) {
      const profileRes = validateDockerProfile(options.profile);
      if (!profileRes.ok) {
        throw new Error(`INVALID_DOCKER_PROFILE: ${profileRes.errors.map((e) => e.message).join('; ')}`);
      }
      const val = profileRes.value;
      const trustedLimits: DockerResourceLimits = Object.freeze({
        timeoutMs: val.limits.timeoutMs,
        maxMemoryBytes: val.limits.maxMemoryBytes,
        maxCpuCores: val.limits.maxCpuCores,
        maxPids: val.limits.maxPids,
        ...(val.limits.maxOutputBytes !== undefined
          ? { maxOutputBytes: val.limits.maxOutputBytes }
          : {}),
      });

      const trustedMounts: readonly DockerMountConfig[] = Object.freeze(
        val.mounts.map((m) =>
          Object.freeze({
            source: m.source,
            target: m.target,
            readOnly: m.readOnly,
          })
        )
      );

      this.trustedProfile = Object.freeze({
        profileId: val.profileId,
        image: val.image,
        imageDigest: val.imageDigest,
        user: val.user,
        readOnlyRootFilesystem: true,
        network: 'none' as const,
        limits: trustedLimits,
        mounts: trustedMounts,
      });
    }
  }

  async execute(params: ExecuteCommandParams): Promise<StructuredExecutionResult> {
    if (!params || typeof params !== 'object') {
      throw new Error('INVALID_EXECUTE_PARAMS: params must be an object');
    }
    if (!params.workspaceId || typeof params.workspaceId !== 'string') {
      throw new Error('INVALID_WORKSPACE_ID: workspaceId must be a non-empty string');
    }

    // Check command view freshness BEFORE dispatch
    const activeView = this.manager.getActiveCommandView(params.workspaceId);
    if (!activeView) {
      throw new Error(`COMMAND_VIEW_REQUIRED: No active admitted command view for workspace '${params.workspaceId}'`);
    }
    if (activeView.mountedReadOnly !== true) {
      throw new Error('COMMAND_VIEW_NOT_READONLY: Admitted command view must be mounted read-only');
    }
    const currentRev = this.manager.getCanonicalRevision(params.workspaceId);
    if (!currentRev || activeView.canonicalRevisionDigest !== currentRev) {
      throw new Error(`STALE_COMMAND_VIEW: Active view revision '${activeView.canonicalRevisionDigest}' does not match canonical revision '${currentRev}'`);
    }
    if (params.view) {
      if (
        params.view.viewId !== activeView.viewId ||
        params.view.viewDigest !== activeView.viewDigest ||
        params.view.canonicalRevisionDigest !== activeView.canonicalRevisionDigest
      ) {
        throw new Error(`STALE_COMMAND_VIEW: Supplied view does not match current admitted command view for workspace '${params.workspaceId}'`);
      }
    }

    const workspace = this.manager.getWorkspace(params.workspaceId);
    if (!workspace) {
      throw new Error(`WORKSPACE_NOT_FOUND: Workspace '${params.workspaceId}' not found`);
    }

    // Absent constructor authority must deny even if command supplies a plausible profile
    if (!this.trustedProfile) {
      throw new Error(
        `PROFILE_REQUIRED: Trusted constructor DockerProfile is required for command execution on workspace '${params.workspaceId}'`
      );
    }
    const trustedProfile = this.trustedProfile;

    // Reject command-level profile overrides or modifications; accept only exact trusted equivalent if provided
    if (params.profile !== undefined) {
      const candidateRes = validateDockerProfile(params.profile);
      if (!candidateRes.ok) {
        throw new Error(`INVALID_DOCKER_PROFILE: ${candidateRes.errors.map((e) => e.message).join('; ')}`);
      }
      const p = candidateRes.value;
      const isExactMatch =
        p.profileId === trustedProfile.profileId &&
        p.image === trustedProfile.image &&
        p.imageDigest === trustedProfile.imageDigest &&
        p.user === trustedProfile.user &&
        p.readOnlyRootFilesystem === trustedProfile.readOnlyRootFilesystem &&
        p.network === trustedProfile.network &&
        p.limits.timeoutMs === trustedProfile.limits.timeoutMs &&
        p.limits.maxMemoryBytes === trustedProfile.limits.maxMemoryBytes &&
        p.limits.maxCpuCores === trustedProfile.limits.maxCpuCores &&
        p.limits.maxPids === trustedProfile.limits.maxPids &&
        p.limits.maxOutputBytes === trustedProfile.limits.maxOutputBytes &&
        p.mounts.length === trustedProfile.mounts.length &&
        p.mounts.every((m, idx) => {
          const tm = trustedProfile.mounts[idx];
          return (
            tm !== undefined &&
            m.source === tm.source &&
            m.target === tm.target &&
            m.readOnly === tm.readOnly
          );
        });

      if (!isExactMatch) {
        throw new Error(
          `COMMAND_PROFILE_OVERRIDE_FORBIDDEN: Command-supplied profile cannot override or differ from trusted constructor profile`
        );
      }
    }

    // Enforce workspace canonical image identity authority
    if (trustedProfile.imageDigest !== workspace.containerImageDigest) {
      throw new Error(`IMAGE_DIGEST_MISMATCH: Profile image digest '${trustedProfile.imageDigest}' does not match canonical workspace image digest '${workspace.containerImageDigest}'`);
    }

    // Resolve action
    let action: RunCommandAction;
    if (params.action) {
      const validAction = validateNormalizedAction(params.action);
      if (!validAction.ok || validAction.value.kind !== 'run_command') {
        throw new Error(`INVALID_COMMAND_ACTION: ${validAction.ok ? 'Action must be run_command' : validAction.errors.map((e) => e.message).join('; ')}`);
      }
      action = validAction.value;
    } else if (params.executable) {
      const constructed = {
        actionId: `act-exec-${Date.now()}`,
        kind: 'run_command',
        executable: params.executable,
        argv: params.argv ?? [],
        workingDirectory: params.workingDirectory ?? '/workspace/repo',
      };
      const validAction = validateNormalizedAction(constructed);
      if (!validAction.ok || validAction.value.kind !== 'run_command') {
        throw new Error(`INVALID_COMMAND_ACTION: ${validAction.ok ? 'Action must be run_command' : validAction.errors.map((e) => e.message).join('; ')}`);
      }
      action = validAction.value;
    } else {
      throw new Error('COMMAND_ACTION_REQUIRED: action or executable must be provided');
    }

    // Validate limits
    const validLimits = validateExecutionLimits(params.limits);
    if (!validLimits.ok) {
      throw new Error(`INVALID_EXECUTION_LIMITS: ${validLimits.errors.map((e) => e.message).join('; ')}`);
    }
    const limits: ExecutionLimits = Object.freeze({
      timeoutMs: validLimits.value.timeoutMs,
      maxOutputBytes: validLimits.value.maxOutputBytes,
      maxCpuCores: validLimits.value.maxCpuCores,
      maxMemoryBytes: validLimits.value.maxMemoryBytes,
      maxPids: validLimits.value.maxPids,
    });

    // Validate per-command resource limits against profile ceilings
    if (limits.maxCpuCores > trustedProfile.limits.maxCpuCores) {
      throw new Error(`RESOURCE_LIMIT_EXCEEDS_PROFILE_CEILING: Command maxCpuCores (${limits.maxCpuCores}) exceeds profile ceiling (${trustedProfile.limits.maxCpuCores})`);
    }
    if (limits.maxMemoryBytes > trustedProfile.limits.maxMemoryBytes) {
      throw new Error(`RESOURCE_LIMIT_EXCEEDS_PROFILE_CEILING: Command maxMemoryBytes (${limits.maxMemoryBytes}) exceeds profile ceiling (${trustedProfile.limits.maxMemoryBytes})`);
    }
    if (limits.maxPids > trustedProfile.limits.maxPids) {
      throw new Error(`RESOURCE_LIMIT_EXCEEDS_PROFILE_CEILING: Command maxPids (${limits.maxPids}) exceeds profile ceiling (${trustedProfile.limits.maxPids})`);
    }
    if (limits.timeoutMs > trustedProfile.limits.timeoutMs) {
      throw new Error(`RESOURCE_LIMIT_EXCEEDS_PROFILE_CEILING: Command timeoutMs (${limits.timeoutMs}) exceeds profile ceiling (${trustedProfile.limits.timeoutMs})`);
    }
    if (trustedProfile.limits.maxOutputBytes !== undefined && limits.maxOutputBytes > trustedProfile.limits.maxOutputBytes) {
      throw new Error(`RESOURCE_LIMIT_EXCEEDS_PROFILE_CEILING: Command maxOutputBytes (${limits.maxOutputBytes}) exceeds profile ceiling (${trustedProfile.limits.maxOutputBytes})`);
    }

    // Check allowlisted executable
    if (!ALLOWED_EXECUTABLES.has(action.executable)) {
      throw new Error(`DISALLOWED_EXECUTABLE: Executable '${action.executable}' is not in allowed executable set (${Array.from(ALLOWED_EXECUTABLES).join(', ')})`);
    }

    // Check argv without shell
    for (let i = 0; i < action.argv.length; i++) {
      const arg = action.argv[i];
      if (typeof arg !== 'string' || SHELL_METACHARS_RE.test(arg)) {
        throw new Error(`FORBIDDEN_SHELL_CHARACTERS: Argument at index ${i} contains forbidden shell characters`);
      }
    }

    // Check working directory
    const wd = action.workingDirectory;
    if (wd !== '/workspace/repo' && wd !== '/workspace/scratch' && !wd.startsWith('/workspace/repo/') && !wd.startsWith('/workspace/scratch/')) {
      throw new Error(`INVALID_WORKING_DIRECTORY: workingDirectory '${wd}' must be within /workspace/repo or /workspace/scratch`);
    }

    // Minimal configured environment; zero provider/host inheritance
    const mergedEnv: Record<string, string> = { ...PRIVATE_DEFAULT_CONTAINER_ENV };
    if (params.env) {
      if (typeof params.env !== 'object' || Array.isArray(params.env)) {
        throw new Error('INVALID_ENVIRONMENT: env must be an object');
      }
      const envEntries = Object.entries(params.env);
      for (const [k, v] of envEntries) {
        if (typeof v !== 'string') {
          throw new Error(`INVALID_ENVIRONMENT: Environment variable '${k}' must be a string`);
        }
        if (FORBIDDEN_ENV_KEYS.test(k) || containsProtectedContent(v)) {
          throw new Error(`FORBIDDEN_ENVIRONMENT_VARIABLE: Environment variable '${k}' contains forbidden secret or credential pattern`);
        }
        if (isImmutableEnvKey(k)) {
          throw new Error(`IMMUTABLE_ENVIRONMENT_OVERRIDE_FORBIDDEN: Overriding immutable runtime environment variable '${k}' is forbidden: ${k}`);
        }
        if (isLoaderHook(k)) {
          throw new Error(`LOADER_HOOK_FORBIDDEN: Loader and interpreter hook variable '${k}' is forbidden`);
        }
        if (!this.allowedEnvKeys.has(k)) {
          throw new Error(`DISALLOWED_ENVIRONMENT_VARIABLE: Environment variable '${k}' is not permitted by host environment policy`);
        }
        mergedEnv[k] = v;
      }
    }

    // Generate narrow container plan: immutable view mounted RO, scratch only writable, canonical repo never accessible
    const planMounts: readonly DockerMountConfig[] = Object.freeze([
      {
        source: activeView.viewId,
        target: '/workspace/repo',
        readOnly: true,
      },
      {
        source: activeView.scratchIdentity,
        target: '/workspace/scratch',
        readOnly: false,
      },
    ]);

    const plan: DockerContainerPlan = {
      image: trustedProfile.image,
      imageDigest: trustedProfile.imageDigest,
      user: trustedProfile.user,
      readOnlyRootFilesystem: true,
      network: 'none',
      dropCapabilities: Object.freeze(['ALL']),
      noNewPrivileges: true,
      mounts: planMounts,
      executable: action.executable,
      argv: Object.freeze([...action.argv]),
      workingDirectory: action.workingDirectory,
      env: Object.freeze(mergedEnv),
      limits,
    };

    const execFn = this.controller.executeContainer ?? this.controller.executePlan;
    if (typeof execFn !== 'function') {
      throw new Error('CONTROLLER_EXECUTE_METHOD_REQUIRED: Injected controller missing executeContainer method');
    }

    // Dispatch to trusted controller with cleanup in finally on rejection
    let rawOutput: unknown;
    try {
      rawOutput = await execFn.call(this.controller, plan);
    } finally {
      if (typeof this.controller.cleanup === 'function') {
        await this.controller.cleanup();
      }
    }

    // Enforce command view and workspace freshness AGAIN AFTER await; repo or workspace change invalidates cached views
    const activeViewAfter = this.manager.getActiveCommandView(params.workspaceId);
    const revAfter = this.manager.getCanonicalRevision(params.workspaceId);
    const wsAfter = this.manager.getWorkspace(params.workspaceId);
    if (
      !activeViewAfter ||
      activeViewAfter.viewDigest !== activeView.viewDigest ||
      revAfter !== activeView.canonicalRevisionDigest ||
      !wsAfter ||
      wsAfter.containerImageDigest !== workspace.containerImageDigest
    ) {
      this.manager.invalidateViews(params.workspaceId);
      throw new Error(`CANONICAL_REVISION_CHANGED: Canonical repository or workspace changed during command execution from '${activeView.canonicalRevisionDigest}' to '${revAfter}'`);
    }

    // Validate raw injected controller result at runtime: fail closed on malformed data
    if (typeof rawOutput !== 'object' || rawOutput === null || Array.isArray(rawOutput)) {
      throw new Error('INVALID_CONTROLLER_OUTPUT: Controller returned malformed output record (expected object)');
    }

    const rawObj = rawOutput as Record<string, unknown>;

    // Snapshot each raw controller field ONCE into detached local values before validation and use (prevents getter TOCTOU)
    const rawTimedOut: unknown = rawObj['timedOut'];
    const rawDuration: unknown = rawObj['durationMs'];
    const rawStdout: unknown = rawObj['stdout'];
    const rawStderr: unknown = rawObj['stderr'];
    const rawExitCode: unknown = rawObj['exitCode'];

    if (typeof rawTimedOut !== 'boolean') {
      throw new Error('INVALID_CONTROLLER_OUTPUT: Controller output timedOut must be a boolean');
    }
    const timedOut = rawTimedOut;

    if (
      typeof rawDuration !== 'number' ||
      !Number.isFinite(rawDuration) ||
      Number.isNaN(rawDuration) ||
      rawDuration < 0
    ) {
      throw new Error('INVALID_CONTROLLER_OUTPUT: Controller output durationMs must be a finite non-negative number');
    }
    const durationMs = rawDuration;

    if (typeof rawStdout !== 'string' || typeof rawStderr !== 'string') {
      throw new Error('INVALID_CONTROLLER_OUTPUT: Controller output stdout and stderr must be strings');
    }

    const effectiveTimedOut = timedOut || durationMs >= limits.timeoutMs;

    let validExitCode = false;
    if (rawExitCode === null) {
      validExitCode = effectiveTimedOut;
    } else if (typeof rawExitCode === 'number' && Number.isSafeInteger(rawExitCode) && !Number.isNaN(rawExitCode)) {
      validExitCode = true;
    }

    if (!validExitCode) {
      throw new Error(
        `INVALID_CONTROLLER_OUTPUT: Controller output exitCode must be a safe integer${effectiveTimedOut ? ' or null on timeout' : ' (null only permitted on timeout)'}`
      );
    }
    const exitCode: number | null = rawExitCode as number | null;

    // Canonicalize malformed UTF-16 to well-formed Unicode before byte budget consistently
    const canonicalStdout = rawStdout.toWellFormed();
    const canonicalStderr = rawStderr.toWellFormed();

    // Combined byte-accurate valid UTF-8 output bounding
    const maxBytes = limits.maxOutputBytes;
    const stdoutRawBytes = Buffer.byteLength(canonicalStdout, 'utf8');
    const stderrRawBytes = Buffer.byteLength(canonicalStderr, 'utf8');

    let stdout: string;
    let stderr: string;
    let truncated = false;

    if (stdoutRawBytes + stderrRawBytes <= maxBytes) {
      stdout = canonicalStdout;
      stderr = canonicalStderr;
      truncated = false;
    } else {
      truncated = true;
      const halfBudget = Math.floor(maxBytes / 2);

      if (stdoutRawBytes <= halfBudget) {
        stdout = canonicalStdout;
        const remainingForStderr = Math.max(0, maxBytes - Buffer.byteLength(stdout, 'utf8'));
        stderr = truncateUtf8(canonicalStderr, remainingForStderr).text;
      } else if (stderrRawBytes <= halfBudget) {
        stderr = canonicalStderr;
        const remainingForStdout = Math.max(0, maxBytes - Buffer.byteLength(stderr, 'utf8'));
        stdout = truncateUtf8(canonicalStdout, remainingForStdout).text;
      } else {
        const stdoutBudget = Math.ceil(maxBytes / 2);
        const stdoutTrunc = truncateUtf8(canonicalStdout, stdoutBudget);
        stdout = stdoutTrunc.text;
        const remainingForStderr = Math.max(0, maxBytes - stdoutTrunc.byteLength);
        stderr = truncateUtf8(canonicalStderr, remainingForStderr).text;
      }
    }

    let outcome: 'success' | 'failure' | 'timeout' | 'error';
    if (effectiveTimedOut) {
      outcome = 'timeout';
    } else if (exitCode === 0) {
      outcome = 'success';
    } else {
      outcome = 'failure';
    }

    return {
      exitCode,
      stdout,
      stderr,
      durationMs,
      timedOut: effectiveTimedOut,
      outcome,
      plan,
      truncated,
    };
  }
}

export { StructuredCommandExecutor as DockerCommandExecutor };
