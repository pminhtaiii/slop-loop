import { isProxy } from 'node:util/types';
import type { ApprovalBindingContext } from '../contracts/foundation/uc03.ts';
import type { PresentationInput } from './presentation.ts';

export function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/.test(value); }

export function directionInput(value: unknown): value is { readonly taskId: string; readonly taskVersion: number; readonly direction: 'resume' | 'revise' | 'end'; readonly responseKey: string } {
  if (!plainContextData(value) || !dataRecord(value) || !exactFields(value, ['taskId', 'taskVersion', 'direction', 'responseKey'])) return false;
  return identifier(value['taskId']) && identifier(value['responseKey']) && typeof value['taskVersion'] === 'number' && Number.isSafeInteger(value['taskVersion']) && value['taskVersion'] > 0 && ['resume', 'revise', 'end'].includes(String(value['direction']));
}

/** Inspect descriptors recursively before validators or property reads can invoke input getters. */
export function plainContextData(value: unknown, depth = 0): boolean {
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
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor && plainContextData(descriptor.value, depth + 1);
  });
}

export function dataRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean { return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)); }

export function freshnessContext(value: unknown): value is ApprovalBindingContext {
  if (!dataRecord(value)) return false;
  const ids = ['currentTaskId', 'currentWorkspaceId', 'currentPolicyId', 'currentPolicyVersion'];
  const digests = ['currentRepositoryRevisionDigest', 'currentNormalizedActionDigest'];
  const planDigests = ['currentStrategyDigest', 'currentCriteriaDigest', 'currentCheckSetDigest'];
  const optional = [...planDigests, 'currentPlanVersion', 'currentBaselineRef', 'currentEvidenceRefs'];
  const sha = (digest: unknown): boolean => typeof digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(digest);
  return Object.keys(value).every(key => [...ids, ...digests, ...optional].includes(key)) &&
    ids.every(key => identifier(value[key])) && digests.every(key => sha(value[key])) &&
    planDigests.every(key => !Object.hasOwn(value, key) || sha(value[key])) &&
    (!Object.hasOwn(value, 'currentBaselineRef') || identifier(value['currentBaselineRef'])) &&
    (!Object.hasOwn(value, 'currentPlanVersion') || typeof value['currentPlanVersion'] === 'number' && Number.isSafeInteger(value['currentPlanVersion']) && value['currentPlanVersion'] > 0) &&
    (!Object.hasOwn(value, 'currentEvidenceRefs') || Array.isArray(value['currentEvidenceRefs']) && value['currentEvidenceRefs'].length > 0 && value['currentEvidenceRefs'].every(identifier));
}

export function decisionElements(value: unknown): value is PresentationInput['elements'] {
  if (!dataRecord(value) || !exactFields(value, ['action', 'necessity', 'targets', 'consequences', 'verificationStatus'])) return false;
  const text = (field: unknown): boolean => typeof field === 'string' && field.trim().length > 0;
  return ['action', 'necessity', 'consequences', 'verificationStatus'].every(key => text(value[key])) &&
    Array.isArray(value['targets']) && value['targets'].length > 0 && value['targets'].length <= 32 && value['targets'].every(text);
}

interface DecisionInput {
  readonly taskId: string; readonly decisionId: string; readonly taskVersion: number; readonly requestVersion: number;
  readonly presentationDigest: string; readonly decision: 'approve' | 'reject'; readonly responseKey: string;
}
export function decisionInput(value: unknown): value is DecisionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = ['taskId', 'decisionId', 'taskVersion', 'requestVersion', 'presentationDigest', 'decision', 'responseKey'];
  if (Reflect.ownKeys(value).length !== keys.length || !keys.every(key => descriptors[key]?.enumerable && 'value' in descriptors[key])) return false;
  const candidate = value as Record<string, unknown>;
  return identifier(candidate['taskId']) && identifier(candidate['decisionId']) && identifier(candidate['responseKey']) &&
    [candidate['taskVersion'], candidate['requestVersion']].every(number => typeof number === 'number' && Number.isSafeInteger(number) && number > 0) &&
    typeof candidate['presentationDigest'] === 'string' && /^sha256:[0-9a-f]{64}$/.test(candidate['presentationDigest']) &&
    (candidate['decision'] === 'approve' || candidate['decision'] === 'reject');
}
