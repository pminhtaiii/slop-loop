/**
 * UC-03 repair and replan types and interfaces.
 * Feature: specs/001-verified-code-repair
 * Tasks: T016, T017, T018
 */

import type {
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
