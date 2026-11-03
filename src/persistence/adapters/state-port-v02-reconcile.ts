/**
 * Reconciliation and unattempted-claim closure for the durable UC-03 v0.2 state port.
 *
 * A reconciliation settles a journal entry that a recorded outcome left uncertain or observed-but-
 * unsettled; a closure releases a claim that never dispatched. Both require a control hold and a
 * fencing proof, so neither can be driven by an unattended caller.
 */
import { computeCanonicalSha256, validateAttemptReconciliationReceiptV02, validateClaimClosureReceiptV02, validateProviderUsage, validateTaskState } from '../../contracts/foundation/uc03.ts';
import type {
  AttemptOutcomeReceiptV02,
  AttemptReconciliationReceiptV02,
  AttemptReconciliationValidationContextV02,
  BudgetLedger,
  ClaimClosureReceiptV02,
  ClaimClosureResultV02,
  ClaimClosureValidationContextV02,
  ReconciliationResultV02,
  SafeReferenceV02,
  TaskState,
} from '../../contracts/foundation/uc03.ts';
import { isSafeStorageId } from '../store.ts';
import type { StatePortStore } from './state-port-v02-storage.ts';
import type { ControlRecordV02, FenceProofV02, RecoveryEvidenceV02, StoredAttemptV02, StoredClaimV02 } from './state-port-v02-types.ts';
import { DEFAULT_CONTROL, NEUTRAL_CLAIM_CLOSURE_RESULT_V02, NEUTRAL_RECONCILIATION_RESULT_V02, SHA256 } from './state-port-v02-types.ts';
import { contextMatchesTask, equal, isDiagnosticPatch, isRepairPatch, isRepositoryPatch, observedPatchTaskState, safeRef, taskMatchesAttempt } from './state-port-v02-admission.ts';
import { observedCommandAccountingMatches, replaceLedgers, stageClaimReservations } from './state-port-v02-ledgers.ts';

function reconciliationContext(
  claim: StoredClaimV02,
  attempt: StoredAttemptV02,
  predecessor: AttemptOutcomeReceiptV02,
  receipt: AttemptReconciliationReceiptV02,
  task: TaskState,
  control: ControlRecordV02,
  evidenceRefs: readonly SafeReferenceV02[],
  evidence?: RecoveryEvidenceV02,
  fence?: FenceProofV02,
): AttemptReconciliationValidationContextV02 {
  const status = receipt.reconciliationKind === 'uncertain-attempt' ? 'uncertain' : 'observed-unsettled';
  return {
    trustedAdmission: claim.context,
    trustedClaim: claim.receipt,
    currentClaimStatus: status,
    predecessorJournalStatus: status,
    trustedAttempt: attempt.receipt,
    trustedPredecessor: predecessor,
    predecessorReceiptDigest: predecessor.receiptDigest,
    currentTaskStateVersion: task.stateVersion,
    currentControlVersion: control.controlVersion,
    currentEpoch: control.epoch,
    trustedEvidenceRefs: evidenceRefs,
    trustedAccountingIdentityDigest: computeCanonicalSha256({ predecessorReceiptDigest: predecessor.receiptDigest, reservationRefs: claim.receipt.reservationRefs }),
    ...(evidence
      ? {
          trustedObservedEffectRef: evidence.effectEvidenceRef,
          trustedAccountingEvidenceRefs: evidence.accountingEvidenceRefs,
          ...(evidence.observedUsage ? { trustedObservedUsage: evidence.observedUsage } : {}),
        }
      : {}),
    // The receipt names the pre-fence recipient; the raised generation is carried separately.
    ...(fence ? { trustedFencingProof: { fencedRecipientIdentity: fence.recipientIdentity, fencingGeneration: fence.fencingGeneration, proofRef: fence.proofRef } } : {}),
  };
}

export function isValidRecoveryEvidence(evidence: RecoveryEvidenceV02, claim: StoredClaimV02): boolean {
  if (!safeRef(evidence.effectEvidenceRef) || !evidence.accountingEvidenceRefs.length || !evidence.accountingEvidenceRefs.every(ref => safeRef(ref))) return false;
  if (claim.context.subjectKind === 'provider-request') {
    return evidence.observedUsage !== undefined && validateProviderUsage(evidence.observedUsage).ok && evidence.observedRevisionDigest === undefined && evidence.invalidatedEvidence === undefined;
  }
  if (isRepositoryPatch(claim.context)) {
    if (
      evidence.observedUsage !== undefined ||
      typeof evidence.observedRevisionDigest !== 'string' ||
      !SHA256.test(evidence.observedRevisionDigest) ||
      !Array.isArray(evidence.invalidatedEvidence) ||
      !evidence.invalidatedEvidence.every(ref => safeRef(ref)) ||
      new Set(evidence.invalidatedEvidence.map(ref => ref.reference)).size !== evidence.invalidatedEvidence.length
    )
      return false;
    return (
      evidence.effectEvidenceRef.digest ===
      computeCanonicalSha256({
        schemaVersion: 'uc03-observed-patch-recovery/0.2-draft',
        predecessorReceiptId: evidence.predecessorReceiptId,
        effectConfirmation: true,
        observedRevisionDigest: evidence.observedRevisionDigest,
        invalidatedEvidence: evidence.invalidatedEvidence,
        accountingEvidenceRefs: evidence.accountingEvidenceRefs,
      })
    );
  }
  return evidence.observedUsage === undefined && evidence.observedRevisionDigest === undefined && evidence.invalidatedEvidence === undefined;
}

async function reconciliationReplay(store: StatePortStore, taskId: string, receipt: AttemptReconciliationReceiptV02): Promise<ReconciliationResultV02 | null> {
  const prior = await store.readReconciliation(taskId, receipt.reconciliationId);
  if (!prior) return null;
  return equal(prior, receipt) ? { outcome: 'settled', receiptId: receipt.reconciliationId } : { outcome: 'conflict', receiptId: receipt.reconciliationId };
}

export async function reconcileObservedOutcome(store: StatePortStore, receipt: AttemptReconciliationReceiptV02): Promise<ReconciliationResultV02> {
  let snapshot: AttemptReconciliationReceiptV02;
  try {
    snapshot = structuredClone(receipt);
  } catch {
    return NEUTRAL_RECONCILIATION_RESULT_V02;
  }
  if (!snapshot || typeof snapshot !== 'object') return NEUTRAL_RECONCILIATION_RESULT_V02;
  const located = await store.findClaimTask(snapshot.claimId);
  if (!located) return NEUTRAL_RECONCILIATION_RESULT_V02;
  const taskId = located.taskId;
  return store.locked(taskId, async () => {
    const control = await store.readControl(taskId, DEFAULT_CONTROL);
    const replay = await reconciliationReplay(store, taskId, snapshot);
    if (replay) return replay;
    const predecessor = await store.readOutcome(taskId, snapshot.predecessorReceiptId);
    const claim = await store.readClaim(taskId, snapshot.claimId);
    const attempt = claim?.attemptId ? await store.readAttempt(taskId, claim.attemptId) : null;
    const conflict: ReconciliationResultV02 = { outcome: 'conflict', receiptId: snapshot.reconciliationId };
    if (
      !predecessor ||
      predecessor.outcome !== 'observed' ||
      predecessor.receiptDigest !== snapshot.predecessorReceiptDigest ||
      !claim ||
      claim.status !== 'observed-unsettled' ||
      claim.attemptId !== snapshot.attemptId ||
      !attempt ||
      attempt.outcomeReceiptId !== predecessor.receiptId ||
      control.epoch !== claim.receipt.epoch
    )
      return conflict;
    const task = await store.readTask(taskId);
    if (!task) return conflict;
    const validation = validateAttemptReconciliationReceiptV02(snapshot, reconciliationContext(claim, attempt, predecessor, snapshot, task, control, predecessor.evidenceRefs));
    const ledgers = task.budgetLedgers ?? [];
    if (!validation.ok || !observedCommandAccountingMatches(claim, predecessor, ledgers)) return conflict;

    const repairPatch = isRepairPatch(claim.context);
    const diagnosticPatch = isDiagnosticPatch(claim.context);
    let nextTask: TaskState | undefined;
    if (repairPatch || diagnosticPatch) {
      if (claim.context.subjectKind !== 'repository-action' || predecessor.subjectKind !== 'repository-action') return conflict;
      const transition = predecessor.proposedEffects.taskTransition;
      const resultRevision = predecessor.observedResultRevisionDigest;
      const transitionMatches = repairPatch ? transition.kind === 'transition' && transition.fromNode === 'Patch' && transition.toNode === 'Verify' : transition.kind === 'none';
      if (!resultRevision || !transitionMatches || !taskMatchesAttempt(claim, task, repairPatch, resultRevision)) return conflict;
      nextTask = observedPatchTaskState(task, predecessor.proposedEffects.invalidatedEvidence, resultRevision, repairPatch, ledgers);
      if (!validateTaskState(nextTask).ok) return conflict;
    } else if (!taskMatchesAttempt(claim, task, false, claim.taskSnapshot.repositoryRevisionDigest)) {
      return conflict;
    }

    if (nextTask) await store.writeTask(taskId, nextTask);
    await store.writeJson(store.statePath(taskId, `recon-${snapshot.reconciliationId}.json`), snapshot);
    await store.writeJson(store.statePath(taskId, `attempt-${attempt.receipt.attemptId}.json`), { ...attempt, status: 'settled' } satisfies StoredAttemptV02);
    await store.writeClaim(taskId, { ...claim, status: 'settled' });
    await store.writeControl(taskId, {
      ...control,
      controlVersion: control.controlVersion + 1,
      activeClaimId: control.activeClaimId === snapshot.claimId ? null : control.activeClaimId,
    });
    return { outcome: 'settled', receiptId: snapshot.reconciliationId };
  });
}

export async function reconcileUncertain(store: StatePortStore, receipt: AttemptReconciliationReceiptV02): Promise<ReconciliationResultV02> {
  let snapshot: AttemptReconciliationReceiptV02;
  try {
    snapshot = structuredClone(receipt);
  } catch {
    return NEUTRAL_RECONCILIATION_RESULT_V02;
  }
  if (!snapshot || typeof snapshot !== 'object') return NEUTRAL_RECONCILIATION_RESULT_V02;
  const located = await store.findClaimTask(snapshot.claimId);
  if (!located) return NEUTRAL_RECONCILIATION_RESULT_V02;
  const taskId = located.taskId;
  return store.locked(taskId, async () => {
    const control = await store.readControl(taskId, DEFAULT_CONTROL);
    const replay = await reconciliationReplay(store, taskId, snapshot);
    if (replay) return replay;
    const conflict: ReconciliationResultV02 = { outcome: 'conflict', receiptId: snapshot.reconciliationId };
    const predecessor = await store.readOutcome(taskId, snapshot.predecessorReceiptId);
    const claim = await store.readClaim(taskId, snapshot.claimId);
    const attempt = claim?.attemptId ? await store.readAttempt(taskId, claim.attemptId) : null;
    if (
      !predecessor ||
      predecessor.outcome !== 'uncertain' ||
      predecessor.receiptDigest !== snapshot.predecessorReceiptDigest ||
      !claim ||
      claim.status !== 'uncertain' ||
      claim.attemptId !== snapshot.attemptId ||
      !attempt ||
      attempt.outcomeReceiptId !== predecessor.receiptId ||
      control.epoch !== claim.receipt.epoch
    )
      return conflict;
    const task = await store.readTask(taskId);
    if (!task) return conflict;
    const disposition = (snapshot as unknown as Record<string, unknown>)['disposition'];
    const evidence = disposition === 'observed-and-accounted' ? await store.readRecovery(taskId, predecessor.receiptId) : null;
    const fence = await store.readFence(taskId, claim.receipt.claimId);
    if (!fence || (disposition === 'observed-and-accounted' && !evidence)) return conflict;
    if (fence.holdRef !== control.holdRef || control.mode === 'runnable') return { outcome: 'blocked', receiptId: snapshot.reconciliationId };
    if (evidence && !isValidRecoveryEvidence(evidence, claim)) return conflict;
    const trustedEvidence = evidence ? [evidence.effectEvidenceRef, ...evidence.accountingEvidenceRefs] : fence.adapterEvidenceRefs;
    const validation = validateAttemptReconciliationReceiptV02(snapshot, reconciliationContext(claim, attempt, predecessor, snapshot, task, control, trustedEvidence, evidence ?? undefined, fence));
    if (!validation.ok) return conflict;

    const ledgers = task.budgetLedgers ?? [];
    let staged = new Map<string, BudgetLedger>();
    let nextTask: TaskState | undefined;
    if (claim.context.subjectKind === 'provider-request') {
      if (disposition === 'observed-and-accounted') {
        if (!evidence?.observedUsage) return conflict;
        const next = stageClaimReservations(claim.context, ledgers, 'settle', evidence.observedUsage);
        if (!next) return conflict;
        staged = next;
      } else if (disposition === 'proven-not-dispatched') {
        const next = stageClaimReservations(claim.context, ledgers, 'release');
        if (!next) return conflict;
        staged = next;
      }
    } else if (disposition === 'observed-and-accounted') {
      const repairPatch = isRepairPatch(claim.context);
      if (isRepositoryPatch(claim.context)) {
        if (!evidence?.observedRevisionDigest || !evidence.invalidatedEvidence || !taskMatchesAttempt(claim, task, repairPatch, claim.taskSnapshot.repositoryRevisionDigest)) {
          return { outcome: 'blocked', receiptId: snapshot.reconciliationId };
        }
        nextTask = observedPatchTaskState(task, evidence.invalidatedEvidence, evidence.observedRevisionDigest, repairPatch, ledgers);
        if (!validateTaskState(nextTask).ok) return conflict;
      } else if (!taskMatchesAttempt(claim, task, false, claim.taskSnapshot.repositoryRevisionDigest)) {
        return { outcome: 'blocked', receiptId: snapshot.reconciliationId };
      }
      if (claim.context.action.kind === 'run_command') {
        const next = stageClaimReservations(claim.context, ledgers, 'settle');
        if (!next) return conflict;
        staged = next;
      }
    } else if (disposition === 'proven-not-dispatched' && claim.context.action.kind === 'run_command') {
      const next = stageClaimReservations(claim.context, ledgers, 'release');
      if (!next) return conflict;
      staged = next;
    }

    if (nextTask) await store.writeTask(taskId, nextTask);
    else if (staged.size) await store.writeTask(taskId, replaceLedgers(task, staged));
    await store.writeJson(store.statePath(taskId, `recon-${snapshot.reconciliationId}.json`), snapshot);
    await store.writeJson(store.statePath(taskId, `attempt-${attempt.receipt.attemptId}.json`), { ...attempt, status: 'settled' } satisfies StoredAttemptV02);
    await store.writeClaim(taskId, { ...claim, status: 'settled' });
    await store.writeControl(taskId, {
      ...control,
      controlVersion: control.controlVersion + 1,
      activeClaimId: control.activeClaimId === snapshot.claimId ? null : control.activeClaimId,
    });
    return { outcome: 'settled', receiptId: snapshot.reconciliationId };
  });
}

export async function closeUnattemptedClaim(store: StatePortStore, receipt: ClaimClosureReceiptV02): Promise<ClaimClosureResultV02> {
  let snapshot: ClaimClosureReceiptV02;
  try {
    snapshot = structuredClone(receipt);
  } catch {
    return NEUTRAL_CLAIM_CLOSURE_RESULT_V02;
  }
  if (!snapshot || typeof snapshot !== 'object' || !isSafeStorageId(snapshot.taskId)) return NEUTRAL_CLAIM_CLOSURE_RESULT_V02;
  const taskId = snapshot.taskId;
  return store.locked(taskId, async () => {
    const refused: ClaimClosureResultV02 = { closed: false, receiptId: snapshot.receiptId };
    const control = await store.readControl(taskId, DEFAULT_CONTROL);
    const prior = isSafeStorageId(snapshot.receiptId) ? await store.readJson<ClaimClosureReceiptV02>(store.statePath(taskId, `closure-${snapshot.receiptId}.json`)) : null;
    if (prior) return equal(prior, snapshot) ? { closed: true, receiptId: snapshot.receiptId } : refused;
    const claim = await store.readClaim(taskId, snapshot.claimId);
    if (!claim) return refused;
    const fence = await store.readFence(taskId, snapshot.claimId);
    if (
      claim.status !== 'claimed' ||
      claim.attemptId ||
      control.activeClaimId !== snapshot.claimId ||
      !fence ||
      control.mode === 'runnable' ||
      !control.holdRef ||
      fence.holdRef !== control.holdRef ||
      snapshot.reason !== control.holdRef ||
      !equal(snapshot.fencedExecutorIdentity, fence.fencedExecutorIdentity) ||
      !equal(snapshot.unconsumedReservations, claim.receipt.reservationRefs)
    )
      return refused;
    const validationContext: ClaimClosureValidationContextV02 = {
      expectedTaskId: claim.receipt.taskId,
      expectedClaimId: claim.receipt.claimId,
      claim: { ...claim.receipt, hasCommittedAttempt: false },
      hasCommittedAttempt: false,
      expectedAdapterIdentity: fence.fencedExecutorIdentity.adapterIdentity,
      expectedMinFencingGeneration: fence.fencingGeneration,
      expectedFencedExecutorIdentity: fence.fencedExecutorIdentity,
    };
    if (!validateClaimClosureReceiptV02(snapshot, validationContext).ok) return refused;
    const task = await store.readTask(taskId);
    if (!task || !contextMatchesTask(claim.context, task)) return refused;
    const staged = stageClaimReservations(claim.context, task.budgetLedgers ?? [], 'release', undefined, true);
    if (!staged) return refused;
    if (!isSafeStorageId(snapshot.receiptId)) return refused;
    await store.writeTask(taskId, replaceLedgers(task, staged));
    await store.writeJson(store.statePath(taskId, `closure-${snapshot.receiptId}.json`), snapshot);
    await store.writeClaim(taskId, { ...claim, status: 'closed' });
    await store.writeControl(taskId, {
      ...control,
      controlVersion: control.controlVersion + 1,
      activeClaimId: control.activeClaimId === snapshot.claimId ? null : control.activeClaimId,
    });
    return { closed: true, receiptId: snapshot.receiptId };
  });
}
