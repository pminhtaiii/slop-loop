/** Task state, plan, envelope, and budget ledger validation. */

import { canonicalJsonStringify, isCanonicalRelativePath } from '../identity.ts';
import type { BudgetLedger, BudgetReservation, BugTask, EnvelopeOutcome, FixPlan, PlanStep, PlanStepStatus, TaskEnvelope, TaskNode, TaskOutcome, TaskState, ValidationError, ValidationResult } from '../types.ts';
import { CONTRACT_VERSION, ENVELOPE_OUTCOMES, PLAN_STEP_STATUSES, TASK_NODES, TASK_OUTCOMES } from '../types.ts';
import { isPlainObject, rejectUnknownKeys, validateNonEmptyString, validateNonNegativeInteger, validateNonNegativeNumber, validatePositiveInteger } from './common.ts';
import { validateBugTask } from './intake.ts';

const TASK_ENVELOPE_ALLOWED_KEYS = [
  'schemaVersion',
  'requestId',
  'taskId',
  'runId',
  'workspaceId',
  'expectedStateVersion',
  'repositoryRevisionDigest',
  'trustedConfigId',
] as const;

export function validateTaskEnvelope(input: unknown): ValidationResult<TaskEnvelope> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'envelope', message: 'TaskEnvelope must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, TASK_ENVELOPE_ALLOWED_KEYS, '', errors);

  const schemaVersion = validateNonEmptyString(input['schemaVersion'], 'schemaVersion', errors);
  if (schemaVersion && schemaVersion !== CONTRACT_VERSION) {
    errors.push({
      path: 'schemaVersion',
      message: `schemaVersion must match current contract version ${CONTRACT_VERSION}`,
      code: 'SCHEMA_VERSION_MISMATCH',
    });
  }

  const requestId = validateNonEmptyString(input['requestId'], 'requestId', errors);
  const taskId = validateNonEmptyString(input['taskId'], 'taskId', errors);
  const runId = validateNonEmptyString(input['runId'], 'runId', errors);
  const workspaceId = validateNonEmptyString(input['workspaceId'], 'workspaceId', errors);
  const expectedStateVersion = validateNonNegativeInteger(
    input['expectedStateVersion'],
    'expectedStateVersion',
    errors
  );
  const repositoryRevisionDigest = validateNonEmptyString(
    input['repositoryRevisionDigest'],
    'repositoryRevisionDigest',
    errors
  );
  const trustedConfigId = validateNonEmptyString(input['trustedConfigId'], 'trustedConfigId', errors);

  if (
    errors.length > 0 ||
    !schemaVersion ||
    schemaVersion !== CONTRACT_VERSION ||
    !requestId ||
    !taskId ||
    !runId ||
    !workspaceId ||
    expectedStateVersion === undefined ||
    !repositoryRevisionDigest ||
    !trustedConfigId
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      schemaVersion,
      requestId,
      taskId,
      runId,
      workspaceId,
      expectedStateVersion,
      repositoryRevisionDigest,
      trustedConfigId,
    },
  };
}

export function validateTaskNode(input: unknown): ValidationResult<TaskNode> {
  if (typeof input !== 'string') {
    return {
      ok: false,
      errors: [{ path: 'node', message: 'node must be a string', code: 'INVALID_TYPE' }],
    };
  }
  if (!TASK_NODES.includes(input as TaskNode)) {
    return {
      ok: false,
      errors: [
        {
          path: 'node',
          message: `node must be one of: ${TASK_NODES.join(', ')}`,
          code: 'INVALID_NODE',
        },
      ],
    };
  }
  return { ok: true, value: input as TaskNode };
}

export function validateTaskOutcome(input: unknown): ValidationResult<TaskOutcome> {
  if (typeof input !== 'string') {
    return {
      ok: false,
      errors: [{ path: 'outcome', message: 'TaskOutcome must be a string', code: 'INVALID_TYPE' }],
    };
  }
  if (!TASK_OUTCOMES.includes(input as TaskOutcome)) {
    return {
      ok: false,
      errors: [
        {
          path: 'outcome',
          message: `TaskOutcome must be one of: ${TASK_OUTCOMES.join(', ')}`,
          code: 'INVALID_OUTCOME',
        },
      ],
    };
  }
  return { ok: true, value: input as TaskOutcome };
}

export function validateEnvelopeOutcome(input: unknown): ValidationResult<EnvelopeOutcome> {
  if (typeof input !== 'string') {
    return {
      ok: false,
      errors: [
        {
          path: 'envelopeOutcome',
          message: 'EnvelopeOutcome must be a string',
          code: 'INVALID_TYPE',
        },
      ],
    };
  }
  if (!ENVELOPE_OUTCOMES.includes(input as EnvelopeOutcome)) {
    return {
      ok: false,
      errors: [
        {
          path: 'envelopeOutcome',
          message: `EnvelopeOutcome must be one of: ${ENVELOPE_OUTCOMES.join(', ')}`,
          code: 'INVALID_ENVELOPE_OUTCOME',
        },
      ],
    };
  }
  return { ok: true, value: input as EnvelopeOutcome };
}

const PLAN_STEP_ALLOWED_KEYS = [
  'stepId',
  'description',
  'status',
  'actionRefs',
  'evidenceRefs',
] as const;

export function validatePlanStep(input: unknown, path = 'planStep'): ValidationResult<PlanStep> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, PLAN_STEP_ALLOWED_KEYS, path, errors);

  const stepId = validateNonEmptyString(input['stepId'], `${path}.stepId`, errors);
  const description = validateNonEmptyString(input['description'], `${path}.description`, errors);

  const status = input['status'] as PlanStepStatus;
  if (!PLAN_STEP_STATUSES.includes(status)) {
    errors.push({
      path: `${path}.status`,
      message: `${path}.status must be one of: ${PLAN_STEP_STATUSES.join(', ')}`,
      code: 'INVALID_STEP_STATUS',
    });
  }

  if (!Array.isArray(input['actionRefs'])) {
    errors.push({
      path: `${path}.actionRefs`,
      message: `${path}.actionRefs must be an array of strings`,
      code: 'INVALID_TYPE',
    });
  } else {
    for (let i = 0; i < input['actionRefs'].length; i++) {
      if (typeof input['actionRefs'][i] !== 'string') {
        errors.push({
          path: `${path}.actionRefs[${i}]`,
          message: `${path}.actionRefs[${i}] must be a string`,
          code: 'INVALID_TYPE',
        });
      }
    }
  }

  if (!Array.isArray(input['evidenceRefs'])) {
    errors.push({
      path: `${path}.evidenceRefs`,
      message: `${path}.evidenceRefs must be an array of strings`,
      code: 'INVALID_TYPE',
    });
  } else {
    for (let i = 0; i < input['evidenceRefs'].length; i++) {
      if (typeof input['evidenceRefs'][i] !== 'string') {
        errors.push({
          path: `${path}.evidenceRefs[${i}]`,
          message: `${path}.evidenceRefs[${i}] must be a string`,
          code: 'INVALID_TYPE',
        });
      }
    }
  }

  if (
    errors.length > 0 ||
    !stepId ||
    !description ||
    !PLAN_STEP_STATUSES.includes(status) ||
    !Array.isArray(input['actionRefs']) ||
    !Array.isArray(input['evidenceRefs'])
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      stepId,
      description,
      status,
      actionRefs: input['actionRefs'] as readonly string[],
      evidenceRefs: input['evidenceRefs'] as readonly string[],
    },
  };
}

const FIX_PLAN_ALLOWED_KEYS = [
  'planVersion',
  'diagnosis',
  'suspectedCauseLocations',
  'evidenceRefs',
  'strategy',
  'scopedChanges',
  'checkSetDigest',
  'baselineRef',
  'strategyDigest',
  'decisionRef',
] as const;

export function validateFixPlan(input: unknown, path = 'fixPlan'): ValidationResult<FixPlan> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, FIX_PLAN_ALLOWED_KEYS, path, errors);

  const planVersion = validatePositiveInteger(input['planVersion'], `${path}.planVersion`, errors);
  const diagnosis = validateNonEmptyString(input['diagnosis'], `${path}.diagnosis`, errors);
  const strategy = validateNonEmptyString(input['strategy'], `${path}.strategy`, errors);
  const checkSetDigest = validateNonEmptyString(input['checkSetDigest'], `${path}.checkSetDigest`, errors);
  const baselineRef = validateNonEmptyString(input['baselineRef'], `${path}.baselineRef`, errors);
  const strategyDigest = validateNonEmptyString(input['strategyDigest'], `${path}.strategyDigest`, errors);

  let decisionRef: string | undefined;
  if (input['decisionRef'] !== undefined) {
    decisionRef = validateNonEmptyString(input['decisionRef'], `${path}.decisionRef`, errors);
  }

  if (!Array.isArray(input['suspectedCauseLocations'])) {
    errors.push({
      path: `${path}.suspectedCauseLocations`,
      message: `${path}.suspectedCauseLocations must be an array of location strings`,
      code: 'INVALID_TYPE',
    });
  } else if (input['suspectedCauseLocations'].length === 0) {
    errors.push({
      path: `${path}.suspectedCauseLocations`,
      message: `${path}.suspectedCauseLocations must contain at least one location`,
      code: 'EMPTY_CAUSE_LOCATIONS',
    });
  } else {
    for (let i = 0; i < input['suspectedCauseLocations'].length; i++) {
      validateNonEmptyString(input['suspectedCauseLocations'][i], `${path}.suspectedCauseLocations[${i}]`, errors);
    }
  }

  if (!Array.isArray(input['evidenceRefs'])) {
    errors.push({
      path: `${path}.evidenceRefs`,
      message: `${path}.evidenceRefs must be an array of evidence references`,
      code: 'INVALID_TYPE',
    });
  } else if (input['evidenceRefs'].length === 0) {
    errors.push({
      path: `${path}.evidenceRefs`,
      message: `${path}.evidenceRefs must contain at least one evidence reference`,
      code: 'EMPTY_EVIDENCE_REFS',
    });
  } else {
    for (let i = 0; i < input['evidenceRefs'].length; i++) {
      validateNonEmptyString(input['evidenceRefs'][i], `${path}.evidenceRefs[${i}]`, errors);
    }
  }

  if (!Array.isArray(input['scopedChanges'])) {
    errors.push({
      path: `${path}.scopedChanges`,
      message: `${path}.scopedChanges must be an array of file/module paths`,
      code: 'INVALID_TYPE',
    });
  } else if (input['scopedChanges'].length === 0) {
    errors.push({
      path: `${path}.scopedChanges`,
      message: `${path}.scopedChanges must contain at least one targeted path`,
      code: 'EMPTY_SCOPED_CHANGES',
    });
  } else {
    for (let i = 0; i < input['scopedChanges'].length; i++) {
      validateNonEmptyString(input['scopedChanges'][i], `${path}.scopedChanges[${i}]`, errors);
    }
  }

  if (
    errors.length > 0 ||
    planVersion === undefined ||
    !diagnosis ||
    !strategy ||
    !checkSetDigest ||
    !baselineRef ||
    !strategyDigest ||
    !Array.isArray(input['suspectedCauseLocations']) ||
    input['suspectedCauseLocations'].length === 0 ||
    !Array.isArray(input['evidenceRefs']) ||
    input['evidenceRefs'].length === 0 ||
    !Array.isArray(input['scopedChanges']) ||
    input['scopedChanges'].length === 0
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      planVersion,
      diagnosis,
      suspectedCauseLocations: input['suspectedCauseLocations'] as readonly string[],
      evidenceRefs: input['evidenceRefs'] as readonly string[],
      strategy,
      scopedChanges: input['scopedChanges'] as readonly string[],
      checkSetDigest,
      baselineRef,
      strategyDigest,
      ...(decisionRef !== undefined ? { decisionRef } : {}),
    },
  };
}

const BUDGET_RESERVATION_ALLOWED_KEYS = ['reservationId', 'keyedId', 'amount'] as const;

const BUDGET_LEDGER_ALLOWED_KEYS = [
  'scope',
  'kind',
  'limit',
  'consumed',
  'reservations',
  'unit',
  'configurationId',
  'version',
] as const;

export function validateBudgetLedger(
  input: unknown,
  path = 'budgetLedger'
): ValidationResult<BudgetLedger> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, BUDGET_LEDGER_ALLOWED_KEYS, path, errors);

  const scope = input['scope'];
  if (scope !== 'task' && scope !== 'run') {
    errors.push({
      path: `${path}.scope`,
      message: `${path}.scope must be "task" or "run"`,
      code: 'INVALID_SCOPE',
    });
  }

  const kind = validateNonEmptyString(input['kind'], `${path}.kind`, errors);
  const limit = validateNonNegativeNumber(input['limit'], `${path}.limit`, errors);
  const consumed = validateNonNegativeNumber(input['consumed'], `${path}.consumed`, errors);
  const unit = validateNonEmptyString(input['unit'], `${path}.unit`, errors);
  const configurationId = validateNonEmptyString(input['configurationId'], `${path}.configurationId`, errors);
  const version = validateNonNegativeInteger(input['version'], `${path}.version`, errors);

  const reservations: BudgetReservation[] = [];
  if (!Array.isArray(input['reservations'])) {
    errors.push({
      path: `${path}.reservations`,
      message: `${path}.reservations must be an array of reservations`,
      code: 'INVALID_TYPE',
    });
  } else {
    for (let i = 0; i < input['reservations'].length; i++) {
      const resItem = input['reservations'][i];
      const resPath = `${path}.reservations[${i}]`;
      if (!isPlainObject(resItem)) {
        errors.push({
          path: resPath,
          message: `${resPath} must be an object`,
          code: 'INVALID_TYPE',
        });
        continue;
      }
      rejectUnknownKeys(resItem, BUDGET_RESERVATION_ALLOWED_KEYS, resPath, errors);
      const resId = validateNonEmptyString(resItem['reservationId'], `${resPath}.reservationId`, errors);
      const keyedId = validateNonEmptyString(resItem['keyedId'], `${resPath}.keyedId`, errors);
      const amount = validateNonNegativeNumber(resItem['amount'], `${resPath}.amount`, errors);
      if (resId && keyedId && amount !== undefined) {
        reservations.push({ reservationId: resId, keyedId, amount });
      }
    }
  }

  const ledgerTotal = (consumed ?? 0) + reservations.reduce((sum, reservation) => sum + reservation.amount, 0);
  if (!Number.isFinite(ledgerTotal)) errors.push({ path, code: 'INVALID_ACCOUNTING_TOTAL', message: 'Ledger totals must remain finite' });
  if (kind !== 'cost') {
    const amounts = [limit, consumed, ...reservations.map(reservation => reservation.amount)];
    const total = (consumed ?? 0) + reservations.reduce((sum, reservation) => sum + reservation.amount, 0);
    if (amounts.some(amount => !Number.isSafeInteger(amount)) || !Number.isSafeInteger(total)) {
      errors.push({ path, code: 'UNSAFE_COUNT_SUM', message: 'Count ledger amounts and totals must be safe integers' });
    }
  }
  if (new Set(reservations.map(reservation => reservation.reservationId)).size !== reservations.length ||
      new Set(reservations.map(reservation => reservation.keyedId)).size !== reservations.length) {
    errors.push({ path, code: 'DUPLICATE_RESERVATION', message: 'Ledger reservation IDs and keys must be unique' });
  }

  if (
    errors.length > 0 ||
    (scope !== 'task' && scope !== 'run') ||
    !kind ||
    limit === undefined ||
    consumed === undefined ||
    !unit ||
    !configurationId ||
    version === undefined ||
    !Array.isArray(input['reservations'])
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      scope,
      kind,
      limit,
      consumed,
      reservations,
      unit,
      configurationId,
      version,
    },
  };
}

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
