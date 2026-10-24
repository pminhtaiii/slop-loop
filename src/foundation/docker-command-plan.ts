import path from 'node:path';
import { validateExecutionLimits, validateNormalizedAction } from '../contracts/foundation/uc03.ts';
import type { ExecutionLimits, RunCommandAction, CommandView } from '../contracts/foundation/uc03.ts';
import { containsProtectedContent, DEFAULT_MAX_OUTPUT_BYTES, FORBIDDEN_ENV_KEYS, isImmutableEnvKey, isLoaderHook, PRIVATE_ALLOWED_EXECUTABLES, PRIVATE_DEFAULT_CONTAINER_ENV, SHELL_METACHARS_RE } from './docker-workspace-policy.ts';
import type { DockerContainerPlan, DockerMountConfig, DockerProfile, ExecuteCommandParams } from './docker-workspace-types.ts';

export function createDockerCommandPlan(
  params: ExecuteCommandParams,
  trustedProfile: DockerProfile,
  activeView: CommandView,
  allowedEnvKeys: ReadonlySet<string>
): { readonly action: RunCommandAction; readonly limits: ExecutionLimits; readonly plan: DockerContainerPlan } {
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
  const maxOutputBytesCeiling = trustedProfile.limits.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (limits.maxOutputBytes > maxOutputBytesCeiling) {
    throw new Error(`RESOURCE_LIMIT_EXCEEDS_PROFILE_CEILING: Command maxOutputBytes (${limits.maxOutputBytes}) exceeds profile ceiling (${maxOutputBytesCeiling})`);
  }

  // Check allowlisted executable
  if (!PRIVATE_ALLOWED_EXECUTABLES.has(action.executable)) {
    throw new Error(`DISALLOWED_EXECUTABLE: Executable '${action.executable}' is not in allowed executable set (${Array.from(PRIVATE_ALLOWED_EXECUTABLES).join(', ')})`);
  }

  // Check argv without shell
  for (let i = 0; i < action.argv.length; i++) {
    const arg = action.argv[i];
    if (typeof arg !== 'string' || SHELL_METACHARS_RE.test(arg)) {
      throw new Error(`FORBIDDEN_SHELL_CHARACTERS: Argument at index ${i} contains forbidden shell characters`);
    }
  }

  // Check working directory
  const wd = path.posix.normalize(action.workingDirectory);
  if (!path.posix.isAbsolute(wd) || (wd !== '/workspace/repo' && wd !== '/workspace/scratch' && !wd.startsWith('/workspace/repo/') && !wd.startsWith('/workspace/scratch/'))) {
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
      if (!allowedEnvKeys.has(k)) {
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
    workingDirectory: wd,
    env: Object.freeze(mergedEnv),
    limits,
  };


  return { action, limits, plan };
}
