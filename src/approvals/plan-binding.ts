import type { ApprovalBindingContext } from '../contracts/foundation/uc03.ts';
import { computeCanonicalSha256, parseApprovalBinding, validateApprovalBinding } from '../contracts/foundation/uc03.ts';
import { isProxy } from 'node:util/types';

export interface BindingEvaluation {
  readonly status: 'valid' | 'stale' | 'denied';
  readonly reasonCodes: readonly string[];
}

export interface PlanBindingDigestInput {
  readonly taskId: string;
  readonly planVersion: number;
  readonly strategyDigest: string;
  readonly baselineRef: string;
  readonly evidenceRefs: readonly string[];
  readonly criteriaDigest: string;
  readonly checkSetDigest: string;
  readonly decisionRef: string;
}

const PLAN_DIGEST_KEYS = [
  'taskId', 'planVersion', 'strategyDigest', 'baselineRef', 'evidenceRefs', 'criteriaDigest', 'checkSetDigest', 'decisionRef',
] as const;

const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

export function computePlanBindingDigest(input: unknown): string {
  if (!plainData(input) || typeof input !== 'object' || input === null || Array.isArray(input) ||
    Object.keys(input).length !== PLAN_DIGEST_KEYS.length || PLAN_DIGEST_KEYS.some(key => !Object.hasOwn(input, key))) {
    throw new Error('computePlanBindingDigest requires a plain object');
  }
  const record = input as Record<string, unknown>;
  if (
    !validId(record['taskId']) || !Number.isSafeInteger(record['planVersion']) || Number(record['planVersion']) < 1 ||
    !isSha(record['strategyDigest']) || !validId(record['baselineRef']) ||
    !Array.isArray(record['evidenceRefs']) || record['evidenceRefs'].length === 0 || record['evidenceRefs'].length > 128 ||
    !record['evidenceRefs'].every(validId) || new Set(record['evidenceRefs']).size !== record['evidenceRefs'].length ||
    !isSha(record['criteriaDigest']) || !isSha(record['checkSetDigest']) || !validId(record['decisionRef'])
  ) {
    throw new Error('computePlanBindingDigest missing required fields');
  }
  return computeCanonicalSha256({
    taskId: record['taskId'],
    planVersion: record['planVersion'],
    strategyDigest: record['strategyDigest'],
    baselineRef: record['baselineRef'],
    evidenceRefs: record['evidenceRefs'],
    criteriaDigest: record['criteriaDigest'],
    checkSetDigest: record['checkSetDigest'],
    decisionRef: record['decisionRef'],
  });
}

export interface PlanApplicabilityInputV02 {
  readonly planApplicability: 'pre-plan-diagnostic' | 'approved-plan';
  readonly taskNode?: string;
  readonly planBindingDigest?: string;
  readonly planDecisionRef?: string;
  readonly diagnosticPurpose?: string;
  readonly taskCriteriaDigest?: string;
  readonly checkSetDigest?: string;
  readonly testPath?: string;
  readonly checkId?: string;
  readonly planBinding?: unknown;
}

export interface PlanApplicabilityEvaluationV02 {
  readonly status: 'valid' | 'stale' | 'denied';
  readonly planApplicability: 'pre-plan-diagnostic' | 'approved-plan';
  readonly reasonCodes: readonly string[];
}

const isSha = (v: unknown): v is string => typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v);
const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);

/** Evaluates v0.2 plan applicability: pre-plan diagnostic vs approved plan. */
export function evaluatePlanApplicabilityV02(input: unknown): PlanApplicabilityEvaluationV02 {
  if (!plainData(input) || typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { status: 'denied', planApplicability: 'pre-plan-diagnostic', reasonCodes: ['invalid-applicability-input'] };
  }
  const record = input as Record<string, unknown>;
  const app = record['planApplicability'];
  if (app !== 'pre-plan-diagnostic' && app !== 'approved-plan') {
    return { status: 'denied', planApplicability: 'pre-plan-diagnostic', reasonCodes: ['invalid-plan-applicability'] };
  }

  if (app === 'pre-plan-diagnostic') {
    const fields = ['planApplicability', 'taskNode', 'diagnosticPurpose', 'taskCriteriaDigest', 'checkSetDigest', 'testPath', 'checkId'];
    if (Object.keys(record).length !== fields.length || fields.some(key => !Object.hasOwn(record, key))) return { status: 'denied', planApplicability: app, reasonCodes: ['invalid-pre-plan-fields'] };
    if (record['taskNode'] !== 'Investigate') return { status: 'denied', planApplicability: app, reasonCodes: ['pre-plan-requires-investigate'] };
    if (typeof record['diagnosticPurpose'] !== 'string' || record['diagnosticPurpose'].trim().length === 0 || Buffer.byteLength(record['diagnosticPurpose'], 'utf8') > 512) {
      return { status: 'denied', planApplicability: app, reasonCodes: ['invalid-diagnostic-purpose'] };
    }
    if (!isSha(record['taskCriteriaDigest']) || !isSha(record['checkSetDigest'])) return { status: 'denied', planApplicability: app, reasonCodes: ['invalid-task-criteria-or-check-set-digest'] };
    if (typeof record['testPath'] !== 'string' || !record['testPath'].startsWith('tests/') || record['testPath'].split('/').some((part, index, parts) => part === '.' || part === '..' || part === '' && index !== parts.length - 1) || record['testPath'].includes('\\')) {
      return { status: 'denied', planApplicability: app, reasonCodes: ['invalid-diagnostic-test-path'] };
    }
    if (!validId(record['checkId'])) return { status: 'denied', planApplicability: app, reasonCodes: ['invalid-diagnostic-check-id'] };
    return { status: 'valid', planApplicability: 'pre-plan-diagnostic', reasonCodes: [] };
  }

  // approved-plan
  const fields = ['planApplicability', 'planBindingDigest', 'planDecisionRef', 'planBinding'];
  if (Object.keys(record).length !== fields.length || fields.some(key => !Object.hasOwn(record, key))) return { status: 'denied', planApplicability: app, reasonCodes: ['invalid-approved-plan-fields'] };
  const planBindingDigest = record['planBindingDigest'];
  const planDecisionRef = record['planDecisionRef'];
  if (!isSha(planBindingDigest) || !isId(planDecisionRef)) {
    return { status: 'denied', planApplicability: 'approved-plan', reasonCodes: ['missing-or-invalid-plan-binding-fields'] };
  }
  try {
    if (!plainData(record['planBinding']) || typeof record['planBinding'] !== 'object' || record['planBinding'] === null || Array.isArray(record['planBinding'])) {
      return { status: 'denied', planApplicability: 'approved-plan', reasonCodes: ['invalid-plan-binding'] };
    }
    const planBinding = record['planBinding'] as Record<string, unknown>;
    if (planBinding['decisionRef'] !== planDecisionRef || computePlanBindingDigest(planBinding) !== planBindingDigest) {
      return { status: 'denied', planApplicability: 'approved-plan', reasonCodes: ['plan-binding-digest-or-reference-mismatch'] };
    }
  } catch {
    return { status: 'denied', planApplicability: 'approved-plan', reasonCodes: ['invalid-plan-binding'] };
  }
  return { status: 'valid', planApplicability: 'approved-plan', reasonCodes: [] };
}

// Key vocabulary stays exhaustive against the canonical type; admission owns value semantics.
const contextFields: Readonly<Record<keyof ApprovalBindingContext, true>> = {
  currentTaskId: true, currentWorkspaceId: true, currentRepositoryRevisionDigest: true,
  currentPolicyId: true, currentPolicyVersion: true, currentNormalizedActionDigest: true,
  currentPlanVersion: true, currentStrategyDigest: true, currentBaselineRef: true,
  currentEvidenceRefs: true, currentCriteriaDigest: true, currentCheckSetDigest: true,
};

/** Evaluates freshness only; a valid pending/rejected binding is never consent. */
export function evaluatePlanBinding(binding: unknown, context: unknown): BindingEvaluation {
  if (!plainData(binding) || !plainData(context) || !context || typeof context !== 'object' || Array.isArray(context)) return { status: 'denied', reasonCodes: ['invalid-binding-context'] };
  if (Object.keys(context).some(key => !Object.hasOwn(contextFields, key))) return { status: 'denied', reasonCodes: ['unknown-binding-context-field'] };
  const parsed = parseApprovalBinding(binding);
  if (!parsed.ok) return { status: 'denied', reasonCodes: ['invalid-binding'] };
  // Descriptor inspection admits only data; canonical admission owns the field semantics.
  let checked: ReturnType<typeof validateApprovalBinding>;
  try { checked = validateApprovalBinding({ ...parsed.value, status: 'approved' }, context as ApprovalBindingContext); }
  catch { return { status: 'denied', reasonCodes: ['invalid-binding-context'] }; }
  if (checked.ok) return { status: 'valid', reasonCodes: [] };
  if (checked.errors.some(error => error.code !== 'STALE_APPROVAL_BINDING')) return { status: 'denied', reasonCodes: ['incomplete-binding-context'] };
  return { status: 'stale', reasonCodes: [...new Set(checked.errors.map(error => `changed-${error.path}`))] };
}

function plainData(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || value === undefined || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 65536;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 1024) return false;
  if (Array.isArray(value) && (keys.length !== value.length + 1 || !Array.from({ length: value.length }, (_, index) => String(index)).every(key => Object.hasOwn(descriptors, key)))) return false;
  return keys.every(key => {
    if (Array.isArray(value) && key === 'length') return true;
    const descriptor = typeof key === 'string' ? descriptors[key] : undefined;
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor && plainData(descriptor.value, depth + 1);
  });
}
