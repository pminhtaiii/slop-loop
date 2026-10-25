import type { ApprovalContinuationV02 } from '../../../../src/approvals/recovery-v02.ts';
import type { AttemptOutcomeReceiptV02, AttemptReconciliationReceiptV02, ClaimClosureReceiptV02 } from '../../../../src/contracts/foundation/uc03/ports-v02.ts';
import type { MemoryStatePortV02 } from '../uc03/memory-state.ts';
import { isDeepStrictEqual } from 'node:util';
import {
  type ApprovalRequestRecord,
  type ApprovalTaskControl,
  type BindingAssessment,
  type DecisionEvent,
  type DeveloperDirection,
  type DispatchClaim,
  type HumanResolution,
  type PolicyProfile,
  type SafeResult,
  validateApprovalRequestRecord,
  validateApprovalTaskControl,
  validateBindingAssessment,
  validateDecisionEvent,
  validateDeveloperDirection,
  validateDispatchClaim,
  validateHumanResolution,
  validatePolicyProfile,
  validateSafeResult,
} from '../../../../src/contracts/approvals/contracts.ts';

export const UC05_MOCK_PROVENANCE = 'mock' as const;

export interface MockPortResponse<T> {
  readonly safe: SafeResult;
  readonly value: T | null;
}

export interface MockDecisionHistory {
  readonly assessments: readonly BindingAssessment[];
  readonly resolutions: readonly HumanResolution[];
  readonly directions: readonly DeveloperDirection[];
  readonly claims: readonly DispatchClaim[];
}

export type MockStoreOperation =
  | 'createPendingAndPause'
  | 'resolvePending'
  | 'replaceStalePending'
  | 'recordDirection'
  | 'claimDispatch'
  | 'recordOutcome'
  | 'reconcile';

export interface MockApprovalStore {
  readonly provenance: typeof UC05_MOCK_PROVENANCE;
  readonly profile: PolicyProfile;
  loadTaskControl(taskId: string): MockPortResponse<ApprovalTaskControl>;
  readRequest(decisionId: string): MockPortResponse<ApprovalRequestRecord>;
  readEvents(taskId: string): MockPortResponse<readonly DecisionEvent[]>;
  readHistory(taskId: string): MockPortResponse<MockDecisionHistory>;
  failNext(operation: MockStoreOperation): void;
  createPendingAndPause(input: unknown): MockPortResponse<ApprovalRequestRecord>;
  resolvePending(input: unknown): MockPortResponse<HumanResolution>;
  replaceStalePending(input: unknown): MockPortResponse<ApprovalRequestRecord>;
  recordDirection(input: unknown): MockPortResponse<DeveloperDirection>;
  claimDispatch(input: unknown): MockPortResponse<DispatchClaim>;
  recordOutcome(input: unknown): MockPortResponse<DispatchClaim>;
  reconcile(input: unknown): MockPortResponse<DispatchClaim>;
}

export interface CreateMockApprovalStoreInput {
  readonly profile: unknown;
  readonly initialControls: readonly unknown[];
}

interface CreatePendingInput {
  readonly expectedControlVersion: number;
  readonly submissionKey: string;
  readonly request: unknown;
  readonly event: unknown;
}

interface ResolvePendingInput {
  readonly expectedControlVersion: number;
  readonly expectedRequestVersion: number;
  readonly trustedResponse: unknown;
  readonly trustedOperator: unknown;
  readonly event: unknown;
}

interface ReplaceStaleInput {
  readonly expectedControlVersion: number;
  readonly expectedRequestVersion: number;
  readonly trustedContextDigest: string;
  readonly assessment: unknown;
  readonly replacement: unknown;
  readonly events: readonly unknown[];
}

interface RecordDirectionInput {
  readonly expectedControlVersion: number;
  readonly trustedOperator: unknown;
  readonly direction: unknown;
  readonly event: unknown;
}

interface ClaimInput {
  readonly claim: unknown;
  readonly event: unknown;
}

interface ClaimOutcomeInput {
  readonly claimId: string;
  readonly expectedControlVersion: number;
  readonly resultRef: string;
  readonly phase: 'observed' | 'uncertain';
  readonly event: unknown;
}

interface ReconcileInput {
  readonly claimId: string;
  readonly expectedControlVersion: number;
  readonly resultRef: string;
  readonly event: unknown;
}

/**
 * Creates the explicit v0.1 compatibility test double. Its mock provenance
 * never authorizes v0.2 effects or production admission, and it performs no durable I/O.
 */
export function createMockApprovalStore(input: CreateMockApprovalStoreInput): MockApprovalStore {
  const profileResult = validatePolicyProfile(input.profile);
  if (!profileResult.ok) throw new TypeError('mock store requires a validated finite test profile');
  if (!Array.isArray(input.initialControls) || input.initialControls.length === 0) {
    throw new TypeError('mock store requires at least one validated initial task control');
  }

  const profile = freezeCopy(profileResult.value);
  const controls = new Map<string, ApprovalTaskControl>();
  for (const candidate of input.initialControls) {
    const result = validateApprovalTaskControl(candidate);
    if (!result.ok || controls.has(result.ok ? result.value.taskId : '')) {
      throw new TypeError('mock store requires unique validated initial task controls');
    }
    controls.set(result.value.taskId, freezeCopy(result.value));
  }

  const requests = new Map<string, ApprovalRequestRecord>();
  const submissions = new Map<string, string>();
  const resolutions = new Map<string, HumanResolution>();
  const assessments: BindingAssessment[] = [];
  const directions: DeveloperDirection[] = [];
  const directionOperators = new Map<string, unknown>();
  const claims = new Map<string, DispatchClaim>();
  const events: DecisionEvent[] = [];
  const failedNext = new Set<MockStoreOperation>();

  const resultFor = <T = never>(
    control: ApprovalTaskControl,
    outcome: SafeResult['outcome'],
    reasonCode: string,
    value: T | null = null,
    decisionId: string | null = null,
    requestVersion: number | null = null,
    eventRef: string | null = null,
  ): MockPortResponse<T> => makeResponse(control, outcome, reasonCode, value, decisionId, requestVersion, eventRef);

  const controlFor = (taskId: string): ApprovalTaskControl | undefined => controls.get(taskId);
  const requestForTask = (taskId: string): ApprovalRequestRecord | undefined =>
    [...requests.values()].find((request) => request.taskId === taskId && controlFor(taskId)?.pendingDecisionId === request.decisionId);
  const fallbackControl = (): ApprovalTaskControl => controls.values().next().value as ApprovalTaskControl;
  const currentOrUnknown = (taskId: string): ApprovalTaskControl => controlFor(taskId) ?? {
    schemaVersion: 'uc05-approval/0.1-draft', taskId: 'unknown-task', repositoryId: 'unknown-repository',
    workspaceId: 'unknown-workspace', version: 1, epoch: 1, mode: 'recovery-blocked',
    pendingDecisionId: null, continuationRef: null, reasonCode: 'unknown-task', outstandingClaimRefs: [],
  };
  const storageFailure = <T>(operation: MockStoreOperation, control: ApprovalTaskControl, decisionId: string | null = null, requestVersion: number | null = null): MockPortResponse<T> | undefined => {
    if (!failedNext.delete(operation)) return undefined;
    return makeResponse<T>(control, 'unavailable', 'mock-storage-commit-failed', null, decisionId, requestVersion, null);
  };
  const pendingRequestVersion = (control: ApprovalTaskControl): number | null => control.pendingDecisionId === null
    ? null
    : requests.get(control.pendingDecisionId)?.requestVersion ?? null;

  const loadTaskControl = (taskId: string): MockPortResponse<ApprovalTaskControl> => {
    const control = controlFor(taskId);
    return control
      ? resultFor(control, 'ok', 'task-control-loaded', freezeCopy(control))
      : resultFor(currentOrUnknown(taskId), 'invalid', 'unknown-task');
  };

  const readRequest = (decisionId: string): MockPortResponse<ApprovalRequestRecord> => {
    const request = requests.get(decisionId);
    const control = request ? currentOrUnknown(request.taskId) : fallbackControl();
    return request
      ? resultFor(control, 'ok', 'approval-request-loaded', freezeCopy(request), request.decisionId, request.requestVersion)
      : resultFor(control, 'invalid', 'unknown-decision');
  };

  const readEvents = (taskId: string): MockPortResponse<readonly DecisionEvent[]> => {
    const control = controlFor(taskId);
    if (!control) return resultFor(currentOrUnknown(taskId), 'invalid', 'unknown-task');
    return resultFor(control, 'ok', 'decision-events-loaded', freezeCopy(events.filter((event) => event.taskId === taskId)));
  };

  const readHistory = (taskId: string): MockPortResponse<MockDecisionHistory> => {
    const control = controlFor(taskId);
    if (!control) return resultFor(currentOrUnknown(taskId), 'invalid', 'unknown-task');
    const taskDecisionIds = new Set([...requests.values()].filter((request) => request.taskId === taskId).map((request) => request.decisionId));
    const history: MockDecisionHistory = {
      assessments: assessments.filter((assessment) => taskDecisionIds.has(assessment.decisionId)),
      resolutions: [...resolutions.values()].filter((resolution) => taskDecisionIds.has(resolution.decisionId)),
      directions: directions.filter((direction) => direction.taskId === taskId),
      claims: [...claims.values()].filter((claim) => claim.taskId === taskId),
    };
    return resultFor(control, 'ok', 'decision-history-loaded', freezeCopy(history));
  };

  const createPendingAndPause = (input: unknown): MockPortResponse<ApprovalRequestRecord> => {
    if (!isRecord(input)) return resultFor(fallbackControl(), 'invalid', 'invalid-pending-request-input');
    const candidate = input as unknown as CreatePendingInput;
    const requestResult = validateApprovalRequestRecord(candidate.request);
    if (!requestResult.ok || !isPositiveInteger(candidate.expectedControlVersion) || !isIdentifier(candidate.submissionKey)) {
      return resultFor(fallbackControl(), 'invalid', 'invalid-pending-request-input');
    }
    const request = requestResult.value;
    const control = controlFor(request.taskId);
    const event = validateEvent(candidate.event, profile);
    if (!control || !event || event.type !== 'approval-request-created' || event.taskId !== request.taskId || event.decisionId !== request.decisionId || event.directionId !== null || event.claimId !== null) {
      return resultFor(control ?? fallbackControl(), 'invalid', 'invalid-pending-request-context');
    }
    const submissionIdentity = `${request.taskId}:${candidate.submissionKey}`;
    const existingDecisionId = submissions.get(submissionIdentity);
    if (existingDecisionId) {
      const existing = requests.get(existingDecisionId);
      if (existing && isDeepStrictEqual(existing, request)) {
        const current = controlFor(request.taskId) ?? control;
        const pending = current.pendingDecisionId === request.decisionId;
        return resultFor(current, pending ? 'pending' : 'ok', 'pending-request-idempotent-retry', freezeCopy(existing), existing.decisionId, existing.requestVersion);
      }
      return resultFor<ApprovalRequestRecord>(control, 'conflict', 'submission-key-conflict', null, request.decisionId, request.requestVersion);
    }
    if (request.submissionKey !== candidate.submissionKey) {
      return resultFor<ApprovalRequestRecord>(control, 'conflict', 'submission-key-mismatch', null, request.decisionId, request.requestVersion);
    }
    if (requests.has(request.decisionId) || eventExists(event.eventId)) {
      return resultFor<ApprovalRequestRecord>(control, 'conflict', 'request-identity-conflict', null, request.decisionId, request.requestVersion);
    }
    if (control.version !== candidate.expectedControlVersion || control.mode !== 'runnable' || control.pendingDecisionId !== null) {
      return resultFor<ApprovalRequestRecord>(control, control.mode === 'waiting' ? 'conflict' : 'stale', 'task-control-changed', null, request.decisionId, request.requestVersion);
    }
    if (request.repositoryId !== control.repositoryId || request.workspaceId !== control.workspaceId) {
      return resultFor(control, 'invalid', 'request-task-identity-mismatch');
    }
    const failed = storageFailure<ApprovalRequestRecord>('createPendingAndPause', control, request.decisionId, request.requestVersion);
    if (failed) return failed;

    const nextControl = validateGeneratedControl({
      ...control,
      version: control.version + 1,
      epoch: control.epoch + 1,
      mode: 'waiting',
      pendingDecisionId: request.decisionId,
      continuationRef: request.continuationRef,
      reasonCode: 'approval-pending',
    });
    requests.set(request.decisionId, freezeCopy(request));
    submissions.set(submissionIdentity, request.decisionId);
    controls.set(control.taskId, nextControl);
    events.push(freezeCopy(event));
    return resultFor(nextControl, 'pending', 'approval-request-created-and-task-paused', freezeCopy(request), request.decisionId, request.requestVersion, event.eventId);
  };

  const resolvePending = (input: unknown): MockPortResponse<HumanResolution> => {
    if (!isRecord(input)) return resultFor(fallbackControl(), 'invalid', 'invalid-decision-input');
    const candidate = input as unknown as ResolvePendingInput;
    const rawResponse = candidate.trustedResponse;
    if (!isRecord(rawResponse) || !isPositiveInteger(candidate.expectedControlVersion) || !isPositiveInteger(candidate.expectedRequestVersion)) {
      return resultFor(fallbackControl(), 'invalid', 'invalid-decision-input');
    }
    const decisionId = typeof rawResponse['decisionId'] === 'string' ? rawResponse['decisionId'] : '';
    const request = requests.get(decisionId);
    const control = request ? controlFor(request.taskId) : undefined;
    if (!request || !control) return resultFor(fallbackControl(), 'invalid', 'unknown-pending-decision');
    const prior = resolutions.get(decisionId);
    const resolutionResult = validateHumanResolution(rawResponse, {
      expectedDecisionId: decisionId,
      expectedRequestVersion: request.requestVersion,
      trustedOperator: candidate.trustedOperator,
      ...(prior ? { existingTerminalResolution: prior } : {}),
    });
    if (!resolutionResult.ok || candidate.expectedRequestVersion !== request.requestVersion) {
      return resultFor<HumanResolution>(control, prior ? 'conflict' : 'invalid', prior ? 'terminal-decision-conflict' : 'invalid-trusted-decision', null, decisionId, request.requestVersion);
    }
    if (prior) {
      return resultFor(control, 'ok', 'same-response-idempotent-retry', freezeCopy(prior), decisionId, request.requestVersion, prior.eventId);
    }
    const event = validateEvent(candidate.event, profile);
    if (!event || event.type !== 'human-resolution-recorded' || event.taskId !== request.taskId || event.decisionId !== decisionId || event.directionId !== null || event.claimId !== null || eventExists(event.eventId)) {
      return resultFor<HumanResolution>(control, 'invalid', 'invalid-decision-event', null, decisionId, request.requestVersion);
    }
    if (control.version !== candidate.expectedControlVersion || control.mode !== 'waiting' || control.pendingDecisionId !== decisionId) {
      return resultFor<HumanResolution>(control, 'conflict', 'pending-control-changed', null, decisionId, request.requestVersion);
    }
    const failed = storageFailure<HumanResolution>('resolvePending', control, decisionId, request.requestVersion);
    if (failed) return failed;

    const resolution = resolutionResult.value;
    const nextMode = resolution.decision === 'rejected'
      ? 'rejected'
      : control.outstandingClaimRefs.length > 0 ? 'recovery-blocked' : 'runnable';
    const nextControl = validateGeneratedControl({
      ...control,
      version: control.version + 1,
      epoch: control.epoch + 1,
      mode: nextMode,
      pendingDecisionId: null,
      continuationRef: null,
      reasonCode: resolution.decision === 'rejected' ? 'developer-rejected' : nextMode === 'recovery-blocked' ? 'claim-reconciliation-required' : 'developer-approved',
    });
    resolutions.set(decisionId, freezeCopy(resolution));
    controls.set(control.taskId, nextControl);
    events.push(freezeCopy(event));
    return resultFor(nextControl, resolution.decision === 'rejected' ? 'paused' : nextMode === 'runnable' ? 'ok' : 'uncertain', 'human-resolution-recorded', freezeCopy(resolution), decisionId, request.requestVersion, event.eventId);
  };

  const replaceStalePending = (input: unknown): MockPortResponse<ApprovalRequestRecord> => {
    if (!isRecord(input)) return resultFor(fallbackControl(), 'invalid', 'invalid-stale-replacement-input');
    const candidate = input as unknown as ReplaceStaleInput;
    const replacementResult = validateApprovalRequestRecord(candidate.replacement);
    if (!replacementResult.ok || !Array.isArray(candidate.events) || candidate.events.length !== 2 || !isPositiveInteger(candidate.expectedControlVersion) || !isPositiveInteger(candidate.expectedRequestVersion)) {
      return resultFor(fallbackControl(), 'invalid', 'invalid-stale-replacement-input');
    }
    const replacement = replacementResult.value;
    const control = controlFor(replacement.taskId);
    const previous = requestForTask(replacement.taskId);
    const assessmentResult = previous ? validateBindingAssessment(candidate.assessment, {
      expectedDecisionId: previous.decisionId,
      expectedTaskVersion: candidate.expectedControlVersion,
      expectedEpoch: control?.epoch ?? 0,
      trustedContextDigest: candidate.trustedContextDigest,
    }) : undefined;
    const checkedEvents = candidate.events.map((event) => validateEvent(event, profile));
    const staleEvent = checkedEvents[0]?.type === 'binding-assessed' ? checkedEvents[0] : undefined;
    const requestEvent = checkedEvents[1]?.type === 'approval-request-created' ? checkedEvents[1] : undefined;
    if (!control || !previous || !assessmentResult?.ok || assessmentResult.value.status !== 'stale' || !staleEvent || !requestEvent ||
      staleEvent.taskId !== control.taskId || staleEvent.decisionId !== previous.decisionId || requestEvent.taskId !== control.taskId || requestEvent.decisionId !== replacement.decisionId ||
      control.mode !== 'waiting' || control.pendingDecisionId !== previous.decisionId || candidate.expectedRequestVersion !== previous.requestVersion ||
      control.version !== candidate.expectedControlVersion || replacement.decisionId === previous.decisionId || eventExists(staleEvent.eventId) || eventExists(requestEvent.eventId) || requests.has(replacement.decisionId)) {
      return resultFor(control ?? fallbackControl(), 'conflict', 'stale-replacement-context-changed');
    }
    if (replacement.repositoryId !== control.repositoryId || replacement.workspaceId !== control.workspaceId) {
      return resultFor(control, 'invalid', 'request-task-identity-mismatch');
    }
    if (submissions.has(`${replacement.taskId}:${replacement.submissionKey}`)) {
      return resultFor(control, 'conflict', 'submission-key-conflict');
    }
    const failed = storageFailure<ApprovalRequestRecord>('replaceStalePending', control, previous.decisionId, previous.requestVersion);
    if (failed) return failed;
    const nextControl = validateGeneratedControl({
      ...control,
      version: control.version + 1,
      epoch: control.epoch + 1,
      pendingDecisionId: replacement.decisionId,
      continuationRef: replacement.continuationRef,
      reasonCode: 'stale-request-replaced',
    });
    assessments.push(freezeCopy(assessmentResult.value));
    requests.set(replacement.decisionId, freezeCopy(replacement));
    submissions.set(`${replacement.taskId}:${replacement.submissionKey}`, replacement.decisionId);
    controls.set(control.taskId, nextControl);
    events.push(freezeCopy(staleEvent), freezeCopy(requestEvent));
    return resultFor(nextControl, 'pending', 'stale-request-replaced-while-paused', freezeCopy(replacement), replacement.decisionId, replacement.requestVersion, requestEvent.eventId);
  };

  const recordDirection = (input: unknown): MockPortResponse<DeveloperDirection> => {
    if (!isRecord(input)) return resultFor(fallbackControl(), 'invalid', 'invalid-direction-input');
    const candidate = input as unknown as RecordDirectionInput;
    const rawDirection = candidate.direction;
    if (!isRecord(rawDirection) || !isPositiveInteger(candidate.expectedControlVersion)) return resultFor(fallbackControl(), 'invalid', 'invalid-direction-input');
    const taskId = typeof rawDirection['taskId'] === 'string' ? rawDirection['taskId'] : '';
    const control = controlFor(taskId);
    if (!control) return resultFor(currentOrUnknown(taskId), 'invalid', 'unknown-task');
    const prior = directions.find(value => value.taskId === taskId && value.responseKey === rawDirection['responseKey']);
    if (prior) {
      const validated = validateDeveloperDirection(rawDirection, { expectedTaskId: taskId, expectedVersion: prior.expectedVersion, expectedEpoch: prior.expectedEpoch, trustedOperator: candidate.trustedOperator });
      const originalEvent = events.find(event => event.directionId === prior.directionId && event.taskId === taskId && event.type === 'developer-direction-recorded');
      if (!validated.ok || candidate.expectedControlVersion !== prior.expectedVersion || !isDeepStrictEqual(candidate.trustedOperator, directionOperators.get(prior.directionId)) || !isDeepStrictEqual(rawDirection, prior) || !isDeepStrictEqual(candidate.event, originalEvent)) return resultFor<DeveloperDirection>(control, 'conflict', 'direction-response-conflict');
      return resultFor(control, prior.direction === 'end' ? 'paused' : 'ok', 'same-direction-idempotent-retry', freezeCopy(prior), null, null, originalEvent?.eventId ?? null);
    }
    const directionResult = validateDeveloperDirection(rawDirection, {
      expectedTaskId: taskId,
      expectedVersion: control.version,
      expectedEpoch: control.epoch,
      trustedOperator: candidate.trustedOperator,
    });
    const event = validateEvent(candidate.event, profile);
    if (!directionResult.ok || !event || event.type !== 'developer-direction-recorded' || event.taskId !== taskId || event.directionId !== directionResult.value.directionId || event.decisionId !== null || event.claimId !== null || eventExists(event.eventId)) {
      return resultFor<DeveloperDirection>(control, 'invalid', 'invalid-trusted-direction', null, control.pendingDecisionId, pendingRequestVersion(control));
    }
    if (control.version !== candidate.expectedControlVersion || directionResult.value.expectedVersion !== control.version || directionResult.value.expectedEpoch !== control.epoch) {
      return resultFor<DeveloperDirection>(control, 'conflict', 'task-control-changed', null, control.pendingDecisionId, pendingRequestVersion(control));
    }
    const canEnd = directionResult.value.direction === 'end' && control.mode !== 'ended';
    const canContinue = (directionResult.value.direction === 'resume' || directionResult.value.direction === 'revise') && control.mode === 'rejected' && control.outstandingClaimRefs.length === 0;
    if (!canEnd && !canContinue) return resultFor<DeveloperDirection>(control, control.outstandingClaimRefs.length > 0 ? 'uncertain' : 'denied', 'direction-cannot-release-current-hold', null, control.pendingDecisionId, pendingRequestVersion(control));
    const failed = storageFailure<DeveloperDirection>('recordDirection', control, control.pendingDecisionId, pendingRequestVersion(control));
    if (failed) return failed;
    const nextMode = directionResult.value.direction === 'end' ? 'ended' : 'runnable';
    const nextControl = validateGeneratedControl({
      ...control,
      version: control.version + 1,
      epoch: control.epoch + 1,
      mode: nextMode,
      pendingDecisionId: null,
      continuationRef: null,
      reasonCode: directionResult.value.direction === 'end' ? 'developer-ended' : 'developer-direction-recorded',
    });
    directions.push(freezeCopy(directionResult.value));
    directionOperators.set(directionResult.value.directionId, freezeCopy(candidate.trustedOperator));
    controls.set(taskId, nextControl);
    events.push(freezeCopy(event));
    return resultFor(nextControl, nextMode === 'ended' ? 'paused' : 'ok', 'developer-direction-recorded', freezeCopy(directionResult.value), null, null, event.eventId);
  };

  const claimDispatch = (input: unknown): MockPortResponse<DispatchClaim> => {
    if (!isRecord(input) || !isRecord(input['claim'])) return resultFor(fallbackControl(), 'invalid', 'invalid-claim-input');
    const candidate = input as unknown as ClaimInput;
    const claimResult = validateDispatchClaim(candidate.claim);
    if (!claimResult.ok) return resultFor(fallbackControl(), 'invalid', 'invalid-dispatch-claim');
    const claim = claimResult.value;
    const control = controlFor(claim.taskId);
    const event = validateEvent(candidate.event, profile);
    if (!control || !event || event.type !== 'dispatch-claim-created' || event.taskId !== claim.taskId || event.claimId !== claim.claimId || event.decisionId !== null || event.directionId !== null || eventExists(event.eventId)) {
      return resultFor(control ?? fallbackControl(), 'invalid', 'invalid-dispatch-claim-context');
    }
    if (claims.has(claim.claimId)) return resultFor(control, 'conflict', 'claim-already-exists');
    if (claim.phase !== 'claimed' || claim.expectedControlVersion !== control.version || claim.expectedEpoch !== control.epoch || control.mode !== 'runnable') {
      return resultFor(control, control.mode === 'waiting' || control.mode === 'rejected' || control.mode === 'ended' ? 'paused' : 'stale', 'task-epoch-fenced');
    }
    if (!isDeepStrictEqual(claim.policyIdentity, profile.policyIdentity)) return resultFor(control, 'denied', 'claim-policy-identity-mismatch');
    const failed = storageFailure<DispatchClaim>('claimDispatch', control);
    if (failed) return failed;
    const nextControl = validateGeneratedControl({
      ...control,
      version: control.version + 1,
      outstandingClaimRefs: [...control.outstandingClaimRefs, claim.claimId],
    });
    claims.set(claim.claimId, freezeCopy(claim));
    controls.set(control.taskId, nextControl);
    events.push(freezeCopy(event));
    return resultFor(nextControl, 'ok', 'dispatch-claim-recorded-no-effect-performed', freezeCopy(claim), null, null, event.eventId);
  };

  const recordOutcome = (input: unknown): MockPortResponse<DispatchClaim> => {
    if (!isRecord(input) || !isIdentifier(input['claimId'])) return resultFor(fallbackControl(), 'invalid', 'invalid-claim-outcome-input');
    const candidate = input as unknown as ClaimOutcomeInput;
    const claim = claims.get(candidate.claimId);
    const control = claim ? controlFor(claim.taskId) : undefined;
    const event = validateEvent(candidate.event, profile);
    if (!claim || !control || !event || !isPositiveInteger(candidate.expectedControlVersion) || !isIdentifier(candidate.resultRef) ||
      (candidate.phase !== 'observed' && candidate.phase !== 'uncertain') || event.claimId !== claim.claimId || event.taskId !== claim.taskId ||
      event.type !== (candidate.phase === 'observed' ? 'dispatch-effect-observed' : 'dispatch-uncertain') || eventExists(event.eventId)) {
      return resultFor(control ?? fallbackControl(), 'invalid', 'invalid-claim-outcome-context');
    }
    if (control.version !== candidate.expectedControlVersion || !control.outstandingClaimRefs.includes(claim.claimId)) return resultFor(control, 'conflict', 'claim-control-changed');
    const failed = storageFailure<DispatchClaim>('recordOutcome', control);
    if (failed) return failed;
    const nextClaim = validateGeneratedClaim({ ...claim, phase: candidate.phase, resultRef: candidate.resultRef });
    const outstandingClaimRefs = candidate.phase === 'observed'
      ? control.outstandingClaimRefs.filter((claimId) => claimId !== claim.claimId)
      : control.outstandingClaimRefs;
    const releasesHold = candidate.phase === 'observed' && outstandingClaimRefs.length === 0 &&
      control.mode === 'recovery-blocked' && control.pendingDecisionId === null;
    const nextControl = validateGeneratedControl({
      ...control,
      version: control.version + 1,
      outstandingClaimRefs,
      ...(releasesHold ? { mode: 'runnable' as const, reasonCode: 'claim-observed' } : {}),
    });
    claims.set(claim.claimId, nextClaim);
    controls.set(control.taskId, nextControl);
    events.push(freezeCopy(event));
    return resultFor(nextControl, candidate.phase === 'observed' ? 'ok' : 'uncertain', candidate.phase === 'observed' ? 'effect-outcome-recorded' : 'effect-outcome-uncertain', freezeCopy(nextClaim), null, null, event.eventId);
  };

  const reconcile = (input: unknown): MockPortResponse<DispatchClaim> => {
    if (!isRecord(input) || !isIdentifier(input['claimId'])) return resultFor(fallbackControl(), 'invalid', 'invalid-reconciliation-input');
    const candidate = input as unknown as ReconcileInput;
    const claim = claims.get(candidate.claimId);
    const control = claim ? controlFor(claim.taskId) : undefined;
    const event = validateEvent(candidate.event, profile);
    if (!claim || !control || !event || claim.phase !== 'uncertain' || !isPositiveInteger(candidate.expectedControlVersion) || !isIdentifier(candidate.resultRef) ||
      event.type !== 'claim-reconciled' || event.taskId !== claim.taskId || event.claimId !== claim.claimId || eventExists(event.eventId)) {
      return resultFor(control ?? fallbackControl(), 'invalid', 'invalid-reconciliation-context');
    }
    if (control.version !== candidate.expectedControlVersion || !control.outstandingClaimRefs.includes(claim.claimId)) return resultFor(control, 'conflict', 'claim-control-changed');
    const failed = storageFailure<DispatchClaim>('reconcile', control);
    if (failed) return failed;
    const nextClaim = validateGeneratedClaim({ ...claim, phase: 'reconciled', resultRef: candidate.resultRef });
    const outstandingClaimRefs = control.outstandingClaimRefs.filter((claimId) => claimId !== claim.claimId);
    const releasesHold = control.mode === 'recovery-blocked' && control.pendingDecisionId === null && outstandingClaimRefs.length === 0;
    const nextControl = validateGeneratedControl({
      ...control,
      version: control.version + 1,
      outstandingClaimRefs,
      ...(releasesHold ? { mode: 'runnable' as const, reasonCode: 'claim-reconciled' } : {}),
    });
    claims.set(claim.claimId, nextClaim);
    controls.set(control.taskId, nextControl);
    events.push(freezeCopy(event));
    return resultFor(nextControl, 'ok', 'existing-claim-reconciled', freezeCopy(nextClaim), null, null, event.eventId);
  };

  return Object.freeze({
    provenance: UC05_MOCK_PROVENANCE,
    profile,
    loadTaskControl,
    readRequest,
    readEvents,
    readHistory,
    failNext: (operation: MockStoreOperation) => { failedNext.add(operation); },
    createPendingAndPause,
    resolvePending,
    replaceStalePending,
    recordDirection,
    claimDispatch,
    recordOutcome,
    reconcile,
  });

  /** Detect event identity reuse across the mock store's committed audit history. */
  function eventExists(eventId: string): boolean {
    return events.some((event) => event.eventId === eventId);
  }
}

/** Explicit v0.1 test compatibility; never a v0.2 admission owner. */
export const createMockApprovalStoreV01Compatibility = createMockApprovalStore;

/** Forward to the actual in-memory UC-05 continuation and UC-04 journal owners. */
export function createMockApprovalStoreV02(input: {
  readonly continuation: ApprovalContinuationV02;
  readonly journal: MemoryStatePortV02;
}): MockApprovalStoreV02 {
  return Object.freeze({
    provenance: UC05_MOCK_PROVENANCE,
    claimDispatchV02: (decisionId: string) => input.continuation.admit(decisionId),
    recordOutcomeV02: (receipt: AttemptOutcomeReceiptV02) => input.journal.recordOutcome(receipt),
    closeUnattemptedClaimV02: (receipt: ClaimClosureReceiptV02) => input.journal.closeUnattemptedClaim(receipt),
    reconcileObservedOutcomeV02: (receipt: AttemptReconciliationReceiptV02) => input.journal.reconcileObservedOutcome(receipt),
    reconcileUncertainV02: (receipt: AttemptReconciliationReceiptV02) => input.journal.reconcileUncertain(receipt),
    publishAuthorityV02: (options: Parameters<MemoryStatePortV02['publishAuthority']>[0]) => input.journal.publishAuthority(options),
    readHistoryV02: () => input.journal.getJournalSnapshot(),
  });
}

export interface MockApprovalStoreV02 {
  readonly provenance: typeof UC05_MOCK_PROVENANCE;
  claimDispatchV02(decisionId: string): ReturnType<ApprovalContinuationV02['admit']>;
  recordOutcomeV02(receipt: AttemptOutcomeReceiptV02): ReturnType<MemoryStatePortV02['recordOutcome']>;
  closeUnattemptedClaimV02(receipt: ClaimClosureReceiptV02): ReturnType<MemoryStatePortV02['closeUnattemptedClaim']>;
  reconcileObservedOutcomeV02(receipt: AttemptReconciliationReceiptV02): ReturnType<MemoryStatePortV02['reconcileObservedOutcome']>;
  reconcileUncertainV02(receipt: AttemptReconciliationReceiptV02): ReturnType<MemoryStatePortV02['reconcileUncertain']>;
  publishAuthorityV02(options: Parameters<MemoryStatePortV02['publishAuthority']>[0]): ReturnType<MemoryStatePortV02['publishAuthority']>;
  readHistoryV02(): ReturnType<MemoryStatePortV02['getJournalSnapshot']>;
}

/** Return a validated audit event, or undefined when it violates the supplied test profile. */
function validateEvent(input: unknown, profile: PolicyProfile): DecisionEvent | undefined {
  const result = validateDecisionEvent(input, profile);
  return result.ok ? result.value : undefined;
}

/** Freeze generated task control, throwing if a mock transition violates the contract. */
function validateGeneratedControl(input: unknown): ApprovalTaskControl {
  const result = validateApprovalTaskControl(input);
  if (!result.ok) throw new Error('mock store attempted to write an invalid task control');
  return freezeCopy(result.value);
}

/** Freeze a generated claim, throwing if a mock outcome violates the claim contract. */
function validateGeneratedClaim(input: unknown): DispatchClaim {
  const result = validateDispatchClaim(input);
  if (!result.ok) throw new Error('mock store attempted to write an invalid dispatch claim');
  return freezeCopy(result.value);
}

/** Construct an immutable mock response, throwing if its safe metadata violates the result contract. */
function makeResponse<T>(
  control: Pick<ApprovalTaskControl, 'taskId' | 'version'>,
  outcome: SafeResult['outcome'],
  safeReasonCode: string,
  value: T | null,
  decisionId: string | null = null,
  requestVersion: number | null = null,
  eventRef: string | null = null,
): MockPortResponse<T> {
  const candidate: SafeResult = {
    schemaVersion: 'uc05-approval/0.1-draft',
    outcome,
    safeReasonCode,
    taskId: control.taskId,
    decisionId,
    controlVersion: control.version,
    requestVersion,
    eventRef,
    safeNextAction: 'none',
  };
  const checked = validateSafeResult(candidate);
  if (!checked.ok) throw new Error('mock store produced an invalid safe result');
  return freezeCopy({ safe: checked.value, value });
}

/** Narrow mock operation input to a non-null object that is not an array. */
function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

/** Recognize bounded ASCII identifiers used by mock operation inputs. */
function isIdentifier(input: unknown): input is string {
  return typeof input === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/u.test(input);
}

/** Require positive safe integers for mock control and request versions. */
function isPositiveInteger(input: unknown): input is number {
  return typeof input === 'number' && Number.isSafeInteger(input) && input > 0;
}

/** Clone and recursively freeze mock data so callers cannot mutate stored state through responses. */
function freezeCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const visit = (item: unknown): void => {
    if (item === null || typeof item !== 'object' || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) visit(child);
    Object.freeze(item);
  };
  visit(copy);
  return copy;
}
