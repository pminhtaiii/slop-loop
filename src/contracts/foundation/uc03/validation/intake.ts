/** Task input, action, approval binding, and command-view validation. */

import { isCanonicalRelativePath, isProtectedPath } from '../identity.ts';
import type { AdmittedFile, ApplyPatchAction, ApprovalBinding, ApprovalBindingContext, ApprovalStatus, ApproveFixPlanAction, BudgetLimits, BugTask, CheckDefinition, CheckPurpose, CommandView, CommandViewValidationContext, ExecutionLimits, NormalizedAction, RunCommandAction, ValidationError, ValidationResult } from '../types.ts';
import { isPlainObject, rejectUnknownKeys, validateNonEmptyString, validateNonNegativeInteger, validateNonNegativeNumber, validatePositiveInteger, validatePositiveNumber } from './common.ts';

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

const RUN_COMMAND_ACTION_ALLOWED_KEYS = [
  'actionId',
  'kind',
  'executable',
  'argv',
  'workingDirectory',
  'purpose',
] as const;

const APPLY_PATCH_ACTION_ALLOWED_KEYS = [
  'actionId',
  'kind',
  'patchContent',
  'targetPaths',
  'baseRevisionDigest',
] as const;

const APPROVE_FIX_PLAN_ACTION_ALLOWED_KEYS = [
  'actionId',
  'kind',
  'planVersion',
  'strategyDigest',
  'diagnosisEvidenceRefs',
  'checkSetDigest',
] as const;

const APPROVAL_BINDING_ACTION_ALLOWED_KEYS = [
  'decisionId',
  'actionKind',
  'normalizedActionDigest',
  'taskId',
  'workspaceId',
  'repositoryRevisionDigest',
  'policyId',
  'policyVersion',
  'status',
  'reason',
] as const;

const APPROVAL_BINDING_FIX_PLAN_ALLOWED_KEYS = [
  'decisionId',
  'actionKind',
  'normalizedActionDigest',
  'taskId',
  'workspaceId',
  'repositoryRevisionDigest',
  'policyId',
  'policyVersion',
  'planVersion',
  'strategyDigest',
  'baselineRef',
  'evidenceRefs',
  'criteriaDigest',
  'checkSetDigest',
  'status',
  'reason',
] as const;

const COMMAND_VIEW_ALLOWED_KEYS = [
  'viewId',
  'viewDigest',
  'taskId',
  'workspaceId',
  'canonicalRevisionDigest',
  'admittedFiles',
  'exclusionsPolicyVersion',
  'scratchIdentity',
  'mountedReadOnly',
] as const;

const ADMITTED_FILE_ALLOWED_KEYS = ['path', 'digest'] as const;

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
      if (typeof input['constraints'][i] !== 'string') {
        errors.push({
          path: `constraints[${i}]`,
          message: `constraints[${i}] must be a string`,
          code: 'INVALID_TYPE',
        });
      }
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

export function validateNormalizedAction(input: unknown): ValidationResult<NormalizedAction> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'action', message: 'Action must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  const actionId = validateNonEmptyString(input['actionId'], 'actionId', errors);
  const kind = validateNonEmptyString(input['kind'], 'kind', errors);

  if (!actionId || !kind) {
    return { ok: false, errors };
  }

  if (kind === 'run_command') {
    rejectUnknownKeys(input, RUN_COMMAND_ACTION_ALLOWED_KEYS, '', errors);

    const executable = validateNonEmptyString(input['executable'], 'executable', errors);
    if (executable) {
      if (/[\s;&|><`$\r\n]/.test(executable)) {
        errors.push({
          path: 'executable',
          message: 'executable contains forbidden shell characters or whitespace',
          code: 'FORBIDDEN_SHELL_CHARACTERS',
        });
      }
    }

    if (!Array.isArray(input['argv'])) {
      errors.push({
        path: 'argv',
        message: 'argv must be an array of strings',
        code: 'INVALID_TYPE',
      });
    } else {
      for (let i = 0; i < input['argv'].length; i++) {
        if (typeof input['argv'][i] !== 'string') {
          errors.push({
            path: `argv[${i}]`,
            message: `argv[${i}] must be a string`,
            code: 'INVALID_TYPE',
          });
        }
      }
    }

    const workingDirectory = validateNonEmptyString(input['workingDirectory'], 'workingDirectory', errors);
    let purpose: string | undefined;
    if (input['purpose'] !== undefined) {
      purpose = validateNonEmptyString(input['purpose'], 'purpose', errors);
    }

    if (errors.length > 0 || !executable || !Array.isArray(input['argv']) || !workingDirectory) {
      return { ok: false, errors };
    }

    const action: RunCommandAction = {
      actionId,
      kind: 'run_command',
      executable,
      argv: input['argv'] as readonly string[],
      workingDirectory,
      ...(purpose !== undefined ? { purpose } : {}),
    };
    return { ok: true, value: action };
  }

  if (kind === 'apply_patch') {
    rejectUnknownKeys(input, APPLY_PATCH_ACTION_ALLOWED_KEYS, '', errors);

    const rawPatch = input['patchContent'];
    let patchContent: string | undefined;
    if (typeof rawPatch !== 'string') {
      errors.push({
        path: 'patchContent',
        message: 'patchContent must be a string',
        code: 'INVALID_TYPE',
      });
    } else if (rawPatch.trim().length === 0) {
      errors.push({
        path: 'patchContent',
        message: 'patchContent must be a non-empty string',
        code: 'EMPTY_STRING',
      });
    } else {
      patchContent = rawPatch;
    }

    const baseRevisionDigest = validateNonEmptyString(input['baseRevisionDigest'], 'baseRevisionDigest', errors);

    if (!Array.isArray(input['targetPaths'])) {
      errors.push({
        path: 'targetPaths',
        message: 'targetPaths must be an array of relative paths',
        code: 'INVALID_TYPE',
      });
    } else if (input['targetPaths'].length === 0) {
      errors.push({
        path: 'targetPaths',
        message: 'targetPaths must contain at least one path',
        code: 'EMPTY_TARGET_PATHS',
      });
    } else {
      for (let i = 0; i < input['targetPaths'].length; i++) {
        const p = validateNonEmptyString(input['targetPaths'][i], `targetPaths[${i}]`, errors);
        if (p) {
          if (!isCanonicalRelativePath(p)) {
            errors.push({
              path: `targetPaths[${i}]`,
              message: `targetPaths[${i}] must be a canonical relative path: ${p}`,
              code: 'WORKSPACE_ESCAPE',
            });
          }
          if (isProtectedPath(p)) {
            errors.push({
              path: `targetPaths[${i}]`,
              message: `targetPaths[${i}] targets protected path: ${p}`,
              code: 'PROTECTED_PATH_FORBIDDEN',
            });
          }
        }
      }
    }

    if (
      errors.length > 0 ||
      !patchContent ||
      !baseRevisionDigest ||
      !Array.isArray(input['targetPaths']) ||
      input['targetPaths'].length === 0
    ) {
      return { ok: false, errors };
    }

    const action: ApplyPatchAction = {
      actionId,
      kind: 'apply_patch',
      patchContent,
      targetPaths: input['targetPaths'] as readonly string[],
      baseRevisionDigest,
    };
    return { ok: true, value: action };
  }

  if (kind === 'approve_fix_plan') {
    rejectUnknownKeys(input, APPROVE_FIX_PLAN_ACTION_ALLOWED_KEYS, '', errors);

    const planVersion = validatePositiveInteger(input['planVersion'], 'planVersion', errors);
    const strategyDigest = validateNonEmptyString(input['strategyDigest'], 'strategyDigest', errors);
    const checkSetDigest = validateNonEmptyString(input['checkSetDigest'], 'checkSetDigest', errors);

    if (!Array.isArray(input['diagnosisEvidenceRefs'])) {
      errors.push({
        path: 'diagnosisEvidenceRefs',
        message: 'diagnosisEvidenceRefs must be an array of evidence references',
        code: 'INVALID_TYPE',
      });
    } else if (input['diagnosisEvidenceRefs'].length === 0) {
      errors.push({
        path: 'diagnosisEvidenceRefs',
        message: 'diagnosisEvidenceRefs must contain at least one evidence reference',
        code: 'EMPTY_EVIDENCE_REFS',
      });
    } else {
      for (let i = 0; i < input['diagnosisEvidenceRefs'].length; i++) {
        validateNonEmptyString(input['diagnosisEvidenceRefs'][i], `diagnosisEvidenceRefs[${i}]`, errors);
      }
    }

    if (
      errors.length > 0 ||
      planVersion === undefined ||
      !strategyDigest ||
      !checkSetDigest ||
      !Array.isArray(input['diagnosisEvidenceRefs']) ||
      input['diagnosisEvidenceRefs'].length === 0
    ) {
      return { ok: false, errors };
    }

    const action: ApproveFixPlanAction = {
      actionId,
      kind: 'approve_fix_plan',
      planVersion,
      strategyDigest,
      diagnosisEvidenceRefs: input['diagnosisEvidenceRefs'] as readonly string[],
      checkSetDigest,
    };
    return { ok: true, value: action };
  }

  return {
    ok: false,
    errors: [
      {
        path: 'kind',
        message: `Unknown action kind: ${kind}`,
        code: 'INVALID_ACTION_KIND',
      },
    ],
  };
}

/** Admission requires host-owned current identities; parsing alone grants no permission. */
export function validateApprovalBinding(input: unknown, context?: ApprovalBindingContext): ValidationResult<ApprovalBinding> {
  const parsed = parseApprovalBinding(input);
  if (!parsed.ok) return parsed;
  const binding = parsed.value;
  if (binding.status !== 'approved') return parsed;
  const required: (keyof ApprovalBindingContext)[] = ['currentTaskId', 'currentWorkspaceId', 'currentRepositoryRevisionDigest', 'currentPolicyId', 'currentPolicyVersion', 'currentNormalizedActionDigest'];
  if (binding.actionKind === 'fix_plan') required.push('currentPlanVersion', 'currentStrategyDigest', 'currentBaselineRef', 'currentEvidenceRefs', 'currentCriteriaDigest', 'currentCheckSetDigest');
  const errors: ValidationError[] = [];
  for (const field of required) {
    const value = context?.[field];
    if (value === undefined ||
      (typeof value === 'string' && !value.trim()) ||
      (field === 'currentPlanVersion' && (!Number.isSafeInteger(value) ||
      Number(value) < 1)) ||
      (field === 'currentEvidenceRefs' && (!Array.isArray(value) ||
      value.length === 0 ||
      value.some(v => typeof v !== 'string' ||
      !v.trim())))) {
      errors.push({ path: `context.${field}`, code: 'MISSING_FRESHNESS_CONTEXT', message: 'Complete trusted freshness context is required' });
    }
  }
  const checked = parseApprovalBinding(input, context);
  if (!checked.ok) errors.push(...checked.errors);
  return errors.length ? { ok: false, errors } : checked;
}

export function parseApprovalBinding(
  input: unknown,
  context?: ApprovalBindingContext
): ValidationResult<ApprovalBinding> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'approvalBinding', message: 'approvalBinding must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  const actionKind = input['actionKind'];
  if (actionKind !== 'action' && actionKind !== 'fix_plan') {
    errors.push({
      path: 'actionKind',
      message: 'actionKind must be either "action" or "fix_plan"',
      code: 'INVALID_ACTION_KIND',
    });
    return { ok: false, errors };
  }

  if (actionKind === 'fix_plan') {
    rejectUnknownKeys(input, APPROVAL_BINDING_FIX_PLAN_ALLOWED_KEYS, '', errors);
  } else {
    rejectUnknownKeys(input, APPROVAL_BINDING_ACTION_ALLOWED_KEYS, '', errors);
  }

  const decisionId = validateNonEmptyString(input['decisionId'], 'decisionId', errors);
  const normalizedActionDigest = validateNonEmptyString(input['normalizedActionDigest'], 'normalizedActionDigest', errors);
  const taskId = validateNonEmptyString(input['taskId'], 'taskId', errors);
  const workspaceId = validateNonEmptyString(input['workspaceId'], 'workspaceId', errors);
  const repositoryRevisionDigest = validateNonEmptyString(input['repositoryRevisionDigest'], 'repositoryRevisionDigest', errors);
  const policyId = validateNonEmptyString(input['policyId'], 'policyId', errors);
  const policyVersion = validateNonEmptyString(input['policyVersion'], 'policyVersion', errors);

  const validStatuses: readonly ApprovalStatus[] = ['pending', 'approved', 'rejected', 'stale'];
  const status = input['status'] as ApprovalStatus;
  if (!validStatuses.includes(status)) {
    errors.push({
      path: 'status',
      message: `status must be one of: ${validStatuses.join(', ')}`,
      code: 'INVALID_STATUS',
    });
  }

  let planVersion: number | undefined;
  let strategyDigest: string | undefined;
  let baselineRef: string | undefined;
  let evidenceRefs: readonly string[] | undefined;
  let criteriaDigest: string | undefined;
  let checkSetDigest: string | undefined;

  if (actionKind === 'fix_plan') {
    if (input['planVersion'] === undefined) {
      errors.push({
        path: 'planVersion',
        message: 'planVersion is required for fix_plan approval bindings',
        code: 'MISSING_PLAN_FIELD',
      });
    } else {
      planVersion = validatePositiveInteger(input['planVersion'], 'planVersion', errors);
    }

    if (input['strategyDigest'] === undefined) {
      errors.push({
        path: 'strategyDigest',
        message: 'strategyDigest is required for fix_plan approval bindings',
        code: 'MISSING_PLAN_FIELD',
      });
    } else {
      strategyDigest = validateNonEmptyString(input['strategyDigest'], 'strategyDigest', errors);
    }

    if (input['baselineRef'] === undefined) {
      errors.push({
        path: 'baselineRef',
        message: 'baselineRef is required for fix_plan approval bindings',
        code: 'MISSING_PLAN_FIELD',
      });
    } else {
      baselineRef = validateNonEmptyString(input['baselineRef'], 'baselineRef', errors);
    }

    if (input['criteriaDigest'] === undefined) {
      errors.push({
        path: 'criteriaDigest',
        message: 'criteriaDigest is required for fix_plan approval bindings',
        code: 'MISSING_PLAN_FIELD',
      });
    } else {
      criteriaDigest = validateNonEmptyString(input['criteriaDigest'], 'criteriaDigest', errors);
    }

    if (input['checkSetDigest'] === undefined) {
      errors.push({
        path: 'checkSetDigest',
        message: 'checkSetDigest is required for fix_plan approval bindings',
        code: 'MISSING_PLAN_FIELD',
      });
    } else {
      checkSetDigest = validateNonEmptyString(input['checkSetDigest'], 'checkSetDigest', errors);
    }

    if (!Array.isArray(input['evidenceRefs'])) {
      errors.push({
        path: 'evidenceRefs',
        message: 'evidenceRefs must be an array of evidence references',
        code: 'MISSING_PLAN_FIELD',
      });
    } else if (input['evidenceRefs'].length === 0) {
      errors.push({
        path: 'evidenceRefs',
        message: 'evidenceRefs must not be empty',
        code: 'MISSING_PLAN_FIELD',
      });
    } else {
      const refs: string[] = [];
      for (let i = 0; i < input['evidenceRefs'].length; i++) {
        const r = validateNonEmptyString(input['evidenceRefs'][i], `evidenceRefs[${i}]`, errors);
        if (r) refs.push(r);
      }
      evidenceRefs = refs;
    }
  }

  let reason: string | undefined;
  if (input['reason'] !== undefined) {
    reason = validateNonEmptyString(input['reason'], 'reason', errors);
  }

  if (context) {
    if (context.currentTaskId !== undefined && context.currentTaskId !== taskId) {
      errors.push({ path: 'taskId', message: 'Binding taskId does not match current context', code: 'STALE_APPROVAL_BINDING' });
    }
    if (context.currentWorkspaceId !== undefined && context.currentWorkspaceId !== workspaceId) {
      errors.push({ path: 'workspaceId', message: 'Binding workspaceId does not match current context', code: 'STALE_APPROVAL_BINDING' });
    }
    if (context.currentRepositoryRevisionDigest !== undefined && context.currentRepositoryRevisionDigest !== repositoryRevisionDigest) {
      errors.push({ path: 'repositoryRevisionDigest', message: 'Binding repositoryRevisionDigest does not match current context', code: 'STALE_APPROVAL_BINDING' });
    }
    if (context.currentPolicyId !== undefined && context.currentPolicyId !== policyId) {
      errors.push({ path: 'policyId', message: 'Binding policyId does not match current context', code: 'STALE_APPROVAL_BINDING' });
    }
    if (context.currentPolicyVersion !== undefined && context.currentPolicyVersion !== policyVersion) {
      errors.push({ path: 'policyVersion', message: 'Binding policyVersion does not match current context', code: 'STALE_APPROVAL_BINDING' });
    }
    if (context.currentNormalizedActionDigest !== undefined && context.currentNormalizedActionDigest !== normalizedActionDigest) {
      errors.push({ path: 'normalizedActionDigest', message: 'Binding normalizedActionDigest does not match current context', code: 'STALE_APPROVAL_BINDING' });
    }
    if (actionKind === 'fix_plan') {
      if (context.currentPlanVersion !== undefined && context.currentPlanVersion !== planVersion) {
        errors.push({ path: 'planVersion', message: 'Binding planVersion does not match current context', code: 'STALE_APPROVAL_BINDING' });
      }
      if (context.currentStrategyDigest !== undefined && context.currentStrategyDigest !== strategyDigest) {
        errors.push({ path: 'strategyDigest', message: 'Binding strategyDigest does not match current context', code: 'STALE_APPROVAL_BINDING' });
      }
      if (context.currentBaselineRef !== undefined && context.currentBaselineRef !== baselineRef) {
        errors.push({ path: 'baselineRef', message: 'Binding baselineRef does not match current context', code: 'STALE_APPROVAL_BINDING' });
      }
      if (context.currentCriteriaDigest !== undefined && context.currentCriteriaDigest !== criteriaDigest) {
        errors.push({ path: 'criteriaDigest', message: 'Binding criteriaDigest does not match current context', code: 'STALE_APPROVAL_BINDING' });
      }
      if (context.currentCheckSetDigest !== undefined && context.currentCheckSetDigest !== checkSetDigest) {
        errors.push({ path: 'checkSetDigest', message: 'Binding checkSetDigest does not match current context', code: 'STALE_APPROVAL_BINDING' });
      }
      if (context.currentEvidenceRefs !== undefined) {
        const match =
          Array.isArray(evidenceRefs) &&
          context.currentEvidenceRefs.length === evidenceRefs.length &&
          context.currentEvidenceRefs.every((r, idx) => r === evidenceRefs?.[idx]);
        if (!match) {
          errors.push({ path: 'evidenceRefs', message: 'Binding evidenceRefs do not match current context', code: 'STALE_APPROVAL_BINDING' });
        }
      }
    }
  }

  if (
    errors.length > 0 ||
    !decisionId ||
    !normalizedActionDigest ||
    !taskId ||
    !workspaceId ||
    !repositoryRevisionDigest ||
    !policyId ||
    !policyVersion ||
    !validStatuses.includes(status) ||
    (actionKind === 'fix_plan' &&
      (planVersion === undefined ||
        !strategyDigest ||
        !baselineRef ||
        !criteriaDigest ||
        !checkSetDigest ||
        !evidenceRefs ||
        evidenceRefs.length === 0))
  ) {
    return { ok: false, errors };
  }

  const binding: ApprovalBinding = {
    decisionId,
    actionKind,
    normalizedActionDigest,
    taskId,
    workspaceId,
    repositoryRevisionDigest,
    policyId,
    policyVersion,
    status,
    ...(planVersion !== undefined ? { planVersion } : {}),
    ...(strategyDigest !== undefined ? { strategyDigest } : {}),
    ...(baselineRef !== undefined ? { baselineRef } : {}),
    ...(evidenceRefs !== undefined ? { evidenceRefs } : {}),
    ...(criteriaDigest !== undefined ? { criteriaDigest } : {}),
    ...(checkSetDigest !== undefined ? { checkSetDigest } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };

  return { ok: true, value: binding };
}

export function validateCommandView(
  input: unknown,
  options?: CommandViewValidationContext
): ValidationResult<CommandView> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'commandView', message: 'commandView must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, COMMAND_VIEW_ALLOWED_KEYS, '', errors);

  const viewId = validateNonEmptyString(input['viewId'], 'viewId', errors);
  const viewDigest = validateNonEmptyString(input['viewDigest'], 'viewDigest', errors);
  const taskId = validateNonEmptyString(input['taskId'], 'taskId', errors);
  const workspaceId = validateNonEmptyString(input['workspaceId'], 'workspaceId', errors);
  const canonicalRevisionDigest = validateNonEmptyString(input['canonicalRevisionDigest'], 'canonicalRevisionDigest', errors);
  const exclusionsPolicyVersion = validateNonEmptyString(input['exclusionsPolicyVersion'], 'exclusionsPolicyVersion', errors);
  const scratchIdentity = validateNonEmptyString(input['scratchIdentity'], 'scratchIdentity', errors);

  if (input['mountedReadOnly'] !== true) {
    errors.push({
      path: 'mountedReadOnly',
      message: 'CommandView must be mounted read-only (mountedReadOnly: true)',
      code: 'READONLY_REQUIRED',
    });
  }

  const admittedFiles: AdmittedFile[] = [];
  if (!Array.isArray(input['admittedFiles'])) {
    errors.push({
      path: 'admittedFiles',
      message: 'admittedFiles must be an array of admitted file records',
      code: 'INVALID_TYPE',
    });
  } else if (input['admittedFiles'].length === 0) {
    errors.push({
      path: 'admittedFiles',
      message: 'admittedFiles must contain at least one file',
      code: 'EMPTY_ADMITTED_FILES',
    });
  } else {
    for (let i = 0; i < input['admittedFiles'].length; i++) {
      const file = input['admittedFiles'][i];
      if (!isPlainObject(file)) {
        errors.push({
          path: `admittedFiles[${i}]`,
          message: `admittedFiles[${i}] must be an object`,
          code: 'INVALID_TYPE',
        });
        continue;
      }

      rejectUnknownKeys(file, ADMITTED_FILE_ALLOWED_KEYS, `admittedFiles[${i}]`, errors);

      const filePath = validateNonEmptyString(file['path'], `admittedFiles[${i}].path`, errors);
      const fileDigest = validateNonEmptyString(file['digest'], `admittedFiles[${i}].digest`, errors);

      if (filePath) {
        if (!isCanonicalRelativePath(filePath)) {
          errors.push({
            path: `admittedFiles[${i}].path`,
            message: `admittedFiles[${i}].path must be a canonical relative path: ${filePath}`,
            code: 'WORKSPACE_ESCAPE',
          });
        }
        if (isProtectedPath(filePath)) {
          errors.push({
            path: `admittedFiles[${i}].path`,
            message: `admittedFiles[${i}].path contains protected data which cannot be admitted: ${filePath}`,
            code: 'PROTECTED_DATA_ADMITTED',
          });
        }

        if (options?.trustedFileDigests !== undefined) {
          if (!(filePath in options.trustedFileDigests)) {
            errors.push({
              path: `admittedFiles[${i}]`,
              message: `Admitted file has no trusted evidence: ${filePath}`,
              code: 'UNTRUSTED_FILE_ADMISSION',
            });
          } else if (fileDigest && options.trustedFileDigests[filePath] !== fileDigest) {
            errors.push({
              path: `admittedFiles[${i}].digest`,
              message: `Admitted file digest mismatch for ${filePath}: expected ${options.trustedFileDigests[filePath]}, got ${fileDigest}`,
              code: 'FILE_DIGEST_MISMATCH',
            });
          }
        }
      }

      if (filePath && fileDigest) {
        admittedFiles.push({ path: filePath, digest: fileDigest });
      }
    }
  }

  if (
    options?.currentCanonicalRevisionDigest !== undefined &&
    canonicalRevisionDigest &&
    options.currentCanonicalRevisionDigest !== canonicalRevisionDigest
  ) {
    errors.push({
      path: 'canonicalRevisionDigest',
      message: `CommandView canonicalRevisionDigest (${canonicalRevisionDigest}) does not match current repository revision (${options.currentCanonicalRevisionDigest})`,
      code: 'STALE_COMMAND_VIEW',
    });
  }

  if (
    options?.currentExclusionsPolicyVersion !== undefined &&
    exclusionsPolicyVersion &&
    options.currentExclusionsPolicyVersion !== exclusionsPolicyVersion
  ) {
    errors.push({
      path: 'exclusionsPolicyVersion',
      message: `CommandView exclusionsPolicyVersion (${exclusionsPolicyVersion}) does not match current policy (${options.currentExclusionsPolicyVersion})`,
      code: 'STALE_EXCLUSIONS_POLICY',
    });
  }

  if (
    options?.expectedViewDigest !== undefined &&
    viewDigest &&
    options.expectedViewDigest !== viewDigest
  ) {
    errors.push({
      path: 'viewDigest',
      message: `CommandView viewDigest (${viewDigest}) does not match expected view digest (${options.expectedViewDigest})`,
      code: 'VIEW_DIGEST_MISMATCH',
    });
  }

  if (
    errors.length > 0 ||
    !viewId ||
    !viewDigest ||
    !taskId ||
    !workspaceId ||
    !canonicalRevisionDigest ||
    !exclusionsPolicyVersion ||
    !scratchIdentity ||
    input['mountedReadOnly'] !== true ||
    !Array.isArray(input['admittedFiles']) ||
    input['admittedFiles'].length === 0
  ) {
    return { ok: false, errors };
  }

  const commandView: CommandView = {
    viewId,
    viewDigest,
    taskId,
    workspaceId,
    canonicalRevisionDigest,
    admittedFiles,
    exclusionsPolicyVersion,
    scratchIdentity,
    mountedReadOnly: true,
  };

  return { ok: true, value: commandView };
}

/* ------------------------------------------------------------------
 * Slice 2 Validators: TaskEnvelope, TaskNode, Outcomes, PlanStep,
 * FixPlan, BudgetLedger, TaskState/Checkpoint, and State Transitions
 * ------------------------------------------------------------------ */
