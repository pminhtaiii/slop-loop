import type { QuestionBudgetProfileV1, QuestionIdentityV1, QuestionValidationError, QuestionValidationResult, RepositoryBindingV1, RetrievalResourceLimitsV1 } from '../contracts.ts';
import { hasExactKeys, invalid, isRecord, validateDigest, validateId } from './shared.ts';

const IDENTITY_KEYS = ['binding', 'configDigest', 'questionId', 'runId', 'sessionId', 'taskId'];
const BINDING_KEYS = ['policyDigest', 'repositoryId', 'revisionDigest', 'workspaceId'];
const RUNTIME_LIMIT_KEYS = [
  'maxToolCalls',
  'maxModelCalls',
  'maxScannedFiles',
  'maxScannedBytes',
  'maxReturnedBytes',
  'maxInputTokensPerCall',
  'maxOutputTokensPerCall',
  'maxBillableTokensTask',
  'maxCostMicrosTask',
  'maxElapsedMsTask',
  'maxClarificationRounds',
  'maxConversationBytes',
  'maxFinalBytes',
] as const;
const REPOSITORY_LIMIT_KEYS = ['maxFileBytes', 'maxSpanBytes', 'maxSpanLines', 'maxPageEntries', 'maxSearchHits', 'maxQueryBytes', 'maxPathBytes'] as const;
const RETRIEVAL_LIMIT_KEYS = [
  'maxFiles',
  'maxChunks',
  'maxVectorDimensions',
  'maxBatchSize',
  'maxConcurrentIndexWriters',
  'maxConcurrentRetrievalWorkers',
  'maxIndexDiskBytes',
  'maxSqliteCacheBytes',
  'maxWorkerMemoryBytes',
  'maxExactScanVectors',
  'maxIndexDeadlineMs',
  'maxRetrievalDeadlineMs',
] as const;

/** Validates and detaches the host-selected question identity and repository binding. */
export function validateQuestionIdentity(input: unknown): QuestionValidationResult<QuestionIdentityV1> {
  if (!isRecord(input) || !hasExactKeys(input, IDENTITY_KEYS)) return invalid('invalid-shape', 'identity');
  if (!isRecord(input['binding']) || !hasExactKeys(input['binding'], BINDING_KEYS)) {
    return invalid('invalid-shape', 'binding');
  }

  const errors = [
    validateId(input['sessionId'], 'sessionId'),
    validateId(input['taskId'], 'taskId'),
    validateId(input['runId'], 'runId'),
    validateId(input['questionId'], 'questionId'),
    validateId(input['binding']['repositoryId'], 'binding.repositoryId'),
    validateId(input['binding']['workspaceId'], 'binding.workspaceId'),
    validateDigest(input['binding']['revisionDigest'], 'binding.revisionDigest'),
    validateDigest(input['binding']['policyDigest'], 'binding.policyDigest'),
    validateDigest(input['configDigest'], 'configDigest'),
  ].filter((error): error is QuestionValidationError => error !== undefined);
  if (errors.length > 0) return { ok: false, errors: Object.freeze(errors.map(error => Object.freeze(error))) };

  const binding: RepositoryBindingV1 = Object.freeze({
    repositoryId: input['binding']['repositoryId'] as string,
    workspaceId: input['binding']['workspaceId'] as string,
    revisionDigest: input['binding']['revisionDigest'] as string,
    policyDigest: input['binding']['policyDigest'] as string,
  });
  return {
    ok: true,
    value: Object.freeze({
      sessionId: input['sessionId'] as string,
      taskId: input['taskId'] as string,
      runId: input['runId'] as string,
      questionId: input['questionId'] as string,
      binding,
      configDigest: input['configDigest'] as string,
    }),
  };
}

function validatePositiveLimits(input: unknown, expectedKeys: readonly string[], path: string): QuestionValidationResult<Readonly<Record<string, number>>> {
  if (!isRecord(input) || !hasExactKeys(input, expectedKeys)) return invalid('invalid-shape', path);
  const values: Record<string, number> = {};
  const errors: QuestionValidationError[] = [];
  for (const key of expectedKeys) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      errors.push({ code: 'invalid-limit', path: path + '.' + key });
    } else {
      values[key] = value;
    }
  }
  if (errors.length > 0) return { ok: false, errors: Object.freeze(errors.map(error => Object.freeze(error))) };
  // Exact keys and integer checks above establish that every required limit is present.
  return { ok: true, value: Object.freeze(values) };
}

/** Validates all finite question, repository, and retrieval caps before any operation is admitted. */
export function validateQuestionBudgetProfile(input: unknown): QuestionValidationResult<QuestionBudgetProfileV1> {
  if (!isRecord(input) || !hasExactKeys(input, ['repository', 'retrieval', 'runtime', 'schemaVersion'])) {
    return invalid('invalid-shape', 'budgetProfile');
  }
  if (input['schemaVersion'] !== 'question-budget/1') {
    return invalid('invalid-shape', 'budgetProfile.schemaVersion');
  }

  const runtime = validatePositiveLimits(input['runtime'], RUNTIME_LIMIT_KEYS, 'runtime');
  if (!runtime.ok) return runtime;
  const repository = validatePositiveLimits(input['repository'], REPOSITORY_LIMIT_KEYS, 'repository');
  if (!repository.ok) return repository;
  const retrieval = validateRetrievalResourceLimits(input['retrieval']);
  if (!retrieval.ok) return retrieval;

  const runtimeLimits = runtime.value;
  const repositoryLimits = repository.value;
  const retrievalLimits = retrieval.value;
  // Each asserted value was checked as a positive safe integer under the exact key list above.
  const value: QuestionBudgetProfileV1 = Object.freeze({
    schemaVersion: 'question-budget/1',
    runtime: Object.freeze({
      maxToolCalls: runtimeLimits['maxToolCalls'] as number,
      maxModelCalls: runtimeLimits['maxModelCalls'] as number,
      maxScannedFiles: runtimeLimits['maxScannedFiles'] as number,
      maxScannedBytes: runtimeLimits['maxScannedBytes'] as number,
      maxReturnedBytes: runtimeLimits['maxReturnedBytes'] as number,
      maxInputTokensPerCall: runtimeLimits['maxInputTokensPerCall'] as number,
      maxOutputTokensPerCall: runtimeLimits['maxOutputTokensPerCall'] as number,
      maxBillableTokensTask: runtimeLimits['maxBillableTokensTask'] as number,
      maxCostMicrosTask: runtimeLimits['maxCostMicrosTask'] as number,
      maxElapsedMsTask: runtimeLimits['maxElapsedMsTask'] as number,
      maxClarificationRounds: runtimeLimits['maxClarificationRounds'] as number,
      maxConversationBytes: runtimeLimits['maxConversationBytes'] as number,
      maxFinalBytes: runtimeLimits['maxFinalBytes'] as number,
    }),
    repository: Object.freeze({
      maxFileBytes: repositoryLimits['maxFileBytes'] as number,
      maxSpanBytes: repositoryLimits['maxSpanBytes'] as number,
      maxSpanLines: repositoryLimits['maxSpanLines'] as number,
      maxPageEntries: repositoryLimits['maxPageEntries'] as number,
      maxSearchHits: repositoryLimits['maxSearchHits'] as number,
      maxQueryBytes: repositoryLimits['maxQueryBytes'] as number,
      maxPathBytes: repositoryLimits['maxPathBytes'] as number,
    }),
    retrieval: Object.freeze({
      maxFiles: retrievalLimits['maxFiles'] as number,
      maxChunks: retrievalLimits['maxChunks'] as number,
      maxVectorDimensions: retrievalLimits['maxVectorDimensions'] as number,
      maxBatchSize: retrievalLimits['maxBatchSize'] as number,
      maxConcurrentIndexWriters: retrievalLimits['maxConcurrentIndexWriters'] as number,
      maxConcurrentRetrievalWorkers: retrievalLimits['maxConcurrentRetrievalWorkers'] as number,
      maxIndexDiskBytes: retrievalLimits['maxIndexDiskBytes'] as number,
      maxSqliteCacheBytes: retrievalLimits['maxSqliteCacheBytes'] as number,
      maxWorkerMemoryBytes: retrievalLimits['maxWorkerMemoryBytes'] as number,
      maxExactScanVectors: retrievalLimits['maxExactScanVectors'] as number,
      maxIndexDeadlineMs: retrievalLimits['maxIndexDeadlineMs'] as number,
      maxRetrievalDeadlineMs: retrievalLimits['maxRetrievalDeadlineMs'] as number,
    }),
  });
  return { ok: true, value };
}
/** Validates and copies the immutable host-selected repository binding. */
export function validateRepositoryBinding(input: unknown): QuestionValidationResult<RepositoryBindingV1> {
  if (!isRecord(input) || !hasExactKeys(input, BINDING_KEYS)) return invalid('invalid-shape', 'binding');
  const errors = [
    validateId(input['repositoryId'], 'binding.repositoryId'),
    validateId(input['workspaceId'], 'binding.workspaceId'),
    validateDigest(input['revisionDigest'], 'binding.revisionDigest'),
    validateDigest(input['policyDigest'], 'binding.policyDigest'),
  ].filter((error): error is QuestionValidationError => error !== undefined);
  if (errors.length > 0) return { ok: false, errors: Object.freeze(errors.map(error => Object.freeze(error))) };
  return {
    ok: true,
    value: Object.freeze({
      repositoryId: input['repositoryId'] as string,
      workspaceId: input['workspaceId'] as string,
      revisionDigest: input['revisionDigest'] as string,
      policyDigest: input['policyDigest'] as string,
    }),
  };
}

/** Validates the retrieval-only resource caps used before indexing or ranking. */
export function validateRetrievalResourceLimits(input: unknown): QuestionValidationResult<RetrievalResourceLimitsV1> {
  const limits = validatePositiveLimits(input, RETRIEVAL_LIMIT_KEYS, 'retrieval');
  if (!limits.ok) return limits;
  const values = limits.value;
  // Exact keys and safe-positive-integer checks establish every normalized field below.
  const normalized: RetrievalResourceLimitsV1 = Object.freeze({
    maxFiles: values['maxFiles'] as number,
    maxChunks: values['maxChunks'] as number,
    maxVectorDimensions: values['maxVectorDimensions'] as number,
    maxBatchSize: values['maxBatchSize'] as number,
    maxConcurrentIndexWriters: values['maxConcurrentIndexWriters'] as number,
    maxConcurrentRetrievalWorkers: values['maxConcurrentRetrievalWorkers'] as number,
    maxIndexDiskBytes: values['maxIndexDiskBytes'] as number,
    maxSqliteCacheBytes: values['maxSqliteCacheBytes'] as number,
    maxWorkerMemoryBytes: values['maxWorkerMemoryBytes'] as number,
    maxExactScanVectors: values['maxExactScanVectors'] as number,
    maxIndexDeadlineMs: values['maxIndexDeadlineMs'] as number,
    maxRetrievalDeadlineMs: values['maxRetrievalDeadlineMs'] as number,
  });
  const ceilings = [
    ['maxFiles', 2_000],
    ['maxChunks', 20_000],
    ['maxVectorDimensions', 384],
    ['maxBatchSize', 32],
    ['maxConcurrentIndexWriters', 1],
    ['maxConcurrentRetrievalWorkers', 1],
    ['maxIndexDiskBytes', 512 * 1024 * 1024],
    ['maxSqliteCacheBytes', 32 * 1024 * 1024],
    ['maxWorkerMemoryBytes', 1024 * 1024 * 1024],
    ['maxExactScanVectors', 20_000],
    ['maxIndexDeadlineMs', 120_000],
    ['maxRetrievalDeadlineMs', 10_000],
  ] as const;
  for (const [key, ceiling] of ceilings) {
    if (normalized[key] > ceiling) return invalid('invalid-limit', 'retrieval.' + key);
  }
  return { ok: true, value: normalized };
}
