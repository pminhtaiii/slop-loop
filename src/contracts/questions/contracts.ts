/** Stable schemas and immutable boundary shapes for the read-only question runtime. */
export const QUESTION_CONTRACT_VERSIONS = Object.freeze({
  question: 'repository-question/1',
  repository: 'question-repository/1',
  retrieval: 'question-retrieval/1',
  budget: 'question-budget/1',
} as const);

export interface QuestionValidationError {
  readonly code:
    'invalid-shape' | 'invalid-id' | 'invalid-digest' | 'invalid-range' | 'invalid-limit' | 'invalid-decision' | 'invalid-usage' | 'invalid-retrieval' | 'invalid-repository' | 'invalid-result';
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
  readonly pathPrefix?: string;
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

export interface SourceManifestEntryV1 {
  readonly path: string;
  readonly originalByteDigest: string;
}

/** Metadata for a host-admitted source. Serialized metadata does not establish a snapshot lease. */
export interface SourceSnapshotV1 {
  readonly snapshotId: string;
  readonly binding: RepositoryBindingV1;
  readonly manifestDigest: string;
  readonly acquisitionId: string;
  readonly admissionLimits: Readonly<{ maxFiles: number; maxBytes: number; maxElapsedMs: number }>;
  readonly manifest: readonly SourceManifestEntryV1[];
}

export type SpanTruncationV1 = { readonly kind: 'none' } | { readonly kind: 'truncated'; readonly nextLine: number };

/** Whole normalized lines joined by LF. Only the current-run registry establishes issuance. */
export interface AdmittedSpanV1 {
  readonly identity: QuestionIdentityV1;
  readonly evidenceId: string;
  readonly snapshotId: string;
  readonly manifestDigest: string;
  readonly path: string;
  readonly range: QuestionLineRangeV1;
  readonly excerpt: string;
  readonly excerptDigest: string;
  readonly originalByteDigest: string;
  readonly truncation: SpanTruncationV1;
}

export type RepositoryToolFailureV1 =
  | { readonly status: 'denied'; readonly reasonCode: 'protected' | 'outside-scope' | 'read-not-authorized' }
  | { readonly status: 'stale'; readonly reasonCode: 'binding-mismatch' | 'source-mismatch' }
  | { readonly status: 'invalid'; readonly reasonCode: 'invalid-request' | 'invalid-cursor' | 'out-of-range' | 'line-too-large' }
  | { readonly status: 'unavailable'; readonly reasonCode: 'unreadable' | 'binary' | 'oversized' | 'unsupported-adapter' }
  | { readonly status: 'exhausted'; readonly reasonCode: 'scan-limit' | 'output-limit' | 'deadline' }
  | { readonly status: 'cancelled'; readonly reasonCode: 'cancelled' };

export type RepositoryOmissionReasonV1 = 'protected' | 'outside-scope' | 'unreadable' | 'binary' | 'oversized' | 'line-too-large' | 'scan-limit' | 'output-limit';

interface RepositoryPageCoverageV1 {
  readonly coverage: 'complete' | 'partial';
  readonly omissionReasons: readonly RepositoryOmissionReasonV1[];
  readonly nextCursor?: string;
}

export interface DirectoryEntryV1 {
  readonly path: string;
  readonly kind: 'file' | 'directory';
}

export type DirectoryPageV1 =
  | RepositoryToolFailureV1
  | (RepositoryPageCoverageV1 & {
      readonly status: 'ok';
      readonly path: string;
      readonly entries: readonly DirectoryEntryV1[];
    });

export type SpanResultV1 = RepositoryToolFailureV1 | { readonly status: 'ok'; readonly span: AdmittedSpanV1 };

export interface SearchHitV1 {
  readonly span: AdmittedSpanV1;
  readonly line: number;
  readonly column: number;
  readonly matchLength: number;
}

export type SearchPageV1 =
  | RepositoryToolFailureV1
  | (RepositoryPageCoverageV1 & {
      readonly status: 'ok';
      readonly hits: readonly SearchHitV1[];
    });

export interface QuestionCitationV1 extends QuestionEvidenceReferenceV1 {
  readonly path: string;
  readonly originalByteDigest: string;
  readonly excerptDigest: string;
}

export interface QuestionClarificationV1 extends Omit<ClarifyQuestionDecisionV1, 'kind'> {
  readonly clarificationId: string;
  readonly round: number;
}

interface QuestionResultBaseV1 {
  readonly schemaVersion: 'repository-question/1';
  readonly identity: QuestionIdentityV1;
  readonly usage: QuestionUsageV1;
}

export type QuestionClosedOutcomeV1 =
  | { readonly kind: 'budget-exhausted'; readonly reasonCode: 'tool-limit' | 'model-limit' | 'scan-limit' | 'output-limit' | 'token-limit' | 'cost-limit' | 'elapsed-deadline' }
  | { readonly kind: 'stale-repository'; readonly reasonCode: 'binding-mismatch' | 'source-mismatch' }
  | { readonly kind: 'cancelled'; readonly reasonCode: 'cancelled' }
  | { readonly kind: 'blocked'; readonly reasonCode: 'accounting-unknown' | 'owner-denied' | 'owner-unavailable' | 'context-limit' }
  | { readonly kind: 'failed'; readonly reasonCode: 'invalid-decision' | 'invalid-citation' | 'protected-content' | 'invalid-usage' | 'render-limit' };

/** A run outcome. Closed activity has no source-bearing or clarification payload. */
export type QuestionResultV1 = QuestionResultBaseV1 &
  (
    | { readonly kind: 'answered'; readonly claims: readonly QuestionClaimV1[]; readonly citations: readonly QuestionCitationV1[]; readonly limitations: readonly string[] }
    | { readonly kind: 'awaiting-clarification'; readonly clarification: QuestionClarificationV1 }
    | {
        readonly kind: 'insufficient-evidence';
        readonly claims: readonly QuestionClaimV1[];
        readonly citations: readonly QuestionCitationV1[];
        readonly limitations: readonly string[];
        readonly explanation: string;
      }
    | QuestionClosedOutcomeV1
  );
