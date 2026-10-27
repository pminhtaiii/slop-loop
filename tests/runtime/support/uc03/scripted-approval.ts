import {
  type ApprovalPort,
  type NormalizedAction,
  type PermissionClass,
  type ApprovalBinding,
  type ApprovalBindingContext,
  type PortProvenance,
  type PolicyEvaluationReceiptV02,
  type ActionDecisionReceiptV02,
  type ProviderAdmissionReceiptV02,
  type PolicyAuthorityRefV02,
  type ContextualApprovalVerifierV02,
  type VerificationApprovalContextV02,
  type VerificationApprovalResolutionV02,
  type RepositoryAdmissionContextV02,
  type ProviderRequest,
  validateNormalizedAction,
  computeCanonicalSha256,
  computeActionDigest,
  computeRequestContentDigest,
  validateProviderRequest,
  parseApprovalBinding,
  validateApprovalBinding,
  isVerificationApprovalContextV02,
} from '../../../../src/contracts/foundation/uc03.ts';

export interface ScriptedApprovalPortOptions {
  readonly classifications?: Readonly<Record<string, PermissionClass>> | undefined;
  readonly decisions?: readonly ApprovalBinding[] | undefined;
  readonly currentContext?: ApprovalBindingContext | undefined;
  readonly v02AuthorityRef?: PolicyAuthorityRefV02 | undefined;
  readonly v02Evaluations?: readonly PolicyEvaluationReceiptV02[] | undefined;
  readonly v02Decisions?: readonly ActionDecisionReceiptV02[] | undefined;
  readonly v02ProviderAdmissionReceipts?: readonly ProviderAdmissionReceiptV02[] | undefined;
}

export class ScriptedApprovalPort implements ApprovalPort, ContextualApprovalVerifierV02 {
  readonly provenance: PortProvenance = 'mock';

  private readonly attemptedActions: NormalizedAction[] = [];
  private readonly recordedBindings: ApprovalBinding[] = [];
  private readonly scriptedDecisions = new Map<string, ApprovalBinding>();
  private readonly requestBindings = new Map<string, ApprovalBinding>();
  private readonly contextualDecisionHistory = new Map<string, Map<number, ApprovalBinding>>();
  private readonly decisionIssuerKeys = new Map<string, string>();
  private readonly classifications = new Map<string, PermissionClass>();
  private readonly forbiddenDigests = new Set<string>();
  private readonly rejectedDecisions = new Set<string>();
  private readonly defaultContext?: ApprovalBindingContext | undefined;

  // v0.2 additions
  private v02AuthorityRef?: PolicyAuthorityRefV02 | undefined;
  private readonly v02Evaluations = new Map<string, PolicyEvaluationReceiptV02>();
  private readonly v02Decisions = new Map<string, ActionDecisionReceiptV02>();
  private readonly v02ProviderAdmissionReceipts: ProviderAdmissionReceiptV02[] = [];

  constructor(options?: ScriptedApprovalPortOptions) {
    this.v02AuthorityRef = options?.v02AuthorityRef;
    if (options?.classifications) {
      for (const [key, perm] of Object.entries(options.classifications)) {
        this.classifications.set(key, perm);
      }
    }

    if (options?.decisions) {
      for (const d of options.decisions) {
        const parsed = parseApprovalBinding(d);
        if (!parsed.ok) {
          throw new Error(`Invalid initial decision: ${parsed.errors.map((e) => e.message).join(', ')}`);
        }
        const prior = this.scriptedDecisions.get(parsed.value.decisionId);
        if (prior) throw new Error('Duplicate decision identity');
        this.scriptedDecisions.set(parsed.value.decisionId, structuredClone(parsed.value));
        this.recordContextualStatus(parsed.value, this.v02AuthorityRef?.decisionAuthorityGeneration ?? 1);
        if (parsed.value.status === 'rejected') {
          this.rejectedDecisions.add(parsed.value.decisionId);
        }
      }
    }

    if (options?.currentContext) {
      this.defaultContext = structuredClone(options.currentContext);
    }

    for (const receipt of options?.v02Evaluations ?? []) this.scriptEvaluationV02(receipt);
    for (const receipt of options?.v02Decisions ?? []) this.scriptDecisionV02(receipt);
    for (const receipt of options?.v02ProviderAdmissionReceipts ?? []) this.scriptProviderAdmissionReceiptV02(receipt);
  }

  setV02AuthorityRef(auth: PolicyAuthorityRefV02 | undefined): void {
    this.v02AuthorityRef = auth;
  }

  scriptEvaluationV02(receipt: PolicyEvaluationReceiptV02): void {
    if (!isValidEvaluationReceipt(receipt)) throw new Error('Invalid scripted v0.2 policy evaluation receipt');
    const prior = this.v02Evaluations.get(receipt.receiptId);
    if (prior && computeCanonicalSha256(prior) !== computeCanonicalSha256(receipt)) {
      throw new Error('Conflicting scripted v0.2 policy evaluation identity');
    }
    this.v02Evaluations.set(receipt.receiptId, receipt);
  }

  scriptDecisionV02(receipt: ActionDecisionReceiptV02): void {
    if (!isValidDecisionReceipt(receipt)) throw new Error('Invalid scripted v0.2 action decision receipt');
    const prior = this.v02Decisions.get(receipt.evaluationReceiptRef);
    if (prior && computeCanonicalSha256(prior) !== computeCanonicalSha256(receipt)) {
      throw new Error('Conflicting scripted v0.2 decision for evaluation');
    }
    this.v02Decisions.set(receipt.evaluationReceiptRef, receipt);
  }

  scriptProviderAdmissionReceiptV02(receipt: ProviderAdmissionReceiptV02): void {
    const prior = this.v02ProviderAdmissionReceipts.find((candidate) => candidate.receiptId === receipt.receiptId);
    if (prior && computeCanonicalSha256(prior) !== computeCanonicalSha256(receipt)) {
      throw new Error('Conflicting scripted v0.2 provider admission receipt identity');
    }
    if (!prior) this.v02ProviderAdmissionReceipts.push(receipt);
  }

  getAttemptedActions(): readonly NormalizedAction[] {
    return this.attemptedActions.map((a) => structuredClone(a));
  }

  getRecordedBindings(): readonly ApprovalBinding[] {
    return this.recordedBindings.map((b) => structuredClone(b));
  }

  scriptClassification(actionIdOrKind: string, permission: PermissionClass): void {
    this.classifications.set(actionIdOrKind, permission);
  }

  scriptDecision(binding: ApprovalBinding, decisionAuthorityGeneration = this.v02AuthorityRef?.decisionAuthorityGeneration ?? 1): void {
    const parsed = parseApprovalBinding(binding);
    if (!parsed.ok) {
      throw new Error(`Invalid scripted decision: ${parsed.errors.map((e) => e.message).join(', ')}`);
    }
    const prior = this.scriptedDecisions.get(parsed.value.decisionId);
    if (prior && !this.sameIdentity(prior, parsed.value)) throw new Error('Conflicting decision identity');
    this.recordContextualStatus(parsed.value, decisionAuthorityGeneration);
    this.scriptedDecisions.set(parsed.value.decisionId, structuredClone(parsed.value));
    if (parsed.value.status === 'approved') {
      this.rejectedDecisions.delete(parsed.value.decisionId);
    } else if (parsed.value.status === 'rejected') {
      this.rejectedDecisions.add(parsed.value.decisionId);
    }
  }

  async classify(action: NormalizedAction): Promise<PermissionClass> {
    const val = validateNormalizedAction(action);
    if (!val.ok) {
      throw new Error(`Invalid action for classification: ${val.errors.map((e) => e.message).join(', ')}`);
    }
    const validated = val.value;
    this.attemptedActions.push(structuredClone(validated));

    const cmdKey =
      validated.kind === 'run_command'
        ? `${validated.executable} ${validated.argv.join(' ')}`
        : validated.actionId;

    const byCmd = this.classifications.get(cmdKey);
    if (byCmd !== undefined) {
      if (byCmd === 'FORBIDDEN') this.forbiddenDigests.add(computeCanonicalSha256(validated));
      return byCmd;
    }
    const byAction = this.classifications.get(validated.actionId);
    if (byAction !== undefined) {
      if (byAction === 'FORBIDDEN') this.forbiddenDigests.add(computeCanonicalSha256(validated));
      return byAction;
    }
    const byKind = this.classifications.get(validated.kind);
    if (byKind !== undefined) {
      if (byKind === 'FORBIDDEN') this.forbiddenDigests.add(computeCanonicalSha256(validated));
      return byKind;
    }

    // Explicit non-autoapprove: unscripted actions require approval
    return 'APPROVAL_REQUIRED';
  }

  async requestDecision(binding: ApprovalBinding): Promise<ApprovalBinding> {
    const parsed = parseApprovalBinding(binding);
    if (!parsed.ok) {
      throw new Error(`Invalid approval binding: ${parsed.errors.map((e) => e.message).join(', ')}`);
    }

    const recorded = structuredClone(parsed.value);
    const priorRequest = this.requestBindings.get(recorded.decisionId);
    if (priorRequest && !this.sameIdentity(priorRequest, recorded)) throw new Error('Conflicting request for decision identity');
    if (!priorRequest) {
      this.requestBindings.set(recorded.decisionId, recorded);
      this.recordedBindings.push(recorded);
    }

    let scripted = this.scriptedDecisions.get(recorded.decisionId);
    if (!scripted && recorded.decisionId.startsWith('dec-verify-')) {
      this.scriptDecision({ ...recorded, status: 'pending' });
      scripted = this.scriptedDecisions.get(recorded.decisionId);
    }
    if (!scripted || !this.sameIdentity(scripted, recorded)) throw new Error('Unscripted or conflicting decision identity');
    if (this.forbiddenDigests.has(scripted.normalizedActionDigest)) throw new Error('Forbidden action');
    const result = structuredClone(scripted);

    if (result.status === 'rejected') {
      this.rejectedDecisions.add(result.decisionId);
    }
    return structuredClone(result);
  }

  async validateBinding(binding: ApprovalBinding, context?: ApprovalBindingContext): Promise<boolean> {
    const scripted = this.scriptedDecisions.get(binding.decisionId);
    if (!scripted || computeCanonicalSha256(scripted) !== computeCanonicalSha256(binding) || this.forbiddenDigests.has(binding.normalizedActionDigest)) return false;
    // Rejection cannot become approval without scripted human/test input
    if (this.rejectedDecisions.has(binding.decisionId) && binding.status === 'approved') {
      const scriptedRec = this.scriptedDecisions.get(binding.decisionId);
      if (!scriptedRec || scriptedRec.status !== 'approved') {
        return false;
      }
    }

    const ctx = context ?? this.defaultContext;
    const res = validateApprovalBinding(binding, ctx);
    if (!res.ok) {
      return false;
    }
    return res.value.status === 'approved';
  }

  private sameIdentity(a: ApprovalBinding, b: ApprovalBinding): boolean {
    const ai = Object.fromEntries(Object.entries(a).filter(([key]) => key !== 'status' && key !== 'reason'));
    const bi = Object.fromEntries(Object.entries(b).filter(([key]) => key !== 'status' && key !== 'reason'));
    return computeCanonicalSha256(ai) === computeCanonicalSha256(bi);
  }

  private recordContextualStatus(binding: ApprovalBinding, generation: number): void {
    if (!this.v02AuthorityRef || !Number.isSafeInteger(generation) || generation < 1) return;
    const history = this.contextualDecisionHistory.get(binding.decisionId) ?? new Map<number, ApprovalBinding>();
    const terminalRejection = [...history.values()].find((record) => record.status === 'rejected');
    // Rejected D1 stays terminal in contextual history even when legacy scripting updates its mutable record.
    const contextualBinding = terminalRejection && binding.status !== 'rejected' ? terminalRejection : binding;
    const prior = history.get(generation);
    if (prior && (!this.sameIdentity(prior, contextualBinding) || prior.status !== contextualBinding.status)) throw new Error('Conflicting contextual decision generation');
    history.set(generation, structuredClone(contextualBinding));
    this.contextualDecisionHistory.set(binding.decisionId, history);
    this.decisionIssuerKeys.set(binding.decisionId, this.v02AuthorityRef.issuerKeyRef);
  }

  async resolvePlanDecisionInContext(
    decisionId: string,
    context: VerificationApprovalContextV02,
  ): Promise<VerificationApprovalResolutionV02> {
    if (!isVerificationApprovalContextV02(context)) return { outcome: 'denied', reasonCode: 'INVALID_CONTEXT' };
    const binding = this.contextualDecisionHistory.get(decisionId)?.get(context.expectedDecisionAuthorityGeneration);
    if (!binding) return { outcome: 'stale', reasonCode: 'DECISION_GENERATION_UNAVAILABLE' };
    if (this.decisionIssuerKeys.get(decisionId) !== context.expectedIssuerKeyRef) return { outcome: 'denied', reasonCode: 'WRONG_ISSUER' };
    if (!this.sameIdentity(this.scriptedDecisions.get(decisionId) ?? binding, binding)) return { outcome: 'denied', reasonCode: 'DECISION_IDENTITY_CONFLICT' };
    const validation = validateApprovalBinding(binding, context.approvalContext);
    if (!validation.ok || !this.bindingMatchesContext(binding, context)) return { outcome: 'denied', reasonCode: 'APPROVAL_CONTEXT_MISMATCH' };
    return {
      outcome: 'resolved', decisionId, binding: structuredClone(binding),
      issuerKeyRef: context.expectedIssuerKeyRef,
      decisionAuthorityGeneration: context.expectedDecisionAuthorityGeneration,
      contextDigest: computeCanonicalSha256(context),
    };
  }

  private bindingMatchesContext(binding: ApprovalBinding, context: VerificationApprovalContextV02): boolean {
    const freshness = context.approvalContext;
    return binding.decisionId === this.scriptedDecisions.get(binding.decisionId)?.decisionId &&
      binding.actionKind === 'fix_plan' && binding.taskId === freshness.currentTaskId &&
      binding.workspaceId === freshness.currentWorkspaceId &&
      binding.repositoryRevisionDigest === freshness.currentRepositoryRevisionDigest &&
      binding.policyId === freshness.currentPolicyId && binding.policyVersion === freshness.currentPolicyVersion &&
      binding.normalizedActionDigest === freshness.currentNormalizedActionDigest &&
      binding.planVersion === freshness.currentPlanVersion && binding.strategyDigest === freshness.currentStrategyDigest &&
      binding.baselineRef === freshness.currentBaselineRef &&
      computeCanonicalSha256(binding.evidenceRefs ?? []) === computeCanonicalSha256(freshness.currentEvidenceRefs) &&
      binding.criteriaDigest === freshness.currentCriteriaDigest && binding.checkSetDigest === freshness.currentCheckSetDigest;
  }

  async resolve(decisionId: string): Promise<ApprovalBinding> {
    const decision = this.scriptedDecisions.get(decisionId);
    if (!decision) {
      throw new Error(`No decision found for decisionId: ${decisionId}`);
    }
    const parsed = parseApprovalBinding(decision);
    if (!parsed.ok) {
      throw new Error(`Invalid resolved binding: ${parsed.errors.map((e) => e.message).join(', ')}`);
    }
    return structuredClone(parsed.value);
  }

  /* ============================================================================
   * v0.2 Policy and Decision Operations
   * ============================================================================ */

  async evaluatePolicyV02(
    action: NormalizedAction,
    context?: RepositoryAdmissionContextV02
  ): Promise<PolicyEvaluationReceiptV02> {
    const val = validateNormalizedAction(action);
    if (!val.ok) {
      throw new Error(`Invalid action for classification: ${val.errors.map((e) => e.message).join(', ')}`);
    }
    const validated = val.value;
    const auth = this.v02AuthorityRef;
    if (!auth || !isValidAuthorityRef(auth)) throw new Error('MISSING_CURRENT_AUTHORITY: v0.2 evaluation requires configured authority');
    if (!context || context.schemaVersion !== '0.2.0' || context.subjectKind !== 'repository-action') {
      throw new Error('MISSING_CURRENT_CONTEXT: v0.2 evaluation requires current repository context');
    }
    const actionDigest = computeActionDigest(validated);
    if (context.actionDigest !== actionDigest || !sameAuthority(context.policyAuthorityRef, auth)) {
      throw new Error('STALE_CURRENT_CONTEXT: Action or authority does not match the requested evaluation');
    }
    const freshnessContextDigest = computeCanonicalSha256({
      actionDigest,
      canonicalRevision: context.canonicalRevision,
      policyAuthorityRef: auth,
    });
    const receipt = [...this.v02Evaluations.values()].find((candidate) =>
      candidate.actionDigest === actionDigest &&
      candidate.freshnessContextDigest === freshnessContextDigest &&
      authorityMatchesReceipt(auth, candidate),
    );
    if (!receipt) throw new Error('UNSCRIPTED_CURRENT_EVALUATION: No current receipt matches action and authority');
    return receipt;
  }

  async requestDecisionV02(
    evaluation: PolicyEvaluationReceiptV02
  ): Promise<ActionDecisionReceiptV02> {
    const auth = this.v02AuthorityRef;
    const scriptedEvaluation = this.v02Evaluations.get(evaluation.receiptId);
    if (!auth || !isValidAuthorityRef(auth) || !isValidEvaluationReceipt(evaluation) ||
      !scriptedEvaluation || computeCanonicalSha256(scriptedEvaluation) !== computeCanonicalSha256(evaluation) ||
      !authorityMatchesReceipt(auth, evaluation)) {
      throw new Error('INVALID_CURRENT_EVALUATION: Decision requires a scripted current evaluation');
    }
    if (evaluation.result !== 'APPROVAL_REQUIRED') {
      throw new Error(evaluation.result === 'FORBIDDEN' ? 'FORBIDDEN_ACTION: Approval cannot override policy' : 'APPROVAL_NOT_REQUIRED');
    }
    const decision = this.v02Decisions.get(evaluation.receiptId);
    if (!decision || !isValidDecisionReceipt(decision) ||
      decision.actionDigest !== evaluation.actionDigest ||
      decision.evaluationReceiptRef !== evaluation.receiptId ||
      decision.decisionAuthorityGeneration !== evaluation.decisionAuthorityGeneration ||
      decision.status !== 'approved') {
      throw new Error('UNSCRIPTED_CURRENT_DECISION: No current human decision matches evaluation');
    }
    return decision;
  }

  async validateBindingV02(
    receipt: PolicyEvaluationReceiptV02 | ActionDecisionReceiptV02,
    authorityRef?: PolicyAuthorityRefV02
  ): Promise<boolean> {
    const auth = this.v02AuthorityRef;
    if (!auth || !isValidAuthorityRef(auth) ||
      (authorityRef !== undefined && (!isValidAuthorityRef(authorityRef) || !sameAuthority(authorityRef, auth)))) return false;
    if ('result' in receipt) {
      const scripted = this.v02Evaluations.get(receipt.receiptId);
      return isValidEvaluationReceipt(receipt) && !!scripted &&
        computeCanonicalSha256(scripted) === computeCanonicalSha256(receipt) && authorityMatchesReceipt(auth, receipt);
    }
    const scripted = this.v02Decisions.get(receipt.evaluationReceiptRef);
    const evaluation = this.v02Evaluations.get(receipt.evaluationReceiptRef);
    return isValidDecisionReceipt(receipt) && !!scripted && !!evaluation &&
      computeCanonicalSha256(scripted) === computeCanonicalSha256(receipt) &&
      evaluation.result === 'APPROVAL_REQUIRED' && evaluation.actionDigest === receipt.actionDigest &&
      evaluation.decisionAuthorityGeneration === receipt.decisionAuthorityGeneration &&
      authorityMatchesReceipt(auth, evaluation);
  }

  async issueProviderAdmissionReceiptV02(
    request: ProviderRequest,
    authorityRef?: PolicyAuthorityRefV02
  ): Promise<ProviderAdmissionReceiptV02> {
    const configuredAuthority = this.v02AuthorityRef;
    if (!configuredAuthority || !isValidAuthorityRef(configuredAuthority)) {
      throw new Error('MISSING_CURRENT_AUTHORITY: Provider receipt requires configured current authority');
    }
    if (authorityRef !== undefined && (!isValidAuthorityRef(authorityRef) || !sameAuthority(authorityRef, configuredAuthority))) {
      throw new Error('CURRENT_AUTHORITY_MISMATCH: Supplied authority differs from configured current authority');
    }
    const requestValidation = validateProviderRequest(request);
    if (!requestValidation.ok) throw new Error('INVALID_PROVIDER_REQUEST: Provider receipt requires a complete valid request');
    const validRequest = requestValidation.value;
    if (validRequest.configId !== configuredAuthority.configId) {
      throw new Error('PROVIDER_CONFIGURATION_MISMATCH: Request configuration differs from current authority');
    }
    const requestContentDigest = computeRequestContentDigest(validRequest);
    const receiptIndex = this.v02ProviderAdmissionReceipts.findIndex((receipt) =>
      isMatchingProviderAdmissionReceipt(receipt, validRequest, configuredAuthority, requestContentDigest),
    );
    if (receiptIndex < 0) throw new Error('UNSCRIPTED_PROVIDER_ADMISSION_RECEIPT: No matching provider receipt was scripted');
    const receipt = this.v02ProviderAdmissionReceipts[receiptIndex];
    if (!receipt) throw new Error('UNSCRIPTED_PROVIDER_ADMISSION_RECEIPT: No matching provider receipt was scripted');
    this.v02ProviderAdmissionReceipts.splice(receiptIndex, 1);
    return receipt;
  }
}

function isValidAuthorityRef(value: PolicyAuthorityRefV02): boolean {
  return [value.policyId, value.policyVersion, value.configId, value.configVersion, value.issuerKeyRef]
    .every((part) => typeof part === 'string' && part.trim().length > 0) &&
    Number.isSafeInteger(value.decisionAuthorityGeneration) && value.decisionAuthorityGeneration > 0;
}

function isMatchingProviderAdmissionReceipt(
  receipt: ProviderAdmissionReceiptV02,
  request: ProviderRequest,
  authority: PolicyAuthorityRefV02,
  requestContentDigest: string,
): boolean {
  try {
    return [receipt.receiptId, receipt.receiptDigest, receipt.providerRequestId, receipt.requestContentDigest,
      receipt.providerId, receipt.modelId, receipt.configId, receipt.configVersion]
      .every((value) => typeof value === 'string' && value.trim().length > 0) &&
      (receipt.role === 'coder' || receipt.role === 'reviewer') &&
      Number.isSafeInteger(receipt.decisionAuthorityGeneration) && receipt.decisionAuthorityGeneration > 0 &&
      receipt.receiptDigest === computeCanonicalSha256({ ...receipt, receiptDigest: undefined }) &&
      receipt.providerRequestId === request.providerRequestId &&
      receipt.role === request.role &&
      receipt.requestContentDigest === requestContentDigest &&
      receipt.providerId === request.providerId &&
      receipt.modelId === request.modelId &&
      receipt.configId === request.configId && receipt.configId === authority.configId &&
      receipt.configVersion === authority.configVersion &&
      receipt.decisionAuthorityGeneration === authority.decisionAuthorityGeneration;
  } catch {
    return false;
  }
}

function sameAuthority(a: PolicyAuthorityRefV02, b: PolicyAuthorityRefV02): boolean {
  return a.policyId === b.policyId && a.policyVersion === b.policyVersion &&
    a.configId === b.configId && a.configVersion === b.configVersion &&
    a.issuerKeyRef === b.issuerKeyRef &&
    a.decisionAuthorityGeneration === b.decisionAuthorityGeneration;
}

function authorityMatchesReceipt(
  authority: PolicyAuthorityRefV02,
  receipt: PolicyEvaluationReceiptV02,
): boolean {
  return receipt.policyId === authority.policyId && receipt.policyVersion === authority.policyVersion &&
    receipt.configId === authority.configId && receipt.configVersion === authority.configVersion &&
    receipt.decisionAuthorityGeneration === authority.decisionAuthorityGeneration;
}

function isValidEvaluationReceipt(receipt: PolicyEvaluationReceiptV02): boolean {
  if (![receipt.receiptId, receipt.actionDigest, receipt.freshnessContextDigest, receipt.policyId,
    receipt.policyVersion, receipt.configId, receipt.configVersion].every((value) => typeof value === 'string' && value.trim().length > 0) ||
    !Number.isSafeInteger(receipt.decisionAuthorityGeneration) || receipt.decisionAuthorityGeneration <= 0 ||
    !['ALLOWED', 'APPROVAL_REQUIRED', 'FORBIDDEN'].includes(receipt.result)) return false;
  return receipt.receiptDigest === computeCanonicalSha256({ ...receipt, receiptDigest: undefined });
}

function isValidDecisionReceipt(receipt: ActionDecisionReceiptV02): boolean {
  if (![receipt.decisionId, receipt.actionDigest, receipt.evaluationReceiptRef].every((value) => typeof value === 'string' && value.trim().length > 0) ||
    !Number.isSafeInteger(receipt.decisionAuthorityGeneration) || receipt.decisionAuthorityGeneration <= 0 ||
    receipt.status !== 'approved') return false;
  return receipt.decisionDigest === computeCanonicalSha256({ ...receipt, decisionDigest: undefined });
}

export class ScriptedApprovalPortV02 {
  readonly provenance: PortProvenance = 'mock';
  private readonly underlying: ScriptedApprovalPort;

  constructor(underlying: ScriptedApprovalPort) {
    this.underlying = underlying;
  }

  evaluatePolicyV02(
    action: NormalizedAction,
    context?: RepositoryAdmissionContextV02
  ): Promise<PolicyEvaluationReceiptV02> {
    return this.underlying.evaluatePolicyV02(action, context);
  }

  requestDecisionV02(
    evaluation: PolicyEvaluationReceiptV02
  ): Promise<ActionDecisionReceiptV02> {
    return this.underlying.requestDecisionV02(evaluation);
  }

  validateBindingV02(
    receipt: PolicyEvaluationReceiptV02 | ActionDecisionReceiptV02,
    authorityRef?: PolicyAuthorityRefV02
  ): Promise<boolean> {
    return this.underlying.validateBindingV02(receipt, authorityRef);
  }

  issueProviderAdmissionReceiptV02(
    request: ProviderRequest,
    authorityRef?: PolicyAuthorityRefV02
  ): Promise<ProviderAdmissionReceiptV02> {
    return this.underlying.issueProviderAdmissionReceiptV02(request, authorityRef);
  }
}
