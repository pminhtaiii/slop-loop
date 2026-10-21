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

import {
  type TaskState,
  type FixPlan,
  type VerificationResult,
  type ReviewResult,
  type StatePort,
  type RepositoryPort,
  type ApprovalPort,
  type ModelPort,
  type StateTransitionOptions,
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
  // Neutral incomplete skeleton for T016
  return {
    isMaterial: false,
    changedFields: [],
    reason: 'skeleton-neutral-not-implemented',
  };
}

/**
 * Executes a bounded evidence-driven repair attempt.
 *
 * Enforces:
 * 1. Validates fresh failure evidence bound to current task/revision/checks (not replay).
 * 2. Authoritative state load and finite config/ledger verification.
 * 3. Reserves persisted repair allowance before any proposal/patch effects.
 * 4. Bound human plan approval and action policy before production code edits.
 * 5. Transitions state to Patch/Verify, never claiming COMPLETED.
 */
export async function executeRepair(
  input: RepairInput,
  ports: RepairPorts
): Promise<RepairResult> {
  const currentState = await ports.statePort.loadTask(input.taskId);
  // Neutral incomplete skeleton for T016
  return {
    outcome: 'INCOMPLETE',
    state: currentState ?? ({} as TaskState),
    reasons: ['skeleton-neutral-not-implemented'],
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
  // Neutral incomplete skeleton for T016
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
  // Neutral incomplete skeleton for T016
  return {
    outcome: 'INCOMPLETE',
    state: currentState ?? ({} as TaskState),
    reasons: ['skeleton-neutral-not-implemented'],
    replanCount: currentState?.replanCount ?? 0,
    isMaterial: false,
  };
}
