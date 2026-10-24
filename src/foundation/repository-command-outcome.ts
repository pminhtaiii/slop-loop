import { computeCanonicalSha256 } from '../contracts/foundation/uc03.ts';
import { computeAdmissionDigest } from '../contracts/foundation/uc03/admission-v02.ts';
import {
  computeAttemptOutcomeDigest,
  validateAttemptReconciliationReceiptV02,
  validateRepositoryActionOutcomeReceiptV02,
} from '../contracts/foundation/uc03/attempt-v02.ts';
import type {
  AttemptReceiptV02,
  ClaimReceiptV02,
  OutcomeRecordResultV02,
  ReconciliationResultV02,
  RepositoryActionOutcomeReceiptV02,
  RepositoryAdmissionContextV02,
} from '../contracts/foundation/uc03/ports-v02.ts';
import type { AttemptOutcomeValidationContextV02, AttemptReconciliationValidationContextV02 } from '../contracts/foundation/uc03/attempt-v02.ts';
import type { StructuredExecutionResult, WorkspaceLease } from './docker-workspace.ts';
import type { ControlledRepositoryToolsOptions, PatchRecoveryPreparationV02 } from './repository-types.ts';

export interface NormalizedCommandResultV02 {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly outcome: StructuredExecutionResult['outcome'];
  readonly truncated: boolean;
  readonly digest: string;
}

export function normalizeCommandResult(input: unknown): NormalizedCommandResultV02 | null {
  if (!isPlainRecord(input) || !isPlainRecord(input['plan']) ||
    input['exitCode'] !== null && (!Number.isSafeInteger(input['exitCode']) || (input['exitCode'] as number) < 0) ||
    typeof input['stdout'] !== 'string' || typeof input['stderr'] !== 'string' ||
    typeof input['durationMs'] !== 'number' || !Number.isFinite(input['durationMs']) || input['durationMs'] < 0 ||
    typeof input['timedOut'] !== 'boolean' || !['success', 'failure', 'timeout', 'error'].includes(String(input['outcome'])) ||
    typeof input['truncated'] !== 'boolean') return null;
  const fields = {
    exitCode: input['exitCode'] as number | null,
    stdout: input['stdout'] as string,
    stderr: input['stderr'] as string,
    durationMs: input['durationMs'] as number,
    timedOut: input['timedOut'] as boolean,
    outcome: input['outcome'] as StructuredExecutionResult['outcome'],
    truncated: input['truncated'] as boolean,
  };
  return { ...fields, digest: computeCanonicalSha256(fields) };
}

export function createCommandOutcomeReceipt(
  claim: ClaimReceiptV02,
  attempt: AttemptReceiptV02,
  context: RepositoryAdmissionContextV02,
  outcome: 'observed' | 'uncertain',
  normalized?: NormalizedCommandResultV02,
): RepositoryActionOutcomeReceiptV02 {
  if (context.action.kind !== 'run_command') throw new Error('INVALID_COMMAND_ADMISSION: Command receipt requires an admitted run-command action');
  if (outcome === 'observed' && !normalized) throw new Error('INVALID_COMMAND_RESULT: Observed command settlement requires a normalized result');
  const resultDigest = computeCanonicalSha256({
    attemptId: attempt.attemptId,
    actionDigest: context.actionDigest,
    outcome,
    ...(normalized ? { observedResultDigest: normalized.digest } : {}),
  });
  const resultRef = { reference: `command-result-${resultDigest.slice(7)}`, digest: resultDigest };
  const planFields = context.planApplicability === 'approved-plan'
    ? {
        planApplicability: context.planApplicability,
        planBindingDigest: context.planBindingDigest,
        planDecisionRef: context.planDecisionRef,
        ...(context.diagnosticPurpose !== undefined ? { diagnosticPurpose: context.diagnosticPurpose } : {}),
        ...(context.taskCriteriaDigest !== undefined ? { taskCriteriaDigest: context.taskCriteriaDigest } : {}),
        ...(context.checkSetDigest !== undefined ? { checkSetDigest: context.checkSetDigest } : {}),
      }
    : {
        planApplicability: context.planApplicability,
        diagnosticPurpose: context.diagnosticPurpose,
        taskCriteriaDigest: context.taskCriteriaDigest,
        checkSetDigest: context.checkSetDigest,
      };
  const decisionFields = context.policyEvaluationReceipt.result === 'APPROVAL_REQUIRED'
    ? context.actionDecisionReceipt
      ? { actionDecisionReceiptRef: context.actionDecisionReceipt.decisionId, actionDecisionReceiptDigest: context.actionDecisionReceipt.decisionDigest }
      : (() => { throw new Error('MISSING_ACTION_DECISION_RECEIPT: Command outcome requires the admitted action decision'); })()
    : {};
  const raw = {
    receiptId: `repo-out-${resultDigest.slice(7)}`,
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
      epoch: claim.epoch,
    },
    resultRef,
    evidenceRefs: [resultRef],
    proposedEffects: {
      taskTransition: { kind: 'none' as const },
      revision: { kind: 'preserve' as const },
      invalidatedEvidence: [],
      accounting: { disposition: outcome === 'observed' ? 'settle' as const : 'hold' as const, reservationRefs: [...claim.reservationRefs] },
    },
    subjectKind: 'repository-action' as const,
    actionDigest: context.actionDigest,
    repositoryOperation: 'run-command' as const,
    outcome,
    policyAuthorityRef: context.policyAuthorityRef,
    policyEvaluationReceiptRef: context.policyEvaluationReceipt.receiptId,
    policyEvaluationReceiptDigest: context.policyEvaluationReceipt.receiptDigest,
    freshnessContextDigest: context.policyEvaluationReceipt.freshnessContextDigest,
    ...planFields,
    ...decisionFields,
  };
  const receipt = { ...raw, receiptDigest: computeAttemptOutcomeDigest(raw) };
  const validationContext: AttemptOutcomeValidationContextV02 = {
    trustedAdmission: context,
    trustedClaim: claim,
    trustedAttempt: attempt,
    currentClaimStatus: 'attempting',
    currentTaskStateVersion: attempt.postBeginTaskStateVersion,
    currentControlVersion: attempt.postBeginControlVersion,
    currentEpoch: attempt.epoch,
  };
  const validation = validateRepositoryActionOutcomeReceiptV02(receipt, validationContext);
  if (!validation.ok) throw new Error(`INVALID_COMMAND_OUTCOME_RECEIPT: ${validation.errors.map((item) => item.code).join(',')}`);
  return validation.value;
}

interface PendingRepositoryOutcomeV02 {
  readonly lease: WorkspaceLease;
  readonly context: RepositoryAdmissionContextV02;
  readonly claim: ClaimReceiptV02;
  readonly attempt: AttemptReceiptV02;
  readonly outcome: RepositoryActionOutcomeReceiptV02;
  recovering: boolean;
}

export class RepositoryOutcomeRecoveryV02 {
  private readonly options: ControlledRepositoryToolsOptions;
  private readonly pending = new Map<string, PendingRepositoryOutcomeV02>();

  constructor(options: ControlledRepositoryToolsOptions) { this.options = options; }

  hasPending(attemptId: string): boolean { return this.pending.has(attemptId); }

  async record(
    lease: WorkspaceLease,
    context: RepositoryAdmissionContextV02,
    claim: ClaimReceiptV02,
    attempt: AttemptReceiptV02,
    outcome: RepositoryActionOutcomeReceiptV02,
  ): Promise<OutcomeRecordResultV02> {
    const statePort = this.options.statePort;
    if (!statePort) throw new Error('STATE_PORT_REQUIRED: StatePortV02 is required for repository receiver execution');
    try {
      const recorded = validateOutcomeRecordResult(await statePort.recordOutcome(outcome), outcome.receiptId);
      if (outcome.outcome !== 'observed' || recorded.outcome !== 'settled') this.hold(lease, context, claim, attempt, outcome);
      return recorded;
    } catch (error: unknown) {
      this.hold(lease, context, claim, attempt, outcome);
      throw error;
    }
  }

  async recover(attemptId: string): Promise<ReconciliationResultV02> {
    const pending = this.pending.get(attemptId);
    if (!pending) throw new Error('REPOSITORY_OUTCOME_RECOVERY_NOT_FOUND: No locally held repository outcome matches this attempt');
    if (pending.recovering) throw new Error('REPOSITORY_OUTCOME_RECOVERY_IN_PROGRESS: Recovery is already running');
    const statePort = this.options.statePort;
    const handoff = this.options.patchRecoveryHandoff;
    if (!statePort || !handoff) throw new Error('REPOSITORY_OUTCOME_RECOVERY_REQUIRED: StatePortV02 and its UC-04 recovery handoff are required');
    pending.recovering = true;
    try {
      const prepared = await handoff.prepare({
        admission: pending.context,
        claim: pending.claim,
        attempt: pending.attempt,
        outcome: pending.outcome,
      });
      validateRecoveryPreparation(prepared, pending);
      const receipt = prepared.receipt;
      const result = validateReconciliationResult(
        receipt.reconciliationKind === 'observed-unsettled'
          ? await statePort.reconcileObservedOutcome(receipt)
          : await statePort.reconcileUncertain(receipt),
        receipt.reconciliationId,
      );
      if (result.outcome === 'settled') {
        await pending.lease.release();
        this.pending.delete(attemptId);
      }
      return result;
    } finally {
      pending.recovering = false;
    }
  }

  private hold(
    lease: WorkspaceLease,
    context: RepositoryAdmissionContextV02,
    claim: ClaimReceiptV02,
    attempt: AttemptReceiptV02,
    outcome: RepositoryActionOutcomeReceiptV02,
  ): void {
    const prior = this.pending.get(attempt.attemptId);
    if (prior && prior.outcome.receiptDigest !== outcome.receiptDigest) {
      throw new Error('REPOSITORY_OUTCOME_IDENTITY_CONFLICT: A different immutable outcome already owns this attempt');
    }
    if (!prior) this.pending.set(attempt.attemptId, { lease, context, claim, attempt, outcome, recovering: false });
  }
}

export function validateOutcomeRecordResult(input: unknown, receiptId: string): OutcomeRecordResultV02 {
  if (!isPlainRecord(input) || Object.keys(input).length !== 2 ||
    !['settled', 'recorded-unsettled', 'already-recorded', 'uncertain'].includes(String(input['outcome'])) ||
    input['receiptId'] !== receiptId) {
    throw new Error('INVALID_OUTCOME_RECORD_RESULT: StatePort returned a mismatched repository outcome result');
  }
  return input as unknown as OutcomeRecordResultV02;
}

export function validateReconciliationResult(input: unknown, receiptId: string): ReconciliationResultV02 {
  if (!isPlainRecord(input) || Object.keys(input).length !== 2 ||
    (input['outcome'] !== 'settled' && input['outcome'] !== 'blocked' && input['outcome'] !== 'conflict') ||
    input['receiptId'] !== receiptId) {
    throw new Error('INVALID_RECONCILIATION_RESULT: StatePort returned a mismatched repository recovery result');
  }
  return input as unknown as ReconciliationResultV02;
}

function validateRecoveryPreparation(prepared: PatchRecoveryPreparationV02, pending: PendingRepositoryOutcomeV02): void {
  if (!prepared || typeof prepared !== 'object' || !prepared.receipt || !prepared.validationContext) {
    throw new Error('REPOSITORY_RECOVERY_EVIDENCE_INVALID: UC-04 recovery handoff returned incomplete evidence');
  }
  const { receipt, validationContext } = prepared;
  const expectedKind = pending.outcome.outcome === 'uncertain' ? 'uncertain-attempt' : 'observed-unsettled';
  const trustedAttempt = validationContext?.trustedAttempt;
  const trustedClaim = validationContext?.trustedClaim;
  const trustedPredecessor = validationContext?.trustedPredecessor;
  if (receipt.reconciliationKind !== expectedKind || receipt.claimId !== pending.claim.claimId ||
    receipt.attemptId !== pending.attempt.attemptId || receipt.predecessorReceiptId !== pending.outcome.receiptId ||
    receipt.predecessorReceiptDigest !== pending.outcome.receiptDigest || receipt.subjectKind !== 'repository-action' ||
    receipt.actionDigest !== pending.context.actionDigest || receipt.admissionDigest !== computeAdmissionDigest(pending.context) ||
    computeCanonicalSha256(validationContext.trustedAdmission) !== computeCanonicalSha256(pending.context) ||
    computeCanonicalSha256(validationContext.trustedClaim) !== computeCanonicalSha256(pending.claim) ||
    computeCanonicalSha256(validationContext.trustedAttempt) !== computeCanonicalSha256(pending.attempt) ||
    computeCanonicalSha256(validationContext.trustedPredecessor) !== computeCanonicalSha256(pending.outcome) ||
    trustedClaim?.claimId !== pending.claim.claimId || trustedClaim.claimDigest !== pending.claim.claimDigest ||
    trustedAttempt?.attemptId !== pending.attempt.attemptId || trustedAttempt.claimId !== pending.claim.claimId ||
    trustedPredecessor?.receiptId !== pending.outcome.receiptId || trustedPredecessor.receiptDigest !== pending.outcome.receiptDigest) {
    throw new Error('REPOSITORY_RECOVERY_BINDING_MISMATCH: UC-04 recovery facts do not match the held repository attempt');
  }
  const validation = validateAttemptReconciliationReceiptV02(receipt, validationContext as AttemptReconciliationValidationContextV02);
  if (!validation.ok) throw new Error(`INVALID_REPOSITORY_RECOVERY_RECEIPT: ${validation.errors.map((item) => item.code).join(',')}`);
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}
