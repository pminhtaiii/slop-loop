import { randomUUID } from 'node:crypto';
import { validateAttemptReceiptV02, validateClaimClosureReceiptV02 } from '../contracts/foundation/uc03/v02/attempt.ts';
import type {
  AttemptReceiptV02,
  ClaimClosureReceiptV02,
  ClaimReceiptV02,
  ExecutorIdentityV02,
  ReconciliationResultV02,
  RepositoryActionOutcomeReceiptV02,
  RepositoryAdmissionContextV02,
  StatePortV02,
} from '../contracts/foundation/uc03/v02/ports.ts';
import type { WorkspaceLease } from './docker-workspace.ts';
import { matchesRepositoryAttemptV02 } from './repository-claim-lifecycle.ts';
import type { RepositoryOutcomeRecoveryV02 } from './repository-command-outcome.ts';
import type {
  RepositoryAttemptStartRecoveryHandoffV02,
  RepositoryAttemptStartRecoveryResultV02,
} from './repository-types.ts';

interface PendingAttemptStartV02 {
  readonly recoveryId: string;
  readonly lease: WorkspaceLease;
  readonly admission: RepositoryAdmissionContextV02;
  readonly claim: ClaimReceiptV02;
  readonly executorIdentity: ExecutorIdentityV02;
  readonly isRepairPatch: boolean;
  recovering: boolean;
  leaseReleaseAttempted: boolean;
  attempt?: AttemptReceiptV02;
  outcome?: RepositoryActionOutcomeReceiptV02;
  outcomeRecorded: boolean;
  closureReceipt?: ClaimClosureReceiptV02;
}

type OutcomeRecoveryBoundaryV02 = Pick<RepositoryOutcomeRecoveryV02, 'record' | 'recover' | 'hasPending'>;
type UncertainOutcomeFactoryV02 = (
  claim: ClaimReceiptV02,
  attempt: AttemptReceiptV02,
  admission: RepositoryAdmissionContextV02,
) => RepositoryActionOutcomeReceiptV02;

const CLAIM_KEYS = [
  'claimId', 'claimDigest', 'taskId', 'runId', 'subjectKind', 'planApplicability',
  'preClaimTaskStateVersion', 'preClaimControlVersion', 'postClaimControlVersion',
  'epoch', 'status', 'reservationRefs',
] as const;
const ATTEMPT_KEYS = [
  'attemptId', 'claimId', 'taskId', 'executorIdentity', 'preAttemptTaskStateVersion',
  'postBeginTaskStateVersion', 'preAttemptControlVersion', 'postBeginControlVersion', 'epoch', 'status',
] as const;
const CLOSURE_KEYS = [
  'receiptId', 'receiptDigest', 'claimId', 'taskId', 'reason', 'fencedExecutorIdentity', 'unconsumedReservations',
] as const;

/** Owns pending attempt starts and exposes a recovery path through the receiver that retained the lease. */
export class RepositoryAttemptStartRecoveryV02 {
  private readonly statePort: StatePortV02 | undefined;
  private readonly handoff: RepositoryAttemptStartRecoveryHandoffV02 | undefined;
  private readonly outcomes: OutcomeRecoveryBoundaryV02;
  private readonly createUncertainOutcome: UncertainOutcomeFactoryV02;
  private readonly pending = new Map<string, PendingAttemptStartV02>();

  constructor(options: {
    readonly statePort?: StatePortV02 | undefined;
    readonly handoff?: RepositoryAttemptStartRecoveryHandoffV02 | undefined;
    readonly outcomes: OutcomeRecoveryBoundaryV02;
    readonly createUncertainOutcome: UncertainOutcomeFactoryV02;
  }) {
    this.statePort = options.statePort;
    this.handoff = options.handoff;
    this.outcomes = options.outcomes;
    this.createUncertainOutcome = options.createUncertainOutcome;
  }

  requireCapability(): void {
    if (!this.statePort || !this.handoff) {
      throw new Error('ATTEMPT_START_RECOVERY_REQUIRED: A trusted UC-04 owner query and StatePortV02 are required before attempt admission');
    }
  }

  hasPending(recoveryId: string): boolean { return this.pending.has(recoveryId); }

  register(
    lease: WorkspaceLease,
    admission: RepositoryAdmissionContextV02,
    claim: ClaimReceiptV02,
    executorIdentity: ExecutorIdentityV02,
    isRepairPatch: boolean,
  ): string {
    const recoveryId = `attempt-start:${randomUUID()}`;
    this.pending.set(recoveryId, {
      recoveryId,
      lease,
      admission: deepCloneFreeze(admission),
      claim: deepCloneFreeze(claim),
      executorIdentity: deepCloneFreeze(executorIdentity),
      isRepairPatch,
      recovering: false,
      leaseReleaseAttempted: false,
      outcomeRecorded: false,
    });
    return recoveryId;
  }

  async recover(recoveryId: string): Promise<RepositoryAttemptStartRecoveryResultV02> {
    const pending = this.pending.get(recoveryId);
    if (!pending || pending.recovering) return { outcome: 'blocked', recoveryId };
    if (!this.statePort || !this.handoff) return { outcome: 'blocked', recoveryId };
    pending.recovering = true;
    try {
      if (pending.attempt) return await this.recoverCommitted(pending);
      if (pending.closureReceipt) return await this.closeUnattempted(pending);
      const reply: unknown = await this.handoff.queryAttemptStart({
        recoveryId,
        admission: pending.admission,
        claim: pending.claim,
        executorIdentity: pending.executorIdentity,
      });
      if (!isPlainRecord(reply) || typeof reply['outcome'] !== 'string') return { outcome: 'blocked', recoveryId };
      if (reply['outcome'] === 'unknown' && hasExactKeys(reply, ['outcome'])) return { outcome: 'blocked', recoveryId };
      if (reply['outcome'] === 'committed' && hasExactKeys(reply, ['outcome', 'attempt'])) {
        const candidate = reply['attempt'];
        if (!isPlainRecord(candidate) || !hasExactKeys(candidate, ATTEMPT_KEYS) || !isExecutorIdentity(candidate['executorIdentity'])) {
          return { outcome: 'blocked', recoveryId };
        }
        const validated = validateAttemptReceiptV02(candidate, {
          expectedTaskId: pending.claim.taskId,
          expectedClaimId: pending.claim.claimId,
          expectedEpoch: pending.claim.epoch,
          isRepairPatch: pending.isRepairPatch,
        });
        if (!validated.ok || !matchesRepositoryAttemptV02(validated.value, pending.claim, pending.executorIdentity)) {
          return { outcome: 'blocked', recoveryId };
        }
        pending.attempt = deepCloneFreeze(validated.value);
        return await this.recoverCommitted(pending);
      }
      if (reply['outcome'] === 'unattempted' && hasExactKeys(reply, ['outcome', 'claim', 'closureReceipt'])) {
        const proof = validateNoAttemptClaim(reply['claim'], pending.claim);
        const candidate = reply['closureReceipt'];
        if (!proof || !isPlainRecord(candidate) || !hasExactKeys(candidate, CLOSURE_KEYS) ||
          !safeStringArray(candidate['unconsumedReservations'])) return { outcome: 'blocked', recoveryId };
        const fenced = candidate['fencedExecutorIdentity'];
        if (!isExecutorIdentity(fenced) || fenced.adapterIdentity !== pending.executorIdentity.adapterIdentity ||
          fenced.processIncarnation !== pending.executorIdentity.processIncarnation ||
          fenced.payloadDigest !== pending.executorIdentity.payloadDigest ||
          fenced.fencingGeneration <= pending.executorIdentity.fencingGeneration) {
          return { outcome: 'blocked', recoveryId };
        }
        const closure = validateClaimClosureReceiptV02(candidate, {
          expectedTaskId: pending.claim.taskId,
          expectedClaimId: pending.claim.claimId,
          claim: proof as unknown as Record<string, unknown>,
          hasCommittedAttempt: false,
          expectedAdapterIdentity: pending.executorIdentity.adapterIdentity,
          expectedMinFencingGeneration: pending.executorIdentity.fencingGeneration + 1,
          expectedFencedExecutorIdentity: fenced,
        });
        if (!closure.ok) return { outcome: 'blocked', recoveryId };
        pending.closureReceipt = deepCloneFreeze(closure.value);
        return await this.closeUnattempted(pending);
      }
      return { outcome: 'blocked', recoveryId };
    } catch {
      return { outcome: 'blocked', recoveryId };
    } finally {
      pending.recovering = false;
    }
  }

  private async recoverCommitted(pending: PendingAttemptStartV02): Promise<RepositoryAttemptStartRecoveryResultV02> {
    const attempt = pending.attempt;
    const statePort = this.statePort;
    if (!attempt || !statePort) return { outcome: 'blocked', recoveryId: pending.recoveryId };
    try {
      if (!pending.outcome) pending.outcome = deepCloneFreeze(this.createUncertainOutcome(pending.claim, attempt, pending.admission));
      if (!pending.outcomeRecorded) {
        await this.outcomes.record(
          pending.lease,
          pending.admission,
          pending.claim,
          attempt,
          pending.outcome,
        );
        pending.outcomeRecorded = true;
      }
      if (!this.outcomes.hasPending(attempt.attemptId)) return { outcome: 'blocked', recoveryId: pending.recoveryId };
      const result: ReconciliationResultV02 = await this.outcomes.recover(attempt.attemptId);
      if (result.outcome !== 'settled') return { ...result, recoveryId: pending.recoveryId };
      this.pending.delete(pending.recoveryId);
      return { outcome: 'settled', recoveryId: pending.recoveryId, receiptId: result.receiptId };
    } catch {
      return { outcome: 'blocked', recoveryId: pending.recoveryId };
    }
  }

  private async closeUnattempted(pending: PendingAttemptStartV02): Promise<RepositoryAttemptStartRecoveryResultV02> {
    const receipt = pending.closureReceipt;
    const statePort = this.statePort;
    if (!receipt || !statePort || pending.leaseReleaseAttempted) return { outcome: 'blocked', recoveryId: pending.recoveryId };
    try {
      const result: unknown = await statePort.closeUnattemptedClaim(receipt);
      if (!isPlainRecord(result) || !hasExactKeys(result, ['closed', 'receiptId']) ||
        typeof result['closed'] !== 'boolean' || result['receiptId'] !== receipt.receiptId) {
        return { outcome: 'blocked', recoveryId: pending.recoveryId };
      }
      if (result['closed'] !== true) return { outcome: 'conflict', recoveryId: pending.recoveryId, receiptId: receipt.receiptId };
      await pending.lease.release();
      pending.leaseReleaseAttempted = true;
      this.pending.delete(pending.recoveryId);
      return { outcome: 'settled', recoveryId: pending.recoveryId, receiptId: receipt.receiptId };
    } catch {
      return { outcome: 'blocked', recoveryId: pending.recoveryId };
    }
  }
}

function validateNoAttemptClaim(input: unknown, expected: ClaimReceiptV02): (ClaimReceiptV02 & { readonly hasCommittedAttempt: false }) | null {
  if (!isPlainRecord(input) || !hasExactKeys(input, [...CLAIM_KEYS, 'hasCommittedAttempt']) || input['hasCommittedAttempt'] !== false) return null;
  const actual = input as unknown as ClaimReceiptV02 & { readonly hasCommittedAttempt: false };
  const actualValues = actual as unknown as Record<string, unknown>;
  const expectedValues = expected as unknown as Record<string, unknown>;
  if (CLAIM_KEYS.some((key) => key === 'reservationRefs'
    ? !sameStrings(actualValues[key], expectedValues[key])
    : actualValues[key] !== expectedValues[key])) return null;
  return actual;
}

function isExecutorIdentity(input: unknown): input is ExecutorIdentityV02 {
  return isPlainRecord(input) && hasExactKeys(input, ['adapterIdentity', 'processIncarnation', 'fencingGeneration', 'payloadDigest']) &&
    typeof input['adapterIdentity'] === 'string' && typeof input['processIncarnation'] === 'string' &&
    typeof input['payloadDigest'] === 'string' && Number.isSafeInteger(input['fencingGeneration']) &&
    (input['fencingGeneration'] as number) > 0;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  return Reflect.ownKeys(input).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = descriptors[key];
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value');
  });
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(record);
  return ownKeys.length === keys.length && ownKeys.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      return descriptor !== undefined && descriptor.enumerable && Object.hasOwn(descriptor, 'value');
    });
}

function sameStrings(left: unknown, right: unknown): boolean {
  const leftValues = safeStringArray(left);
  const rightValues = safeStringArray(right);
  return leftValues !== null && rightValues !== null && leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index]);
}

function safeStringArray(input: unknown): string[] | null {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return null;
  const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
  if (!Number.isSafeInteger(length) || (length as number) < 0) return null;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== (length as number) + 1 || !keys.includes('length')) return null;
  const values: string[] = [];
  for (let index = 0; index < (length as number); index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') return null;
    values.push(descriptor.value);
  }
  return values;
}

function deepCloneFreeze<T>(value: T): T {
  const clone = structuredClone(value);
  freezeDeep(clone, new WeakSet<object>());
  return clone;
}

function freezeDeep(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  Object.freeze(value);
}
