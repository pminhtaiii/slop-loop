import { isDeepStrictEqual } from 'node:util';
import type { NormalizedAction, ProviderRequest } from '../contracts/foundation/uc03.ts';
import { computeActionDigest, validateNormalizedAction, validateProviderRequest } from '../contracts/foundation/uc03.ts';
import type { ActionDecisionReceipt, ApprovalTaskControl, PolicyEvaluationReceipt, ProviderAdmissionReceipt } from '../contracts/approvals/contracts.ts';
import {
  UC05_APPROVAL_SCHEMA_VERSION_V02,
  computeActionDecisionReceiptDigest,
  validateActionDecisionReceipt,
  validatePolicyEvaluationReceipt,
  validateProviderAdmissionReceipt,
} from '../contracts/approvals/contracts.ts';
import type { EvaluatePolicyOptionsV02, EvaluateProviderAdmissionOptionsV02, PolicyFactsV02 } from './policy.ts';
import { computePolicyFreshnessContextDigest } from './policy-v02.ts';
import { isBoundedPolicyData, isPolicyData } from './policy-v01.ts';
import { ApprovalServiceError } from './service-data.ts';
import type { ApprovalService, ApprovalServiceOptions } from './service-data.ts';
import { createApprovalServiceCore } from './service-v01.ts';

const POLICY_OPTION_KEYS = ['planApplicability', 'planBindingDigest', 'planDecisionRef', 'diagnosticPurpose', 'taskCriteriaDigest', 'receiptId'] as const;
const PROVIDER_OPTION_KEYS = ['role', 'planApplicability', 'planBindingDigest', 'planDecisionRef', 'diagnosticPurpose', 'taskCriteriaDigest', 'receiptId'] as const;
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/;

function retainImmutable<T>(receipts: Map<string, T>, id: string, receipt: T, reasonCode: string): T {
  const prior = receipts.get(id);
  if (prior !== undefined) {
    if (!isDeepStrictEqual(prior, receipt)) throw new ApprovalServiceError('conflict', reasonCode);
    return prior;
  }
  receipts.set(id, receipt);
  return receipt;
}

export interface ApprovalServiceV02 {
  readonly decisionAuthorityGeneration: number;
  evaluatePolicy(action: NormalizedAction, options?: EvaluatePolicyOptionsV02): Promise<PolicyEvaluationReceipt>;
  admitProvider(request: ProviderRequest | unknown, options?: EvaluateProviderAdmissionOptionsV02): Promise<ProviderAdmissionReceipt>;
  issueActionDecision(decisionId: string, evaluationReceipt: PolicyEvaluationReceipt | string): Promise<ActionDecisionReceipt>;
  readProviderAdmissionReceipt(receiptId: string): Promise<ProviderAdmissionReceipt>;
  readActionDecisionReceipt(decisionId: string): Promise<ActionDecisionReceipt>;
}

export interface ApprovalServiceOptionsV02 extends ApprovalServiceOptions {
  readonly decisionAuthorityGeneration?: number;
}

function sameRunnableAuthority(latest: ApprovalTaskControl, before: ApprovalTaskControl): boolean {
  return latest.mode === 'runnable' && latest.outstandingClaimRefs.length === 0 &&
    latest.version === before.version && latest.epoch === before.epoch && latest.taskId === before.taskId &&
    latest.repositoryId === before.repositoryId && latest.workspaceId === before.workspaceId &&
    latest.continuationRef === before.continuationRef && latest.pendingDecisionId === before.pendingDecisionId;
}

function serviceOptions(input: unknown, fields: readonly string[], generation: number): Record<string, unknown> {
  if (input === undefined) return { decisionAuthorityGeneration: generation };
  if (!isBoundedPolicyData(input, 8_192) || typeof input !== 'object' || input === null || Array.isArray(input)) throw new ApprovalServiceError('invalid');
  const record = input as Record<string, unknown>;
  const allowed = new Set([...fields, 'decisionAuthorityGeneration', 'freshnessContextDigest']);
  if (Object.keys(record).some(key => !allowed.has(key))) throw new ApprovalServiceError('invalid');
  const result: Record<string, unknown> = {};
  for (const key of fields) if (Object.hasOwn(record, key)) result[key] = record[key];
  // Generation and freshness are service-owned; caller values are deliberately ignored.
  result['decisionAuthorityGeneration'] = generation;
  return result;
}

export function createApprovalService(options: ApprovalServiceOptionsV02): ApprovalService & ApprovalServiceV02 {
  const core = createApprovalServiceCore(options);
  const { runtime } = core;
  const generation = runtime.decisionAuthorityGeneration;
  const retainedEvaluations = new Map<string, PolicyEvaluationReceipt>();
  const retainedProviderAdmissions = new Map<string, ProviderAdmissionReceipt>();
  const retainedActionDecisions = new Map<string, ActionDecisionReceipt>();

  const issueActionDecision = async (decisionId: string, evaluationInput: PolicyEvaluationReceipt | string): Promise<ActionDecisionReceipt> => {
    if (runtime.admission.closed || runtime.coordinator.isClosed()) throw new ApprovalServiceError('unavailable');
    const before = runtime.control();
    if (before.mode !== 'runnable' || before.outstandingClaimRefs.length > 0) throw new ApprovalServiceError('paused');
    let originalRecord;
    try { originalRecord = runtime.request(decisionId); }
    catch { throw new ApprovalServiceError('unavailable', 'decision-not-found'); }
    if (runtime.projection(originalRecord).status !== 'approved') throw new ApprovalServiceError('unavailable', 'decision-not-approved');
    const view = await runtime.checkedView(decisionId);

    const latest = runtime.control();
    const currentRecord = runtime.request(decisionId);
    if (runtime.admission.closed || runtime.coordinator.isClosed() || !sameRunnableAuthority(latest, before) ||
      !isDeepStrictEqual(currentRecord, originalRecord) || runtime.projection(currentRecord).status !== 'approved') {
      throw new ApprovalServiceError('paused');
    }
    if (view.record.decisionId !== decisionId || !isDeepStrictEqual(view.record, originalRecord)) throw new ApprovalServiceError('stale');

    if (typeof evaluationInput !== 'string' && (!isPolicyData(evaluationInput) || typeof evaluationInput !== 'object' || evaluationInput === null || Array.isArray(evaluationInput))) {
      throw new ApprovalServiceError('denied', 'unrecognized-policy-evaluation');
    }
    const evaluationId = typeof evaluationInput === 'string'
      ? evaluationInput
      : (typeof evaluationInput['receiptId'] === 'string' ? evaluationInput['receiptId'] : '');
    const retained = retainedEvaluations.get(evaluationId);
    if (!retained) throw new ApprovalServiceError('denied', 'unrecognized-policy-evaluation');
    if (typeof evaluationInput !== 'string') {
      const validated = validatePolicyEvaluationReceipt(evaluationInput);
      if (!validated.ok || !isDeepStrictEqual(validated.value, retained)) throw new ApprovalServiceError('denied', 'unrecognized-policy-evaluation');
    }
    if (retained.result !== 'APPROVAL_REQUIRED' || retained.decisionAuthorityGeneration !== generation ||
      retained.actionDigest !== computeActionDigest(view.context.action) ||
      retained.actionDigest !== originalRecord.binding.normalizedActionDigest) throw new ApprovalServiceError('denied', 'evaluation-does-not-authorize-decision');

    const currentEvaluation = runtime.policy.evaluatePolicyV02(view.context.action, view.context.facts, {
      decisionAuthorityGeneration: generation,
    });
    if (!currentEvaluation.ok || currentEvaluation.permission !== 'APPROVAL_REQUIRED' ||
      currentEvaluation.receipt.freshnessContextDigest !== retained.freshnessContextDigest ||
      currentEvaluation.receipt.policyId !== retained.policyId || currentEvaluation.receipt.policyVersion !== retained.policyVersion ||
      currentEvaluation.receipt.configId !== retained.configId || currentEvaluation.receipt.configVersion !== retained.configVersion ||
      computePolicyFreshnessContextDigest(view.context.action, view.context.facts as PolicyFactsV02, runtime.profile.policyIdentity, generation) !== retained.freshnessContextDigest) {
      throw new ApprovalServiceError('stale', 'evaluation-context-changed');
    }

    const unsignedActionDecision = {
      schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
      decisionId,
      actionDigest: originalRecord.binding.normalizedActionDigest,
      evaluationReceiptRef: retained.receiptId,
      decisionAuthorityGeneration: generation,
      status: 'approved' as const,
    };
    const actionReceipt: ActionDecisionReceipt = Object.freeze({
      ...unsignedActionDecision,
      decisionDigest: computeActionDecisionReceiptDigest(unsignedActionDecision),
    });
    if (!validateActionDecisionReceipt(actionReceipt).ok) throw new ApprovalServiceError('invalid', 'invalid-action-decision-receipt');
    return retainImmutable(retainedActionDecisions, decisionId, actionReceipt, 'action-decision-receipt-id-collision');
  };

  const service: ApprovalService & ApprovalServiceV02 = {
    ...core.service,
    decisionAuthorityGeneration: generation,
    evaluatePolicy: (actionInput, evalOptions) => runtime.bounded(async () => {
      if (runtime.admission.closed || runtime.coordinator.isClosed()) throw new ApprovalServiceError('unavailable');
      const action = validateNormalizedAction(actionInput);
      if (!action.ok) throw new ApprovalServiceError('invalid');
      const validatedOptions = serviceOptions(evalOptions, POLICY_OPTION_KEYS, generation);
      const before = runtime.control();
      if (before.mode !== 'runnable' || before.outstandingClaimRefs.length > 0) throw new ApprovalServiceError('paused');
      const rawContext = await runtime.loadPort(() => options.context.loadForAction(options.taskId, action.value.actionId));
      const context = runtime.admitContext(rawContext);
      if (!isDeepStrictEqual(action.value, context.action) || context.facts.taskId !== options.taskId ||
        context.facts.repositoryId !== before.repositoryId || context.facts.workspaceId !== before.workspaceId) throw new ApprovalServiceError('invalid');
      const result = runtime.policy.evaluatePolicyV02(action.value, context.facts, validatedOptions);
      if (!result.ok) throw new ApprovalServiceError('denied', result.reasonCode);
      const latest = runtime.control();
      if (runtime.admission.closed || runtime.coordinator.isClosed() || !sameRunnableAuthority(latest, before)) throw new ApprovalServiceError('paused');
      const prior = retainedEvaluations.get(result.receipt.receiptId);
      if (prior && !isDeepStrictEqual(prior, result.receipt)) throw new ApprovalServiceError('conflict', 'evaluation-receipt-id-collision');
      retainedEvaluations.set(result.receipt.receiptId, result.receipt);
      return result.receipt;
    }),
    admitProvider: (requestInput, providerOptions) => runtime.bounded(async () => {
      if (runtime.admission.closed || runtime.coordinator.isClosed()) throw new ApprovalServiceError('unavailable');
      if (!isBoundedPolicyData(requestInput, 65_536)) throw new ApprovalServiceError('invalid');
      const parsed = validateProviderRequest(requestInput);
      if (!parsed.ok) throw new ApprovalServiceError('invalid');
      const request = parsed.value;
      const validatedOptions = serviceOptions(providerOptions, PROVIDER_OPTION_KEYS, generation);
      const before = runtime.control();
      if (before.mode !== 'runnable' || before.outstandingClaimRefs.length > 0) throw new ApprovalServiceError('paused');
      const rawContext = await runtime.loadPort(() => options.context.loadForAction(options.taskId, request.providerRequestId));
      const context = runtime.admitContext(rawContext);
      const facts = context.facts as PolicyFactsV02;
      if (context.facts.taskId !== options.taskId || context.facts.repositoryId !== before.repositoryId ||
        context.facts.workspaceId !== before.workspaceId || facts.runId !== request.runId) throw new ApprovalServiceError('invalid');
      const result = runtime.policy.evaluateProviderAdmissionV02(request, facts, validatedOptions);
      if (!result.ok) throw new ApprovalServiceError('denied', result.reasonCode);
      const latest = runtime.control();
      if (runtime.admission.closed || runtime.coordinator.isClosed() || !sameRunnableAuthority(latest, before)) throw new ApprovalServiceError('paused');
      return retainImmutable(retainedProviderAdmissions, result.receipt.receiptId, result.receipt, 'provider-admission-receipt-id-collision');
    }),
    readProviderAdmissionReceipt: receiptId => runtime.bounded(async () => {
      if (runtime.admission.closed || runtime.coordinator.isClosed()) throw new ApprovalServiceError('unavailable');
      if (typeof receiptId !== 'string' || !RECEIPT_ID.test(receiptId)) throw new ApprovalServiceError('invalid');
      const retained = retainedProviderAdmissions.get(receiptId);
      if (!retained || !validateProviderAdmissionReceipt(retained).ok) throw new ApprovalServiceError('denied', 'unrecognized-provider-admission-receipt');
      const before = runtime.control();
      if (before.mode !== 'runnable' || before.outstandingClaimRefs.length > 0) throw new ApprovalServiceError('paused');
      const rawContext = await runtime.loadPort(() => options.context.loadForAction(options.taskId, retained.providerRequestId));
      const context = runtime.admitContext(rawContext);
      const facts = context.facts as PolicyFactsV02;
      const request = facts.providerRequest;
      if (!request || context.facts.taskId !== options.taskId || context.facts.repositoryId !== before.repositoryId ||
        context.facts.workspaceId !== before.workspaceId || facts.runId !== request.runId || request.providerRequestId !== retained.providerRequestId) {
        throw new ApprovalServiceError('stale', 'provider-admission-context-changed');
      }
      const providerOptions: EvaluateProviderAdmissionOptionsV02 = retained.planApplicability === 'pre-plan-diagnostic'
        ? {
          decisionAuthorityGeneration: generation,
          receiptId: retained.receiptId,
          planApplicability: retained.planApplicability,
          diagnosticPurpose: retained.diagnosticPurpose,
          taskCriteriaDigest: retained.taskCriteriaDigest,
        }
        : {
          decisionAuthorityGeneration: generation,
          receiptId: retained.receiptId,
          planApplicability: retained.planApplicability,
          planBindingDigest: retained.planBindingDigest,
          planDecisionRef: retained.planDecisionRef,
        };
      const current = runtime.policy.evaluateProviderAdmissionV02(request, facts, providerOptions);
      if (!current.ok || !isDeepStrictEqual(current.receipt, retained)) throw new ApprovalServiceError('stale', 'provider-admission-context-changed');
      const latest = runtime.control();
      if (runtime.admission.closed || runtime.coordinator.isClosed() || !sameRunnableAuthority(latest, before)) throw new ApprovalServiceError('paused');
      return retained;
    }),
    issueActionDecision: (decisionId, evaluationInput) => runtime.bounded(() => issueActionDecision(decisionId, evaluationInput)),
    readActionDecisionReceipt: decisionId => runtime.bounded(async () => {
      if (runtime.admission.closed || runtime.coordinator.isClosed()) throw new ApprovalServiceError('unavailable');
      if (typeof decisionId !== 'string' || !RECEIPT_ID.test(decisionId)) throw new ApprovalServiceError('invalid');
      const retained = retainedActionDecisions.get(decisionId);
      if (!retained || !validateActionDecisionReceipt(retained).ok) throw new ApprovalServiceError('denied', 'unrecognized-action-decision-receipt');
      const current = await issueActionDecision(decisionId, retained.evaluationReceiptRef);
      if (!isDeepStrictEqual(current, retained)) throw new ApprovalServiceError('stale', 'action-decision-context-changed');
      return retained;
    }),
  };
  return Object.freeze(service);
}

export const createApprovalServiceV02 = createApprovalService;
