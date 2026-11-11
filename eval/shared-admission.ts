import { sha256Text } from '../src/uc01/contracts.ts';

import type { RealExecutionAdmission, RealExecutionBinding } from './shared-types.ts';
import { array, object, sha, text } from './shared-validation.ts';

/** Receipt identity is object identity: a spread copy or a caller-built shape is never present here. */
const realAdmissions = new WeakSet<RealExecutionAdmission>();
const issuedAdmissionIds = new Set<string>();

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
    profileDigest: sha(input.profileDigest),
    configDigest: sha(input.configDigest),
    pricingDigest: sha(input.pricingDigest),
    adapterVersions: array(input.adapterVersions).map(text),
    caseIds: array(input.caseIds).map(text),
    requestedModel: text(input.requestedModel),
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
