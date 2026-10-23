import { isDeepStrictEqual } from 'node:util';
import type { ApprovalTaskControl, ClaimClosureReceipt, DispatchClaimV02 } from '../contracts/approvals/contracts.ts';
import {
  UC05_APPROVAL_SCHEMA_VERSION_V02,
  computeClaimClosureReceiptDigest,
  validateClaimClosureReceipt,
  validateApprovalTaskControl,
  validateDispatchClaim,
  validateDispatchClaimV02,
} from '../contracts/approvals/contracts.ts';
import { computeCanonicalSha256, validateTaskState } from '../contracts/foundation/uc03.ts';
import {
  computeClaimClosureDigest,
  validateClaimClosureReceiptV02,
  type ClaimClosureValidationContextV02,
} from '../contracts/foundation/uc03/attempt-v02.ts';
import type {
  ClaimClosureReceiptV02 as JournalClaimClosureReceiptV02,
  ClaimReceiptV02 as JournalClaimReceiptV02,
} from '../contracts/foundation/uc03/ports-v02.ts';
import { containsProtectedContent } from '../foundation/repository-tools.ts';
export {
  createApprovalContinuation,
  isExecutorCapability,
} from './recovery.ts';
export type {
  ApprovalContinuation,
  ApprovalRecoveryOwner,
  RecoverySnapshot,
  RecoveryClaimInput,
} from './recovery.ts';
export { createApprovalContinuationV02 } from './recovery-v02.ts';
export type { ApprovalContinuationV02, ApprovalContinuationResultV02 } from './recovery-v02.ts';
export type {
  ApprovalControlV02,
  AuthorityPublicationOptionsV02,
  AuthorityPublicationReceiptV02,
  CloseUnattemptedClaimInputV02,
  UC04JournalPortV02,
} from './control-v02.ts';
import {
  dataMethodV02,
  dataPropertyV02,
  exactKeysV02,
  executorIdentityV02,
  fenceProofV02,
  isDigestV02,
  isIdV02,
  journalClaimV02,
  journalSnapshotV02,
  matchesClaimV02,
  plainRecordV02,
  publishAuthorityV02,
  safeDataV02,
  type ApprovalControlV02,
  type UC04JournalPortV02,
} from './control-v02.ts';

export interface ApprovalActivity {
  readonly provenance: 'mock';
  admitAttempt(input: unknown): { readonly outcome: string; readonly value: unknown };
  fenceTask(input: { readonly taskId: string; readonly epoch: number }): { readonly outcome: string };
  requestCancellation(taskId: string): { readonly outcome: string };
  inspectOutstanding(taskId: string): readonly unknown[];
}
export interface ApprovalControl {
  isClosed(): boolean;
  fence(current: ApprovalTaskControl, cancel: boolean): void;
  admitAttempt(attemptId: string, claim: unknown): boolean;
}
export function createApprovalControl(options: {
  readonly taskId: string;
  readonly load: () => ApprovalTaskControl;
  readonly activity?: ApprovalActivity;
}): ApprovalControl {
  let closed = false;
  return {
    isClosed: () => closed,
    fence: (current, cancel) => {
      if (!options.activity) return;
      const wasClosed = closed;
      closed = true;
      if (options.activity.provenance !== 'mock' || !validateApprovalTaskControl(current).ok || current.taskId !== options.taskId ||
        !activityReceipt(options.activity.fenceTask({ taskId: options.taskId, epoch: current.epoch }), 'paused') ||
        cancel && !activityReceipt(options.activity.requestCancellation(options.taskId), 'ok')) throw new Error('approval-activity-unavailable');
      closed = wasClosed;
    },
    admitAttempt: (attemptId, input) => {
      try {
        if (!plainData(input)) return false;
        const claim = validateDispatchClaim(input);
        const current = options.load();
        if (closed || !options.activity || options.activity.provenance !== 'mock' || !validateApprovalTaskControl(current).ok || !claim.ok ||
          current.taskId !== options.taskId || claim.value.taskId !== options.taskId || current.mode !== 'runnable' ||
          current.epoch !== claim.value.expectedEpoch || current.version !== claim.value.expectedControlVersion || current.outstandingClaimRefs.length > 0) return false;
        const response = options.activity.admitAttempt({ attemptId, claim: claim.value, control: current });
        if (!activityReceipt(response, 'ok') || !attemptRecord(response.value) || response.value['taskId'] !== options.taskId || response.value['attemptId'] !== attemptId || response.value['claimId'] !== claim.value.claimId || response.value['epoch'] !== current.epoch || response.value['state'] !== 'outstanding' || response.value['cancellationRequested'] !== false) { closed = true; return false; }
        const latest = options.load();
        return !closed && plainData(latest) && validateApprovalTaskControl(latest).ok && latest.taskId === options.taskId &&
          latest.repositoryId === current.repositoryId && latest.workspaceId === current.workspaceId && latest.mode === 'runnable' &&
          latest.outstandingClaimRefs.length === 0 && latest.epoch === current.epoch && latest.version === current.version;
      } catch { closed = true; return false; }
    },
  };
}

function taskMatchesV02(taskInput: unknown, claim: DispatchClaimV02, journal: JournalClaimReceiptV02): boolean {
  const result = validateTaskState(taskInput);
  return result.ok && result.value.taskId === journal.taskId && result.value.runId === journal.runId &&
    result.value.stateVersion === journal.preClaimTaskStateVersion &&
    (claim.subjectKind !== 'repository-action' || result.value.repositoryRevisionDigest === claim.repositoryStateDigest);
}

/** UC-05 v0.2 receipts are projections of independently verified UC-04 journal facts. */
export function createApprovalControlV02(options: { readonly taskId: string; readonly journal?: UC04JournalPortV02 }): ApprovalControlV02 {
  return {
    publishAuthority: input => publishAuthorityV02(options.taskId, options.journal, input),
    closeUnattemptedClaim: async input => {
      const refused = { closed: false, receipt: null };
      try {
        if (!isIdV02(options.taskId) || dataPropertyV02(options.journal, 'provenance') !== 'mock' || !safeDataV02(input)) return refused;
        const fields = plainRecordV02(input, ['claim', 'journalClaim', 'recipientIdentity', 'pauseOrDenialEvent']);
        if (!fields || !exactKeysV02(fields, ['claim', 'journalClaim', 'recipientIdentity', 'pauseOrDenialEvent'])) return refused;
        const claimResult = validateDispatchClaimV02(fields['claim']);
        const claim = claimResult.ok ? claimResult.value : null;
        const journalClaim = journalClaimV02(fields['journalClaim']);
        const actor = executorIdentityV02(fields['recipientIdentity']);
        const event = plainRecordV02(fields['pauseOrDenialEvent'], ['eventKind', 'eventRef', 'eventDigest']);
        if (!claim || !journalClaim || !actor || !event || !exactKeysV02(event, ['eventKind', 'eventRef', 'eventDigest']) ||
          !isIdV02(event['eventRef']) || !isDigestV02(event['eventDigest']) || claim.taskId !== options.taskId ||
          !matchesClaimV02(claim, journalClaim) ||
          (claim.subjectKind === 'repository-action' ? actor.payloadDigest !== claim.actionDigest : actor.payloadDigest !== claim.requestContentDigest)) return refused;

        const setControl = dataMethodV02(options.journal, 'setTaskControl');
        const loadTask = dataMethodV02(options.journal, 'loadTask');
        const getSnapshot = dataMethodV02(options.journal, 'getJournalSnapshot');
        const fence = dataMethodV02(options.journal, 'fenceClaimRecipient');
        const close = dataMethodV02(options.journal, 'closeUnattemptedClaim');
        if (!setControl || !loadTask || !getSnapshot || !fence || !close) return refused;
        const before = journalSnapshotV02(await getSnapshot());
        const eventKind: 'denial' | 'pause' = before?.mode === 'rejected' ? 'denial' : 'pause';
        const expectedMode = eventKind === 'denial' ? 'rejected' : 'paused';
        if (!before || before.mode !== expectedMode || !before.holdRef || event['eventKind'] !== eventKind ||
          event['eventRef'] !== before.holdRef || event['eventDigest'] !== before.holdEventDigest ||
          !before.controlEventRefs.includes(before.holdRef) || before.epoch !== claim.expectedEpoch ||
          before.controlVersion <= journalClaim.postClaimControlVersion) return refused;
        const priorClaim = before.claims.find(row => row.claimId === claim.claimId);
        const alreadyClosed = priorClaim?.status === 'closed';
        const priorClosure = before.closures.find(row => row.claimId === claim.claimId);
        if (!priorClaim || priorClaim.attemptId !== null ||
          priorClaim.status !== 'claimed' && !alreadyClosed ||
          before.activeClaimId !== (alreadyClosed ? null : claim.claimId) ||
          before.attempts.some(row => row.claimId === claim.claimId) ||
          (alreadyClosed ? !priorClosure : Boolean(priorClosure))) return refused;
        const taskBefore = await loadTask(claim.taskId);
        if (!taskMatchesV02(taskBefore, claim, journalClaim)) return refused;

        // The journal confirms the caller's already-persisted pause event idempotently under its lock.
        if (await setControl(claim.taskId, expectedMode, before.holdRef) !== true) return refused;
        const afterControl = journalSnapshotV02(await getSnapshot());
        if (!afterControl || !isDeepStrictEqual(afterControl, before)) return refused;

        const proof = fenceProofV02(await fence(claim.claimId, actor));
        const afterFence = journalSnapshotV02(await getSnapshot());
        const fencedClaim = afterFence?.claims.find(row => row.claimId === claim.claimId);
        const priorFence = before.fenceProofs.find(row => row.claimId === claim.claimId);
        const storedFence = afterFence?.fenceProofs.find(row => row.claimId === claim.claimId);
        const incarnation = actor.adapterIdentity + '\u0000' + actor.processIncarnation;
        const expectedActiveClaimId = alreadyClosed ? null : claim.claimId;
        if (!proof || !afterFence || !fencedClaim || proof.claimId !== claim.claimId || proof.claimDigest !== journalClaim.claimDigest ||
          proof.taskId !== claim.taskId || !isDeepStrictEqual(proof.recipientIdentity, actor) ||
          proof.fencedExecutorIdentity.adapterIdentity !== actor.adapterIdentity ||
          proof.fencedExecutorIdentity.processIncarnation !== actor.processIncarnation ||
          proof.fencedExecutorIdentity.payloadDigest !== actor.payloadDigest ||
          proof.fencingGeneration !== proof.fencedExecutorIdentity.fencingGeneration || proof.fencingGeneration <= actor.fencingGeneration ||
          proof.holdRef !== before.holdRef || proof.epoch !== before.epoch ||
          proof.controlVersion !== (priorFence?.controlVersion ?? before.controlVersion + 1) ||
          afterFence.controlVersion !== before.controlVersion + (priorFence ? 0 : 1) ||
          afterFence.mode !== before.mode || afterFence.holdRef !== before.holdRef ||
          afterFence.holdEventDigest !== before.holdEventDigest || afterFence.activeClaimId !== expectedActiveClaimId ||
          afterFence.epoch !== before.epoch || fencedClaim.status !== (alreadyClosed ? 'closed' : 'claimed') ||
          fencedClaim.attemptId !== null || afterFence.attempts.some(row => row.claimId === claim.claimId) ||
          afterFence.claims.length !== before.claims.length || !storedFence) return refused;
        if (!storedFence || !isDeepStrictEqual(storedFence.proofRef, proof.proofRef) ||
          storedFence.fencingGeneration !== proof.fencingGeneration || storedFence.holdRef !== proof.holdRef ||
          storedFence.controlVersion !== proof.controlVersion || !afterFence.fencedIncarnations.includes(incarnation) ||
          priorFence && !isDeepStrictEqual(priorFence, storedFence)) return refused;

        const noAttemptDigest = computeCanonicalSha256({
          journalRef: journalClaim.claimId, claimId: journalClaim.claimId, claimDigest: journalClaim.claimDigest,
          claimPhase: 'claimed', claimAttemptId: null, attempts: afterFence.attempts.filter(row => row.claimId === claim.claimId),
          activeClaimId: claim.claimId, controlVersion: proof.controlVersion,
          epoch: afterFence.epoch, mode: afterFence.mode, holdRef: afterFence.holdRef,
          holdEventDigest: afterFence.holdEventDigest, fenceProofRef: proof.proofRef,
        });
        const unsigned = {
          schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
          receiptId: 'closure-' + computeCanonicalSha256({ claimId: claim.claimId, fenceProofRef: proof.proofRef }).slice(7, 27),
          claimId: claim.claimId,
          claimDigest: claim.claimDigest,
          taskId: claim.taskId,
          runId: claim.runId,
          taskStateSchemaVersion: claim.taskStateSchemaVersion,
          expectedTaskStateVersion: claim.expectedTaskStateVersion,
          controlSchemaVersion: claim.controlSchemaVersion,
          expectedControlVersion: claim.expectedControlVersion,
          expectedEpoch: claim.expectedEpoch,
          reason: before.holdRef,
          pauseOrDenialEvent: { eventKind, eventRef: before.holdRef, eventDigest: event['eventDigest'] as string },
          fencedExecutorIdentity: proof.fencedExecutorIdentity,
          noAttemptProof: { journalRef: journalClaim.claimId, journalDigest: noAttemptDigest, claimPhase: 'claimed' as const },
          reservationDispositions: journalClaim.reservationRefs.map(reservationRef => ({ reservationRef, disposition: 'released' as const })),
        };
        const receipt: ClaimClosureReceipt = { ...unsigned, receiptDigest: computeClaimClosureReceiptDigest(unsigned) };
        if (!validateClaimClosureReceipt(receipt).ok) return refused;

        // UC-04 has a deliberately smaller receipt. Project the checked UC-05 proof explicitly.
        const journalBase = {
          receiptId: receipt.receiptId, claimId: journalClaim.claimId, taskId: journalClaim.taskId,
          reason: receipt.reason, fencedExecutorIdentity: proof.fencedExecutorIdentity,
          unconsumedReservations: [...journalClaim.reservationRefs],
        };
        const journalReceipt: JournalClaimClosureReceiptV02 = { ...journalBase, receiptDigest: computeClaimClosureDigest(journalBase) };
        const validationContext: ClaimClosureValidationContextV02 = {
          expectedTaskId: journalClaim.taskId, expectedClaimId: journalClaim.claimId,
          claim: { claimId: journalClaim.claimId, taskId: journalClaim.taskId, claimDigest: journalClaim.claimDigest,
            status: 'claimed', hasCommittedAttempt: false, reservationRefs: journalClaim.reservationRefs },
          hasCommittedAttempt: false,
          expectedAdapterIdentity: proof.fencedExecutorIdentity.adapterIdentity,
          expectedMinFencingGeneration: proof.fencingGeneration,
          expectedFencedExecutorIdentity: proof.fencedExecutorIdentity,
        };
        const journalValidated = validateClaimClosureReceiptV02(journalReceipt, validationContext);
        if (!journalValidated.ok) return refused;
        if (alreadyClosed && (priorClosure?.receiptId !== receipt.receiptId ||
          priorClosure.receiptDigest !== journalValidated.value.receiptDigest)) return refused;
        const closeReply = plainRecordV02(await close(journalValidated.value), ['closed', 'receiptId']);
        if (!closeReply || !exactKeysV02(closeReply, ['closed', 'receiptId']) ||
          closeReply['closed'] !== true || closeReply['receiptId'] !== receipt.receiptId) return refused;

        const afterClose = journalSnapshotV02(await getSnapshot());
        const taskAfter = validateTaskState(await loadTask(claim.taskId));
        const taskInitial = validateTaskState(taskBefore);
        const closedClaim = afterClose?.claims.find(row => row.claimId === claim.claimId);
        const closure = afterClose?.closures.find(row => row.receiptId === receipt.receiptId);
        if (!afterClose || !taskAfter.ok || !taskInitial.ok || !closedClaim || closedClaim.status !== 'closed' ||
          closedClaim.attemptId !== null || afterClose.activeClaimId !== null ||
          afterClose.attempts.some(row => row.claimId === claim.claimId) ||
          afterClose.controlVersion !== afterFence.controlVersion + (alreadyClosed ? 0 : 1) || afterClose.mode !== afterFence.mode ||
          afterClose.holdRef !== afterFence.holdRef || afterClose.holdEventDigest !== afterFence.holdEventDigest ||
          afterClose.epoch !== afterFence.epoch ||
          !closure || closure.claimId !== claim.claimId || closure.receiptDigest !== journalValidated.value.receiptDigest ||
          taskAfter.value.taskId !== taskInitial.value.taskId || taskAfter.value.runId !== taskInitial.value.runId ||
          taskAfter.value.stateVersion !== taskInitial.value.stateVersion || taskAfter.value.node !== taskInitial.value.node ||
          taskAfter.value.repositoryRevisionDigest !== taskInitial.value.repositoryRevisionDigest) return refused;
        return { closed: true, receipt };
      } catch { return refused; }
    },
  };
}

function activityReceipt(value: unknown, outcome: string): boolean {
  if (!plainData(value) || typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const reasons = outcome === 'paused' ? ['task-epoch-fenced-in-memory'] : ['activity-attempt-admitted-in-memory', 'cancellation-requested-without-claim-release'];
  return Object.keys(record).length === 3 && Object.hasOwn(record, 'value') && record['outcome'] === outcome &&
    typeof record['safeReasonCode'] === 'string' && reasons.includes(record['safeReasonCode']) && !containsProtectedContent(JSON.stringify(record['value'])) &&
    (outcome === 'paused' ? record['value'] === null : record['safeReasonCode'] === 'activity-attempt-admitted-in-memory' ? attemptRecord(record['value']) : Array.isArray(record['value']) && record['value'].every(attemptRecord));
}

function attemptRecord(value: unknown): value is Record<string, unknown> {
  if (!plainData(value) || value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 6 && ['attemptId', 'claimId', 'taskId'].every(key => typeof record[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/u.test(record[key])) &&
    Number.isSafeInteger(record['epoch']) && typeof record['epoch'] === 'number' && record['epoch'] > 0 && typeof record['cancellationRequested'] === 'boolean' && ['outstanding', 'completed', 'cancelled', 'uncertain'].includes(String(record['state']));
}
/** Inspect plain data before calling validators or serializing untrusted port results. */
function plainData(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 8192;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length <= 256 && Reflect.ownKeys(descriptors).every(key => {
    const descriptor = typeof key === 'string' ? descriptors[key] : undefined;
    return descriptor !== undefined && 'value' in descriptor && plainData(descriptor.value, depth + 1);
  });
}
