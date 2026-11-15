/**
 * T044 material replan transaction (real-tier contract §(b)6, host contract §4).
 *
 * `createMaterialReplanPort({ state, verifyDirection })` owns the one charged plan transition a
 * material replan needs: it re-reads the task and control head under the task lock, compares the
 * request against them (identity, prior versions, allowance count, exact current revise direction),
 * recomputes the candidate digest before any mutation, and then writes the charged plan transition
 * to renewed approval together with a `uc04-journal:` operation record. Prior decision and review
 * authority do not survive that write.
 *
 * Identity is derived, never random: the reservation and transition receipts and the operation id
 * all hash the complete request, so an identical replay finds its own record and returns the same
 * committed state without a second charge, while the same proposal id with different content
 * cannot match it. A write whose outcome is unknown returns `uncertain({operationRef})`, and only
 * the T040 exact-operation lookup can say whether that operation committed.
 */
import { computeCanonicalSha256, validateFixPlan, validateStateTransition, validateTaskState } from '../../contracts/foundation/uc03.ts';
import type { BudgetLedger, FixPlan, StateTransitionOptions, TaskState } from '../../contracts/foundation/uc03.ts';
import { MAX_TASK_REPLANS } from '../../uc03/replan-accounting.ts';
import type { MaterialReplanPortV02, MaterialReplanRequestV02, MaterialReplanResultV02 } from '../../uc03/graph-types-v02.ts';
import type { TrustedReplanDirection } from '../../uc03/repair-types.ts';
import { isSafeStorageId } from '../store.ts';
import { journalOperationPath, journalOperationRef } from './state-port-v02-operation-lookup.ts';
import type { JournalOperationRecordV02 } from './state-port-v02-operation-lookup.ts';
import type { DurableStatePortV02 } from './state-port-v02.ts';
import { StatePortStore } from './state-port-v02-storage.ts';
import { DEFAULT_CONTROL } from './state-port-v02-types.ts';

export interface MaterialReplanPortOptions {
  readonly state: DurableStatePortV02;
  /** UC-05 direction authority: true only for the human direction currently bound to this task. */
  readonly verifyDirection: (state: TaskState, direction: TrustedReplanDirection) => boolean | Promise<boolean>;
  /** Test seam for the two filesystem outcomes a real run cannot force: a failed and a lost commit. */
  readonly commitTransaction?: ((write: () => Promise<void>) => Promise<void>) | undefined;
}

type Denied = Extract<MaterialReplanResultV02, { readonly outcome: 'denied' }>;

function denied(reason: string): Denied {
  return { outcome: 'denied', reason };
}

function hex(digest: string): string {
  return digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest;
}

/** The complete request identity the receipts and the operation id bind. */
function requestIdentity(request: MaterialReplanRequestV02): string {
  return computeCanonicalSha256({
    taskId: request.taskId,
    runId: request.runId,
    workspaceId: request.workspaceId,
    repositoryId: request.repositoryId,
    configurationId: request.configurationId,
    configurationVersion: request.configurationVersion,
    proposalId: request.proposalId,
    candidatePlanDigest: request.candidatePlanDigest,
    priorPlanVersion: request.priorPlanVersion,
    priorStateVersion: request.priorStateVersion,
    priorReplanCount: request.priorReplanCount,
    expectedNextReplanCount: request.expectedNextReplanCount,
    direction: request.direction,
  });
}

function digestOf(value: unknown): string | undefined {
  try {
    return computeCanonicalSha256(value);
  } catch {
    // Translated, not rethrown: an unrepresentable payload is a request defect, not a write.
    return undefined;
  }
}

function requestDefect(request: MaterialReplanRequestV02): string | undefined {
  if (!isSafeStorageId(request.taskId)) return 'invalid-task-id';
  for (const value of [request.runId, request.workspaceId, request.repositoryId, request.configurationId, request.configurationVersion, request.proposalId]) {
    if (typeof value !== 'string' || !value.trim()) return 'invalid-request-identity';
  }
  if (!validateFixPlan(request.candidatePlan).ok) return 'invalid-candidate-plan';
  if (typeof request.candidatePlanDigest !== 'string' || digestOf(request.candidatePlan) !== request.candidatePlanDigest) return 'candidate-plan-digest-mismatch';
  return undefined;
}

/** The request must name the task it is about, at the versions it read, for one more replan. */
function bindingDefect(request: MaterialReplanRequestV02, prior: TaskState): string | undefined {
  if (prior.taskId !== request.taskId || prior.runId !== request.runId || prior.workspaceId !== request.workspaceId || prior.repositoryId !== request.repositoryId)
    return 'request-task-binding-mismatch';
  if (prior.taskContext?.configId !== request.configurationId || prior.taskContext?.configVersion !== request.configurationVersion) return 'request-configuration-mismatch';
  if (prior.stateVersion !== request.priorStateVersion) return 'prior-state-version-mismatch';
  if (prior.planVersion !== request.priorPlanVersion) return 'prior-plan-version-mismatch';
  if (prior.replanCount !== request.priorReplanCount) return 'prior-replan-count-mismatch';
  if (request.expectedNextReplanCount !== prior.replanCount + 1) return 'expected-next-count-mismatch';
  return undefined;
}

/** The direction must be the current human revise direction for this exact plan, not a stale one. */
function directionDefect(direction: TrustedReplanDirection, prior: TaskState): string | undefined {
  const plan = prior.plan;
  if (direction.directive !== 'revise') return 'direction-not-revise';
  if (direction.taskId !== prior.taskId || direction.workspaceId !== prior.workspaceId || direction.repositoryRevisionDigest !== prior.repositoryRevisionDigest) return 'direction-binding-mismatch';
  if (direction.stateVersion !== prior.stateVersion || direction.planVersion !== prior.planVersion) return 'direction-stale';
  if (!plan) return 'missing-prior-plan';
  if (direction.rejectedDecisionId !== prior.activeDecisionId || direction.strategyDigest !== plan.strategyDigest) return 'direction-decision-mismatch';
  return undefined;
}

/** The single replan slot this transaction charges, keyed by the proposal identity. */
function chargeReplan(prior: TaskState, proposalId: string, receipt: string): readonly BudgetLedger[] {
  return (prior.budgetLedgers ?? []).map(ledger =>
    ledger.scope === 'task' && ledger.kind === 'replan'
      ? { ...ledger, reservations: [...ledger.reservations, { reservationId: receipt, keyedId: proposalId, amount: 1 }], version: ledger.version + 1 }
      : ledger,
  );
}

/**
 * The charged transition to renewed approval: AwaitFeedback/Repair pass through Investigate, and
 * each edge bumps the state version once, so the plan lands two versions later. Both steps are
 * validated against the trusted allowance the caller just minted; the second needs none.
 */
function commitState(prior: TaskState, request: MaterialReplanRequestV02, receipt: string, renewedDecisionId: string): TaskState | undefined {
  if (prior.node !== 'AwaitFeedback' && prior.node !== 'Repair' && prior.node !== 'Investigate') return undefined;
  const planVersion = prior.planVersion + 1;
  const replanCount = prior.replanCount + 1;
  const plan: FixPlan = { ...request.candidatePlan, planVersion };
  const cleared = {
    planVersion,
    replanCount,
    plan,
    activeDecisionId: undefined,
    approvalDecisionRefs: [] as readonly string[],
    latestReviewRef: undefined,
    reviewRefs: [] as readonly string[],
    budgetLedgers: chargeReplan(prior, request.proposalId, receipt),
  } as const;
  const reservation: NonNullable<StateTransitionOptions['trusted']>['replanReservation'] = {
    proposalId: request.proposalId,
    taskId: prior.taskId,
    configurationId: prior.taskContext?.configId ?? '',
    priorCount: prior.replanCount,
    nextCount: replanCount,
    reservationId: receipt,
  };
  let current = prior;
  if (prior.node !== 'Investigate') {
    const investigate: TaskState = { ...prior, ...cleared, stateVersion: prior.stateVersion + 1, node: 'Investigate', nextAction: 'propose-fix-plan' };
    if (!validateStateTransition(prior, investigate, { trusted: { replanReservation: reservation } }).ok) return undefined;
    current = investigate;
  }
  const awaitPlan: TaskState = {
    ...current,
    ...cleared,
    stateVersion: current.stateVersion + 1,
    node: 'AwaitPlan',
    nextAction: 'approve-fix-plan',
    plan: { ...plan, decisionRef: renewedDecisionId },
    activeDecisionId: renewedDecisionId,
  };
  if (!validateStateTransition(current, awaitPlan, current === prior ? { trusted: { replanReservation: reservation } } : {}).ok) return undefined;
  return validateTaskState(awaitPlan).ok ? awaitPlan : undefined;
}

export function createMaterialReplanPort(options: MaterialReplanPortOptions): MaterialReplanPortV02 {
  const { state } = options;
  const store = new StatePortStore(state.store);

  return {
    provenance: 'real',

    async accept(request: MaterialReplanRequestV02): Promise<MaterialReplanResultV02> {
      const defect = requestDefect(request);
      if (defect) return denied(defect);
      const identity = hex(requestIdentity(request));
      // Keyed by the proposal, not the full identity: a different request under the same proposal
      // id must find this record and be refused, not slip past it as a fresh operation.
      const operationId = `replan-${hex(computeCanonicalSha256({ taskId: request.taskId, proposalId: request.proposalId }))}`;
      const operationRef = journalOperationRef(operationId);
      const recordPath = journalOperationPath(store, request.taskId, operationId);
      const reservationReceipt = `replan-reservation-${hex(computeCanonicalSha256({ kind: 'reservation', identity }))}`;
      const transitionReceipt = `replan-transition-${hex(computeCanonicalSha256({ kind: 'transition', identity }))}`;
      const renewedDecisionId = `dec-replan-${identity}`;

      try {
        return await state.store.withLockRetry(`uc03v02-${request.taskId}`, async (): Promise<MaterialReplanResultV02> => {
          const prior = await store.readTask(request.taskId);
          if (!prior) return denied('task-not-found');

          // An identical replay finds its own record; anything else under this proposal id is a different request.
          const record = await store.readJson<JournalOperationRecordV02>(recordPath);
          if (record) {
            const same = Array.isArray(record.receipts) && record.receipts[0] === reservationReceipt && record.receipts[1] === transitionReceipt;
            if (!same) return denied('proposal-bound-to-different-content');
            // The record is written before the task, so a replay proves its own transition by the exact
            // persisted state: another proposal's commit at the same version is not this one.
            if (record.taskId !== prior.taskId || record.stateVersion !== prior.stateVersion || record.stateDigest !== computeCanonicalSha256(prior)) return denied('replay-state-superseded');
            return { outcome: 'already-accepted', state: structuredClone(prior), reservationReceipt, transitionReceipt };
          }

          const bound = bindingDefect(request, prior);
          if (bound) return denied(bound);
          if (prior.replanCount >= MAX_TASK_REPLANS) return denied('replan-cap-exceeded');
          const control = await store.readControl(request.taskId, DEFAULT_CONTROL);
          if (control.mode !== 'runnable' || control.holdRef !== null || control.activeClaimId !== null) return denied('control-not-runnable');
          const direction = directionDefect(request.direction, prior);
          if (direction) return denied(direction);

          let verified: boolean;
          try {
            verified = await options.verifyDirection(prior, request.direction);
          } catch {
            // An unavailable direction authority verifies nothing; it does not become a pass.
            verified = false;
          }
          if (!verified) return denied('direction-not-verified');

          const next = commitState(prior, request, reservationReceipt, renewedDecisionId);
          if (!next) return denied('replan-transition-invalid');

          // Record first: a half-applied write then reads back `unknown`, never a false `absent`.
          // The record carries the digest of the exact state it commits, so only A's own transition
          // resolves A, never another proposal's later write at the same version.
          const write = async (): Promise<void> => {
            await store.writeJson(recordPath, {
              taskId: next.taskId,
              stateVersion: next.stateVersion,
              stateDigest: computeCanonicalSha256(next),
              receipts: [reservationReceipt, transitionReceipt],
            } satisfies JournalOperationRecordV02);
            await store.writeTask(next.taskId, next);
          };
          try {
            if (options.commitTransaction) await options.commitTransaction(write);
            else await write();
          } catch {
            // Translated, not rethrown: whether it landed is exactly what the lookup answers.
            return { outcome: 'uncertain', operationRef };
          }
          // The persisted value is the acknowledgement: the consumer re-reads and compares it exactly.
          const committed = await store.readTask(next.taskId);
          return { outcome: 'accepted', state: committed ?? structuredClone(next), reservationReceipt, transitionReceipt };
        });
      } catch {
        // A busy or unreadable journal cannot authorize the transition; nothing is written.
        return denied('transaction-unavailable');
      }
    },
  };
}
