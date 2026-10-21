import { isDeepStrictEqual } from 'node:util';
import { computeCanonicalSha256 } from '../contracts/foundation/uc03.ts';
import type { DecisionEvent, HumanResolution } from '../contracts/approvals/contracts.ts';
import { validateHumanResolution, validateSafeResult } from '../contracts/approvals/contracts.ts';
import { containsProtectedContent } from '../foundation/repository-tools.ts';
import { ApprovalServiceError } from './service-data.ts';
import type { ApprovalService, ServiceRuntime } from './service-data.ts';
import { decisionInput, plainContextData } from './service-context.ts';
import { readApprovalJournal, requireJournalEvent } from './history.ts';

/** Decision transitions retain the service's shared admission fence and bounded operation lifetime. */
export function createServiceDecision(runtime: Pick<ServiceRuntime, 'options' | 'profile' | 'store' | 'control' | 'task' | 'checkedView' | 'resolution' | 'callPort' | 'coordinator' | 'now' | 'admission' | 'bounded'>): ApprovalService['decide'] {
  const { options, profile, store, control, task, checkedView, resolution, callPort, coordinator, now, admission, bounded } = runtime;
  return input => bounded(async assertActive => {
      if (!options.operator) throw new ApprovalServiceError('denied');
      if (!decisionInput(input)) throw new ApprovalServiceError('invalid');
      task(input.taskId);
      const view = await checkedView(input.decisionId);
      const { record, context } = view;
      if (input.requestVersion !== record.requestVersion || input.presentationDigest !== view.bundle.summary.presentationDigest) throw new ApprovalServiceError('conflict');
      const current = control();
      const prior = resolution(record);
      const decision = input.decision === 'approve' ? 'approved' : 'rejected';
      if (prior && (prior.responseKey !== input.responseKey || prior.decision !== decision)) throw new ApprovalServiceError('conflict');
      if (!prior && (current.version !== input.taskVersion || current.mode !== 'waiting' || current.pendingDecisionId !== record.decisionId)) throw new ApprovalServiceError('conflict');
      const timestamp = prior?.decidedAt ?? callPort(now);
      const terminal: HumanResolution = prior ?? {
        schemaVersion: 'uc05-approval/0.1-draft', decisionId: record.decisionId, responseKey: input.responseKey,
        expectedRequestVersion: record.requestVersion, operatorChannelRef: options.operator.identity.channelRef,
        decision, safeReasonCode: decision === 'approved' ? 'developer-approved' : 'developer-rejected',
        decidedAt: timestamp, eventId: computeCanonicalSha256({ type: 'response', taskId: options.taskId, decisionId: record.decisionId, responseKey: input.responseKey }),
      };
      if (!validateHumanResolution(terminal, { expectedDecisionId: record.decisionId, expectedRequestVersion: record.requestVersion, trustedOperator: options.operator.identity }).ok) throw new ApprovalServiceError('denied');
      assertActive();
      const admissionWasClosed = admission.closed;
      admission.closed = true;
      const expectedEvent: DecisionEvent = prior
        ? readApprovalJournal(store(), options.taskId, profile).find(value => value.eventId === terminal.eventId) ?? (() => { throw new ApprovalServiceError('unavailable'); })()
        : { schemaVersion: 'uc05-approval/0.1-draft', eventId: terminal.eventId, taskId: options.taskId, runId: context.runId, decisionId: record.decisionId, directionId: null, claimId: null, type: 'human-resolution-recorded', outcome: decision === 'approved' ? 'ok' : 'paused', policyRef: context.facts.policyIdentity, safeReasonCode: terminal.safeReasonCode, timestamp };
      const response = store().resolvePending({ expectedControlVersion: input.taskVersion, expectedRequestVersion: input.requestVersion,
        trustedOperator: options.operator.identity, trustedResponse: terminal,
        event: expectedEvent });
      if (!plainContextData(response) || !validateSafeResult(response.safe).ok || containsProtectedContent(JSON.stringify(response.safe)) || response.safe.taskId !== options.taskId || response.safe.decisionId !== record.decisionId || response.safe.requestVersion !== record.requestVersion) throw new ApprovalServiceError('unavailable');
      if (response.safe.outcome === 'ok' || response.safe.outcome === 'paused') {
        requireJournalEvent(readApprovalJournal(store(), options.taskId, profile), expectedEvent);
        const committed = control();
        if (response.safe.eventRef !== terminal.eventId || response.safe.controlVersion !== committed.version ||
          (!prior && committed.mode !== (decision === 'approved' ? 'runnable' : 'rejected')) ||
          (response.safe.outcome === 'paused' && decision !== 'rejected') ||
          !isDeepStrictEqual(response.value, terminal) || !isDeepStrictEqual(resolution(record), terminal)) throw new ApprovalServiceError('unavailable');
        if (!prior && decision === 'rejected') callPort(() => coordinator.fence(committed, true));
        admission.closed = admissionWasClosed;
      } else if (['denied', 'conflict', 'invalid', 'stale'].includes(response.safe.outcome)) {
        admission.closed = admissionWasClosed;
      }
      const recorded = response.safe.outcome === 'ok' || response.safe.outcome === 'paused';
      const uncertain = response.safe.outcome === 'uncertain';
      // Only validated identities and host-selected reasons/actions cross the store boundary.
      return { schemaVersion: 'uc05-approval/0.1-draft', outcome: response.safe.outcome,
        taskId: options.taskId, decisionId: record.decisionId, requestVersion: record.requestVersion,
        controlVersion: response.safe.controlVersion, eventRef: recorded ? terminal.eventId : null,
        safeNextAction: recorded ? 'none' : uncertain ? 'reconcile' : 'retry-read',
        safeReasonCode: recorded ? 'decision-recorded' : uncertain ? 'decision-reconciliation-required' : 'decision-not-recorded' };
    });
}
