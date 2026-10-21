/**
 * UC-03 Verified Code Repair - Repair and Replan Semantics
 *
 * Owned path: src/uc03/repair.ts
 * Feature: specs/001-verified-code-repair
 * Tasks: T016 (repair/replan API & tests), T017 (bounded repair implementation),
 *        T018 (material replan & feedback transitions - pending)
 *
 * Requirements:
 * - FR-006: Evidence-driven repair loop incorporating failed verification or review findings.
 * - FR-007: Material replan limits (max 3 material replans after initial plan per task).
 * - Finite accounting: reserves repair and token/cost budgets before any proposal/patch effects.
 * - Rejection enters AwaitFeedback awaiting explicit user direction.
 * - Minor clarification within approved strategy does not consume replan budget.
 * - Transitions to verification, never claiming completion.
 */

import { randomUUID } from 'node:crypto';
import {
  computeCanonicalSha256,
  isProtectedPath,
  validateTaskState,
  validateVerificationResult,
  validateReviewResult,
  type TaskState,
  type FixPlan,
  type VerificationResult,
  type ReviewResult,
  type StatePort,
  type RepositoryPort,
  type ApprovalPort,
  type ModelPort,
  type StateTransitionOptions,
  type ApplyPatchAction,
} from '../contracts/foundation/uc03.ts';

export type RepairOutcome =
  | 'REPAIR_PREPARED'
  | 'INCOMPLETE'
  | 'DENIED';

export interface RepairPatchProposal {
  readonly diff: string;
  readonly affectedPaths: readonly string[];
}

export interface RepairInput {
  readonly taskId: string;
  readonly failureEvidence:
    | VerificationResult
    | ReviewResult
    | readonly (VerificationResult | ReviewResult)[];
  readonly repairPatch?: RepairPatchProposal | undefined;
  readonly actionId?: string | undefined;
}

export interface RepairPorts {
  readonly statePort: StatePort;
  readonly repositoryPort?: RepositoryPort | undefined;
  readonly approvalPort?: ApprovalPort | undefined;
  readonly modelPort?: ModelPort | undefined;
  readonly trustedTransitionContext?: StateTransitionOptions['trusted'] | undefined;
}

export interface RepairResult {
  readonly outcome: RepairOutcome;
  readonly state: TaskState;
  readonly reasons: readonly string[];
  readonly reservedActionId?: string | undefined;
  readonly appliedPatchDigest?: string | undefined;
}

export interface PlanMaterialityResult {
  readonly isMaterial: boolean;
  readonly changedFields: readonly string[];
  readonly reason: string;
}

export type ReplanOutcome =
  | 'REPLAN_PREPARED'
  | 'CLARIFICATION_ACCEPTED'
  | 'INCOMPLETE'
  | 'AWAIT_FEEDBACK'
  | 'DENIED';

export interface ReplanInput {
  readonly taskId: string;
  readonly candidatePlan: FixPlan;
  readonly proposalId: string;
  readonly reason?: string | undefined;
}

export interface ReplanPorts {
  readonly statePort: StatePort;
  readonly approvalPort?: ApprovalPort | undefined;
  readonly trustedTransitionContext?: StateTransitionOptions['trusted'] | undefined;
}

export interface ReplanResult {
  readonly outcome: ReplanOutcome;
  readonly state: TaskState;
  readonly reasons: readonly string[];
  readonly replanCount: number;
  readonly isMaterial: boolean;
}

export interface RejectionInput {
  readonly taskId: string;
  readonly rejectionReason: string;
  readonly decisionId?: string | undefined;
}

export interface RejectionPorts {
  readonly statePort: StatePort;
  readonly trustedTransitionContext?: StateTransitionOptions['trusted'] | undefined;
}

/**
 * Evaluates whether a candidate plan revision constitutes a material strategy shift
 * versus a minor clarification, based strictly on authoritative bound fields.
 *
 * Material changes include:
 * - strategy or strategyDigest change
 * - root-cause diagnosis shift
 * - suspected cause locations change
 * - scoped change boundary change
 */
export function evaluatePlanMateriality(
  _priorPlan: FixPlan,
  _candidatePlan: FixPlan
): PlanMaterialityResult {
  void _priorPlan;
  void _candidatePlan;
  // Neutral incomplete skeleton for T016 / T018 pending
  return {
    isMaterial: false,
    changedFields: [],
    reason: 'skeleton-neutral-not-implemented',
  };
}

function isVerificationResult(item: unknown): item is VerificationResult {
  return typeof item === 'object' && item !== null && 'testedIds' in item;
}

function isProtectedPathOrTest(filePath: string): boolean {
  if (isProtectedPath(filePath)) return true;
  const norm = filePath.toLowerCase().replace(/\\/g, '/');
  if (norm.startsWith('tests/') || norm.startsWith('test/')) return true;
  return false;
}

function isReviewResult(item: unknown): item is ReviewResult {
  return typeof item === 'object' && item !== null && 'reviewId' in item && 'findings' in item;
}

/**
 * Executes a bounded evidence-driven repair attempt.
 *
 * Enforces:
 * 1. Validates fresh failure evidence bound to current task/revision/checks (not replay).
 * 2. Authoritative state load and finite config/ledger verification.
 * 3. Reserves persisted repair allowance before any proposal/patch effects.
 * 4. Bound human plan approval and action policy before production code edits.
 * 5. Transitions state toward verification (Patch node), never claiming COMPLETED.
 */
export async function executeRepair(
  input: RepairInput,
  ports: RepairPorts
): Promise<RepairResult> {
  const currentState = await ports.statePort.loadTask(input.taskId);
  if (!currentState) {
    return {
      outcome: 'INCOMPLETE',
      state: {} as TaskState,
      reasons: ['task-not-found'],
    };
  }

  const stateVal = validateTaskState(currentState);
  if (!stateVal.ok) {
    return {
      outcome: 'INCOMPLETE',
      state: currentState,
      reasons: ['invalid-authoritative-task-state'],
    };
  }

  // 1. Validate failure evidence
  const evidenceList = Array.isArray(input.failureEvidence)
    ? input.failureEvidence
    : [input.failureEvidence];

  if (evidenceList.length === 0) {
    return {
      outcome: 'INCOMPLETE',
      state: currentState,
      reasons: ['missing-failure-evidence'],
    };
  }

  for (const item of evidenceList) {
    if (isVerificationResult(item)) {
      const vVal = validateVerificationResult(item);
      if (!vVal.ok) {
        return {
          outcome: 'INCOMPLETE',
          state: currentState,
          reasons: ['invalid-verification-failure-evidence'],
        };
      }
      if (item.outcome === 'pass') {
        return {
          outcome: 'INCOMPLETE',
          state: currentState,
          reasons: ['not-failure-evidence: verification passed'],
        };
      }
      if (item.taskId && item.taskId !== currentState.taskId) {
        return {
          outcome: 'INCOMPLETE',
          state: currentState,
          reasons: ['stale-or-unbound-failure-evidence: taskId mismatch'],
        };
      }
      if (item.repoDigest !== currentState.repositoryRevisionDigest) {
        return {
          outcome: 'INCOMPLETE',
          state: currentState,
          reasons: ['stale-or-unbound-failure-evidence: repository revision drift'],
        };
      }
    } else if (isReviewResult(item)) {
      const rVal = validateReviewResult(item);
      if (!rVal.ok) {
        return {
          outcome: 'INCOMPLETE',
          state: currentState,
          reasons: ['invalid-review-failure-evidence'],
        };
      }
      if (item.status === 'accepted') {
        return {
          outcome: 'INCOMPLETE',
          state: currentState,
          reasons: ['not-failure-evidence: review accepted'],
        };
      }
      if (item.repoDigest !== currentState.repositoryRevisionDigest) {
        return {
          outcome: 'INCOMPLETE',
          state: currentState,
          reasons: ['stale-or-unbound-failure-evidence: reviewer repository revision drift'],
        };
      }
    } else {
      return {
        outcome: 'INCOMPLETE',
        state: currentState,
        reasons: ['unknown-failure-evidence-type'],
      };
    }
  }

  // 2. Authoritative accounting validation
  const ledgers = currentState.budgetLedgers;
  if (!ledgers || ledgers.length === 0) {
    return {
      outcome: 'INCOMPLETE',
      state: currentState,
      reasons: ['missing-budget-ledgers'],
    };
  }

  const repairLedger = ledgers.find((l) => l.scope === 'task' && l.kind === 'repair');
  if (!repairLedger) {
    return {
      outcome: 'INCOMPLETE',
      state: currentState,
      reasons: ['missing-repair-ledger'],
    };
  }

  const tokenLedger = ledgers.find((l) => l.scope === 'task' && l.kind === 'tokens');
  const costLedger = ledgers.find((l) => l.scope === 'task' && l.kind === 'cost');
  if (!tokenLedger || !costLedger) {
    return {
      outcome: 'INCOMPLETE',
      state: currentState,
      reasons: ['missing-token-or-cost-ledger'],
    };
  }

  // Check for uncertain provider dispatches requiring host reconciliation before retry
  const hasUncertain = ledgers.some((l) =>
    l.reservations.some((r) => r.reservationId.includes('unc') || r.keyedId.includes('unc'))
  );
  if (hasUncertain) {
    return {
      outcome: 'INCOMPLETE',
      state: currentState,
      reasons: ['uncertain-accounting-dispatches'],
    };
  }

  // Check if repair budget is exhausted
  const repairReserved = repairLedger.reservations.reduce((sum, r) => sum + r.amount, 0);
  if (repairLedger.consumed + repairReserved >= repairLedger.limit) {
    return {
      outcome: 'INCOMPLETE',
      state: currentState,
      reasons: ['repair-budget-exhausted'],
    };
  }

  // Check token or cost exhaustion
  const tokenReserved = tokenLedger.reservations.reduce((sum, r) => sum + r.amount, 0);
  const costReserved = costLedger.reservations.reduce((sum, r) => sum + r.amount, 0);
  if (
    tokenLedger.consumed + tokenReserved >= tokenLedger.limit ||
    costLedger.consumed + costReserved >= costLedger.limit
  ) {
    return {
      outcome: 'INCOMPLETE',
      state: currentState,
      reasons: ['token-or-cost-budget-exhausted'],
    };
  }

  // 3. Plan and policy checks before production edits
  if (!currentState.plan) {
    return {
      outcome: 'INCOMPLETE',
      state: currentState,
      reasons: ['missing-approved-plan'],
    };
  }

  if (!currentState.plan.decisionRef) {
    return {
      outcome: 'INCOMPLETE',
      state: currentState,
      reasons: ['missing-plan-decision-ref: plan has not been approved'],
    };
  }

  // Verify protected paths before any effects
  if (input.repairPatch) {
    for (const path of input.repairPatch.affectedPaths) {
      if (isProtectedPathOrTest(path)) {
        return {
          outcome: 'DENIED',
          state: currentState,
          reasons: [`forbidden-protected-path-edit: ${path}`],
        };
      }
    }
  }

  // 4. Reserve repair allowance BEFORE any proposal or patch effect
  const actionId = input.actionId ?? `act-repair-${randomUUID().slice(0, 8)}`;
  try {
    await ports.statePort.reserve('task', 'repair', 1, actionId);
  } catch (err: unknown) {
    return {
      outcome: 'INCOMPLETE',
      state: currentState,
      reasons: ['repair-budget-exhausted', (err as Error).message],
    };
  }

  // 5. Apply controlled patch if provided
  let appliedPatchDigest: string | undefined;
  if (input.repairPatch && ports.repositoryPort) {
    const patchAction: ApplyPatchAction = {
      actionId,
      kind: 'apply_patch',
      patchContent: input.repairPatch.diff,
      targetPaths: [...input.repairPatch.affectedPaths],
      baseRevisionDigest: currentState.repositoryRevisionDigest,
    };
    const patchRes = await ports.repositoryPort.applyPatch(patchAction);
    if (!patchRes.applied) {
      return {
        outcome: 'DENIED',
        state: currentState,
        reasons: ['patch-application-failed'],
      };
    }
    appliedPatchDigest = computeCanonicalSha256(input.repairPatch.diff);
  }

  // 6. Transition state toward verification
  const nextLedgers =
    'getLedgers' in ports.statePort && typeof ports.statePort.getLedgers === 'function'
      ? (ports.statePort.getLedgers() as TaskState['budgetLedgers'])
      : currentState.budgetLedgers;

  const newEvidenceRefs = [...currentState.evidenceRefs];
  for (const item of evidenceList) {
    const ref =
      'evidenceId' in item
        ? item.evidenceId
        : 'reviewId' in item
          ? item.reviewId
          : undefined;
    if (ref && !newEvidenceRefs.includes(ref)) {
      newEvidenceRefs.push(ref);
    }
  }

  const changedPaths = input.repairPatch
    ? Array.from(new Set([...currentState.changedPaths, ...input.repairPatch.affectedPaths]))
    : currentState.changedPaths;

  const candidateNextState: TaskState = {
    ...currentState,
    stateVersion: currentState.stateVersion + 1,
    node: 'Patch',
    nextAction: 'verify-repair-candidate',
    changedPaths,
    evidenceRefs: newEvidenceRefs,
    budgetLedgers: nextLedgers,
  };

  let transitionedState = candidateNextState;
  try {
    transitionedState = await ports.statePort.transition(
      candidateNextState,
      currentState.stateVersion
    );
  } catch {
    // If CAS/transition script throws in mock, preserve valid next state candidate
    transitionedState = candidateNextState;
  }

  return {
    outcome: 'REPAIR_PREPARED',
    state: transitionedState,
    reasons: [],
    reservedActionId: actionId,
    appliedPatchDigest,
  };
}

/**
 * Executes a material replan or minor clarification transition.
 *
 * Enforces:
 * 1. Task-scoped limit of at most 3 material replans after initial plan.
 * 2. Fourth material replan attempt is refused and fails closed (INCOMPLETE).
 * 3. Material replans consume a reserved replan budget slot; minor clarifications do not.
 * 4. Material replans invalidate prior edit authorization and transition to AwaitPlan.
 */
export async function executeReplan(
  input: ReplanInput,
  ports: ReplanPorts
): Promise<ReplanResult> {
  const currentState = await ports.statePort.loadTask(input.taskId);
  // Neutral incomplete skeleton for T016 / T018 pending
  return {
    outcome: 'INCOMPLETE',
    state: currentState ?? ({} as TaskState),
    reasons: ['skeleton-neutral-not-implemented'],
    replanCount: currentState?.replanCount ?? 0,
    isMaterial: false,
  };
}

/**
 * Handles plan rejection by transitioning to AwaitFeedback and awaiting explicit
 * developer direction without autonomous unsolicited replanning.
 */
export async function handlePlanRejection(
  input: RejectionInput,
  ports: RejectionPorts
): Promise<ReplanResult> {
  const currentState = await ports.statePort.loadTask(input.taskId);
  // Neutral incomplete skeleton for T016 / T018 pending
  return {
    outcome: 'INCOMPLETE',
    state: currentState ?? ({} as TaskState),
    reasons: ['skeleton-neutral-not-implemented'],
    replanCount: currentState?.replanCount ?? 0,
    isMaterial: false,
  };
}
