/**
 * Provider admission fixture shared by the T059 gate rows and the C10 refusal witness.
 *
 * A provider request admitted by the canonical validator, bound to one task's persisted control head.
 * It is trusted host input: every value derives from the task, the current state and the journal, so
 * the same builder serves a dispatch row and a refusal row without either guessing at owner facts.
 */
import type { BugTask, ProviderAdmissionContextV02, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { computeCanonicalSha256, computeRequestContentDigest, validateAdmissionV02 } from '../../../src/contracts/foundation/uc03.ts';
import { computeContextDigest } from '../../../src/foundation/model.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';

/** The requested model id the operator re-pinned on 2026-11-22 (decisions.md). */
export const PINNED_MODEL = 'nvidia/nemotron-3.5-lightning:free';
/** The exact identity the endpoint returns for `PINNED_MODEL`; the operator accepted it on 2026-11-22. */
export const PINNED_RETURNED_MODEL = 'nvidia/nemotron-3.5-lightning:free';

/** The admitted maxima a provider admission declares; the C10 row raises them over the run ceiling. */
export interface ProviderBounds {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxBillableTokens: number;
  readonly maxCostUsd: number;
  readonly maxReviewerIterations?: number | undefined;
}

const DEFAULT_BOUNDS: ProviderBounds = { maxInputTokens: 8_000, maxOutputTokens: 2_000, maxBillableTokens: 12_000, maxCostUsd: 0.5 };

/**
 * Builds and validates one provider admission for `role` at `generation`. The bounds are part of the
 * admission the owner admits, so a row may raise them without touching the task or the journal.
 */
export function providerContext(
  state: TaskState,
  task: BugTask,
  journal: { readonly controlVersion: number; readonly epoch: number },
  role: 'coder' | 'reviewer',
  providerRequestId: string,
  generation: number,
  bounds: ProviderBounds = DEFAULT_BOUNDS,
): ProviderAdmissionContextV02 {
  const reservationRef = `res-${providerRequestId}`;
  const budgetRefs = [
    `b-tokens-${providerRequestId}`,
    `b-cost-${providerRequestId}`,
    `r-tokens-${providerRequestId}`,
    `r-cost-${providerRequestId}`,
    ...(role === 'reviewer' ? [`b-iter-${providerRequestId}`] : []),
  ];
  const providerIdentity = {
    providerId: 'provider-deepseek',
    modelId: PINNED_MODEL,
    configId: task.configId,
    configVersion: task.configVersion,
    pricingPolicyId: task.configId,
    pricingPolicyVersion: task.configVersion,
    issuerKeyRef: `host-${task.configId}`,
    decisionAuthorityGeneration: generation,
  };
  const providerRequest = {
    providerRequestId,
    taskId: state.taskId,
    runId: state.runId,
    role,
    purpose: role === 'reviewer' ? 'final-review' : 'propose_fix_plan',
    providerId: providerIdentity.providerId,
    modelId: PINNED_MODEL,
    configId: task.configId,
    pricingPolicyId: task.configId,
    contextDigest: computeContextDigest(state, []),
    timeoutMs: 60_000,
    maxInputTokens: bounds.maxInputTokens,
    maxOutputTokens: bounds.maxOutputTokens,
    maxBillableTokens: bounds.maxBillableTokens,
    maxCostUsd: bounds.maxCostUsd,
    reservationRef,
    dispatchState: 'reserved' as const,
  };
  const requestContentDigest = computeRequestContentDigest(providerRequest);
  const providerAdmissionReceipt = {
    receiptId: `par-${providerRequestId}`,
    receiptDigest: sha256Text(`rec-${providerRequestId}`),
    providerRequestId,
    role,
    requestContentDigest,
    providerId: providerIdentity.providerId,
    modelId: PINNED_MODEL,
    configId: task.configId,
    configVersion: task.configVersion,
    decisionAuthorityGeneration: generation,
  };
  const finiteBounds = {
    maxInputTokens: bounds.maxInputTokens,
    maxOutputTokens: bounds.maxOutputTokens,
    maxBillableTokens: bounds.maxBillableTokens,
    maxCostUsd: bounds.maxCostUsd,
    ...(role === 'reviewer' ? { maxReviewerIterations: bounds.maxReviewerIterations ?? 2 } : {}),
  };
  const context: Record<string, unknown> = {
    schemaVersion: '0.2.0',
    subjectKind: 'provider-request',
    planApplicability: 'pre-plan-diagnostic',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: state.stateVersion,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: journal.controlVersion,
    expectedEpoch: journal.epoch,
    taskId: state.taskId,
    runId: state.runId,
    runnableNode: state.node,
    providerRequest,
    providerRequestId,
    role,
    requestContentDigest,
    providerIdentity,
    providerAdmissionReceipt,
    requestReservationReceipt: reservationRef,
    budgetRefs,
    finiteBounds,
    diagnosticPurpose: 'investigate',
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
  };
  const admitted = validateAdmissionV02(context, {
    subjectKind: 'provider-request',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: state.stateVersion,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: journal.controlVersion,
    expectedEpoch: journal.epoch,
    taskId: state.taskId,
    runId: state.runId,
    runnableNode: state.node,
    planApplicability: 'pre-plan-diagnostic',
    diagnosticPurpose: 'investigate',
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    role,
    providerRequestId,
    requestContentDigest,
    providerAdmissionReceiptRef: providerAdmissionReceipt.receiptId,
    providerAdmissionReceiptDigest: providerAdmissionReceipt.receiptDigest,
    requestReservationReceipt: reservationRef,
    budgetRefs,
    providerIdentity,
    requestLimits: { timeoutMs: 60_000, ...finiteBounds },
  });
  if (!admitted.ok) throw new Error(`PROVIDER_CONTEXT_INVALID ${JSON.stringify(admitted.errors)}`);
  return admitted.value as ProviderAdmissionContextV02;
}
