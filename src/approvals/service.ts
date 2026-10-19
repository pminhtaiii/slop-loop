import type { ApprovalBinding, ApprovalBindingContext, ApprovalPort, NormalizedAction } from '../contracts/foundation/uc03.ts';
import type { ApprovalRequestRecord, ApprovalTaskControl, HumanResolution, PolicyProfile, SafeResult, TrustedOperatorIdentity } from '../contracts/approvals/contracts.ts';
import type { PolicyFacts } from './policy.ts';
import type { PresentationBundle, PresentationInput } from './presentation.ts';
import { isDeepStrictEqual } from 'node:util';
import { computeActionDigest, computeCanonicalSha256, parseApprovalBinding, validateApprovalBinding } from '../contracts/foundation/uc03.ts';
import { validateApprovalRequestRecord, validateApprovalTaskControl, validateHumanResolution, validateSafeResult } from '../contracts/approvals/contracts.ts';
import { compilePolicy } from './policy.ts';
import { buildPresentation } from './presentation.ts';
import { containsProtectedContent } from '../foundation/repository-tools.ts';

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
  readHistory(taskId: string): StoreResponse<{ readonly resolutions: readonly HumanResolution[] }>;
  createPendingAndPause(input: unknown): StoreResponse<ApprovalRequestRecord>;
  resolvePending(input: unknown): StoreResponse<HumanResolution>;
}
export interface ApprovalServiceOptions {
  readonly taskId: string;
  readonly profile: unknown;
  readonly store?: ApprovalStore;
  readonly context: {
    loadForAction(taskId: string, actionId: string): Promise<unknown>;
    loadForDecision(decisionId: string): Promise<unknown>;
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
  list(taskId: string): Promise<{ readonly control: ApprovalTaskControl; readonly decisionId: string | null }>;
  show(taskId: string, decisionId: string): Promise<ApprovalView>;
  inspect(taskId: string, decisionId: string, page: number): Promise<{ readonly presentationDigest: string; readonly page: number; readonly pageCount: number; readonly content: string }>;
  decide(input: unknown): Promise<SafeResult>;
}
export class ApprovalServiceError extends Error {
  readonly outcome: SafeResult['outcome'];
  constructor(outcome: SafeResult['outcome']) { super('approval-operation-denied'); this.outcome = outcome; }
}
export function createApprovalService(options: ApprovalServiceOptions): ApprovalService {
  const compiled = compilePolicy(options.profile);
  if (!compiled.ok || !identifier(options.taskId)) throw new ApprovalServiceError('invalid');
  const policy = compiled.value;
  const profile: PolicyProfile = policy.profile;
  const now = options.now ?? (() => new Date().toISOString());
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
      if (error instanceof ApprovalServiceError) throw error;
      throw new ApprovalServiceError('unavailable');
    } finally { expired = true; if (timer !== undefined) clearTimeout(timer); }
  };
  const task = (taskId: string): void => { if (taskId !== options.taskId) throw new ApprovalServiceError('invalid'); };
  const control = (): ApprovalTaskControl => {
    const response = store().loadTaskControl(options.taskId);
    if (response.safe.outcome !== 'ok' || !validateSafeResult(response.safe).ok || !validateApprovalTaskControl(response.value).ok || response.value?.taskId !== options.taskId || containsProtectedContent(JSON.stringify(response.value))) throw new ApprovalServiceError('unavailable');
    return response.value;
  };
  const trusted = async (decisionId: string, binding: ApprovalBinding): Promise<ApprovalContext> => {
    const raw = await options.context.loadForDecision(decisionId);
    if (!raw || typeof raw !== 'object') throw new ApprovalServiceError('invalid');
    const context = raw as ApprovalContext;
    const result = policy.classify(context.action, context.facts);
    const current = control();
    if (!result.ok || result.permission === 'FORBIDDEN') throw new ApprovalServiceError(result.ok ? 'denied' : 'invalid');
    if (!identifier(context.runId) || context.facts.taskId !== options.taskId || current.workspaceId !== context.facts.workspaceId ||
      current.repositoryId !== context.facts.repositoryId || binding.taskId !== options.taskId ||
      !validateApprovalBinding({ ...binding, status: 'approved' }, context.freshness).ok ||
      computeActionDigest(context.action) !== binding.normalizedActionDigest ||
      context.facts.repositoryRevisionDigest !== binding.repositoryRevisionDigest ||
      context.facts.workspaceId !== binding.workspaceId || context.facts.policyIdentity.policyId !== binding.policyId ||
      context.facts.policyIdentity.policyVersion !== binding.policyVersion ||
      ((context.action.kind === 'approve_fix_plan') !== (binding.actionKind === 'fix_plan'))) throw new ApprovalServiceError('stale');
    if (context.action.kind === 'approve_fix_plan' && (context.action.planVersion !== binding.planVersion || context.action.strategyDigest !== binding.strategyDigest || context.action.checkSetDigest !== binding.checkSetDigest || !isDeepStrictEqual(context.action.diagnosisEvidenceRefs, binding.evidenceRefs))) throw new ApprovalServiceError('stale');
    return context;
  };
  const presentation = (binding: ApprovalBinding, context: ApprovalContext, requestVersion = 1): PresentationBundle => {
    try { return buildPresentation({ requestVersion, binding: { ...binding, status: 'pending' }, freshness: context.freshness, action: context.action, repositoryId: context.facts.repositoryId, continuationRef: context.facts.continuationRef, policyIdentity: context.facts.policyIdentity, elements: context.elements }, profile); }
    catch { throw new ApprovalServiceError('denied'); }
  };
  const request = (decisionId: string): ApprovalRequestRecord => {
    if (!identifier(decisionId)) throw new ApprovalServiceError('invalid');
    const response = store().readRequest(decisionId);
    const checked = validateApprovalRequestRecord(response.value);
    if (!checked.ok || response.safe.outcome !== 'ok' || !validateSafeResult(response.safe).ok || checked.value.taskId !== options.taskId || checked.value.decisionId !== decisionId) throw new ApprovalServiceError('invalid');
    return checked.value;
  };
  const resolution = (record: ApprovalRequestRecord): HumanResolution | undefined => {
    const response = store().readHistory(options.taskId);
    if (response.safe.outcome !== 'ok' || !validateSafeResult(response.safe).ok || !response.value || !Array.isArray(response.value.resolutions) || response.value.resolutions.length > 128) throw new ApprovalServiceError('unavailable');
    const matches = response.value.resolutions.filter(value => value.decisionId === record.decisionId);
    if (matches.length > 1) throw new ApprovalServiceError('unavailable');
    const found = matches[0];
    if (found && (!options.operator || !validateHumanResolution(found, { expectedDecisionId: record.decisionId, expectedRequestVersion: record.requestVersion, trustedOperator: options.operator.identity }).ok)) throw new ApprovalServiceError('denied');
    return found;
  };
  const projection = (record: ApprovalRequestRecord): ApprovalBinding => ({ ...record.binding, status: resolution(record)?.decision ?? 'pending' });
  const checkedView = async (decisionId: string): Promise<{ record: ApprovalRequestRecord; context: ApprovalContext; bundle: PresentationBundle }> => {
    const record = request(decisionId);
    const context = await trusted(decisionId, record.binding);
    if (record.repositoryId !== context.facts.repositoryId || record.workspaceId !== context.facts.workspaceId || record.continuationRef !== context.facts.continuationRef || record.actionRef !== context.action.actionId || !isDeepStrictEqual({ policyId: record.policyId, policyVersion: record.policyVersion, configId: record.configId, configVersion: record.configVersion }, context.facts.policyIdentity)) throw new ApprovalServiceError('stale');
    const bundle = presentation(record.binding, context, record.requestVersion);
    if (bundle.summary.presentationDigest !== record.presentationDigest) throw new ApprovalServiceError('conflict');
    return { record, context, bundle };
  };
  const service: ApprovalService = {
    provenance: 'mock',
    classify: action => bounded(async () => {
      const current = control();
      if (current.mode !== 'runnable' || current.outstandingClaimRefs.length > 0) throw new ApprovalServiceError('paused');
      const raw = await options.context.loadForAction(options.taskId, action.actionId);
      if (!raw || typeof raw !== 'object') throw new ApprovalServiceError('invalid');
      const context = raw as ApprovalContext;
      if (!isDeepStrictEqual(action, context.action) || context.facts.taskId !== options.taskId || context.facts.repositoryId !== current.repositoryId || context.facts.workspaceId !== current.workspaceId) throw new ApprovalServiceError('invalid');
      const result = policy.classify(action, context.facts);
      if (!result.ok) throw new ApprovalServiceError('invalid');
      const latest = control();
      if (latest.mode !== 'runnable' || latest.version !== current.version || latest.epoch !== current.epoch) throw new ApprovalServiceError('paused');
      return result.permission;
    }),
    requestDecision: binding => bounded(async assertActive => {
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
      if (current.mode !== 'runnable') throw new ApprovalServiceError('paused');
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
      const response = store().createPendingAndPause({ expectedControlVersion: current.version, submissionKey: record.submissionKey, request: record,
        event: { schemaVersion: 'uc05-approval/0.1-draft', eventId: computeCanonicalSha256({ type: 'request', taskId: options.taskId, decisionId: record.decisionId }), taskId: options.taskId, runId: context.runId, decisionId: record.decisionId, directionId: null, claimId: null, type: 'approval-request-created', outcome: 'pending', policyRef: context.facts.policyIdentity, safeReasonCode: 'approval-pending', timestamp } });
      if (response.safe.outcome !== 'pending' || !validateSafeResult(response.safe).ok || !isDeepStrictEqual(response.value, record)) throw new ApprovalServiceError(response.safe.outcome === 'conflict' ? 'conflict' : 'unavailable');
      const paused = control();
      if (paused.mode !== 'waiting' || paused.pendingDecisionId !== binding.decisionId || paused.continuationRef !== record.continuationRef) throw new ApprovalServiceError('unavailable');
      return projection(record);
    }),
    validateBinding: binding => bounded(async () => {
      try {
        const view = await checkedView(binding.decisionId);
        const current = control();
        const stored = projection(view.record);
        return current.mode === 'runnable' && current.outstandingClaimRefs.length === 0 && stored.status === 'approved' && isDeepStrictEqual(binding, stored) && validateApprovalBinding(stored, view.context.freshness).ok;
      } catch { return false; }
    }),
    resolve: decisionId => bounded(async () => projection((await checkedView(decisionId)).record)),
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
      const response = store().resolvePending({ expectedControlVersion: input.taskVersion, expectedRequestVersion: input.requestVersion,
        trustedOperator: options.operator.identity, trustedResponse: terminal,
        event: { schemaVersion: 'uc05-approval/0.1-draft', eventId: terminal.eventId, taskId: options.taskId, runId: context.runId, decisionId: record.decisionId, directionId: null, claimId: null, type: 'human-resolution-recorded', outcome: decision === 'approved' ? 'ok' : 'paused', policyRef: context.facts.policyIdentity, safeReasonCode: terminal.safeReasonCode, timestamp } });
      if (!validateSafeResult(response.safe).ok || response.safe.taskId !== options.taskId || response.safe.decisionId !== record.decisionId || response.safe.requestVersion !== record.requestVersion) throw new ApprovalServiceError('unavailable');
      if (response.safe.outcome === 'ok' || response.safe.outcome === 'paused') {
        if (!isDeepStrictEqual(response.value, terminal) || !isDeepStrictEqual(resolution(record), terminal)) throw new ApprovalServiceError('unavailable');
      }
      // Store reason strings are never copied to user output, even on infrastructure failures.
      return { ...response.safe, safeReasonCode: response.safe.outcome === 'ok' || response.safe.outcome === 'paused' ? 'decision-recorded' : 'decision-not-recorded' };
    }),
  };
  return Object.freeze(service);
}

function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/.test(value); }

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
