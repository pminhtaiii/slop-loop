/**
 * Real-tier console profile/catalog admission and shared host-template digest computation
 * (Feature 007 T017, ticket #270).
 *
 * Derives a frozen `EvaluationProfile` and `CatalogEntry[]` from a loaded `RealTierProfile` and its
 * real-tier catalog, checks `host.json` using `realTierHostDigestsOf`, enforces
 * `allowInsecureHttp` acknowledgement and fixture/grader file digests, and issues host-only WeakSet
 * receipts for `createEvaluationConsoleHost`.
 */
import { createHmac } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isModelId } from '../contracts/approvals/v01/validation.ts';
import { pinnedEndpointUrl } from '../foundation/deepseek-transport-request.ts';
import { sha256Text, type Validation } from '../uc01/contracts.ts';
import type { EvaluationConsoleConfiguration } from './evaluation-console-host.ts';
import {
  assertNoSecret,
  catalogDigestOf,
  collect,
  deny,
  DIGEST,
  digestValue,
  IMAGE_DIGEST,
  keysOf,
  limitsOf,
  plain,
  positiveInteger,
  present,
  pricingOf,
  text,
} from './evaluation-profile-primitives.ts';
import type { CatalogEntry, EvaluationLimits, EvaluationPricing, EvaluationProfile } from './evaluation-profile-types.ts';
import { DEFAULT_REAL_TIER_ENDPOINT, PROFILE_SCHEMA, type RealTierImage, type RealTierProfile, type RealTierRunLimits } from './real-tier-profile.ts';

export const REAL_TIER_PROFILE_ID = 'uc03-runtime-evaluation-v1' as const;
export const REAL_TIER_ADAPTER_VERSIONS: readonly string[] = Object.freeze(['uc03-real-tier/1']);

export type RealTierHostDigests = Readonly<{
  profileId: typeof REAL_TIER_PROFILE_ID;
  profileDigest: string;
  configDigest: string;
  pricingDigest: string;
  requestedModel: string;
  adapterVersions: readonly string[];
}>;

export type RealTierConsoleAdmissionInput = Readonly<{
  profile: RealTierProfile;
  configuration: EvaluationConsoleConfiguration;
}>;

export type RealTierConsoleAdmission = RealTierHostDigests &
  Readonly<{
    catalogDigest: string;
    profile: EvaluationProfile;
    catalog: readonly CatalogEntry[];
  }>;

const DEFAULT_HREF = new URL(DEFAULT_REAL_TIER_ENDPOINT).href;
const PINNED_BASE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u;
const SHA256_OPT = /^(?:sha256:)?([a-f0-9]{64})$/u;
const SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

const PROFILE_KEYS = ['profileDigest', 'schema', 'campaignId', 'stateRoot', 'endpoint', 'transport', 'pricing', 'runLimits', 'limits', 'image', 'catalog', 'artifacts', 'approvalPolicy'] as const;
const ENDPOINT_KEYS = ['endpointDigest', 'scheme', 'insecureHttpAcknowledged', 'model'] as const;
const RUN_LIMIT_KEYS = ['perRunInputTokens', 'perRunOutputTokens'] as const;
const IMAGE_KEYS = ['label', 'imageId', 'base', 'platform', 'user'] as const;
const CATALOG_ENTRY_KEYS = ['caseId', 'fixturePath', 'fixtureDigest', 'initialRepositoryDigest', 'criteria', 'grader'] as const;
const REQUIRED_ENTRY_KEYS = ['caseId', 'fixturePath', 'fixtureDigest', 'initialRepositoryDigest', 'grader'] as const;

const admittedReceipts = new WeakSet<RealTierConsoleAdmission>();
const admittedProfiles = new WeakSet<EvaluationProfile>();

/**
 * Computes the `sha256:`-prefixed host.json identity fields from a validated `RealTierProfile`.
 * Shared identically by `--print-host-template` and real-tier console admission.
 */
export function realTierHostDigestsOf(profile: RealTierProfile): RealTierHostDigests {
  return Object.freeze({
    profileId: REAL_TIER_PROFILE_ID,
    profileDigest: `sha256:${profile.profileDigest}`,
    // The configuration identity covers the numeric limits and the run limits; the endpoint stays in profileDigest.
    configDigest: `sha256:${sha256Text(JSON.stringify({ limits: profile.limits, runLimits: profile.runLimits }))}`,
    pricingDigest: `sha256:${sha256Text(JSON.stringify(profile.pricing))}`,
    requestedModel: profile.endpoint.model,
    adapterVersions: REAL_TIER_ADAPTER_VERSIONS,
  });
}

function absPath(value: unknown, path: string): string {
  const candidate = text(value, path, 1024);
  return isAbsolute(candidate) ? candidate : deny('INVALID_PATH', path);
}

function bareSha256(value: unknown, path: string): string {
  const match = typeof value === 'string' ? SHA256_OPT.exec(value) : null;
  return match?.[1] ?? deny('INVALID_DIGEST', path);
}

function readUtf8(filePath: string, missingCode: string, unreadableCode: string, path: string): string {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath, { throwIfNoEntry: false });
    if (stat !== undefined && stat.isFile()) return readFileSync(filePath, 'utf8');
  } catch {
    deny(unreadableCode, path);
  }
  if (stat === undefined) deny(missingCode, path);
  deny(unreadableCode, path);
}

function parseJson(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    deny('INVALID_CATALOG', path);
  }
}

interface VerifiedRealProfile {
  readonly profileDigest: string;
  readonly endpointUrl: URL;
  readonly pricing: EvaluationPricing;
  readonly limits: EvaluationLimits;
  readonly image: RealTierImage;
  readonly catalogPath: string;
}

function verifyRealTierProfile(value: unknown): VerifiedRealProfile {
  const p = '$.profile';
  const rec = keysOf(value, PROFILE_KEYS, p);
  if (rec.schema !== PROFILE_SCHEMA) deny('INVALID_SCHEMA', `${p}.schema`);

  const ep = keysOf(rec.endpoint, ENDPOINT_KEYS, `${p}.endpoint`);
  const scheme = ep.scheme;
  if (scheme !== 'https' && scheme !== 'http') deny('INVALID_ENDPOINT', `${p}.endpoint.scheme`);
  if (typeof ep.insecureHttpAcknowledged !== 'boolean') deny('INVALID_ENDPOINT', `${p}.endpoint.insecureHttpAcknowledged`);

  const acknowledged = scheme === 'http' && ep.insecureHttpAcknowledged === true && rec.transport === 'insecure-http-acknowledged';
  if (scheme === 'http' && !acknowledged) deny('INSECURE_ENDPOINT_UNACKNOWLEDGED', `${p}.endpoint`);
  if (scheme === 'https' && (ep.insecureHttpAcknowledged !== false || rec.transport !== 'https')) deny('INVALID_ENDPOINT', `${p}.endpoint`);

  const href = Reflect.get(ep, 'href');
  if (typeof href !== 'string' || !href.trim() || Buffer.byteLength(href) > 2048) deny('INVALID_ENDPOINT', `${p}.endpoint`);
  const url = pinnedEndpointUrl(href, acknowledged);
  if (url === undefined || url.protocol !== `${scheme}:`) deny('INVALID_ENDPOINT', `${p}.endpoint`);

  const key = Reflect.get(rec, 'endpointDigestKey');
  if (typeof key !== 'string') deny('ENDPOINT_DIGEST_KEY_MISSING', p);
  const endpointDigest = digestValue(ep.endpointDigest, `${p}.endpoint.endpointDigest`);
  const expectedEpDigest =
    key === '' ? (url.href === DEFAULT_HREF ? sha256Text(url.href) : undefined) : DIGEST.test(key) ? createHmac('sha256', key).update(url.href, 'utf8').digest('hex') : undefined;
  if (expectedEpDigest !== endpointDigest) deny('ENDPOINT_DIGEST_MISMATCH', `${p}.endpoint.endpointDigest`);

  const model = text(ep.model, `${p}.endpoint.model`, 128);
  if (!isModelId(model)) deny('INVALID_MODEL', `${p}.endpoint.model`);

  const pricing = pricingOf(rec.pricing, `${p}.pricing`);
  const rl = keysOf(rec.runLimits, RUN_LIMIT_KEYS, `${p}.runLimits`);
  const runLimits: RealTierRunLimits = Object.freeze({
    perRunInputTokens: positiveInteger(rl.perRunInputTokens, `${p}.runLimits.perRunInputTokens`, 'INVALID_LIMIT'),
    perRunOutputTokens: positiveInteger(rl.perRunOutputTokens, `${p}.runLimits.perRunOutputTokens`, 'INVALID_LIMIT'),
  });
  const limits = limitsOf(rec.limits, `${p}.limits`);

  const img = keysOf(rec.image, IMAGE_KEYS, `${p}.image`);
  const imageId = typeof img.imageId === 'string' && IMAGE_DIGEST.test(img.imageId) ? img.imageId : deny('UNPINNED_IMAGE', `${p}.image.imageId`);
  const base = text(img.base, `${p}.image.base`, 512);
  if (!PINNED_BASE.test(base)) deny('UNPINNED_IMAGE', `${p}.image.base`);
  const image: RealTierImage = Object.freeze({
    label: text(img.label, `${p}.image.label`, 256),
    imageId,
    base,
    platform: text(img.platform, `${p}.image.platform`, 128),
    user: text(img.user, `${p}.image.user`, 128),
  });

  const catalogPath = absPath(keysOf(rec.catalog, ['path'], `${p}.catalog`).path, `${p}.catalog.path`);
  const artifacts = keysOf(rec.artifacts, ['retainRoot', 'retainRawStreams'], `${p}.artifacts`);
  if (artifacts.retainRawStreams !== false) deny('RAW_STREAMS_RETAINED', `${p}.artifacts.retainRawStreams`);
  const retainRoot = absPath(artifacts.retainRoot, `${p}.artifacts.retainRoot`);
  const approvalVersion = text(keysOf(rec.approvalPolicy, ['profileVersion'], `${p}.approvalPolicy`).profileVersion, `${p}.approvalPolicy.profileVersion`, 128);

  const fields = {
    schema: PROFILE_SCHEMA,
    campaignId: text(rec.campaignId, `${p}.campaignId`, 256),
    stateRoot: absPath(rec.stateRoot, `${p}.stateRoot`),
    endpoint: { endpointDigest, scheme, insecureHttpAcknowledged: ep.insecureHttpAcknowledged, model },
    transport: scheme === 'http' ? ('insecure-http-acknowledged' as const) : ('https' as const),
    pricing,
    runLimits,
    limits,
    image,
    catalog: { path: catalogPath },
    artifacts: { retainRoot, retainRawStreams: false as const },
    approvalPolicy: { profileVersion: approvalVersion },
  };
  assertNoSecret(fields, p);
  const profileDigest = digestValue(rec.profileDigest, `${p}.profileDigest`);
  if (sha256Text(JSON.stringify(fields)) !== profileDigest) deny('PROFILE_INTEGRITY_MISMATCH', `${p}.profileDigest`);

  return { profileDigest, endpointUrl: url, pricing, limits, image, catalogPath };
}

function configurationMismatch(expected: RealTierHostDigests, candidate: unknown): readonly [string, string] | undefined {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return ['INVALID_CONFIGURATION', '$.configuration'];
  const config = candidate as Readonly<Record<string, unknown>>;
  if (typeof config.identity !== 'object' || config.identity === null || Array.isArray(config.identity)) return ['INVALID_CONFIGURATION', '$.configuration.identity'];
  const id = config.identity as Readonly<Record<string, unknown>>;
  if (id.profileId !== expected.profileId) return ['PROFILE_ID_MISMATCH', '$.configuration.identity.profileId'];
  if (config.profileDigest !== expected.profileDigest || id.profileDigest !== expected.profileDigest) return ['PROFILE_DIGEST_MISMATCH', '$.configuration.profileDigest'];
  if (config.configDigest !== expected.configDigest || id.configDigest !== expected.configDigest) return ['CONFIG_DIGEST_MISMATCH', '$.configuration.configDigest'];
  if (config.pricingDigest !== expected.pricingDigest || id.pricingDigest !== expected.pricingDigest) return ['PRICING_DIGEST_MISMATCH', '$.configuration.pricingDigest'];
  if (config.requestedModel !== expected.requestedModel) return ['MODEL_MISMATCH', '$.configuration.requestedModel'];
  if (
    !Array.isArray(config.adapterVersions) ||
    config.adapterVersions.length !== expected.adapterVersions.length ||
    expected.adapterVersions.some((v, i) => (config.adapterVersions as readonly unknown[])[i] !== v)
  ) {
    return ['ADAPTER_MISMATCH', '$.configuration.adapterVersions'];
  }
  return undefined;
}

function assertNoSecretAt(value: unknown, schemaPath: string): void {
  if (typeof value === 'string') {
    assertNoSecret(value, schemaPath);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretAt(item, schemaPath);
    return;
  }
  if (plain(value)) {
    for (const item of Object.values(value)) assertNoSecretAt(item, schemaPath);
  }
}

function assertCatalogNoSecret(parsed: unknown): void {
  if (!plain(parsed)) {
    assertNoSecretAt(parsed, '$.catalog');
    return;
  }
  for (const [rootKey, rootVal] of Object.entries(parsed)) {
    if (rootKey !== 'catalog') {
      assertNoSecretAt(rootVal, '$.catalog');
      continue;
    }
    if (!Array.isArray(rootVal)) {
      assertNoSecretAt(rootVal, '$.catalog.catalog');
      continue;
    }
    rootVal.forEach((item, index) => {
      const ep = `$.catalog.catalog[${index}]`;
      if (!plain(item)) {
        assertNoSecretAt(item, ep);
        return;
      }
      for (const [key, val] of Object.entries(item)) {
        if (key === 'caseId' || key === 'fixturePath' || key === 'fixtureDigest' || key === 'initialRepositoryDigest' || key === 'criteria') {
          assertNoSecretAt(val, `${ep}.${key}`);
        } else if (key === 'grader') {
          if (!plain(val)) {
            assertNoSecretAt(val, `${ep}.grader`);
          } else {
            for (const [gk, gv] of Object.entries(val)) {
              assertNoSecretAt(gv, gk === 'path' || gk === 'digest' ? `${ep}.grader.${gk}` : `${ep}.grader`);
            }
          }
        } else {
          assertNoSecretAt(val, ep);
        }
      }
    });
  }
}

function checkCriteria(criteria: unknown, path: string): void {
  if (typeof criteria === 'string') {
    if (!criteria.trim() || SURROGATE.test(criteria) || Buffer.byteLength(criteria) > 16384) deny('INVALID_CATALOG_FIELD', path);
    return;
  }
  if (Array.isArray(criteria) ? criteria.length > 0 : plain(criteria)) return;
  deny('INVALID_CATALOG_FIELD', path);
}

function deriveRealTierCatalog(catalogPath: string): readonly CatalogEntry[] {
  const parsed = parseJson(readUtf8(catalogPath, 'MISSING_CATALOG', 'CATALOG_UNREADABLE', '$.profile.catalog.path'), '$.catalog');
  assertCatalogNoSecret(parsed);
  const root = keysOf(parsed, ['catalog'], '$.catalog');
  if (!Array.isArray(root.catalog) || root.catalog.length === 0) deny('MISSING_CATALOG', '$.catalog.catalog');

  const seenCases = new Set<string>();
  const entries: CatalogEntry[] = root.catalog.map((item, index) => {
    const ep = `$.catalog.catalog[${index}]`;
    const record = keysOf(item, CATALOG_ENTRY_KEYS, ep);
    present(record, REQUIRED_ENTRY_KEYS, 'MISSING_CATALOG_FIELD', ep);

    const caseId = text(record.caseId, `${ep}.caseId`, 120);
    if (seenCases.has(caseId)) deny('DUPLICATE_CATALOG_ENTRY', ep);
    seenCases.add(caseId);

    const initialRepositoryDigest = bareSha256(record.initialRepositoryDigest, `${ep}.initialRepositoryDigest`);
    const fixturePath = absPath(record.fixturePath, `${ep}.fixturePath`);
    const fixtureDigest = bareSha256(record.fixtureDigest, `${ep}.fixtureDigest`);
    if (record.criteria !== undefined) checkCriteria(record.criteria, `${ep}.criteria`);

    const graderRec = keysOf(record.grader, ['path', 'digest'], `${ep}.grader`);
    present(graderRec, ['path', 'digest'], 'MISSING_CATALOG_FIELD', `${ep}.grader`);
    const graderPath = absPath(graderRec.path, `${ep}.grader.path`);
    const graderDigest = bareSha256(graderRec.digest, `${ep}.grader.digest`);

    if (sha256Text(readUtf8(fixturePath, 'MISSING_FIXTURE', 'FIXTURE_UNREADABLE', `${ep}.fixturePath`)) !== fixtureDigest) {
      deny('FIXTURE_DIGEST_MISMATCH', `${ep}.fixtureDigest`);
    }
    if (sha256Text(readUtf8(graderPath, 'MISSING_GRADER', 'GRADER_UNREADABLE', `${ep}.grader.path`)) !== graderDigest) {
      deny('GRADER_DIGEST_MISMATCH', `${ep}.grader.digest`);
    }

    const caseDigest = sha256Text(JSON.stringify({ caseId, initialRepositoryDigest, fixtureDigest, graderDigest, ...(record.criteria === undefined ? {} : { criteria: record.criteria }) }));
    return Object.freeze({
      catalogEntryId: `entry-${caseId}`,
      caseId,
      version: '1',
      caseDigest,
      publicTaskDigest: fixtureDigest,
      initialRepositoryDigest,
      fixturePath,
      fixtureDigest,
      grader: Object.freeze({ version: '1', digest: graderDigest, path: graderPath }),
    });
  });

  return Object.freeze([...entries].sort((left, right) => (left.catalogEntryId < right.catalogEntryId ? -1 : 1)));
}

/**
 * Validates a loaded `RealTierProfile` and its real-tier catalog against `configuration` (`host.json`),
 * derives canonical `EvaluationProfile` and `CatalogEntry[]`, and registers host-only WeakSet receipts.
 * Refuses with a bounded reason code and path without echoing rejected values or triggering side effects.
 */
export function admitRealTierConsole(input: RealTierConsoleAdmissionInput): Validation<RealTierConsoleAdmission> {
  return collect(() => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) deny('INVALID_INPUT', '$');
    const verified = verifyRealTierProfile(input.profile);
    const expected = realTierHostDigestsOf(input.profile);
    const mismatch = configurationMismatch(expected, input.configuration);
    if (mismatch !== undefined) deny(mismatch[0], mismatch[1]);

    const catalog = deriveRealTierCatalog(verified.catalogPath);
    const catalogDigest = catalogDigestOf(catalog);
    const derivedProfile: EvaluationProfile = Object.freeze({
      profileId: REAL_TIER_PROFILE_ID,
      profileDigest: expected.profileDigest,
      endpoint: Object.freeze({ origin: verified.endpointUrl.origin, path: verified.endpointUrl.pathname }),
      model: expected.requestedModel,
      mode: 'nonstreaming',
      // Real-tier credentials stay inside RealTierProfile.credential; only a symbolic host label enters EvaluationProfile.
      credentialRef: 'real-tier-host-credential',
      codeDigest: verified.profileDigest,
      configDigest: expected.configDigest,
      pricing: verified.pricing,
      pricingDigest: expected.pricingDigest,
      imageDigest: verified.image.imageId,
      platform: verified.image.platform,
      adapterVersions: expected.adapterVersions,
      catalogDigest,
      caseDigests: Object.freeze(catalog.map(entry => entry.caseDigest)),
      graderDigests: Object.freeze(catalog.map(entry => entry.grader.digest)),
      limits: verified.limits,
      spendPolicy: 'derived-exposure',
    });

    const receipt: RealTierConsoleAdmission = Object.freeze({ ...expected, catalogDigest, profile: derivedProfile, catalog });
    admittedProfiles.add(derivedProfile);
    admittedReceipts.add(receipt);
    return receipt;
  });
}

export function isAdmittedRealTierEvaluationProfile(value: unknown): value is EvaluationProfile {
  return typeof value === 'object' && value !== null && admittedProfiles.has(value as EvaluationProfile);
}

/** True only for an exact receipt issued by `admitRealTierConsole` (and matching `configuration` when supplied). */
export function isAdmittedRealTierConsole(value: unknown, configuration?: EvaluationConsoleConfiguration): value is RealTierConsoleAdmission {
  if (typeof value !== 'object' || value === null || !admittedReceipts.has(value as RealTierConsoleAdmission)) return false;
  const receipt = value as RealTierConsoleAdmission;
  if (!admittedProfiles.has(receipt.profile)) return false;
  return configuration === undefined ? true : configurationMismatch(receipt, configuration) === undefined;
}
