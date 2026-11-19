/**
 * Provider outcome receipt construction for the UC-03 v0.2 host model ingress.
 *
 * Split out of `model-v02.ts` to keep that file inside the 20 KB source bound; the receipt is pure
 * data assembly over the trusted admission, claim and attempt, with no port access.
 */
import {
  type AttemptReceiptV02,
  type ClaimReceiptV02,
  type ProviderAdmissionContextV02,
  type ProviderRequestOutcomeReceiptV02,
  type ProviderUsage,
  computeAdmissionDigest,
  computeAttemptOutcomeDigest,
  computeCanonicalSha256,
} from '../contracts/foundation/uc03.ts';

export function buildProviderOutcomeReceipt(
  context: ProviderAdmissionContextV02,
  claim: ClaimReceiptV02,
  attempt: AttemptReceiptV02,
  outcome: 'observed' | 'uncertain',
  rawPayload: unknown,
  observedUsage?: ProviderUsage,
): ProviderRequestOutcomeReceiptV02 {
  const references = [context.requestReservationReceipt, ...context.budgetRefs];
  const receiptId = `prov-out-${attempt.attemptId}`;
  const resultRef = { reference: `res-${attempt.attemptId}`, digest: computeCanonicalSha256(rawPayload) };
  const evidenceRefs = [{ reference: `ev-${attempt.attemptId}`, digest: computeCanonicalSha256(rawPayload) }];

  const raw: Record<string, unknown> = {
    receiptId,
    receiptDigest: 'sha256:placeholder',
    claimId: claim.claimId,
    claimDigest: claim.claimDigest,
    attemptId: attempt.attemptId,
    executorIdentity: attempt.executorIdentity,
    admissionDigest: computeAdmissionDigest(context),
    versions: {
      taskStateSchemaVersion: context.taskStateSchemaVersion,
      controlSchemaVersion: context.controlSchemaVersion,
      preClaimTaskStateVersion: claim.preClaimTaskStateVersion,
      postClaimTaskStateVersion: claim.preClaimTaskStateVersion,
      postAttemptTaskStateVersion: attempt.postBeginTaskStateVersion,
      preClaimControlVersion: claim.preClaimControlVersion,
      postClaimControlVersion: claim.postClaimControlVersion,
      postAttemptControlVersion: attempt.postBeginControlVersion,
      epoch: context.expectedEpoch,
    },
    resultRef,
    evidenceRefs,
    proposedEffects: {
      taskTransition: { kind: 'none' },
      revision: { kind: 'not-applicable' },
      invalidatedEvidence: [],
      accounting: {
        disposition: outcome === 'observed' ? 'settle' : 'hold',
        reservationRefs: references,
        ...(observedUsage !== undefined ? { observedUsage } : {}),
      },
    },
    subjectKind: 'provider-request',
    planApplicability: context.planApplicability,
    providerRequestId: context.providerRequestId,
    requestContentDigest: context.requestContentDigest,
    role: context.role,
    outcome,
    providerAdmissionReceiptRef: context.providerAdmissionReceipt.receiptId,
    providerAdmissionReceiptDigest: context.providerAdmissionReceipt.receiptDigest,
    requestReservationReceiptRef: context.requestReservationReceipt,
    providerIdentity: context.providerIdentity,
    budgetRefs: [...context.budgetRefs],
    ...(observedUsage !== undefined ? { observedUsage } : {}),
    ...(context.planApplicability === 'approved-plan'
      ? {
          planBindingDigest: context.planBindingDigest,
          planDecisionRef: context.planDecisionRef,
          ...(context.diagnosticPurpose !== undefined ? { diagnosticPurpose: context.diagnosticPurpose } : {}),
          ...(context.taskCriteriaDigest !== undefined ? { taskCriteriaDigest: context.taskCriteriaDigest } : {}),
        }
      : {
          diagnosticPurpose: context.diagnosticPurpose,
          taskCriteriaDigest: context.taskCriteriaDigest,
        }),
  };

  return {
    ...raw,
    receiptDigest: computeAttemptOutcomeDigest(raw),
  } as unknown as ProviderRequestOutcomeReceiptV02;
}
