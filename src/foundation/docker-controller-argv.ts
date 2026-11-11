import { validateExecutionLimits } from '../contracts/foundation/uc03.ts';
import type { ExecutionLimits } from '../contracts/foundation/uc03.ts';
import { ALLOWED_EXECUTABLES, containsProtectedContent, DEFAULT_MAX_OUTPUT_BYTES, FORBIDDEN_ENV_KEYS, SHELL_METACHARS_RE } from './docker-workspace-policy.ts';
import type { DockerContainerPlan, DockerMountConfig, DockerProfile } from './docker-workspace-types.ts';

export interface RunArgumentSpec {
  readonly user: string;
  readonly memoryBytes: number;
  readonly cpus: number;
  readonly pids: number;
  readonly name: string;
  readonly mounts: readonly DockerMountConfig[];
  readonly workingDirectory?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly stdin?: boolean | undefined;
  readonly tail: readonly string[];
}

const VOLUME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SOCKET_PATH_RE = /(?:docker\.sock|containerd\.sock|\/var\/run\/|\/proc\/self|\/sys\/)/i;
export const ALLOWED_MOUNT_TARGETS: ReadonlyMap<string, boolean> = new Map([
  ['/workspace/repo', true],
  ['/workspace/scratch', false],
]);

export function assertVolumeName(volumeId: string): void {
  if (typeof volumeId !== 'string' || !VOLUME_NAME_RE.test(volumeId) || volumeId.includes('..')) {
    throw new Error(`INVALID_VOLUME_ID: '${String(volumeId)}' is not a safe docker volume name`);
  }
}

/** Validates a plan against the pinned trusted profile and limits before anything is spawned. */
export function assertPlan(plan: DockerContainerPlan, trustedProfile: DockerProfile): ExecutionLimits {
  if (!plan || typeof plan !== 'object') throw new Error('INVALID_CONTAINER_PLAN: plan must be an object');
  if (plan.image !== trustedProfile.image || plan.imageDigest !== trustedProfile.imageDigest) {
    throw new Error(`IMAGE_DIGEST_MISMATCH: plan image '${plan.image}@${plan.imageDigest}' does not match the pinned profile '${trustedProfile.image}@${trustedProfile.imageDigest}'`);
  }
  if (plan.user !== trustedProfile.user) throw new Error(`PINNED_USER_MISMATCH: plan user '${plan.user}' does not match the pinned profile user`);
  if (plan.readOnlyRootFilesystem !== true || plan.network !== 'none' || plan.noNewPrivileges !== true || !plan.dropCapabilities.includes('ALL')) {
    throw new Error('ISOLATION_PROFILE_MISMATCH: read-only root, network none, no-new-privileges and a full capability drop are required');
  }

  if (!Array.isArray(plan.mounts) || plan.mounts.length !== 2) throw new Error('INVALID_MOUNTS: a container plan requires exactly the repo and scratch mounts');
  const targets = new Set<string>();
  for (const mount of plan.mounts) {
    const expectedReadOnly = ALLOWED_MOUNT_TARGETS.get(mount.target);
    if (expectedReadOnly === undefined) throw new Error(`ARBITRARY_MOUNT_TARGET_FORBIDDEN: '${mount.target}'`);
    if (mount.readOnly !== expectedReadOnly) throw new Error(`MOUNT_READONLY_MISMATCH: '${mount.target}' must be ${expectedReadOnly ? 'read-only' : 'writable'}`);
    if (targets.has(mount.target)) throw new Error(`DUPLICATE_MOUNT_TARGET_FORBIDDEN: '${mount.target}'`);
    assertVolumeName(mount.source);
    targets.add(mount.target);
  }

  for (const [key, value] of Object.entries(plan.env ?? {})) {
    if (typeof value !== 'string') throw new Error(`INVALID_ENVIRONMENT: '${key}' must be a string`);
    if (FORBIDDEN_ENV_KEYS.test(key) || containsProtectedContent(value) || SOCKET_PATH_RE.test(key) || SOCKET_PATH_RE.test(value) || key.includes('=') || key.includes('\0')) {
      throw new Error(`FORBIDDEN_ENVIRONMENT_VARIABLE: '${key}' carries a credential or socket-looking value`);
    }
  }

  if (!ALLOWED_EXECUTABLES.has(plan.executable)) throw new Error(`DISALLOWED_EXECUTABLE: '${plan.executable}' is not in the allowed executable set`);
  for (const arg of plan.argv) {
    if (typeof arg !== 'string' || SHELL_METACHARS_RE.test(arg)) throw new Error('FORBIDDEN_SHELL_CHARACTERS: an argument carries shell metacharacters or is not a string');
  }
  const wd = plan.workingDirectory;
  const inWorkspace = typeof wd === 'string' && (wd === '/workspace/repo' || wd === '/workspace/scratch' || wd.startsWith('/workspace/repo/') || wd.startsWith('/workspace/scratch/'));
  if (!inWorkspace || wd.includes('..') || SHELL_METACHARS_RE.test(wd)) {
    throw new Error(`INVALID_WORKING_DIRECTORY: '${String(wd)}' must resolve inside /workspace/repo or /workspace/scratch`);
  }

  const limitsRes = validateExecutionLimits(plan.limits);
  if (!limitsRes.ok) throw new Error(`INVALID_EXECUTION_LIMITS: ${limitsRes.errors.map(e => e.message).join('; ')}`);
  const limits = limitsRes.value;
  const ceiling = trustedProfile.limits;
  if (
    limits.timeoutMs > ceiling.timeoutMs ||
    limits.maxMemoryBytes > ceiling.maxMemoryBytes ||
    limits.maxCpuCores > ceiling.maxCpuCores ||
    limits.maxPids > ceiling.maxPids ||
    limits.maxOutputBytes > (ceiling.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)
  ) {
    throw new Error('RESOURCE_LIMIT_EXCEEDS_PROFILE_CEILING: plan limits exceed the pinned profile ceilings');
  }
  return limits;
}

/** Docker argv array; each element is one argument, so no shell ever parses it. */
export function runArguments(spec: RunArgumentSpec, platform: string, image: string, imageDigest: string): string[] {
  const args = [
    'run',
    '--rm',
    '--network=none',
    '--read-only',
    `--user=${spec.user}`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--platform=${platform}`,
    `--memory=${spec.memoryBytes}`,
    `--cpus=${spec.cpus}`,
    `--pids-limit=${spec.pids}`,
    `--name=${spec.name}`,
  ];
  if (spec.workingDirectory !== undefined) args.push('-w', spec.workingDirectory);
  for (const [key, value] of Object.entries(spec.env ?? {})) args.push('-e', `${key}=${value}`);
  if (spec.stdin === true) args.push('-i');
  for (const mount of spec.mounts) {
    args.push(`--mount=type=volume,source=${mount.source},target=${mount.target}${mount.readOnly ? ',readonly' : ''}`);
  }
  args.push(`${image}@${imageDigest}`, ...spec.tail);
  return args;
}
