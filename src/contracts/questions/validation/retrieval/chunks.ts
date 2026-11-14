import type {
  QuestionDefinitionOriginV1,
  QuestionIndexedChunkKindV1,
  QuestionIndexedChunkV1,
  QuestionIndexedFileTypeV1,
  QuestionIndexedFileV1,
  QuestionRetrievalOmissionReasonV1,
  QuestionValidationResult,
} from '../../contracts.ts';
import {
  hasExactKeys,
  invalid,
  isBoundedText,
  isCanonicalRelativePath,
  isNonNegativeSafeInteger,
  isOneOf,
  isPositiveSafeInteger,
  isRecord,
  MAX_QUESTION_CHUNK_LINES,
  MAX_QUESTION_CHUNK_NORMALIZED_BYTES,
  validateDigest,
  validateId,
  validateLineRange,
} from '../shared.ts';

const CHUNK_FILE_TYPES = ['python-source', 'python-test', 'documentation', 'configuration'] as const;
const CHUNK_KINDS = ['definition', 'module-text', 'documentation', 'configuration'] as const;
const OMISSION_REASONS: readonly QuestionRetrievalOmissionReasonV1[] = [
  'protected',
  'unreadable',
  'binary',
  'oversized',
  'parse-failure',
  'truncated',
  'partial-scan',
  'stale-binding',
  'budget-exhausted',
  'unavailable',
];
function validateDefinitionOrigin(input: unknown, path: string): QuestionValidationResult<QuestionDefinitionOriginV1> {
  if (!isRecord(input) || !hasExactKeys(input, ['definitionId', 'endLine', 'partOrder', 'qualifiedName', 'startLine'])) {
    return invalid('invalid-retrieval', path);
  }
  const idError = validateId(input['definitionId'], path + '.definitionId');
  if (idError) return { ok: false, errors: Object.freeze([Object.freeze(idError)]) };
  if (!isBoundedText(input['qualifiedName'], 512)) return invalid('invalid-retrieval', path + '.qualifiedName');
  const range = validateLineRange({ startLine: input['startLine'], endLine: input['endLine'] }, path);
  if (!range.ok) return range;
  if (!isNonNegativeSafeInteger(input['partOrder'])) return invalid('invalid-retrieval', path + '.partOrder');
  return {
    ok: true,
    value: Object.freeze({
      definitionId: input['definitionId'] as string,
      qualifiedName: input['qualifiedName'],
      ...range.value,
      partOrder: input['partOrder'],
    }),
  };
}

/** Validates persisted chunk metadata without admitting or retaining source text. */
export function validateQuestionIndexedChunk(input: unknown): QuestionValidationResult<QuestionIndexedChunkV1> {
  const keys = [
    'chunkId',
    'definition',
    'endLine',
    'excerptDigest',
    'fileType',
    'kind',
    'normalizedByteLength',
    'originalByteDigest',
    'path',
    'qualifiedSymbolName',
    'schemaVersion',
    'startLine',
    'symbolName',
    'vectorId',
  ];
  if (!isRecord(input) || !hasExactKeys(input, keys)) return invalid('invalid-retrieval', 'indexedChunk');
  if (input['schemaVersion'] !== 'question-retrieval/1') return invalid('invalid-retrieval', 'indexedChunk.schemaVersion');

  const idError = validateId(input['chunkId'], 'indexedChunk.chunkId') ?? validateId(input['vectorId'], 'indexedChunk.vectorId');
  if (idError) return { ok: false, errors: Object.freeze([Object.freeze(idError)]) };
  if (!isCanonicalRelativePath(input['path'])) return invalid('invalid-retrieval', 'indexedChunk.path');
  if (!isOneOf(input['fileType'], CHUNK_FILE_TYPES)) return invalid('invalid-retrieval', 'indexedChunk.fileType');
  if (!isOneOf(input['kind'], CHUNK_KINDS)) return invalid('invalid-retrieval', 'indexedChunk.kind');
  const originalDigestError = validateDigest(input['originalByteDigest'], 'indexedChunk.originalByteDigest');
  if (originalDigestError) return { ok: false, errors: Object.freeze([Object.freeze(originalDigestError)]) };
  const excerptDigestError = validateDigest(input['excerptDigest'], 'indexedChunk.excerptDigest');
  if (excerptDigestError) return { ok: false, errors: Object.freeze([Object.freeze(excerptDigestError)]) };
  if (!isPositiveSafeInteger(input['normalizedByteLength']) || input['normalizedByteLength'] > MAX_QUESTION_CHUNK_NORMALIZED_BYTES) {
    return invalid('invalid-retrieval', 'indexedChunk.normalizedByteLength');
  }
  const range = validateLineRange({ startLine: input['startLine'], endLine: input['endLine'] }, 'indexedChunk.range');
  if (!range.ok) return range;
  if (range.value.endLine - range.value.startLine + 1 > MAX_QUESTION_CHUNK_LINES) return invalid('invalid-range', 'indexedChunk.range');

  const definitionBased = input['kind'] === 'definition';
  let definition: QuestionDefinitionOriginV1 | null = null;
  let symbolName: string | null = null;
  let qualifiedSymbolName: string | null = null;
  if (definitionBased) {
    if (!isBoundedText(input['symbolName'], 512) || !isBoundedText(input['qualifiedSymbolName'], 1_024)) {
      return invalid('invalid-retrieval', 'indexedChunk.symbol');
    }
    const origin = validateDefinitionOrigin(input['definition'], 'indexedChunk.definition');
    if (!origin.ok) return origin;
    if (origin.value.qualifiedName !== input['qualifiedSymbolName'] || origin.value.startLine > range.value.startLine || origin.value.endLine < range.value.endLine) {
      return invalid('invalid-retrieval', 'indexedChunk.definition');
    }
    definition = origin.value;
    symbolName = input['symbolName'];
    qualifiedSymbolName = input['qualifiedSymbolName'];
  } else if (input['symbolName'] !== null || input['qualifiedSymbolName'] !== null || input['definition'] !== null) {
    return invalid('invalid-retrieval', 'indexedChunk.symbol');
  }

  const fileType = input['fileType'] as QuestionIndexedFileTypeV1;
  const kind = input['kind'] as QuestionIndexedChunkKindV1;
  const fileKindMatches =
    ((fileType === 'python-source' || fileType === 'python-test') && (kind === 'definition' || kind === 'module-text')) ||
    (fileType === 'documentation' && kind === 'documentation') ||
    (fileType === 'configuration' && kind === 'configuration');
  if (!fileKindMatches) return invalid('invalid-retrieval', 'indexedChunk.kind');

  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: 'question-retrieval/1',
      chunkId: input['chunkId'] as string,
      path: input['path'],
      fileType,
      kind,
      symbolName,
      qualifiedSymbolName,
      ...range.value,
      originalByteDigest: input['originalByteDigest'] as string,
      excerptDigest: input['excerptDigest'] as string,
      normalizedByteLength: input['normalizedByteLength'],
      vectorId: input['vectorId'] as string,
      definition,
    }),
  };
}

/** Validates safe per-file parse and coverage metadata; source bytes remain outside the index contract. */
export function validateQuestionIndexedFile(input: unknown): QuestionValidationResult<QuestionIndexedFileV1> {
  if (!isRecord(input) || !hasExactKeys(input, ['coverage', 'fileType', 'omissionReasons', 'originalByteDigest', 'path'])) {
    return invalid('invalid-retrieval', 'indexedFile');
  }
  if (!isCanonicalRelativePath(input['path'])) return invalid('invalid-retrieval', 'indexedFile.path');
  if (!isOneOf(input['fileType'], CHUNK_FILE_TYPES)) return invalid('invalid-retrieval', 'indexedFile.fileType');
  const digestError = validateDigest(input['originalByteDigest'], 'indexedFile.originalByteDigest');
  if (digestError) return { ok: false, errors: Object.freeze([Object.freeze(digestError)]) };
  if (!isOneOf(input['coverage'], ['complete', 'partial', 'excluded'] as const)) {
    return invalid('invalid-retrieval', 'indexedFile.coverage');
  }
  const reasons = input['omissionReasons'];
  if (!Array.isArray(reasons)) return invalid('invalid-retrieval', 'indexedFile.omissionReasons');
  const copiedReasons: QuestionRetrievalOmissionReasonV1[] = [];
  for (const reason of reasons) {
    if (!isOneOf(reason, OMISSION_REASONS) || copiedReasons.includes(reason)) {
      return invalid('invalid-retrieval', 'indexedFile.omissionReasons');
    }
    copiedReasons.push(reason);
  }
  const complete = input['coverage'] === 'complete';
  if ((complete && copiedReasons.length !== 0) || (!complete && copiedReasons.length === 0)) {
    return invalid('invalid-retrieval', 'indexedFile.coverage');
  }
  return {
    ok: true,
    value: Object.freeze({
      path: input['path'],
      originalByteDigest: input['originalByteDigest'] as string,
      fileType: input['fileType'],
      coverage: input['coverage'],
      omissionReasons: Object.freeze(copiedReasons),
    }),
  };
}
