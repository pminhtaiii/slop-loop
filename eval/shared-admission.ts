import { isProtectedPayload } from '../src/foundation/telemetry.ts';
import { sha256Text } from '../src/uc01/contracts.ts';

import type { RealExecutionAdmission, RealExecutionBinding } from './shared-types.ts';
import { array, fail, object, text } from './shared-validation.ts';

/** Receipt identity is object identity: a spread copy or a caller-built shape is never present here. */
const realAdmissions = new WeakSet<RealExecutionAdmission>();
const issuedAdmissionIds = new Set<string>();

function bindingDigestValue(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(value)) fail();
  return value;
}

function bindingModelValue(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,191}$/u.test(value) || value.includes('..') || isProtectedPayload(value)) fail();
  return value;
}

function digestOf(binding: RealExecutionBinding): string {
  return sha256Text(JSON.stringify([binding.profileDigest, binding.configDigest, binding.pricingDigest, binding.adapterVersions, binding.caseIds, binding.requestedModel]));
}
/**
 * Issues the only capability that can admit a real tier. Validates the binding, freezes a fresh receipt and
 * registers that exact object; the caller receives no authority over any other binding.
 */
export function issueRealExecutionAdmission(value: unknown): RealExecutionAdmission {
  const input = object(value, ['profileDigest', 'configDigest', 'pricingDigest', 'adapterVersions', 'caseIds', 'requestedModel']);
  const binding: RealExecutionBinding = {
    profileDigest: bindingDigestValue(input.profileDigest),
    configDigest: bindingDigestValue(input.configDigest),
    pricingDigest: bindingDigestValue(input.pricingDigest),
    adapterVersions: array(input.adapterVersions).map(text),
    caseIds: array(input.caseIds).map(text),
    requestedModel: bindingModelValue(input.requestedModel),
  };
  const bindingDigest = digestOf(binding);
  const admissionId = sha256Text(`real-admission\u0000${bindingDigest}\u0000${issuedAdmissionIds.size}`);
  const receipt = Object.freeze({ admissionId, profileDigest: binding.profileDigest, bindingDigest });
  realAdmissions.add(receipt);
  issuedAdmissionIds.add(admissionId);
  return receipt;
}
/** True only for the issued object bound to exactly this request; a copy, forged value or other binding is denied. */
export function isAdmittedRealExecutionAdmission(value: unknown, binding: RealExecutionBinding): boolean {
  return typeof value === 'object' && value !== null && realAdmissions.has(value as RealExecutionAdmission) && (value as RealExecutionAdmission).bindingDigest === digestOf(binding);
}
