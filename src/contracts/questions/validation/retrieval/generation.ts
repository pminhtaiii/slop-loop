import type { QuestionIndexGenerationV1, QuestionRetrievalRequestV1, QuestionValidationResult } from '../../contracts.ts';
import { validateQuestionIdentity, validateRepositoryBinding, validateRetrievalResourceLimits } from '../admission.ts';
import { hasExactKeys, invalid, isBoundedText, isRecord, validateDigest, validateId } from '../shared.ts';
/** Validates a committed or partial generation descriptor and its immutable binding. */
export function validateQuestionIndexGeneration(input: unknown): QuestionValidationResult<QuestionIndexGenerationV1> {
  const keys = ['binding', 'configDigest', 'coverage', 'embeddingDigest', 'generationId', 'manifestDigest', 'schemaVersion', 'snapshotId'];
  if (!isRecord(input) || !hasExactKeys(input, keys) || input['schemaVersion'] !== 'question-retrieval/1') {
    return invalid('invalid-retrieval', 'generation');
  }
  const binding = validateRepositoryBinding(input['binding']);
  if (!binding.ok) return binding;
  const idError = validateId(input['generationId'], 'generation.generationId') ?? validateId(input['snapshotId'], 'generation.snapshotId');
  if (idError) return { ok: false, errors: Object.freeze([Object.freeze(idError)]) };
  for (const key of ['manifestDigest', 'configDigest', 'embeddingDigest']) {
    const error = validateDigest(input[key], 'generation.' + key);
    if (error) return { ok: false, errors: Object.freeze([Object.freeze(error)]) };
  }
  if (input['coverage'] !== 'complete' && input['coverage'] !== 'partial') {
    return invalid('invalid-retrieval', 'generation.coverage');
  }
  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: 'question-retrieval/1',
      generationId: input['generationId'] as string,
      binding: binding.value,
      snapshotId: input['snapshotId'] as string,
      manifestDigest: input['manifestDigest'] as string,
      configDigest: input['configDigest'] as string,
      embeddingDigest: input['embeddingDigest'] as string,
      coverage: input['coverage'],
    }),
  };
}

/** Validates a question-bound retrieval request and all finite retrieval caps before query work. */
export function validateQuestionRetrievalRequest(input: unknown): QuestionValidationResult<QuestionRetrievalRequestV1> {
  if (!isRecord(input) || !hasExactKeys(input, ['generationId', 'identity', 'limits', 'queryText', 'schemaVersion'])) {
    return invalid('invalid-retrieval', 'retrievalRequest');
  }
  if (input['schemaVersion'] !== 'question-retrieval/1') return invalid('invalid-retrieval', 'retrievalRequest.schemaVersion');
  const identity = validateQuestionIdentity(input['identity']);
  if (!identity.ok) return identity;
  const idError = validateId(input['generationId'], 'retrievalRequest.generationId');
  if (idError) return { ok: false, errors: Object.freeze([Object.freeze(idError)]) };
  if (!isBoundedText(input['queryText'], 16_384)) return invalid('invalid-retrieval', 'retrievalRequest.queryText');
  const limits = validateRetrievalResourceLimits(input['limits']);
  if (!limits.ok) return limits;
  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: 'question-retrieval/1',
      identity: identity.value,
      generationId: input['generationId'] as string,
      queryText: input['queryText'],
      limits: limits.value,
    }),
  };
}
