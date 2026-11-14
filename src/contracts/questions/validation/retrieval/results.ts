import type {
  QuestionAbsenceReceiptV1,
  QuestionRankedChunkV1,
  QuestionRetrievalFailureReasonV1,
  QuestionRetrievalFailureStatusV1,
  QuestionRetrievalResultV1,
  QuestionValidationResult,
} from '../../contracts.ts';
import { validateRepositoryBinding } from '../admission.ts';
import {
  hasExactKeys,
  invalid,
  isCanonicalRelativePath,
  isOneOf,
  isPositiveSafeInteger,
  isRecord,
  MAX_QUESTION_CHUNK_LINES,
  MAX_QUESTION_CHUNK_NORMALIZED_BYTES,
  validateDigest,
  validateId,
  validateLineRange,
} from '../shared.ts';

const FAILURE_STATUSES = ['busy', 'stale', 'unavailable', 'invalid', 'exhausted', 'cancelled'] as const;
const FAILURE_REASONS = ['binding-mismatch', 'generation-missing', 'generation-incompatible', 'scan-limit', 'deadline', 'cancelled', 'invalid-request', 'store-unavailable', 'busy'] as const;
const LANES = ['exact-qualified', 'exact-simple', 'semantic'] as const;
function validateRankedChunk(input: unknown, path: string): QuestionValidationResult<QuestionRankedChunkV1> {
  const keys = ['chunkId', 'embeddingInputTokens', 'endLine', 'excerptDigest', 'lane', 'normalizedByteLength', 'originalByteDigest', 'path', 'rank', 'revisionDigest', 'score', 'startLine'];
  if (!isRecord(input) || !hasExactKeys(input, keys)) return invalid('invalid-retrieval', path);
  const idError = validateId(input['chunkId'], path + '.chunkId');
  if (idError) return { ok: false, errors: Object.freeze([Object.freeze(idError)]) };
  if (!isOneOf(input['lane'], LANES)) return invalid('invalid-retrieval', path + '.lane');
  if (!isPositiveSafeInteger(input['rank']) || input['rank'] > 5) return invalid('invalid-retrieval', path + '.rank');
  if (typeof input['score'] !== 'number' || !Number.isFinite(input['score']) || input['score'] < -1 || input['score'] > 1) {
    return invalid('invalid-retrieval', path + '.score');
  }
  if (!isCanonicalRelativePath(input['path'])) return invalid('invalid-retrieval', path + '.path');
  for (const key of ['revisionDigest', 'originalByteDigest', 'excerptDigest']) {
    const error = validateDigest(input[key], path + '.' + key);
    if (error) return { ok: false, errors: Object.freeze([Object.freeze(error)]) };
  }
  const range = validateLineRange({ startLine: input['startLine'], endLine: input['endLine'] }, path + '.range');
  if (!range.ok) return range;
  if (range.value.endLine - range.value.startLine + 1 > MAX_QUESTION_CHUNK_LINES) return invalid('invalid-range', path + '.range');
  if (!isPositiveSafeInteger(input['normalizedByteLength']) || input['normalizedByteLength'] > MAX_QUESTION_CHUNK_NORMALIZED_BYTES) {
    return invalid('invalid-retrieval', path + '.normalizedByteLength');
  }
  if (!isPositiveSafeInteger(input['embeddingInputTokens'])) return invalid('invalid-retrieval', path + '.embeddingInputTokens');
  return {
    ok: true,
    value: Object.freeze({
      chunkId: input['chunkId'] as string,
      lane: input['lane'],
      rank: input['rank'],
      score: input['score'],
      path: input['path'],
      revisionDigest: input['revisionDigest'] as string,
      originalByteDigest: input['originalByteDigest'] as string,
      excerptDigest: input['excerptDigest'] as string,
      ...range.value,
      normalizedByteLength: input['normalizedByteLength'],
      embeddingInputTokens: input['embeddingInputTokens'],
    }),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRankedChunks(left: QuestionRankedChunkV1, right: QuestionRankedChunkV1): number {
  const priorities: Readonly<Record<QuestionRankedChunkV1['lane'], number>> = {
    'exact-qualified': 0,
    'exact-simple': 1,
    semantic: 2,
  };
  return (
    priorities[left.lane] - priorities[right.lane] ||
    right.score - left.score ||
    compareText(left.path, right.path) ||
    left.startLine - right.startLine ||
    left.endLine - right.endLine ||
    compareText(left.chunkId, right.chunkId)
  );
}

function failureReasonMatches(status: QuestionRetrievalFailureStatusV1, reason: QuestionRetrievalFailureReasonV1): boolean {
  const allowed: Readonly<Record<QuestionRetrievalFailureStatusV1, readonly QuestionRetrievalFailureReasonV1[]>> = {
    busy: ['busy'],
    stale: ['binding-mismatch', 'generation-incompatible'],
    unavailable: ['generation-missing', 'generation-incompatible', 'store-unavailable'],
    invalid: ['generation-incompatible', 'invalid-request'],
    exhausted: ['scan-limit', 'deadline'],
    cancelled: ['cancelled'],
  };
  return allowed[status].includes(reason);
}

/** Validates a frozen final top-five ranking or a typed retrieval refusal. */
export function validateQuestionRetrievalResult(input: unknown): QuestionValidationResult<QuestionRetrievalResultV1> {
  if (!isRecord(input) || input['schemaVersion'] !== 'question-retrieval/1' || typeof input['status'] !== 'string') {
    return invalid('invalid-retrieval', 'retrievalResult');
  }
  const status = input['status'];
  if (status === 'complete' || status === 'empty') {
    const keys = ['binding', 'configDigest', 'embeddingDigest', 'generationId', 'manifestDigest', 'ranked', 'schemaVersion', 'status'];
    if (!hasExactKeys(input, keys)) return invalid('invalid-retrieval', 'retrievalResult');
    const binding = validateRepositoryBinding(input['binding']);
    if (!binding.ok) return binding;
    const idError = validateId(input['generationId'], 'retrievalResult.generationId');
    if (idError) return { ok: false, errors: Object.freeze([Object.freeze(idError)]) };
    for (const key of ['manifestDigest', 'configDigest', 'embeddingDigest']) {
      const error = validateDigest(input[key], 'retrievalResult.' + key);
      if (error) return { ok: false, errors: Object.freeze([Object.freeze(error)]) };
    }
    const rankedInput = input['ranked'];
    if (!Array.isArray(rankedInput) || rankedInput.length > 5) return invalid('invalid-retrieval', 'retrievalResult.ranked');
    if ((status === 'complete' && rankedInput.length === 0) || (status === 'empty' && rankedInput.length !== 0)) {
      return invalid('invalid-retrieval', 'retrievalResult.ranked');
    }
    const ranked: QuestionRankedChunkV1[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < rankedInput.length; index += 1) {
      const candidate = validateRankedChunk(rankedInput[index], 'retrievalResult.ranked[' + index + ']');
      const previous = ranked.at(-1);
      if (!candidate.ok) return candidate;
      if (
        candidate.value.rank !== index + 1 ||
        candidate.value.revisionDigest !== binding.value.revisionDigest ||
        seen.has(candidate.value.chunkId) ||
        (previous !== undefined && compareRankedChunks(previous, candidate.value) > 0)
      ) {
        return invalid('invalid-retrieval', 'retrievalResult.ranked[' + index + ']');
      }
      seen.add(candidate.value.chunkId);
      ranked.push(candidate.value);
    }
    const common = {
      schemaVersion: 'question-retrieval/1' as const,
      binding: binding.value,
      generationId: input['generationId'] as string,
      manifestDigest: input['manifestDigest'] as string,
      configDigest: input['configDigest'] as string,
      embeddingDigest: input['embeddingDigest'] as string,
    };
    if (status === 'empty') {
      return { ok: true, value: Object.freeze({ ...common, status, ranked: Object.freeze([]) as readonly [] }) };
    }
    return { ok: true, value: Object.freeze({ ...common, status, ranked: Object.freeze(ranked) }) };
  }

  if (!isOneOf(status, FAILURE_STATUSES) || !hasExactKeys(input, ['reasonCode', 'schemaVersion', 'status'])) {
    return invalid('invalid-retrieval', 'retrievalResult.status');
  }
  const reasonCode = input['reasonCode'];
  if (!isOneOf(reasonCode, FAILURE_REASONS) || !failureReasonMatches(status, reasonCode)) {
    return invalid('invalid-retrieval', 'retrievalResult.reasonCode');
  }
  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: 'question-retrieval/1',
      status,
      reasonCode,
    }),
  };
}

/** A host-issued absence receipt is valid only for fresh, complete, zero-match scans without omissions. */
export function validateQuestionAbsenceReceipt(input: unknown): QuestionValidationResult<QuestionAbsenceReceiptV1> {
  const keys = [
    'binding',
    'exactDefinitionMatchCount',
    'exactDefinitionScan',
    'generationId',
    'guardedLiteralMatchCount',
    'guardedLiteralScan',
    'manifestDigest',
    'normalizedQueryDigest',
    'omissionReasons',
    'schemaVersion',
    'scope',
    'snapshotId',
  ];
  if (!isRecord(input) || !hasExactKeys(input, keys) || input['schemaVersion'] !== 'question-retrieval/1') {
    return invalid('invalid-retrieval', 'absenceReceipt');
  }
  const binding = validateRepositoryBinding(input['binding']);
  if (!binding.ok) return binding;
  const idError = validateId(input['snapshotId'], 'absenceReceipt.snapshotId') ?? validateId(input['generationId'], 'absenceReceipt.generationId');
  if (idError) return { ok: false, errors: Object.freeze([Object.freeze(idError)]) };
  const digestError = validateDigest(input['manifestDigest'], 'absenceReceipt.manifestDigest') ?? validateDigest(input['normalizedQueryDigest'], 'absenceReceipt.normalizedQueryDigest');
  if (digestError) return { ok: false, errors: Object.freeze([Object.freeze(digestError)]) };
  if (input['exactDefinitionScan'] !== 'complete' || input['guardedLiteralScan'] !== 'complete' || input['exactDefinitionMatchCount'] !== 0 || input['guardedLiteralMatchCount'] !== 0) {
    return invalid('invalid-retrieval', 'absenceReceipt.coverage');
  }
  if (!Array.isArray(input['omissionReasons']) || input['omissionReasons'].length !== 0) {
    return invalid('invalid-retrieval', 'absenceReceipt.omissionReasons');
  }
  const scopeInput = input['scope'];
  if (!Array.isArray(scopeInput) || scopeInput.length === 0 || scopeInput.length > 1_000) {
    return invalid('invalid-retrieval', 'absenceReceipt.scope');
  }
  const scope: string[] = [];
  for (const path of scopeInput) {
    const previous = scope.at(-1);
    if (!isCanonicalRelativePath(path) || scope.includes(path) || (previous !== undefined && compareText(previous, path) >= 0)) {
      return invalid('invalid-retrieval', 'absenceReceipt.scope');
    }
    scope.push(path);
  }
  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: 'question-retrieval/1',
      binding: binding.value,
      snapshotId: input['snapshotId'] as string,
      generationId: input['generationId'] as string,
      manifestDigest: input['manifestDigest'] as string,
      normalizedQueryDigest: input['normalizedQueryDigest'] as string,
      scope: Object.freeze(scope),
      exactDefinitionScan: 'complete',
      guardedLiteralScan: 'complete',
      exactDefinitionMatchCount: 0,
      guardedLiteralMatchCount: 0,
      omissionReasons: Object.freeze([]) as readonly [],
    }),
  };
}
