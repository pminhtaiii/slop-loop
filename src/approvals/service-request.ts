import { isDeepStrictEqual } from 'node:util';
import { computeCanonicalSha256, parseApprovalBinding } from '../contracts/foundation/uc03.ts';
import type { ApprovalRequestRecord, BindingAssessment, DecisionEvent } from '../contracts/approvals/contracts.ts';
import { validateApprovalRequestRecord, validateSafeResult } from '../contracts/approvals/contracts.ts';
import { containsProtectedContent } from '../foundation/repository-tools.ts';
import { ApprovalServiceError } from './service-data.ts';
import type { ApprovalService, ApprovalStore, StoreResponse, ServiceRuntime } from './service-data.ts';
import { plainContextData } from './service-context.ts';
import { readApprovalJournal, requireJournalEvent } from './history.ts';

/** Request transitions retain the service's shared admission fence and bounded operation lifetime. */
export function createServiceRequest(runtime: Pick<ServiceRuntime, 'options' | 'profile' | 'policy' | 'store' | 'control' | 'trusted' | 'checkedView' | 'presentation' | 'request' | 'projection' | 'staleContextDigests' | 'callPort' | 'coordinator' | 'now' | 'admission' | 'bounded'>): ApprovalService['requestDecision'] {
  const { options, profile, policy, store, control, trusted, checkedView, presentation, request, projection, staleContextDigests, callPort, coordinator, now, admission, bounded } = runtime;
  return binding => bounded(async assertActive => {
      if (admission.closed || coordinator.isClosed()) throw new ApprovalServiceError('unavailable');
      if (!plainContextData(binding)) throw new ApprovalServiceError('invalid');
      const checked = parseApprovalBinding(binding);
      if (!checked.ok || binding.status !== 'pending') throw new ApprovalServiceError('invalid');
      const context = await trusted(binding.decisionId, binding);
      const classification = policy.classify(context.action, context.facts);
      if (!classification.ok || classification.permission !== 'APPROVAL_REQUIRED') throw new ApprovalServiceError('denied');
      const bundle = presentation(binding, context);
      const prior = store().readRequest(binding.decisionId);
      if (!plainContextData(prior) || !validateSafeResult(prior.safe).ok || prior.value === null && (prior.safe.outcome !== 'invalid' || prior.safe.safeReasonCode !== 'unknown-decision')) throw new ApprovalServiceError('unavailable');
      if (prior.value !== null) {
        const existing = await checkedView(binding.decisionId);
        if (!isDeepStrictEqual(existing.record.binding, binding)) throw new ApprovalServiceError('conflict');
        return projection(existing.record);
      }
      const current = control();
      let stale: { readonly record: ApprovalRequestRecord; readonly reason: string; readonly trustedContextDigest: string } | undefined;
      if (current.mode === 'waiting' && current.pendingDecisionId && store().replaceStalePending) {
        const pending = request(current.pendingDecisionId);
        try { await checkedView(pending.decisionId); }
        catch (error) {
          if (!(error instanceof ApprovalServiceError) || error.outcome !== 'stale') throw error;
          const trustedContextDigest = staleContextDigests.get(error);
          if (!trustedContextDigest) throw new ApprovalServiceError('unavailable');
          stale = { record: pending, reason: error.reasonCode, trustedContextDigest };
        }
        if (!stale) throw new ApprovalServiceError('conflict');
      } else if (current.mode !== 'runnable') throw new ApprovalServiceError('paused');
      const timestamp = callPort(now);
      const record: ApprovalRequestRecord = {
        schemaVersion: 'uc05-approval/0.1-draft', decisionId: binding.decisionId, binding: structuredClone(binding), taskId: options.taskId,
        repositoryId: context.facts.repositoryId, workspaceId: context.facts.workspaceId, createdRunId: context.runId,
        continuationRef: context.facts.continuationRef, requestVersion: 1, ...context.facts.policyIdentity,
        actionRef: context.action.actionId, actionDigest: binding.normalizedActionDigest, presentationDigest: bundle.summary.presentationDigest,
        createdAt: timestamp, submissionKey: binding.decisionId,
      };
      if (!validateApprovalRequestRecord(record).ok) throw new ApprovalServiceError('invalid');
      assertActive();
      if (admission.closed || coordinator.isClosed()) throw new ApprovalServiceError('unavailable');
      const admissionWasClosed = admission.closed;
      admission.closed = true;
      const event: DecisionEvent = { schemaVersion: 'uc05-approval/0.1-draft', eventId: computeCanonicalSha256({ type: 'request', taskId: options.taskId, decisionId: record.decisionId }), taskId: options.taskId, runId: context.runId, decisionId: record.decisionId, directionId: null, claimId: null, type: 'approval-request-created', outcome: 'pending', policyRef: context.facts.policyIdentity, safeReasonCode: 'approval-pending', timestamp };
      let response: StoreResponse<ApprovalRequestRecord>;
      let replacementEvidence: { readonly assessment: BindingAssessment; readonly staleEvent: DecisionEvent; readonly history: NonNullable<ReturnType<ApprovalStore['readHistory']>['value']>; readonly events: readonly DecisionEvent[] } | undefined;
      if (stale) {
        const trustedContextDigest = stale.trustedContextDigest;
        const assessment: BindingAssessment = { schemaVersion: 'uc05-approval/0.1-draft', assessmentId: computeCanonicalSha256({ type: 'assessment', decisionId: stale.record.decisionId, trustedContextDigest, version: current.version }), decisionId: stale.record.decisionId, checkedTaskVersion: current.version, checkedEpoch: current.epoch, trustedContextDigest, status: 'stale', reasonCodes: stale.reason.split(','), checkedAt: timestamp };
        const backend = store();
        if (!backend.replaceStalePending || !backend.readEvents) throw new ApprovalServiceError('unavailable');
        const history = backend.readHistory(options.taskId);
        const events = backend.readEvents(options.taskId);
        if (!plainContextData(history) || !plainContextData(events) || containsProtectedContent(JSON.stringify([history, events])) || !validateSafeResult(history.safe).ok || !validateSafeResult(events.safe).ok || history.safe.outcome !== 'ok' || events.safe.outcome !== 'ok' || history.safe.taskId !== options.taskId || events.safe.taskId !== options.taskId || !history.value || !Array.isArray(history.value.resolutions) || !Array.isArray(history.value.assessments ?? []) || !Array.isArray(events.value) || events.value.length > 512) throw new ApprovalServiceError('unavailable');
        const staleEvent: DecisionEvent = { ...event, eventId: assessment.assessmentId, decisionId: stale.record.decisionId, type: 'binding-assessed', outcome: 'stale', safeReasonCode: 'binding-stale' };
        replacementEvidence = { assessment, staleEvent, history: structuredClone(history.value), events: structuredClone(events.value) };
        response = backend.replaceStalePending(structuredClone({ expectedControlVersion: current.version, expectedRequestVersion: stale.record.requestVersion, trustedContextDigest, assessment, replacement: record, events: [staleEvent, event] }));
      } else {
        response = store().createPendingAndPause(structuredClone({ expectedControlVersion: current.version, submissionKey: record.submissionKey, request: record, event }));
      }
      if (!plainContextData(response) || containsProtectedContent(JSON.stringify(response)) || !validateSafeResult(response.safe).ok) throw new ApprovalServiceError('unavailable');
      if (response.safe.outcome !== 'pending') {
        if (stale && ['denied', 'conflict', 'invalid', 'stale'].includes(response.safe.outcome)) {
          const latest = control();
          const attempted = store().readRequest(record.decisionId);
          if (!plainContextData(attempted) || containsProtectedContent(JSON.stringify(attempted)) || !validateSafeResult(attempted.safe).ok || attempted.safe.outcome !== 'invalid' || attempted.safe.safeReasonCode !== 'unknown-decision' || attempted.value !== null) throw new ApprovalServiceError('unavailable');
          if (response.value !== null || response.safe.taskId !== options.taskId || response.safe.controlVersion !== latest.version || response.safe.eventRef !== null ||
            response.safe.decisionId !== null && ![stale.record.decisionId, record.decisionId].includes(response.safe.decisionId) || response.safe.requestVersion !== null && response.safe.requestVersion !== stale.record.requestVersion ||
            latest.repositoryId !== current.repositoryId || latest.workspaceId !== current.workspaceId || !isDeepStrictEqual(request(stale.record.decisionId), stale.record)) throw new ApprovalServiceError('unavailable');
          admission.closed = admissionWasClosed;
          throw new ApprovalServiceError(response.safe.outcome);
        }
        throw new ApprovalServiceError(response.safe.outcome === 'uncertain' ? 'uncertain' : 'unavailable');
      }
      if (!isDeepStrictEqual(response.value, record) || response.safe.taskId !== options.taskId || response.safe.decisionId !== record.decisionId || response.safe.requestVersion !== record.requestVersion || response.safe.controlVersion !== current.version + 1 || response.safe.eventRef !== event.eventId || response.safe.safeNextAction !== 'none') throw new ApprovalServiceError('unavailable');
      const paused = control();
      requireJournalEvent(readApprovalJournal(store(), options.taskId, profile), event);
      if (!isDeepStrictEqual(request(record.decisionId), record)) throw new ApprovalServiceError('unavailable');
      if (paused.mode !== 'waiting' || paused.pendingDecisionId !== binding.decisionId || paused.continuationRef !== record.continuationRef) throw new ApprovalServiceError('unavailable');
      if (stale && replacementEvidence) {
        const history = store().readHistory(options.taskId);
        const events = store().readEvents?.(options.taskId);
        if (paused.version !== current.version + 1 || paused.epoch !== current.epoch + 1 || paused.repositoryId !== current.repositoryId || paused.workspaceId !== current.workspaceId || !isDeepStrictEqual(paused.outstandingClaimRefs, current.outstandingClaimRefs) || !isDeepStrictEqual(request(record.decisionId), record) || !isDeepStrictEqual(request(stale.record.decisionId), stale.record) ||
          !plainContextData(history) || !plainContextData(events) || containsProtectedContent(JSON.stringify([history, events])) || !validateSafeResult(history.safe).ok || !events || !validateSafeResult(events.safe).ok || history.safe.outcome !== 'ok' || events.safe.outcome !== 'ok' || history.safe.taskId !== options.taskId || events.safe.taskId !== options.taskId ||
          !isDeepStrictEqual(history.value, { ...replacementEvidence.history, assessments: [...replacementEvidence.history.assessments ?? [], replacementEvidence.assessment] }) || !isDeepStrictEqual(events.value, [...replacementEvidence.events, replacementEvidence.staleEvent, event])) throw new ApprovalServiceError('unavailable');
      }
      callPort(() => coordinator.fence(paused, false));
      admission.closed = false;
      return projection(record);
    });
}
