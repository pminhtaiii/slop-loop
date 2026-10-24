import type { ApprovalBinding, ApprovalBindingContext, NormalizedAction } from '../contracts/foundation/uc03.ts';
import { isProxy } from 'node:util/types';
import type { PolicyProfile, SafePresentation } from '../contracts/approvals/contracts.ts';
import { computeActionDigest, computeCanonicalSha256, validateApprovalBinding, validateNormalizedAction } from '../contracts/foundation/uc03.ts';
import { validatePolicyProfile, validateSafePresentation } from '../contracts/approvals/contracts.ts';
import { containsProtectedContent } from '../foundation/repository-tools.ts';

export interface PresentationInput {
  readonly requestVersion: number;
  readonly binding: ApprovalBinding;
  readonly freshness: ApprovalBindingContext;
  readonly action: NormalizedAction;
  readonly repositoryId: string;
  readonly continuationRef: string;
  readonly policyIdentity: PolicyProfile['policyIdentity'];
  readonly elements: SafePresentation['elements'];
}
export interface PresentationBundle {
  readonly summary: SafePresentation;
  readonly pages: readonly string[];
}
export function buildPresentation(input: PresentationInput, profile: PolicyProfile): PresentationBundle {
  try { return admittedPresentation(input, profile); }
  catch { throw new Error('unsafe-presentation'); }
}

function admittedPresentation(input: PresentationInput, profile: PolicyProfile): PresentationBundle {
  if (!safeData(input) || !Number.isSafeInteger(input.requestVersion) || input.requestVersion < 1) throw new Error('unsafe-presentation');
  if (!validatePolicyProfile(profile).ok || !validateNormalizedAction(input.action).ok ||
    !validateApprovalBinding({ ...input.binding, status: 'approved' }, input.freshness).ok ||
    computeActionDigest(input.action) !== input.binding.normalizedActionDigest) throw new Error('unsafe-presentation');
  const details = JSON.stringify(input.action);
  const content = JSON.stringify(input);
  if (containsProtectedContent(content)) throw new Error('unsafe-presentation');
  const elementBytes = Buffer.byteLength(JSON.stringify(input.elements));
  const totalBytes = Buffer.byteLength(details) + elementBytes;
  if (totalBytes > profile.maxPresentationTotalBytes) throw new Error('unsafe-presentation');
  const pages: string[] = [];
  let page = '';
  for (const point of details) {
    if (Buffer.byteLength(page + point) > profile.maxPresentationPageBytes) { pages.push(page); page = ''; }
    if (Buffer.byteLength(point) > profile.maxPresentationPageBytes) throw new Error('unsafe-presentation');
    page += point;
  }
  if (page) pages.push(page);
  if (pages.length > profile.maxPresentationPages) throw new Error('unsafe-presentation');
  const bindingFingerprint = computeCanonicalSha256({ binding: input.binding, freshness: input.freshness, repositoryId: input.repositoryId, continuationRef: input.continuationRef, policyIdentity: input.policyIdentity, requestVersion: input.requestVersion });
  const summary: SafePresentation = {
    schemaVersion: 'uc05-approval/0.1-draft', decisionId: input.binding.decisionId, requestVersion: input.requestVersion,
    bindingFingerprint, elements: structuredClone(input.elements), inspectionRef: input.binding.decisionId,
    presentationDigest: computeCanonicalSha256({ bindingFingerprint, elements: input.elements, details }),
    page: { pageNumber: 1, pageCount: pages.length, pageBytes: Math.max(elementBytes, Buffer.byteLength(pages[0] ?? '')), totalBytes, truncated: false },
  };
  if (!validateSafePresentation(summary, profile).ok || Buffer.byteLength(JSON.stringify(summary)) > profile.maxPresentationPageBytes) throw new Error('unsafe-presentation');
  return { summary, pages };
}

/** Only bounded plain data is inspected; accessors, cycles and terminal format controls are refused. */
function safeData(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (typeof value === 'string') return value.length <= 65536 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value);
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
    const descriptor = typeof key === 'string' ? descriptors[key] : undefined;
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor && safeData(descriptor.value, depth + 1);
  });
}
