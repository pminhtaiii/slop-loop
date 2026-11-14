/** Validates repository question wire data. Snapshot admission, scope and evidence issuance remain host decisions. */
import type {
  AdmittedSpanV1,
  DirectoryEntryV1,
  DirectoryPageV1,
  RepositoryOmissionReasonV1,
  RepositoryOperationLimitsV1,
  RepositoryToolFailureV1,
  SearchHitV1,
  SearchPageV1,
  SourceManifestEntryV1,
  SourceSnapshotV1,
  SpanResultV1,
  SpanTruncationV1,
  QuestionValidationResult,
} from '../contracts.ts';
import { validateQuestionIdentity, validateRepositoryBinding } from './admission.ts';
import { hasExactKeys, invalid, isCanonicalRelativePath, isOneOf, isPositiveSafeInteger, isRecord, validCursor, validateDigest, validateId, validateLineRange } from './shared.ts';

const FAILURE_REASONS = {
  denied: ['protected', 'outside-scope', 'read-not-authorized'],
  stale: ['binding-mismatch', 'source-mismatch'],
  invalid: ['invalid-request', 'invalid-cursor', 'out-of-range', 'line-too-large'],
  unavailable: ['unreadable', 'binary', 'oversized', 'unsupported-adapter'],
  exhausted: ['scan-limit', 'output-limit', 'deadline'],
  cancelled: ['cancelled'],
} as const;

const OMISSION_REASONS = ['protected', 'outside-scope', 'unreadable', 'binary', 'oversized', 'line-too-large', 'scan-limit', 'output-limit'] as const;
const encoder = new TextEncoder();

function invalidRepository<T>(path: string): QuestionValidationResult<T> {
  return invalid('invalid-repository', path);
}

export function validateSourceSnapshot(input: unknown): QuestionValidationResult<SourceSnapshotV1> {
  if (!isRecord(input) || !hasExactKeys(input, ['snapshotId', 'binding', 'manifestDigest', 'acquisitionId', 'admissionLimits', 'manifest'])) {
    return invalidRepository('snapshot');
  }
  const { snapshotId, manifestDigest, acquisitionId, admissionLimits, manifest } = input;
  if (validateId(snapshotId, 'snapshot.snapshotId') || validateId(acquisitionId, 'snapshot.acquisitionId') || validateDigest(manifestDigest, 'snapshot.manifestDigest')) {
    return invalidRepository('snapshot.identity');
  }
  const binding = validateRepositoryBinding(input['binding']);
  if (!binding.ok) return binding;
  if (!isRecord(admissionLimits) || !hasExactKeys(admissionLimits, ['maxFiles', 'maxBytes', 'maxElapsedMs'])) {
    return invalidRepository('snapshot.admissionLimits');
  }
  const { maxFiles, maxBytes, maxElapsedMs } = admissionLimits;
  if (!isPositiveSafeInteger(maxFiles) || !isPositiveSafeInteger(maxBytes) || !isPositiveSafeInteger(maxElapsedMs)) {
    return invalidRepository('snapshot.admissionLimits');
  }
  if (!Array.isArray(manifest) || manifest.length > maxFiles) return invalidRepository('snapshot.manifest');
  const paths = new Set<string>();
  const entries: SourceManifestEntryV1[] = [];
  for (const entry of manifest as unknown[]) {
    if (!isRecord(entry) || !hasExactKeys(entry, ['path', 'originalByteDigest'])) return invalidRepository('snapshot.manifest');
    const { path, originalByteDigest } = entry;
    if (!isCanonicalRelativePath(path) || paths.has(path) || validateDigest(originalByteDigest, 'snapshot.manifest.originalByteDigest')) {
      return invalidRepository('snapshot.manifest');
    }
    paths.add(path);
    entries.push(Object.freeze({ path, originalByteDigest: originalByteDigest as string }));
  }
  return {
    ok: true,
    value: Object.freeze({
      snapshotId: snapshotId as string,
      binding: binding.value,
      manifestDigest: manifestDigest as string,
      acquisitionId: acquisitionId as string,
      admissionLimits: Object.freeze({ maxFiles, maxBytes, maxElapsedMs }),
      manifest: Object.freeze(entries),
    }),
  };
}

function validateTruncation(input: unknown, endLine: number): QuestionValidationResult<SpanTruncationV1> {
  if (!isRecord(input)) return invalidRepository('span.truncation');
  if (input['kind'] === 'none' && hasExactKeys(input, ['kind'])) {
    return { ok: true, value: Object.freeze({ kind: 'none' }) };
  }
  const nextLine = input['nextLine'];
  if (input['kind'] !== 'truncated' || !hasExactKeys(input, ['kind', 'nextLine']) || !isPositiveSafeInteger(nextLine) || nextLine !== endLine + 1) {
    return invalidRepository('span.truncation');
  }
  return { ok: true, value: Object.freeze({ kind: 'truncated', nextLine }) };
}

export function validateAdmittedSpan(input: unknown, limits: RepositoryOperationLimitsV1): QuestionValidationResult<AdmittedSpanV1> {
  if (!isRecord(input) || !hasExactKeys(input, ['identity', 'evidenceId', 'snapshotId', 'manifestDigest', 'path', 'range', 'excerpt', 'excerptDigest', 'originalByteDigest', 'truncation'])) {
    return invalidRepository('span');
  }
  const identity = validateQuestionIdentity(input['identity']);
  if (!identity.ok) return identity;
  const { evidenceId, snapshotId, manifestDigest, path, excerpt, excerptDigest, originalByteDigest } = input;
  if (
    validateId(evidenceId, 'span.evidenceId') ||
    validateId(snapshotId, 'span.snapshotId') ||
    validateDigest(manifestDigest, 'span.manifestDigest') ||
    validateDigest(excerptDigest, 'span.excerptDigest') ||
    validateDigest(originalByteDigest, 'span.originalByteDigest')
  ) {
    return invalidRepository('span.identity');
  }
  if (!isCanonicalRelativePath(path) || encoder.encode(path).length > limits.maxPathBytes) return invalidRepository('span.path');
  const range = validateLineRange(input['range'], 'span.range');
  if (!range.ok) return range;
  const { startLine, endLine } = range.value;
  const lineCount = endLine - startLine + 1;
  if (
    lineCount > limits.maxSpanLines ||
    typeof excerpt !== 'string' ||
    excerpt.length > limits.maxSpanBytes ||
    encoder.encode(excerpt).length > limits.maxSpanBytes ||
    excerpt.includes('\u0000') ||
    excerpt.includes('\r\n') ||
    excerpt.split('\n').length !== lineCount
  ) {
    return invalidRepository('span.excerpt');
  }
  const truncation = validateTruncation(input['truncation'], endLine);
  if (!truncation.ok) return truncation;
  return {
    ok: true,
    value: Object.freeze({
      identity: identity.value,
      evidenceId: evidenceId as string,
      snapshotId: snapshotId as string,
      manifestDigest: manifestDigest as string,
      path,
      range: range.value,
      excerpt,
      excerptDigest: excerptDigest as string,
      originalByteDigest: originalByteDigest as string,
      truncation: truncation.value,
    }),
  };
}

function validateFailure(input: Record<string, unknown>): QuestionValidationResult<RepositoryToolFailureV1> {
  const { status, reasonCode } = input;
  if (
    !hasExactKeys(input, ['status', 'reasonCode']) ||
    !isOneOf(status, Object.keys(FAILURE_REASONS)) ||
    !isOneOf(reasonCode, FAILURE_REASONS[status as keyof typeof FAILURE_REASONS] as readonly string[])
  ) {
    return invalidRepository('repositoryResult');
  }
  // The table validates the reason against the selected status.
  return { ok: true, value: Object.freeze({ status, reasonCode }) as RepositoryToolFailureV1 };
}

function validateCoverage(input: Record<string, unknown>, payloadKeys: readonly string[]) {
  const { coverage, omissionReasons, nextCursor } = input;
  const keys = ['status', 'coverage', 'omissionReasons', ...payloadKeys];
  if (nextCursor !== undefined) keys.push('nextCursor');
  if (!hasExactKeys(input, keys) || (coverage !== 'complete' && coverage !== 'partial') || !Array.isArray(omissionReasons) || omissionReasons.length > OMISSION_REASONS.length) {
    return invalidRepository<never>('repositoryResult.coverage');
  }
  const reasons: RepositoryOmissionReasonV1[] = [];
  for (const reason of omissionReasons as unknown[]) {
    if (!isOneOf(reason, OMISSION_REASONS) || reasons.includes(reason)) return invalidRepository<never>('repositoryResult.omissionReasons');
    reasons.push(reason);
  }
  if ((coverage === 'complete' && reasons.length > 0) || (nextCursor !== undefined && (!validCursor(nextCursor) || reasons.includes('scan-limit')))) {
    return invalidRepository<never>('repositoryResult.coverage');
  }
  const result = { coverage, omissionReasons: Object.freeze(reasons) } as const;
  return { ok: true as const, value: nextCursor === undefined ? result : { ...result, nextCursor } };
}

export function validateDirectoryPage(input: unknown, limits: RepositoryOperationLimitsV1): QuestionValidationResult<DirectoryPageV1> {
  if (!isRecord(input)) return invalidRepository('directoryPage');
  if (input['status'] !== 'ok') return validateFailure(input);
  const coverage = validateCoverage(input, ['path', 'entries']);
  if (!coverage.ok) return coverage;
  const { path, entries } = input;
  if (!isCanonicalRelativePath(path, true) || encoder.encode(path).length > limits.maxPathBytes || !Array.isArray(entries) || entries.length > limits.maxPageEntries) {
    return invalidRepository('directoryPage');
  }
  const children: DirectoryEntryV1[] = [];
  const prefix = path === '.' ? '' : path + '/';
  let previous = '';
  for (const entry of entries as unknown[]) {
    if (!isRecord(entry) || !hasExactKeys(entry, ['path', 'kind'])) return invalidRepository('directoryPage.entries');
    const { path: child, kind } = entry;
    if (
      !isCanonicalRelativePath(child) ||
      encoder.encode(child).length > limits.maxPathBytes ||
      !child.startsWith(prefix) ||
      child.slice(prefix.length).includes('/') ||
      child.length === prefix.length ||
      child <= previous ||
      (kind !== 'file' && kind !== 'directory')
    ) {
      return invalidRepository('directoryPage.entries');
    }
    previous = child;
    children.push(Object.freeze({ path: child, kind }));
  }
  return { ok: true, value: Object.freeze({ status: 'ok', path, entries: Object.freeze(children), ...coverage.value }) };
}

export function validateSpanResult(input: unknown, limits: RepositoryOperationLimitsV1): QuestionValidationResult<SpanResultV1> {
  if (!isRecord(input)) return invalidRepository('spanResult');
  if (input['status'] !== 'ok') return validateFailure(input);
  if (!hasExactKeys(input, ['status', 'span'])) return invalidRepository('spanResult');
  const span = validateAdmittedSpan(input['span'], limits);
  if (!span.ok) return span;
  return { ok: true, value: Object.freeze({ status: 'ok', span: span.value }) };
}

export function validateSearchPage(input: unknown, limits: RepositoryOperationLimitsV1): QuestionValidationResult<SearchPageV1> {
  if (!isRecord(input)) return invalidRepository('searchPage');
  if (input['status'] !== 'ok') return validateFailure(input);
  const coverage = validateCoverage(input, ['hits']);
  if (!coverage.ok) return coverage;
  const hits = input['hits'];
  if (!Array.isArray(hits) || hits.length > limits.maxSearchHits) return invalidRepository('searchPage.hits');
  const values: SearchHitV1[] = [];
  const seenLines = new Set<string>();
  for (const hit of hits as unknown[]) {
    if (!isRecord(hit) || !hasExactKeys(hit, ['span', 'line', 'column', 'matchLength'])) return invalidRepository('searchPage.hits');
    const { line, column, matchLength } = hit;
    const span = validateAdmittedSpan(hit['span'], limits);
    if (!span.ok) return span;
    if (!isPositiveSafeInteger(line) || !isPositiveSafeInteger(column) || !isPositiveSafeInteger(matchLength) || line < span.value.range.startLine || line > span.value.range.endLine) {
      return invalidRepository('searchPage.hits');
    }
    const text = span.value.excerpt.split('\n')[line - span.value.range.startLine];
    const key = span.value.path + ':' + line;
    if (text === undefined || matchLength > text.length - (column - 1) || seenLines.has(key)) {
      return invalidRepository('searchPage.hits');
    }
    seenLines.add(key);
    values.push(Object.freeze({ span: span.value, line, column, matchLength }));
  }
  return { ok: true, value: Object.freeze({ status: 'ok', hits: Object.freeze(values), ...coverage.value }) };
}
