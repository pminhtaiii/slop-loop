/** Success acknowledgements for committed durable approval mutations.
 *
 * UC-05 consumers trust a write only when the receipt carries their own transition's
 * outcome and committed event identity: request creation answers `pending` with the
 * request-event ID, and resolutions, directions and replacements acknowledge the event
 * they appended. Kept beside the adapter so that file stays within the 20,000-byte limit.
 */
import { validateDecisionEvent } from '../../contracts/approvals/contracts.ts';
import type { ApprovalRequestRecord, ApprovalTaskControl, DeveloperDirection, HumanResolution, PolicyProfile } from '../../contracts/approvals/contracts.ts';
import type { StoreResponse } from '../../approvals/service-data.ts';
import { readEvents } from './approval-events.ts';
import { makeResponse } from './approval-types.ts';

/** Event ID of a caller-supplied event that validates, else null (no event was appended). */
export function committedEventId(event: unknown, profile: PolicyProfile): string | null {
  if (event === undefined) return null;
  const checked = validateDecisionEvent(event, profile);
  return checked.ok ? checked.value.eventId : null;
}

/** The request event among a replacement batch, which is what the consumer acknowledges. */
export function requestEventId(events: readonly unknown[], decisionId: string, profile: PolicyProfile): string | null {
  for (const event of events) {
    const checked = validateDecisionEvent(event, profile);
    if (checked.ok && checked.value.type === 'approval-request-created' && checked.value.decisionId === decisionId) return checked.value.eventId;
  }
  return null;
}

/** Receipt id for a direction: its committed audit event on replay, else the event just appended. */
export function directionReceiptId(storageDir: string, direction: DeveloperDirection, replayed: boolean, event: unknown, profile: PolicyProfile): string | null {
  if (!replayed) return committedEventId(event, profile);
  const res = readEvents(storageDir, direction.taskId);
  return res.safe.outcome === 'ok' ? (res.value?.find(entry => entry.type === 'developer-direction-recorded' && entry.directionId === direction.directionId)?.eventId ?? null) : null;
}

export function requestCreatedResponse(control: ApprovalTaskControl, request: ApprovalRequestRecord, eventRef: string | null): StoreResponse<ApprovalRequestRecord> {
  return makeResponse(control, 'pending', 'pending-created', request, request.decisionId, request.requestVersion, eventRef);
}

export function requestReplacedResponse(control: ApprovalTaskControl, request: ApprovalRequestRecord, eventRef: string | null): StoreResponse<ApprovalRequestRecord> {
  return makeResponse(control, 'pending', 'stale-pending-replaced', request, request.decisionId, request.requestVersion, eventRef);
}

export function resolutionResponse(control: ApprovalTaskControl, resolution: HumanResolution, eventRef: string | null, alreadyResolved: boolean): StoreResponse<HumanResolution> {
  return makeResponse(control, 'ok', alreadyResolved ? 'already-resolved' : 'pending-resolved', resolution, resolution.decisionId, resolution.expectedRequestVersion, eventRef);
}

export function directionResponse(control: ApprovalTaskControl, direction: DeveloperDirection, eventRef: string | null): StoreResponse<DeveloperDirection> {
  return makeResponse(control, 'ok', 'direction-recorded', direction, null, null, eventRef);
}
