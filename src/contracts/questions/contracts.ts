/** Stable schemas and immutable boundary shapes for the read-only question runtime. */
export const QUESTION_CONTRACT_VERSIONS = Object.freeze({
  question: 'repository-question/1',
  retrieval: 'question-retrieval/1',
  budget: 'question-budget/1',
} as const);

export interface QuestionValidationError {
  readonly code: 'invalid-shape' | 'invalid-id' | 'invalid-digest' | 'invalid-range' | 'invalid-limit' | 'invalid-decision' | 'invalid-usage' | 'invalid-retrieval';
  readonly path: string;
}

export type QuestionValidationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly QuestionValidationError[] };

export interface RepositoryBindingV1 {
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly revisionDigest: string;
  readonly policyDigest: string;
}

export interface QuestionIdentityV1 {
  readonly sessionId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly questionId: string;
  readonly binding: RepositoryBindingV1;
  readonly configDigest: string;
}
export interface QuestionRuntimeBudgetV1 {
  readonly maxToolCalls: number;
  readonly maxModelCalls: number;
  readonly maxScannedFiles: number;
  readonly maxScannedBytes: number;
  readonly maxReturnedBytes: number;
  readonly maxInputTokensPerCall: number;
  readonly maxOutputTokensPerCall: number;
  readonly maxBillableTokensTask: number;
  readonly maxCostMicrosTask: number;
  readonly maxElapsedMsTask: number;
  readonly maxClarificationRounds: number;
  readonly maxConversationBytes: number;
  readonly maxFinalBytes: number;
}

export interface RepositoryOperationLimitsV1 {
  readonly maxFileBytes: number;
  readonly maxSpanBytes: number;
  readonly maxSpanLines: number;
  readonly maxPageEntries: number;
  readonly maxSearchHits: number;
  readonly maxQueryBytes: number;
  readonly maxPathBytes: number;
}

export interface RetrievalResourceLimitsV1 {
  readonly maxFiles: number;
  readonly maxChunks: number;
  readonly maxVectorDimensions: number;
  readonly maxBatchSize: number;
  readonly maxConcurrentIndexWriters: number;
  readonly maxConcurrentRetrievalWorkers: number;
  readonly maxIndexDiskBytes: number;
  readonly maxSqliteCacheBytes: number;
  readonly maxWorkerMemoryBytes: number;
  readonly maxExactScanVectors: number;
  readonly maxIndexDeadlineMs: number;
  readonly maxRetrievalDeadlineMs: number;
}

export interface QuestionBudgetProfileV1 {
  readonly schemaVersion: 'question-budget/1';
  readonly runtime: QuestionRuntimeBudgetV1;
  readonly repository: RepositoryOperationLimitsV1;
  readonly retrieval: RetrievalResourceLimitsV1;
}

export interface QuestionLineRangeV1 {
  readonly startLine: number;
  readonly endLine: number;
}

export interface QuestionEvidenceReferenceV1 {
  readonly evidenceId: string;
  readonly range: QuestionLineRangeV1;
}

export interface QuestionClaimV1 {
  readonly claimId: string;
  readonly text: string;
  readonly kind: 'observation' | 'inference';
  readonly evidence: readonly QuestionEvidenceReferenceV1[];
}

export interface ListQuestionFilesDecisionV1 {
  readonly kind: 'list';
  readonly path: string;
  readonly cursor?: string;
}

export interface SearchQuestionFilesDecisionV1 {
  readonly kind: 'search';
  readonly query: string;
  readonly path?: string;
  readonly cursor?: string;
}

export interface ReadQuestionSpanDecisionV1 {
  readonly kind: 'read';
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface AnswerQuestionDecisionV1 {
  readonly kind: 'answer';
  readonly claims: readonly QuestionClaimV1[];
  readonly limitations: readonly string[];
}

export interface ClarifyQuestionDecisionV1 {
  readonly kind: 'clarify';
  readonly question: string;
  readonly explanation: string;
  readonly unresolvedReferents: readonly string[];
}

export interface InsufficientQuestionDecisionV1 {
  readonly kind: 'insufficient';
  readonly explanation: string;
  readonly claims?: readonly QuestionClaimV1[];
}

export type QuestionModelDecisionV1 =
  ListQuestionFilesDecisionV1 | SearchQuestionFilesDecisionV1 | ReadQuestionSpanDecisionV1 | AnswerQuestionDecisionV1 | ClarifyQuestionDecisionV1 | InsufficientQuestionDecisionV1;

export type QuestionUsageV1 =
  | { readonly status: 'complete'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly status: 'missing' }
  | {
      readonly status: 'unknown';
      readonly reasonCode: QuestionUsageUnknownReasonV1;
    };

export interface QuestionModelResponseV1 {
  readonly decision: QuestionModelDecisionV1;
  readonly usage: QuestionUsageV1;
}

export type QuestionUsageUnknownReasonV1 = 'provider-error' | 'timeout' | 'invalid-metadata' | 'over-reservation' | 'cancelled' | 'unknown';

export type QuestionIndexedFileTypeV1 = 'python-source' | 'python-test' | 'documentation' | 'configuration';
export type QuestionIndexedChunkKindV1 = 'definition' | 'module-text' | 'documentation' | 'configuration';

export interface QuestionDefinitionOriginV1 {
  readonly definitionId: string;
  readonly qualifiedName: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly partOrder: number;
}

/** Persisted metadata only; source text is always re-read through the guarded repository reader. */
export interface QuestionIndexedChunkV1 {
  readonly schemaVersion: 'question-retrieval/1';
  readonly chunkId: string;
  readonly path: string;
  readonly fileType: QuestionIndexedFileTypeV1;
  readonly kind: QuestionIndexedChunkKindV1;
  readonly symbolName: string | null;
  readonly qualifiedSymbolName: string | null;
  readonly startLine: number;
  readonly endLine: number;
  readonly originalByteDigest: string;
  readonly excerptDigest: string;
  readonly normalizedByteLength: number;
  readonly vectorId: string;
  readonly definition: QuestionDefinitionOriginV1 | null;
}

export type QuestionCoverageStateV1 = 'complete' | 'partial' | 'excluded';
export type QuestionRetrievalOmissionReasonV1 =
  'protected' | 'unreadable' | 'binary' | 'oversized' | 'parse-failure' | 'truncated' | 'partial-scan' | 'stale-binding' | 'budget-exhausted' | 'unavailable';

export interface QuestionIndexedFileV1 {
  readonly path: string;
  readonly originalByteDigest: string;
  readonly fileType: QuestionIndexedFileTypeV1;
  readonly coverage: QuestionCoverageStateV1;
  readonly omissionReasons: readonly QuestionRetrievalOmissionReasonV1[];
}

export interface QuestionIndexGenerationV1 {
  readonly schemaVersion: 'question-retrieval/1';
  readonly generationId: string;
  readonly binding: RepositoryBindingV1;
  readonly snapshotId: string;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly embeddingDigest: string;
  readonly coverage: 'complete' | 'partial';
}

export interface QuestionRetrievalRequestV1 {
  readonly schemaVersion: 'question-retrieval/1';
  readonly identity: QuestionIdentityV1;
  readonly generationId: string;
  readonly queryText: string;
  readonly limits: RetrievalResourceLimitsV1;
}

export type QuestionRetrievalLaneV1 = 'exact-qualified' | 'exact-simple' | 'semantic';

export interface QuestionRankedChunkV1 {
  readonly chunkId: string;
  readonly lane: QuestionRetrievalLaneV1;
  readonly rank: number;
  readonly score: number;
  readonly path: string;
  readonly revisionDigest: string;
  readonly originalByteDigest: string;
  readonly excerptDigest: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly normalizedByteLength: number;
  readonly embeddingInputTokens: number;
}

export type QuestionRetrievalFailureStatusV1 = 'busy' | 'stale' | 'unavailable' | 'invalid' | 'exhausted' | 'cancelled';
export type QuestionRetrievalFailureReasonV1 =
  'binding-mismatch' | 'generation-missing' | 'generation-incompatible' | 'scan-limit' | 'deadline' | 'cancelled' | 'invalid-request' | 'store-unavailable' | 'busy';

export type QuestionRetrievalResultV1 =
  | {
      readonly schemaVersion: 'question-retrieval/1';
      readonly status: 'complete';
      readonly binding: RepositoryBindingV1;
      readonly generationId: string;
      readonly manifestDigest: string;
      readonly configDigest: string;
      readonly embeddingDigest: string;
      readonly ranked: readonly QuestionRankedChunkV1[];
    }
  | {
      readonly schemaVersion: 'question-retrieval/1';
      readonly status: 'empty';
      readonly binding: RepositoryBindingV1;
      readonly generationId: string;
      readonly manifestDigest: string;
      readonly configDigest: string;
      readonly embeddingDigest: string;
      readonly ranked: readonly [];
    }
  | {
      readonly schemaVersion: 'question-retrieval/1';
      readonly status: QuestionRetrievalFailureStatusV1;
      readonly reasonCode: QuestionRetrievalFailureReasonV1;
    };

export interface QuestionAbsenceReceiptV1 {
  readonly schemaVersion: 'question-retrieval/1';
  readonly binding: RepositoryBindingV1;
  readonly snapshotId: string;
  readonly generationId: string;
  readonly manifestDigest: string;
  readonly normalizedQueryDigest: string;
  readonly scope: readonly string[];
  readonly exactDefinitionScan: 'complete';
  readonly guardedLiteralScan: 'complete';
  readonly exactDefinitionMatchCount: 0;
  readonly guardedLiteralMatchCount: 0;
  readonly omissionReasons: readonly [];
}
