import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isPlainObject } from '../contracts/foundation/uc03/v01/validation/common.ts';
import { sha256Text, type Validation } from '../uc01/contracts.ts';
import type { CatalogEntry, EvaluationLimits, EvaluationPricing } from './evaluation-profile-types.ts';

export const DIGEST = /^[a-f0-9]{64}$/u;
export const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
export const CREDENTIAL_REFERENCE = /^[a-z][a-z0-9-]{2,63}$/u;
const SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const SECRETS = [/(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/u, /bearer\s+[A-Za-z0-9._-]{16,}/iu, /-----BEGIN [A-Z ]+PRIVATE KEY-----/u, /(?:api[_-]?key|secret|password|token)\s*[:=]\s*\S{8,}/iu];

export const LIMIT_KEYS = [
  'totalModelCalls',
  'inputTokensPerRequest',
  'outputTokensPerRequest',
  'providerTimeoutMs',
  'activeExecutionMs',
  'repairs',
  'reviewerIterations',
  'materialReplans',
  'commandTimeoutMs',
  'outputBytes',
  'memoryBytes',
  'cpus',
  'processes',
] as const;
const PRICING_KEYS = ['pricingId', 'inputRate', 'outputRate', 'cacheRate', 'overheadRate', 'denominator'] as const;
const ENTRY_KEYS = ['catalogEntryId', 'caseId', 'version', 'caseDigest', 'publicTaskDigest', 'initialRepositoryDigest', 'fixturePath', 'fixtureDigest', 'grader'] as const;
const GRADER_KEYS = ['version', 'digest', 'path'] as const;
export const PROFILE_KEYS = ['endpoint', 'model', 'mode', 'credentialRef', 'codeDigest', 'configDigest', 'imageDigest', 'platform', 'adapterVersions', 'pricing', 'limits', 'catalog'] as const;
export const BUG_KEYS = ['goal', 'observedBehavior', 'expectedBehavior', 'reproduction', 'acceptanceCriteria', 'constraints'] as const;

export class Denied extends Error {
  readonly reasonCode: string;
  readonly path: string;
  constructor(reasonCode: string, path: string) {
    super(reasonCode);
    this.reasonCode = reasonCode;
    this.path = path;
  }
}

export function deny(reasonCode: string, path: string): never {
  throw new Denied(reasonCode, path);
}

/** Translates the first denial; other failures stay programmer errors. */
export function collect<T>(check: () => T): Validation<T> {
  try {
    return { ok: true, value: check() };
  } catch (error) {
    if (error instanceof Denied) return { ok: false, status: 'invalid-input', reasonCode: error.reasonCode, path: error.path };
    throw error;
  }
}

export function plain(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export function keysOf(value: unknown, allowed: readonly string[], path: string): Record<string, unknown> {
  if (!plain(value)) deny('INVALID_INPUT', path);
  if (!Object.keys(value).every(key => allowed.includes(key))) deny('UNKNOWN_FIELD', path);
  return value;
}

export function present(record: Record<string, unknown>, keys: readonly string[], reasonCode: string, path: string): void {
  // An own `undefined` is still an absent value, not a supplied one.
  for (const key of keys) if (record[key] === undefined) deny(reasonCode, `${path}.${key}`);
}

export function text(value: unknown, path: string, maxBytes = 4096): string {
  if (typeof value !== 'string' || !value.trim() || SURROGATE.test(value) || Buffer.byteLength(value) > maxBytes) deny('INVALID_TEXT', path);
  return value;
}

export function digestValue(value: unknown, path: string): string {
  return typeof value === 'string' && DIGEST.test(value) ? value : deny('INVALID_DIGEST', path);
}

export function positiveInteger(value: unknown, path: string, reasonCode: string): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : deny(reasonCode, path);
}

export function nonNegativeInteger(value: unknown, path: string, reasonCode: string): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : deny(reasonCode, path);
}

export function assertNoSecret(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (SECRETS.some(pattern => pattern.test(value))) deny('SECRET_MATERIAL', path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecret(item, `${path}[${index}]`));
    return;
  }
  if (plain(value)) for (const [key, item] of Object.entries(value)) assertNoSecret(item, `${path}.${key}`);
}

export function endpointOf(value: unknown, path: string): Readonly<{ origin: string; path: string }> {
  const raw = text(value, path, 512);
  if (!URL.canParse(raw)) deny('INVALID_ENDPOINT', path);
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== 'api.deepseek.com' || url.port !== '' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    deny('INVALID_ENDPOINT', path);
  }
  return Object.freeze({ origin: url.origin, path: url.pathname });
}

export function limitsOf(value: unknown, path: string): EvaluationLimits {
  const record = keysOf(value, LIMIT_KEYS, path);
  present(record, LIMIT_KEYS, 'MISSING_LIMIT', path);
  const limits: EvaluationLimits = Object.freeze({
    totalModelCalls: positiveInteger(record.totalModelCalls, `${path}.totalModelCalls`, 'INVALID_LIMIT'),
    inputTokensPerRequest: positiveInteger(record.inputTokensPerRequest, `${path}.inputTokensPerRequest`, 'INVALID_LIMIT'),
    outputTokensPerRequest: positiveInteger(record.outputTokensPerRequest, `${path}.outputTokensPerRequest`, 'INVALID_LIMIT'),
    providerTimeoutMs: positiveInteger(record.providerTimeoutMs, `${path}.providerTimeoutMs`, 'INVALID_LIMIT'),
    activeExecutionMs: positiveInteger(record.activeExecutionMs, `${path}.activeExecutionMs`, 'INVALID_LIMIT'),
    repairs: positiveInteger(record.repairs, `${path}.repairs`, 'INVALID_LIMIT'),
    reviewerIterations: positiveInteger(record.reviewerIterations, `${path}.reviewerIterations`, 'INVALID_LIMIT'),
    materialReplans: positiveInteger(record.materialReplans, `${path}.materialReplans`, 'INVALID_LIMIT'),
    commandTimeoutMs: positiveInteger(record.commandTimeoutMs, `${path}.commandTimeoutMs`, 'INVALID_LIMIT'),
    outputBytes: positiveInteger(record.outputBytes, `${path}.outputBytes`, 'INVALID_LIMIT'),
    memoryBytes: positiveInteger(record.memoryBytes, `${path}.memoryBytes`, 'INVALID_LIMIT'),
    cpus: positiveInteger(record.cpus, `${path}.cpus`, 'INVALID_LIMIT'),
    processes: positiveInteger(record.processes, `${path}.processes`, 'INVALID_LIMIT'),
  });
  if (limits.providerTimeoutMs > limits.activeExecutionMs || limits.commandTimeoutMs > limits.activeExecutionMs) {
    deny('INVALID_LIMIT', path);
  }
  return limits;
}

export function pricingOf(value: unknown, path: string): EvaluationPricing {
  const record = keysOf(value, PRICING_KEYS, path);
  present(record, PRICING_KEYS, 'MISSING_PRICING', path);
  return Object.freeze({
    pricingId: text(record.pricingId, `${path}.pricingId`, 128),
    inputRate: positiveInteger(record.inputRate, `${path}.inputRate`, 'INVALID_PRICING'),
    outputRate: positiveInteger(record.outputRate, `${path}.outputRate`, 'INVALID_PRICING'),
    cacheRate: nonNegativeInteger(record.cacheRate, `${path}.cacheRate`, 'INVALID_PRICING'),
    overheadRate: nonNegativeInteger(record.overheadRate, `${path}.overheadRate`, 'INVALID_PRICING'),
    denominator: positiveInteger(record.denominator, `${path}.denominator`, 'INVALID_PRICING'),
  });
}

export function pathValue(value: unknown, path: string): string {
  const candidate = text(value, path, 512);
  return isAbsolute(candidate) ? candidate : deny('INVALID_PATH', path);
}

export function catalogEntryOf(value: unknown, path: string): CatalogEntry {
  const record = keysOf(value, ENTRY_KEYS, path);
  present(record, ENTRY_KEYS, 'MISSING_CATALOG_FIELD', path);
  const graderRecord = keysOf(record.grader, GRADER_KEYS, `${path}.grader`);
  present(graderRecord, GRADER_KEYS, 'MISSING_CATALOG_FIELD', `${path}.grader`);
  return Object.freeze({
    catalogEntryId: text(record.catalogEntryId, `${path}.catalogEntryId`, 128),
    caseId: text(record.caseId, `${path}.caseId`, 128),
    version: text(record.version, `${path}.version`, 128),
    caseDigest: digestValue(record.caseDigest, `${path}.caseDigest`),
    publicTaskDigest: digestValue(record.publicTaskDigest, `${path}.publicTaskDigest`),
    initialRepositoryDigest: digestValue(record.initialRepositoryDigest, `${path}.initialRepositoryDigest`),
    fixturePath: pathValue(record.fixturePath, `${path}.fixturePath`),
    fixtureDigest: digestValue(record.fixtureDigest, `${path}.fixtureDigest`),
    grader: Object.freeze({
      version: text(graderRecord.version, `${path}.grader.version`, 128),
      digest: digestValue(graderRecord.digest, `${path}.grader.digest`),
      path: pathValue(graderRecord.path, `${path}.grader.path`),
    }),
  });
}

/** shortcut: fixture existence only; content digests are pinned host identities verified by the downstream loader. */
export function catalogOf(value: unknown, path: string): readonly CatalogEntry[] {
  if (!Array.isArray(value) || !value.length) deny('MISSING_CATALOG', path);
  const entries = value.map((entry, index) => catalogEntryOf(entry, `${path}[${index}]`));
  const entryIds = new Set<string>();
  const caseIds = new Set<string>();
  entries.forEach((entry, index) => {
    if (entryIds.has(entry.catalogEntryId) || caseIds.has(entry.caseId)) deny('DUPLICATE_CATALOG_ENTRY', `${path}[${index}]`);
    entryIds.add(entry.catalogEntryId);
    caseIds.add(entry.caseId);
    if (!existsSync(entry.fixturePath)) deny('MISSING_FIXTURE', `${path}[${index}].fixturePath`);
    if (!existsSync(entry.grader.path)) deny('MISSING_GRADER', `${path}[${index}].grader.path`);
  });
  return Object.freeze([...entries].sort((left, right) => (left.catalogEntryId < right.catalogEntryId ? -1 : 1)));
}

function catalogRecord(entry: CatalogEntry): Record<string, unknown> {
  return {
    catalogEntryId: entry.catalogEntryId,
    caseId: entry.caseId,
    version: entry.version,
    caseDigest: entry.caseDigest,
    publicTaskDigest: entry.publicTaskDigest,
    initialRepositoryDigest: entry.initialRepositoryDigest,
    fixturePath: entry.fixturePath,
    fixtureDigest: entry.fixtureDigest,
    grader: { version: entry.grader.version, digest: entry.grader.digest, path: entry.grader.path },
  };
}

/** Canonical catalog identity, independent of caller array order. */
export function catalogDigestOf(catalog: readonly CatalogEntry[]): string {
  const records = [...catalog].sort((left, right) => (left.catalogEntryId < right.catalogEntryId ? -1 : 1)).map(catalogRecord);
  return sha256Text(JSON.stringify(records));
}
