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
 * committed snapshot without a second charge, while the same proposal id with different content
 * cannot match it. The record carries that committed snapshot and the charge it owns, so the replay
 * keeps proving after later task progress. A write whose outcome is unknown returns
 * `uncertain({operationRef})`, and only the T040 exact-operation lookup can say whether that
 * operation committed.
 */
import { computeCanonicalSha256, validateFixPlan, validateStateTransition, validateTaskState } from '../../contracts/foundation/uc03.ts';
import type { BudgetLedger, FixPlan, StateTransitionOptions, TaskState } from '../../contracts/foundation/uc03.ts';
import { MAX_TASK_REPLANS } from '../../uc03/replan-accounting.ts';
import type { MaterialReplanPortV02, MaterialReplanRequestV02, MaterialReplanResultV02 } from '../../uc03/graph-types-v02.ts';
import type { TrustedReplanDirection } from '../../uc03/repair-types.ts';
import { isSafeStorageId } from '../store.ts';
import { chargeLanded, journalOperationId, journalOperationPath, journalOperationRef, operationSnapshot } from './state-port-v02-operation-lookup.ts';
import type { JournalOperationRecordV02 } from './state-port-v02-operation-lookup.ts';
import type { DurableStatePortV02 } from './state-port-v02.ts';
import { StatePortStore } from './state-port-v02-storage.ts';

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
      // Own a deep snapshot before anything reads it: the request crosses an await boundary, and a
      // caller that mutates its own object must not change what gets validated, hashed or persisted.
      let owned: MaterialReplanRequestV02;
      try {
        owned = structuredClone(request);
      } catch {
        return denied('invalid-request-identity');
      }
      const defect = requestDefect(owned);
      if (defect) return denied(defect);
      const identity = hex(requestIdentity(owned));
      // Keyed by the proposal, not the full identity: a different request under the same proposal
      // id must find this record and be refused, not slip past it as a fresh operation.
      const operationId = journalOperationId(owned.taskId, owned.proposalId);
      const operationRef = journalOperationRef(operationId);
      const recordPath = journalOperationPath(store, owned.taskId, operationId);
      const reservationReceipt = `replan-reservation-${hex(computeCanonicalSha256({ kind: 'reservation', identity }))}`;
      const transitionReceipt = `replan-transition-${hex(computeCanonicalSha256({ kind: 'transition', identity }))}`;
      const renewedDecisionId = `dec-replan-${identity}`;
      const charge = { reservationId: reservationReceipt, keyedId: owned.proposalId } as const;
      // Lock cleanup runs after the callback, so a lock failure can follow a committed write: only the
      // phase says whether the journal may already hold this operation.
      let writing = false;

      try {
        return await state.store.withLockRetry(`uc03v02-${owned.taskId}`, async (): Promise<MaterialReplanResultV02> => {
          const prior = await store.readTask(owned.taskId);
          if (!prior) return denied('task-not-found');

          // An identical replay finds its own record; anything else under this proposal id is a different request.
          const record = await store.readJson<JournalOperationRecordV02>(recordPath);
          if (record) {
            const same = Array.isArray(record.receipts) && record.receipts[0] === reservationReceipt && record.receipts[1] === transitionReceipt;
            if (!same) return denied('proposal-bound-to-different-content');
            // The record carries its own committed snapshot, and the task itself keeps this proposal's
            // charge, so the same replay still proves its transition after the task has moved on —
            // while another proposal's commit at the same version never carried this charge.
            const snapshot = operationSnapshot(record, operationId);
            // The record must carry the charge this request computes, not one borrowed from another operation.
            if (!snapshot || snapshot.charge.reservationId !== charge.reservationId || snapshot.charge.keyedId !== charge.keyedId) return denied('replay-state-superseded');
            if (!chargeLanded(prior, snapshot.charge)) return denied('replay-state-superseded');
            return { outcome: 'already-accepted', state: snapshot.state, reservationReceipt, transitionReceipt };
          }

          const bound = bindingDefect(owned, prior);
          if (bound) return denied(bound);
          if (prior.replanCount >= MAX_TASK_REPLANS) return denied('replan-cap-exceeded');
          // The same seed claims and authority publication use: a task with no control head is not
          // implicitly runnable just because nothing wrote one yet.
          const control = await store.readControl(owned.taskId, state.controlSeed);
          if (control.mode !== 'runnable' || control.holdRef !== null || control.activeClaimId !== null) return denied('control-not-runnable');
          const direction = directionDefect(owned.direction, prior);
          if (direction) return denied(direction);

          let verified: boolean;
          try {
            verified = await options.verifyDirection(prior, owned.direction);
          } catch {
            // An unavailable direction authority verifies nothing; it does not become a pass.
            verified = false;
          }
          if (!verified) return denied('direction-not-verified');

          const next = commitState(prior, owned, reservationReceipt, renewedDecisionId);
          if (!next) return denied('replan-transition-invalid');

          // Record first: a half-applied write then reads back `unknown`, never a false `absent`.
          // The record keeps the snapshot it commits plus the charge it owns, so a replay after later
          // progress still returns the identical committed state and receipts.
          const write = async (): Promise<void> => {
            writing = true;
            await store.writeJson(recordPath, {
              taskId: next.taskId,
              stateVersion: next.stateVersion,
              stateDigest: computeCanonicalSha256(next),
              receipts: [reservationReceipt, transitionReceipt],
              state: next,
              charge,
            } satisfies JournalOperationRecordV02);
            await store.writeTask(next.taskId, next);
          };
          try {
            if (options.commitTransaction) await options.commitTransaction(write);
            else await write();
            // The persisted value is the acknowledgement: the consumer re-reads and compares it exactly.
            // A failure here is after both writes, so it is an unknown outcome, never a denial.
            const committed = await store.readTask(next.taskId);
            return { outcome: 'accepted', state: committed ?? structuredClone(next), reservationReceipt, transitionReceipt };
          } catch {
            // Translated, not rethrown: whether it landed is exactly what the lookup answers.
            return { outcome: 'uncertain', operationRef };
          }
        });
      } catch {
        // Past the first write the outcome is unknown: only the lookup can say whether it landed.
        return writing ? { outcome: 'uncertain', operationRef } : denied('transaction-unavailable');
      }
    },
  };
}
