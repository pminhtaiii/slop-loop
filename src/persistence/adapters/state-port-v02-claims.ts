/**
 * Claim lifecycle for the durable UC-03 v0.2 state port: claim, begin attempt, record outcome.
 *
 * Every operation re-reads the journal under the task lock, re-validates the receipt against the
 * facts it finds, and only then writes. A refusal returns the neutral result, never a partial write.
 */
import {
  computeCanonicalSha256,
  validateAttemptOutcomeReceiptV02,
  validateAttemptReceiptV02,
  validateProtocolVersionProgressionV02,
  validateProviderUsage,
  validateTaskState,
} from '../../contracts/foundation/uc03.ts';
import type {
  AdmissionContextV02,
  AttemptOutcomeReceiptV02,
  AttemptOutcomeValidationContextV02,
  AttemptReceiptV02,
  BudgetLedger,
  ClaimReceiptV02,
  ExecutorIdentityV02,
  OutcomeRecordResultV02,
  TaskState,
} from '../../contracts/foundation/uc03.ts';
import { isSafeStorageId } from '../store.ts';
import type { StatePortStore } from './state-port-v02-storage.ts';
import type { ControlRecordV02, StoredAttemptV02, StoredClaimV02 } from './state-port-v02-types.ts';
import { DEFAULT_CONTROL, NEUTRAL_ATTEMPT_RECEIPT_V02, NEUTRAL_CLAIM_RECEIPT_V02, NEUTRAL_OUTCOME_RECORD_RESULT_V02 } from './state-port-v02-types.ts';
import {
  actorPayloadDigest,
  authorityFor,
  contextMatchesTask,
  deriveTrustedContext,
  equal,
  isDiagnosticPatch,
  isRepairPatch,
  isRepositoryPatch,
  observedPatchTaskState,
  taskMatchesAttempt,
  taskSemantic,
  validExecutorIdentity,
} from './state-port-v02-admission.ts';
import { providerSpecs, replaceLedgers, reviewerIterationSpecs, stageClaimReservations, stageReservation } from './state-port-v02-ledgers.ts';

export interface ClaimOperationOptions {
  readonly store: StatePortStore;
  readonly initialControl: ControlRecordV02;
}

function outcomeContext(claim: StoredClaimV02, attempt: StoredAttemptV02, task: TaskState, control: ControlRecordV02): AttemptOutcomeValidationContextV02 {
  return {
    trustedAdmission: claim.context,
    trustedClaim: claim.receipt,
    trustedAttempt: attempt.receipt,
    currentClaimStatus: 'attempting',
    currentTaskStateVersion: task.stateVersion,
    currentControlVersion: control.controlVersion,
    currentEpoch: control.epoch,
  };
}

export async function claim(options: ClaimOperationOptions, context: AdmissionContextV02): Promise<ClaimReceiptV02> {
  const { store } = options;
  let snapshot: AdmissionContextV02;
  try {
    snapshot = structuredClone(context);
  } catch {
    return NEUTRAL_CLAIM_RECEIPT_V02;
  }
  if (!snapshot || typeof snapshot !== 'object' || !isSafeStorageId(snapshot.taskId)) return NEUTRAL_CLAIM_RECEIPT_V02;
  const taskId = snapshot.taskId;
  return store.locked(taskId, async () => {
    const control = await store.readControl(taskId, options.initialControl);
    if (control.mode !== 'runnable') return NEUTRAL_CLAIM_RECEIPT_V02;
    if (control.activeClaimId) {
      const active = await store.readClaim(taskId, control.activeClaimId);
      if (active && active.status !== 'settled' && active.status !== 'closed') {
        return equal(snapshot, active.context) && active.status === 'claimed' ? structuredClone(active.receipt) : NEUTRAL_CLAIM_RECEIPT_V02;
      }
    }
    const task = await store.readTask(taskId);
    if (!task || !contextMatchesTask(snapshot, task) || control.controlVersion !== snapshot.expectedControlVersion || control.epoch !== snapshot.expectedEpoch) return NEUTRAL_CLAIM_RECEIPT_V02;
    const authorityRef = authorityFor(snapshot);
    if (!control.activeAuthorityRef || !equal(control.activeAuthorityRef, authorityRef)) return NEUTRAL_CLAIM_RECEIPT_V02;

    const subjectId = snapshot.subjectKind === 'repository-action' ? snapshot.action.actionId : snapshot.providerRequestId;
    const claimId = `claim-${subjectId}`;
    const existing = await store.readClaim(taskId, claimId);
    if (existing) return existing.status === 'claimed' && equal(existing.context, snapshot) ? structuredClone(existing.receipt) : NEUTRAL_CLAIM_RECEIPT_V02;

    const staged = stageClaimReservations(snapshot, task.budgetLedgers ?? [], 'reserve');
    if (!staged) return NEUTRAL_CLAIM_RECEIPT_V02;
    const postClaimControlVersion = control.controlVersion + 1;
    const progression = validateProtocolVersionProgressionV02({
      kind: 'claim',
      pre: { taskStateVersion: task.stateVersion, controlVersion: control.controlVersion, epoch: control.epoch },
      post: { taskStateVersion: task.stateVersion, controlVersion: postClaimControlVersion, epoch: control.epoch },
    });
    if (!progression.ok) return NEUTRAL_CLAIM_RECEIPT_V02;
    const reservationRefs = snapshot.subjectKind === 'repository-action' ? [...snapshot.reservationRefs] : [snapshot.requestReservationReceipt, ...snapshot.budgetRefs];
    const rawReceipt: ClaimReceiptV02 = {
      claimId,
      claimDigest: '',
      taskId: snapshot.taskId,
      runId: snapshot.runId,
      subjectKind: snapshot.subjectKind,
      planApplicability: snapshot.planApplicability,
      preClaimTaskStateVersion: task.stateVersion,
      preClaimControlVersion: control.controlVersion,
      postClaimControlVersion,
      epoch: control.epoch,
      status: 'claimed',
      reservationRefs,
    };
    const receipt: ClaimReceiptV02 = { ...rawReceipt, claimDigest: computeCanonicalSha256({ ...rawReceipt, claimDigest: undefined }) };
    if (!isSafeStorageId(claimId)) return NEUTRAL_CLAIM_RECEIPT_V02;
    await store.writeTask(taskId, replaceLedgers(task, staged));
    await store.writeClaim(taskId, {
      receipt,
      context: snapshot,
      taskSnapshot: structuredClone(task),
      authorityRef,
      trustedAdmissionContext: deriveTrustedContext(snapshot),
      status: 'claimed',
    });
    await store.writeControl(taskId, { ...control, controlVersion: postClaimControlVersion, activeClaimId: claimId });
    return structuredClone(receipt);
  });
}

export async function beginAttempt(store: StatePortStore, claimId: string, executor: ExecutorIdentityV02): Promise<AttemptReceiptV02> {
  let actor: ExecutorIdentityV02;
  try {
    actor = structuredClone(executor);
  } catch {
    return NEUTRAL_ATTEMPT_RECEIPT_V02;
  }
  if (!validExecutorIdentity(actor)) return NEUTRAL_ATTEMPT_RECEIPT_V02;
  const located = await store.findClaimTask(claimId);
  if (!located) return NEUTRAL_ATTEMPT_RECEIPT_V02;
  const taskId = located.taskId;
  return store.locked(taskId, async () => {
    const control = await store.readControl(taskId, DEFAULT_CONTROL);
    const claimRecord = await store.readClaim(taskId, claimId);
    if (
      !claimRecord ||
      claimRecord.status !== 'claimed' ||
      control.activeClaimId !== claimId ||
      control.mode !== 'runnable' ||
      control.epoch !== claimRecord.receipt.epoch ||
      control.controlVersion !== claimRecord.receipt.postClaimControlVersion ||
      !control.activeAuthorityRef ||
      !equal(control.activeAuthorityRef, claimRecord.authorityRef) ||
      actor.payloadDigest !== actorPayloadDigest(claimRecord.context)
    )
      return NEUTRAL_ATTEMPT_RECEIPT_V02;
    const task = await store.readTask(taskId);
    if (!task || !contextMatchesTask(claimRecord.context, task) || !equal(taskSemantic(task), taskSemantic(claimRecord.taskSnapshot))) return NEUTRAL_ATTEMPT_RECEIPT_V02;

    const repairPatch = isRepairPatch(claimRecord.context);
    const nextTaskVersion = task.stateVersion + (repairPatch ? 1 : 0);
    const nextControlVersion = control.controlVersion + 1;
    const progression = validateProtocolVersionProgressionV02({
      kind: 'begin-attempt',
      isRepairPatch: repairPatch,
      pre: { taskStateVersion: task.stateVersion, controlVersion: control.controlVersion, epoch: control.epoch },
      post: { taskStateVersion: nextTaskVersion, controlVersion: nextControlVersion, epoch: control.epoch },
    });
    if (!progression.ok) return NEUTRAL_ATTEMPT_RECEIPT_V02;

    const attemptId = `att-${claimId}`;
    const receipt: AttemptReceiptV02 = {
      attemptId,
      claimId,
      taskId: claimRecord.receipt.taskId,
      executorIdentity: actor,
      preAttemptTaskStateVersion: task.stateVersion,
      postBeginTaskStateVersion: nextTaskVersion,
      preAttemptControlVersion: control.controlVersion,
      postBeginControlVersion: nextControlVersion,
      epoch: control.epoch,
      status: 'attempting',
    };
    if (
      !validateAttemptReceiptV02(receipt, {
        expectedTaskId: claimRecord.receipt.taskId,
        expectedClaimId: claimId,
        expectedAttemptId: attemptId,
        expectedEpoch: control.epoch,
        isRepairPatch: repairPatch,
      }).ok
    )
      return NEUTRAL_ATTEMPT_RECEIPT_V02;

    const ledgers = task.budgetLedgers ?? [];
    const staged = new Map<string, BudgetLedger>();
    if (repairPatch) {
      if (claimRecord.context.subjectKind !== 'repository-action') return NEUTRAL_ATTEMPT_RECEIPT_V02;
      const ledger = ledgers.find(item => item.scope === 'task' && item.kind === 'repair');
      const next = stageReservation(ledger, { reservationId: claimRecord.context.reservationRefs[0] ?? '', keyedId: claimRecord.context.action.actionId, amount: 1 }, 'consume');
      if (!next) return NEUTRAL_ATTEMPT_RECEIPT_V02;
      staged.set('task:repair', next);
    }
    if (claimRecord.context.subjectKind === 'provider-request' && claimRecord.context.role === 'reviewer') {
      const specs = reviewerIterationSpecs(claimRecord.context, ledgers);
      if (!specs?.length) return NEUTRAL_ATTEMPT_RECEIPT_V02;
      for (const spec of specs) {
        const key = `${spec.scope}:${spec.kind}`;
        const ledger = staged.get(key) ?? ledgers.find(item => item.scope === spec.scope && item.kind === spec.kind);
        const next = stageReservation(ledger, spec, 'consume');
        if (!next) return NEUTRAL_ATTEMPT_RECEIPT_V02;
        staged.set(key, next);
      }
    }
    const settled = replaceLedgers(task, staged);
    let nextTask: TaskState | undefined;
    if (repairPatch) {
      nextTask = { ...settled, node: 'Patch', stateVersion: nextTaskVersion };
      if (!validateTaskState(nextTask).ok) return NEUTRAL_ATTEMPT_RECEIPT_V02;
    }
    if (!isSafeStorageId(attemptId)) return NEUTRAL_ATTEMPT_RECEIPT_V02;
    await store.writeTask(taskId, nextTask ?? settled);
    await store.writeJson(store.statePath(taskId, `attempt-${attemptId}.json`), { receipt, claimId, status: 'attempting' } satisfies StoredAttemptV02);
    await store.writeClaim(taskId, { ...claimRecord, status: 'attempting', attemptId });
    await store.writeControl(taskId, { ...control, controlVersion: nextControlVersion });
    return structuredClone(receipt);
  });
}

export async function recordOutcome(store: StatePortStore, receipt: AttemptOutcomeReceiptV02): Promise<OutcomeRecordResultV02> {
  let snapshot: AttemptOutcomeReceiptV02;
  try {
    snapshot = structuredClone(receipt);
  } catch {
    return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
  }
  if (!snapshot || typeof snapshot !== 'object') return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
  const located = await store.findClaimTask(snapshot.claimId);
  if (!located) return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
  const taskId = located.taskId;
  return store.locked(taskId, async () => {
    const control = await store.readControl(taskId, DEFAULT_CONTROL);
    const prior = await store.readOutcome(taskId, snapshot.receiptId);
    if (prior) return equal(prior, snapshot) ? { outcome: 'already-recorded', receiptId: snapshot.receiptId } : NEUTRAL_OUTCOME_RECORD_RESULT_V02;
    const claimRecord = await store.readClaim(taskId, snapshot.claimId);
    const attempt = await store.readAttempt(taskId, snapshot.attemptId);
    if (
      !claimRecord ||
      !attempt ||
      attempt.claimId !== snapshot.claimId ||
      claimRecord.status !== 'attempting' ||
      claimRecord.attemptId !== attempt.receipt.attemptId ||
      attempt.status !== 'attempting' ||
      attempt.outcomeReceiptId !== undefined ||
      control.epoch !== claimRecord.receipt.epoch
    )
      return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
    const task = await store.readTask(taskId);
    if (!task || !validateAttemptOutcomeReceiptV02(snapshot, outcomeContext(claimRecord, attempt, task, control)).ok || snapshot.outcome === 'proven-not-dispatched')
      return NEUTRAL_OUTCOME_RECORD_RESULT_V02;

    const ledgers = task.budgetLedgers ?? [];
    let stagedLedgers = new Map<string, BudgetLedger>();
    if (snapshot.outcome === 'observed' && snapshot.subjectKind === 'provider-request') {
      if (!snapshot.observedUsage || !validateProviderUsage(snapshot.observedUsage).ok) return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
      const budgetRefs = claimRecord.context.subjectKind === 'provider-request' ? claimRecord.context.budgetRefs : [];
      const specs = providerSpecs(claimRecord.context, ledgers);
      if (!specs || specs.some(spec => !budgetRefs.includes(spec.reservationId))) return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
      const settled = stageClaimReservations(claimRecord.context, ledgers, 'settle', snapshot.observedUsage);
      if (!settled) return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
      stagedLedgers = settled;
    } else if (snapshot.outcome === 'observed' && snapshot.subjectKind === 'repository-action' && snapshot.repositoryOperation === 'run-command') {
      const settled = stageClaimReservations(claimRecord.context, ledgers, 'settle');
      if (!settled) return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
      stagedLedgers = settled;
    }

    let nextTask: TaskState | undefined;
    let isUnsettled = false;
    if (snapshot.outcome === 'observed' && snapshot.subjectKind === 'repository-action') {
      const transition = snapshot.proposedEffects.taskTransition;
      const repairPatch = isRepairPatch(claimRecord.context);
      const diagnosticPatch = isDiagnosticPatch(claimRecord.context);
      const expectedFromNode = repairPatch ? 'Patch' : claimRecord.context.runnableNode;
      const expectedToNode = repairPatch ? 'Verify' : undefined;
      if (repairPatch && (transition.kind !== 'transition' || transition.fromNode !== expectedFromNode || transition.toNode !== expectedToNode)) return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
      if (diagnosticPatch && transition.kind !== 'none') return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
      if (!repairPatch && transition.kind === 'transition') return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
      const expectedRevision = claimRecord.taskSnapshot.repositoryRevisionDigest;
      if (task.stateVersion !== attempt.receipt.postBeginTaskStateVersion || !taskMatchesAttempt(claimRecord, task, repairPatch, expectedRevision)) {
        isUnsettled = true;
      } else if (isRepositoryPatch(claimRecord.context)) {
        if (!snapshot.observedResultRevisionDigest) return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
        const settledTask = replaceLedgers(task, stagedLedgers);
        nextTask = observedPatchTaskState(settledTask, snapshot.proposedEffects.invalidatedEvidence, snapshot.observedResultRevisionDigest, repairPatch, settledTask.budgetLedgers ?? []);
        if (!validateTaskState(nextTask).ok) return NEUTRAL_OUTCOME_RECORD_RESULT_V02;
      }
    }

    const attemptPath = store.statePath(taskId, `attempt-${attempt.receipt.attemptId}.json`);
    if (nextTask) await store.writeTask(taskId, nextTask);
    else if (stagedLedgers.size) await store.writeTask(taskId, replaceLedgers(task, stagedLedgers));
    await store.writeJson(store.statePath(taskId, `outcome-${snapshot.receiptId}.json`), snapshot);
    const nextAttempt: StoredAttemptV02 = { ...attempt, outcomeReceiptId: snapshot.receiptId };
    if (snapshot.outcome === 'uncertain') {
      await store.writeJson(attemptPath, { ...nextAttempt, status: 'uncertain' } satisfies StoredAttemptV02);
      await store.writeClaim(taskId, { ...claimRecord, status: 'uncertain' });
      await store.writeControl(taskId, { ...control, controlVersion: control.controlVersion + 1 });
      return { outcome: 'uncertain', receiptId: snapshot.receiptId };
    }
    if (isUnsettled) {
      await store.writeJson(attemptPath, { ...nextAttempt, status: 'observed-unsettled' } satisfies StoredAttemptV02);
      await store.writeClaim(taskId, { ...claimRecord, status: 'observed-unsettled' });
      await store.writeControl(taskId, { ...control, controlVersion: control.controlVersion + 1 });
      return { outcome: 'recorded-unsettled', receiptId: snapshot.receiptId };
    }
    const settlement: OutcomeRecordResultV02 & { readonly outcome: 'settled' } = { outcome: 'settled', receiptId: snapshot.receiptId };
    await store.writeJson(attemptPath, { ...nextAttempt, status: 'settled' } satisfies StoredAttemptV02);
    await store.writeClaim(taskId, { ...claimRecord, status: 'settled', settlementResult: settlement });
    await store.writeControl(taskId, {
      ...control,
      controlVersion: control.controlVersion + 1,
      activeClaimId: control.activeClaimId === snapshot.claimId ? null : control.activeClaimId,
    });
    return settlement;
  });
}
