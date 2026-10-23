import { createHash } from 'node:crypto';
import { computeCanonicalSha256 } from '../contracts/foundation/uc03.ts';
import type { ExecutionLimits, ValidationError, ValidationResult } from '../contracts/foundation/uc03.ts';
import type { DockerContainerPlan, DockerMountConfig, DockerProfile, DockerResourceLimits, StructuredExecutionResult } from './docker-workspace-types.ts';

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

export const PRIVATE_ALLOWED_EXECUTABLES: ReadonlySet<string> = new Set(['pytest', 'python', 'python3']);

export const ALLOWED_EXECUTABLES: ReadonlySet<string> = new Set(PRIVATE_ALLOWED_EXECUTABLES);

export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export const PRIVATE_DEFAULT_CONTAINER_ENV: Readonly<Record<string, string>> = Object.freeze({
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

export const SHA256_HEX_REGEX = /^sha256:[a-f0-9]{64}$/;
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

export const SHELL_METACHARS_RE = /[;&|><`$\r\n]/;
export const FORBIDDEN_ENV_KEYS = /(?:TOKEN|SECRET|KEY|PASSWORD|AUTH|CREDENTIAL|API|AWS|GITHUB|OPENAI|ANTHROPIC|GEMINI)/i;

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

export function isValidFencingGeneration(generation: number): boolean {
  return Number.isSafeInteger(generation) && generation > 0;
}

export function normalizeDockerExecutionOutput(
  rawOutput: unknown,
  limits: ExecutionLimits,
  plan: DockerContainerPlan
): StructuredExecutionResult {
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
