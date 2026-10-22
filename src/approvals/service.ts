import { createServiceControl } from './service-control.ts';
import { createServiceRequest } from './service-request.ts';
import { createServiceDecision } from './service-decision.ts';
import type { ApprovalBinding } from '../contracts/foundation/uc03.ts';
import type { ApprovalRequestRecord, ApprovalTaskControl, HumanResolution, PolicyProfile } from '../contracts/approvals/contracts.ts';
import type { PolicyFacts } from './policy.ts';
import type { PresentationBundle } from './presentation.ts';
import { isDeepStrictEqual } from 'node:util';
import { computeActionDigest, computeCanonicalSha256, parseApprovalBinding, validateApprovalBinding, validateNormalizedAction } from '../contracts/foundation/uc03.ts';
import { validateApprovalRequestRecord, validateApprovalTaskControl, validateBindingAssessment, validateSafeResult } from '../contracts/approvals/contracts.ts';
import { compilePolicy } from './policy.ts';
import { buildPresentation } from './presentation.ts';
import { containsProtectedContent } from '../foundation/repository-tools.ts';
import { createApprovalControl } from './control.ts';
import { evaluatePlanBinding } from './plan-binding.ts';
import { readApprovalHistory, readApprovalJournal, readApprovalResolution, requireJournalEvent } from './history.ts';

export { ApprovalServiceError } from './service-data.ts';
export type { ApprovalContext, ApprovalService, ApprovalServiceOptions, ApprovalStore, ApprovalView, StoreResponse } from './service-data.ts';
import { ApprovalServiceError } from './service-data.ts';
import type { ApprovalContext, ApprovalService, ApprovalServiceOptions, ApprovalStore } from './service-data.ts';
import { identifier, plainContextData, dataRecord, exactFields, freshnessContext, decisionElements } from './service-context.ts';

export function createApprovalService(options: ApprovalServiceOptions): ApprovalService {
  const compiled = compilePolicy(options.profile);
  if (!compiled.ok || !identifier(options.taskId)) throw new ApprovalServiceError('invalid');
  const policy = compiled.value;
  const profile: PolicyProfile = policy.profile;
  const now = options.now ?? (() => new Date().toISOString());
  const admission = { closed: false };
  // An injected callback cannot mint a host-selected outcome or freshness reason.
  const callPort = <T>(operation: () => T): T => {
    try { return operation(); }
    catch { admission.closed = true; throw new ApprovalServiceError('unavailable'); }
  };
  const loadPort = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch { admission.closed = true; throw new ApprovalServiceError('unavailable'); }
  };
  const store = (): ApprovalStore => {
    if (!options.store || options.store.provenance !== 'mock') throw new ApprovalServiceError('unavailable');
    const backend = options.store;
    const { readEvents, recordDirection, replaceStalePending } = backend;
    return {
      provenance: backend.provenance,
      loadTaskControl: taskId => callPort(() => backend.loadTaskControl(taskId)),
      readRequest: decisionId => callPort(() => backend.readRequest(decisionId)),
      readHistory: taskId => callPort(() => backend.readHistory(taskId)),
      createPendingAndPause: input => callPort(() => backend.createPendingAndPause(input)),
      resolvePending: input => callPort(() => backend.resolvePending(input)),
      ...(readEvents ? { readEvents: (taskId: string) => callPort(() => readEvents.call(backend, taskId)) } : {}),
      ...(recordDirection ? { recordDirection: (input: unknown) => callPort(() => recordDirection.call(backend, input)) } : {}),
      ...(replaceStalePending ? { replaceStalePending: (input: unknown) => callPort(() => replaceStalePending.call(backend, input)) } : {}),
    };
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
        if (error.outcome === 'unavailable' || error.outcome === 'uncertain') admission.closed = true;
        throw error;
      }
      admission.closed = true;
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
  // Keep assessment evidence private and tied to the exact service-owned stale verdict.
  const staleContextDigests = new WeakMap<ApprovalServiceError, string>();
  const staleError = (reason: string, context: ApprovalContext): ApprovalServiceError => {
    const error = new ApprovalServiceError('stale', reason);
    staleContextDigests.set(error, computeCanonicalSha256(context));
    return error;
  };
  const trusted = async (decisionId: string, binding: ApprovalBinding, admitted?: ApprovalContext): Promise<ApprovalContext> => {
    const context = admitted ?? admitContext(await loadPort(() => options.context.loadForDecision(decisionId)));
    const result = policy.classify(context.action, context.facts);
    const current = control();
    if (!result.ok || result.permission === 'FORBIDDEN') throw new ApprovalServiceError(result.ok ? 'denied' : 'invalid');
    const freshness = evaluatePlanBinding(binding, context.freshness);
    if (freshness.status === 'stale') throw staleError(freshness.reasonCodes.join(','), context);
    if (freshness.status !== 'valid') throw new ApprovalServiceError('denied', freshness.reasonCodes.join(','));
    if (current.repositoryId !== context.facts.repositoryId || current.workspaceId !== context.facts.workspaceId) throw staleError('changed-repository-mapping', context);
    if (!identifier(context.runId) || context.facts.taskId !== options.taskId || current.workspaceId !== context.facts.workspaceId ||
      current.repositoryId !== context.facts.repositoryId || binding.taskId !== options.taskId ||
      !validateApprovalBinding({ ...binding, status: 'approved' }, context.freshness).ok ||
      computeActionDigest(context.action) !== binding.normalizedActionDigest ||
      context.facts.repositoryRevisionDigest !== binding.repositoryRevisionDigest ||
      context.facts.workspaceId !== binding.workspaceId || context.facts.policyIdentity.policyId !== binding.policyId ||
      context.facts.policyIdentity.policyVersion !== binding.policyVersion ||
      ((context.action.kind === 'approve_fix_plan') !== (binding.actionKind === 'fix_plan'))) throw staleError('changed-action-context', context);
    if (context.action.kind === 'approve_fix_plan' && (context.action.planVersion !== binding.planVersion || context.action.strategyDigest !== binding.strategyDigest || context.action.checkSetDigest !== binding.checkSetDigest || !isDeepStrictEqual(context.action.diagnosisEvidenceRefs, binding.evidenceRefs))) throw staleError('changed-plan-action', context);
    return context;
  };
  const presentation = (binding: ApprovalBinding, context: ApprovalContext, requestVersion = 1): PresentationBundle => {
    try { return buildPresentation({ requestVersion, binding: { ...binding, status: 'pending' }, freshness: context.freshness, action: context.action, repositoryId: context.facts.repositoryId, continuationRef: context.facts.continuationRef, policyIdentity: context.facts.policyIdentity, elements: context.elements }, profile); }
    catch { throw new ApprovalServiceError('denied'); }
  };
  const request = (decisionId: string): ApprovalRequestRecord => {
    if (!identifier(decisionId)) throw new ApprovalServiceError('invalid');
    const response = store().readRequest(decisionId);
    if (!plainContextData(response) || containsProtectedContent(JSON.stringify(response))) throw new ApprovalServiceError('unavailable');
    const checked = validateApprovalRequestRecord(response.value);
    if (!checked.ok || response.safe.outcome !== 'ok' || !validateSafeResult(response.safe).ok || checked.value.taskId !== options.taskId || checked.value.decisionId !== decisionId) throw new ApprovalServiceError('invalid');
    const record = checked.value;
    requireJournalEvent(readApprovalJournal(store(), options.taskId, profile), { schemaVersion: 'uc05-approval/0.1-draft', eventId: computeCanonicalSha256({ type: 'request', taskId: options.taskId, decisionId }), taskId: options.taskId, runId: record.createdRunId, decisionId, directionId: null, claimId: null, type: 'approval-request-created', outcome: 'pending', policyRef: { policyId: record.policyId, policyVersion: record.policyVersion, configId: record.configId, configVersion: record.configVersion }, safeReasonCode: 'approval-pending', timestamp: record.createdAt });
    return checked.value;
  };
  const resolution = (record: ApprovalRequestRecord): HumanResolution | undefined => readApprovalResolution(store(), options.taskId, record, options.operator?.identity, profile, request);
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
  const checkedView = async (decisionId: string, admitted?: ApprovalContext): Promise<{ record: ApprovalRequestRecord; context: ApprovalContext; bundle: PresentationBundle }> => {
    const record = request(decisionId);
    const context = await trusted(decisionId, record.binding, admitted);
    if (record.repositoryId !== context.facts.repositoryId || record.workspaceId !== context.facts.workspaceId || record.continuationRef !== context.facts.continuationRef || record.actionRef !== context.action.actionId || !isDeepStrictEqual({ policyId: record.policyId, policyVersion: record.policyVersion, configId: record.configId, configVersion: record.configVersion }, context.facts.policyIdentity)) throw staleError('changed-request-context', context);
    const bundle = presentation(record.binding, context, record.requestVersion);
    if (bundle.summary.presentationDigest !== record.presentationDigest) throw new ApprovalServiceError('conflict');
    return { record, context, bundle };
  };
  const runtime = { options, profile, policy, store, control, task, trusted, checkedView, presentation, request, resolution, projection, staleContextDigests, callPort, loadPort, admitContext, coordinator, now, admission, bounded };
  const service: ApprovalService = {
    history: (taskId, page) => bounded(async () => {
      task(taskId);
      return readApprovalHistory({ taskId, profile, store: store(), control: control(), operator: options.operator?.identity, observations: options.observations, request,
        observe: async record => {
          let classification: 'ALLOWED' | 'APPROVAL_REQUIRED' | 'FORBIDDEN' | 'unknown' = 'unknown';
          let context: ApprovalContext;
          try { context = admitContext(await options.context.loadForDecision(record.decisionId)); }
          catch { return { status: 'unknown', classification, reasonCode: 'current-binding-unavailable-or-ineligible' }; }
          try {
            const classified = policy.classify(context.action, context.facts);
            classification = classified.ok ? classified.permission : 'unknown';
            await checkedView(record.decisionId, context);
            return { status: 'valid', classification, reasonCode: 'current-binding-valid' };
          } catch (error) {
            return { status: error instanceof ApprovalServiceError && error.outcome === 'stale' ? 'stale' : error instanceof ApprovalServiceError && error.outcome === 'denied' ? 'denied' : 'unknown', classification, reasonCode: 'current-binding-unavailable-or-ineligible' };
          }
        } }, page);
    }),
    admitAttempt: (attemptId, claim) => !admission.closed && coordinator.admitAttempt(attemptId, claim),
    control: createServiceControl(runtime),
    provenance: 'mock',
    classify: action => bounded(async () => {
      if (admission.closed || coordinator.isClosed()) throw new ApprovalServiceError('unavailable');
      const current = control();
      if (current.mode !== 'runnable' || current.outstandingClaimRefs.length > 0) throw new ApprovalServiceError('paused');
      const context = admitContext(await loadPort(() => options.context.loadForAction(options.taskId, action.actionId)));
      if (!isDeepStrictEqual(action, context.action) || context.facts.taskId !== options.taskId || context.facts.repositoryId !== current.repositoryId || context.facts.workspaceId !== current.workspaceId) throw new ApprovalServiceError('invalid');
      const result = policy.classify(action, context.facts);
      if (!result.ok) throw new ApprovalServiceError('invalid');
      const latest = control();
      if (admission.closed || coordinator.isClosed() || latest.mode !== 'runnable' || latest.version !== current.version || latest.epoch !== current.epoch) throw new ApprovalServiceError('paused');
      return result.permission;
    }),
    requestDecision: createServiceRequest(runtime),
    validateBinding: binding => bounded(async () => {
      if (admission.closed || coordinator.isClosed()) return false;
      if (!plainContextData(binding) || !parseApprovalBinding(binding).ok) return false;
      try {
        const view = await checkedView(binding.decisionId);
        const current = control();
        const stored = projection(view.record);
        return !admission.closed && !coordinator.isClosed() && current.mode === 'runnable' && current.outstandingClaimRefs.length === 0 && stored.status === 'approved' && isDeepStrictEqual(binding, stored) && validateApprovalBinding(stored, view.context.freshness).ok;
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
    decide: createServiceDecision(runtime),

  };
  return Object.freeze(service);
}
