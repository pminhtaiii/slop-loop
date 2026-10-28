import { safeSnapshot } from '../contracts/foundation/uc03/v02/admission/snapshot.ts';
import { computeCanonicalSha256 } from '../contracts/foundation/uc03.ts';
import { validateAttemptReceiptV02 } from '../contracts/foundation/uc03/v02/attempt.ts';
import type { ClaimReceiptV02, AttemptReceiptV02, ProviderAdmissionContextV02, ExecutorIdentityV02 } from '../contracts/foundation/uc03/v02/ports.ts';
import { deepClone, deepFreeze } from './model.ts';

const claimKeys = ['claimId', 'claimDigest', 'taskId', 'runId', 'subjectKind', 'planApplicability',
  'preClaimTaskStateVersion', 'preClaimControlVersion', 'postClaimControlVersion', 'epoch', 'status', 'reservationRefs'];

export function providerClaim(input: unknown, context: ProviderAdmissionContextV02): ClaimReceiptV02 | null {
  const snapshot = safeSnapshot(input);
  if (!snapshot.ok || !snapshot.value || typeof snapshot.value !== 'object' || Array.isArray(snapshot.value)) return null;
  const copy = snapshot.value as Record<string, unknown>;
  if (Object.keys(copy).length !== claimKeys.length || !claimKeys.every((key) => Object.hasOwn(copy, key)) ||
    typeof copy['claimId'] !== 'string' || !copy['claimId'].trim() ||
    copy['taskId'] !== context.taskId || copy['runId'] !== context.runId ||
    copy['subjectKind'] !== context.subjectKind || copy['planApplicability'] !== context.planApplicability ||
    copy['preClaimTaskStateVersion'] !== context.expectedTaskStateVersion ||
    copy['preClaimControlVersion'] !== context.expectedControlVersion ||
    copy['postClaimControlVersion'] !== context.expectedControlVersion + 1 ||
    copy['epoch'] !== context.expectedEpoch || copy['status'] !== 'claimed' ||
    !Array.isArray(copy['reservationRefs']) ||
    computeCanonicalSha256(copy['reservationRefs']) !== computeCanonicalSha256([context.requestReservationReceipt, ...context.budgetRefs]) ||
    copy['claimDigest'] !== computeCanonicalSha256({ ...copy, claimDigest: undefined })) return null;
  // Exact shape, values and digest establish the canonical claim receipt.
  return deepFreeze(copy) as unknown as ClaimReceiptV02;
}

export function sameProviderActor(actual: Partial<ExecutorIdentityV02>, expected: Partial<ExecutorIdentityV02>): boolean {
  return actual.adapterIdentity === expected.adapterIdentity && actual.processIncarnation === expected.processIncarnation &&
    actual.fencingGeneration === expected.fencingGeneration;
}

export function providerAttempt(input: unknown, claim: ClaimReceiptV02, actor: ExecutorIdentityV02): AttemptReceiptV02 | null {
  const result = validateAttemptReceiptV02(input, {
    expectedTaskId: claim.taskId, expectedClaimId: claim.claimId, expectedEpoch: claim.epoch, isRepairPatch: false,
  });
  if (!result.ok) return null;
  const attempt = result.value;
  if (attempt.preAttemptTaskStateVersion !== claim.preClaimTaskStateVersion ||
    attempt.preAttemptControlVersion !== claim.postClaimControlVersion ||
    !sameProviderActor(attempt.executorIdentity, actor) || attempt.executorIdentity.payloadDigest !== actor.payloadDigest) return null;
  return deepFreeze(deepClone(attempt));
}
