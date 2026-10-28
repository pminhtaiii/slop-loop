import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  TASK_NODES,
  validateBugTask,
  validateTaskState,
  type BugTask,
  type ApprovalBinding,
  type ProviderAdmissionContextV02,
  type StatePort,
  type TaskState,
  type TaskOutcome,
  type VerificationResult,
} from '../contracts/foundation/uc03.ts';
import type { ExecutionGuardV02 } from '../foundation/execution-guard.ts';
import { extractCheckTestSelectors } from './selectors.ts';
import { createMilestone, type Milestone, type MilestoneKind } from './report.ts';
import type { UC03GraphConfig, UC03GraphPorts } from './graph-types.ts';
import type { TrustedHostExpectedContext } from './investigation.ts';
export { validSettledPatchEvidence } from './graph-patch-ancestry.ts';

export type GraphInputValidation =
  | { readonly ok: true; readonly state: TaskState }
  | {
      readonly ok: false;
      readonly state: TaskState | null;
      readonly outcome: TaskOutcome | 'needs-info';
      readonly reasons: readonly string[];
    };

export async function validateGraphInput(
  task: BugTask,
  suppliedState: TaskState | undefined,
  statePort: StatePort,
): Promise<GraphInputValidation> {
  const taskValidation = validateBugTask(task);
  if (!taskValidation.ok) {
    const needsInfo = !task.reproduction?.trim() || !Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0;
    return {
      ok: false,
      state: null,
      outcome: needsInfo ? 'needs-info' : 'INCOMPLETE',
      reasons: taskValidation.errors.map((error) => error.message),
    };
  }

  let current: TaskState | null;
  try {
    current = await statePort.loadTask(task.taskId);
  } catch {
    return { ok: false, state: null, outcome: 'INCOMPLETE', reasons: ['Authoritative task state could not be loaded'] };
  }
  if (!current) {
    return { ok: false, state: null, outcome: 'INCOMPLETE', reasons: ['Authoritative task state is missing'] };
  }

  const currentValidation = validateTaskState(current);
  if (!currentValidation.ok || !taskStateMatchesTask(currentValidation.ok ? currentValidation.value : current, task)) {
    return { ok: false, state: null, outcome: 'INCOMPLETE', reasons: ['Authoritative task state does not match the supplied task'] };
  }
  if (!TASK_NODES.includes(current.node)) {
    return { ok: false, state: null, outcome: 'INCOMPLETE', reasons: ['Authoritative task state has an unknown workflow node'] };
  }

  if (suppliedState !== undefined) {
    const suppliedValidation = validateTaskState(suppliedState);
    if (!suppliedValidation.ok || !samePersistedTransition(suppliedValidation.ok ? suppliedValidation.value : suppliedState, current)) {
      return { ok: false, state: null, outcome: 'INCOMPLETE', reasons: ['Restored task state is stale or does not match authoritative owner state'] };
    }
  }

  return { ok: true, state: currentValidation.value };
}

export function taskStateMatchesTask(state: TaskState, task: BugTask): boolean {
  try {
    return state.taskId === task.taskId &&
      state.repositoryId === task.repositoryId &&
      state.goal === task.goal &&
      state.observedBehavior === task.observedBehavior &&
      state.expectedBehavior === task.expectedBehavior &&
      state.reproduction === task.reproduction &&
      computeCanonicalSha256(state.acceptanceCriteria) === computeCanonicalSha256(task.acceptanceCriteria) &&
      computeCanonicalSha256(state.constraints) === computeCanonicalSha256(task.constraints) &&
      computeCanonicalSha256(state.requiredCheckIds ?? []) === computeCanonicalSha256(task.requiredChecks.map((check) => check.checkId)) &&
      state.taskContext !== undefined &&
      computeCanonicalSha256(state.taskContext) === computeCanonicalSha256(task);
  } catch {
    return false;
  }
}

export function addMilestone(
  milestones: readonly Milestone[],
  taskId: string,
  runId: string,
  node: string,
  kind: MilestoneKind,
  summary: string,
  outcome: 'success' | 'failure' | 'pending' | 'info' = 'info',
  evidenceRefs: readonly string[] = [],
): readonly Milestone[] {
  return [...milestones, createMilestone({ taskId, runId, node, kind, summary, outcome, evidenceRefs })];
}

export function resolveExpectedTestFiles(task: BugTask): readonly string[] {
  const files = new Set<string>();
  for (const check of task.requiredChecks) {
    for (const selector of extractCheckTestSelectors(check)) {
      if (!selector.isDirectory) files.add(selector.filePath);
    }
  }
  return Object.freeze([...files].sort());
}
export function trustedExpectedContext(
  config: UC03GraphConfig | undefined,
  task: BugTask,
  state: TaskState,
): TrustedHostExpectedContext | undefined {
  const trusted = config?.trustedExpectedContext;
  const expectedTestFiles = resolveExpectedTestFiles(task);
  if (
    !trusted || !trusted.executionGuard || !trusted.statePort || expectedTestFiles.length === 0 ||
    trusted.taskId !== task.taskId || trusted.workspaceId !== state.workspaceId ||
    trusted.repositoryId !== task.repositoryId || trusted.revisionDigest !== task.initialRevisionDigest ||
    trusted.criteriaDigest !== computeCanonicalSha256(task.acceptanceCriteria) ||
    trusted.checkSetDigest !== computeCheckSetDigest(task.requiredChecks) ||
    !samePaths(trusted.expectedTestFiles, expectedTestFiles)
  ) return undefined;
  return trusted;
}

export async function trustedOwnerStateMatches(
  trusted: TrustedHostExpectedContext,
  expected: TaskState,
): Promise<boolean> {
  try {
    const current = await trusted.statePort?.loadTask(expected.taskId);
    if (!current || !validateTaskState(current).ok) return false;
    return computeCanonicalSha256({ ...current, budgetLedgers: [] }) ===
      computeCanonicalSha256({ ...expected, budgetLedgers: [] });
  } catch {
    return false;
  }
}

export function resolveExecutionGuard(ports: UC03GraphPorts, config?: UC03GraphConfig): ExecutionGuardV02 | undefined {
  const trustedGuard = config?.trustedExpectedContext?.executionGuard;
  if (ports.executionGuard && trustedGuard && ports.executionGuard !== trustedGuard) return undefined;
  return trustedGuard ?? ports.executionGuard;
}

export function decisionMatchesState(binding: ApprovalBinding, state: TaskState): boolean {
  const plan = state.plan;
  const action = plan ? {
    actionId: state.activeDecisionId ?? '', kind: 'approve_fix_plan' as const,
    planVersion: plan.planVersion, strategyDigest: plan.strategyDigest,
    diagnosisEvidenceRefs: plan.evidenceRefs, checkSetDigest: plan.checkSetDigest,
  } : undefined;
  return !!plan && !!action && binding.status !== 'stale' && binding.actionKind === 'fix_plan' &&
    binding.decisionId === state.activeDecisionId && binding.taskId === state.taskId &&
    binding.workspaceId === state.workspaceId && binding.repositoryRevisionDigest === state.repositoryRevisionDigest &&
    binding.policyId === state.taskContext?.configId && binding.policyVersion === state.taskContext?.configVersion &&
    binding.normalizedActionDigest === computeCanonicalSha256(action) &&
    binding.planVersion === state.planVersion && binding.strategyDigest === plan.strategyDigest &&
    binding.baselineRef === plan.baselineRef && binding.checkSetDigest === plan.checkSetDigest &&
    binding.criteriaDigest === computeCanonicalSha256(state.acceptanceCriteria) &&
    computeCanonicalSha256(binding.evidenceRefs ?? []) === computeCanonicalSha256(plan.evidenceRefs);
}

export function samePersistedTransition(left: TaskState, right: TaskState): boolean {
  try {
    return computeCanonicalSha256({ ...left, budgetLedgers: left.budgetLedgers ?? [] }) ===
      computeCanonicalSha256({ ...right, budgetLedgers: right.budgetLedgers ?? [] });
  } catch {
    return false;
  }
}

export function requiredChecksPassed(
  task: BugTask,
  state: TaskState,
  diffDigest: string,
  results: readonly VerificationResult[],
): boolean {
  if (results.length !== task.requiredChecks.length) return false;
  return task.requiredChecks.every((check) => {
    const phase = check.purpose === 'reproduction' ? 'focused' : check.purpose;
    const matches = results.filter((result) => result.testedIds.includes(check.checkId));
    return matches.length === 1 && matches[0]?.outcome === 'pass' && matches[0].phase === phase &&
      matches[0].taskId === task.taskId && matches[0].runId === state.runId &&
      matches[0].repoDigest === state.repositoryRevisionDigest && matches[0].diffDigest === diffDigest;
  });
}

export function patchResult(value: unknown): { readonly applied: true; readonly newRevisionDigest: string; readonly executionReceipt: unknown } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  try {
    const applied = Object.getOwnPropertyDescriptor(value, 'applied');
    const digest = Object.getOwnPropertyDescriptor(value, 'newRevisionDigest');
    const receipt = Object.getOwnPropertyDescriptor(value, 'executionReceipt');
    if (applied === undefined || !('value' in applied) || applied.value !== true ||
        digest === undefined || !('value' in digest) || typeof digest.value !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/u.test(digest.value) || receipt === undefined || !('value' in receipt) ||
        typeof receipt.value !== 'object' || receipt.value === null) return null;
    return { applied: true, newRevisionDigest: digest.value, executionReceipt: receipt.value };
  } catch {
    return null;
  }
}

export function currentPlanBindingDigest(task: BugTask, state: TaskState): string {
  const plan = state.plan;
  if (!plan?.decisionRef) return '';
  return computeCanonicalSha256({
    taskId: state.taskId,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef ?? '',
    evidenceRefs: plan.evidenceRefs ?? [],
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: plan.checkSetDigest,
    decisionRef: plan.decisionRef,
  });
}

export function validDiffInfo(value: unknown): value is { readonly diff: string; readonly diffDigest: string; readonly changedFiles: readonly string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const diff = Object.getOwnPropertyDescriptor(value, 'diff');
    const digest = Object.getOwnPropertyDescriptor(value, 'diffDigest');
    const paths = Object.getOwnPropertyDescriptor(value, 'changedFiles');
    return diff !== undefined && 'value' in diff && typeof diff.value === 'string' &&
      digest !== undefined && 'value' in digest && typeof digest.value === 'string' &&
      digest.value === computeCanonicalSha256(diff.value) && paths !== undefined && 'value' in paths &&
      Array.isArray(paths.value) && paths.value.every((path) => typeof path === 'string');
  } catch {
    return false;
  }
}

export function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return computeCanonicalSha256([...left].sort()) === computeCanonicalSha256([...right].sort());
}

export function reviewAdmissionMatchesState(
  admission: ProviderAdmissionContextV02,
  state: TaskState,
  task: BugTask,
): boolean {
  const plan = state.plan;
  if (!plan || !plan.decisionRef || (state.activeDecisionId !== undefined && state.activeDecisionId !== plan.decisionRef)) return false;
  const planBindingDigest = currentPlanBindingDigest(task, state);
  return admission.planApplicability === 'approved-plan' && admission.planDecisionRef === plan.decisionRef &&
    admission.planBindingDigest === planBindingDigest && admission.providerRequest.taskId === state.taskId &&
    admission.providerRequest.runId === state.runId && admission.providerRequest.configId === task.configId &&
    admission.providerRequest.role === 'reviewer';
}
