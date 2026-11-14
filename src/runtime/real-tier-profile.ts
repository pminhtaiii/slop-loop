/**
 * G-PROFILE operator real-tier profile (T047, `uc03-real-tier-profile/1`).
 *
 * `loadRealTierProfile(env)` reads the file named by `UC03_REAL_TIER_PROFILE`, validates it against the
 * real-tier contract §(d), resolves exactly one endpoint (profile, `ANTHROPIC_BASE_URL`, or the pinned
 * default) and one model (profile or `ANTHROPIC_MODEL`), and holds the credential from `ANTHROPIC_API_KEY`.
 * It never reads the process environment itself or touches the network.
 *
 * Privacy: the profile lives outside every checkout, and the returned value serializes to `endpointDigest`
 * and the scheme only. The normalized `href` and the credential are non-enumerable, so JSON, a digest input
 * or an error never carries the URL, the host or the key bytes.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { sha256Text, type Validation } from '../uc01/contracts.ts';
import { collect, deny, IMAGE_DIGEST, keysOf, limitsOf, positiveInteger, pricingOf, text } from './evaluation-profile-primitives.ts';
import type { EvaluationLimits, EvaluationPricing } from './evaluation-profile-types.ts';

/** The pinned default when neither the profile nor the environment supplies an endpoint. */
export const DEFAULT_REAL_TIER_ENDPOINT = 'https://api.deepseek.com/anthropic/v1/messages';
export const PROFILE_SCHEMA = 'uc03-real-tier-profile/1';

const MODEL_ID = /^[A-Za-z0-9._:/@-]{1,256}$/u;
const PINNED_BASE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u;
const PROFILE_KEYS = ['schema', 'campaignId', 'stateRoot', 'provider', 'pricing', 'runLimits', 'limits', 'image', 'catalog', 'artifacts', 'approvalPolicy'] as const;
const PROVIDER_KEYS = ['endpoint', 'allowInsecureHttp', 'model', 'mode', 'timeoutMs'] as const;
const RUN_LIMIT_KEYS = ['perRunInputTokens', 'perRunOutputTokens'] as const;
const IMAGE_KEYS = ['label', 'imageId', 'base', 'platform', 'user'] as const;
const ARTIFACT_KEYS = ['retainRoot', 'retainRawStreams'] as const;

/** In-memory endpoint identity: the `href` is never enumerable, so it cannot be serialized or digested. */
export type ResolvedEndpoint = Readonly<{
  readonly href: string;
  readonly scheme: 'https' | 'http';
  readonly endpointDigest: string;
  readonly insecureHttpAcknowledged: boolean;
  readonly model: string;
}>;

export type RealTierRunLimits = Readonly<{ perRunInputTokens: number; perRunOutputTokens: number }>;

export type RealTierImage = Readonly<{ label: string; imageId: string; base: string; platform: string; user: string }>;

export type RealTierProfile = Readonly<{
  schema: typeof PROFILE_SCHEMA;
  campaignId: string;
  stateRoot: string;
  endpoint: ResolvedEndpoint;
  /** `insecure-http-acknowledged` while an acknowledged cleartext hop is in force. */
  transport: 'https' | 'insecure-http-acknowledged';
  pricing: EvaluationPricing;
  runLimits: RealTierRunLimits;
  limits: EvaluationLimits;
  image: RealTierImage;
  catalog: Readonly<{ path: string }>;
  artifacts: Readonly<{ retainRoot: string; retainRawStreams: false }>;
  approvalPolicy: Readonly<{ profileVersion: string }>;
  /** sha256 over the serializable fields, so it changes with any pinned identity and never with the key. */
  profileDigest: string;
  /** Non-enumerable credential handle; the only place the key bytes live. */
  readonly credential: string;
}>;

/** A profile or environment value: absent or blank values are absent. */
export type RealTierEnvironment = Readonly<Record<string, string | undefined>>;

export type RealTierProfileOptions = Readonly<{ repositoryRoot?: string }>;

function defined(env: RealTierEnvironment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function absolutePath(value: unknown, path: string): string {
  const candidate = text(value, path, 1024);
  return isAbsolute(candidate) ? resolve(candidate) : deny('INVALID_PATH', path);
}

/** Resolves the target and reports whether it lands inside the checkout, case-insensitively on Windows. */
function insideRepository(root: string, target: string): boolean {
  const from = relative(resolve(root).toLowerCase(), target.toLowerCase());
  return from === '' || (!from.startsWith('..') && !isAbsolute(from));
}

function refuseInside(root: string, target: string, reasonCode: string): string {
  if (insideRepository(root, target)) deny(reasonCode, '$');
  return target;
}

const normalizeUrl = (raw: string): string => (URL.canParse(raw) ? new URL(raw).href : raw.trim());

/** One `<base>/messages` URL from the environment, with any trailing slash collapsed. */
function endpointFromBase(base: string): string {
  return `${base.replace(/\/+$/u, '')}/messages`;
}

function endpointOf(raw: string, allowInsecureHttp: boolean | undefined, model: string): ResolvedEndpoint {
  if (!URL.canParse(raw)) deny('endpoint-invalid', '$');
  const url = new URL(raw);
  const shape =
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    url.pathname.endsWith('/messages') &&
    url.hostname !== '';
  if (!shape) deny('endpoint-invalid', '$');
  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  const acknowledged = scheme === 'http' && allowInsecureHttp === true;
  if (scheme === 'http' && !acknowledged) deny('insecure-endpoint-unacknowledged', '$');
  const href = url.href;
  const endpoint = { endpointDigest: sha256Text(href), scheme, insecureHttpAcknowledged: acknowledged, model };
  // The URL is a host-only memory value: non-enumerable, so it never reaches JSON, a digest or a log.
  return Object.freeze(Object.defineProperty(endpoint, 'href', { value: href, enumerable: false })) as ResolvedEndpoint;
}

function imageOf(value: unknown): RealTierImage {
  const record = keysOf(value, IMAGE_KEYS, '$.image');
  const imageId = record.imageId;
  if (typeof imageId !== 'string' || !IMAGE_DIGEST.test(imageId)) deny('unpinned-image', '$.image.imageId');
  const base = text(record.base, '$.image.base', 512);
  if (!PINNED_BASE.test(base)) deny('unpinned-image', '$.image.base');
  return Object.freeze({
    label: text(record.label, '$.image.label', 256),
    imageId,
    base,
    platform: text(record.platform, '$.image.platform', 128),
    user: text(record.user, '$.image.user', 128),
  });
}

function runLimitsOf(value: unknown): RealTierRunLimits {
  const record = keysOf(value, RUN_LIMIT_KEYS, '$.runLimits');
  return Object.freeze({
    perRunInputTokens: positiveInteger(record.perRunInputTokens, '$.runLimits.perRunInputTokens', 'run-limits-invalid'),
    perRunOutputTokens: positiveInteger(record.perRunOutputTokens, '$.runLimits.perRunOutputTokens', 'run-limits-invalid'),
  });
}

function checkProfile(raw: unknown, root: string, env: RealTierEnvironment): RealTierProfile {
  const record = keysOf(raw, PROFILE_KEYS, '$');
  if (record.schema !== PROFILE_SCHEMA) deny('INVALID_SCHEMA', '$.schema');

  const provider = keysOf(record.provider, PROVIDER_KEYS, '$.provider');
  const allowInsecureHttp = provider.allowInsecureHttp;
  if (allowInsecureHttp !== undefined && typeof allowInsecureHttp !== 'boolean') deny('INVALID_INPUT', '$.provider.allowInsecureHttp');
  if (provider.mode !== 'nonstreaming') deny('INVALID_MODE', '$.provider.mode');
  positiveInteger(provider.timeoutMs, '$.provider.timeoutMs', 'INVALID_LIMIT');

  const profileEndpoint = provider.endpoint === undefined ? undefined : text(provider.endpoint, '$.provider.endpoint', 2048);
  const baseEndpoint = defined(env, 'ANTHROPIC_BASE_URL');
  const environmentEndpoint = baseEndpoint === undefined ? undefined : endpointFromBase(baseEndpoint);
  if (profileEndpoint !== undefined && environmentEndpoint !== undefined && normalizeUrl(profileEndpoint) !== normalizeUrl(environmentEndpoint)) {
    deny('endpoint-ambiguous', '$.provider.endpoint');
  }

  // The model id follows the host-file identifier rule (src/cli/evaluate.ts:69).
  const profileModel = provider.model === undefined ? undefined : text(provider.model, '$.provider.model', 256);
  if (profileModel !== undefined && !MODEL_ID.test(profileModel)) deny('model-invalid', '$.provider.model');
  const environmentModel = defined(env, 'ANTHROPIC_MODEL');
  if (profileModel !== undefined && environmentModel !== undefined && profileModel !== environmentModel) deny('model-ambiguous', '$.provider.model');
  const model = profileModel ?? environmentModel;
  if (model === undefined) deny('model-missing', '$.provider.model');
  if (!MODEL_ID.test(model)) deny('model-invalid', '$.provider.model');

  const endpoint = endpointOf(profileEndpoint ?? environmentEndpoint ?? DEFAULT_REAL_TIER_ENDPOINT, allowInsecureHttp, model);

  const stateRoot = refuseInside(root, absolutePath(record.stateRoot, '$.stateRoot'), 'state-root-inside-repository');
  const artifactsRecord = keysOf(record.artifacts, ARTIFACT_KEYS, '$.artifacts');
  if (artifactsRecord.retainRawStreams !== false) deny('raw-streams-retained', '$.artifacts.retainRawStreams');
  const retainRoot = refuseInside(root, absolutePath(artifactsRecord.retainRoot, '$.artifacts.retainRoot'), 'artifacts-inside-repository');
  // The catalog and its fixtures are deliberately repository-local; only profile/state/artifact paths stay outside.
  const catalog = Object.freeze({ path: absolutePath(keysOf(record.catalog, ['path'], '$.catalog').path, '$.catalog.path') });
  const approvalPolicy = Object.freeze({ profileVersion: text(keysOf(record.approvalPolicy, ['profileVersion'], '$.approvalPolicy').profileVersion, '$.approvalPolicy.profileVersion', 128) });

  const fields = {
    schema: PROFILE_SCHEMA,
    campaignId: text(record.campaignId, '$.campaignId', 256),
    stateRoot,
    endpoint,
    transport: endpoint.scheme === 'http' ? ('insecure-http-acknowledged' as const) : ('https' as const),
    pricing: pricingOf(record.pricing, '$.pricing'),
    runLimits: runLimitsOf(record.runLimits),
    limits: limitsOf(record.limits, '$.limits'),
    image: imageOf(record.image),
    catalog,
    artifacts: Object.freeze({ retainRoot, retainRawStreams: false }),
    approvalPolicy,
  };
  const profile = Object.defineProperty({ profileDigest: sha256Text(JSON.stringify(fields)), ...fields }, 'credential', { value: env.ANTHROPIC_API_KEY ?? '', enumerable: false });
  return Object.freeze(profile) as RealTierProfile;
}

/**
 * Validates and freezes the operator profile named by `env.UC03_REAL_TIER_PROFILE`, which must resolve
 * outside `repositoryRoot` (default: the process working directory). Refusals carry a bounded reason code
 * and path; no file content, endpoint URL or credential value is ever returned or thrown.
 */
export function loadRealTierProfile(env: RealTierEnvironment, options: RealTierProfileOptions = {}): Validation<RealTierProfile> {
  const root = resolve(options.repositoryRoot ?? process.cwd());
  const reference = defined(env, 'UC03_REAL_TIER_PROFILE');
  if (reference === undefined) return { ok: false, status: 'invalid-input', reasonCode: 'profile-path-missing', path: '$' };
  const file = resolve(reference);
  if (insideRepository(root, file)) return { ok: false, status: 'invalid-input', reasonCode: 'profile-inside-repository', path: '$' };
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return { ok: false, status: 'invalid-input', reasonCode: 'profile-unreadable', path: '$' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { ok: false, status: 'invalid-input', reasonCode: 'profile-unreadable', path: '$' };
  }
  if (typeof env.ANTHROPIC_API_KEY !== 'string' || !env.ANTHROPIC_API_KEY.trim()) {
    return { ok: false, status: 'invalid-input', reasonCode: 'credential-missing', path: '$' };
  }
  return collect(() => checkProfile(parsed, root, env));
}
