import { isDeepStrictEqual } from 'node:util';
import type { ApprovalRequestRecord, ApprovalTaskControl, DecisionEvent, HumanResolution, PolicyProfile, TrustedOperatorIdentity } from '../contracts/approvals/contracts.ts';
import { validateBindingAssessment, validateDecisionEvent, validateDeveloperDirection, validateDispatchClaim, validateHumanResolution, validateSafeResult } from '../contracts/approvals/contracts.ts';
import { containsProtectedContent } from '../foundation/repository-tools.ts';
import { computeCanonicalSha256 } from '../contracts/foundation/uc03.ts';
import { ApprovalServiceError, type ApprovalStore } from './service-data.ts';
import { plainContextData, dataRecord, exactFields, identifier } from './service-context.ts';

export interface ApprovalHistoryPage {
  readonly taskId: string;
  readonly page: number;
  readonly pageCount: number;
  readonly totalBytes: number;
  readonly snapshotDigest: string;
  readonly truncated: false;
  readonly content: string;
}
export interface CurrentApprovalObservation {
  readonly status: 'valid' | 'stale' | 'denied' | 'unknown';
  readonly classification: 'ALLOWED' | 'APPROVAL_REQUIRED' | 'FORBIDDEN' | 'unknown';
  readonly reasonCode: string;
}

/** Admit the entire journal before filtering so foreign or duplicate evidence cannot disappear. */
export function readApprovalJournal(store: ApprovalStore, taskId: string, profile: PolicyProfile): readonly DecisionEvent[] {
  const response = store.readEvents?.(taskId);
  if (!plainContextData(response) || !response || !validateSafeResult(response.safe).ok || response.safe.outcome !== 'ok' || response.safe.taskId !== taskId || !Array.isArray(response.value) || response.value.length > 512 || containsProtectedContent(JSON.stringify(response))) throw new ApprovalServiceError('unavailable');
  const ids = new Set<string>();
  for (const event of response.value) {
    if (!validateDecisionEvent(event, profile).ok || event.taskId !== taskId || ids.has(event.eventId)) throw new ApprovalServiceError('unavailable');
    ids.add(event.eventId);
  }
  return response.value;
}

/** A successful receipt grants nothing until its exact immutable outbox event is observable. */
export function requireJournalEvent(events: readonly DecisionEvent[], expected: DecisionEvent): void {
  const matches = events.filter(event => event.eventId === expected.eventId);
  if (matches.length !== 1 || !isDeepStrictEqual(matches[0], expected)) throw new ApprovalServiceError('unavailable');
}

/** Validate all terminal rows before selecting one; a foreign row cannot hide behind a filter. */
export function readApprovalResolution(store: ApprovalStore, taskId: string, record: ApprovalRequestRecord, operator: TrustedOperatorIdentity | undefined, profile: PolicyProfile, request: (decisionId: string) => ApprovalRequestRecord): HumanResolution | undefined {
  const history = store.readHistory(taskId);
  if (!plainContextData(history) || !validateSafeResult(history.safe).ok || history.safe.outcome !== 'ok' || history.safe.taskId !== taskId || !history.value || !Array.isArray(history.value.resolutions) || history.value.resolutions.length > 128 || containsProtectedContent(JSON.stringify(history))) throw new ApprovalServiceError('unavailable');
  const ids = new Set<string>();
  const events = readApprovalJournal(store, taskId, profile);
  for (const candidate of history.value.resolutions) {
    if (!dataRecord(candidate) || !operator || !identifier(candidate['decisionId']) || typeof candidate['expectedRequestVersion'] !== 'number') throw new ApprovalServiceError('unavailable');
    const checked = validateHumanResolution(candidate, { expectedDecisionId: candidate['decisionId'], expectedRequestVersion: candidate['expectedRequestVersion'], trustedOperator: operator });
    if (!checked.ok || ids.has(checked.value.decisionId)) throw new ApprovalServiceError('unavailable');
    const terminal = checked.value;
    ids.add(terminal.decisionId);
    const associated = terminal.decisionId === record.decisionId ? record : request(terminal.decisionId);
    const event = events.find(value => value.eventId === terminal.eventId);
    if (terminal.expectedRequestVersion !== associated.requestVersion || !event || event.type !== 'human-resolution-recorded' || event.decisionId !== terminal.decisionId || event.claimId !== null || event.directionId !== null || event.timestamp !== terminal.decidedAt || event.safeReasonCode !== terminal.safeReasonCode || event.outcome !== (terminal.decision === 'approved' ? 'ok' : 'paused') || !isDeepStrictEqual(event.policyRef, { policyId: associated.policyId, policyVersion: associated.policyVersion, configId: associated.configId, configVersion: associated.configVersion })) throw new ApprovalServiceError('unavailable');
  }
  return history.value.resolutions.find(value => value.decisionId === record.decisionId);
}

export interface ApprovalHistoryReader {
  readonly taskId: string;
  readonly profile: PolicyProfile;
  readonly store: ApprovalStore;
  readonly control: ApprovalTaskControl;
  readonly operator: TrustedOperatorIdentity | undefined;
  readonly observations: { readonly provenance: 'mock'; read(taskId: string): Promise<unknown> } | undefined;
  request(decisionId: string): ApprovalRequestRecord;
  observe(record: ApprovalRequestRecord): Promise<CurrentApprovalObservation>;
}

/** Read committed metadata independently of current action-detail availability or freshness. */
export async function readApprovalHistory(reader: ApprovalHistoryReader, page: number): Promise<ApprovalHistoryPage> {
  if (!Number.isSafeInteger(page) || page < 1) throw new ApprovalServiceError('invalid');
  const { taskId, profile, store, control } = reader;
  if (reader.observations && reader.observations.provenance !== 'mock') throw new ApprovalServiceError('unavailable');
  const observations = reader.observations ? await reader.observations.read(taskId) : [];
  if (!plainContextData(observations) || !Array.isArray(observations) || observations.length > 128 || Buffer.byteLength(JSON.stringify(observations)) > profile.maxPresentationTotalBytes || containsProtectedContent(JSON.stringify(observations))) throw new ApprovalServiceError('unavailable');
  const events = readApprovalJournal(store, taskId, profile);
  const history = store.readHistory(taskId);
  if (!plainContextData(history) || !validateSafeResult(history.safe).ok || history.safe.outcome !== 'ok' || history.safe.taskId !== taskId || !history.value || containsProtectedContent(JSON.stringify(history))) throw new ApprovalServiceError('unavailable');
  const { resolutions, assessments = [], directions = [], claims = [] } = history.value;
  if (Object.keys(history.value).some(key => !['resolutions', 'assessments', 'directions', 'claims'].includes(key))) throw new ApprovalServiceError('unavailable');
  if (![resolutions, assessments, directions, claims].every(values => Array.isArray(values) && values.length <= 128)) throw new ApprovalServiceError('unavailable');
  const entries: Record<string, unknown>[] = [{ kind: 'control', source: 'current-owner-snapshot', ...control }, { kind: 'cancellation', source: 'current-observation', status: 'unknown', reasonCode: 'cancellation-observation-unavailable' }];
  const requests = new Map<string, ApprovalRequestRecord>();
  const unique = new Set<string>();
  const once = (identity: string): void => { if (unique.has(identity)) throw new ApprovalServiceError('unavailable'); unique.add(identity); };
  for (const event of events.filter(value => value.type === 'approval-request-created')) {
    if (!event.decisionId) throw new ApprovalServiceError('unavailable');
    once(`request:${event.decisionId}`);
    const record = reader.request(event.decisionId);
    if (event.timestamp !== record.createdAt || event.runId !== record.createdRunId || event.outcome !== 'pending' || event.directionId !== null || event.claimId !== null || !isDeepStrictEqual(event.policyRef, { policyId: record.policyId, policyVersion: record.policyVersion, configId: record.configId, configVersion: record.configVersion })) throw new ApprovalServiceError('unavailable');
    requests.set(record.decisionId, record);
    entries.push({ kind: 'request', source: 'committed-owner-record', ...record });
  }
  if (control.pendingDecisionId !== null && !requests.has(control.pendingDecisionId)) throw new ApprovalServiceError('unavailable');
  for (const resolution of resolutions) {
    if (!dataRecord(resolution)) throw new ApprovalServiceError('unavailable');
    const record = requests.get(resolution.decisionId);
    if (!record || !reader.operator || !validateHumanResolution(resolution, { expectedDecisionId: record.decisionId, expectedRequestVersion: record.requestVersion, trustedOperator: reader.operator }).ok) throw new ApprovalServiceError('unavailable');
    once(`resolution:${resolution.decisionId}`);
    const event = events.find(value => value.eventId === resolution.eventId);
    if (!event || event.type !== 'human-resolution-recorded' || event.decisionId !== record.decisionId || event.timestamp !== resolution.decidedAt || event.safeReasonCode !== resolution.safeReasonCode || event.outcome !== (resolution.decision === 'approved' ? 'ok' : 'paused') || event.claimId !== null || event.directionId !== null) throw new ApprovalServiceError('unavailable');
    entries.push({ kind: 'resolution', source: 'committed-owner-record', ...resolution });
  }
  for (const assessment of assessments) {
    if (!dataRecord(assessment)) throw new ApprovalServiceError('unavailable');
    if (!requests.has(assessment.decisionId) || !validateBindingAssessment(assessment, { expectedDecisionId: assessment.decisionId, expectedTaskVersion: assessment.checkedTaskVersion, expectedEpoch: assessment.checkedEpoch, trustedContextDigest: assessment.trustedContextDigest }).ok) throw new ApprovalServiceError('unavailable');
    once(`assessment:${assessment.assessmentId}`);
    if (!events.some(event => event.type === 'binding-assessed' && event.eventId === assessment.assessmentId && event.decisionId === assessment.decisionId && event.timestamp === assessment.checkedAt && event.outcome === assessment.status)) throw new ApprovalServiceError('unavailable');
    entries.push({ kind: 'assessment', source: 'committed-owner-record', ...assessment });
  }
  for (const direction of directions) {
    if (!dataRecord(direction)) throw new ApprovalServiceError('unavailable');
    if (!reader.operator || !validateDeveloperDirection(direction, { expectedTaskId: taskId, expectedVersion: direction.expectedVersion, expectedEpoch: direction.expectedEpoch, trustedOperator: reader.operator }).ok) throw new ApprovalServiceError('unavailable');
    once(`direction:${direction.directionId}`);
    if (!events.some(event => event.type === 'developer-direction-recorded' && event.directionId === direction.directionId && event.timestamp === direction.createdAt)) throw new ApprovalServiceError('unavailable');
    entries.push({ kind: 'direction', source: 'committed-owner-record', ...direction });
  }
  for (const claim of claims) {
    if (!dataRecord(claim)) throw new ApprovalServiceError('unavailable');
    if (!validateDispatchClaim(claim).ok || claim.taskId !== taskId || claim.decisionRefs.some(id => !requests.has(id))) throw new ApprovalServiceError('unavailable');
    once(`claim:${claim.claimId}`);
    const type = claim.phase === 'observed' ? 'dispatch-effect-observed' : claim.phase === 'uncertain' ? 'dispatch-uncertain' : claim.phase === 'reconciled' ? 'claim-reconciled' : 'dispatch-claim-created';
    if (!events.some(event => event.claimId === claim.claimId && event.type === type)) throw new ApprovalServiceError('unavailable');
    entries.push({ kind: 'claim', source: 'committed-owner-record', ...claim });
  }
  for (const event of events) {
    if (event.decisionId !== null && !requests.has(event.decisionId) || event.type === 'human-resolution-recorded' && !resolutions.some(value => value.eventId === event.eventId) || event.claimId !== null && !claims.some(value => value.claimId === event.claimId) || event.directionId !== null && !directions.some(value => value.directionId === event.directionId)) throw new ApprovalServiceError('unavailable');
    entries.push({ kind: 'event', source: 'committed-journal', ...event });
  }
  for (const observation of observations) {
    if (!dataRecord(observation) || !exactFields(observation, ['observationId', 'taskId', 'runId', 'decisionId', 'attemptId', 'claimId', 'state', 'observedAt', 'evidenceRef']) ||
      !['observationId', 'runId', 'attemptId', 'evidenceRef'].every(key => identifier(observation[key])) || observation['taskId'] !== taskId ||
      typeof observation['observedAt'] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(observation['observedAt']) || !Number.isFinite(Date.parse(observation['observedAt'])) ||
      !['cancelled', 'failed', 'completed', 'uncertain', 'cancellation-requested'].includes(String(observation['state'])) ||
      observation['decisionId'] !== null && (typeof observation['decisionId'] !== 'string' || !requests.has(observation['decisionId'])) ||
      observation['claimId'] !== null && !claims.some(claim => claim.claimId === observation['claimId'] && (observation['decisionId'] === null || claim.decisionRefs.includes(String(observation['decisionId']))))) throw new ApprovalServiceError('unavailable');
    once(`observation:${String(observation['observationId'])}`);
    once(`attempt:${String(observation['attemptId'])}`);
    entries.push({ kind: 'activity-observation', source: 'owner-activity-observation', ...observation, verifiedCompletion: 'unknown' });
  }
  for (const record of requests.values()) {
    entries.push({ kind: 'current-assessment', source: 'derived-current-observation', decisionId: record.decisionId, ...await reader.observe(record) });
    const related = claims.filter(claim => claim.decisionRefs.includes(record.decisionId));
    const status = related.some(claim => claim.phase === 'uncertain') ? 'uncertain' : related.some(claim => claim.phase === 'observed') ? 'observed' : 'unknown';
    entries.push({ kind: 'execution', source: 'owner-outcome-observation', decisionId: record.decisionId, status, verifiedCompletion: 'unknown', claimRefs: related.map(claim => claim.claimId) });
  }
  const latestControl = store.loadTaskControl(taskId);
  const latestHistory = store.readHistory(taskId);
  if (reader.observations) {
    const latestObservations = await reader.observations.read(taskId);
    if (!plainContextData(latestObservations) || !isDeepStrictEqual(latestObservations, observations)) throw new ApprovalServiceError('unavailable');
  }
  if (!plainContextData(latestControl) || !plainContextData(latestHistory) || !validateSafeResult(latestControl.safe).ok || latestControl.safe.outcome !== 'ok' || latestControl.safe.taskId !== taskId || !isDeepStrictEqual(latestControl.value, control) || !isDeepStrictEqual(latestHistory, history) || !isDeepStrictEqual(readApprovalJournal(store, taskId, profile), events)) throw new ApprovalServiceError('unavailable');
  return paginateApprovalHistory(taskId, entries, page, profile);
}

/** Each page is complete JSON. Both payloads and all envelope bytes count toward configured limits. */
function paginateApprovalHistory(taskId: string, entries: readonly Record<string, unknown>[], page: number, profile: PolicyProfile): ApprovalHistoryPage {
  if (!plainContextData(entries) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(JSON.stringify(entries)) || containsProtectedContent(JSON.stringify(entries))) throw new ApprovalServiceError('unavailable');
  const chunks: Record<string, unknown>[][] = [[]];
  const snapshotDigest = computeCanonicalSha256(entries);
  // Reserve the maximum envelope width before packing complete entries.
  const overhead = Buffer.byteLength(JSON.stringify({ taskId, page: profile.maxPresentationPages, pageCount: profile.maxPresentationPages, totalBytes: profile.maxPresentationTotalBytes, snapshotDigest, truncated: false, content: '' }));
  for (const entry of entries) {
    let chunk = chunks[chunks.length - 1];
    if (!chunk) throw new ApprovalServiceError('unavailable');
    if (overhead + Buffer.byteLength(JSON.stringify(JSON.stringify([...chunk, entry]))) - 2 > profile.maxPresentationPageBytes) {
      if (chunk.length === 0) throw new ApprovalServiceError('denied');
      chunk = []; chunks.push(chunk);
    }
    chunk.push(entry);
    if (overhead + Buffer.byteLength(JSON.stringify(JSON.stringify(chunk))) - 2 > profile.maxPresentationPageBytes) throw new ApprovalServiceError('denied');
  }
  if (chunks.length > profile.maxPresentationPages) throw new ApprovalServiceError('denied');
  let totalBytes = 0;
  let pages: ApprovalHistoryPage[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    pages = chunks.map((chunk, index) => ({ taskId, page: index + 1, pageCount: chunks.length, totalBytes, snapshotDigest, truncated: false, content: JSON.stringify(chunk) }));
    const bytes = pages.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0);
    if (bytes === totalBytes) break;
    totalBytes = bytes;
  }
  if (totalBytes > profile.maxPresentationTotalBytes || pages.some(value => Buffer.byteLength(JSON.stringify(value)) > profile.maxPresentationPageBytes)) throw new ApprovalServiceError('denied');
  const result = pages[page - 1];
  if (!result) throw new ApprovalServiceError('invalid');
  return result;
}
