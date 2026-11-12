/** UC-06 additive companion records. Canonical UC-03/provider schemas remain unchanged. */
import type { ReviewResult, SourceEvidence, TrustedDiffLines, ValidationResult } from './foundation/uc03.ts';
import { deepFreeze } from './foundation/uc03/v02/admission/snapshot.ts';
export interface ReviewProfileV1 {
  readonly profileId: string;
  readonly profileVersion: string;
  readonly promptVersion: string;
  readonly promptDigest: string;
  readonly requiredConventionPaths: readonly string[];
  readonly optionalEvidenceRefs: readonly string[];
  readonly maxDiffBytes: number;
  readonly maxContextBytes: number;
  readonly maxEvidenceItems: number;
  readonly maxEvidenceBytes: number;
  readonly maxFindings: number;
  readonly maxMessageBytes: number;
  readonly maxOutputBytes: number;
  readonly maxResponseBytes: number;
}
export interface ReviewBindingV1 {
  readonly taskId: string;
  readonly runId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly baseRevisionDigest: string;
  readonly headRevisionDigest: string;
  readonly diffDigest: string;
  readonly criteriaDigest: string;
  readonly checkSetDigest: string;
  readonly verificationDigest: string;
  readonly conventionsDigest: string;
  readonly evidenceDigest: string;
  readonly profileDigest: string;
}
export interface ReviewAuthorityV1 {
  readonly taskStateVersion: number;
  readonly controlVersion: number;
  readonly epoch: number;
  readonly decisionAuthorityGeneration: number;
  readonly planDecisionRef: string;
  readonly planBindingDigest: string;
}
export interface ReviewEvidenceV1 {
  readonly evidenceRef: string;
  readonly path: string;
  readonly revisionDigest: string;
  readonly contentDigest: string;
  readonly kind: 'requirement' | 'convention' | 'verification' | 'source';
}
export interface ReviewConventionV1 {
  readonly path: string;
  readonly revisionDigest: string;
  readonly contentDigest: string;
  readonly evidenceRef: string;
}
export interface ReviewVerificationV1 {
  readonly baselineRef: string;
  readonly results: readonly {
    readonly evidenceId: string;
    readonly checkId: string;
    readonly phase: 'focused' | 'regression' | 'compatibility' | 'diff';
    readonly outcome: 'pass';
    readonly repoDigest: string;
    readonly diffDigest: string;
    readonly contentDigest: string;
  }[];
}
export interface ReviewContextV1 {
  readonly schemaVersion: 'uc06-review-context/1';
  readonly binding: ReviewBindingV1;
  readonly authority: ReviewAuthorityV1;
  readonly profile: ReviewProfileV1;
  readonly verification: ReviewVerificationV1;
  readonly conventions: readonly ReviewConventionV1[];
  readonly evidence: readonly ReviewEvidenceV1[];
  readonly contextDigest: string;
}
export type ReviewReasonV1 =
  | 'OK'
  | 'FINDINGS'
  | 'INPUT_UNSUPPORTED'
  | 'REQUIRED_EVIDENCE_MISSING'
  | 'BINDING_STALE'
  | 'AUTHORITY_UNAVAILABLE'
  | 'LIMIT_INVALID'
  | 'BUDGET_EXHAUSTED'
  | 'MODEL_OUTPUT_INVALID'
  | 'PROVIDER_TIMEOUT'
  | 'USAGE_UNCERTAIN'
  | 'EVIDENCE_UNACKNOWLEDGED';
export interface ReviewObservationV1 {
  readonly schemaVersion: 'uc06-review-observation/1';
  readonly contextDigest: string;
  readonly binding: ReviewBindingV1;
  readonly authority: ReviewAuthorityV1;
  readonly reviewId: string | null;
  readonly providerRequestId: string | null;
  readonly status: 'accepted' | 'findings' | 'invalid' | 'stale' | 'blocked' | 'uncertain';
  readonly reasonCode: ReviewReasonV1;
  readonly result: ReviewResult | null;
  readonly accountingRefs: readonly string[];
  readonly evidenceTier: 'unit' | 'controlled' | 'real-provider' | 'real-integration';
}
export interface ReviewEvidenceAckV1 {
  readonly schemaVersion: 'uc06-review-evidence/1';
  readonly receiptId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly headRevisionDigest: string;
  readonly diffDigest: string;
  readonly contextDigest: string;
  readonly providerRequestId: string | null;
  readonly observationDigest: string;
  readonly storeRecordVersion: number;
  readonly committed: true;
}
export interface PersistReviewObservationRequestV1 {
  readonly observation: ReviewObservationV1;
  readonly observationDigest: string;
  readonly expectedAuthority: ReviewAuthorityV1;
  readonly idempotencyKey: string;
}
export interface LoadReviewObservationRequestV1 {
  readonly taskId: string;
  readonly runId: string;
  readonly providerRequestId: string | null;
  readonly contextDigest: string;
  readonly observationDigest: string;
  readonly expectedAuthority: ReviewAuthorityV1;
}
export interface RecoverReviewObservationRequestV1 {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly headRevisionDigest: string;
  readonly diffDigest: string;
  readonly expectedAuthority: ReviewAuthorityV1;
  readonly operationRef?: string;
}
export interface ReviewEvidenceRefusalV1 {
  readonly outcome: 'conflict' | 'denied';
  readonly reasonCode: 'BINDING_STALE' | 'AUTHORITY_UNAVAILABLE' | 'MODEL_OUTPUT_INVALID';
}
export interface ReviewEvidenceFoundV1 {
  readonly outcome: 'found';
  readonly observation: ReviewObservationV1;
  readonly ack: ReviewEvidenceAckV1;
}
export type PersistReviewObservationResultV1 =
  { readonly outcome: 'acknowledged'; readonly ack: ReviewEvidenceAckV1 } | ReviewEvidenceRefusalV1 | { readonly outcome: 'uncertain'; readonly operationRef: string };
export type LoadReviewObservationResultV1 = ReviewEvidenceFoundV1 | ReviewEvidenceRefusalV1 | { readonly outcome: 'missing' };
export type RecoverReviewObservationResultV1 = LoadReviewObservationResultV1 | { readonly outcome: 'uncertain'; readonly operationRef: string };
/** Owner-provided durable supplement; shape/provenance alone grants no storage or completion authority. */
export interface ReviewEvidencePortV1 {
  readonly reviewEvidenceApiVersion: 'uc06-review-evidence/1';
  readonly provenance: 'mock' | 'real';
  persistObservation(request: PersistReviewObservationRequestV1): Promise<PersistReviewObservationResultV1>;
  loadObservation(request: LoadReviewObservationRequestV1): Promise<LoadReviewObservationResultV1>;
  recoverObservation(request: RecoverReviewObservationRequestV1): Promise<RecoverReviewObservationResultV1>;
}
export interface ReviewContextAdmissionV1 {
  readonly binding: ReviewBindingV1;
  readonly authority: ReviewAuthorityV1;
  readonly sourceEvidence: readonly SourceEvidence[];
  readonly requiredCheckIds: readonly string[];
}
export interface ReviewOutputV1 {
  readonly status: 'accepted' | 'findings';
  readonly findings: ReviewResult['findings'];
}
export type ReviewDiffValidationV1 = ValidationResult<TrustedDiffLines>;

/** Closed JSON shapes shared by the pure parser; these descriptors convey no owner authority. */
type Shape<T> = { readonly [K in keyof Required<T>]: unknown } & { readonly $optional?: readonly (keyof T)[] };
const schemas = {
  profile: {
    profileId: 'id',
    profileVersion: 'id',
    promptVersion: 'id',
    promptDigest: 'sha',
    requiredConventionPaths: ['unique', 'path'],
    optionalEvidenceRefs: ['unique', 'id'],
    maxDiffBytes: 'positive',
    maxContextBytes: 'positive',
    maxEvidenceItems: 'positive',
    maxEvidenceBytes: 'positive',
    maxFindings: 'positive',
    maxMessageBytes: 'positive',
    maxOutputBytes: 'positive',
    maxResponseBytes: 'positive',
  },
  binding: {
    taskId: 'id',
    runId: 'id',
    repositoryId: 'id',
    workspaceId: 'id',
    baseRevisionDigest: 'sha',
    headRevisionDigest: 'sha',
    diffDigest: 'sha',
    criteriaDigest: 'sha',
    checkSetDigest: 'sha',
    verificationDigest: 'sha',
    conventionsDigest: 'sha',
    evidenceDigest: 'sha',
    profileDigest: 'sha',
  },
  authority: { taskStateVersion: 'integer', controlVersion: 'integer', epoch: 'integer', decisionAuthorityGeneration: 'integer', planDecisionRef: 'id', planBindingDigest: 'sha' },
  convention: { path: 'path', revisionDigest: 'sha', contentDigest: 'sha', evidenceRef: 'id' },
  evidence: { path: 'path', revisionDigest: 'sha', contentDigest: 'sha', evidenceRef: 'id', kind: ['enum', 'requirement', 'convention', 'verification', 'source'] },
  verification: {
    baselineRef: 'id',
    results: [
      'array',
      { evidenceId: 'id', checkId: 'id', phase: ['enum', 'focused', 'regression', 'compatibility', 'diff'], outcome: ['enum', 'pass'], repoDigest: 'sha', diffDigest: 'sha', contentDigest: 'sha' },
    ],
  },
  context: {
    schemaVersion: ['enum', 'uc06-review-context/1'],
    binding: 'binding',
    authority: 'authority',
    profile: 'profile',
    verification: 'verification',
    conventions: ['array', 'convention'],
    evidence: ['array', 'evidence'],
    contextDigest: 'sha',
  },
  observation: {
    schemaVersion: ['enum', 'uc06-review-observation/1'],
    contextDigest: 'sha',
    binding: 'binding',
    authority: 'authority',
    reviewId: ['nullable', 'id'],
    providerRequestId: ['nullable', 'id'],
    status: ['enum', 'accepted', 'findings', 'invalid', 'stale', 'blocked', 'uncertain'],
    reasonCode: [
      'enum',
      'OK',
      'FINDINGS',
      'INPUT_UNSUPPORTED',
      'REQUIRED_EVIDENCE_MISSING',
      'BINDING_STALE',
      'AUTHORITY_UNAVAILABLE',
      'LIMIT_INVALID',
      'BUDGET_EXHAUSTED',
      'MODEL_OUTPUT_INVALID',
      'PROVIDER_TIMEOUT',
      'USAGE_UNCERTAIN',
      'EVIDENCE_UNACKNOWLEDGED',
    ],
    result: ['nullable', 'reviewResult'],
    accountingRefs: ['unique', 'id'],
    evidenceTier: ['enum', 'unit', 'controlled', 'real-provider', 'real-integration'],
  },
  persist: { observation: 'observation', observationDigest: 'sha', expectedAuthority: 'authority', idempotencyKey: 'id' },
  ack: {
    schemaVersion: ['enum', 'uc06-review-evidence/1'],
    receiptId: 'id',
    taskId: 'id',
    runId: 'id',
    repositoryId: 'id',
    workspaceId: 'id',
    headRevisionDigest: 'sha',
    diffDigest: 'sha',
    contextDigest: 'sha',
    providerRequestId: ['nullable', 'id'],
    observationDigest: 'sha',
    storeRecordVersion: 'positive',
    committed: ['enum', true],
  },
  load: { taskId: 'id', runId: 'id', providerRequestId: ['nullable', 'id'], contextDigest: 'sha', observationDigest: 'sha', expectedAuthority: 'authority' },
  recover: { taskId: 'id', workspaceId: 'id', repositoryId: 'id', headRevisionDigest: 'sha', diffDigest: 'sha', expectedAuthority: 'authority', operationRef: 'id', $optional: ['operationRef'] },
} as const satisfies {
  profile: Shape<ReviewProfileV1>;
  binding: Shape<ReviewBindingV1>;
  authority: Shape<ReviewAuthorityV1>;
  convention: Shape<ReviewConventionV1>;
  evidence: Shape<ReviewEvidenceV1>;
  verification: Shape<ReviewVerificationV1>;
  context: Shape<ReviewContextV1>;
  observation: Shape<ReviewObservationV1>;
  persist: Shape<PersistReviewObservationRequestV1>;
  ack: Shape<ReviewEvidenceAckV1>;
  load: Shape<LoadReviewObservationRequestV1>;
  recover: Shape<RecoverReviewObservationRequestV1>;
};
export const REVIEW_SCHEMAS: Readonly<Record<string, unknown>> = deepFreeze(schemas);
