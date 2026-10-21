import type { ApprovalTaskControl } from '../contracts/approvals/contracts.ts';
import { validateApprovalTaskControl, validateDispatchClaim } from '../contracts/approvals/contracts.ts';
import { containsProtectedContent } from '../foundation/repository-tools.ts';
export { createApprovalContinuation } from './recovery.ts';
export type { ApprovalContinuation, ApprovalRecoveryOwner, RecoverySnapshot, RecoveryClaimInput } from './recovery.ts';

export interface ApprovalActivity {
  readonly provenance: 'mock';
  admitAttempt(input: unknown): { readonly outcome: string; readonly value: unknown };
  fenceTask(input: { readonly taskId: string; readonly epoch: number }): { readonly outcome: string };
  requestCancellation(taskId: string): { readonly outcome: string };
  inspectOutstanding(taskId: string): readonly unknown[];
}
export interface ApprovalControl {
  isClosed(): boolean;
  fence(current: ApprovalTaskControl, cancel: boolean): void;
  admitAttempt(attemptId: string, claim: unknown): boolean;
}
export function createApprovalControl(options: {
  readonly taskId: string;
  readonly load: () => ApprovalTaskControl;
  readonly activity?: ApprovalActivity;
}): ApprovalControl {
  let closed = false;
  return {
    isClosed: () => closed,
    fence: (current, cancel) => {
      if (!options.activity) return;
      const wasClosed = closed;
      closed = true;
      if (options.activity.provenance !== 'mock' || !validateApprovalTaskControl(current).ok || current.taskId !== options.taskId ||
        !activityReceipt(options.activity.fenceTask({ taskId: options.taskId, epoch: current.epoch }), 'paused') ||
        cancel && !activityReceipt(options.activity.requestCancellation(options.taskId), 'ok')) throw new Error('approval-activity-unavailable');
      closed = wasClosed;
    },
    admitAttempt: (attemptId, input) => {
      try {
        if (!plainData(input)) return false;
        const claim = validateDispatchClaim(input);
        const current = options.load();
        if (closed || !options.activity || options.activity.provenance !== 'mock' || !validateApprovalTaskControl(current).ok || !claim.ok ||
          current.taskId !== options.taskId || claim.value.taskId !== options.taskId || current.mode !== 'runnable' ||
          current.epoch !== claim.value.expectedEpoch || current.version !== claim.value.expectedControlVersion || current.outstandingClaimRefs.length > 0) return false;
        const response = options.activity.admitAttempt({ attemptId, claim: claim.value, control: current });
        if (!activityReceipt(response, 'ok') || !attemptRecord(response.value) || response.value['taskId'] !== options.taskId || response.value['attemptId'] !== attemptId || response.value['claimId'] !== claim.value.claimId || response.value['epoch'] !== current.epoch || response.value['state'] !== 'outstanding' || response.value['cancellationRequested'] !== false) { closed = true; return false; }
        const latest = options.load();
        return !closed && plainData(latest) && validateApprovalTaskControl(latest).ok && latest.taskId === options.taskId &&
          latest.repositoryId === current.repositoryId && latest.workspaceId === current.workspaceId && latest.mode === 'runnable' &&
          latest.outstandingClaimRefs.length === 0 && latest.epoch === current.epoch && latest.version === current.version;
      } catch { closed = true; return false; }
    },
  };
}

function activityReceipt(value: unknown, outcome: string): boolean {
  if (!plainData(value) || typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const reasons = outcome === 'paused' ? ['task-epoch-fenced-in-memory'] : ['activity-attempt-admitted-in-memory', 'cancellation-requested-without-claim-release'];
  return Object.keys(record).length === 3 && Object.hasOwn(record, 'value') && record['outcome'] === outcome &&
    typeof record['safeReasonCode'] === 'string' && reasons.includes(record['safeReasonCode']) && !containsProtectedContent(JSON.stringify(record['value'])) &&
    (outcome === 'paused' ? record['value'] === null : record['safeReasonCode'] === 'activity-attempt-admitted-in-memory' ? attemptRecord(record['value']) : Array.isArray(record['value']) && record['value'].every(attemptRecord));
}

function attemptRecord(value: unknown): value is Record<string, unknown> {
  if (!plainData(value) || value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 6 && ['attemptId', 'claimId', 'taskId'].every(key => typeof record[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/u.test(record[key])) &&
    Number.isSafeInteger(record['epoch']) && typeof record['epoch'] === 'number' && record['epoch'] > 0 && typeof record['cancellationRequested'] === 'boolean' && ['outstanding', 'completed', 'cancelled', 'uncertain'].includes(String(record['state']));
}
/** Inspect plain data before calling validators or serializing untrusted port results. */
function plainData(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 8192;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length <= 256 && Reflect.ownKeys(descriptors).every(key => {
    const descriptor = typeof key === 'string' ? descriptors[key] : undefined;
    return descriptor !== undefined && 'value' in descriptor && plainData(descriptor.value, depth + 1);
  });
}
