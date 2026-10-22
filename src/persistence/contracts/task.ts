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
import { validateBudgetLedger, validateApprovalRequestBinding } from './control.ts';

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function checkStr(errors: ValidationError[], val: unknown, path: string, message: string, code: string): void {
  if (typeof val !== 'string' || !val.trim()) errors.push({ path, message, code });
}

function checkStringArray(
  errors: ValidationError[],
  arr: unknown,
  path: string,
  name: string,
  code: string,
  allowEmpty = true
): void {
  if (!Array.isArray(arr)) {
    errors.push({ path, message: `${name} must be an array`, code });
    return;
  }
  if (!allowEmpty && arr.length === 0) {
    errors.push({ path, message: `${name} must not be empty`, code });
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== 'string' || !arr[i].trim()) {
      errors.push({ path: `${path}[${i}]`, message: `${name} items must be non-empty strings`, code });
    }
  }
}

const ALLOWED_STEP_KEYS = new Set([
  'id',
  'title',
  'description',
  'status',
  'predecessorIds',
  'startedAt',
  'completedAt',
  'evidenceRefs',
  'error',
  'changedFiles',
]);

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
  for (const key of Object.keys(val)) {
    if (!ALLOWED_STEP_KEYS.has(key)) {
      errors.push({ path: `${path}.${key}`, message: `Unknown property "${key}" in PlanStep`, code: 'UNKNOWN_PROPERTY' });
    }
  }
  checkStr(errors, val.id, `${path}.id`, 'Step id must be a non-empty string', 'INVALID_ID');
  checkStr(errors, val.title, `${path}.title`, 'Step title must be a non-empty string', 'INVALID_TITLE');
  if (typeof val.description !== 'string') {
    errors.push({ path: `${path}.description`, message: 'Step description must be a string', code: 'INVALID_DESCRIPTION' });
  }
  const statusRes = validateStepStatus(val.status, `${path}.status`);
  if (!statusRes.ok) errors.push(...statusRes.errors);

  if (val.startedAt !== undefined && (typeof val.startedAt !== 'string' || !val.startedAt.trim())) {
    errors.push({ path: `${path}.startedAt`, message: 'startedAt must be a non-empty string', code: 'INVALID_TIMESTAMP' });
  }
  if (val.completedAt !== undefined && (typeof val.completedAt !== 'string' || !val.completedAt.trim())) {
    errors.push({ path: `${path}.completedAt`, message: 'completedAt must be a non-empty string', code: 'INVALID_TIMESTAMP' });
  }
  if (val.error !== undefined && typeof val.error !== 'string') {
    errors.push({ path: `${path}.error`, message: 'error must be a string', code: 'INVALID_ERROR' });
  }

  if (val.predecessorIds !== undefined) {
    checkStringArray(errors, val.predecessorIds, `${path}.predecessorIds`, 'predecessorIds', 'INVALID_PREDECESSORS', true);
  }
  if (val.evidenceRefs !== undefined) {
    checkStringArray(errors, val.evidenceRefs, `${path}.evidenceRefs`, 'evidenceRefs', 'INVALID_REFS', true);
  }
  if (val.changedFiles !== undefined) {
    checkStringArray(errors, val.changedFiles, `${path}.changedFiles`, 'changedFiles', 'INVALID_FILES', true);
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
  checkStr(errors, val.branch, `${path}.branch`, 'branch must be a non-empty string', 'INVALID_BRANCH');
  if (typeof val.isClean !== 'boolean') {
    errors.push({ path: `${path}.isClean`, message: 'isClean must be a boolean', code: 'INVALID_IS_CLEAN' });
  }
  checkStr(errors, val.trackedFilesHash, `${path}.trackedFilesHash`, 'trackedFilesHash must be a non-empty string', 'INVALID_FILES_HASH');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as WorkspaceBaseline };
}

export function validatePlanIntegrity(
  plan: unknown,
  errors: ValidationError[],
  path: string,
  requireInitialTodo = false,
  allowEmpty = false
): void {
  if (!Array.isArray(plan)) {
    errors.push({ path, message: 'plan must be an array', code: 'INVALID_PLAN' });
    return;
  }
  if (!allowEmpty && plan.length === 0) {
    errors.push({ path, message: 'plan must be a non-empty array', code: 'INVALID_PLAN' });
    return;
  }
  const stepIds = new Set<string>();
  for (let i = 0; i < plan.length; i++) {
    const stepRes = validatePlanStep(plan[i], `${path}[${i}]`);
    if (!stepRes.ok) {
      errors.push(...stepRes.errors);
    } else {
      if (requireInitialTodo && stepRes.value.status !== 'todo') {
        errors.push({ path: `${path}[${i}].status`, message: 'New registered task plan steps must have status "todo"', code: 'INVALID_STEP_STATUS' });
      }
      if (stepIds.has(stepRes.value.id)) {
        errors.push({ path: `${path}[${i}].id`, message: `Duplicate step ID: ${stepRes.value.id}`, code: 'DUPLICATE_STEP_ID' });
      } else {
        stepIds.add(stepRes.value.id);
      }
    }
  }

  // Predecessor integrity & cycle detection
  const adj = new Map<string, string[]>();
  for (let i = 0; i < plan.length; i++) {
    const s: unknown = plan[i];
    if (isObject(s) && typeof s.id === 'string' && s.id) {
      const rawPreds = Array.isArray(s.predecessorIds) ? s.predecessorIds : [];
      const preds: string[] = [];
      for (const pred of rawPreds) {
        if (typeof pred !== 'string' || !stepIds.has(pred)) {
          errors.push({ path: `${path}[${i}].predecessorIds`, message: `Unknown predecessor ${pred}`, code: 'FOREIGN_PREDECESSOR' });
          continue;
        }
        preds.push(pred);
      }
      adj.set(s.id, preds);
    }
  }

  const visited = new Map<string, number>();
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
        errors.push({ path, message: 'Plan steps contain cyclic dependency', code: 'CYCLIC_DEPENDENCY' });
        break;
      }
    }
  }
}

export function validateCompactSummary(val: unknown, path = 'summary'): ValidationResult<CompactSummary> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };

  checkStr(errors, val.taskId, `${path}.taskId`, 'taskId must be non-empty', 'INVALID_TASK_ID');
  if (typeof val.sourceStateVersion !== 'number' || !Number.isInteger(val.sourceStateVersion) || val.sourceStateVersion < 1) {
    errors.push({ path: `${path}.sourceStateVersion`, message: 'sourceStateVersion must be an integer >= 1', code: 'INVALID_VERSION' });
  }
  checkStr(errors, val.goal, `${path}.goal`, 'goal must be non-empty', 'INVALID_GOAL');
  checkStringArray(errors, val.constraints, `${path}.constraints`, 'constraints', 'INVALID_CONSTRAINTS', true);
  checkStringArray(errors, val.completedWork, `${path}.completedWork`, 'completedWork', 'INVALID_COMPLETED_WORK', true);
  checkStr(errors, val.currentState, `${path}.currentState`, 'currentState must be non-empty', 'INVALID_CURRENT_STATE');
  checkStringArray(errors, val.openRisks, `${path}.openRisks`, 'openRisks', 'INVALID_OPEN_RISKS', true);
  checkStr(errors, val.nextAction, `${path}.nextAction`, 'nextAction must be non-empty', 'INVALID_NEXT_ACTION');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as CompactSummary };
}

export function validateRegisterTaskInput(val: unknown, path = 'input'): ValidationResult<RegisterTaskInput> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };

  if (val.schemaVersion !== UC04_SCHEMA_VERSION) {
    errors.push({ path: `${path}.schemaVersion`, message: `Expected schema version ${UC04_SCHEMA_VERSION}`, code: 'INCOMPATIBLE_VERSION' });
  }
  checkStr(errors, val.taskId, `${path}.taskId`, 'taskId must be non-empty', 'INVALID_TASK_ID');
  checkStr(errors, val.repositoryId, `${path}.repositoryId`, 'repositoryId must be non-empty', 'INVALID_REPO_ID');
  checkStr(errors, val.workspaceId, `${path}.workspaceId`, 'workspaceId must be non-empty', 'INVALID_WORKSPACE_ID');
  if (!['feature', 'bugfix', 'refactor'].includes(val.taskType as string)) {
    errors.push({ path: `${path}.taskType`, message: 'taskType must be feature, bugfix, or refactor', code: 'INVALID_TASK_TYPE' });
  }
  checkStr(errors, val.goal, `${path}.goal`, 'goal must be non-empty', 'INVALID_GOAL');
  checkStringArray(errors, val.acceptanceCriteria, `${path}.acceptanceCriteria`, 'acceptanceCriteria', 'INVALID_CRITERIA', false);
  checkStringArray(errors, val.constraints, `${path}.constraints`, 'constraints', 'INVALID_CONSTRAINTS', true);

  validatePlanIntegrity(val.plan, errors, `${path}.plan`, true, false);

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
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };

  if (val.schemaVersion !== UC04_SCHEMA_VERSION) {
    errors.push({ path: `${path}.schemaVersion`, message: `Expected schema version ${UC04_SCHEMA_VERSION}`, code: 'INCOMPATIBLE_VERSION' });
  }
  checkStr(errors, val.taskId, `${path}.taskId`, 'taskId must be non-empty', 'INVALID_TASK_ID');
  checkStr(errors, val.runId, `${path}.runId`, 'runId must be non-empty', 'INVALID_RUN_ID');
  checkStr(errors, val.repositoryId, `${path}.repositoryId`, 'repositoryId must be a non-empty string', 'INVALID_REPOSITORY_ID');
  checkStr(errors, val.workspaceId, `${path}.workspaceId`, 'workspaceId must be a non-empty string', 'INVALID_WORKSPACE_ID');
  if (!['feature', 'bugfix', 'refactor'].includes(val.taskType as string)) {
    errors.push({ path: `${path}.taskType`, message: 'taskType must be feature, bugfix, or refactor', code: 'INVALID_TASK_TYPE' });
  }
  checkStr(errors, val.goal, `${path}.goal`, 'goal must be a non-empty string', 'INVALID_GOAL');
  checkStringArray(errors, val.acceptanceCriteria, `${path}.acceptanceCriteria`, 'acceptanceCriteria', 'INVALID_CRITERIA', true);
  checkStringArray(errors, val.constraints, `${path}.constraints`, 'constraints', 'INVALID_CONSTRAINTS', true);

  validatePlanIntegrity(val.plan, errors, `${path}.plan`, false, true);

  const planLen = Array.isArray(val.plan) ? val.plan.length : 0;
  if (typeof val.currentStepIndex !== 'number' || !Number.isInteger(val.currentStepIndex) || val.currentStepIndex < 0 || val.currentStepIndex > planLen) {
    errors.push({ path: `${path}.currentStepIndex`, message: `currentStepIndex must be an integer between 0 and plan length (${planLen})`, code: 'INVALID_STEP_INDEX' });
  }

  const validStatuses = ['pending', 'running', 'waiting_approval', 'paused', 'completed', 'failed'];
  if (typeof val.status !== 'string' || !validStatuses.includes(val.status)) {
    errors.push({ path: `${path}.status`, message: `status must be one of ${validStatuses.join(', ')}`, code: 'INVALID_STATUS' });
  }

  if (typeof val.stateVersion !== 'number' || !Number.isInteger(val.stateVersion) || val.stateVersion < 1) {
    errors.push({ path: `${path}.stateVersion`, message: 'stateVersion must be an integer >= 1', code: 'INVALID_VERSION' });
  }

  if (val.lastCheckpointId !== undefined) {
    checkStr(errors, val.lastCheckpointId, `${path}.lastCheckpointId`, 'lastCheckpointId must be non-empty', 'INVALID_CHECKPOINT_ID');
  }

  if (!Array.isArray(val.budgetLedgers)) {
    errors.push({ path: `${path}.budgetLedgers`, message: 'budgetLedgers must be an array', code: 'INVALID_LEDGERS' });
  } else {
    for (let i = 0; i < val.budgetLedgers.length; i++) {
      const lRes = validateBudgetLedger(val.budgetLedgers[i], `${path}.budgetLedgers[${i}]`);
      if (!lRes.ok) errors.push(...lRes.errors);
    }
  }

  checkStringArray(errors, val.changedFiles, `${path}.changedFiles`, 'changedFiles', 'INVALID_CHANGED_FILES', true);
  checkStringArray(errors, val.openRisks, `${path}.openRisks`, 'openRisks', 'INVALID_OPEN_RISKS', true);
  checkStr(errors, val.nextAction, `${path}.nextAction`, 'nextAction must be a non-empty string', 'INVALID_NEXT_ACTION');

  const wsRes = validateWorkspaceBaseline(val.workspaceBaseline, `${path}.workspaceBaseline`);
  if (!wsRes.ok) errors.push(...wsRes.errors);

  if (val.pendingApproval !== undefined) {
    const appRes = validateApprovalRequestBinding(val.pendingApproval, `${path}.pendingApproval`);
    if (!appRes.ok) errors.push(...appRes.errors);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as TaskState };
}
