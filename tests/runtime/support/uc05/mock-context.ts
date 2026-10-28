import { journalClaimV02 } from '../../../../src/approvals/control-v02.ts';
import type { AttemptReceiptV02, ClaimReceiptV02, ExecutorIdentityV02, RepositoryAdmissionContextV02, RepositoryAdmissionTrustedContextV02 } from '../../../../src/contracts/foundation/uc03/v02/ports.ts';
import { validateAdmissionV02 } from '../../../../src/contracts/foundation/uc03/v02/admission.ts';
import { validateAttemptReceiptV02 } from '../../../../src/contracts/foundation/uc03/v02/attempt.ts';
import { type MemoryStatePortV02, NEUTRAL_ATTEMPT_RECEIPT_V02, isNeutralAttemptReceiptV02 } from '../uc03/memory-state.ts';
import { isDeepStrictEqual } from 'node:util';
import {
  type ApprovalTaskControl,
  type DispatchClaim,
  type PolicyProfile,
  type SafeOperationOutcome,
  validateApprovalTaskControl,
  validateDispatchClaim,
  validatePolicyProfile,
} from '../../../../src/contracts/approvals/contracts.ts';
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

/** Require an attempt identifier and contract-valid task control and claim before admission checks. */
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

/** Return an immutable copy of an activity attempt without exposing mutable mock state. */
function snapshot(attempt: MutableAttempt): MockActivityAttempt {
  return freezeCopy({ ...attempt });
}

/** Recognize bounded ASCII identifiers for mock tasks and activity attempts. */
function isIdentifier(input: unknown): input is string {
  return typeof input === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/u.test(input);
}

/** Require a positive safe integer for an activity fence epoch. */
function isPositiveInteger(input: unknown): input is number {
  return typeof input === 'number' && Number.isSafeInteger(input) && input > 0;
}

/** Clone and recursively freeze activity data to isolate callers from the mock's mutable state. */
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

export interface MockEffectAttemptV02 {
  readonly attemptReceipt: AttemptReceiptV02;
  readonly admissionContext: RepositoryAdmissionContextV02;
  readonly trustedContext: RepositoryAdmissionTrustedContextV02;
  readonly effectClass: MockEffectClass;
}

export interface MockActivityControlV02 {
  readonly provenance: typeof UC05_MOCK_PROVENANCE;
  admitAttemptV02(admissionReceipt: ClaimReceiptV02, executor: ExecutorIdentityV02, context: RepositoryAdmissionContextV02, trusted: RepositoryAdmissionTrustedContextV02): Promise<AttemptReceiptV02>;
  recordEffectAttemptV02(receipt: AttemptReceiptV02, effectClass: MockEffectClass, context: RepositoryAdmissionContextV02, trusted: RepositoryAdmissionTrustedContextV02): Promise<MockActivityResponse<MockEffectAttemptV02>>;
  readEffectLogV02(): readonly MockEffectAttemptV02[];
}

/** Same-process receipt tracking only; the canonical journal owns attempt consumption. */
export function createMockActivityControlV02(profileInput: unknown, journal: MemoryStatePortV02): MockActivityControlV02 {
  if (!validatePolicyProfile(profileInput).ok) throw new TypeError('invalid-mock-activity-profile');
  const admitted = new Map<string, { readonly receipt: AttemptReceiptV02; readonly context: RepositoryAdmissionContextV02; readonly trusted: RepositoryAdmissionTrustedContextV02 }>();
  const effects: MockEffectAttemptV02[] = [];
  return Object.freeze({
    provenance: UC05_MOCK_PROVENANCE,
    admitAttemptV02: async (admissionReceipt, executor, context, trusted) => {
      const checked = validateAdmissionV02(context, trusted);
      if (!checked.ok || checked.value.subjectKind !== 'repository-action' || executor?.payloadDigest !== checked.value.actionDigest) return NEUTRAL_ATTEMPT_RECEIPT_V02;
      const claim = journalClaimV02(admissionReceipt);
      if (!claim || claim.taskId !== context.taskId || claim.runId !== context.runId || claim.subjectKind !== context.subjectKind ||
        claim.planApplicability !== context.planApplicability || claim.preClaimTaskStateVersion !== context.expectedTaskStateVersion ||
        claim.preClaimControlVersion !== context.expectedControlVersion || claim.epoch !== context.expectedEpoch ||
        !isDeepStrictEqual(claim.reservationRefs, context.reservationRefs)) return NEUTRAL_ATTEMPT_RECEIPT_V02;
      const inputs = freezeCopy({ context, trusted });
      const receipt = await journal.beginAttempt(claim.claimId, executor);
      if (!isNeutralAttemptReceiptV02(receipt)) admitted.set(receipt.attemptId, freezeCopy({ receipt, ...inputs }));
      return receipt;
    },
    recordEffectAttemptV02: async (receipt, effectClass, context, trusted) => {
      const denied: MockActivityResponse<MockEffectAttemptV02> = { outcome: 'conflict', safeReasonCode: 'invalid-or-stale-effect-context', value: null };
      const checked = validateAdmissionV02(context, trusted);
      if (!checked.ok || checked.value.subjectKind !== 'repository-action' || !validateAttemptReceiptV02(receipt, { isRepairPatch: context.action.kind === 'apply_patch' && context.runnableNode === 'Repair' }).ok) return denied;
      const retained = admitted.get(receipt.attemptId);
      if (!retained || !isDeepStrictEqual(receipt, retained.receipt) || !isDeepStrictEqual(context, retained.context) || !isDeepStrictEqual(trusted, retained.trusted) ||
        !['read', 'test', 'mutation'].includes(effectClass) || effects.some(effect => effect.attemptReceipt.attemptId === receipt.attemptId)) return denied;
      receipt = retained.receipt;
      context = retained.context;
      trusted = retained.trusted;
      const task = await journal.loadTask(receipt.taskId);
      const current = journal.getJournalSnapshot();
      if (effects.some(effect => effect.attemptReceipt.attemptId === receipt.attemptId) || !task || task.stateVersion !== receipt.postBeginTaskStateVersion || task.repositoryRevisionDigest !== context.canonicalRevision ||
        current.mode !== 'runnable' || current.holdRef !== null || current.controlVersion !== receipt.postBeginControlVersion || current.epoch !== receipt.epoch ||
        current.activeClaimId !== receipt.claimId || !isDeepStrictEqual(current.activeAuthorityRef, context.policyAuthorityRef) ||
        !current.attempts.some(attempt => attempt.attemptId === receipt.attemptId && attempt.claimId === receipt.claimId && attempt.status === 'attempting')) return denied;
      const effect = freezeCopy({ attemptReceipt: receipt, admissionContext: context, trustedContext: trusted, effectClass });
      effects.push(effect);
      return freezeCopy({ outcome: 'ok', safeReasonCode: 'effect-recorded-test-only', value: effect });
    },
    readEffectLogV02: () => freezeCopy(effects),
  } satisfies MockActivityControlV02);
}
