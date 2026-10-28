/** Public v0.2 admission boundary. Trusted facts are supplied independently by the caller. */

import {
  computeActionDigest,
  computeCommandViewDigest,
  computeCanonicalSha256,
  isCanonicalRelativePath,
  isProtectedPath,
} from '../identity.ts';
import {
  computeRequestContentDigest,
  validateProviderAdmissionV02 as validateProviderAdmissionBodyV02,
} from './admission/provider.ts';
import { checkProviderAdmissionBindingsV02, isProviderAdmissionTrustedContextV02 } from './admission/trusted-provider.ts';
import { validateRepositoryAdmissionV02 as validateRepositoryAdmissionBodyV02 } from './admission/repository.ts';
import { immutableResult, safeSnapshot, unsafeInputResult } from './admission/snapshot.ts';
import type {
  AdmissionContextV02,
  AdmissionTrustedContextV02,
  ProviderAdmissionContextV02,
  ProviderAdmissionTrustedContextV02,
  RepositoryAdmissionContextV02,
  RepositoryAdmissionTrustedContextV02,
} from './ports.ts';
import type { ApplyPatchAction, RunCommandAction, ValidationError, ValidationResult } from '../v01/types.ts';
import { isPlainObject } from '../v01/validation/common.ts';
import { validateNormalizedAction } from '../v01/validation/intake/actions.ts';

export { computeRequestContentDigest };

const err = (path: string, code: string): ValidationError => ({
  path,
  message: 'Admission does not match trusted current state',
  code,
});

function fail<T>(path: string, code: string): ValidationResult<T> {
  return { ok: false, errors: [err(path, code)] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateOptionalAdmissionFields(input: Record<string, unknown>, subject: 'repository-action' | 'provider-request'): ValidationError[] {
  const errors: ValidationError[] = [];
  const fields = subject === 'repository-action'
    ? ['diagnosticPurpose', 'taskCriteriaDigest', 'checkSetDigest', 'testPath', 'checkId']
    : ['diagnosticPurpose', 'taskCriteriaDigest'];
  for (const field of fields) if (Object.hasOwn(input, field) && !isText(input[field])) errors.push(err(field, 'INVALID_OPTIONAL_FIELD'));
  if (Object.hasOwn(input, 'testPath') && typeof input['testPath'] === 'string' && (!isCanonicalRelativePath(input['testPath']) || isProtectedPath(input['testPath']))) errors.push(err('testPath', 'INVALID_TEST_PATH'));
  if (Object.hasOwn(input, 'checkId') && typeof input['checkId'] === 'string' && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input['checkId'])) errors.push(err('checkId', 'INVALID_CHECK_ID'));
  if (Object.hasOwn(input, 'admissionDigest') && (!isText(input['admissionDigest']) || input['admissionDigest'] !== computeAdmissionDigest(input))) errors.push(err('admissionDigest', 'ADMISSION_DIGEST_MISMATCH'));
  return errors;
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isPositive(value) && Number.isSafeInteger(value);
}

function trustedRepositoryContext(value: unknown): value is RepositoryAdmissionTrustedContextV02 {
  if (!isRecord(value) || value['subjectKind'] !== 'repository-action') return false;
  const strings = [
    'taskStateSchemaVersion', 'controlSchemaVersion', 'taskId', 'runId', 'workspaceId',
    'repositoryId', 'runnableNode', 'canonicalRevision', 'executionProfileId',
    'policyEvaluationReceiptRef', 'policyEvaluationReceiptDigest', 'freshnessContextDigest',
  ];
  if (!strings.every((key) => isText(value[key]))) return false;
  if (value['commandViewDigest'] !== undefined && !isText(value['commandViewDigest'])) return false;
  if (value['actionDecisionReceiptRef'] !== undefined && !isText(value['actionDecisionReceiptRef'])) return false;
  if (value['actionDecisionReceiptDigest'] !== undefined && !isText(value['actionDecisionReceiptDigest'])) return false;
  if ((value['actionDecisionReceiptRef'] === undefined) !== (value['actionDecisionReceiptDigest'] === undefined)) return false;
  if (!['expectedTaskStateVersion', 'expectedControlVersion', 'expectedEpoch'].every((key) =>
    typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)) return false;
  if (value['planApplicability'] !== 'approved-plan' && value['planApplicability'] !== 'pre-plan-diagnostic') return false;
  if (value['planApplicability'] === 'approved-plan' && (!isText(value['planBindingDigest']) || !isText(value['planDecisionRef']))) return false;
  if (value['planApplicability'] === 'pre-plan-diagnostic' && (value['planBindingDigest'] !== undefined || value['planDecisionRef'] !== undefined)) return false;

  const auth = value['policyAuthorityRef'];
  if (!isRecord(auth) || !['policyId', 'policyVersion', 'configId', 'configVersion', 'issuerKeyRef'].every((k) => isText(auth[k])) || !isPositiveInteger(auth['decisionAuthorityGeneration'])) return false;
  const profile = value['executionProfile'];
  if (!isRecord(profile) || !isText(profile['isolationProfileRef']) || !isText(profile['exclusionsPolicyVersion']) || !isText(profile['scratchIdentity'])) return false;
  const command = profile['commandBounds'];
  const patch = profile['patchBounds'];
  if (!isRecord(command) || !['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes'].every((k) => isPositive(command[k])) || !isPositiveInteger(command['maxProcessCount'])) return false;
  if (!isRecord(patch) || !isPositiveInteger(patch['maxPatchBytes']) || !isPositiveInteger(patch['maxChangedPaths'])) return false;
  if (!Array.isArray(value['allowedDiagnosticChecks']) || !Array.isArray(value['allowedDiagnosticTestPaths'])) return false;
  const testPaths = value['allowedDiagnosticTestPaths'] as unknown[];
  if (!testPaths.every((p) => typeof p === 'string' && isCanonicalRelativePath(p) && !isProtectedPath(p))) return false;
  return (value['allowedDiagnosticChecks'] as unknown[]).every((item) => {
    if (!isRecord(item) || !['checkId', 'testPath', 'diagnosticPurpose', 'taskCriteriaDigest', 'checkSetDigest'].every((k) => isText(item[k]))) return false;
    if (!isCanonicalRelativePath(item['testPath'] as string) || isProtectedPath(item['testPath'] as string) || !testPaths.includes(item['testPath'])) return false;
    const action = item['action'];
    if (!isRecord(action) || action['kind'] !== 'run_command' || !isText(action['actionId']) || !isText(action['executable']) || !Array.isArray(action['argv']) ||
      !(action['argv'] as unknown[]).every((arg) => typeof arg === 'string') || !isText(action['workingDirectory']) ||
      (action['purpose'] !== undefined && !isText(action['purpose']))) return false;
    const validAction = validateNormalizedAction(action);
    return validAction.ok && validAction.value.kind === 'run_command' && validAction.value.argv.includes(item['testPath'] as string) &&
      (validAction.value.purpose === undefined || validAction.value.purpose === item['diagnosticPurpose']);
  });
}

function trustedProviderContext(value: unknown): value is ProviderAdmissionTrustedContextV02 {
  return isProviderAdmissionTrustedContextV02(value);
}

function checkRepositoryBindings(
  input: Record<string, unknown>,
  trust: RepositoryAdmissionTrustedContextV02,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const pairs: readonly [string, keyof RepositoryAdmissionTrustedContextV02][] = [
    ['taskStateSchemaVersion', 'taskStateSchemaVersion'], ['expectedTaskStateVersion', 'expectedTaskStateVersion'],
    ['controlSchemaVersion', 'controlSchemaVersion'], ['expectedControlVersion', 'expectedControlVersion'], ['expectedEpoch', 'expectedEpoch'],
    ['taskId', 'taskId'], ['runId', 'runId'], ['workspaceId', 'workspaceId'], ['repositoryId', 'repositoryId'],
    ['runnableNode', 'runnableNode'], ['canonicalRevision', 'canonicalRevision'], ['executionProfileId', 'executionProfileId'],
    ['planApplicability', 'planApplicability'],
  ];
  for (const [field, trustedField] of pairs) if (input[field] !== trust[trustedField]) errors.push(err(field, 'TRUSTED_CONTEXT_MISMATCH'));
  if (computeCanonicalSha256(input['policyAuthorityRef']) !== computeCanonicalSha256(trust.policyAuthorityRef)) errors.push(err('policyAuthorityRef', 'POLICY_AUTHORITY_MISMATCH'));
  const receipt = input['policyEvaluationReceipt'] as Record<string, unknown>;
  if (receipt['receiptId'] !== trust.policyEvaluationReceiptRef) errors.push(err('policyEvaluationReceipt.receiptId', 'EVALUATION_RECEIPT_MISMATCH'));
  const receiptBody = { ...receipt };
  delete receiptBody['receiptDigest'];
  if (receipt['receiptDigest'] !== trust.policyEvaluationReceiptDigest ||
    computeCanonicalSha256(receiptBody) !== trust.policyEvaluationReceiptDigest) {
    errors.push(err('policyEvaluationReceipt.receiptDigest', 'EVALUATION_RECEIPT_DIGEST_MISMATCH'));
  }
  if (receipt['freshnessContextDigest'] !== trust.freshnessContextDigest) errors.push(err('policyEvaluationReceipt.freshnessContextDigest', 'FRESHNESS_CONTEXT_MISMATCH'));
  const decision = input['actionDecisionReceipt'];
  if (receipt['result'] === 'APPROVAL_REQUIRED') {
    if (!isText(trust.actionDecisionReceiptRef) || !isText(trust.actionDecisionReceiptDigest)) {
      errors.push(err('trustedContext.actionDecisionReceiptRef', 'ACTION_DECISION_BINDING_REQUIRED'));
    }
    if (isRecord(decision)) {
      if (decision['decisionId'] !== trust.actionDecisionReceiptRef) errors.push(err('actionDecisionReceipt.decisionId', 'ACTION_DECISION_MISMATCH'));
      if (decision['decisionDigest'] !== trust.actionDecisionReceiptDigest) errors.push(err('actionDecisionReceipt.decisionDigest', 'ACTION_DECISION_MISMATCH'));
      if (decision['evaluationReceiptRef'] !== trust.policyEvaluationReceiptRef) errors.push(err('actionDecisionReceipt.evaluationReceiptRef', 'EVALUATION_RECEIPT_MISMATCH'));
    }
  } else if (isRecord(decision) && decision['evaluationReceiptRef'] !== trust.policyEvaluationReceiptRef) {
    errors.push(err('actionDecisionReceipt.evaluationReceiptRef', 'EVALUATION_RECEIPT_MISMATCH'));
  }
  if (trust.planApplicability === 'approved-plan') {
    if (input['planBindingDigest'] !== trust.planBindingDigest) errors.push(err('planBindingDigest', 'PLAN_BINDING_MISMATCH'));
    if (input['planDecisionRef'] !== trust.planDecisionRef) errors.push(err('planDecisionRef', 'PLAN_DECISION_MISMATCH'));
  }

  const action = input['action'];
  if (isRecord(action) && action['kind'] === 'run_command') {
    const view = input['commandView'] as Record<string, unknown>;
    const declaredDigest = view['viewDigest'];
    const recomputedDigest = computeCommandViewDigest(view as unknown as Parameters<typeof computeCommandViewDigest>[0]);
    if (declaredDigest !== recomputedDigest || declaredDigest !== trust.commandViewDigest) errors.push(err('commandView.viewDigest', 'COMMAND_VIEW_DIGEST_MISMATCH'));
    const profile = trust.executionProfile;
    const viewFields: readonly [string, unknown][] = [
      ['taskId', trust.taskId], ['workspaceId', trust.workspaceId], ['canonicalRevision', trust.canonicalRevision],
      ['exclusionsPolicyVersion', profile.exclusionsPolicyVersion], ['scratchIdentity', profile.scratchIdentity],
      ['isolationProfileRef', profile.isolationProfileRef],
    ];
    for (const [field, expected] of viewFields) if (view[field] !== expected) errors.push(err(`commandView.${field}`, 'COMMAND_VIEW_BINDING_MISMATCH'));
    if (view['mountedReadOnly'] !== true) errors.push(err('commandView.mountedReadOnly', 'READONLY_REQUIRED'));
    const bounds = input['finiteBounds'] as Record<string, unknown>;
    const ceilings = profile.commandBounds;
    const boundPairs: readonly [string, number][] = [
      ['timeoutMs', ceilings.timeoutMs], ['maxOutputBytes', ceilings.maxOutputBytes], ['maxCpuSeconds', ceilings.maxCpuSeconds],
      ['maxMemoryBytes', ceilings.maxMemoryBytes], ['maxProcessCount', ceilings.maxProcessCount],
    ];
    for (const [field, ceiling] of boundPairs) {
      if (!isPositive(bounds[field]) || bounds[field] > ceiling) errors.push(err(`finiteBounds.${field}`, 'EXECUTION_BOUND_EXCEEDED'));
    }
    if (bounds['isolationProfileRef'] !== profile.isolationProfileRef) errors.push(err('finiteBounds.isolationProfileRef', 'ISOLATION_PROFILE_MISMATCH'));

    if (trust.planApplicability === 'pre-plan-diagnostic') {
      if (trust.runnableNode !== 'Investigate' || action['kind'] !== 'run_command') errors.push(err('runnableNode', 'DIAGNOSTIC_NODE_REQUIRED'));
      const check = trust.allowedDiagnosticChecks.find((candidate) => candidate.checkId === input['checkId']);
      if (!check || input['testPath'] !== check.testPath || input['diagnosticPurpose'] !== check.diagnosticPurpose ||
        input['taskCriteriaDigest'] !== check.taskCriteriaDigest || input['checkSetDigest'] !== check.checkSetDigest ||
        computeActionDigest(action as unknown as RunCommandAction) !== computeActionDigest(check.action)) {
        errors.push(err('checkId', 'DIAGNOSTIC_CHECK_BINDING_MISMATCH'));
      }
    }
  } else if (isRecord(action) && action['kind'] === 'apply_patch') {
    const patch = action as unknown as ApplyPatchAction;
    const targets = input['targetPaths'];
    const actionTargets = patch.targetPaths;
    const validTargets = Array.isArray(targets) && Array.isArray(actionTargets) && targets.length > 0 &&
      targets.length === actionTargets.length && targets.every((p) =>
      typeof p === 'string' && isCanonicalRelativePath(p) && !isProtectedPath(p)) &&
      actionTargets.every((p) => typeof p === 'string' && isCanonicalRelativePath(p) && !isProtectedPath(p)) &&
      new Set(targets).size === targets.length && new Set(actionTargets).size === actionTargets.length &&
      [...targets].sort().every((p, i) => p === [...actionTargets].sort()[i]);
    if (!validTargets) errors.push(err('targetPaths', 'TARGET_PATHS_MISMATCH'));
    if (input['baseRevision'] !== patch.baseRevisionDigest || input['baseRevision'] !== trust.canonicalRevision) errors.push(err('baseRevision', 'REVISION_MISMATCH'));
    const bounds = input['finiteBounds'] as Record<string, unknown>;
    const ceilings = trust.executionProfile.patchBounds;
    const patchBytes = new TextEncoder().encode(patch.patchContent).length;
    if (!isPositiveInteger(bounds['maxPatchBytes']) || bounds['maxPatchBytes'] > ceilings.maxPatchBytes || patchBytes > bounds['maxPatchBytes']) errors.push(err('finiteBounds.maxPatchBytes', 'PATCH_BYTE_LIMIT_EXCEEDED'));
    if (!isPositiveInteger(bounds['maxChangedPaths']) || bounds['maxChangedPaths'] > ceilings.maxChangedPaths || actionTargets.length > bounds['maxChangedPaths']) errors.push(err('finiteBounds.maxChangedPaths', 'PATCH_PATH_LIMIT_EXCEEDED'));
    if (trust.planApplicability === 'pre-plan-diagnostic') {
      if (trust.runnableNode !== 'Investigate' || !Array.isArray(targets) || !targets.every((p) => trust.allowedDiagnosticTestPaths.includes(p as string)) ||
        !isText(input['testPath']) || !targets.includes(input['testPath'])) errors.push(err('targetPaths', 'TEST_ONLY_PATCH_POLICY_VIOLATION'));
    }
  }
  return errors;
}

export function validateRepositoryAdmissionV02(
  input: unknown,
  trustedContext: RepositoryAdmissionTrustedContextV02,
): ValidationResult<RepositoryAdmissionContextV02> {
  const inputCopy = safeSnapshot(input);
  const trustCopy = safeSnapshot(trustedContext);
  if (!inputCopy.ok || !trustCopy.ok) return immutableResult(unsafeInputResult());
  if (!trustedRepositoryContext(trustCopy.value)) return immutableResult(fail('trustedContext', 'INVALID_TRUSTED_CONTEXT'));
  if (!isRecord(inputCopy.value)) return immutableResult(validateRepositoryAdmissionBodyV02(inputCopy.value));
  const optionalErrors = validateOptionalAdmissionFields(inputCopy.value, 'repository-action');
  if (optionalErrors.length) return immutableResult({ ok: false, errors: optionalErrors });
  const result = validateRepositoryAdmissionBodyV02(inputCopy.value);
  if (!result.ok) return immutableResult(result);
  const errors = checkRepositoryBindings(inputCopy.value, trustCopy.value);
  return immutableResult(errors.length > 0 ? { ok: false, errors } : result);
}

export function validateProviderAdmissionV02(
  input: unknown,
  trustedContext: ProviderAdmissionTrustedContextV02,
): ValidationResult<ProviderAdmissionContextV02> {
  const inputCopy = safeSnapshot(input);
  const trustCopy = safeSnapshot(trustedContext);
  if (!inputCopy.ok || !trustCopy.ok) return immutableResult(unsafeInputResult());
  if (!trustedProviderContext(trustCopy.value)) return immutableResult(fail('trustedContext', 'INVALID_TRUSTED_CONTEXT'));
  if (!isRecord(inputCopy.value)) return immutableResult(fail('context', 'INVALID_TYPE'));
  const optionalErrors = validateOptionalAdmissionFields(inputCopy.value, 'provider-request');
  if (optionalErrors.length) return immutableResult({ ok: false, errors: optionalErrors });
  const result = validateProviderAdmissionBodyV02(inputCopy.value, trustCopy.value);
  if (!result.ok) return immutableResult(result);
  const errors = checkProviderAdmissionBindingsV02(inputCopy.value, trustCopy.value);
  return immutableResult(errors.length > 0 ? { ok: false, errors } : result);
}

export function computeAdmissionDigest(context: unknown): string {
  if (!isPlainObject(context)) throw new Error('computeAdmissionDigest requires an object');
  const copy = { ...(context as Record<string, unknown>) };
  delete copy['admissionDigest'];
  return computeCanonicalSha256(copy);
}

export function validateAdmissionV02(
  input: unknown,
  trustedContext: AdmissionTrustedContextV02,
): ValidationResult<AdmissionContextV02> {
  const inputCopy = safeSnapshot(input);
  const trustCopy = safeSnapshot(trustedContext);
  if (!inputCopy.ok || !trustCopy.ok) return immutableResult(unsafeInputResult());
  if (!isRecord(inputCopy.value)) return immutableResult(fail('context', 'INVALID_TYPE'));
  if (inputCopy.value['subjectKind'] === 'repository-action') {
    return validateRepositoryAdmissionV02(inputCopy.value, trustCopy.value as RepositoryAdmissionTrustedContextV02);
  }
  if (inputCopy.value['subjectKind'] === 'provider-request') {
    return validateProviderAdmissionV02(inputCopy.value, trustCopy.value as ProviderAdmissionTrustedContextV02);
  }
  return immutableResult(fail('subjectKind', 'INVALID_SUBJECT_KIND'));
}
