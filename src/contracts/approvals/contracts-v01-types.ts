import type { ApprovalBinding } from '../foundation/uc03.ts';
import type { UC05_APPROVAL_SCHEMA_VERSION } from './contracts-versions.ts';

export interface ApprovalTaskControl {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly version: number;
  readonly epoch: number;
  readonly mode: 'runnable' | 'waiting' | 'rejected' | 'recovery-blocked' | 'ended';
  readonly pendingDecisionId: string | null;
  readonly continuationRef: string | null;
  readonly reasonCode: string;
  readonly outstandingClaimRefs: readonly string[];
}

export interface ApprovalRequestRecord {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly decisionId: string;
  readonly binding: ApprovalBinding;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly createdRunId: string;
  readonly continuationRef: string;
  readonly requestVersion: number;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly configId: string;
  readonly configVersion: string;
  readonly actionRef: string;
  readonly actionDigest: string;
  readonly presentationDigest: string;
  readonly createdAt: string;
  readonly submissionKey: string;
}

export interface TrustedOperatorIdentity {
  readonly actorId: string;
  readonly channelRef: string;
  readonly provenance: 'real';
}

export interface HumanResolution {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly decisionId: string;
  readonly responseKey: string;
  readonly expectedRequestVersion: number;
  readonly operatorChannelRef: string;
  readonly decision: 'approved' | 'rejected';
  readonly safeReasonCode: string;
  readonly decidedAt: string;
  readonly eventId: string;
}

export interface HumanResolutionValidationContext {
  readonly expectedDecisionId: string;
  readonly expectedRequestVersion: number;
  readonly trustedOperator: unknown;
  readonly existingTerminalResolution?: unknown;
}

export interface BindingAssessment {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly assessmentId: string;
  readonly decisionId: string;
  readonly checkedTaskVersion: number;
  readonly checkedEpoch: number;
  readonly trustedContextDigest: string;
  readonly status: 'valid' | 'stale' | 'denied';
  readonly reasonCodes: readonly string[];
  readonly checkedAt: string;
}

export interface BindingAssessmentValidationContext {
  readonly expectedDecisionId: string;
  readonly expectedTaskVersion: number;
  readonly expectedEpoch: number;
  readonly trustedContextDigest: string;
}

export interface DeveloperDirection {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly directionId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly expectedEpoch: number;
  readonly direction: 'resume' | 'revise' | 'end';
  readonly safeScopeRef: string;
  readonly responseKey: string;
  readonly createdAt: string;
}

export interface DeveloperDirectionValidationContext {
  readonly expectedTaskId: string;
  readonly expectedVersion: number;
  readonly expectedEpoch: number;
  readonly trustedOperator: unknown;
}

export interface PolicyIdentity {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly configId: string;
  readonly configVersion: string;
}

export interface DispatchClaim {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly claimId: string;
  readonly actionId: string;
  readonly taskId: string;
  readonly expectedControlVersion: number;
  readonly expectedEpoch: number;
  readonly repositoryStateDigest: string;
  readonly policyIdentity: PolicyIdentity;
  readonly decisionRefs: readonly string[];
  readonly reservationRefs: readonly string[];
  readonly phase: 'claimed' | 'dispatched' | 'observed' | 'uncertain' | 'reconciled';
  readonly resultRef: string | null;
}

export interface PolicyCommandRule {
  readonly ruleId: string;
  readonly executableRef: string;
  readonly argvPrefix: readonly string[];
  readonly workingDirectoryRef: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface PolicyProfile {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly profileId: 'uc05-local-v1';
  readonly profileVersion: string;
  readonly policyIdentity: PolicyIdentity;
  readonly supportedActionKinds: readonly ('run_command' | 'apply_patch' | 'approve_fix_plan')[];
  readonly commandRules: readonly PolicyCommandRule[];
  readonly sensitivePaths: readonly string[];
  readonly patchBreadth: { readonly maxFiles: number; readonly maxAddedDeletedLines: number };
  readonly maxActionBytes: number;
  readonly maxArgvEntries: number;
  readonly maxArgvEntryBytes: number;
  readonly maxPresentationPageBytes: number;
  readonly maxPresentationPages: number;
  readonly maxPresentationTotalBytes: number;
  readonly maxEventBytes: number;
  readonly operationDeadlineMs: number;
  readonly maxMutationAttempts: number;
  readonly diagnosticRules: {
    readonly maxBytes: number;
    readonly redactSecrets: true;
    readonly allowRawArtifacts: false;
    readonly retainUnresolvedDecisions: true;
  };
}

export interface SafePresentation {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly decisionId: string;
  readonly requestVersion: number;
  readonly bindingFingerprint: string;
  readonly elements: {
    readonly action: string;
    readonly necessity: string;
    readonly targets: readonly string[];
    readonly consequences: string;
    readonly verificationStatus: string;
  };
  readonly inspectionRef: string;
  readonly presentationDigest: string;
  readonly page: {
    readonly pageNumber: number;
    readonly pageCount: number;
    readonly pageBytes: number;
    readonly totalBytes: number;
    readonly truncated: boolean;
  };
}

export type SafeOperationOutcome = 'ok' | 'pending' | 'paused' | 'denied' | 'invalid' | 'conflict' | 'stale' | 'unavailable' | 'uncertain';
export type SafeNextAction = 'none' | 'inspect' | 'decide' | 'resume' | 'revise' | 'end' | 'retry-read' | 'reconcile';

export interface SafeResult {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly outcome: SafeOperationOutcome;
  readonly safeReasonCode: string;
  readonly taskId: string;
  readonly decisionId: string | null;
  readonly controlVersion: number;
  readonly requestVersion: number | null;
  readonly eventRef: string | null;
  readonly safeNextAction: SafeNextAction;
}

export type DecisionEventType =
  | 'approval-request-created'
  | 'human-resolution-recorded'
  | 'binding-assessed'
  | 'developer-direction-recorded'
  | 'dispatch-claim-created'
  | 'dispatch-effect-observed'
  | 'dispatch-uncertain'
  | 'claim-reconciled';

export interface DecisionEvent {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly eventId: string;
  readonly taskId: string;
  readonly runId: string | null;
  readonly decisionId: string | null;
  readonly directionId: string | null;
  readonly claimId: string | null;
  readonly type: DecisionEventType;
  readonly outcome: SafeOperationOutcome;
  readonly policyRef: PolicyIdentity;
  readonly safeReasonCode: string;
  readonly timestamp: string;
}
