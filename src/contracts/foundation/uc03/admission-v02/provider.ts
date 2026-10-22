/**
 * UC-03 v0.2.0 Provider Admission Validation.
 *
 * Cohesive helper for validateProviderAdmissionV02 and computeRequestContentDigest:
 * - Canonical requestContentDigest verification
 * - Provider role, config, pricing, and policy identity
 * - Provider admission receipt and decision authority generation
 * - Explicit pre-plan-diagnostic vs approved-plan applicability
 * - Finite bounds (tokens, cost, reviewer iterations)
 * - Strict cross-branch rejection
 */

import { computeCanonicalSha256 } from '../identity.ts';
import type {
  ProviderAdmissionContextV02,
  ProviderAdmissionReceiptV02,
  ProviderFiniteBoundsV02,
  ProviderPricingIdentityV02,
} from '../ports-v02.ts';
import type {
  ProviderRequest,
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
import { validateProviderRequest } from '../validation/provider/request.ts';

const PROV_ALLOWED = [
  'schemaVersion', 'subjectKind', 'planApplicability',
  'taskStateSchemaVersion', 'expectedTaskStateVersion',
  'controlSchemaVersion', 'expectedControlVersion', 'expectedEpoch',
  'taskId', 'runId', 'providerRequest', 'providerRequestId', 'role',
  'requestContentDigest', 'providerIdentity', 'providerAdmissionReceipt',
  'requestReservationReceipt', 'budgetRefs', 'finiteBounds', 'admissionDigest',
  'diagnosticPurpose', 'taskCriteriaDigest',
  'planBindingDigest', 'planDecisionRef',
] as const;

const REPO_CROSS = [
  'action', 'actionDigest', 'commandView', 'policyEvaluationReceipt',
  'actionDecisionReceipt', 'patchDigest', 'baseRevision', 'targetPaths', 'executionProfileId',
] as const;

const PROV_ID_KEYS = ['providerId', 'modelId', 'configId', 'configVersion', 'pricingPolicyId', 'pricingPolicyVersion', 'issuerKeyRef', 'decisionAuthorityGeneration'] as const;
const PROV_REC_KEYS = ['receiptId', 'receiptDigest', 'providerRequestId', 'role', 'requestContentDigest', 'providerId', 'modelId', 'configId', 'configVersion', 'decisionAuthorityGeneration'] as const;
const PROV_BOUNDS_KEYS = ['maxInputTokens', 'maxOutputTokens', 'maxCostUsd', 'maxReviewerIterations'] as const;

export function computeRequestContentDigest(request: unknown): string {
  if (!isPlainObject(request)) throw new Error('computeRequestContentDigest requires an object');
  return computeCanonicalSha256({
    providerRequestId: request['providerRequestId'],
    taskId: request['taskId'],
    runId: request['runId'],
    role: request['role'],
    purpose: request['purpose'],
    providerId: request['providerId'],
    modelId: request['modelId'],
    configId: request['configId'],
    pricingPolicyId: request['pricingPolicyId'],
    contextDigest: request['contextDigest'],
    timeoutMs: request['timeoutMs'],
    maxInputTokens: request['maxInputTokens'],
    maxOutputTokens: request['maxOutputTokens'],
    maxBillableTokens: request['maxBillableTokens'],
    maxCostUsd: request['maxCostUsd'],
  });
}

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

export function validateProviderAdmissionV02(
  input: unknown
): ValidationResult<ProviderAdmissionContextV02> {
  const errs: ValidationError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: 'context', message: 'Provider admission context must be an object', code: 'INVALID_TYPE' }] };
  }

  for (const k of REPO_CROSS) {
    if (input[k] !== undefined) {
      return { ok: false, errors: [{ path: 'context', message: 'Repository fields forbidden on provider context', code: 'CROSS_BRANCH_FIELDS_FORBIDDEN' }] };
    }
  }

  rejectUnknownKeys(input, PROV_ALLOWED, '', errs);
  if (input['schemaVersion'] !== '0.2.0') errs.push({ path: 'schemaVersion', message: 'schemaVersion must be "0.2.0"', code: 'INVALID_SCHEMA_VERSION' });
  if (input['subjectKind'] !== 'provider-request') errs.push({ path: 'subjectKind', message: 'subjectKind must be "provider-request"', code: 'INVALID_SUBJECT_KIND' });

  const planApp = input['planApplicability'];
  if (planApp === 'pre-plan-diagnostic') {
    if (input['planBindingDigest'] !== undefined) errs.push({ path: 'planBindingDigest', message: 'planBindingDigest forbidden in pre-plan', code: 'PLAN_FIELDS_FORBIDDEN_IN_PRE_PLAN' });
    if (input['planDecisionRef'] !== undefined) errs.push({ path: 'planDecisionRef', message: 'planDecisionRef forbidden in pre-plan', code: 'PLAN_FIELDS_FORBIDDEN_IN_PRE_PLAN' });
    reqStrings(input, ['diagnosticPurpose', 'taskCriteriaDigest'], '', errs);
  } else if (planApp === 'approved-plan') {
    reqStrings(input, ['planBindingDigest', 'planDecisionRef'], '', errs);
  } else {
    errs.push({ path: 'planApplicability', message: 'planApplicability must be pre-plan-diagnostic or approved-plan', code: 'INVALID_PLAN_APPLICABILITY' });
  }

  reqStrings(input, ['taskStateSchemaVersion', 'controlSchemaVersion', 'taskId', 'runId', 'requestReservationReceipt'], '', errs);
  validateNonNegativeInteger(input['expectedTaskStateVersion'], 'expectedTaskStateVersion', errs);
  validateNonNegativeInteger(input['expectedControlVersion'], 'expectedControlVersion', errs);
  validateNonNegativeInteger(input['expectedEpoch'], 'expectedEpoch', errs);

  const reqRes = validateProviderRequest(input['providerRequest']);
  let validReq: ProviderRequest | undefined;
  if (!reqRes.ok) errs.push(...reqRes.errors);
  else {
    validReq = reqRes.value;
    const computedDigest = computeRequestContentDigest(validReq);
    const declaredDigest = validateNonEmptyString(input['requestContentDigest'], 'requestContentDigest', errs);
    if (declaredDigest && declaredDigest !== computedDigest) {
      errs.push({ path: 'requestContentDigest', message: 'requestContentDigest mismatch', code: 'REQUEST_CONTENT_DIGEST_MISMATCH' });
    }
    const declaredId = validateNonEmptyString(input['providerRequestId'], 'providerRequestId', errs);
    if (declaredId && declaredId !== validReq.providerRequestId) {
      errs.push({ path: 'providerRequestId', message: 'providerRequestId mismatch', code: 'PROVIDER_REQUEST_ID_MISMATCH' });
    }
    const role = input['role'];
    if (role !== 'coder' && role !== 'reviewer') {
      errs.push({ path: 'role', message: 'role must be coder or reviewer', code: 'INVALID_ROLE' });
    } else if (role !== validReq.role) {
      errs.push({ path: 'role', message: 'role mismatch', code: 'ROLE_MISMATCH' });
    }
  }

  let provId: ProviderPricingIdentityV02 | undefined;
  if (!isPlainObject(input['providerIdentity'])) {
    errs.push({ path: 'providerIdentity', message: 'providerIdentity must be an object', code: 'INVALID_TYPE' });
  } else {
    const id = input['providerIdentity'];
    rejectUnknownKeys(id, PROV_ID_KEYS, 'providerIdentity', errs);
    reqStrings(id, ['providerId', 'modelId', 'configId', 'configVersion', 'pricingPolicyId', 'pricingPolicyVersion', 'issuerKeyRef'], 'providerIdentity', errs);
    const gen = validatePositiveInteger(id['decisionAuthorityGeneration'], 'providerIdentity.decisionAuthorityGeneration', errs);
    if (validReq) {
      if (id['providerId'] && id['providerId'] !== validReq.providerId) errs.push({ path: 'providerIdentity.providerId', message: 'providerId mismatch', code: 'PROVIDER_IDENTITY_MISMATCH' });
      if (id['modelId'] && id['modelId'] !== validReq.modelId) errs.push({ path: 'providerIdentity.modelId', message: 'modelId mismatch', code: 'PROVIDER_IDENTITY_MISMATCH' });
      if (id['configId'] && id['configId'] !== validReq.configId) errs.push({ path: 'providerIdentity.configId', message: 'configId mismatch', code: 'PROVIDER_IDENTITY_MISMATCH' });
      if (id['pricingPolicyId'] && id['pricingPolicyId'] !== validReq.pricingPolicyId) errs.push({ path: 'providerIdentity.pricingPolicyId', message: 'pricingPolicyId mismatch', code: 'PROVIDER_IDENTITY_MISMATCH' });
    }
    if (gen !== undefined) provId = id as unknown as ProviderPricingIdentityV02;
  }

  let provRec: ProviderAdmissionReceiptV02 | undefined;
  if (!isPlainObject(input['providerAdmissionReceipt'])) {
    errs.push({ path: 'providerAdmissionReceipt', message: 'providerAdmissionReceipt must be an object', code: 'INVALID_TYPE' });
  } else {
    const rec = input['providerAdmissionReceipt'];
    rejectUnknownKeys(rec, PROV_REC_KEYS, 'providerAdmissionReceipt', errs);
    reqStrings(rec, ['receiptId', 'receiptDigest', 'providerRequestId', 'requestContentDigest', 'providerId', 'modelId', 'configId', 'configVersion'], 'providerAdmissionReceipt', errs);
    const gen = validatePositiveInteger(rec['decisionAuthorityGeneration'], 'providerAdmissionReceipt.decisionAuthorityGeneration', errs);
    if (rec['role'] !== 'coder' && rec['role'] !== 'reviewer') {
      errs.push({ path: 'providerAdmissionReceipt.role', message: 'role must be coder or reviewer', code: 'INVALID_ROLE' });
    }
    if (validReq && rec['providerRequestId'] && rec['providerRequestId'] !== validReq.providerRequestId) {
      errs.push({ path: 'providerAdmissionReceipt.providerRequestId', message: 'providerRequestId mismatch', code: 'PROVIDER_REQUEST_ID_MISMATCH' });
    }
    if (input['requestContentDigest'] && rec['requestContentDigest'] && rec['requestContentDigest'] !== input['requestContentDigest']) {
      errs.push({ path: 'providerAdmissionReceipt.requestContentDigest', message: 'requestContentDigest mismatch', code: 'REQUEST_CONTENT_DIGEST_MISMATCH' });
    }
    if (provId) {
      matchProp(rec, provId as unknown as Record<string, unknown>, ['providerId', 'modelId', 'configId', 'configVersion'], 'providerAdmissionReceipt', 'PROVIDER_IDENTITY_MISMATCH', errs);
      if (gen !== undefined && gen !== provId.decisionAuthorityGeneration) {
        errs.push({ path: 'providerAdmissionReceipt.decisionAuthorityGeneration', message: 'authority generation mismatch', code: 'AUTHORITY_GENERATION_MISMATCH' });
      }
    }
    if (gen !== undefined && (rec['role'] === 'coder' || rec['role'] === 'reviewer')) {
      provRec = rec as unknown as ProviderAdmissionReceiptV02;
    }
  }

  let finiteBounds: ProviderFiniteBoundsV02 | undefined;
  if (!isPlainObject(input['finiteBounds'])) {
    errs.push({ path: 'finiteBounds', message: 'finiteBounds required', code: 'MISSING_FINITE_BOUNDS' });
  } else {
    const b = input['finiteBounds'];
    rejectUnknownKeys(b, PROV_BOUNDS_KEYS, 'finiteBounds', errs);
    const inT = validatePositiveNumber(b['maxInputTokens'], 'finiteBounds.maxInputTokens', errs);
    const outT = validatePositiveNumber(b['maxOutputTokens'], 'finiteBounds.maxOutputTokens', errs);
    const cost = validatePositiveNumber(b['maxCostUsd'], 'finiteBounds.maxCostUsd', errs);
    let iter: number | undefined;
    if (input['role'] === 'reviewer') {
      iter = validatePositiveInteger(b['maxReviewerIterations'], 'finiteBounds.maxReviewerIterations', errs);
    }
    if (inT !== undefined && outT !== undefined && cost !== undefined) {
      finiteBounds = {
        maxInputTokens: inT,
        maxOutputTokens: outT,
        maxCostUsd: cost,
        maxReviewerIterations: iter,
      };
    }
  }

  const rawBudgetRefs = input['budgetRefs'];
  if (!Array.isArray(rawBudgetRefs) || rawBudgetRefs.length === 0) {
    errs.push({ path: 'budgetRefs', message: 'budgetRefs required', code: 'MISSING_BUDGET_REFS' });
  } else {
    for (let i = 0; i < rawBudgetRefs.length; i++) {
      if (typeof rawBudgetRefs[i] !== 'string' || !rawBudgetRefs[i].trim()) {
        errs.push({ path: `budgetRefs[${i}]`, message: 'invalid budget ref', code: 'INVALID_BUDGET_REF' });
      }
    }
  }

  if (errs.length > 0) return { ok: false, errors: errs };
  if (!validReq || !provId || !provRec || !finiteBounds) {
    return { ok: false, errors: [{ path: 'context', message: 'Incomplete provider admission context', code: 'INCOMPLETE_CONTEXT' }] };
  }
  return {
    ok: true,
    value: {
      ...(input as unknown as ProviderAdmissionContextV02),
      providerRequest: validReq,
      providerIdentity: provId,
      providerAdmissionReceipt: provRec,
      finiteBounds: finiteBounds,
    },
  };
}
