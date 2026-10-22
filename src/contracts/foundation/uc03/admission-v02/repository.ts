/**
 * UC-03 v0.2.0 Repository Admission Validation.
 *
 * Cohesive helper for validateRepositoryAdmissionV02:
 * - Canonical action digest verification
 * - Command view, admitted files, exclusions, scratch, and finite bounds
 * - Policy authority reference and policy evaluation receipt
 * - Action decision receipt (mandatory when APPROVAL_REQUIRED)
 * - Explicit pre-plan-diagnostic vs approved-plan applicability
 * - Test-only patch enforcement during pre-plan
 * - Strict cross-branch rejection
 */

import {
  computeActionDigest,
  computeCanonicalSha256,
  isCanonicalRelativePath,
  isProtectedPath,
} from '../identity.ts';
import type {
  ActionDecisionReceiptV02,
  CommandFiniteBoundsV02,
  CommandViewV02,
  PatchFiniteBoundsV02,
  PolicyAuthorityRefV02,
  PolicyEvaluationReceiptV02,
  RepositoryAdmissionContextV02,
} from '../ports-v02.ts';
import type {
  AdmittedFile,
  ApplyPatchAction,
  NormalizedAction,
  ValidationError,
  ValidationResult,
} from '../types.ts';
import {
  isPlainObject,
  rejectUnknownKeys,
  validateNonEmptyString,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validatePositiveNumber,
} from '../validation/common.ts';
import { validateNormalizedAction } from '../validation/intake/actions.ts';

const REPO_ALLOWED = [
  'schemaVersion', 'subjectKind', 'planApplicability',
  'taskStateSchemaVersion', 'expectedTaskStateVersion',
  'controlSchemaVersion', 'expectedControlVersion', 'expectedEpoch',
  'taskId', 'runId', 'workspaceId', 'repositoryId', 'runnableNode',
  'canonicalRevision', 'executionProfileId', 'action', 'actionDigest',
  'policyAuthorityRef', 'policyEvaluationReceipt', 'actionDecisionReceipt',
  'reservationRefs', 'admissionDigest',
  'diagnosticPurpose', 'taskCriteriaDigest', 'checkSetDigest', 'testPath', 'checkId',
  'planBindingDigest', 'planDecisionRef',
  'commandView', 'baseRevision', 'targetPaths', 'patchDigest', 'finiteBounds',
] as const;

const PROV_CROSS = [
  'providerRequestId', 'requestContentDigest', 'providerRequest',
  'providerAdmissionReceipt', 'requestReservationReceipt', 'budgetRefs', 'providerIdentity',
] as const;

const AUTH_REF_KEYS = ['policyId', 'policyVersion', 'configId', 'configVersion', 'issuerKeyRef', 'decisionAuthorityGeneration'] as const;
const PE_RECEIPT_KEYS = ['receiptId', 'receiptDigest', 'actionDigest', 'freshnessContextDigest', 'policyId', 'policyVersion', 'configId', 'configVersion', 'decisionAuthorityGeneration', 'result'] as const;
const AD_RECEIPT_KEYS = ['decisionId', 'decisionDigest', 'actionDigest', 'evaluationReceiptRef', 'decisionAuthorityGeneration', 'status', 'reason'] as const;
const CMD_BOUNDS_KEYS = ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount', 'isolationProfileRef'] as const;
const PATCH_BOUNDS_KEYS = ['maxPatchBytes', 'maxChangedPaths'] as const;
const CMD_VIEW_ALLOWED = [
  'viewId', 'viewDigest', 'taskId', 'workspaceId',
  'canonicalRevision', 'canonicalRevisionDigest',
  'admittedFiles', 'exclusionsPolicyVersion', 'scratchIdentity',
  'mountedReadOnly', 'isolationProfileRef',
] as const;

function reqStrings(o: Record<string, unknown>, keys: readonly string[], pre: string, errs: ValidationError[]): void {
  for (const k of keys) validateNonEmptyString(o[k], pre ? `${pre}.${k}` : k, errs);
}

function matchProp(src: Record<string, unknown>, tgt: Record<string, unknown>, fields: readonly string[], pre: string, code: string, errs: ValidationError[]): void {
  for (const f of fields) {
    if (src[f] !== undefined && tgt[f] !== undefined && src[f] !== tgt[f]) {
      errs.push({ path: `${pre}.${f}`, message: `${pre}.${f} does not match authority reference`, code });
    }
  }
}

function isTestPath(p: string): boolean {
  const norm = p.replace(/\\/g, '/').toLowerCase();
  return (
    norm.startsWith('tests/') ||
    norm.includes('/tests/') ||
    norm.includes('/test_') ||
    norm.endsWith('_test.py') ||
    norm.endsWith('.test.ts') ||
    norm.endsWith('.test.js')
  );
}

export function validateRepositoryAdmissionV02(
  input: unknown
): ValidationResult<RepositoryAdmissionContextV02> {
  const errs: ValidationError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: 'context', message: 'Repository admission context must be an object', code: 'INVALID_TYPE' }] };
  }

  for (const k of PROV_CROSS) {
    if (input[k] !== undefined) {
      return { ok: false, errors: [{ path: 'context', message: 'Provider fields forbidden on repository context', code: 'CROSS_BRANCH_FIELDS_FORBIDDEN' }] };
    }
  }

  rejectUnknownKeys(input, REPO_ALLOWED, '', errs);
  if (input['schemaVersion'] !== '0.2.0') errs.push({ path: 'schemaVersion', message: 'schemaVersion must be "0.2.0"', code: 'INVALID_SCHEMA_VERSION' });
  if (input['subjectKind'] !== 'repository-action') errs.push({ path: 'subjectKind', message: 'subjectKind must be "repository-action"', code: 'INVALID_SUBJECT_KIND' });

  const planApp = input['planApplicability'];
  if (planApp === 'pre-plan-diagnostic') {
    if (input['planBindingDigest'] !== undefined) errs.push({ path: 'planBindingDigest', message: 'planBindingDigest forbidden in pre-plan', code: 'PLAN_FIELDS_FORBIDDEN_IN_PRE_PLAN' });
    if (input['planDecisionRef'] !== undefined) errs.push({ path: 'planDecisionRef', message: 'planDecisionRef forbidden in pre-plan', code: 'PLAN_FIELDS_FORBIDDEN_IN_PRE_PLAN' });
    reqStrings(input, ['diagnosticPurpose', 'taskCriteriaDigest', 'checkSetDigest'], '', errs);
  } else if (planApp === 'approved-plan') {
    reqStrings(input, ['planBindingDigest', 'planDecisionRef'], '', errs);
  } else {
    errs.push({ path: 'planApplicability', message: 'planApplicability must be pre-plan-diagnostic or approved-plan', code: 'INVALID_PLAN_APPLICABILITY' });
  }

  reqStrings(input, ['taskStateSchemaVersion', 'controlSchemaVersion', 'taskId', 'runId', 'workspaceId', 'repositoryId', 'runnableNode', 'canonicalRevision', 'executionProfileId'], '', errs);
  validateNonNegativeInteger(input['expectedTaskStateVersion'], 'expectedTaskStateVersion', errs);
  validateNonNegativeInteger(input['expectedControlVersion'], 'expectedControlVersion', errs);
  validateNonNegativeInteger(input['expectedEpoch'], 'expectedEpoch', errs);

  const actRes = validateNormalizedAction(input['action']);
  let validAct: NormalizedAction | undefined;
  if (!actRes.ok) errs.push(...actRes.errors);
  else {
    validAct = actRes.value;
    const computedDigest = computeActionDigest(validAct);
    const declaredDigest = validateNonEmptyString(input['actionDigest'], 'actionDigest', errs);
    if (declaredDigest && declaredDigest !== computedDigest) {
      errs.push({ path: 'actionDigest', message: 'Action digest mismatch', code: 'ACTION_DIGEST_MISMATCH' });
    }
  }

  if (planApp === 'pre-plan-diagnostic' && validAct) {
    if (validAct.kind === 'apply_patch') {
      const nonTests = (validAct as ApplyPatchAction).targetPaths.filter((p) => !isTestPath(p));
      if (nonTests.length > 0) {
        errs.push({ path: 'action.targetPaths', message: `Test-only patch violation: ${nonTests.join(', ')}`, code: 'TEST_ONLY_PATCH_POLICY_VIOLATION' });
      }
    } else if (validAct.kind === 'approve_fix_plan') {
      errs.push({ path: 'action.kind', message: 'approve_fix_plan forbidden in pre-plan', code: 'ACTION_NOT_PERMITTED_IN_PRE_PLAN' });
    }
  }

  let policyAuth: PolicyAuthorityRefV02 | undefined;
  if (!isPlainObject(input['policyAuthorityRef'])) {
    errs.push({ path: 'policyAuthorityRef', message: 'policyAuthorityRef must be an object', code: 'INVALID_TYPE' });
  } else {
    const ref = input['policyAuthorityRef'];
    rejectUnknownKeys(ref, AUTH_REF_KEYS, 'policyAuthorityRef', errs);
    reqStrings(ref, ['policyId', 'policyVersion', 'configId', 'configVersion', 'issuerKeyRef'], 'policyAuthorityRef', errs);
    const gen = validatePositiveInteger(ref['decisionAuthorityGeneration'], 'policyAuthorityRef.decisionAuthorityGeneration', errs);
    if (gen !== undefined) policyAuth = ref as unknown as PolicyAuthorityRefV02;
  }

  let peReceipt: PolicyEvaluationReceiptV02 | undefined;
  if (!isPlainObject(input['policyEvaluationReceipt'])) {
    errs.push({ path: 'policyEvaluationReceipt', message: 'policyEvaluationReceipt must be an object', code: 'INVALID_TYPE' });
  } else {
    const pe = input['policyEvaluationReceipt'];
    rejectUnknownKeys(pe, PE_RECEIPT_KEYS, 'policyEvaluationReceipt', errs);
    reqStrings(pe, ['receiptId', 'receiptDigest', 'actionDigest', 'freshnessContextDigest', 'policyId', 'policyVersion', 'configId', 'configVersion'], 'policyEvaluationReceipt', errs);
    const peGen = validatePositiveInteger(pe['decisionAuthorityGeneration'], 'policyEvaluationReceipt.decisionAuthorityGeneration', errs);
    const res = pe['result'];
    if (res !== 'ALLOWED' && res !== 'APPROVAL_REQUIRED' && res !== 'FORBIDDEN') {
      errs.push({ path: 'policyEvaluationReceipt.result', message: 'invalid result', code: 'INVALID_RESULT' });
    } else if (res === 'FORBIDDEN') {
      errs.push({ path: 'policyEvaluationReceipt.result', message: 'FORBIDDEN result never admits', code: 'POLICY_FORBIDDEN' });
    }
    if (input['actionDigest'] && pe['actionDigest'] && pe['actionDigest'] !== input['actionDigest']) {
      errs.push({ path: 'policyEvaluationReceipt.actionDigest', message: 'actionDigest mismatch', code: 'ACTION_DIGEST_MISMATCH' });
    }
    if (policyAuth) {
      matchProp(pe, policyAuth as unknown as Record<string, unknown>, ['policyId', 'policyVersion', 'configId', 'configVersion'], 'policyEvaluationReceipt', 'POLICY_MISMATCH', errs);
      if (peGen !== undefined && peGen !== policyAuth.decisionAuthorityGeneration) {
        errs.push({ path: 'policyEvaluationReceipt.decisionAuthorityGeneration', message: 'authority generation mismatch', code: 'AUTHORITY_GENERATION_MISMATCH' });
      }
    }
    if (peGen !== undefined && (res === 'ALLOWED' || res === 'APPROVAL_REQUIRED' || res === 'FORBIDDEN')) {
      peReceipt = pe as unknown as PolicyEvaluationReceiptV02;
    }
  }

  let adReceipt: ActionDecisionReceiptV02 | undefined;
  if (input['actionDecisionReceipt'] !== undefined) {
    if (!isPlainObject(input['actionDecisionReceipt'])) {
      errs.push({ path: 'actionDecisionReceipt', message: 'actionDecisionReceipt must be an object', code: 'INVALID_TYPE' });
    } else {
      const ad = input['actionDecisionReceipt'];
      rejectUnknownKeys(ad, AD_RECEIPT_KEYS, 'actionDecisionReceipt', errs);
      reqStrings(ad, ['decisionId', 'decisionDigest', 'actionDigest', 'evaluationReceiptRef'], 'actionDecisionReceipt', errs);
      const adGen = validatePositiveInteger(ad['decisionAuthorityGeneration'], 'actionDecisionReceipt.decisionAuthorityGeneration', errs);
      if (ad['status'] !== 'approved') errs.push({ path: 'actionDecisionReceipt.status', message: 'status must be approved', code: 'DECISION_NOT_APPROVED' });
      if (input['actionDigest'] && ad['actionDigest'] && ad['actionDigest'] !== input['actionDigest']) {
        errs.push({ path: 'actionDecisionReceipt.actionDigest', message: 'actionDigest mismatch', code: 'ACTION_DIGEST_MISMATCH' });
      }
      if (policyAuth && adGen !== undefined && adGen !== policyAuth.decisionAuthorityGeneration) {
        errs.push({ path: 'actionDecisionReceipt.decisionAuthorityGeneration', message: 'generation mismatch', code: 'AUTHORITY_GENERATION_MISMATCH' });
      }
      if (adGen !== undefined && ad['status'] === 'approved') adReceipt = ad as unknown as ActionDecisionReceiptV02;
    }
  }

  if (peReceipt && peReceipt.result === 'APPROVAL_REQUIRED' && !adReceipt) {
    errs.push({ path: 'actionDecisionReceipt', message: 'APPROVAL_REQUIRED requires ActionDecisionReceipt', code: 'MISSING_ACTION_DECISION_RECEIPT' });
  }

  let cmdView: CommandViewV02 | undefined;
  let finBounds: CommandFiniteBoundsV02 | PatchFiniteBoundsV02 | undefined;
  let baseRev: string | undefined;
  let tgtPaths: readonly string[] | undefined;
  let patchDig: string | undefined;

  if (validAct?.kind === 'run_command') {
    if (!isPlainObject(input['commandView'])) {
      errs.push({ path: 'commandView', message: 'commandView required', code: 'MISSING_COMMAND_VIEW' });
    } else {
      const cvObj = input['commandView'] as Record<string, unknown>;
      rejectUnknownKeys(cvObj, CMD_VIEW_ALLOWED, 'commandView', errs);
      reqStrings(cvObj, ['viewId', 'viewDigest', 'taskId', 'workspaceId', 'exclusionsPolicyVersion', 'scratchIdentity', 'isolationProfileRef'], 'commandView', errs);
      const rev = (cvObj['canonicalRevision'] ?? cvObj['canonicalRevisionDigest']) as string | undefined;
      if (typeof rev !== 'string' || !rev.trim()) {
        errs.push({ path: 'commandView.canonicalRevision', message: 'canonicalRevision required', code: 'MISSING_FIELD' });
      } else if (input['canonicalRevision'] && rev !== input['canonicalRevision']) {
        errs.push({ path: 'commandView.canonicalRevision', message: 'revision mismatch', code: 'REVISION_MISMATCH' });
      }
      if (cvObj['mountedReadOnly'] !== true) {
        errs.push({ path: 'commandView.mountedReadOnly', message: 'CommandView must be mounted read-only (mountedReadOnly: true)', code: 'READONLY_REQUIRED' });
      }
      const admitted = cvObj['admittedFiles'];
      let validAdmitted: AdmittedFile[] | undefined;
      if (!Array.isArray(admitted)) {
        errs.push({ path: 'commandView.admittedFiles', message: 'admittedFiles must be an array', code: 'INVALID_TYPE' });
      } else {
        validAdmitted = [];
        for (let i = 0; i < admitted.length; i++) {
          const file = admitted[i];
          if (!isPlainObject(file)) {
            errs.push({ path: `commandView.admittedFiles[${i}]`, message: 'admitted file must be an object', code: 'INVALID_TYPE' });
            continue;
          }
          const filePath = file['path'];
          const fileDigest = file['digest'];
          let okPath = false;
          if (typeof filePath !== 'string' || !filePath.trim()) {
            errs.push({ path: `commandView.admittedFiles[${i}].path`, message: 'path must be a non-empty string', code: 'INVALID_PATH' });
          } else {
            if (!isCanonicalRelativePath(filePath)) {
              errs.push({ path: `commandView.admittedFiles[${i}].path`, message: `Path is not a canonical relative path: ${filePath}`, code: 'NON_CANONICAL_PATH' });
            } else if (isProtectedPath(filePath)) {
              errs.push({ path: `commandView.admittedFiles[${i}].path`, message: `Path is a protected path: ${filePath}`, code: 'PROTECTED_PATH_FORBIDDEN' });
            } else {
              okPath = true;
            }
          }
          let okDigest = false;
          if (typeof fileDigest !== 'string' || !fileDigest.trim()) {
            errs.push({ path: `commandView.admittedFiles[${i}].digest`, message: 'digest must be a non-empty string', code: 'INVALID_DIGEST' });
          } else {
            okDigest = true;
          }
          if (okPath && okDigest) {
            validAdmitted.push({ path: filePath as string, digest: fileDigest as string });
          }
        }
      }
      if (rev && cvObj['mountedReadOnly'] === true && cvObj['isolationProfileRef'] && validAdmitted && errs.length === 0) {
        cmdView = {
          viewId: String(cvObj['viewId']),
          viewDigest: String(cvObj['viewDigest']),
          taskId: String(cvObj['taskId']),
          workspaceId: String(cvObj['workspaceId']),
          canonicalRevision: rev,
          admittedFiles: validAdmitted,
          exclusionsPolicyVersion: String(cvObj['exclusionsPolicyVersion']),
          scratchIdentity: String(cvObj['scratchIdentity']),
          mountedReadOnly: true,
          isolationProfileRef: String(cvObj['isolationProfileRef']),
        };
      }
    }

    if (!isPlainObject(input['finiteBounds'])) {
      errs.push({ path: 'finiteBounds', message: 'finiteBounds required', code: 'MISSING_FINITE_BOUNDS' });
    } else {
      const b = input['finiteBounds'];
      rejectUnknownKeys(b, CMD_BOUNDS_KEYS, 'finiteBounds', errs);
      const t = validatePositiveNumber(b['timeoutMs'], 'finiteBounds.timeoutMs', errs);
      const m = validatePositiveNumber(b['maxOutputBytes'], 'finiteBounds.maxOutputBytes', errs);
      const iso = validateNonEmptyString(b['isolationProfileRef'], 'finiteBounds.isolationProfileRef', errs);
      const cpu = b['maxCpuSeconds'] !== undefined ? validatePositiveNumber(b['maxCpuSeconds'], 'finiteBounds.maxCpuSeconds', errs) : undefined;
      const mem = b['maxMemoryBytes'] !== undefined ? validatePositiveNumber(b['maxMemoryBytes'], 'finiteBounds.maxMemoryBytes', errs) : undefined;
      const proc = b['maxProcessCount'] !== undefined ? validatePositiveInteger(b['maxProcessCount'], 'finiteBounds.maxProcessCount', errs) : undefined;
      if (t !== undefined && m !== undefined && iso) {
        finBounds = { timeoutMs: t, maxOutputBytes: m, maxCpuSeconds: cpu, maxMemoryBytes: mem, maxProcessCount: proc, isolationProfileRef: iso };
      }
    }
  } else if (validAct?.kind === 'apply_patch') {
    const patch = validAct as ApplyPatchAction;
    baseRev = validateNonEmptyString(input['baseRevision'], 'baseRevision', errs);
    if (baseRev && input['canonicalRevision'] && baseRev !== input['canonicalRevision']) {
      errs.push({ path: 'baseRevision', message: 'baseRevision mismatch', code: 'REVISION_MISMATCH' });
    }
    if (!Array.isArray(input['targetPaths'])) errs.push({ path: 'targetPaths', message: 'targetPaths must be array', code: 'INVALID_TYPE' });
    else tgtPaths = input['targetPaths'];

    patchDig = validateNonEmptyString(input['patchDigest'], 'patchDigest', errs);
    const expPd = computeCanonicalSha256(patch.patchContent);
    if (patchDig && patchDig !== expPd) errs.push({ path: 'patchDigest', message: 'patchDigest mismatch', code: 'PATCH_DIGEST_MISMATCH' });

    if (!isPlainObject(input['finiteBounds'])) {
      errs.push({ path: 'finiteBounds', message: 'finiteBounds required for patch', code: 'MISSING_FINITE_BOUNDS' });
    } else {
      const b = input['finiteBounds'];
      rejectUnknownKeys(b, PATCH_BOUNDS_KEYS, 'finiteBounds', errs);
      const mp = validatePositiveInteger(b['maxPatchBytes'], 'finiteBounds.maxPatchBytes', errs);
      const mc = validatePositiveInteger(b['maxChangedPaths'], 'finiteBounds.maxChangedPaths', errs);
      if (mp !== undefined && mc !== undefined) finBounds = { maxPatchBytes: mp, maxChangedPaths: mc };
    }
  }

  const rawRefs = input['reservationRefs'];
  if (!Array.isArray(rawRefs) || rawRefs.length === 0) {
    errs.push({ path: 'reservationRefs', message: 'reservationRefs required', code: 'MISSING_RESERVATIONS' });
  } else {
    for (let i = 0; i < rawRefs.length; i++) {
      if (typeof rawRefs[i] !== 'string' || !rawRefs[i].trim()) {
        errs.push({ path: `reservationRefs[${i}]`, message: 'invalid ref', code: 'INVALID_RESERVATION_REF' });
      }
    }
  }

  if (errs.length > 0) return { ok: false, errors: errs };
  if (!validAct || !policyAuth || !peReceipt) {
    return { ok: false, errors: [{ path: 'context', message: 'Incomplete repository admission context', code: 'INCOMPLETE_CONTEXT' }] };
  }
  return {
    ok: true,
    value: {
      ...(input as unknown as RepositoryAdmissionContextV02),
      action: validAct,
      policyAuthorityRef: policyAuth,
      policyEvaluationReceipt: peReceipt,
      actionDecisionReceipt: adReceipt,
      commandView: cmdView,
      finiteBounds: finBounds,
      baseRevision: baseRev,
      targetPaths: tgtPaths,
      patchDigest: patchDig,
    },
  };
}
