/** Normalized action and approval-binding validation. */

import { isCanonicalRelativePath, isProtectedPath } from '../../identity.ts';
import type { ApplyPatchAction, ApprovalBinding, ApprovalBindingContext, ApprovalStatus, ApproveFixPlanAction, NormalizedAction, RunCommandAction, ValidationError, ValidationResult } from '../../types.ts';
import { isPlainObject, rejectUnknownKeys, validateNonEmptyString, validatePositiveInteger } from '../common.ts';

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
