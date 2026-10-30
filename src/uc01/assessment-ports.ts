import type { Assessment, Catalog, Invocation, Limits, Question, Usage } from "./contracts.ts";
import type { ExcerptAdmission, ModelEvidence } from "./intake.ts";
import type { ProductionProfile } from "./production-profile.ts";

export type OperationContext = Readonly<{ taskId: string; runId: string; invocationId: string; repositoryId: string; workspaceId: string;
  repositorySnapshotDigest: string; configId: string; configVersion: string; policyId: string; policyVersion: string;
  operationId: string; requestId: string; accountingRef: string; deadlineEpochMs: number; limits: Limits }>;
export type Admission = Readonly<{ kind: 'admitted'; admissionRef: string; requestId: string; contextDigest: string }>;
export type ReserveCeiling = Readonly<{ inputTokens: number; outputTokens: number; totalTokens: number; costUnits: number; pricingId: string }>;
export type ModelRequest = Readonly<{ role: 'triage'; invocation: Invocation; evidence: readonly ModelEvidence[];
  priorQuestions: readonly Question[]; catalog: Catalog; reservationRef: string }>;
export type SafeEvent = Readonly<{ eventId: string; type: string; outcome: string; durationMs: number;
  counts: Readonly<{ modelCalls: number; toolCalls: number; evidenceItems: number; questions: number }>; configRef: string }>;
/** Approved consumer requirements, not a production adapter or full RepositoryPort. */
export interface AssessmentPorts {
  readonly provenance: 'mock' | 'real';
  guard(context: OperationContext, action: Readonly<{ kind: 'model' | 'read' | 'search'; inputDigest: string }>): Promise<unknown>;
  reserve(context: OperationContext, admission: Admission, ceiling: ReserveCeiling): Promise<unknown>;
  settle(context: OperationContext, reservationRef: string, usage: Usage): Promise<unknown>;
  proposeAssessment(context: OperationContext, admission: Admission, request: ModelRequest): Promise<unknown>;
  readEvidence(context: OperationContext, admission: Admission, path: string): Promise<unknown>;
  searchEvidence(context: OperationContext, admission: Admission, query: string): Promise<unknown>;
  bindContinuation(context: OperationContext, assessment: Assessment): Promise<unknown>;
  resolveContinuation(context: OperationContext, continuationRef: string): Promise<unknown>;
  emitSafeEvent(event: SafeEvent): Promise<unknown>;
}
export type AssessmentDependencies = Readonly<{ ports: AssessmentPorts; excerpts: ExcerptAdmission; now: () => number;
  profileId: 'uc01-fixture-v1' | 'uc01-production-v1'; production?: ProductionProfile; ceiling: ReserveCeiling }>;
