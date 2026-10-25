/**
 * UC-03 repair and replan types and interfaces.
 * Feature: specs/001-verified-code-repair
 * Tasks: T016, T017, T018, T061
 */

import type {
  ApprovalBindingContext,
  ApprovalPort,
  ExecutionGuard,
  ExecutionGuardV02,
  FixPlan,
  ModelPort,
  RepositoryPort,
  RepositoryPortV02,
  ReviewResult,
  StatePort,
  StatePortV02,
  StateTransitionOptions,
  TaskState,
  VerificationResult,
  RepositoryAdmissionContextV02,
  BudgetLedger,
} from '../contracts/foundation/uc03.ts';
import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  isProtectedPath,
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
  readonly admissionContext?: RepositoryAdmissionContextV02 | undefined;
}

export interface RepairInput {
  readonly taskId: string;
  readonly failureEvidence:
    | VerificationResult
    | ReviewResult
    | readonly (VerificationResult | ReviewResult)[];
  readonly repairPatch?: RepairPatchProposal | undefined;
  readonly actionId?: string | undefined;
  readonly admissionContext?: RepositoryAdmissionContextV02 | undefined;
}

export interface RepairPorts {
  readonly statePort: StatePort | StatePortV02;
  readonly repositoryPort?: RepositoryPort | RepositoryPortV02 | undefined;
  readonly executionGuard?: ExecutionGuard | ExecutionGuardV02 | undefined;
  readonly approvalPort?: ApprovalPort | undefined;
  readonly modelPort?: ModelPort | undefined;
  readonly trustedTransitionContext?: StateTransitionOptions['trusted'] | undefined;
  readonly trustedRepairContext?: TrustedRepairContext | undefined;
  readonly admissionContext?: RepositoryAdmissionContextV02 | undefined;
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

export function isStatePortV02(port: unknown): port is StatePortV02 {
  return (
    typeof port === 'object' &&
    port !== null &&
    'claim' in port &&
    typeof (port as Record<string, unknown>).claim === 'function'
  );
}

export function isVerificationResult(item: unknown): item is VerificationResult {
  return typeof item === 'object' && item !== null && 'testedIds' in item;
}

export function isProtectedPathOrTest(filePath: string): boolean {
  const norm = filePath.toLowerCase().replace(/\\/g, '/');
  return isProtectedPath(filePath) ||
    /(^|\/)(test|tests)(\/|$)|(^|\/)(test_[^/]*\.py|[^/]*_test\.py|conftest\.py)$/.test(norm);
}

export function isReviewResult(item: unknown): item is ReviewResult {
  return typeof item === 'object' && item !== null && 'reviewId' in item && 'findings' in item;
}

export function failureRefs(items: readonly (VerificationResult | ReviewResult)[]): {
  evidence: string[];
  actions: string[];
  diagnostics: string[];
} {
  const evidence = items.map((item) => isVerificationResult(item) ? item.evidenceId : item.reviewId);
  const actions = items.map((item) => isVerificationResult(item) ? item.actionId : item.iterationReservationRef);
  const diagnostics = items.flatMap((item) => isVerificationResult(item) ? item.diagnosticRefs : item.findings.map((finding) => finding.evidenceRef ?? item.reviewId));
  return { evidence, actions, diagnostics: [...new Set(diagnostics)] };
}

export function refsMatch(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((ref: unknown, index: number) => typeof ref === 'string' && ref === expected[index]);
}

export const isSha256 = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 71 && /^sha256:[a-f0-9]{64}$/.test(value);

export type AccountingCheck = { readonly ok: true; readonly repair: BudgetLedger } | { readonly ok: false; readonly reason: string };

export function checkAccounting(state: TaskState, actionId?: string, receiptId?: string): AccountingCheck {
  const task = state.taskContext, ledgers = state.budgetLedgers;
  if (!ledgers?.length) return { ok: false, reason: 'missing-budget-ledgers' };
  if (!task) return { ok: false, reason: 'missing-budget-configuration' };
  const [repair, tokens, cost] = (['repair', 'tokens', 'cost'] as const).map((kind) => ledgers.find((entry) => entry.scope === 'task' && entry.kind === kind));
  if (!repair || !tokens || !cost) return { ok: false, reason: 'missing-budget-ledgers' };
  for (const [ledger, limit, unit] of [[repair, task.budgetLimits.maxRepairAttempts, 'count'], [tokens, task.budgetLimits.maxTokens, 'count'], [cost, task.budgetLimits.maxCostUsd, 'usd']] as const) {
    if (ledger.configurationId !== task.configId || ledger.limit !== limit || ledger.unit !== unit) return { ok: false, reason: 'inconsistent-budget-configuration' };
    if (ledger.reservations.some((item) => item.amount <= 0)) return { ok: false, reason: 'inconsistent-budget-accounting' };
    const total = ledger.consumed + ledger.reservations.reduce((sum, item) => sum + item.amount, 0);
    if (ledger.kind === 'repair' && actionId) {
      if (total > limit) return { ok: false, reason: 'inconsistent-budget-accounting' };
      if (ledger.reservations.filter((item) => item.keyedId === actionId && item.amount === 1 && item.reservationId === receiptId).length !== 1) return { ok: false, reason: 'repair-reservation-not-authoritative' };
    } else if (total >= limit) return { ok: false, reason: ledger.kind === 'repair' ? 'repair-budget-exhausted' : 'token-or-cost-budget-exhausted' };
  }
  if (ledgers.some((entry) => (entry.kind === 'tokens' || entry.kind === 'cost') && entry.reservations.length > 0)) return { ok: false, reason: 'uncertain-accounting-reservations' };
  return { ok: true, repair };
}

export function isPatchResult(value: unknown): value is { readonly applied: true; readonly newRevisionDigest: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'applied' in value && (value as { applied: unknown }).applied === true && 'newRevisionDigest' in value && isSha256((value as { newRevisionDigest: unknown }).newRevisionDigest);
}

/** The guard and journal validate supplied owner authority; repair never creates it. */
export function resolveRepairAdmissionContext(
  ports: RepairPorts,
  ctx?: TrustedRepairContext | undefined,
): RepositoryAdmissionContextV02 | undefined {
  return ports.admissionContext ?? ctx?.admissionContext;
}
