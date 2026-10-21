/**
 * UC-03 repair and replan types and interfaces.
 * Feature: specs/001-verified-code-repair
 * Tasks: T016, T017, T018
 */

import type {
  ApprovalBindingContext,
  ApprovalPort,
  ExecutionGuard,
  FixPlan,
  ModelPort,
  RepositoryPort,
  ReviewResult,
  StatePort,
  StateTransitionOptions,
  TaskState,
  VerificationResult,
} from '../contracts/foundation/uc03.ts';
import { computeCanonicalSha256, computeCheckSetDigest } from '../contracts/foundation/uc03.ts';

export type RepairOutcome = 'REPAIR_PREPARED' | 'INCOMPLETE' | 'DENIED';

export interface RepairPatchProposal {
  readonly diff: string;
  readonly affectedPaths: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly diagnosticRefs: readonly string[];
}

export interface TrustedRepairContext {
  readonly taskId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly repositoryRevisionDigest: string;
  readonly baselineRef: string;
  readonly checkSetDigest: string;
  readonly diffDigest: string;
  readonly evidenceRefs: readonly string[];
  readonly actionRefs: readonly string[];
  readonly diagnosticRefs: readonly string[];
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
  readonly executionGuard?: ExecutionGuard | undefined;
  readonly approvalPort?: ApprovalPort | undefined;
  readonly modelPort?: ModelPort | undefined;
  readonly trustedTransitionContext?: StateTransitionOptions['trusted'] | undefined;
  readonly trustedRepairContext?: TrustedRepairContext | undefined;
}

export interface RepairResult {
  readonly outcome: RepairOutcome;
  readonly state: TaskState | null;
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

export interface TrustedReplanDirection {
  readonly directive: 'resume' | 'revise' | 'terminate';
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryRevisionDigest: string;
  readonly stateVersion: number;
  readonly planVersion: number;
  readonly rejectedDecisionId: string;
  readonly strategyDigest: string;
}

export interface ReplanPorts {
  readonly statePort: StatePort;
  readonly approvalPort?: ApprovalPort | undefined;
  readonly trustedTransitionContext?: StateTransitionOptions['trusted'] | undefined;
  readonly trustedDirection?: TrustedReplanDirection | undefined;
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
  readonly decisionId: string;
}

export interface RejectionPorts {
  readonly statePort: StatePort;
  readonly approvalPort?: ApprovalPort | undefined;
  readonly trustedTransitionContext?: StateTransitionOptions['trusted'] | undefined;
}

export function validateRejectionInput(input: unknown): input is RejectionInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return typeof value.taskId === 'string' && !!value.taskId.trim() &&
    typeof value.decisionId === 'string' && !!value.decisionId.trim() &&
    typeof value.rejectionReason === 'string' && !!value.rejectionReason.trim();
}

export function getRejectionApprovalContext(state: TaskState): ApprovalBindingContext | undefined {
  const plan = state.plan;
  const task = state.taskContext;
  if (!plan?.decisionRef || !task?.requiredChecks.length) return undefined;
  const checkSetDigest = computeCheckSetDigest(task.requiredChecks);
  if (plan.checkSetDigest !== checkSetDigest) return undefined;
  const action = {
    actionId: plan.decisionRef,
    kind: 'approve_fix_plan' as const,
    planVersion: state.planVersion,
    strategyDigest: plan.strategyDigest,
    diagnosisEvidenceRefs: plan.evidenceRefs,
    checkSetDigest,
  };
  return {
    currentTaskId: state.taskId,
    currentWorkspaceId: state.workspaceId,
    currentRepositoryRevisionDigest: state.repositoryRevisionDigest,
    currentPolicyId: task.configId,
    currentPolicyVersion: task.configVersion,
    currentNormalizedActionDigest: computeCanonicalSha256(action),
    currentPlanVersion: state.planVersion,
    currentStrategyDigest: plan.strategyDigest,
    currentBaselineRef: plan.baselineRef,
    currentEvidenceRefs: plan.evidenceRefs,
    currentCriteriaDigest: computeCanonicalSha256(state.acceptanceCriteria),
    currentCheckSetDigest: checkSetDigest,
  };
}
