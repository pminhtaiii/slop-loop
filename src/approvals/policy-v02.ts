import type { NormalizedAction, PermissionClass, ProviderRequest } from '../contracts/foundation/uc03.ts';
import { computeActionDigest, computeCanonicalSha256, computeRequestContentDigest, validateNormalizedAction, validateProviderRequest } from '../contracts/foundation/uc03.ts';
import type { PolicyEvaluationReceipt, PolicyIdentity, PolicyProfile, ProviderAdmissionReceipt, ProviderRole } from '../contracts/approvals/contracts.ts';
import {
  UC05_APPROVAL_SCHEMA_VERSION_V02,
  computePolicyEvaluationReceiptDigest,
  computeProviderAdmissionReceiptDigest,
  validatePolicyEvaluationReceipt,
  validateProviderAdmissionReceipt,
} from '../contracts/approvals/contracts.ts';
import { computePlanBindingDigest, evaluatePlanApplicabilityV02, evaluatePlanBinding } from './plan-binding.ts';
import type { CompiledPolicyV01, PolicyFacts } from './policy-v01.ts';
import { compilePolicyV01, freezePolicyData, isBoundedPolicyData, isPolicyData, isValidPolicyFacts } from './policy-v01.ts';

export interface PolicyFactsV02 extends PolicyFacts {
  readonly runId: string;
  readonly taskStateVersion: number;
  readonly taskNode: string;
  readonly planApplicability: 'pre-plan-diagnostic' | 'approved-plan';
  readonly diagnosticPurpose: string | null;
  readonly taskCriteriaDigest: string | null;
  readonly checkSetDigest: string;
  readonly testPath: string | null;
  readonly checkId: string | null;
  readonly planBindingDigest: string | null;
  readonly planDecisionRef: string | null;
  readonly providerRequest: ProviderRequest | null;
}

export interface EvaluatePolicyOptionsV02 {
  readonly decisionAuthorityGeneration?: number;
  readonly planApplicability?: 'pre-plan-diagnostic' | 'approved-plan';
  readonly planBindingDigest?: string;
  readonly planDecisionRef?: string;
  readonly diagnosticPurpose?: string;
  readonly taskCriteriaDigest?: string;
  readonly freshnessContextDigest?: string;
  readonly receiptId?: string;
}

export type PolicyEvaluationResultV02 =
  | { readonly ok: true; readonly permission: PermissionClass; readonly reasonCode: string; readonly actionDigest: string; readonly receipt: PolicyEvaluationReceipt }
  | { readonly ok: false; readonly outcome: 'invalid' | 'prerequisite-denied' | 'unsupported'; readonly reasonCode: string };

export interface EvaluateProviderAdmissionOptionsV02 {
  readonly role?: ProviderRole;
  readonly planApplicability?: 'pre-plan-diagnostic' | 'approved-plan';
  readonly decisionAuthorityGeneration?: number;
  readonly planBindingDigest?: string;
  readonly planDecisionRef?: string;
  readonly diagnosticPurpose?: string;
  readonly taskCriteriaDigest?: string;
  readonly receiptId?: string;
}

export type ProviderAdmissionResultV02 =
  | { readonly ok: true; readonly receipt: ProviderAdmissionReceipt }
  | { readonly ok: false; readonly outcome: 'invalid' | 'prerequisite-denied' | 'unsupported' | 'forbidden'; readonly reasonCode: string };

export interface CompiledPolicy extends CompiledPolicyV01 {
  evaluatePolicyV02(actionInput: unknown, factsInput: unknown, options?: EvaluatePolicyOptionsV02): PolicyEvaluationResultV02;
  evaluateProviderAdmissionV02(requestInput: unknown, factsInput: unknown, options?: EvaluateProviderAdmissionOptionsV02): ProviderAdmissionResultV02;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/;
const SHA = /^sha256:[0-9a-f]{64}$/;
const POLICY_OPTIONS = ['decisionAuthorityGeneration', 'planApplicability', 'planBindingDigest', 'planDecisionRef', 'diagnosticPurpose', 'taskCriteriaDigest', 'freshnessContextDigest', 'receiptId'] as const;
const PROVIDER_OPTIONS = ['role', 'planApplicability', 'decisionAuthorityGeneration', 'planBindingDigest', 'planDecisionRef', 'diagnosticPurpose', 'taskCriteriaDigest', 'receiptId'] as const;

const isId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
const isSha = (value: unknown): value is string => typeof value === 'string' && SHA.test(value);

function optionRecord(input: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (input === undefined) return {};
  if (!isPolicyData(input) || typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) return null;
  return input as Record<string, unknown>;
}

function validatedV02Facts(input: unknown): input is PolicyFactsV02 {
  return isPolicyData(input) && isValidPolicyFacts(input) && Object.hasOwn(input, 'runId') && Object.hasOwn(input, 'providerRequest');
}

function currentIdentity(facts: PolicyFactsV02, profile: PolicyProfile): boolean {
  const identity = profile.policyIdentity;
  return facts.policyIdentity.policyId === identity.policyId && facts.policyIdentity.policyVersion === identity.policyVersion &&
    facts.policyIdentity.configId === identity.configId && facts.policyIdentity.configVersion === identity.configVersion;
}

function safetyFactsPass(facts: PolicyFactsV02): boolean {
  return Object.values(facts.safety).every(value => value === true);
}

function planDigestInput(facts: PolicyFactsV02): Record<string, unknown> | null {
  const binding = facts.plan?.binding;
  if (!binding) return null;
  return {
    taskId: binding.taskId,
    planVersion: binding.planVersion,
    strategyDigest: binding.strategyDigest,
    baselineRef: binding.baselineRef,
    evidenceRefs: binding.evidenceRefs,
    criteriaDigest: binding.criteriaDigest,
    checkSetDigest: binding.checkSetDigest,
    decisionRef: binding.decisionId,
  };
}

function applicabilityInput(facts: PolicyFactsV02): Record<string, unknown> {
  if (facts.planApplicability === 'pre-plan-diagnostic') {
    return {
      planApplicability: facts.planApplicability,
      taskNode: facts.taskNode,
      diagnosticPurpose: facts.diagnosticPurpose,
      taskCriteriaDigest: facts.taskCriteriaDigest,
      checkSetDigest: facts.checkSetDigest,
      testPath: facts.testPath,
      checkId: facts.checkId,
    };
  }
  return {
    planApplicability: facts.planApplicability,
    planBindingDigest: facts.planBindingDigest,
    planDecisionRef: facts.planDecisionRef,
    planBinding: planDigestInput(facts),
  };
}

function optionsMatchFacts(options: Record<string, unknown>, facts: PolicyFactsV02): boolean {
  return (options['planApplicability'] === undefined || options['planApplicability'] === facts.planApplicability) &&
    (options['planBindingDigest'] === undefined || options['planBindingDigest'] === facts.planBindingDigest) &&
    (options['planDecisionRef'] === undefined || options['planDecisionRef'] === facts.planDecisionRef) &&
    (options['diagnosticPurpose'] === undefined || options['diagnosticPurpose'] === facts.diagnosticPurpose) &&
    (options['taskCriteriaDigest'] === undefined || options['taskCriteriaDigest'] === facts.taskCriteriaDigest);
}

function approvedPlanIsCurrent(facts: PolicyFactsV02, profile: PolicyProfile): boolean {
  const plan = facts.plan;
  const binding = plan?.binding;
  const context = plan?.context;
  if (!plan || !binding || !context || binding.status !== 'approved' || binding.actionKind !== 'fix_plan' ||
    binding.taskId !== facts.taskId || binding.workspaceId !== facts.workspaceId || binding.repositoryRevisionDigest !== facts.repositoryRevisionDigest ||
    binding.policyId !== profile.policyIdentity.policyId || binding.policyVersion !== profile.policyIdentity.policyVersion ||
    binding.decisionId !== facts.planDecisionRef || binding.checkSetDigest !== facts.checkSetDigest ||
    (plan.materialChange && (plan.replanSlot === null || plan.replanSlot > 3)) || evaluatePlanBinding(binding, context).status !== 'valid') return false;
  const exact = planDigestInput(facts);
  if (!exact) return false;
  try { return computePlanBindingDigest(exact) === facts.planBindingDigest; }
  catch { return false; }
}

function repositoryBranchAllows(action: NormalizedAction, facts: PolicyFactsV02, profile: PolicyProfile, options: Record<string, unknown>): boolean {
  if (facts.providerRequest !== null || !optionsMatchFacts(options, facts)) return false;
  if (evaluatePlanApplicabilityV02(applicabilityInput(facts)).status !== 'valid') return false;
  if (facts.planApplicability === 'approved-plan') return approvedPlanIsCurrent(facts, profile);
  if (facts.plan !== null || !facts.safety.isolated) return false;
  if (action.kind === 'run_command') {
    const command = facts.command;
    if (!command || facts.patch !== null || !action.argv.includes(facts.testPath ?? '')) return false;
    const configured = profile.commandRules.some(rule => rule.executableRef === command.executableRef && rule.workingDirectoryRef === command.workingDirectoryRef &&
      rule.argvPrefix.length === action.argv.length && rule.argvPrefix.every((token, index) => token === action.argv[index]));
    return configured || command.constrainedCapability === 'constrained-tests';
  }
  if (action.kind === 'apply_patch') {
    return facts.patch !== null && facts.command === null && facts.patch.productionCode === false && facts.patch.fileCount === 1 &&
      facts.patch.dependencyChange === false && facts.patch.deletion === false && facts.patch.structuralChange === false &&
      facts.patch.sensitiveConfiguration === false && action.targetPaths.length === 1 && action.targetPaths[0] === facts.testPath &&
      action.targetPaths[0]?.startsWith('tests/') === true;
  }
  return false;
}

function policyFreshnessDigest(action: NormalizedAction, facts: PolicyFactsV02, profile: PolicyProfile, generation: number): string {
  return computeCanonicalSha256({ action, facts, policyIdentity: profile.policyIdentity, decisionAuthorityGeneration: generation });
}

function providerOptionsMatch(options: Record<string, unknown>, facts: PolicyFactsV02, request: ProviderRequest): boolean {
  return (options['role'] === undefined || options['role'] === request.role) && optionsMatchFacts(options, facts);
}

function providerRequestIsCurrent(request: ProviderRequest, facts: PolicyFactsV02, profile: PolicyProfile, options: Record<string, unknown>): boolean {
  if (request.dispatchState !== 'reserved' || request.taskId !== facts.taskId || request.runId !== facts.runId || request.role !== facts.role ||
    request.configId !== profile.policyIdentity.configId || ![request.providerRequestId, request.taskId, request.runId, request.providerId, request.modelId, request.configId, request.pricingPolicyId, request.reservationRef].every(isId) ||
    !isSha(request.contextDigest) || !currentIdentity(facts, profile) || !safetyFactsPass(facts) || !optionsMatchFacts(options, facts) ||
    !facts.providerRequest || !validateProviderRequest(facts.providerRequest).ok || facts.providerRequest.dispatchState !== request.dispatchState ||
    facts.providerRequest.reservationRef !== request.reservationRef ||
    computeRequestContentDigest(facts.providerRequest) !== computeRequestContentDigest(request)) return false;
  if (facts.planApplicability === 'pre-plan-diagnostic') return request.purpose === facts.diagnosticPurpose && evaluatePlanApplicabilityV02(applicabilityInput(facts)).status === 'valid';
  return approvedPlanIsCurrent(facts, profile) && evaluatePlanApplicabilityV02(applicabilityInput(facts)).status === 'valid';
}

function evaluatePolicy(compiled: CompiledPolicyV01, actionInput: unknown, factsInput: unknown, optionInput?: EvaluatePolicyOptionsV02): PolicyEvaluationResultV02 {
  const options = optionRecord(optionInput, POLICY_OPTIONS);
  if (!options || !Number.isSafeInteger(options['decisionAuthorityGeneration']) || Number(options['decisionAuthorityGeneration']) < 1 ||
    Object.hasOwn(options, 'freshnessContextDigest') && !isSha(options['freshnessContextDigest']) ||
    Object.hasOwn(options, 'receiptId') && !isId(options['receiptId'])) return { ok: false, outcome: 'invalid', reasonCode: 'invalid-evaluation-options' };
  if (!isBoundedPolicyData(actionInput, compiled.profile.maxActionBytes) || !isBoundedPolicyData(factsInput, compiled.profile.maxActionBytes) || !validatedV02Facts(factsInput)) {
    return { ok: false, outcome: 'invalid', reasonCode: 'invalid-current-policy-context' };
  }
  const action = validateNormalizedAction(actionInput);
  if (!action.ok) return { ok: false, outcome: 'invalid', reasonCode: 'invalid-action' };
  const facts = factsInput;
  if (!currentIdentity(facts, compiled.profile)) return { ok: false, outcome: 'prerequisite-denied', reasonCode: 'stale-policy-identity' };
  if (!repositoryBranchAllows(action.value, facts, compiled.profile, options)) return { ok: false, outcome: 'prerequisite-denied', reasonCode: 'invalid-plan-applicability-or-binding' };
  const classified = compiled.classify(action.value, facts);
  if (!classified.ok) return { ok: false, outcome: classified.outcome, reasonCode: classified.reasonCode };
  const generation = Number(options['decisionAuthorityGeneration']);
  const freshnessContextDigest = policyFreshnessDigest(action.value, facts, compiled.profile, generation);
  const receiptId = typeof options['receiptId'] === 'string' ? options['receiptId'] : `receipt-eval-${freshnessContextDigest.slice(7, 23)}-${generation}`;
  const unsignedReceipt = {
    schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, receiptId, actionDigest: computeActionDigest(action.value), freshnessContextDigest,
    policyId: compiled.profile.policyIdentity.policyId, policyVersion: compiled.profile.policyIdentity.policyVersion,
    configId: compiled.profile.policyIdentity.configId, configVersion: compiled.profile.policyIdentity.configVersion,
    decisionAuthorityGeneration: generation, result: classified.permission,
  };
  const receipt: PolicyEvaluationReceipt = freezePolicyData({ ...unsignedReceipt, receiptDigest: computePolicyEvaluationReceiptDigest(unsignedReceipt) });
  if (!validatePolicyEvaluationReceipt(receipt).ok) return { ok: false, outcome: 'invalid', reasonCode: 'invalid-policy-evaluation-receipt' };
  return { ok: true, permission: classified.permission, reasonCode: classified.reasonCode, actionDigest: unsignedReceipt.actionDigest, receipt };
}

function evaluateProviderAdmission(compiled: CompiledPolicyV01, requestInput: unknown, factsInput: unknown, optionInput?: EvaluateProviderAdmissionOptionsV02): ProviderAdmissionResultV02 {
  const options = optionRecord(optionInput, PROVIDER_OPTIONS);
  if (!options || !Number.isSafeInteger(options['decisionAuthorityGeneration']) || Number(options['decisionAuthorityGeneration']) < 1 ||
    Object.hasOwn(options, 'receiptId') && !isId(options['receiptId'])) return { ok: false, outcome: 'invalid', reasonCode: 'invalid-provider-options' };
  if (!isBoundedPolicyData(requestInput, 65_536) || !validatedV02Facts(factsInput)) return { ok: false, outcome: 'invalid', reasonCode: 'invalid-provider-context' };
  const parsed = validateProviderRequest(requestInput);
  if (!parsed.ok) return { ok: false, outcome: 'invalid', reasonCode: 'invalid-provider-request' };
  const request = parsed.value;
  if (request.dispatchState !== 'reserved' || !providerRequestIsCurrent(request, factsInput, compiled.profile, options) || !providerOptionsMatch(options, factsInput, request)) {
    return { ok: false, outcome: 'prerequisite-denied', reasonCode: 'provider-request-or-authority-mismatch' };
  }
  const generation = Number(options['decisionAuthorityGeneration']);
  const planApplicability = factsInput.planApplicability;
  const requestDigest = computeRequestContentDigest(request);
  const receiptId = typeof options['receiptId'] === 'string' ? options['receiptId'] : `receipt-prov-${requestDigest.slice(7, 19)}-${generation}`;
  const commonReceipt = {
    schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
    receiptId,
    providerRequestId: request.providerRequestId,
    role: request.role,
    requestContentDigest: requestDigest,
    providerId: request.providerId,
    modelId: request.modelId,
    policyId: compiled.profile.policyIdentity.policyId,
    policyVersion: compiled.profile.policyIdentity.policyVersion,
    configId: compiled.profile.policyIdentity.configId,
    configVersion: compiled.profile.policyIdentity.configVersion,
    decisionAuthorityGeneration: generation,
  };
  const unsignedReceipt = (() => {
    if (planApplicability === 'pre-plan-diagnostic') {
      const { diagnosticPurpose, taskCriteriaDigest } = factsInput;
      if (typeof diagnosticPurpose !== 'string' || typeof taskCriteriaDigest !== 'string') return null;
      return { ...commonReceipt, planApplicability, diagnosticPurpose, taskCriteriaDigest };
    }
    const { planBindingDigest, planDecisionRef } = factsInput;
    if (typeof planBindingDigest !== 'string' || typeof planDecisionRef !== 'string') return null;
    return { ...commonReceipt, planApplicability, planBindingDigest, planDecisionRef };
  })();
  if (unsignedReceipt === null) return { ok: false, outcome: 'invalid', reasonCode: 'invalid-provider-admission-receipt' };
  const receipt: ProviderAdmissionReceipt = freezePolicyData({ ...unsignedReceipt, receiptDigest: computeProviderAdmissionReceiptDigest(unsignedReceipt) });
  if (!validateProviderAdmissionReceipt(receipt).ok) return { ok: false, outcome: 'invalid', reasonCode: 'invalid-provider-admission-receipt' };
  return { ok: true, receipt };
}

export function computePolicyFreshnessContextDigest(action: NormalizedAction, facts: PolicyFactsV02, policyIdentity: PolicyIdentity, generation: number): string {
  return computeCanonicalSha256({ action, facts, policyIdentity, decisionAuthorityGeneration: generation });
}

export function compilePolicy(profileInput: unknown): { readonly ok: true; readonly value: CompiledPolicy } | { readonly ok: false; readonly reasonCode: 'invalid-profile' } {
  const compiled = compilePolicyV01(profileInput);
  if (!compiled.ok) return compiled;
  const core = compiled.value;
  const value: CompiledPolicy = {
    profile: core.profile,
    classify: core.classify,
    evaluatePolicyV02: (action: unknown, facts: unknown, options?: EvaluatePolicyOptionsV02) => evaluatePolicy(core, action, facts, options),
    evaluateProviderAdmissionV02: (request: unknown, facts: unknown, options?: EvaluateProviderAdmissionOptionsV02) => evaluateProviderAdmission(core, request, facts, options),
  };
  return { ok: true, value: Object.freeze(value) };
}

export function evaluatePolicyV02(profile: unknown, actionInput: unknown, factsInput: unknown, options?: EvaluatePolicyOptionsV02): PolicyEvaluationResultV02 {
  const compiled = compilePolicy(profile);
  if (!compiled.ok) return { ok: false, outcome: 'invalid', reasonCode: compiled.reasonCode };
  return compiled.value.evaluatePolicyV02(actionInput, factsInput, options);
}

export function evaluateProviderAdmissionV02(profile: unknown, requestInput: unknown, factsInput: unknown, options?: EvaluateProviderAdmissionOptionsV02): ProviderAdmissionResultV02 {
  const compiled = compilePolicy(profile);
  if (!compiled.ok) return { ok: false, outcome: 'invalid', reasonCode: compiled.reasonCode };
  return compiled.value.evaluateProviderAdmissionV02(requestInput, factsInput, options);
}
