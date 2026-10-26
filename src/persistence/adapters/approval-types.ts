import type { StoreResponse } from '../../approvals/service-data.ts';
import {
  type ApprovalTaskControl,
  type BindingAssessment,
  type DeveloperDirection,
  type DispatchClaim,
  type HumanResolution,
  type SafeOperationOutcome,
  type SafeResult,
  UC05_APPROVAL_SCHEMA_VERSION,
} from '../../contracts/approvals/contracts.ts';
import type { DurableStore } from '../store.ts';

export interface DurableApprovalStoreOptions {
  readonly storageDir: string;
  readonly durableStore?: DurableStore | undefined;
}

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
