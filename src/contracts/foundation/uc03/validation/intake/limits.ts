/** Execution, budget, and check limits validation. */

import type { BudgetLimits, CheckDefinition, CheckPurpose, ExecutionLimits, ValidationError, ValidationResult } from '../../types.ts';
import { isPlainObject, rejectUnknownKeys, validateNonEmptyString, validateNonNegativeInteger, validateNonNegativeNumber, validatePositiveInteger, validatePositiveNumber } from '../common.ts';

const EXECUTION_LIMITS_ALLOWED_KEYS = [
  'timeoutMs',
  'maxOutputBytes',
  'maxCpuCores',
  'maxMemoryBytes',
  'maxPids',
] as const;

const BUDGET_LIMITS_ALLOWED_KEYS = [
  'maxReplanCount',
  'maxTokens',
  'maxCostUsd',
  'maxRepairAttempts',
  'maxReviewIterations',
] as const;

const CHECK_DEFINITION_ALLOWED_KEYS = [
  'checkId',
  'executable',
  'argv',
  'purpose',
  'workingDirectory',
  'timeoutMs',
  'maxOutputBytes',
] as const;

/* ------------------------------------------------------------------
 * Validators
 * ------------------------------------------------------------------ */

export function validateExecutionLimits(input: unknown): ValidationResult<ExecutionLimits> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'limits', message: 'limits must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, EXECUTION_LIMITS_ALLOWED_KEYS, 'limits', errors);

  const timeoutMs = validatePositiveInteger(input['timeoutMs'], 'limits.timeoutMs', errors);
  const maxOutputBytes = validatePositiveInteger(input['maxOutputBytes'], 'limits.maxOutputBytes', errors);
  const maxCpuCores = validatePositiveNumber(input['maxCpuCores'], 'limits.maxCpuCores', errors);
  const maxMemoryBytes = validatePositiveInteger(input['maxMemoryBytes'], 'limits.maxMemoryBytes', errors);
  const maxPids = validatePositiveInteger(input['maxPids'], 'limits.maxPids', errors);

  if (
    errors.length > 0 ||
    timeoutMs === undefined ||
    maxOutputBytes === undefined ||
    maxCpuCores === undefined ||
    maxMemoryBytes === undefined ||
    maxPids === undefined
  ) {
    return { ok: false, errors };
  }

  const result: ExecutionLimits = {
    timeoutMs,
    maxOutputBytes,
    maxCpuCores,
    maxMemoryBytes,
    maxPids,
  };

  return { ok: true, value: result };
}

export function validateBudgetLimits(input: unknown): ValidationResult<BudgetLimits> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'budgetLimits', message: 'budgetLimits must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, BUDGET_LIMITS_ALLOWED_KEYS, 'budgetLimits', errors);

  const replan = validateNonNegativeInteger(input['maxReplanCount'], 'budgetLimits.maxReplanCount', errors);
  if (replan !== undefined && replan > 3) {
    errors.push({
      path: 'budgetLimits.maxReplanCount',
      message: 'maxReplanCount cannot exceed 3 (fixed task-scoped replan limit)',
      code: 'REPLAN_CAP_EXCEEDED',
    });
  }

  const maxTokens = validateNonNegativeInteger(input['maxTokens'], 'budgetLimits.maxTokens', errors);
  const maxCostUsd = validateNonNegativeNumber(input['maxCostUsd'], 'budgetLimits.maxCostUsd', errors);
  const maxRepairAttempts = validateNonNegativeInteger(input['maxRepairAttempts'], 'budgetLimits.maxRepairAttempts', errors);
  const maxReviewIterations = validateNonNegativeInteger(input['maxReviewIterations'], 'budgetLimits.maxReviewIterations', errors);

  if (
    errors.length > 0 ||
    replan === undefined ||
    replan > 3 ||
    maxTokens === undefined ||
    maxCostUsd === undefined ||
    maxRepairAttempts === undefined ||
    maxReviewIterations === undefined
  ) {
    return { ok: false, errors };
  }

  const result: BudgetLimits = {
    maxReplanCount: replan,
    maxTokens,
    maxCostUsd,
    maxRepairAttempts,
    maxReviewIterations,
  };

  return { ok: true, value: result };
}

export function validateCheckDefinition(
  input: unknown,
  path: string,
  errors: ValidationError[]
): CheckDefinition | undefined {
  if (!isPlainObject(input)) {
    errors.push({
      path,
      message: `${path} must be an object`,
      code: 'INVALID_TYPE',
    });
    return undefined;
  }

  const initialErrorsCount = errors.length;
  rejectUnknownKeys(input, CHECK_DEFINITION_ALLOWED_KEYS, path, errors);

  const checkId = validateNonEmptyString(input['checkId'], `${path}.checkId`, errors);
  const executable = validateNonEmptyString(input['executable'], `${path}.executable`, errors);

  let argvValid = false;
  if (!Array.isArray(input['argv'])) {
    errors.push({
      path: `${path}.argv`,
      message: `${path}.argv must be an array of strings`,
      code: 'INVALID_TYPE',
    });
  } else {
    let allStrings = true;
    for (let i = 0; i < input['argv'].length; i++) {
      if (typeof input['argv'][i] !== 'string') {
        allStrings = false;
        errors.push({
          path: `${path}.argv[${i}]`,
          message: `${path}.argv[${i}] must be a string`,
          code: 'INVALID_TYPE',
        });
      }
    }
    if (allStrings) argvValid = true;
  }

  const validPurposes: readonly CheckPurpose[] = [
    'reproduction',
    'focused',
    'regression',
    'compatibility',
    'diff',
  ];
  const purpose = input['purpose'] as CheckPurpose;
  if (!validPurposes.includes(purpose)) {
    errors.push({
      path: `${path}.purpose`,
      message: `${path}.purpose must be one of: ${validPurposes.join(', ')}`,
      code: 'INVALID_PURPOSE',
    });
  }

  let workingDirectory: string | undefined;
  if (input['workingDirectory'] !== undefined) {
    workingDirectory = validateNonEmptyString(input['workingDirectory'], `${path}.workingDirectory`, errors);
  }

  let timeoutMs: number | undefined;
  if (input['timeoutMs'] !== undefined) {
    timeoutMs = validatePositiveInteger(input['timeoutMs'], `${path}.timeoutMs`, errors);
  }

  let maxOutputBytes: number | undefined;
  if (input['maxOutputBytes'] !== undefined) {
    maxOutputBytes = validatePositiveInteger(input['maxOutputBytes'], `${path}.maxOutputBytes`, errors);
  }

  if (
    errors.length > initialErrorsCount ||
    !checkId ||
    !executable ||
    !argvValid ||
    !validPurposes.includes(purpose)
  ) {
    return undefined;
  }

  return {
    checkId,
    executable,
    argv: input['argv'] as readonly string[],
    purpose,
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
  };
}
