import type { ValidationError } from '../../foundation/uc03.ts';
import type { DispatchClaimPhaseV02 } from './types.ts';
import { addError } from '../v01/validation.ts';
export const POLICY_EVALUATION_RECEIPT_KEYS = [
  'schemaVersion', 'receiptId', 'receiptDigest', 'actionDigest', 'freshnessContextDigest',
  'policyId', 'policyVersion', 'configId', 'configVersion', 'decisionAuthorityGeneration', 'result',
] as const;

export const ACTION_DECISION_RECEIPT_KEYS = [
  'schemaVersion', 'decisionId', 'decisionDigest', 'actionDigest', 'evaluationReceiptRef',
  'decisionAuthorityGeneration', 'status', 'reason',
] as const;

export const PROVIDER_ADMISSION_RECEIPT_KEYS = [
  'schemaVersion', 'receiptId', 'receiptDigest', 'providerRequestId', 'role',
  'policyId', 'policyVersion', 'requestContentDigest', 'providerId', 'modelId', 'configId', 'configVersion',
  'decisionAuthorityGeneration', 'planApplicability', 'planBindingDigest',
  'planDecisionRef', 'diagnosticPurpose', 'taskCriteriaDigest',
] as const;

export const CLAIM_CLOSURE_RECEIPT_KEYS = [
  'schemaVersion', 'receiptId', 'receiptDigest', 'claimId', 'claimDigest', 'taskId', 'runId',
  'taskStateSchemaVersion', 'expectedTaskStateVersion', 'controlSchemaVersion', 'expectedControlVersion',
  'expectedEpoch', 'reason', 'pauseOrDenialEvent', 'fencedExecutorIdentity', 'noAttemptProof',
  'reservationDispositions',
] as const;

export const PAUSE_OR_DENIAL_EVENT_KEYS = ['eventKind', 'eventRef', 'eventDigest'] as const;
export const NO_ATTEMPT_PROOF_KEYS = ['journalRef', 'journalDigest', 'claimPhase'] as const;
export const RESERVATION_DISPOSITION_KEYS = ['reservationRef', 'disposition'] as const;

export const EXECUTOR_IDENTITY_KEYS = [
  'adapterIdentity', 'processIncarnation', 'fencingGeneration', 'payloadDigest',
] as const;

export const DISPATCH_CLAIM_V02_KEYS = [
  'schemaVersion', 'claimId', 'claimDigest', 'taskId', 'runId', 'subjectKind',
  'planApplicability', 'taskStateSchemaVersion', 'expectedTaskStateVersion',
  'controlSchemaVersion', 'expectedControlVersion', 'expectedEpoch',
  'policyIdentity', 'decisionRefs', 'reservationRefs', 'phase', 'resultRef', 'attemptId',
  'actionId', 'actionDigest', 'repositoryStateDigest', 'providerRequestId',
  'requestContentDigest', 'role', 'planBindingDigest', 'planDecisionRef',
  'diagnosticPurpose', 'taskCriteriaDigest',
] as const;

export const DISPATCH_CLAIM_V02_PHASES: readonly DispatchClaimPhaseV02[] = [
  'claimed', 'attempting', 'dispatched', 'outcome-recorded', 'settled', 'uncertain', 'observed-unsettled',
];

export function validateNonNegativeInteger(input: unknown, path: string, errors: ValidationError[]): void {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) {
    addError(errors, path, 'INVALID_BOUND', `${path} must be a non-negative safe integer`);
  }
}

/** Validate PolicyEvaluationReceipt (v0.2). */
