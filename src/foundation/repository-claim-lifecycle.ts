import type { ClaimReceiptV02, ExecutorIdentityV02, RepositoryAdmissionContextV02 } from '../contracts/foundation/uc03/ports-v02.ts';
import { computeCanonicalSha256 } from '../contracts/foundation/uc03.ts';
import type { AttemptReceiptV02 } from '../contracts/foundation/uc03/ports-v02.ts';
import type { DockerWorkspaceManager, StructuredCommandExecutor, WorkspaceLease } from './docker-workspace.ts';
import type { UnattemptedClaimClosureHandoffV02 } from './repository-types.ts';

interface PendingClaimClosureV02 {
  readonly lease: WorkspaceLease;
  readonly admission: RepositoryAdmissionContextV02;
  readonly claim: ClaimReceiptV02;
  readonly recipientIdentity: ExecutorIdentityV02;
  recovering: boolean;
}

export class ClaimClosurePendingError extends Error {
  readonly claimId: string;

  constructor(claimId: string) {
    super(`CLAIM_CLOSURE_PENDING: Claim '${claimId}' remains held for trusted UC-04 closure`);
    this.name = 'ClaimClosurePendingError';
    this.claimId = claimId;
  }
}

export class RepositoryAttemptStartPendingError extends Error {
  readonly claimId: string;

  constructor(claimId: string) {
    super(`ATTEMPT_START_PENDING: Claim '${claimId}' may have a committed attempt and remains held`);
    this.name = 'RepositoryAttemptStartPendingError';
    this.claimId = claimId;
  }
}

/** Holds the workspace lease until the injected UC-05/UC-04 boundary confirms closure. */
export class RepositoryClaimLifecycleV02 {
  private readonly handoff: UnattemptedClaimClosureHandoffV02 | undefined;
  private readonly pending = new Map<string, PendingClaimClosureV02>();

  constructor(handoff: UnattemptedClaimClosureHandoffV02 | undefined) {
    this.handoff = handoff;
  }

  requireClosureCapability(): void {
    if (!this.handoff) throw new Error('CLAIM_CLOSURE_REQUIRED: Trusted UC-05/UC-04 unattempted-claim closure is required before admission');
  }

  async closeUnattemptedClaim(
    lease: WorkspaceLease,
    admission: RepositoryAdmissionContextV02,
    claim: ClaimReceiptV02,
    recipientIdentity: ExecutorIdentityV02,
  ): Promise<boolean> {
    const pending = { lease, admission, claim, recipientIdentity, recovering: false };
    this.remember(pending);
    return await this.closePending(pending);
  }

  async recoverUnattemptedClaim(claimId: string): Promise<boolean> {
    const pending = this.pending.get(claimId);
    if (!pending || pending.recovering) return false;
    pending.recovering = true;
    try { return await this.closePending(pending); }
    finally { pending.recovering = false; }
  }

  hasPending(claimId: string): boolean {
    return this.pending.has(claimId);
  }

  private async closePending(pending: PendingClaimClosureV02): Promise<boolean> {
    try {
      const handoff = this.handoff;
      if (!handoff) return false;
      const result: unknown = await handoff.closeUnattemptedClaim({
        admission: pending.admission,
        claim: pending.claim,
        recipientIdentity: pending.recipientIdentity,
      });
      if (!isClosedClaimResult(result)) return false;
      await pending.lease.release();
      this.pending.delete(pending.claim.claimId);
      return true;
    } catch {
      return false;
    }
  }

  private remember(pending: PendingClaimClosureV02): void {
    const prior = this.pending.get(pending.claim.claimId);
    if (prior && (prior.claim.claimDigest !== pending.claim.claimDigest ||
      prior.admission.actionDigest !== pending.admission.actionDigest)) {
      throw new Error('CLAIM_CLOSURE_IDENTITY_CONFLICT: A different pending claim already owns this identity');
    }
    if (!prior) this.pending.set(pending.claim.claimId, pending);
  }
}

const claimKeys = [
  'claimId', 'claimDigest', 'taskId', 'runId', 'subjectKind', 'planApplicability',
  'preClaimTaskStateVersion', 'preClaimControlVersion', 'postClaimControlVersion',
  'epoch', 'status', 'reservationRefs',
] as const;

export function validateRepositoryClaimV02(
  input: unknown,
  context: RepositoryAdmissionContextV02,
): ClaimReceiptV02 | null {
  if (!isPlainRecord(input) || Object.keys(input).length !== claimKeys.length ||
    !claimKeys.every((key) => Object.hasOwn(input, key))) return null;
  if (context.subjectKind !== 'repository-action' ||
    typeof input['claimId'] !== 'string' || !input['claimId'].trim() ||
    typeof input['claimDigest'] !== 'string' ||
    input['taskId'] !== context.taskId || input['runId'] !== context.runId ||
    input['subjectKind'] !== context.subjectKind || input['planApplicability'] !== context.planApplicability ||
    input['preClaimTaskStateVersion'] !== context.expectedTaskStateVersion ||
    input['preClaimControlVersion'] !== context.expectedControlVersion ||
    input['postClaimControlVersion'] !== context.expectedControlVersion + 1 ||
    input['epoch'] !== context.expectedEpoch || input['status'] !== 'claimed' ||
    !sameStrings(input['reservationRefs'], context.reservationRefs) ||
    input['claimDigest'] !== computeCanonicalSha256({ ...input, claimDigest: undefined })) return null;
  return input as unknown as ClaimReceiptV02;
}

export function matchesRepositoryAttemptV02(
  attempt: AttemptReceiptV02,
  claim: ClaimReceiptV02,
  executorIdentity: ExecutorIdentityV02,
): boolean {
  return attempt.claimId === claim.claimId && attempt.taskId === claim.taskId &&
    attempt.epoch === claim.epoch && attempt.preAttemptTaskStateVersion === claim.preClaimTaskStateVersion &&
    attempt.preAttemptControlVersion === claim.postClaimControlVersion &&
    attempt.postBeginControlVersion === claim.postClaimControlVersion + 1 &&
    matchesRepositoryIdentityV02(attempt.executorIdentity, executorIdentity);
}

export function matchesRepositoryIdentityV02(actual: ExecutorIdentityV02, expected: ExecutorIdentityV02): boolean {
  return actual.adapterIdentity === expected.adapterIdentity && actual.processIncarnation === expected.processIncarnation &&
    actual.fencingGeneration === expected.fencingGeneration && actual.payloadDigest === expected.payloadDigest;
}

export function assertCurrentCommandFenceV02(
  manager: DockerWorkspaceManager,
  commandExecutor: StructuredCommandExecutor,
  lease: WorkspaceLease,
  workspaceId: string,
  identity: ExecutorIdentityV02,
  adapterIdentity: string,
  processIncarnation: string,
  receiverGeneration: number,
): void {
  const currentGeneration = manager.getFencingGeneration(workspaceId);
  if (lease.kind !== 'read' || lease.workspaceId !== workspaceId ||
    !Number.isSafeInteger(currentGeneration) || currentGeneration <= 0 ||
    lease.fencingGeneration !== currentGeneration || receiverGeneration !== currentGeneration ||
    commandExecutor.getFencingGeneration() !== currentGeneration ||
    identity.adapterIdentity !== adapterIdentity || identity.adapterIdentity !== commandExecutor.getAdapterIdentity() ||
    identity.processIncarnation !== processIncarnation || identity.processIncarnation !== commandExecutor.getProcessIncarnation() ||
    identity.fencingGeneration !== currentGeneration) {
    throw new Error('FENCED_EXECUTOR: Command receiver is stale at the invocation boundary');
  }
}

function isClosedClaimResult(input: unknown): input is { readonly closed: true; readonly receiptId: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const record = input as Record<string, unknown>;
  return Object.keys(record).length === 2 && Object.hasOwn(record, 'closed') && Object.hasOwn(record, 'receiptId') &&
    record['closed'] === true && typeof record['receiptId'] === 'string' && record['receiptId'].trim().length > 0;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function sameStrings(input: unknown, expected: readonly string[]): boolean {
  return Array.isArray(input) && input.length === expected.length &&
    input.every((value, index) => value === expected[index]);
}
