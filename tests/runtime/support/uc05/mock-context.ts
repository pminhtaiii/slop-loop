import { isDeepStrictEqual } from 'node:util';
import {
  type ApprovalTaskControl,
  type DispatchClaim,
  type PolicyProfile,
  type SafeOperationOutcome,
  validateApprovalTaskControl,
  validateDispatchClaim,
  validatePolicyProfile,
} from '../../../../src/approvals/contracts.ts';
import { UC05_MOCK_PROVENANCE } from './mock-store.ts';

export type MockEffectClass = 'read' | 'test' | 'mutation';
export type MockAttemptState = 'outstanding' | 'completed' | 'cancelled' | 'uncertain';

export interface MockActivityAttempt {
  readonly attemptId: string;
  readonly claimId: string;
  readonly taskId: string;
  readonly epoch: number;
  readonly state: MockAttemptState;
  readonly cancellationRequested: boolean;
}

export interface MockEffectAttempt {
  readonly attemptId: string;
  readonly claimId: string;
  readonly taskId: string;
  readonly epoch: number;
  readonly effectClass: MockEffectClass;
  readonly observation: 'attempt-recorded' | 'uncertain';
}

export interface MockActivityResponse<T> {
  readonly outcome: SafeOperationOutcome;
  readonly safeReasonCode: string;
  readonly value: T | null;
}

export interface MockActivityControl {
  readonly provenance: typeof UC05_MOCK_PROVENANCE;
  readonly profile: PolicyProfile;
  admitAttempt(input: unknown): MockActivityResponse<MockActivityAttempt>;
  fenceTask(input: { readonly taskId: string; readonly epoch: number }): MockActivityResponse<null>;
  requestCancellation(taskId: string): MockActivityResponse<readonly MockActivityAttempt[]>;
  recordEffectAttempt(attemptId: string, effectClass: MockEffectClass): MockActivityResponse<MockEffectAttempt>;
  recordOutcome(attemptId: string, outcome: Exclude<MockAttemptState, 'outstanding'>): MockActivityResponse<MockActivityAttempt>;
  inspectOutstanding(taskId: string): readonly MockActivityAttempt[];
  readEffectLog(): readonly MockEffectAttempt[];
}

interface MutableAttempt {
  attemptId: string;
  claimId: string;
  taskId: string;
  epoch: number;
  state: MockAttemptState;
  cancellationRequested: boolean;
}

/** Creates an in-memory ActivityControl double that records attempts only. */
export function createMockActivityControl(profileInput: unknown): MockActivityControl {
  const profileResult = validatePolicyProfile(profileInput);
  if (!profileResult.ok) throw new TypeError('mock activity control requires a validated finite test profile');
  const profile = freezeCopy(profileResult.value);
  const fences = new Map<string, number>();
  const attempts = new Map<string, MutableAttempt>();
  const effects: MockEffectAttempt[] = [];

  const result = <T>(outcome: SafeOperationOutcome, safeReasonCode: string, value: T | null = null): MockActivityResponse<T> =>
    freezeCopy({ outcome, safeReasonCode, value });

  const admitAttempt = (input: unknown): MockActivityResponse<MockActivityAttempt> => {
    if (!validAttemptInput(input)) return result('invalid', 'invalid-activity-claim');
    const { attemptId, control, claim } = input;
    if (control.mode !== 'runnable') return result('paused', 'task-control-fences-activity');
    if (control.taskId !== claim.taskId || control.epoch !== claim.expectedEpoch ||
      (control.version !== claim.expectedControlVersion && control.version !== claim.expectedControlVersion + 1) ||
      !isDeepStrictEqual(claim.policyIdentity, profile.policyIdentity)) {
      return result('stale', 'claim-does-not-match-current-task-context');
    }
    if ((fences.get(claim.taskId) ?? 0) >= claim.expectedEpoch) return result('paused', 'task-epoch-is-fenced');
    if (claim.phase !== 'claimed' || attempts.has(attemptId) || [...attempts.values()].some((attempt) => attempt.claimId === claim.claimId)) {
      return result('conflict', 'claim-already-admitted');
    }
    const attempt: MutableAttempt = {
      attemptId,
      claimId: claim.claimId,
      taskId: claim.taskId,
      epoch: claim.expectedEpoch,
      state: 'outstanding',
      cancellationRequested: false,
    };
    attempts.set(attemptId, attempt);
    return result('ok', 'activity-attempt-admitted-in-memory', snapshot(attempt));
  };

  const fenceTask = (input: { readonly taskId: string; readonly epoch: number }): MockActivityResponse<null> => {
    if (!isIdentifier(input.taskId) || !isPositiveInteger(input.epoch)) return result('invalid', 'invalid-task-fence');
    const previous = fences.get(input.taskId) ?? 0;
    if (input.epoch < previous) return result('stale', 'older-task-fence-ignored');
    fences.set(input.taskId, input.epoch);
    for (const attempt of attempts.values()) {
      if (attempt.taskId === input.taskId && attempt.epoch < input.epoch && attempt.state === 'outstanding') {
        attempt.cancellationRequested = true;
      }
    }
    return result('paused', 'task-epoch-fenced-in-memory');
  };

  const requestCancellation = (taskId: string): MockActivityResponse<readonly MockActivityAttempt[]> => {
    if (!isIdentifier(taskId)) return result('invalid', 'invalid-task-id');
    for (const attempt of attempts.values()) {
      if (attempt.taskId === taskId && attempt.state === 'outstanding') attempt.cancellationRequested = true;
    }
    return result('ok', 'cancellation-requested-without-claim-release', outstanding(taskId));
  };

  const recordEffectAttempt = (attemptId: string, effectClass: MockEffectClass): MockActivityResponse<MockEffectAttempt> => {
    if (!isIdentifier(attemptId) || !['read', 'test', 'mutation'].includes(effectClass)) return result('invalid', 'invalid-effect-attempt');
    const attempt = attempts.get(attemptId);
    if (!attempt || attempt.state !== 'outstanding' || effects.some((effect) => effect.attemptId === attemptId)) {
      return result('conflict', 'no-unrecorded-admitted-attempt');
    }
    const observation = attempt.cancellationRequested ? 'uncertain' : 'attempt-recorded';
    const effect: MockEffectAttempt = freezeCopy({
      attemptId,
      claimId: attempt.claimId,
      taskId: attempt.taskId,
      epoch: attempt.epoch,
      effectClass,
      observation,
    });
    effects.push(effect);
    return result(observation === 'uncertain' ? 'uncertain' : 'ok', observation === 'uncertain' ? 'in-flight-effect-remains-uncertain' : 'effect-attempt-recorded-test-only', effect);
  };

  const recordOutcome = (attemptId: string, outcome: Exclude<MockAttemptState, 'outstanding'>): MockActivityResponse<MockActivityAttempt> => {
    if (!isIdentifier(attemptId) || !['completed', 'cancelled', 'uncertain'].includes(outcome)) return result('invalid', 'invalid-activity-outcome');
    const attempt = attempts.get(attemptId);
    if (!attempt || attempt.state !== 'outstanding') return result('conflict', 'activity-attempt-is-not-outstanding');
    if (outcome === 'cancelled' && (!attempt.cancellationRequested || effects.some((effect) => effect.attemptId === attemptId))) {
      return result('conflict', 'cancellation-cannot-imply-rollback');
    }
    attempt.state = outcome;
    return result(outcome === 'uncertain' ? 'uncertain' : 'ok', outcome === 'uncertain' ? 'activity-outcome-remains-uncertain' : 'activity-outcome-recorded', snapshot(attempt));
  };

  const outstanding = (taskId: string): readonly MockActivityAttempt[] => freezeCopy(
    [...attempts.values()]
      .filter((attempt) => attempt.taskId === taskId && (attempt.state === 'outstanding' || attempt.state === 'uncertain'))
      .map(snapshot),
  );

  const readEffectLog = (): readonly MockEffectAttempt[] => freezeCopy(effects);

  return Object.freeze({
    provenance: UC05_MOCK_PROVENANCE,
    profile,
    admitAttempt,
    fenceTask,
    requestCancellation,
    recordEffectAttempt,
    recordOutcome,
    inspectOutstanding: outstanding,
    readEffectLog,
  });
}

function validAttemptInput(input: unknown): input is {
  readonly attemptId: string;
  readonly control: ApprovalTaskControl;
  readonly claim: DispatchClaim;
} {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  return isIdentifier(record['attemptId'])
    && validateApprovalTaskControl(record['control']).ok
    && validateDispatchClaim(record['claim']).ok;
}

function snapshot(attempt: MutableAttempt): MockActivityAttempt {
  return freezeCopy({ ...attempt });
}

function isIdentifier(input: unknown): input is string {
  return typeof input === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/u.test(input);
}

function isPositiveInteger(input: unknown): input is number {
  return typeof input === 'number' && Number.isSafeInteger(input) && input > 0;
}

function freezeCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const visit = (item: unknown): void => {
    if (item === null || typeof item !== 'object' || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) visit(child);
    Object.freeze(item);
  };
  visit(copy);
  return copy;
}
