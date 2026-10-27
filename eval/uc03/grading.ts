import type {
  EvaluationGraderExecutionRequest,
  EvaluationGraderExecutor,
  EvaluationGradingAdmission,
  EvaluationGradingAdmissionRequest,
  EvaluationGradingBounds,
  EvaluationGradingProfile,
  EvaluationIsolationAuthority,
  EvaluationOutcome,
  EvaluationSnapshotIdentity,
  MockPrivateGradingBoundary,
  SafeEvaluationGradingResult,
} from './types.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const OUTCOMES = new Set<string>(['COMPLETED', 'INCOMPLETE', 'IMPLEMENTED_UNVERIFIED', 'FAILED']);
const LIMIT_CEILINGS = {
  timeoutMs: 120_000,
  maxCpuMs: 120_000,
  maxOutputBytes: 1_048_576,
  maxMemoryBytes: 1_073_741_824,
  maxProcesses: 32,
} as const;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: RecordValue, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function isSnapshot(value: unknown): value is EvaluationSnapshotIdentity {
  return isRecord(value)
    && hasExactKeys(value, ['snapshotId', 'digest'])
    && isId(value['snapshotId'])
    && typeof value['digest'] === 'string'
    && SHA256.test(value['digest']);
}

function isBounds(value: unknown): value is EvaluationGradingBounds {
  if (!isRecord(value) || !hasExactKeys(value, Object.keys(LIMIT_CEILINGS))) return false;
  for (const [key, ceiling] of Object.entries(LIMIT_CEILINGS)) {
    const limit = value[key];
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > ceiling) return false;
  }
  return typeof value['timeoutMs'] === 'number'
    && typeof value['maxCpuMs'] === 'number'
    && value['maxCpuMs'] <= value['timeoutMs'];
}

function isProfile(value: unknown): value is EvaluationGradingProfile {
  return isRecord(value)
    && hasExactKeys(value, ['profileId', 'digest', 'bounds'])
    && isId(value['profileId'])
    && typeof value['digest'] === 'string'
    && SHA256.test(value['digest'])
    && isBounds(value['bounds']);
}

function isExecutor(value: unknown): value is EvaluationGraderExecutor {
  return isRecord(value)
    && hasExactKeys(value, ['executorId', 'execute'])
    && isId(value['executorId'])
    && typeof value['execute'] === 'function';
}

function isIsolationAuthority(value: unknown): value is EvaluationIsolationAuthority {
  return isRecord(value)
    && hasExactKeys(value, ['admit'])
    && typeof value['admit'] === 'function';
}

function isBoundary(value: unknown): value is MockPrivateGradingBoundary {
  return isRecord(value)
    && hasExactKeys(value, ['finalSnapshot', 'profile', 'graderPayload', 'isolationAuthority', 'executor'])
    && Object.hasOwn(value, 'graderPayload')
    && isSnapshot(value['finalSnapshot'])
    && isProfile(value['profile'])
    && isIsolationAuthority(value['isolationAuthority'])
    && isExecutor(value['executor']);
}

function freezeSnapshot(value: EvaluationSnapshotIdentity): EvaluationSnapshotIdentity {
  return Object.freeze({ snapshotId: value.snapshotId, digest: value.digest });
}

function freezeProfile(value: EvaluationGradingProfile): EvaluationGradingProfile {
  return Object.freeze({
    profileId: value.profileId,
    digest: value.digest,
    bounds: Object.freeze({ ...value.bounds }),
  });
}

function isAdmission(
  value: unknown,
  request: EvaluationGradingAdmissionRequest,
): value is EvaluationGradingAdmission {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'admissionId', 'finalSnapshot', 'profile', 'executorId'])
    && value['kind'] === 'injected-mock-isolation-admission'
    && isId(value['admissionId'])
    && value['finalSnapshot'] === request.finalSnapshot
    && value['profile'] === request.profile
    && value['executorId'] === request.executorId;
}

function isOutcome(value: unknown): value is EvaluationOutcome {
  return typeof value === 'string' && OUTCOMES.has(value);
}

function safeResult(
  value: unknown,
  request: EvaluationGraderExecutionRequest,
): SafeEvaluationGradingResult | undefined {
  if (!isRecord(value) || !hasExactKeys(value, [
    'finalSnapshot', 'profile', 'executorId', 'status', 'actualOutcome', 'durationMs', 'cpuMs', 'outputBytes',
  ])) return undefined;
  const durationMs = value['durationMs'];
  const cpuMs = value['cpuMs'];
  const outputBytes = value['outputBytes'];
  const bounds = request.profile.bounds;
  if (value['finalSnapshot'] !== request.finalSnapshot
    || value['profile'] !== request.profile
    || value['executorId'] !== request.executorId
    || (value['status'] !== 'pass' && value['status'] !== 'fail')
    || !isOutcome(value['actualOutcome'])
    || typeof durationMs !== 'number'
    || !Number.isSafeInteger(durationMs)
    || durationMs < 0
    || durationMs > bounds.timeoutMs
    || typeof cpuMs !== 'number'
    || !Number.isSafeInteger(cpuMs)
    || cpuMs < 0
    || cpuMs > bounds.maxCpuMs
    || typeof outputBytes !== 'number'
    || !Number.isSafeInteger(outputBytes)
    || outputBytes < 0
    || outputBytes > bounds.maxOutputBytes) return undefined;
  return Object.freeze({
    finalSnapshot: request.finalSnapshot,
    profile: request.profile,
    executorId: request.executorId,
    status: value['status'],
    actualOutcome: value['actualOutcome'],
    durationMs,
    outputBytes,
  });
}

export async function executeMockPrivateGrading(data: unknown): Promise<SafeEvaluationGradingResult | undefined> {
  try {
    if (!isBoundary(data)) return undefined;
    const finalSnapshot = freezeSnapshot(data.finalSnapshot);
    const profile = freezeProfile(data.profile);
    const executor = data.executor;
    const request: EvaluationGradingAdmissionRequest = Object.freeze({
      finalSnapshot,
      profile,
      executorId: executor.executorId,
    });
    const rawAdmission: unknown = await data.isolationAuthority.admit(request);
    if (!isAdmission(rawAdmission, request)) return undefined;
    const execution: EvaluationGraderExecutionRequest = Object.freeze({
      ...request,
      executor,
      admission: rawAdmission,
      graderPayload: data.graderPayload,
    });
    const rawResult: unknown = await executor.execute(execution);
    return safeResult(rawResult, execution);
  } catch {
    return undefined;
  }
}
