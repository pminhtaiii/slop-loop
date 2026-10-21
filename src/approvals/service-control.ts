import { isDeepStrictEqual } from 'node:util';
import { computeCanonicalSha256 } from '../contracts/foundation/uc03.ts';
import type { DecisionEvent, DeveloperDirection } from '../contracts/approvals/contracts.ts';
import { validateDecisionEvent, validateDeveloperDirection, validateSafeResult } from '../contracts/approvals/contracts.ts';
import { containsProtectedContent } from '../foundation/repository-tools.ts';
import { ApprovalServiceError } from './service-data.ts';
import type { ApprovalService, ServiceRuntime } from './service-data.ts';
import { directionInput, plainContextData, dataRecord, exactFields, identifier, requireDirectionEvent } from './service-context.ts';
import { readApprovalJournal } from './history.ts';

/** Control transitions retain the service's shared admission fence and bounded operation lifetime. */
export function createServiceControl(runtime: Pick<ServiceRuntime, 'options' | 'profile' | 'store' | 'control' | 'task' | 'callPort' | 'loadPort' | 'coordinator' | 'now' | 'admission' | 'bounded'>): ApprovalService['control'] {
  const { options, profile, store, control, task, callPort, loadPort, coordinator, now, admission, bounded } = runtime;
  return input => bounded(async assertActive => {
      if (!options.operator) throw new ApprovalServiceError('denied');
      if (!directionInput(input)) throw new ApprovalServiceError('invalid');
      task(input.taskId);
      const backend = store();
      if (!backend.recordDirection || !backend.readEvents || !options.activity || !options.context.loadForTask) throw new ApprovalServiceError('unavailable');
      const history = backend.readHistory(options.taskId);
      if (!plainContextData(history) || !validateSafeResult(history.safe).ok || history.safe.outcome !== 'ok' || !plainContextData(history.value) || !Array.isArray(history.value?.directions) || history.value.directions.length > 128) throw new ApprovalServiceError('unavailable');
      const matches = history.value.directions.filter(value => value.responseKey === input.responseKey);
      if (matches.length > 1) throw new ApprovalServiceError('unavailable');
      const prior = matches[0];
      let direction: DeveloperDirection;
      let event: DecisionEvent;
      if (prior) {
        if (!validateDeveloperDirection(prior, { expectedTaskId: options.taskId, expectedVersion: prior.expectedVersion, expectedEpoch: prior.expectedEpoch, trustedOperator: options.operator.identity }).ok || prior.direction !== input.direction || prior.expectedVersion !== input.taskVersion) throw new ApprovalServiceError('conflict');
        direction = prior;
        event = requireDirectionEvent(prior, readApprovalJournal(backend, options.taskId, profile));
      } else {
        const current = control();
        if (current.version !== input.taskVersion) throw new ApprovalServiceError('conflict');
        if ((admission.closed || coordinator.isClosed()) && input.direction !== 'end') throw new ApprovalServiceError('unavailable');
        const outstanding = callPort(() => options.activity?.inspectOutstanding(options.taskId));
        if (!plainContextData(outstanding) || !Array.isArray(outstanding) || outstanding.length > 128 || containsProtectedContent(JSON.stringify(outstanding))) throw new ApprovalServiceError('unavailable');
        if (input.direction !== 'end' && outstanding.length > 0) throw new ApprovalServiceError('uncertain');
        const context = await loadPort(() => options.context.loadForTask?.(options.taskId) ?? Promise.reject());
        if (!plainContextData(context) || !dataRecord(context) || !exactFields(context, ['taskId', 'repositoryId', 'workspaceId', 'runId', 'safeScopeRef', 'policyIdentity']) ||
          context['taskId'] !== options.taskId || context['repositoryId'] !== current.repositoryId || context['workspaceId'] !== current.workspaceId || !identifier(context['runId']) || !identifier(context['safeScopeRef']) || !isDeepStrictEqual(context['policyIdentity'], profile.policyIdentity)) throw new ApprovalServiceError('denied');
        const timestamp = callPort(now);
        const directionId = computeCanonicalSha256({ type: 'direction', taskId: options.taskId, responseKey: input.responseKey });
        direction = { schemaVersion: 'uc05-approval/0.1-draft', directionId, taskId: options.taskId, expectedVersion: input.taskVersion, expectedEpoch: current.epoch, direction: input.direction, safeScopeRef: context['safeScopeRef'], responseKey: input.responseKey, createdAt: timestamp };
        event = { schemaVersion: 'uc05-approval/0.1-draft', eventId: computeCanonicalSha256({ type: 'direction-event', directionId }), taskId: options.taskId, runId: context['runId'], decisionId: null, directionId, claimId: null, type: 'developer-direction-recorded', outcome: input.direction === 'end' ? 'paused' : 'ok', policyRef: profile.policyIdentity, safeReasonCode: 'developer-direction-recorded', timestamp };
      }
      if (!validateDeveloperDirection(direction, { expectedTaskId: options.taskId, expectedVersion: direction.expectedVersion, expectedEpoch: direction.expectedEpoch, trustedOperator: options.operator.identity }).ok || !validateDecisionEvent(event, profile).ok) throw new ApprovalServiceError('denied');
      assertActive();
      const wasClosed = admission.closed;
      admission.closed = true;
      const response = backend.recordDirection({ expectedControlVersion: input.taskVersion, trustedOperator: options.operator.identity, direction, event });
      if (!plainContextData(response) || !validateSafeResult(response.safe).ok || containsProtectedContent(JSON.stringify(response.safe)) || response.safe.taskId !== options.taskId) throw new ApprovalServiceError('unavailable');
      const committed = control();
      const recorded = response.safe.outcome === 'ok' || response.safe.outcome === 'paused';
      if (recorded) {
        const recordedHistory = backend.readHistory(options.taskId);
        const recordedEvents = backend.readEvents(options.taskId);
        if (!plainContextData(response.value) || !isDeepStrictEqual(response.value, direction) || response.safe.eventRef !== event.eventId || response.safe.controlVersion !== committed.version ||
          !plainContextData(recordedHistory) || !validateSafeResult(recordedHistory.safe).ok || recordedHistory.safe.outcome !== 'ok' || !Array.isArray(recordedHistory.value?.directions) || recordedHistory.value.directions.length > 128 || recordedHistory.value.directions.filter(value => isDeepStrictEqual(value, direction)).length !== 1 ||
          !plainContextData(recordedEvents) || !validateSafeResult(recordedEvents.safe).ok || recordedEvents.safe.outcome !== 'ok' || !Array.isArray(recordedEvents.value) || recordedEvents.value.length > 512 || recordedEvents.value.filter(value => isDeepStrictEqual(value, event)).length !== 1 ||
          (!prior && committed.mode !== (direction.direction === 'end' ? 'ended' : 'runnable'))) throw new ApprovalServiceError('unavailable');
        assertActive();
        if (!prior && direction.direction === 'end') callPort(() => coordinator.fence(committed, true));
        admission.closed = wasClosed;
      } else if (['denied', 'conflict', 'invalid', 'stale'].includes(response.safe.outcome)) {
        admission.closed = wasClosed;
      }
      return { schemaVersion: 'uc05-approval/0.1-draft', outcome: response.safe.outcome, safeReasonCode: recorded ? 'direction-recorded' : 'direction-not-recorded', taskId: options.taskId, decisionId: null, requestVersion: null, controlVersion: committed.version, eventRef: recorded ? event.eventId : null, safeNextAction: recorded ? 'none' : 'retry-read' };
    });
}
