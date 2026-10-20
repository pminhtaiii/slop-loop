import type { ApprovalBindingContext } from '../contracts/foundation/uc03.ts';
import { parseApprovalBinding, validateApprovalBinding } from '../contracts/foundation/uc03.ts';
import { isProxy } from 'node:util/types';

export interface BindingEvaluation {
  readonly status: 'valid' | 'stale' | 'denied';
  readonly reasonCodes: readonly string[];
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
  if (value === null || typeof value === 'boolean') return true;
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
