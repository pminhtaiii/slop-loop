import type { ApprovalBinding, ApprovalBindingContext, NormalizedAction, ProviderRequest, ValidationResult } from '../contracts/foundation/uc03.ts';
import { isProxy } from 'node:util/types';
import type { PolicyProfile, ProviderRole, SafePresentation } from '../contracts/approvals/contracts.ts';
import { UC05_APPROVAL_SCHEMA_VERSION_V02, validatePolicyProfile } from '../contracts/approvals/contracts.ts';
import { containsProtectedContent } from '../foundation/repository-tools.ts';

export type PresentationSubjectKindV02 = 'repository-action' | 'provider-request';
export type PresentationPlanApplicabilityV02 = 'pre-plan-diagnostic' | 'approved-plan';

export interface SafePresentationV02Base {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION_V02;
  readonly decisionId: string;
  readonly requestVersion: number;
  readonly bindingFingerprint: string;
  readonly elements: SafePresentation['elements'];
  readonly inspectionRef: string;
  readonly presentationDigest: string;
  readonly page: SafePresentation['page'];
}

export interface SafePresentationV02RepositoryActionPrePlan extends SafePresentationV02Base {
  readonly subjectKind: 'repository-action';
  readonly planApplicability: 'pre-plan-diagnostic';
  readonly actionId: string;
  readonly actionDigest: string;
  readonly diagnosticPurpose: string;
  readonly taskCriteriaDigest: string;
}

export interface SafePresentationV02RepositoryActionApprovedPlan extends SafePresentationV02Base {
  readonly subjectKind: 'repository-action';
  readonly planApplicability: 'approved-plan';
  readonly actionId: string;
  readonly actionDigest: string;
  readonly planBindingDigest: string;
  readonly planDecisionRef: string;
}

export interface SafePresentationV02ProviderRequestPrePlan extends SafePresentationV02Base {
  readonly subjectKind: 'provider-request';
  readonly planApplicability: 'pre-plan-diagnostic';
  readonly providerRequestId: string;
  readonly requestContentDigest: string;
  readonly role: ProviderRole;
  readonly diagnosticPurpose: string;
  readonly taskCriteriaDigest: string;
}

export interface SafePresentationV02ProviderRequestApprovedPlan extends SafePresentationV02Base {
  readonly subjectKind: 'provider-request';
  readonly planApplicability: 'approved-plan';
  readonly providerRequestId: string;
  readonly requestContentDigest: string;
  readonly role: ProviderRole;
  readonly planBindingDigest: string;
  readonly planDecisionRef: string;
}

export type SafePresentationV02 =
  | SafePresentationV02RepositoryActionPrePlan
  | SafePresentationV02RepositoryActionApprovedPlan
  | SafePresentationV02ProviderRequestPrePlan
  | SafePresentationV02ProviderRequestApprovedPlan;

const SAFE_PRESENTATION_V02_BASE_KEYS = [
  'schemaVersion', 'decisionId', 'requestVersion', 'bindingFingerprint', 'elements', 'inspectionRef',
  'presentationDigest', 'page', 'subjectKind', 'planApplicability',
] as const;
const SAFE_PRESENTATION_V02_ELEMENT_KEYS = ['action', 'necessity', 'targets', 'consequences', 'verificationStatus'] as const;
const SAFE_PRESENTATION_V02_PAGE_KEYS = ['pageNumber', 'pageCount', 'pageBytes', 'totalBytes', 'truncated'] as const;
const UNSAFE_PRESENTATION_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export interface PresentationBundleV02 {
  readonly summary: SafePresentationV02;
  readonly pages: readonly string[];
}

export interface PresentationInputV02Base {
  readonly requestVersion: number;
  readonly decisionId: string;
  readonly repositoryId: string;
  readonly continuationRef: string;
  readonly policyIdentity: PolicyProfile['policyIdentity'];
  readonly elements: SafePresentation['elements'];
  readonly freshness?: ApprovalBindingContext;
}

export interface PresentationInputV02RepositoryActionPrePlan extends PresentationInputV02Base {
  readonly subjectKind: 'repository-action';
  readonly planApplicability: 'pre-plan-diagnostic';
  readonly action: NormalizedAction;
  readonly binding?: ApprovalBinding;
  readonly diagnosticPurpose: string;
  readonly taskCriteriaDigest: string;
}

export interface PresentationInputV02RepositoryActionApprovedPlan extends PresentationInputV02Base {
  readonly subjectKind: 'repository-action';
  readonly planApplicability: 'approved-plan';
  readonly action: NormalizedAction;
  readonly binding?: ApprovalBinding;
  readonly planBindingDigest: string;
  readonly planDecisionRef: string;
}

export interface PresentationInputV02ProviderRequestPrePlan extends PresentationInputV02Base {
  readonly subjectKind: 'provider-request';
  readonly planApplicability: 'pre-plan-diagnostic';
  readonly providerRequest: ProviderRequest;
  readonly diagnosticPurpose: string;
  readonly taskCriteriaDigest: string;
}

export interface PresentationInputV02ProviderRequestApprovedPlan extends PresentationInputV02Base {
  readonly subjectKind: 'provider-request';
  readonly planApplicability: 'approved-plan';
  readonly providerRequest: ProviderRequest;
  readonly planBindingDigest: string;
  readonly planDecisionRef: string;
}

export type PresentationInputV02 =
  | PresentationInputV02RepositoryActionPrePlan
  | PresentationInputV02RepositoryActionApprovedPlan
  | PresentationInputV02ProviderRequestPrePlan
  | PresentationInputV02ProviderRequestApprovedPlan;

export function validateSafePresentationV02(input: unknown, profile: unknown): ValidationResult<SafePresentationV02> {
  const path = 'safePresentationV02';
  const invalidInput = (): ValidationResult<SafePresentationV02> => ({
    ok: false,
    errors: [{ path, code: 'INVALID_OBJECT', message: 'expected bounded plain data' }],
  });
  try {
  if (!safeData(input) || !safeData(profile)) return invalidInput();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ path, code: 'INVALID_OBJECT', message: 'expected object' }] };
  }
  const serialized = JSON.stringify(input);
  const serializedProfile = JSON.stringify(profile);
  if (serialized === undefined || serializedProfile === undefined) return invalidInput();
  if (containsProtectedContent(serialized) || containsProtectedContent(serializedProfile)) {
    return { ok: false, errors: [{ path, code: 'PROTECTED_CONTENT', message: 'presentation contains protected content' }] };
  }
  const record = input as Record<string, unknown>;
  const errors: { path: string; code: string; message: string }[] = [];

  if (record['schemaVersion'] !== UC05_APPROVAL_SCHEMA_VERSION_V02) {
    errors.push({
      path: `${path}.schemaVersion`,
      code: 'INVALID_SCHEMA_VERSION',
      message: 'schemaVersion must match the supported version',
    });
  }

  for (const idField of ['decisionId', 'inspectionRef'] as const) {
    if (typeof record[idField] !== 'string' || !record[idField] || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/.test(record[idField] as string)) {
      errors.push({ path: `${path}.${idField}`, code: 'INVALID_ID', message: `${idField} must be a valid identifier` });
    }
  }
  if (!Number.isSafeInteger(record['requestVersion']) || (record['requestVersion'] as number) < 1) {
    errors.push({ path: `${path}.requestVersion`, code: 'INVALID_VERSION', message: 'requestVersion must be a positive integer' });
  }
  for (const digestField of ['bindingFingerprint', 'presentationDigest'] as const) {
    if (typeof record[digestField] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(record[digestField] as string)) {
      errors.push({ path: `${path}.${digestField}`, code: 'INVALID_DIGEST', message: `${digestField} must be a valid sha256 digest` });
    }
  }

  const subjectKind = record['subjectKind'];
  if (subjectKind !== 'repository-action' && subjectKind !== 'provider-request') {
    errors.push({ path: `${path}.subjectKind`, code: 'INVALID_SUBJECT_KIND', message: 'subjectKind must be repository-action or provider-request' });
  }

  const planApplicability = record['planApplicability'];
  if (planApplicability !== 'pre-plan-diagnostic' && planApplicability !== 'approved-plan') {
    errors.push({ path: `${path}.planApplicability`, code: 'INVALID_PLAN_APPLICABILITY', message: 'planApplicability must be pre-plan-diagnostic or approved-plan' });
  }

  const branchKeys = subjectKind === 'repository-action'
    ? planApplicability === 'pre-plan-diagnostic'
      ? ['actionId', 'actionDigest', 'diagnosticPurpose', 'taskCriteriaDigest']
      : ['actionId', 'actionDigest', 'planBindingDigest', 'planDecisionRef']
    : subjectKind === 'provider-request'
      ? planApplicability === 'pre-plan-diagnostic'
        ? ['providerRequestId', 'requestContentDigest', 'role', 'diagnosticPurpose', 'taskCriteriaDigest']
        : ['providerRequestId', 'requestContentDigest', 'role', 'planBindingDigest', 'planDecisionRef']
      : [];
  const allowedKeys = new Set<string>([...SAFE_PRESENTATION_V02_BASE_KEYS, ...branchKeys]);
  if (Object.keys(record).some(key => !allowedKeys.has(key))) {
    errors.push({ path, code: 'UNKNOWN_FIELD', message: 'presentation contains unknown fields' });
  }

  const repoForbiddenKeys = ['providerRequestId', 'requestContentDigest', 'role', 'providerRequest'];
  const provForbiddenKeys = ['actionId', 'actionDigest', 'action'];
  const prePlanForbiddenKeys = ['planBindingDigest', 'planDecisionRef'];
  const appPlanForbiddenKeys = ['diagnosticPurpose', 'taskCriteriaDigest'];

  if (subjectKind === 'repository-action') {
    for (const key of repoForbiddenKeys) {
      if (record[key] !== undefined) {
        errors.push({ path: `${path}.${key}`, code: 'CROSS_BRANCH_FIELDS_FORBIDDEN', message: `Field ${key} forbidden on repository-action` });
      }
    }
  } else if (subjectKind === 'provider-request') {
    for (const key of provForbiddenKeys) {
      if (record[key] !== undefined) {
        errors.push({ path: `${path}.${key}`, code: 'CROSS_BRANCH_FIELDS_FORBIDDEN', message: `Field ${key} forbidden on provider-request` });
      }
    }
  }

  if (planApplicability === 'pre-plan-diagnostic') {
    for (const key of prePlanForbiddenKeys) {
      if (record[key] !== undefined) {
        errors.push({ path: `${path}.${key}`, code: 'CROSS_BRANCH_FIELDS_FORBIDDEN', message: `Field ${key} forbidden on pre-plan-diagnostic` });
      }
    }
  } else if (planApplicability === 'approved-plan') {
    for (const key of appPlanForbiddenKeys) {
      if (record[key] !== undefined) {
        errors.push({ path: `${path}.${key}`, code: 'CROSS_BRANCH_FIELDS_FORBIDDEN', message: `Field ${key} forbidden on approved-plan` });
      }
    }
  }

  if (subjectKind === 'repository-action') {
    if (typeof record['actionId'] !== 'string' || !record['actionId']) {
      errors.push({ path: `${path}.actionId`, code: 'MISSING_REQUIRED_FIELD', message: 'actionId is required' });
    }
    if (typeof record['actionDigest'] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(record['actionDigest'])) {
      errors.push({ path: `${path}.actionDigest`, code: 'MISSING_REQUIRED_FIELD', message: 'actionDigest is required' });
    }
  } else if (subjectKind === 'provider-request') {
    if (typeof record['providerRequestId'] !== 'string' || !record['providerRequestId']) {
      errors.push({ path: `${path}.providerRequestId`, code: 'MISSING_REQUIRED_FIELD', message: 'providerRequestId is required' });
    }
    if (typeof record['requestContentDigest'] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(record['requestContentDigest'])) {
      errors.push({ path: `${path}.requestContentDigest`, code: 'MISSING_REQUIRED_FIELD', message: 'requestContentDigest is required' });
    }
    if (record['role'] !== 'coder' && record['role'] !== 'reviewer') {
      errors.push({ path: `${path}.role`, code: 'MISSING_REQUIRED_FIELD', message: 'role must be coder or reviewer' });
    }
  }

  if (planApplicability === 'pre-plan-diagnostic') {
    if (typeof record['diagnosticPurpose'] !== 'string' || !record['diagnosticPurpose']) {
      errors.push({ path: `${path}.diagnosticPurpose`, code: 'MISSING_REQUIRED_FIELD', message: 'diagnosticPurpose is required' });
    }
    if (typeof record['taskCriteriaDigest'] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(record['taskCriteriaDigest'])) {
      errors.push({ path: `${path}.taskCriteriaDigest`, code: 'MISSING_REQUIRED_FIELD', message: 'taskCriteriaDigest is required' });
    }
  } else if (planApplicability === 'approved-plan') {
    if (typeof record['planBindingDigest'] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(record['planBindingDigest'])) {
      errors.push({ path: `${path}.planBindingDigest`, code: 'MISSING_REQUIRED_FIELD', message: 'planBindingDigest is required' });
    }
    if (typeof record['planDecisionRef'] !== 'string' || !record['planDecisionRef']) {
      errors.push({ path: `${path}.planDecisionRef`, code: 'MISSING_REQUIRED_FIELD', message: 'planDecisionRef is required' });
    }
  }

  const profileResult = validatePolicyProfile(profile);
  if (!profileResult.ok) {
    errors.push({ path: 'profile', code: 'INVALID_PROFILE', message: 'presentation profile is invalid' });
  }
  const pageByteCap = profileResult.ok ? profileResult.value.maxPresentationPageBytes : 65536;
  const totalByteCap = profileResult.ok ? profileResult.value.maxPresentationTotalBytes : 262144;
  const pageCountCap = profileResult.ok ? profileResult.value.maxPresentationPages : 100;

  const elements = record['elements'];
  if (!elements || typeof elements !== 'object' || Array.isArray(elements)) {
    errors.push({ path: `${path}.elements`, code: 'INVALID_TYPE', message: 'all decision elements are required' });
  } else {
    const elemRec = elements as Record<string, unknown>;
    if (Object.keys(elemRec).some(key => !SAFE_PRESENTATION_V02_ELEMENT_KEYS.includes(key as typeof SAFE_PRESENTATION_V02_ELEMENT_KEYS[number]))) {
      errors.push({ path: `${path}.elements`, code: 'UNKNOWN_FIELD', message: 'decision elements contain unexpected fields' });
    }
    for (const field of ['action', 'necessity', 'consequences', 'verificationStatus'] as const) {
      if (typeof elemRec[field] !== 'string' || !elemRec[field]) {
        errors.push({ path: `${path}.elements.${field}`, code: 'INVALID_ELEMENT', message: `${field} is required` });
      }
    }
    const targets = elemRec['targets'];
    if (!Array.isArray(targets) || targets.length === 0 || targets.length > 128 || targets.some(t => typeof t !== 'string' || !t)) {
      errors.push({ path: `${path}.elements.targets`, code: 'INVALID_TARGETS', message: 'targets must be a nonempty array of strings' });
    }
  }

  const page = record['page'];
  if (!page || typeof page !== 'object' || Array.isArray(page)) {
    errors.push({ path: `${path}.page`, code: 'INVALID_TYPE', message: 'page metadata is required' });
  } else {
    const pRec = page as Record<string, unknown>;
    if (Object.keys(pRec).some(key => !SAFE_PRESENTATION_V02_PAGE_KEYS.includes(key as typeof SAFE_PRESENTATION_V02_PAGE_KEYS[number]))) {
      errors.push({ path: `${path}.page`, code: 'UNKNOWN_FIELD', message: 'page metadata contains unexpected fields' });
    }
    for (const field of ['pageNumber', 'pageCount', 'pageBytes', 'totalBytes'] as const) {
      if (!Number.isSafeInteger(pRec[field]) || (pRec[field] as number) < 0) {
        errors.push({ path: `${path}.page.${field}`, code: 'INVALID_PAGE_FIELD', message: `${field} must be a non-negative integer` });
      }
    }
    if (typeof pRec['truncated'] !== 'boolean') {
      errors.push({ path: `${path}.page.truncated`, code: 'INVALID_TYPE', message: 'truncated must be boolean' });
    }
    if (typeof pRec['pageCount'] === 'number' && pRec['pageCount'] > pageCountCap) {
      errors.push({ path: `${path}.page.pageCount`, code: 'PAGE_COUNT_EXCEEDED', message: 'page count exceeds profile bound' });
    }
    if (typeof pRec['pageNumber'] === 'number' && typeof pRec['pageCount'] === 'number' &&
      (pRec['pageNumber'] < 1 || pRec['pageCount'] < 1 || pRec['pageNumber'] > pRec['pageCount'])) {
      errors.push({ path: `${path}.page.pageNumber`, code: 'INVALID_PAGE_FIELD', message: 'page number must fall within the page count' });
    }
    if (typeof pRec['pageBytes'] === 'number' && pRec['pageBytes'] > pageByteCap) {
      errors.push({ path: `${path}.page.pageBytes`, code: 'PAGE_SIZE_EXCEEDED', message: 'page bytes exceed profile bound' });
    }
    if (typeof pRec['totalBytes'] === 'number' && pRec['totalBytes'] > totalByteCap) {
      errors.push({ path: `${path}.page.totalBytes`, code: 'PRESENTATION_SIZE_EXCEEDED', message: 'total bytes exceed profile bound' });
    }
    if (typeof pRec['pageBytes'] === 'number' && typeof pRec['totalBytes'] === 'number' && pRec['totalBytes'] < pRec['pageBytes']) {
      errors.push({ path: `${path}.page.totalBytes`, code: 'INVALID_PAGE_FIELD', message: 'total bytes must cover the largest page' });
    }
  }

  const serializedBytes = Buffer.byteLength(serialized);
  const pageBytes = record['page'] && typeof record['page'] === 'object' && !Array.isArray(record['page'])
    ? (record['page'] as Record<string, unknown>)['pageBytes'] : undefined;
  const elementBytes = elements && typeof elements === 'object' && !Array.isArray(elements)
    ? Buffer.byteLength(JSON.stringify(elements)) : undefined;
  if (serializedBytes > pageByteCap || serializedBytes > totalByteCap) {
    errors.push({ path, code: 'PRESENTATION_SIZE_EXCEEDED', message: 'serialized presentation exceeds profile bounds' });
  }
  if (typeof pageBytes === 'number' && typeof elementBytes === 'number' && pageBytes < elementBytes) {
    errors.push({ path: `${path}.page.pageBytes`, code: 'PAGE_SIZE_EXCEEDED', message: 'page bytes do not cover serialized decision elements' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: record as unknown as SafePresentationV02 };
  } catch {
    return invalidInput();
  }
}

export function isBoundedSafeDataV02(input: unknown): boolean {
  return safeData(input);
}


/** Only bounded plain data is inspected; accessors, cycles and terminal format controls are refused. */
function safeData(value: unknown, depth = 0, budget = { nodes: 0, bytes: 0 }): boolean {
  if (depth > 12 || ++budget.nodes > 4096) return false;
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value);
    return value.length <= 65536 && budget.bytes <= 1_048_576 && !UNSAFE_PRESENTATION_TEXT.test(value);
  }
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 1024) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value) && (keys.length !== value.length + 1 || !Array.from({ length: value.length }, (_, index) => String(index)).every(key => Object.hasOwn(descriptors, key)))) return false;
  return keys.every(key => {
    if (Array.isArray(value) && key === 'length') return true;
    if (typeof key !== 'string') return false;
    if (key.length > 65536 || UNSAFE_PRESENTATION_TEXT.test(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') return false;
    budget.bytes += Buffer.byteLength(key);
    const descriptor = typeof key === 'string' ? descriptors[key] : undefined;
    return budget.bytes <= 1_048_576 && descriptor !== undefined && descriptor.enumerable && 'value' in descriptor && safeData(descriptor.value, depth + 1, budget);
  });
}
