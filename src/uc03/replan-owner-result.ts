/** Bind a material-replan owner receipt to the exact persisted state and single budget reservation. */

import { computeCanonicalSha256, validateTaskState, type StatePortV02, type TaskState } from '../contracts/foundation/uc03.ts';
import { checkReplanAccounting } from './replan-accounting.ts';
import type { MaterialReplanResultV02 } from './graph-types-v02.ts';
import type { ReplanInput } from './repair-types.ts';

type AcceptedMaterialReplan = Extract<MaterialReplanResultV02, { readonly outcome: 'accepted' | 'already-accepted' }>;

/** Return only the exact current owner state that proves this candidate was committed once. */
export async function bindAcceptedMaterialReplan(
  prior: TaskState,
  input: ReplanInput,
  accepted: AcceptedMaterialReplan,
  owner: StatePortV02,
): Promise<TaskState | undefined> {
  if (
    input.taskId !== prior.taskId || typeof accepted.reservationReceipt !== 'string' || !accepted.reservationReceipt.trim() ||
    typeof accepted.transitionReceipt !== 'string' || !accepted.transitionReceipt.trim()
  ) return undefined;

  const owned = accepted.state;
  let current: TaskState | null;
  try {
    current = await owner.loadTask(prior.taskId);
  } catch {
    return undefined;
  }

  let exactCurrentState = false;
  try {
    exactCurrentState = current !== null && computeCanonicalSha256(current) === computeCanonicalSha256(owned);
  } catch {
    return undefined;
  }
  const renewedDecisionId = owned.plan?.decisionRef;
  const committedPlan = owned.plan && { ...owned.plan, decisionRef: undefined };
  const expectedPlan = { ...input.candidatePlan, planVersion: prior.planVersion + 1, decisionRef: undefined };
  const priorAccounting = checkReplanAccounting({ ...owned, replanCount: prior.replanCount }, input.proposalId, accepted.reservationReceipt);
  // ALLOWED_NODE_TRANSITIONS reaches AwaitPlan from AwaitFeedback/Repair only through Investigate and
  // every edge bumps stateVersion once, so the single owner transaction still lands two versions later.
  const expectedStateVersion = prior.stateVersion + (prior.node === 'Investigate' ? 1 : 2);
  // context/runtime_policy.md: a replan resets no other task budget, so consumption may only grow.
  const budgetsMonotone = (prior.budgetLedgers ?? []).every(
    before =>
      before.kind === 'replan' ||
      (owned.budgetLedgers?.some(after => after.scope === before.scope && after.kind === before.kind && after.consumed >= before.consumed) ?? false),
  );
  const bound = validateTaskState(owned).ok && exactCurrentState && priorAccounting.ok && budgetsMonotone &&
    owned.taskId === prior.taskId && owned.runId === prior.runId && owned.workspaceId === prior.workspaceId &&
    owned.repositoryId === prior.repositoryId && owned.repositoryRevisionDigest === prior.repositoryRevisionDigest &&
    owned.taskContext?.configId === prior.taskContext?.configId && owned.taskContext?.configVersion === prior.taskContext?.configVersion &&
    owned.stateVersion === expectedStateVersion && owned.node === 'AwaitPlan' && owned.nextAction === 'approve-fix-plan' &&
    owned.planVersion === prior.planVersion + 1 && owned.replanCount === prior.replanCount + 1 &&
    computeCanonicalSha256(committedPlan ?? null) === computeCanonicalSha256(expectedPlan) &&
    typeof renewedDecisionId === 'string' && renewedDecisionId.length > 0 && renewedDecisionId !== prior.activeDecisionId &&
    owned.activeDecisionId === renewedDecisionId && owned.latestReviewRef === undefined && (owned.reviewRefs?.length ?? 0) === 0;
  return bound ? owned : undefined;
}
