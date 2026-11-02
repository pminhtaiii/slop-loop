import { sha256Text, type Validation } from '../uc01/contracts.ts';
import {
  assertNoSecret,
  catalogDigestOf,
  catalogOf,
  collect,
  CREDENTIAL_REFERENCE,
  deny,
  digestValue,
  endpointOf,
  IMAGE_DIGEST,
  keysOf,
  limitsOf,
  pricingOf,
  PROFILE_KEYS,
  text,
} from './evaluation-profile-primitives.ts';
import type { EvaluationProfile } from './evaluation-profile-types.ts';

const admitted = new WeakSet<EvaluationProfile>();

function checkProfile(value: unknown): EvaluationProfile {
  assertNoSecret(value, '$');
  const record = keysOf(value, PROFILE_KEYS, '$');
  const endpoint = endpointOf(record.endpoint, '$.endpoint');
  const model = text(record.model, '$.model', 128);
  if (record.mode !== 'nonstreaming') deny('INVALID_MODE', '$.mode');
  if (typeof record.credentialRef !== 'string' || !CREDENTIAL_REFERENCE.test(record.credentialRef)) {
    deny('INVALID_CREDENTIAL_REF', '$.credentialRef');
  }
  const codeDigest = digestValue(record.codeDigest, '$.codeDigest');
  const configDigest = digestValue(record.configDigest, '$.configDigest');
  const imageDigest = typeof record.imageDigest === 'string' && IMAGE_DIGEST.test(record.imageDigest) ? record.imageDigest : deny('INVALID_IMAGE_DIGEST', '$.imageDigest');
  const platform = text(record.platform, '$.platform', 128);
  if (!Array.isArray(record.adapterVersions) || !record.adapterVersions.length || record.adapterVersions.length > 16) {
    deny('INVALID_ADAPTERS', '$.adapterVersions');
  }
  const adapterVersions: readonly string[] = Object.freeze(record.adapterVersions.map((item, index) => text(item, `$.adapterVersions[${index}]`, 128)));
  const pricing = pricingOf(record.pricing, '$.pricing');
  const limits = limitsOf(record.limits, '$.limits');
  const catalog = catalogOf(record.catalog, '$.catalog');
  const pricingDigest = sha256Text(JSON.stringify(pricing));
  const catalogDigest = catalogDigestOf(catalog);
  const caseDigests: readonly string[] = Object.freeze(catalog.map(entry => entry.caseDigest));
  const graderDigests: readonly string[] = Object.freeze(catalog.map(entry => entry.grader.digest));
  // credentialRef is deliberately absent: credentials are host-only and never part of an identity.
  const identity = {
    contract: 'runtime-evaluation/1',
    endpoint,
    model,
    mode: 'nonstreaming',
    codeDigest,
    configDigest,
    pricingDigest,
    imageDigest,
    platform,
    adapterVersions,
    catalogDigest,
    caseDigests,
    graderDigests,
    limits,
    spendPolicy: 'derived-exposure',
  };
  return Object.freeze({
    profileId: 'uc03-runtime-evaluation-v1',
    profileDigest: sha256Text(JSON.stringify(identity)),
    endpoint,
    model,
    mode: 'nonstreaming',
    credentialRef: record.credentialRef,
    codeDigest,
    configDigest,
    pricing,
    pricingDigest,
    imageDigest,
    platform,
    adapterVersions,
    catalogDigest,
    caseDigests,
    graderDigests,
    limits,
    spendPolicy: 'derived-exposure',
  });
}

/** Validates, freezes and registers a profile; downstream authority requires the registered instance. */
export function admitEvaluationProfile(value: unknown): Validation<EvaluationProfile> {
  return collect(() => {
    const profile = checkProfile(value);
    admitted.add(profile);
    return profile;
  });
}

export function isAdmittedEvaluationProfile(value: unknown): value is EvaluationProfile {
  return typeof value === 'object' && value !== null && admitted.has(value as EvaluationProfile);
}
