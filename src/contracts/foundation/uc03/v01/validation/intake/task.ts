/** Bug-task intake validation. */

import type { BugTask, CheckDefinition, ValidationError, ValidationResult } from '../../types.ts';
import { isPlainObject, rejectUnknownKeys, validateNonEmptyString } from '../common.ts';

import { validateExecutionLimits, validateBudgetLimits, validateCheckDefinition } from './limits.ts';

const BUG_TASK_ALLOWED_KEYS = [
  'taskId',
  'repositoryId',
  'initialRevisionDigest',
  'goal',
  'observedBehavior',
  'expectedBehavior',
  'reproduction',
  'acceptanceCriteria',
  'constraints',
  'requiredChecks',
  'limits',
  'budgetLimits',
  'configId',
  'configVersion',
] as const;

export function validateBugTask(input: unknown): ValidationResult<BugTask> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'bugTask', message: 'BugTask must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, BUG_TASK_ALLOWED_KEYS, 'bugTask', errors);

  const taskId = validateNonEmptyString(input['taskId'], 'taskId', errors);
  const repositoryId = validateNonEmptyString(input['repositoryId'], 'repositoryId', errors);
  const initialRevisionDigest = validateNonEmptyString(input['initialRevisionDigest'], 'initialRevisionDigest', errors);
  const goal = validateNonEmptyString(input['goal'], 'goal', errors);
  const observedBehavior = validateNonEmptyString(input['observedBehavior'], 'observedBehavior', errors);
  const expectedBehavior = validateNonEmptyString(input['expectedBehavior'], 'expectedBehavior', errors);
  const reproduction = validateNonEmptyString(input['reproduction'], 'reproduction', errors);
  const configId = validateNonEmptyString(input['configId'], 'configId', errors);
  const configVersion = validateNonEmptyString(input['configVersion'], 'configVersion', errors);

  if (!Array.isArray(input['acceptanceCriteria'])) {
    errors.push({
      path: 'acceptanceCriteria',
      message: 'acceptanceCriteria must be an array of non-empty strings',
      code: 'INVALID_TYPE',
    });
  } else if (input['acceptanceCriteria'].length === 0) {
    errors.push({
      path: 'acceptanceCriteria',
      message: 'acceptanceCriteria must contain at least one criteria string',
      code: 'EMPTY_CRITERIA',
    });
  } else {
    for (let i = 0; i < input['acceptanceCriteria'].length; i++) {
      validateNonEmptyString(input['acceptanceCriteria'][i], `acceptanceCriteria[${i}]`, errors);
    }
  }

  if (!Array.isArray(input['constraints'])) {
    errors.push({
      path: 'constraints',
      message: 'constraints must be an array of strings',
      code: 'INVALID_TYPE',
    });
  } else {
    for (let i = 0; i < input['constraints'].length; i++) {
      validateNonEmptyString(input['constraints'][i], `constraints[${i}]`, errors);
    }
  }

  const requiredChecks: CheckDefinition[] = [];
  if (!Array.isArray(input['requiredChecks'])) {
    errors.push({
      path: 'requiredChecks',
      message: 'requiredChecks must be an array of check definitions',
      code: 'INVALID_TYPE',
    });
  } else if (input['requiredChecks'].length === 0) {
    errors.push({
      path: 'requiredChecks',
      message: 'requiredChecks must contain at least one check definition',
      code: 'EMPTY_REQUIRED_CHECKS',
    });
  } else {
    for (let i = 0; i < input['requiredChecks'].length; i++) {
      const parsedCheck = validateCheckDefinition(input['requiredChecks'][i], `requiredChecks[${i}]`, errors);
      if (parsedCheck) {
        requiredChecks.push(parsedCheck);
      }
    }
  }

  const limitsRes = validateExecutionLimits(input['limits']);
  if (!limitsRes.ok) {
    errors.push(...limitsRes.errors);
  }

  const budgetLimitsRes = validateBudgetLimits(input['budgetLimits']);
  if (!budgetLimitsRes.ok) {
    errors.push(...budgetLimitsRes.errors);
  }

  if (
    errors.length > 0 ||
    !taskId ||
    !repositoryId ||
    !initialRevisionDigest ||
    !goal ||
    !observedBehavior ||
    !expectedBehavior ||
    !reproduction ||
    !configId ||
    !configVersion ||
    !Array.isArray(input['acceptanceCriteria']) ||
    input['acceptanceCriteria'].length === 0 ||
    !Array.isArray(input['constraints']) ||
    !Array.isArray(input['requiredChecks']) ||
    input['requiredChecks'].length === 0 ||
    !limitsRes.ok ||
    !budgetLimitsRes.ok
  ) {
    return { ok: false, errors };
  }

  const bugTask: BugTask = {
    taskId,
    repositoryId,
    initialRevisionDigest,
    goal,
    observedBehavior,
    expectedBehavior,
    reproduction,
    acceptanceCriteria: input['acceptanceCriteria'] as readonly string[],
    constraints: input['constraints'] as readonly string[],
    requiredChecks,
    limits: limitsRes.value,
    budgetLimits: budgetLimitsRes.value,
    configId,
    configVersion,
  };

  return { ok: true, value: bugTask };
}
