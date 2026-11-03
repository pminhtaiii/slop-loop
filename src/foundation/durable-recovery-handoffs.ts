/**
 * Stand-in recovery handoffs over DurableStatePortV02, for composing ControlledRepositoryTools
 * on a real-provenance command path.
 *
 * These are NOT the UC-04/UC-05 owner deliveries. They implement only what a command attempt
 * needs: the pre-attempt claim closure (pause, fence, close) and an attempt-start query answered
 * from durable claim state. Patch reconciliation is deliberately unimplemented and refuses by name.
 */
import { computeCanonicalSha256 } from '../contracts/foundation/uc03.ts';
import { computeClaimClosureDigest } from '../contracts/foundation/uc03/v02/attempt.ts';
import type { ClaimClosureReceiptV02, ClaimClosureResultV02 } from '../contracts/foundation/uc03/v02/ports.ts';
import type { DurableStatePortV02 } from '../persistence/adapters/state-port-v02.ts';
import type {
  PatchRecoveryHandoffV02,
  RepositoryAttemptStartRecoveryHandoffV02,
  RepositoryAttemptStartRecoveryRequestV02,
  UnattemptedClaimClosureHandoffV02,
  UnattemptedClaimClosureRequestV02,
} from '../foundation/repository-types.ts';

function pauseRef(claimId: string): string {
  return `pause-claim-${claimId}`;
}

/** Pause on the claim, fence the recipient, then close with the fenced identity. */
export function createDurableUnattemptedClaimClosureHandoff(statePort: DurableStatePortV02): UnattemptedClaimClosureHandoffV02 {
  return {
    async closeUnattemptedClaim(request: UnattemptedClaimClosureRequestV02): Promise<ClaimClosureResultV02> {
      const { admission, claim, recipientIdentity } = request;
      const eventRef = pauseRef(claim.claimId);
      if (!(await statePort.setTaskControl(admission.taskId, 'paused', eventRef))) return { closed: false, receiptId: '' };

      const fence = await statePort.fenceClaimRecipient(claim.claimId, recipientIdentity);
      if (!fence) return { closed: false, receiptId: '' };

      const unsigned = {
        receiptId: `closure-${computeCanonicalSha256({ claimId: claim.claimId, proofRef: fence.proofRef, eventRef }).slice(7, 27)}`,
        claimId: claim.claimId,
        taskId: claim.taskId,
        reason: eventRef,
        fencedExecutorIdentity: fence.fencedExecutorIdentity,
        unconsumedReservations: [...claim.reservationRefs],
      };
      const receipt: ClaimClosureReceiptV02 = { ...unsigned, receiptDigest: computeClaimClosureDigest(unsigned) };
      return await statePort.closeUnattemptedClaim(receipt);
    },
  };
}

/**
 * Answers the attempt-start query from durable claim state: a committed attempt, or the fenced
 * unattempted claim plus its closure receipt. Anything it cannot prove stays 'unknown', which
 * blocks the attempt instead of guessing. The reply is re-validated by the recovery boundary.
 */
export function createDurableAttemptStartRecoveryHandoff(statePort: Pick<DurableStatePortV02, 'readClaimState'>): RepositoryAttemptStartRecoveryHandoffV02 {
  return {
    async queryAttemptStart(request: RepositoryAttemptStartRecoveryRequestV02): Promise<unknown> {
      const state = await statePort.readClaimState(request.claim.claimId);
      if (!state || state.claim.taskId !== request.claim.taskId || state.claim.claimDigest !== request.claim.claimDigest) return { outcome: 'unknown' };
      if (state.attempt && state.status !== 'claimed') return { outcome: 'committed', attempt: state.attempt };
      if (state.closure && state.fence && /^pause-claim-/.test(state.closure.reason)) {
        const fenced = state.fence.fencedExecutorIdentity;
        // The recovery boundary requires a strictly newer generation than the requester's.
        if (fenced.fencingGeneration <= request.executorIdentity.fencingGeneration) return { outcome: 'unknown' };
        return {
          outcome: 'unattempted',
          claim: { ...state.claim, hasCommittedAttempt: false },
          closureReceipt: state.closure,
        };
      }
      return { outcome: 'unknown' };
    },
  };
}

/**
 * shortcut: the receiver only requires a patch recovery handoff to be present on the command
 * path; patch reconciliation needs UC-04-trusted evidence this adapter cannot mint. It refuses
 * by name rather than fabricating a receipt. Implement when a real patch closure is in scope.
 */
export function createRefusingPatchRecoveryHandoff(): PatchRecoveryHandoffV02 {
  return {
    async prepare(): Promise<never> {
      throw new Error('PATCH_RECOVERY_UNSUPPORTED: no trusted UC-04 reconciliation evidence is available to this adapter');
    },
  };
}
