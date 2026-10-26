import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { StoreResponse } from '../../approvals/service-data.ts';
import {
  type ApprovalRequestRecord,
  type ApprovalTaskControl,
  type BindingAssessment,
  type DeveloperDirection,
  type DispatchClaim,
  type HumanResolution,
  type PolicyProfile,
  type SafeOperationOutcome,
  type SafeResult,
  UC05_APPROVAL_SCHEMA_VERSION,
} from '../../contracts/approvals/contracts.ts';
import type { DurableStore } from '../store.ts';

export interface DurableApprovalStoreOptions {
  readonly storageDir: string;
  readonly durableStore?: DurableStore | undefined;
  readonly profile?: unknown;
}

export type EventAppendResult =
  | { readonly ok: true; readonly status: 'skipped' | 'idempotent' | 'appended' }
  | { readonly ok: false; readonly error: 'denied' | 'unavailable' | 'conflict'; readonly reason: string };

export const DEFAULT_POLICY_PROFILE: PolicyProfile = {
  schemaVersion: 'uc05-approval/0.1-draft',
  profileId: 'uc05-local-v1',
  profileVersion: '1',
  policyIdentity: { policyId: 'policy-1', policyVersion: '1', configId: 'config-1', configVersion: '1' },
  supportedActionKinds: ['run_command', 'apply_patch', 'approve_fix_plan'],
  commandRules: [{ ruleId: 'tests', executableRef: 'pytest', argvPrefix: ['-q', 'tests/'], workingDirectoryRef: 'repository-root', timeoutMs: 2000, maxOutputBytes: 8192 }],
  sensitivePaths: ['pyproject.toml'],
  patchBreadth: { maxFiles: 8, maxAddedDeletedLines: 400 },
  maxActionBytes: 65536,
  maxArgvEntries: 32,
  maxArgvEntryBytes: 4096,
  maxPresentationPageBytes: 8192,
  maxPresentationPages: 3,
  maxPresentationTotalBytes: 24576,
  maxEventBytes: 1024,
  operationDeadlineMs: 2000,
  maxMutationAttempts: 1,
  diagnosticRules: { maxBytes: 1024, redactSecrets: true, allowRawArtifacts: false, retainUnresolvedDecisions: true },
};

export interface StoredHistory {
  readonly resolutions: readonly HumanResolution[];
  readonly directions: readonly DeveloperDirection[];
  readonly assessments: readonly BindingAssessment[];
  readonly claims: readonly DispatchClaim[];
}

export interface StorePayload {
  readonly expectedControlVersion?: number;
  readonly expectedRequestVersion?: number;
  readonly request?: unknown;
  readonly replacement?: unknown;
  readonly trustedResponse?: unknown;
  readonly trustedOperator?: unknown;
  readonly direction?: unknown;
  readonly event?: unknown;
  readonly events?: readonly unknown[];
}

export function makeResponse<T>(
  c: Pick<ApprovalTaskControl, 'taskId' | 'version'>,
  outcome: SafeOperationOutcome,
  safeReasonCode: string,
  value: T | null,
  decisionId: string | null = null,
  requestVersion: number | null = null,
  eventRef: string | null = null
): StoreResponse<T> {
  const safe: SafeResult = {
    schemaVersion: UC05_APPROVAL_SCHEMA_VERSION,
    outcome,
    safeReasonCode,
    taskId: c.taskId,
    decisionId,
    controlVersion: c.version,
    requestVersion,
    eventRef,
    safeNextAction: 'none',
  };
  return { safe, value };
}

export const makeFailure = <T>(
  taskId: string,
  v: number,
  o: SafeOperationOutcome,
  code: string,
  dId: string | null = null,
  rV: number | null = null
): StoreResponse<T> => makeResponse<T>({ taskId, version: v }, o, code, null, dId, rV);

export const isSafeId = (id: string): boolean =>
  typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes('..');

export const taskDir = (storageDir: string, taskId: string): string => join(storageDir, 'tasks', taskId, 'approvals');
export const decisionDir = (storageDir: string, dId: string): string => join(storageDir, 'decisions', dId);

export function makeInitialControl(taskId: string): ApprovalTaskControl {
  return {
    schemaVersion: UC05_APPROVAL_SCHEMA_VERSION,
    taskId,
    repositoryId: 'default-repo',
    workspaceId: 'default-ws',
    version: 1,
    epoch: 1,
    mode: 'runnable',
    pendingDecisionId: null,
    continuationRef: null,
    reasonCode: 'initial-runnable',
    outstandingClaimRefs: [],
  };
}

export function parseStoredHistory(raw: unknown, taskId: string): StoreResponse<StoredHistory> {
  if (!raw || typeof raw !== 'object') return makeFailure<StoredHistory>(taskId, 1, 'unavailable', 'read-error');
  const checkArr = (v: unknown) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error('malformed');
    return v;
  };
  return makeResponse({ taskId, version: 1 }, 'ok', 'history-loaded', {
    resolutions: checkArr((raw as Record<string, unknown>).resolutions),
    directions: checkArr((raw as Record<string, unknown>).directions),
    assessments: checkArr((raw as Record<string, unknown>).assessments),
    claims: checkArr((raw as Record<string, unknown>).claims),
  });
}

export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, path);
  } catch (err: unknown) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function checkResolvePreconditions(
  currentControl: ApprovalTaskControl,
  request: ApprovalRequestRecord,
  payload: StorePayload
): string | null {
  if (currentControl.mode !== 'waiting') return 'task-not-waiting';
  if (currentControl.pendingDecisionId !== request.decisionId) return 'decision-not-pending';
  if (payload.expectedControlVersion !== undefined && currentControl.version !== payload.expectedControlVersion) return 'version-conflict';
  if (payload.expectedRequestVersion !== undefined && payload.expectedRequestVersion !== request.requestVersion) return 'request-version-conflict';
  if (!payload.trustedOperator) return 'missing-trusted-operator';
  return null;
}

export function checkDirectionPreconditions(
  currentControl: ApprovalTaskControl,
  payload: StorePayload
): string | null {
  if (currentControl.mode === 'ended' || currentControl.mode === 'rejected') return 'task-terminal';
  if (payload.expectedControlVersion !== undefined && currentControl.version !== payload.expectedControlVersion) return 'version-conflict';
  if (!payload.trustedOperator) return 'missing-trusted-operator';
  return null;
}

export function checkReplacePreconditions(
  currentControl: ApprovalTaskControl,
  replacement: ApprovalRequestRecord,
  storageDir: string,
  payload: StorePayload
): string | null {
  if (currentControl.mode !== 'waiting' || currentControl.pendingDecisionId === null) return 'no-pending-decision';
  if (
    replacement.decisionId === currentControl.pendingDecisionId ||
    existsSync(join(decisionDir(storageDir, replacement.decisionId), 'request.json'))
  ) {
    return 'decision-id-in-use';
  }
  if (payload.expectedControlVersion !== undefined && currentControl.version !== payload.expectedControlVersion) return 'version-conflict';
  return null;
}
