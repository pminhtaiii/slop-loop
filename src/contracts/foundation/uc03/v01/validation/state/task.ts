/** Full persisted task-state validation. */

import { canonicalJsonStringify, isCanonicalRelativePath } from '../../../identity.ts';
import type { BudgetLedger, BugTask, FixPlan, PlanStep, TaskNode, TaskOutcome, TaskState, ValidationError, ValidationResult } from '../../types.ts';
import { CONTRACT_VERSION } from '../../types.ts';
import { isPlainObject, rejectUnknownKeys, validateNonEmptyString, validateNonNegativeInteger, validatePositiveInteger } from '../common.ts';
import { validateBugTask } from '../intake.ts';

import { validateTaskNode, validatePlanStep, validateFixPlan } from './primitives.ts';
import { validateBudgetLedger } from './budget.ts';

const TASK_STATE_ALLOWED_KEYS = [
  'schemaVersion',
  'stateVersion',
  'taskId',
  'runId',
  'workspaceId',
  'repositoryId',
  'repositoryRevisionDigest',
  'goal',
  'observedBehavior',
  'expectedBehavior',
  'reproduction',
  'acceptanceCriteria',
  'constraints',
  'requiredCheckIds',
  'taskContext',
  'node',
  'planVersion',
  'replanCount',
  'plan',
  'steps',
  'changedPaths',
  'evidenceRefs',
  'approvalDecisionRefs',
  'activeDecisionId',
  'reviewRefs',
  'latestReviewRef',
  'budgetLedgers',
  'checkpointConfigId',
  'checkpointVersion',
  'risks',
  'nextAction',
  'outcome',
] as const;

export function validateTaskState(input: unknown): ValidationResult<TaskState> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'taskState', message: 'TaskState must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, TASK_STATE_ALLOWED_KEYS, '', errors);

  for (const key of ['acceptanceCriteria', 'constraints', 'requiredCheckIds', 'changedPaths', 'evidenceRefs', 'approvalDecisionRefs', 'reviewRefs', 'risks']) {
    const value = input[key];
    if (Array.isArray(value)) value.forEach((item, index) => {
      validateNonEmptyString(item, `${key}[${index}]`, errors);
      if (key === 'changedPaths' && (typeof item !== 'string' ||
      !isCanonicalRelativePath(item))) errors.push({ path: `${key}[${index}]`, code: 'INVALID_PATH', message: 'Changed path must be canonical and relative' });
    });
  }
  const schemaVersion = validateNonEmptyString(input['schemaVersion'], 'schemaVersion', errors);
  if (schemaVersion && schemaVersion !== CONTRACT_VERSION) {
    errors.push({
      path: 'schemaVersion',
      message: `schemaVersion must match current contract version ${CONTRACT_VERSION}`,
      code: 'SCHEMA_VERSION_MISMATCH',
    });
  }

  const stateVersion = validatePositiveInteger(input['stateVersion'], 'stateVersion', errors);
  const taskId = validateNonEmptyString(input['taskId'], 'taskId', errors);
  const runId = validateNonEmptyString(input['runId'], 'runId', errors);
  const workspaceId = validateNonEmptyString(input['workspaceId'], 'workspaceId', errors);
  const repositoryId = validateNonEmptyString(input['repositoryId'], 'repositoryId', errors);
  const repositoryRevisionDigest = validateNonEmptyString(
    input['repositoryRevisionDigest'],
    'repositoryRevisionDigest',
    errors
  );
  const goal = validateNonEmptyString(input['goal'], 'goal', errors);
  const nextAction = validateNonEmptyString(input['nextAction'], 'nextAction', errors);

  let observedBehavior: string | undefined;
  if (input['observedBehavior'] !== undefined) {
    observedBehavior = validateNonEmptyString(input['observedBehavior'], 'observedBehavior', errors);
  }

  let expectedBehavior: string | undefined;
  if (input['expectedBehavior'] !== undefined) {
    expectedBehavior = validateNonEmptyString(input['expectedBehavior'], 'expectedBehavior', errors);
  }

  let reproduction: string | undefined;
  if (input['reproduction'] !== undefined) {
    reproduction = validateNonEmptyString(input['reproduction'], 'reproduction', errors);
  }

  if (!Array.isArray(input['acceptanceCriteria'])) {
    errors.push({
      path: 'acceptanceCriteria',
      message: 'acceptanceCriteria must be an array of strings',
      code: 'INVALID_TYPE',
    });
  }

  if (!Array.isArray(input['constraints'])) {
    errors.push({
      path: 'constraints',
      message: 'constraints must be an array of strings',
      code: 'INVALID_TYPE',
    });
  }

  let requiredCheckIds: readonly string[] | undefined;
  if (input['requiredCheckIds'] !== undefined) {
    if (!Array.isArray(input['requiredCheckIds'])) {
      errors.push({
        path: 'requiredCheckIds',
        message: 'requiredCheckIds must be an array of strings',
        code: 'INVALID_TYPE',
      });
    } else {
      requiredCheckIds = input['requiredCheckIds'] as readonly string[];
    }
  }

  let taskContext: BugTask | undefined;
  if (input['taskContext'] !== undefined) {
    const contextRes = validateBugTask(input['taskContext']);
    if (!contextRes.ok) {
      errors.push(...contextRes.errors);
    } else {
      taskContext = contextRes.value;
    }
  }

  if (!taskContext) errors.push({ path: 'taskContext', code: 'MISSING_TASK_CONTEXT', message: 'Complete original validated BugTask is required for recovery' });
  if (taskContext) {
    const originals: Record<string, unknown> = { taskId: taskContext.taskId, repositoryId: taskContext.repositoryId, goal: taskContext.goal, observedBehavior: taskContext.observedBehavior, expectedBehavior: taskContext.expectedBehavior, reproduction: taskContext.reproduction, acceptanceCriteria: taskContext.acceptanceCriteria, constraints: taskContext.constraints, requiredCheckIds: taskContext.requiredChecks.map(c => c.checkId) };
    for (const [key, value] of Object.entries(originals)) if (canonicalJsonStringify(input[key]) !== canonicalJsonStringify(value)) errors.push({ path: key, code: 'TASK_CONTEXT_MISMATCH', message: 'State must preserve original task context' });
  }
  const nodeRes = validateTaskNode(input['node']);
  let node: TaskNode | undefined;
  if (!nodeRes.ok) {
    errors.push(...nodeRes.errors);
  } else {
    node = nodeRes.value;
  }

  const planVersion = validatePositiveInteger(input['planVersion'], 'planVersion', errors);
  const replanCount = validateNonNegativeInteger(input['replanCount'], 'replanCount', errors);
  if (replanCount !== undefined && replanCount > 3) {
    errors.push({
      path: 'replanCount',
      message: 'replanCount cannot exceed 3 (fixed task-scoped replan limit)',
      code: 'REPLAN_CAP_EXCEEDED',
    });
  }

  let plan: FixPlan | undefined;
  if (input['plan'] !== undefined) {
    const planRes = validateFixPlan(input['plan'], 'plan');
    if (!planRes.ok) {
      errors.push(...planRes.errors);
    } else {
      plan = planRes.value;
    }
  }

  let steps: PlanStep[] | undefined;
  if (input['steps'] !== undefined) {
    if (!Array.isArray(input['steps'])) {
      errors.push({
        path: 'steps',
        message: 'steps must be an array of PlanStep objects',
        code: 'INVALID_TYPE',
      });
    } else {
      steps = [];
      for (let i = 0; i < input['steps'].length; i++) {
        const stepRes = validatePlanStep(input['steps'][i], `steps[${i}]`);
        if (!stepRes.ok) {
          errors.push(...stepRes.errors);
        } else {
          steps.push(stepRes.value);
        }
      }
    }
  }

  if (!Array.isArray(input['changedPaths'])) {
    errors.push({
      path: 'changedPaths',
      message: 'changedPaths must be an array of strings',
      code: 'INVALID_TYPE',
    });
  }

  if (!Array.isArray(input['evidenceRefs'])) {
    errors.push({
      path: 'evidenceRefs',
      message: 'evidenceRefs must be an array of strings',
      code: 'INVALID_TYPE',
    });
  }

  let approvalDecisionRefs: readonly string[] | undefined;
  if (input['approvalDecisionRefs'] !== undefined) {
    if (!Array.isArray(input['approvalDecisionRefs'])) {
      errors.push({
        path: 'approvalDecisionRefs',
        message: 'approvalDecisionRefs must be an array of strings',
        code: 'INVALID_TYPE',
      });
    } else {
      approvalDecisionRefs = input['approvalDecisionRefs'] as readonly string[];
    }
  }

  let activeDecisionId: string | undefined;
  if (input['activeDecisionId'] !== undefined) {
    activeDecisionId = validateNonEmptyString(input['activeDecisionId'], 'activeDecisionId', errors);
  }

  let reviewRefs: readonly string[] | undefined;
  if (input['reviewRefs'] !== undefined) {
    if (!Array.isArray(input['reviewRefs'])) {
      errors.push({
        path: 'reviewRefs',
        message: 'reviewRefs must be an array of strings',
        code: 'INVALID_TYPE',
      });
    } else {
      reviewRefs = input['reviewRefs'] as readonly string[];
    }
  }

  let latestReviewRef: string | undefined;
  if (input['latestReviewRef'] !== undefined) {
    latestReviewRef = validateNonEmptyString(input['latestReviewRef'], 'latestReviewRef', errors);
  }

  let budgetLedgers: BudgetLedger[] | undefined;
  if (input['budgetLedgers'] !== undefined) {
    if (!Array.isArray(input['budgetLedgers'])) {
      errors.push({
        path: 'budgetLedgers',
        message: 'budgetLedgers must be an array of BudgetLedger objects',
        code: 'INVALID_TYPE',
      });
    } else {
      budgetLedgers = [];
      for (let i = 0; i < input['budgetLedgers'].length; i++) {
        const ledgerRes = validateBudgetLedger(input['budgetLedgers'][i], `budgetLedgers[${i}]`);
        if (!ledgerRes.ok) {
          errors.push(...ledgerRes.errors);
        } else {
          budgetLedgers.push(ledgerRes.value);
        }
      }
    }
  }

  const ledgerKeys = new Set<string>();
  for (const ledger of budgetLedgers ?? []) {
    const key = `${ledger.scope}:${ledger.kind}`;
    if (ledgerKeys.has(key)) errors.push({ path: 'budgetLedgers', code: 'DUPLICATE_LEDGER', message: 'Each accounting scope and kind must have one ledger' });
    ledgerKeys.add(key);
    if (ledger.consumed + ledger.reservations.reduce((sum, r) => sum + r.amount, 0) > ledger.limit) errors.push({ path: 'budgetLedgers', code: 'BUDGET_EXHAUSTED', message: 'Persisted charges cannot exceed the configured limit' });
  }
  if (replanCount !== undefined && replanCount > 0) {
    const ledger = budgetLedgers?.find(l => l.scope === 'task' && l.kind === 'replan');
    if (!ledger ||
      ledger.configurationId !== taskContext?.configId ||
      ledger.limit > 3 ||
      ledger.consumed + ledger.reservations.reduce((sum, r) => sum + r.amount, 0) < replanCount) errors.push({ path: 'budgetLedgers', code: 'MISSING_REPLAN_ACCOUNTING', message: 'Recovery must retain all task-scoped replan charges' });
  }

  let checkpointConfigId: string | undefined;
  if (input['checkpointConfigId'] !== undefined) {
    checkpointConfigId = validateNonEmptyString(input['checkpointConfigId'], 'checkpointConfigId', errors);
  }

  let checkpointVersion: number | undefined;
  if (input['checkpointVersion'] !== undefined) {
    checkpointVersion = validateNonNegativeInteger(input['checkpointVersion'], 'checkpointVersion', errors);
  }

  if (!Array.isArray(input['risks'])) {
    errors.push({
      path: 'risks',
      message: 'risks must be an array of strings',
      code: 'INVALID_TYPE',
    });
  }

  // Terminal vs Non-terminal outcome validation
  let outcome: TaskOutcome | undefined;
  const rawOutcome = input['outcome'];
  if (node === 'Deliver') {
    if (rawOutcome !== 'COMPLETED' && rawOutcome !== 'IMPLEMENTED_UNVERIFIED') {
      errors.push({
        path: 'outcome',
        message: 'Deliver node requires outcome COMPLETED or IMPLEMENTED_UNVERIFIED',
        code: 'INVALID_TERMINAL_OUTCOME',
      });
    } else {
      outcome = rawOutcome;
    }
  } else if (node === 'Incomplete') {
    if (rawOutcome !== 'INCOMPLETE' && rawOutcome !== 'FAILED') {
      errors.push({
        path: 'outcome',
        message: 'Incomplete node requires outcome INCOMPLETE or FAILED',
        code: 'INVALID_TERMINAL_OUTCOME',
      });
    } else {
      outcome = rawOutcome;
    }
  } else {
    if (rawOutcome !== undefined) {
      errors.push({
        path: 'outcome',
        message: `Non-terminal node ${node} cannot have an outcome set`,
        code: 'NON_TERMINAL_OUTCOME_SET',
      });
    }
  }

  if (
    errors.length > 0 ||
    !schemaVersion ||
    schemaVersion !== CONTRACT_VERSION ||
    stateVersion === undefined ||
    !taskId ||
    !runId ||
    !workspaceId ||
    !repositoryId ||
    !repositoryRevisionDigest ||
    !goal ||
    !Array.isArray(input['acceptanceCriteria']) ||
    !Array.isArray(input['constraints']) ||
    !node ||
    planVersion === undefined ||
    replanCount === undefined ||
    replanCount > 3 ||
    !Array.isArray(input['changedPaths']) ||
    !Array.isArray(input['evidenceRefs']) ||
    !Array.isArray(input['risks']) ||
    !nextAction
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      schemaVersion,
      stateVersion,
      taskId,
      runId,
      workspaceId,
      repositoryId,
      repositoryRevisionDigest,
      goal,
      ...(observedBehavior !== undefined ? { observedBehavior } : {}),
      ...(expectedBehavior !== undefined ? { expectedBehavior } : {}),
      ...(reproduction !== undefined ? { reproduction } : {}),
      acceptanceCriteria: input['acceptanceCriteria'] as readonly string[],
      constraints: input['constraints'] as readonly string[],
      ...(requiredCheckIds !== undefined ? { requiredCheckIds } : {}),
      ...(taskContext !== undefined ? { taskContext } : {}),
      node,
      planVersion,
      replanCount,
      ...(plan !== undefined ? { plan } : {}),
      ...(steps !== undefined ? { steps } : {}),
      changedPaths: input['changedPaths'] as readonly string[],
      evidenceRefs: input['evidenceRefs'] as readonly string[],
      ...(approvalDecisionRefs !== undefined ? { approvalDecisionRefs } : {}),
      ...(activeDecisionId !== undefined ? { activeDecisionId } : {}),
      ...(reviewRefs !== undefined ? { reviewRefs } : {}),
      ...(latestReviewRef !== undefined ? { latestReviewRef } : {}),
      ...(budgetLedgers !== undefined ? { budgetLedgers } : {}),
      ...(checkpointConfigId !== undefined ? { checkpointConfigId } : {}),
      ...(checkpointVersion !== undefined ? { checkpointVersion } : {}),
      risks: input['risks'] as readonly string[],
      nextAction,
      ...(outcome !== undefined ? { outcome } : {}),
    },
  };
}
