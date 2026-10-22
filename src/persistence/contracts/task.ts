import {
  UC04_SCHEMA_VERSION,
  type StepStatus,
  type PlanStep,
  type CompactSummary,
  type RegisterTaskInput,
  type TaskState,
  type WorkspaceBaseline,
  type ValidationResult,
  type ValidationError,
} from './types.ts';
import { validateBudgetLedger } from './control.ts';

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}


export function validateStepStatus(status: unknown, path = 'status'): ValidationResult<StepStatus> {
  if (status === 'todo' || status === 'doing' || status === 'done' || status === 'failed') {
    return { ok: true, value: status };
  }
  return {
    ok: false,
    errors: [{ path, message: 'Expected canonical status: todo, doing, done, failed', code: 'INVALID_STEP_STATUS' }],
  };
}

export function validatePlanStep(val: unknown, path = 'step'): ValidationResult<PlanStep> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }
  if (typeof val.id !== 'string' || !val.id.trim()) {
    errors.push({ path: `${path}.id`, message: 'Step id must be a non-empty string', code: 'INVALID_ID' });
  }
  if (typeof val.title !== 'string' || !val.title.trim()) {
    errors.push({ path: `${path}.title`, message: 'Step title must be a non-empty string', code: 'INVALID_TITLE' });
  }
  if (typeof val.description !== 'string') {
    errors.push({ path: `${path}.description`, message: 'Step description must be a string', code: 'INVALID_DESCRIPTION' });
  }
  const statusRes = validateStepStatus(val.status, `${path}.status`);
  if (!statusRes.ok) {
    errors.push(...statusRes.errors);
  }
  if (val.predecessorIds !== undefined && !Array.isArray(val.predecessorIds)) {
    errors.push({ path: `${path}.predecessorIds`, message: 'predecessorIds must be an array of strings', code: 'INVALID_PREDECESSORS' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as PlanStep };
}

export function validateWorkspaceBaseline(val: unknown, path = 'workspace'): ValidationResult<WorkspaceBaseline> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }
  if (typeof val.commitHash !== 'string' || val.commitHash.length < 7) {
    errors.push({ path: `${path}.commitHash`, message: 'commitHash must be a valid commit SHA', code: 'INVALID_COMMIT_HASH' });
  }
  if (typeof val.branch !== 'string' || !val.branch.trim()) {
    errors.push({ path: `${path}.branch`, message: 'branch must be a non-empty string', code: 'INVALID_BRANCH' });
  }
  if (typeof val.isClean !== 'boolean') {
    errors.push({ path: `${path}.isClean`, message: 'isClean must be a boolean', code: 'INVALID_IS_CLEAN' });
  }
  if (typeof val.trackedFilesHash !== 'string' || !val.trackedFilesHash.trim()) {
    errors.push({ path: `${path}.trackedFilesHash`, message: 'trackedFilesHash must be a non-empty string', code: 'INVALID_FILES_HASH' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as WorkspaceBaseline };
}

export function validateCompactSummary(val: unknown, path = 'summary'): ValidationResult<CompactSummary> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }
  if (typeof val.taskId !== 'string' || !val.taskId.trim()) {
    errors.push({ path: `${path}.taskId`, message: 'taskId must be non-empty', code: 'INVALID_TASK_ID' });
  }
  if (typeof val.sourceStateVersion !== 'number' || !Number.isInteger(val.sourceStateVersion) || val.sourceStateVersion < 1) {
    errors.push({ path: `${path}.sourceStateVersion`, message: 'sourceStateVersion must be an integer >= 1', code: 'INVALID_VERSION' });
  }
  if (typeof val.goal !== 'string' || !val.goal.trim()) {
    errors.push({ path: `${path}.goal`, message: 'goal must be non-empty', code: 'INVALID_GOAL' });
  }
  if (!Array.isArray(val.constraints)) {
    errors.push({ path: `${path}.constraints`, message: 'constraints must be an array', code: 'INVALID_CONSTRAINTS' });
  }
  if (!Array.isArray(val.completedWork)) {
    errors.push({ path: `${path}.completedWork`, message: 'completedWork must be an array', code: 'INVALID_COMPLETED_WORK' });
  }
  if (typeof val.currentState !== 'string' || !val.currentState.trim()) {
    errors.push({ path: `${path}.currentState`, message: 'currentState must be non-empty', code: 'INVALID_CURRENT_STATE' });
  }
  if (!Array.isArray(val.openRisks)) {
    errors.push({ path: `${path}.openRisks`, message: 'openRisks must be an array', code: 'INVALID_OPEN_RISKS' });
  }
  if (typeof val.nextAction !== 'string' || !val.nextAction.trim()) {
    errors.push({ path: `${path}.nextAction`, message: 'nextAction must be non-empty', code: 'INVALID_NEXT_ACTION' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as CompactSummary };
}

export function validateRegisterTaskInput(val: unknown, path = 'input'): ValidationResult<RegisterTaskInput> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }
  if (val.schemaVersion !== UC04_SCHEMA_VERSION) {
    errors.push({ path: `${path}.schemaVersion`, message: `Expected schema version ${UC04_SCHEMA_VERSION}`, code: 'INCOMPATIBLE_VERSION' });
  }
  if (typeof val.taskId !== 'string' || !val.taskId.trim()) {
    errors.push({ path: `${path}.taskId`, message: 'taskId must be non-empty', code: 'INVALID_TASK_ID' });
  }
  if (typeof val.repositoryId !== 'string' || !val.repositoryId.trim()) {
    errors.push({ path: `${path}.repositoryId`, message: 'repositoryId must be non-empty', code: 'INVALID_REPO_ID' });
  }
  if (typeof val.workspaceId !== 'string' || !val.workspaceId.trim()) {
    errors.push({ path: `${path}.workspaceId`, message: 'workspaceId must be non-empty', code: 'INVALID_WORKSPACE_ID' });
  }
  if (!['feature', 'bugfix', 'refactor'].includes(val.taskType as string)) {
    errors.push({ path: `${path}.taskType`, message: 'taskType must be feature, bugfix, or refactor', code: 'INVALID_TASK_TYPE' });
  }
  if (typeof val.goal !== 'string' || !val.goal.trim()) {
    errors.push({ path: `${path}.goal`, message: 'goal must be non-empty', code: 'INVALID_GOAL' });
  }
  if (!Array.isArray(val.acceptanceCriteria)) {
    errors.push({ path: `${path}.acceptanceCriteria`, message: 'acceptanceCriteria must be an array', code: 'INVALID_CRITERIA' });
  }
  if (!Array.isArray(val.constraints)) {
    errors.push({ path: `${path}.constraints`, message: 'constraints must be an array', code: 'INVALID_CONSTRAINTS' });
  }
  if (!Array.isArray(val.plan) || val.plan.length === 0) {
    errors.push({ path: `${path}.plan`, message: 'plan must be a non-empty array', code: 'INVALID_PLAN' });
  } else {
    const stepIds = new Set<string>();
    for (let i = 0; i < val.plan.length; i++) {
      const stepRes = validatePlanStep(val.plan[i], `${path}.plan[${i}]`);
      if (!stepRes.ok) {
        errors.push(...stepRes.errors);
      } else {
        if (stepIds.has(stepRes.value.id)) {
          errors.push({ path: `${path}.plan[${i}].id`, message: `Duplicate step ID: ${stepRes.value.id}`, code: 'DUPLICATE_STEP_ID' });
        } else {
          stepIds.add(stepRes.value.id);
        }
      }
    }
    // Verify predecessor integrity: must be internal and acyclic
    const adj = new Map<string, string[]>();
    for (let i = 0; i < val.plan.length; i++) {
      const s = val.plan[i] as PlanStep;
      if (s && s.id) {
        const preds = s.predecessorIds ?? [];
        for (const pred of preds) {
          if (!stepIds.has(pred)) {
            errors.push({ path: `${path}.plan[${i}].predecessorIds`, message: `Unknown predecessor ${pred}`, code: 'FOREIGN_PREDECESSOR' });
          }
        }
        adj.set(s.id, [...preds]);
      }
    }
    // Check cycle using DFS
    const visited = new Map<string, number>(); // 0: unvisited, 1: visiting, 2: visited
    function hasCycle(node: string): boolean {
      visited.set(node, 1);
      const neighbors = adj.get(node) ?? [];
      for (const n of neighbors) {
        const state = visited.get(n) ?? 0;
        if (state === 1) return true;
        if (state === 0 && hasCycle(n)) return true;
      }
      visited.set(node, 2);
      return false;
    }
    for (const id of stepIds) {
      if ((visited.get(id) ?? 0) === 0) {
        if (hasCycle(id)) {
          errors.push({ path: `${path}.plan`, message: 'Plan steps contain cyclic dependency', code: 'CYCLIC_DEPENDENCY' });
          break;
        }
      }
    }
  }

  if (!Array.isArray(val.budgetLedgers)) {
    errors.push({ path: `${path}.budgetLedgers`, message: 'budgetLedgers must be an array', code: 'INVALID_LEDGERS' });
  } else {
    for (let i = 0; i < val.budgetLedgers.length; i++) {
      const lRes = validateBudgetLedger(val.budgetLedgers[i], `${path}.budgetLedgers[${i}]`);
      if (!lRes.ok) errors.push(...lRes.errors);
    }
  }

  const wsRes = validateWorkspaceBaseline(val.workspaceBaseline, `${path}.workspaceBaseline`);
  if (!wsRes.ok) errors.push(...wsRes.errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as RegisterTaskInput };
}

export function validateTaskState(val: unknown, path = 'state'): ValidationResult<TaskState> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }
  if (val.schemaVersion !== UC04_SCHEMA_VERSION) {
    errors.push({ path: `${path}.schemaVersion`, message: `Expected schema version ${UC04_SCHEMA_VERSION}`, code: 'INCOMPATIBLE_VERSION' });
  }
  if (typeof val.taskId !== 'string' || !val.taskId.trim()) {
    errors.push({ path: `${path}.taskId`, message: 'taskId must be non-empty', code: 'INVALID_TASK_ID' });
  }
  if (typeof val.runId !== 'string' || !val.runId.trim()) {
    errors.push({ path: `${path}.runId`, message: 'runId must be non-empty', code: 'INVALID_RUN_ID' });
  }
  if (typeof val.stateVersion !== 'number' || !Number.isInteger(val.stateVersion) || val.stateVersion < 1) {
    errors.push({ path: `${path}.stateVersion`, message: 'stateVersion must be an integer >= 1', code: 'INVALID_VERSION' });
  }
  if (val.currentStepIndex !== undefined && (typeof val.currentStepIndex !== 'number' || !Number.isInteger(val.currentStepIndex) || val.currentStepIndex < 0)) {
    errors.push({ path: `${path}.currentStepIndex`, message: 'currentStepIndex must be an integer >= 0', code: 'INVALID_STEP_INDEX' });
  }
  if (!Array.isArray(val.plan)) {
    errors.push({ path: `${path}.plan`, message: 'plan must be an array', code: 'INVALID_PLAN' });
  }
  if (!Array.isArray(val.budgetLedgers)) {
    errors.push({ path: `${path}.budgetLedgers`, message: 'budgetLedgers must be an array', code: 'INVALID_LEDGERS' });
  }
  const wsRes = validateWorkspaceBaseline(val.workspaceBaseline, `${path}.workspaceBaseline`);
  if (!wsRes.ok) errors.push(...wsRes.errors);

  if (val.pendingApproval !== undefined) {
    // dynamically imported or called from control
    const appRes = validateApprovalRequestBinding(val.pendingApproval, `${path}.pendingApproval`);
    if (!appRes.ok) errors.push(...appRes.errors);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as TaskState };
}

// Helper forward definition for pendingApproval in TaskState
import { validateApprovalRequestBinding } from './control.ts';
