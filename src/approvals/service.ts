import type { ApprovalBinding, ApprovalBindingContext, ApprovalPort, NormalizedAction } from '../contracts/foundation/uc03.ts';
import type { ApprovalRequestRecord, ApprovalTaskControl, BindingAssessment, DecisionEvent, DeveloperDirection, HumanResolution, PolicyProfile, SafeResult, TrustedOperatorIdentity } from '../contracts/approvals/contracts.ts';
import type { PolicyFacts } from './policy.ts';
import type { PresentationBundle, PresentationInput } from './presentation.ts';
import { isDeepStrictEqual } from 'node:util';
import { isProxy } from 'node:util/types';
import { computeActionDigest, computeCanonicalSha256, parseApprovalBinding, validateApprovalBinding, validateNormalizedAction } from '../contracts/foundation/uc03.ts';
import { validateApprovalRequestRecord, validateApprovalTaskControl, validateBindingAssessment, validateDecisionEvent, validateDeveloperDirection, validateHumanResolution, validateSafeResult } from '../contracts/approvals/contracts.ts';
import { compilePolicy } from './policy.ts';
import { buildPresentation } from './presentation.ts';
import { containsProtectedContent } from '../foundation/repository-tools.ts';
import { createApprovalControl, type ApprovalActivity } from './control.ts';
import { evaluatePlanBinding } from './plan-binding.ts';

export interface ApprovalContext {
  readonly action: NormalizedAction;
  readonly facts: PolicyFacts;
  readonly freshness: ApprovalBindingContext;
  readonly runId: string;
  readonly elements: PresentationInput['elements'];
}
export interface StoreResponse<T> { readonly safe: SafeResult; readonly value: T | null }
export interface ApprovalStore {
  readonly provenance: 'mock';
  loadTaskControl(taskId: string): StoreResponse<ApprovalTaskControl>;
  readRequest(decisionId: string): StoreResponse<ApprovalRequestRecord>;
  readHistory(taskId: string): StoreResponse<{ readonly resolutions: readonly HumanResolution[]; readonly directions?: readonly DeveloperDirection[]; readonly assessments?: readonly BindingAssessment[] }>;
  readEvents?(taskId: string): StoreResponse<readonly DecisionEvent[]>;
  recordDirection?(input: unknown): StoreResponse<DeveloperDirection>;
  createPendingAndPause(input: unknown): StoreResponse<ApprovalRequestRecord>;
  replaceStalePending?(input: unknown): StoreResponse<ApprovalRequestRecord>;
  resolvePending(input: unknown): StoreResponse<HumanResolution>;
}
export interface ApprovalServiceOptions {
  readonly activity?: ApprovalActivity;
  readonly taskId: string;
  readonly profile: unknown;
  readonly store?: ApprovalStore;
  readonly context: {
    loadForAction(taskId: string, actionId: string): Promise<unknown>;
    loadForDecision(decisionId: string): Promise<unknown>;
    loadForTask?(taskId: string): Promise<unknown>;
  };
  readonly operator?: { readonly identity: TrustedOperatorIdentity };
  readonly now?: () => string;
}
export interface ApprovalView {
  readonly control: ApprovalTaskControl;
  readonly binding: ApprovalBinding;
  readonly presentation: PresentationBundle['summary'];
}
export interface ApprovalService extends ApprovalPort {
  admitAttempt(attemptId: string, claim: unknown): boolean;
  control(input: unknown): Promise<SafeResult>;
  list(taskId: string): Promise<{ readonly control: ApprovalTaskControl; readonly decisionId: string | null }>;
  show(taskId: string, decisionId: string): Promise<ApprovalView>;
  inspect(taskId: string, decisionId: string, page: number): Promise<{ readonly presentationDigest: string; readonly page: number; readonly pageCount: number; readonly content: string }>;
  decide(input: unknown): Promise<SafeResult>;
}
export class ApprovalServiceError extends Error {
  readonly outcome: SafeResult['outcome'];
  readonly reasonCode: string;
  constructor(outcome: SafeResult['outcome'], reasonCode = 'approval-operation-denied') { super('approval-operation-denied'); this.outcome = outcome; this.reasonCode = reasonCode; }
}
export function createApprovalService(options: ApprovalServiceOptions): ApprovalService {
  const compiled = compilePolicy(options.profile);
  if (!compiled.ok || !identifier(options.taskId)) throw new ApprovalServiceError('invalid');
  const policy = compiled.value;
  const profile: PolicyProfile = policy.profile;
  const now = options.now ?? (() => new Date().toISOString());
  let localAdmissionClosed = false;
  const store = (): ApprovalStore => {
    if (!options.store || options.store.provenance !== 'mock') throw new ApprovalServiceError('unavailable');
    return options.store;
  };
  // Every host operation is bounded, including a context provider that never settles.
  const bounded = async <T>(operation: (assertActive: () => void) => Promise<T> | T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const assertActive = (): void => { if (expired) throw new ApprovalServiceError('unavailable'); };
    try {
      return await Promise.race([Promise.resolve().then(() => operation(assertActive)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new ApprovalServiceError('unavailable')); }, profile.operationDeadlineMs);
      })]);
    } catch (error) {
      if (error instanceof ApprovalServiceError) {
        if (error.outcome === 'unavailable' || error.outcome === 'uncertain') localAdmissionClosed = true;
        throw error;
      }
      localAdmissionClosed = true;
      throw new ApprovalServiceError('unavailable');
    } finally { expired = true; if (timer !== undefined) clearTimeout(timer); }
  };
  const task = (taskId: string): void => { if (taskId !== options.taskId) throw new ApprovalServiceError('invalid'); };
  const control = (): ApprovalTaskControl => {
    const response = store().loadTaskControl(options.taskId);
    if (!plainContextData(response) || response.safe.outcome !== 'ok' || !validateSafeResult(response.safe).ok || !validateApprovalTaskControl(response.value).ok || response.value?.taskId !== options.taskId || containsProtectedContent(JSON.stringify(response.value))) throw new ApprovalServiceError('unavailable');
    return response.value;
  };
  const coordinator = createApprovalControl({ taskId: options.taskId, load: control, ...(options.activity ? { activity: options.activity } : {}) });
  const admitContext = (raw: unknown): ApprovalContext => {
    if (!plainContextData(raw) || !dataRecord(raw) || !exactFields(raw, ['action', 'facts', 'freshness', 'runId', 'elements']) ||
      !identifier(raw['runId']) || !freshnessContext(raw['freshness']) || !decisionElements(raw['elements'])) throw new ApprovalServiceError('invalid');
    const action = validateNormalizedAction(raw['action']);
    const facts = raw['facts'];
    if (!action.ok || !dataRecord(facts) || !policy.classify(action.value, facts).ok) throw new ApprovalServiceError('invalid');
    const plan = facts['plan'];
    if (plan !== null && (!dataRecord(plan) || !parseApprovalBinding(plan['binding']).ok || !freshnessContext(plan['context']))) throw new ApprovalServiceError('invalid');
    // Policy validates every facts field; plan records also passed canonical and freshness validation.
    return { action: action.value, facts: facts as unknown as PolicyFacts, freshness: raw['freshness'], runId: raw['runId'], elements: raw['elements'] };
  };
  const trusted = async (decisionId: string, binding: ApprovalBinding): Promise<ApprovalContext> => {
    const context = admitContext(await options.context.loadForDecision(decisionId));
    const result = policy.classify(context.action, context.facts);
    const current = control();
    if (!result.ok || result.permission === 'FORBIDDEN') throw new ApprovalServiceError(result.ok ? 'denied' : 'invalid');
    const freshness = evaluatePlanBinding(binding, context.freshness);
    if (freshness.status !== 'valid') throw new ApprovalServiceError(freshness.status === 'stale' ? 'stale' : 'denied', freshness.reasonCodes.join(','));
    if (current.repositoryId !== context.facts.repositoryId || current.workspaceId !== context.facts.workspaceId) throw new ApprovalServiceError('stale', 'changed-repository-mapping');
    if (!identifier(context.runId) || context.facts.taskId !== options.taskId || current.workspaceId !== context.facts.workspaceId ||
      current.repositoryId !== context.facts.repositoryId || binding.taskId !== options.taskId ||
      !validateApprovalBinding({ ...binding, status: 'approved' }, context.freshness).ok ||
      computeActionDigest(context.action) !== binding.normalizedActionDigest ||
      context.facts.repositoryRevisionDigest !== binding.repositoryRevisionDigest ||
      context.facts.workspaceId !== binding.workspaceId || context.facts.policyIdentity.policyId !== binding.policyId ||
      context.facts.policyIdentity.policyVersion !== binding.policyVersion ||
      ((context.action.kind === 'approve_fix_plan') !== (binding.actionKind === 'fix_plan'))) throw new ApprovalServiceError('stale', 'changed-action-context');
    if (context.action.kind === 'approve_fix_plan' && (context.action.planVersion !== binding.planVersion || context.action.strategyDigest !== binding.strategyDigest || context.action.checkSetDigest !== binding.checkSetDigest || !isDeepStrictEqual(context.action.diagnosisEvidenceRefs, binding.evidenceRefs))) throw new ApprovalServiceError('stale', 'changed-plan-action');
    return context;
  };
  const presentation = (binding: ApprovalBinding, context: ApprovalContext, requestVersion = 1): PresentationBundle => {
    try { return buildPresentation({ requestVersion, binding: { ...binding, status: 'pending' }, freshness: context.freshness, action: context.action, repositoryId: context.facts.repositoryId, continuationRef: context.facts.continuationRef, policyIdentity: context.facts.policyIdentity, elements: context.elements }, profile); }
    catch { throw new ApprovalServiceError('denied'); }
  };
  const request = (decisionId: string): ApprovalRequestRecord => {
    if (!identifier(decisionId)) throw new ApprovalServiceError('invalid');
    const response = store().readRequest(decisionId);
    if (!plainContextData(response)) throw new ApprovalServiceError('unavailable');
    const checked = validateApprovalRequestRecord(response.value);
    if (!checked.ok || response.safe.outcome !== 'ok' || !validateSafeResult(response.safe).ok || checked.value.taskId !== options.taskId || checked.value.decisionId !== decisionId) throw new ApprovalServiceError('invalid');
    return checked.value;
  };
  const resolution = (record: ApprovalRequestRecord): HumanResolution | undefined => {
    const response = store().readHistory(options.taskId);
    if (!plainContextData(response)) throw new ApprovalServiceError('unavailable');
    if (response.safe.outcome !== 'ok' || !validateSafeResult(response.safe).ok || !response.value || !Array.isArray(response.value.resolutions) || response.value.resolutions.length > 128) throw new ApprovalServiceError('unavailable');
    const matches = response.value.resolutions.filter(value => value.decisionId === record.decisionId);
    if (matches.length > 1) throw new ApprovalServiceError('unavailable');
    const found = matches[0];
    if (found && (!options.operator || !validateHumanResolution(found, { expectedDecisionId: record.decisionId, expectedRequestVersion: record.requestVersion, trustedOperator: options.operator.identity }).ok)) throw new ApprovalServiceError('denied');
    return found;
  };
  const projection = (record: ApprovalRequestRecord): ApprovalBinding => {
    const terminal = resolution(record);
    if (terminal) return { ...record.binding, status: terminal.decision };
    const history = store().readHistory(options.taskId);
    if (!plainContextData(history) || !validateSafeResult(history.safe).ok || history.safe.outcome !== 'ok' || !history.value) throw new ApprovalServiceError('unavailable');
    const assessments = history.value.assessments ?? [];
    if (!Array.isArray(assessments) || assessments.length > 128) throw new ApprovalServiceError('unavailable');
    for (const assessment of assessments.filter(value => value.decisionId === record.decisionId)) {
      // Historical assessments can only deny this identity; current context is still required for admission.
      if (!validateBindingAssessment(assessment, { expectedDecisionId: record.decisionId, expectedTaskVersion: assessment.checkedTaskVersion, expectedEpoch: assessment.checkedEpoch, trustedContextDigest: assessment.trustedContextDigest }).ok) throw new ApprovalServiceError('unavailable');
      if (assessment.status !== 'valid') return { ...record.binding, status: 'stale', reason: 'request-replaced' };
    }
    return { ...record.binding, status: 'pending' };
  };
  const checkedView = async (decisionId: string): Promise<{ record: ApprovalRequestRecord; context: ApprovalContext; bundle: PresentationBundle }> => {
    const record = request(decisionId);
    const context = await trusted(decisionId, record.binding);
    if (record.repositoryId !== context.facts.repositoryId || record.workspaceId !== context.facts.workspaceId || record.continuationRef !== context.facts.continuationRef || record.actionRef !== context.action.actionId || !isDeepStrictEqual({ policyId: record.policyId, policyVersion: record.policyVersion, configId: record.configId, configVersion: record.configVersion }, context.facts.policyIdentity)) throw new ApprovalServiceError('stale', 'changed-request-context');
    const bundle = presentation(record.binding, context, record.requestVersion);
    if (bundle.summary.presentationDigest !== record.presentationDigest) throw new ApprovalServiceError('conflict');
    return { record, context, bundle };
  };
  const service: ApprovalService = {
    admitAttempt: (attemptId, claim) => !localAdmissionClosed && coordinator.admitAttempt(attemptId, claim),
    control: input => bounded(async assertActive => {
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
        const journal = backend.readEvents(options.taskId);
        if (!plainContextData(journal) || !validateSafeResult(journal.safe).ok || journal.safe.outcome !== 'ok' || !plainContextData(journal.value) || !Array.isArray(journal.value) || journal.value.length > 512) throw new ApprovalServiceError('unavailable');
        const events = journal.value.filter(value => value.type === 'developer-direction-recorded' && value.directionId === prior.directionId);
        const original = events[0];
        if (events.length !== 1 || !original || !validateDecisionEvent(original, profile).ok || original.taskId !== options.taskId || original.decisionId !== null || original.claimId !== null) throw new ApprovalServiceError('unavailable');
        direction = prior;
        event = original;
      } else {
        const current = control();
        if (current.version !== input.taskVersion) throw new ApprovalServiceError('conflict');
        if ((localAdmissionClosed || coordinator.isClosed()) && input.direction !== 'end') throw new ApprovalServiceError('unavailable');
        const outstanding = options.activity.inspectOutstanding(options.taskId);
        if (!plainContextData(outstanding) || !Array.isArray(outstanding) || outstanding.length > 128 || containsProtectedContent(JSON.stringify(outstanding))) throw new ApprovalServiceError('unavailable');
        if (input.direction !== 'end' && outstanding.length > 0) throw new ApprovalServiceError('uncertain');
        const context = await options.context.loadForTask(options.taskId);
        if (!plainContextData(context) || !dataRecord(context) || !exactFields(context, ['taskId', 'repositoryId', 'workspaceId', 'runId', 'safeScopeRef', 'policyIdentity']) ||
          context['taskId'] !== options.taskId || context['repositoryId'] !== current.repositoryId || context['workspaceId'] !== current.workspaceId || !identifier(context['runId']) || !identifier(context['safeScopeRef']) || !isDeepStrictEqual(context['policyIdentity'], profile.policyIdentity)) throw new ApprovalServiceError('denied');
        const timestamp = now();
        const directionId = computeCanonicalSha256({ type: 'direction', taskId: options.taskId, responseKey: input.responseKey });
        direction = { schemaVersion: 'uc05-approval/0.1-draft', directionId, taskId: options.taskId, expectedVersion: input.taskVersion, expectedEpoch: current.epoch, direction: input.direction, safeScopeRef: context['safeScopeRef'], responseKey: input.responseKey, createdAt: timestamp };
        event = { schemaVersion: 'uc05-approval/0.1-draft', eventId: computeCanonicalSha256({ type: 'direction-event', directionId }), taskId: options.taskId, runId: context['runId'], decisionId: null, directionId, claimId: null, type: 'developer-direction-recorded', outcome: input.direction === 'end' ? 'paused' : 'ok', policyRef: profile.policyIdentity, safeReasonCode: 'developer-direction-recorded', timestamp };
      }
      if (!validateDeveloperDirection(direction, { expectedTaskId: options.taskId, expectedVersion: direction.expectedVersion, expectedEpoch: direction.expectedEpoch, trustedOperator: options.operator.identity }).ok || !validateDecisionEvent(event, profile).ok) throw new ApprovalServiceError('denied');
      assertActive();
      const wasClosed = localAdmissionClosed;
      localAdmissionClosed = true;
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
        if (!prior && direction.direction === 'end') coordinator.fence(committed, true);
        localAdmissionClosed = wasClosed;
      } else if (['denied', 'conflict', 'invalid', 'stale'].includes(response.safe.outcome)) {
        localAdmissionClosed = wasClosed;
      }
      return { schemaVersion: 'uc05-approval/0.1-draft', outcome: response.safe.outcome, safeReasonCode: recorded ? 'direction-recorded' : 'direction-not-recorded', taskId: options.taskId, decisionId: null, requestVersion: null, controlVersion: committed.version, eventRef: recorded ? event.eventId : null, safeNextAction: recorded ? 'none' : 'retry-read' };
    }),
    provenance: 'mock',
    classify: action => bounded(async () => {
      if (localAdmissionClosed || coordinator.isClosed()) throw new ApprovalServiceError('unavailable');
      const current = control();
      if (current.mode !== 'runnable' || current.outstandingClaimRefs.length > 0) throw new ApprovalServiceError('paused');
      const context = admitContext(await options.context.loadForAction(options.taskId, action.actionId));
      if (!isDeepStrictEqual(action, context.action) || context.facts.taskId !== options.taskId || context.facts.repositoryId !== current.repositoryId || context.facts.workspaceId !== current.workspaceId) throw new ApprovalServiceError('invalid');
      const result = policy.classify(action, context.facts);
      if (!result.ok) throw new ApprovalServiceError('invalid');
      const latest = control();
      if (localAdmissionClosed || coordinator.isClosed() || latest.mode !== 'runnable' || latest.version !== current.version || latest.epoch !== current.epoch) throw new ApprovalServiceError('paused');
      return result.permission;
    }),
    requestDecision: binding => bounded(async assertActive => {
      if (localAdmissionClosed || coordinator.isClosed()) throw new ApprovalServiceError('unavailable');
      if (!plainContextData(binding)) throw new ApprovalServiceError('invalid');
      const checked = parseApprovalBinding(binding);
      if (!checked.ok || binding.status !== 'pending') throw new ApprovalServiceError('invalid');
      const context = await trusted(binding.decisionId, binding);
      const classification = policy.classify(context.action, context.facts);
      if (!classification.ok || classification.permission !== 'APPROVAL_REQUIRED') throw new ApprovalServiceError('denied');
      const bundle = presentation(binding, context);
      const prior = store().readRequest(binding.decisionId);
      if (!validateSafeResult(prior.safe).ok || prior.value === null && (prior.safe.outcome !== 'invalid' || prior.safe.safeReasonCode !== 'unknown-decision')) throw new ApprovalServiceError('unavailable');
      if (prior.value !== null) {
        const existing = await checkedView(binding.decisionId);
        if (!isDeepStrictEqual(existing.record.binding, binding)) throw new ApprovalServiceError('conflict');
        return projection(existing.record);
      }
      const current = control();
      let stale: { readonly record: ApprovalRequestRecord; readonly reason: string } | undefined;
      if (current.mode === 'waiting' && current.pendingDecisionId && store().replaceStalePending) {
        const pending = request(current.pendingDecisionId);
        try { await checkedView(pending.decisionId); }
        catch (error) {
          if (!(error instanceof ApprovalServiceError) || error.outcome !== 'stale') throw error;
          stale = { record: pending, reason: error.reasonCode };
        }
        if (!stale) throw new ApprovalServiceError('conflict');
      } else if (current.mode !== 'runnable') throw new ApprovalServiceError('paused');
      const timestamp = now();
      const record: ApprovalRequestRecord = {
        schemaVersion: 'uc05-approval/0.1-draft', decisionId: binding.decisionId, binding: structuredClone(binding), taskId: options.taskId,
        repositoryId: context.facts.repositoryId, workspaceId: context.facts.workspaceId, createdRunId: context.runId,
        continuationRef: context.facts.continuationRef, requestVersion: 1, ...context.facts.policyIdentity,
        actionRef: context.action.actionId, actionDigest: binding.normalizedActionDigest, presentationDigest: bundle.summary.presentationDigest,
        createdAt: timestamp, submissionKey: binding.decisionId,
      };
      if (!validateApprovalRequestRecord(record).ok) throw new ApprovalServiceError('invalid');
      assertActive();
      if (localAdmissionClosed || coordinator.isClosed()) throw new ApprovalServiceError('unavailable');
      localAdmissionClosed = true;
      const event: DecisionEvent = { schemaVersion: 'uc05-approval/0.1-draft', eventId: computeCanonicalSha256({ type: 'request', taskId: options.taskId, decisionId: record.decisionId }), taskId: options.taskId, runId: context.runId, decisionId: record.decisionId, directionId: null, claimId: null, type: 'approval-request-created', outcome: 'pending', policyRef: context.facts.policyIdentity, safeReasonCode: 'approval-pending', timestamp };
      let response: StoreResponse<ApprovalRequestRecord>;
      if (stale) {
        const trustedContextDigest = computeCanonicalSha256(context);
        const assessment: BindingAssessment = { schemaVersion: 'uc05-approval/0.1-draft', assessmentId: computeCanonicalSha256({ type: 'assessment', decisionId: stale.record.decisionId, trustedContextDigest, version: current.version }), decisionId: stale.record.decisionId, checkedTaskVersion: current.version, checkedEpoch: current.epoch, trustedContextDigest, status: 'stale', reasonCodes: stale.reason.split(','), checkedAt: timestamp };
        const backend = store();
        if (!backend.replaceStalePending) throw new ApprovalServiceError('unavailable');
        response = backend.replaceStalePending({ expectedControlVersion: current.version, expectedRequestVersion: stale.record.requestVersion, trustedContextDigest, assessment, replacement: record, events: [{ ...event, eventId: assessment.assessmentId, decisionId: stale.record.decisionId, type: 'binding-assessed', outcome: 'stale', safeReasonCode: 'binding-stale' }, event] });
      } else {
        response = store().createPendingAndPause({ expectedControlVersion: current.version, submissionKey: record.submissionKey, request: record, event });
      }
      if (response.safe.outcome !== 'pending' || !validateSafeResult(response.safe).ok || !isDeepStrictEqual(response.value, record)) throw new ApprovalServiceError(response.safe.outcome === 'conflict' ? 'conflict' : 'unavailable');
      const paused = control();
      if (paused.mode !== 'waiting' || paused.pendingDecisionId !== binding.decisionId || paused.continuationRef !== record.continuationRef) throw new ApprovalServiceError('unavailable');
      coordinator.fence(paused, false);
      localAdmissionClosed = false;
      return projection(record);
    }),
    validateBinding: binding => bounded(async () => {
      if (localAdmissionClosed || coordinator.isClosed()) return false;
      if (!plainContextData(binding) || !parseApprovalBinding(binding).ok) return false;
      try {
        const view = await checkedView(binding.decisionId);
        const current = control();
        const stored = projection(view.record);
        return !localAdmissionClosed && !coordinator.isClosed() && current.mode === 'runnable' && current.outstandingClaimRefs.length === 0 && stored.status === 'approved' && isDeepStrictEqual(binding, stored) && validateApprovalBinding(stored, view.context.freshness).ok;
      } catch { return false; }
    }),
    resolve: decisionId => bounded(async () => {
      const record = request(decisionId);
      const stored = projection(record);
      if (stored.status === 'rejected' || stored.status === 'stale') return stored;
      try { await checkedView(decisionId); return stored; }
      catch (error) {
        if (error instanceof ApprovalServiceError && error.outcome === 'stale') return { ...stored, status: 'stale', reason: error.reasonCode };
        throw error;
      }
    }),
    list: taskId => bounded(() => { task(taskId); const current = control(); return { control: current, decisionId: current.pendingDecisionId }; }),
    show: (taskId, decisionId) => bounded(async () => { task(taskId); const view = await checkedView(decisionId); return { control: control(), binding: projection(view.record), presentation: view.bundle.summary }; }),
    inspect: (taskId, decisionId, page) => bounded(async () => {
      task(taskId); const view = await checkedView(decisionId);
      const content = view.bundle.pages[page - 1];
      if (!Number.isSafeInteger(page) || page < 1 || content === undefined) throw new ApprovalServiceError('invalid');
      return { presentationDigest: view.bundle.summary.presentationDigest, page, pageCount: view.bundle.pages.length, content };
    }),
    decide: input => bounded(async assertActive => {
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
      const timestamp = prior?.decidedAt ?? now();
      const terminal: HumanResolution = prior ?? {
        schemaVersion: 'uc05-approval/0.1-draft', decisionId: record.decisionId, responseKey: input.responseKey,
        expectedRequestVersion: record.requestVersion, operatorChannelRef: options.operator.identity.channelRef,
        decision, safeReasonCode: decision === 'approved' ? 'developer-approved' : 'developer-rejected',
        decidedAt: timestamp, eventId: computeCanonicalSha256({ type: 'response', taskId: options.taskId, decisionId: record.decisionId, responseKey: input.responseKey }),
      };
      if (!validateHumanResolution(terminal, { expectedDecisionId: record.decisionId, expectedRequestVersion: record.requestVersion, trustedOperator: options.operator.identity }).ok) throw new ApprovalServiceError('denied');
      assertActive();
      const admissionWasClosed = localAdmissionClosed;
      localAdmissionClosed = true;
      const response = store().resolvePending({ expectedControlVersion: input.taskVersion, expectedRequestVersion: input.requestVersion,
        trustedOperator: options.operator.identity, trustedResponse: terminal,
        event: { schemaVersion: 'uc05-approval/0.1-draft', eventId: terminal.eventId, taskId: options.taskId, runId: context.runId, decisionId: record.decisionId, directionId: null, claimId: null, type: 'human-resolution-recorded', outcome: decision === 'approved' ? 'ok' : 'paused', policyRef: context.facts.policyIdentity, safeReasonCode: terminal.safeReasonCode, timestamp } });
      if (!plainContextData(response) || !validateSafeResult(response.safe).ok || containsProtectedContent(JSON.stringify(response.safe)) || response.safe.taskId !== options.taskId || response.safe.decisionId !== record.decisionId || response.safe.requestVersion !== record.requestVersion) throw new ApprovalServiceError('unavailable');
      if (response.safe.outcome === 'ok' || response.safe.outcome === 'paused') {
        const committed = control();
        if (response.safe.eventRef !== terminal.eventId || response.safe.controlVersion !== committed.version ||
          (!prior && committed.mode !== (decision === 'approved' ? 'runnable' : 'rejected')) ||
          (response.safe.outcome === 'paused' && decision !== 'rejected') ||
          !isDeepStrictEqual(response.value, terminal) || !isDeepStrictEqual(resolution(record), terminal)) throw new ApprovalServiceError('unavailable');
        if (!prior && decision === 'rejected') coordinator.fence(committed, true);
        localAdmissionClosed = admissionWasClosed;
      } else if (['denied', 'conflict', 'invalid', 'stale'].includes(response.safe.outcome)) {
        localAdmissionClosed = admissionWasClosed;
      }
      const recorded = response.safe.outcome === 'ok' || response.safe.outcome === 'paused';
      const uncertain = response.safe.outcome === 'uncertain';
      // Only validated identities and host-selected reasons/actions cross the store boundary.
      return { schemaVersion: 'uc05-approval/0.1-draft', outcome: response.safe.outcome,
        taskId: options.taskId, decisionId: record.decisionId, requestVersion: record.requestVersion,
        controlVersion: response.safe.controlVersion, eventRef: recorded ? terminal.eventId : null,
        safeNextAction: recorded ? 'none' : uncertain ? 'reconcile' : 'retry-read',
        safeReasonCode: recorded ? 'decision-recorded' : uncertain ? 'decision-reconciliation-required' : 'decision-not-recorded' };
    }),
  };
  return Object.freeze(service);
}

function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/.test(value); }

function directionInput(value: unknown): value is { readonly taskId: string; readonly taskVersion: number; readonly direction: 'resume' | 'revise' | 'end'; readonly responseKey: string } {
  if (!plainContextData(value) || !dataRecord(value) || !exactFields(value, ['taskId', 'taskVersion', 'direction', 'responseKey'])) return false;
  return identifier(value['taskId']) && identifier(value['responseKey']) && typeof value['taskVersion'] === 'number' && Number.isSafeInteger(value['taskVersion']) && value['taskVersion'] > 0 && ['resume', 'revise', 'end'].includes(String(value['direction']));
}

/** Inspect descriptors recursively before validators or property reads can invoke input getters. */
function plainContextData(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 65536;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 1024) return false;
  if (Array.isArray(value) && (keys.length !== value.length + 1 || !Array.from({ length: value.length }, (_, index) => String(index)).every(key => Object.hasOwn(descriptors, key)))) return false;
  return keys.every(key => {
    if (Array.isArray(value) && key === 'length') return true;
    const descriptor = typeof key === 'string' ? descriptors[key] : undefined;
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor && plainContextData(descriptor.value, depth + 1);
  });
}

function dataRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean { return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)); }

function freshnessContext(value: unknown): value is ApprovalBindingContext {
  if (!dataRecord(value)) return false;
  const ids = ['currentTaskId', 'currentWorkspaceId', 'currentPolicyId', 'currentPolicyVersion'];
  const digests = ['currentRepositoryRevisionDigest', 'currentNormalizedActionDigest'];
  const planDigests = ['currentStrategyDigest', 'currentCriteriaDigest', 'currentCheckSetDigest'];
  const optional = [...planDigests, 'currentPlanVersion', 'currentBaselineRef', 'currentEvidenceRefs'];
  const sha = (digest: unknown): boolean => typeof digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(digest);
  return Object.keys(value).every(key => [...ids, ...digests, ...optional].includes(key)) &&
    ids.every(key => identifier(value[key])) && digests.every(key => sha(value[key])) &&
    planDigests.every(key => !Object.hasOwn(value, key) || sha(value[key])) &&
    (!Object.hasOwn(value, 'currentBaselineRef') || identifier(value['currentBaselineRef'])) &&
    (!Object.hasOwn(value, 'currentPlanVersion') || typeof value['currentPlanVersion'] === 'number' && Number.isSafeInteger(value['currentPlanVersion']) && value['currentPlanVersion'] > 0) &&
    (!Object.hasOwn(value, 'currentEvidenceRefs') || Array.isArray(value['currentEvidenceRefs']) && value['currentEvidenceRefs'].length > 0 && value['currentEvidenceRefs'].every(identifier));
}

function decisionElements(value: unknown): value is PresentationInput['elements'] {
  if (!dataRecord(value) || !exactFields(value, ['action', 'necessity', 'targets', 'consequences', 'verificationStatus'])) return false;
  const text = (field: unknown): boolean => typeof field === 'string' && field.trim().length > 0;
  return ['action', 'necessity', 'consequences', 'verificationStatus'].every(key => text(value[key])) &&
    Array.isArray(value['targets']) && value['targets'].length > 0 && value['targets'].length <= 32 && value['targets'].every(text);
}

interface DecisionInput {
  readonly taskId: string; readonly decisionId: string; readonly taskVersion: number; readonly requestVersion: number;
  readonly presentationDigest: string; readonly decision: 'approve' | 'reject'; readonly responseKey: string;
}
function decisionInput(value: unknown): value is DecisionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = ['taskId', 'decisionId', 'taskVersion', 'requestVersion', 'presentationDigest', 'decision', 'responseKey'];
  if (Reflect.ownKeys(value).length !== keys.length || !keys.every(key => descriptors[key]?.enumerable && 'value' in descriptors[key])) return false;
  const candidate = value as Record<string, unknown>;
  return identifier(candidate['taskId']) && identifier(candidate['decisionId']) && identifier(candidate['responseKey']) &&
    [candidate['taskVersion'], candidate['requestVersion']].every(number => typeof number === 'number' && Number.isSafeInteger(number) && number > 0) &&
    typeof candidate['presentationDigest'] === 'string' && /^sha256:[0-9a-f]{64}$/.test(candidate['presentationDigest']) &&
    (candidate['decision'] === 'approve' || candidate['decision'] === 'reject');
}
