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
  ExecutorIdentityV02,
  OutcomeRecordResultV02,
  ReconciliationResultV02,
  RepositoryActionOutcomeReceiptV02,
  RepositoryAdmissionContextV02,
} from '../contracts/foundation/uc03/ports-v02.ts';
import type { AttemptOutcomeValidationContextV02 } from '../contracts/foundation/uc03/attempt-v02.ts';
import type { ApplyPatchAction } from '../contracts/foundation/uc03/types.ts';
import type { WorkspaceLease } from './docker-workspace.ts';
import { bindPatchToAdmission, snapshotRepositoryAdmission } from './repository-admission.ts';
import { assertCurrentPatchFence, beginRepositoryAttemptWithClaim, isPatchReceiverResult } from './repository-receiver.ts';
import type { ControlledRepositoryToolsOptions, PatchRecoveryPreparationV02 } from './repository-types.ts';

interface PendingPatchOutcome {
  readonly lease: WorkspaceLease;
  readonly context: RepositoryAdmissionContextV02;
  readonly claim: ClaimReceiptV02;
  readonly attempt: AttemptReceiptV02;
  readonly outcome?: RepositoryActionOutcomeReceiptV02 | undefined;
  recovering: boolean;
}

export class PatchOutcomePendingError extends Error {
  readonly attemptId: string;

  constructor(attemptId: string) {
    super(`PATCH_OUTCOME_PENDING: Patch attempt '${attemptId}' is held for UC-04 settlement or recovery`);
    this.name = 'PatchOutcomePendingError';
    this.attemptId = attemptId;
  }
}

export class RepositoryPatchReceiver {
  private readonly consumedAttempts = new Set<string>();
  private readonly pendingOutcomes = new Map<string, PendingPatchOutcome>();
  private readonly options: ControlledRepositoryToolsOptions;
  private fencingGeneration: number;

  constructor(options: ControlledRepositoryToolsOptions) {
    this.options = options;
    this.fencingGeneration = options.fencingGeneration ?? options.commandExecutor?.getFencingGeneration?.() ?? 0;
  }

  setFencingGeneration(generation: number): void {
    this.fencingGeneration = generation;
  }

  async applyPatch(
    patch: ApplyPatchAction,
    context?: RepositoryAdmissionContextV02,
  ): Promise<{ readonly applied: boolean; readonly newRevisionDigest: string }> {
    if (!context) throw new Error('NOT_IMPLEMENTED: applyPatch without v0.2 context is not implemented in v0.1 compatibility slice');
    const admitted = bindPatchToAdmission(patch, snapshotRepositoryAdmission(context, 'apply_patch'));
    const admittedContext = admitted.context;
    const admittedPatch = admitted.patch;
    const manager = this.options.workspaceManager;
    const statePort = this.options.statePort;
    const patchReceiver = this.options.patchReceiver;
    const recoveryHandoff = this.options.patchRecoveryHandoff;
    if (this.options.neutralStub) throw new Error('NEUTRAL_RECEIVER_STUB: Positive execution not implemented in T049 neutral stub');
    if (!patchReceiver) throw new Error('PATCH_RECEIVER_REQUIRED: A patch effect receiver is required');
    if (!manager) throw new Error('WORKSPACE_GATE_REQUIRED: A workspace manager is required for patch execution');
    if (!statePort) throw new Error('STATE_PORT_REQUIRED: StatePortV02 is required for repository receiver execution');
    if (!recoveryHandoff) throw new Error('PATCH_RECOVERY_REQUIRED: A typed UC-04 recovery handoff is required before patch admission');
    const adapterIdentity = this.options.adapterIdentity ?? this.options.commandExecutor?.getAdapterIdentity?.() ?? '';
    const processIncarnation = this.options.processIncarnation ?? this.options.commandExecutor?.getProcessIncarnation?.() ?? '';
    if (!adapterIdentity || !processIncarnation || !Number.isSafeInteger(this.fencingGeneration) || this.fencingGeneration <= 0) {
      throw new Error('EXECUTOR_IDENTITY_REQUIRED: Patch execution requires a configured adapter incarnation and fencing generation');
    }

    const lease = await manager.acquireWriteLease(admittedContext.workspaceId, admitted.baseRevision);
    let current: { readonly claim: ClaimReceiptV02; readonly attempt: AttemptReceiptV02 } | undefined;
    let dispatchStarted = false;
    try {
      if (lease.canonicalRevision !== admitted.baseRevision || manager.getCanonicalRevision(admittedContext.workspaceId) !== admitted.baseRevision) {
        throw new Error(`STALE_REVISION_DRIFT: Base revision drift under workspace lease: expected '${admitted.baseRevision}'`);
      }
      const currentRevision = await this.options.fsPort.getCurrentRevisionDigest();
      if (currentRevision !== admitted.baseRevision) {
        throw new Error(`STALE_REVISION_DRIFT: Base revision drift under workspace lease: expected '${admitted.baseRevision}', got '${currentRevision}'`);
      }

      const generation = manager.getFencingGeneration(admittedContext.workspaceId);
      assertCurrentPatchFence(lease, admittedContext.workspaceId, generation, this.fencingGeneration);
      const executor: ExecutorIdentityV02 = {
        adapterIdentity,
        processIncarnation,
        fencingGeneration: generation,
        payloadDigest: admittedContext.actionDigest,
      };
      current = await beginRepositoryAttemptWithClaim(
        statePort,
        admittedContext,
        executor,
        admittedContext.planApplicability === 'approved-plan' && admittedContext.runnableNode === 'Repair',
        () => assertCurrentPatchFence(lease, admittedContext.workspaceId, manager.getFencingGeneration(admittedContext.workspaceId), this.fencingGeneration),
      );
      assertCurrentPatchFence(lease, admittedContext.workspaceId, manager.getFencingGeneration(admittedContext.workspaceId), this.fencingGeneration);
      if (this.consumedAttempts.has(current.attempt.attemptId)) {
        throw new Error('DUPLICATE_ATTEMPT: Patch attempt was already consumed by this receiver incarnation');
      }
      this.consumedAttempts.add(current.attempt.attemptId);
      dispatchStarted = true;

      const resultInput: unknown = await patchReceiver(admittedPatch, admittedContext, current.attempt);
      if (!isPatchReceiverResult(resultInput) || !resultInput.applied) {
        throw new Error('PATCH_RESULT_UNCERTAIN: Patch receiver did not confirm an applied canonical revision');
      }
      const fsRevision = await this.options.fsPort.getCurrentRevisionDigest();
      if (fsRevision !== resultInput.newRevisionDigest || manager.getCanonicalRevision(admittedContext.workspaceId) !== resultInput.newRevisionDigest) {
        throw new Error('PATCH_REVISION_UNVERIFIED: Patch result does not match the current filesystem and workspace revisions');
      }
      const outcome = createPatchOutcomeReceipt(current.claim, current.attempt, admittedContext, 'observed', resultInput.newRevisionDigest);
      return await this.recordOutcome(lease, admittedContext, current.claim, current.attempt, outcome, resultInput);
    } catch (error: unknown) {
      if (!current || !dispatchStarted || this.pendingOutcomes.has(current.attempt.attemptId)) throw error;
      try {
        const outcome = createPatchOutcomeReceipt(current.claim, current.attempt, admittedContext, 'uncertain');
        return await this.recordOutcome(lease, admittedContext, current.claim, current.attempt, outcome);
      } catch (pendingError: unknown) {
        if (!this.pendingOutcomes.has(current.attempt.attemptId)) {
          this.hold(lease, admittedContext, current.claim, current.attempt);
        }
        throw pendingError;
      }
    } finally {
      if (!current || !this.pendingOutcomes.has(current.attempt.attemptId)) await lease.release();
    }
  }

  async recoverPatchOutcome(attemptId: string): Promise<ReconciliationResultV02> {
    const pending = this.pendingOutcomes.get(attemptId);
    if (!pending) throw new Error('PATCH_RECOVERY_NOT_FOUND: No locally held patch outcome matches this attempt');
    if (!pending.outcome) throw new Error('PATCH_RECOVERY_EVIDENCE_MISSING: UC-04 outcome receipt is unavailable for recovery');
    if (pending.recovering) throw new Error('PATCH_RECOVERY_IN_PROGRESS: Patch recovery is already running');
    const statePort = this.options.statePort;
    const handoff = this.options.patchRecoveryHandoff;
    if (!statePort || !handoff) throw new Error('PATCH_RECOVERY_REQUIRED: StatePortV02 and its recovery handoff are required');

    pending.recovering = true;
    try {
      const prepared = await handoff.prepare({
        admission: pending.context,
        claim: pending.claim,
        attempt: pending.attempt,
        outcome: pending.outcome,
      });
      this.validateRecoveryPreparation(prepared, pending);
      const receipt = prepared.receipt;
      const resultInput: unknown = receipt.reconciliationKind === 'observed-unsettled'
        ? await statePort.reconcileObservedOutcome(receipt)
        : await statePort.reconcileUncertain(receipt);
      const result = validateReconciliationResult(resultInput, receipt.reconciliationId);
      if (result.outcome === 'settled') {
        await pending.lease.release();
        this.pendingOutcomes.delete(attemptId);
      }
      return result;
    } finally {
      pending.recovering = false;
    }
  }

  private async recordOutcome(
    lease: WorkspaceLease,
    context: RepositoryAdmissionContextV02,
    claim: ClaimReceiptV02,
    attempt: AttemptReceiptV02,
    receipt: RepositoryActionOutcomeReceiptV02,
    result?: { readonly applied: boolean; readonly newRevisionDigest: string },
  ): Promise<{ readonly applied: boolean; readonly newRevisionDigest: string }> {
    const statePort = this.options.statePort;
    if (!statePort) throw new Error('STATE_PORT_REQUIRED: StatePortV02 is required for repository receiver execution');
    try {
      const resultInput: unknown = await statePort.recordOutcome(receipt);
      const recorded = validateOutcomeRecordResult(resultInput, receipt.receiptId);
      if (receipt.outcome === 'observed' && recorded.outcome === 'settled' && result) return result;
      this.hold(lease, context, claim, attempt, receipt);
      throw new PatchOutcomePendingError(attempt.attemptId);
    } catch (error: unknown) {
      if (this.pendingOutcomes.has(attempt.attemptId)) throw error;
      this.hold(lease, context, claim, attempt, receipt);
      throw new PatchOutcomePendingError(attempt.attemptId);
    }
  }

  private validateRecoveryPreparation(prepared: PatchRecoveryPreparationV02, pending: PendingPatchOutcome): void {
    if (!prepared || typeof prepared !== 'object' || !prepared.receipt || !prepared.validationContext) {
      throw new Error('PATCH_RECOVERY_EVIDENCE_INVALID: UC-04 recovery handoff returned incomplete evidence');
    }
    const { receipt, validationContext } = prepared;
    const expectedKind = pending.outcome?.outcome === 'uncertain' ? 'uncertain-attempt' : 'observed-unsettled';
    const trustedAttempt = validationContext?.trustedAttempt;
    const trustedClaim = validationContext?.trustedClaim;
    const trustedPredecessor = validationContext?.trustedPredecessor;
    if (receipt.reconciliationKind !== expectedKind || receipt.claimId !== pending.claim.claimId ||
      receipt.attemptId !== pending.attempt.attemptId || receipt.predecessorReceiptId !== pending.outcome?.receiptId ||
      receipt.predecessorReceiptDigest !== pending.outcome?.receiptDigest ||
      receipt.subjectKind !== 'repository-action' || receipt.actionDigest !== pending.context.actionDigest ||
      receipt.admissionDigest !== computeAdmissionDigest(pending.context) ||
      computeCanonicalSha256(validationContext.trustedAdmission) !== computeCanonicalSha256(pending.context) ||
      computeCanonicalSha256(validationContext.trustedClaim) !== computeCanonicalSha256(pending.claim) ||
      computeCanonicalSha256(validationContext.trustedAttempt) !== computeCanonicalSha256(pending.attempt) ||
      computeCanonicalSha256(validationContext.trustedPredecessor) !== computeCanonicalSha256(pending.outcome) ||
      trustedClaim?.claimId !== pending.claim.claimId || trustedClaim.claimDigest !== pending.claim.claimDigest ||
      trustedAttempt?.attemptId !== pending.attempt.attemptId || trustedAttempt.claimId !== pending.claim.claimId ||
      trustedPredecessor?.receiptId !== pending.outcome?.receiptId || trustedPredecessor.receiptDigest !== pending.outcome?.receiptDigest) {
      throw new Error('PATCH_RECOVERY_BINDING_MISMATCH: UC-04 recovery facts do not match the held patch attempt');
    }
    const validation = validateAttemptReconciliationReceiptV02(receipt, validationContext);
    if (!validation.ok) throw new Error(`INVALID_PATCH_RECOVERY_RECEIPT: ${validation.errors.map((item) => item.code).join(',')}`);
  }

  private hold(
    lease: WorkspaceLease,
    context: RepositoryAdmissionContextV02,
    claim: ClaimReceiptV02,
    attempt: AttemptReceiptV02,
    outcome?: RepositoryActionOutcomeReceiptV02,
  ): void {
    this.pendingOutcomes.set(attempt.attemptId, { lease, context, claim, attempt, outcome, recovering: false });
  }
}

function createPatchOutcomeReceipt(
  claim: ClaimReceiptV02,
  attempt: AttemptReceiptV02,
  context: RepositoryAdmissionContextV02,
  outcome: 'observed' | 'uncertain',
  resultRevision?: string,
): RepositoryActionOutcomeReceiptV02 {
  if (context.action.kind !== 'apply_patch') throw new Error('INVALID_PATCH_ADMISSION: Patch receipt requires an admitted patch action');
  if (outcome === 'observed' && (!resultRevision || !/^sha256:[a-f0-9]{64}$/u.test(resultRevision))) {
    throw new Error('INVALID_PATCH_RESULT: Observed patch settlement requires a canonical revision from the receiver');
  }
  const resultIdentity = outcome === 'observed'
    ? { attemptId: attempt.attemptId, actionDigest: context.actionDigest, observedResultRevisionDigest: resultRevision }
    : { attemptId: attempt.attemptId, actionDigest: context.actionDigest, outcome: 'uncertain' };
  const resultDigest = computeCanonicalSha256(resultIdentity);
  const resultRef = { reference: `patch-result-${resultDigest.slice(7)}`, digest: resultDigest };
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
      : (() => { throw new Error('MISSING_ACTION_DECISION_RECEIPT: Patch outcome requires the admitted action decision'); })()
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
      taskTransition: outcome === 'observed' && context.planApplicability === 'approved-plan'
        ? { kind: 'transition', fromNode: 'Patch', toNode: 'Verify' }
        : { kind: 'none' },
      revision: outcome === 'observed' && resultRevision
        ? { kind: 'advance', revisionDigest: resultRevision }
        : { kind: 'preserve' },
      invalidatedEvidence: [],
      accounting: {
        disposition: outcome === 'observed' ? 'settle' : 'hold',
        reservationRefs: [...claim.reservationRefs],
      },
    },
    subjectKind: 'repository-action',
    actionDigest: context.actionDigest,
    repositoryOperation: 'apply-patch',
    outcome,
    policyAuthorityRef: context.policyAuthorityRef,
    policyEvaluationReceiptRef: context.policyEvaluationReceipt.receiptId,
    policyEvaluationReceiptDigest: context.policyEvaluationReceipt.receiptDigest,
    freshnessContextDigest: context.policyEvaluationReceipt.freshnessContextDigest,
    ...(outcome === 'observed' && resultRevision ? { observedResultRevisionDigest: resultRevision } : {}),
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
  if (!validation.ok) throw new Error(`INVALID_PATCH_OUTCOME_RECEIPT: ${validation.errors.map((item) => item.code).join(',')}`);
  return validation.value;
}

function validateOutcomeRecordResult(input: unknown, receiptId: string): OutcomeRecordResultV02 {
  if (!isPlainRecord(input) || Object.keys(input).length !== 2 ||
    !['settled', 'recorded-unsettled', 'already-recorded', 'uncertain'].includes(String(input['outcome'])) ||
    input['receiptId'] !== receiptId) {
    throw new Error('INVALID_OUTCOME_RECORD_RESULT: StatePort returned a mismatched patch outcome result');
  }
  return input as unknown as OutcomeRecordResultV02;
}

function validateReconciliationResult(input: unknown, receiptId: string): ReconciliationResultV02 {
  if (!isPlainRecord(input) || Object.keys(input).length !== 2 ||
    (input['outcome'] !== 'settled' && input['outcome'] !== 'blocked' && input['outcome'] !== 'conflict') ||
    input['receiptId'] !== receiptId) {
    throw new Error('INVALID_RECONCILIATION_RESULT: StatePort returned a mismatched patch recovery result');
  }
  return input as unknown as ReconciliationResultV02;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}
