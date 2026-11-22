/**
 * Durable verification-approval authority for the real-tier owner (T061, contract §"verification authority").
 *
 * `resolvePlanDecisionInContext` re-issues one recorded human plan decision as a resolution only when
 * the caller's explicit authority context, the durable approval-store record and the owner's own
 * reconstructed context agree in every field. `recordVerificationApproval` is the owner's one write
 * for the post-patch D1: it revalidates the exact request against the durable head, resolves the
 * decision in context, and then holds it pending, records the rejection hold, or applies the single
 * `plan.decisionRef`/`activeDecisionId` rebind.
 * `planDecisionIsApproved` and `trustedPlanApproval` expose the same durable facts to the pre-patch
 * admissions. Shared reads/records live in `state-port-v02-verification-records.ts`.
 *
 * Everything comes from durable owner state that already exists — the approval store's recorded
 * requests/resolutions validated as the UC-05 reader validates them, the control head, the journal's
 * settled patch ancestry, and this owner's own record of which authority/generation consumed each
 * decision. No authority is minted here, and an advanced generation never accepts an old decision.
 */
import { computeCanonicalSha256, isRecordVerificationApprovalRequestV02, isVerificationApprovalContextV02, validateApprovalBinding, validateTaskState } from '../../contracts/foundation/uc03.ts';
import type {
  ApprovalBinding,
  ApprovalBindingContext,
  PolicyAuthorityRefV02,
  RecordVerificationApprovalRequestV02,
  RecordVerificationApprovalResultV02,
  TaskState,
  VerificationApprovalContextV02,
  VerificationApprovalResolutionV02,
} from '../../contracts/foundation/uc03.ts';
import type { TrustedOperatorIdentity } from '../../contracts/approvals/contracts.ts';
import type { StatePortStore } from './state-port-v02-storage.ts';
import type { ControlRecordV02 } from './state-port-v02-types.ts';
import { DEFAULT_CONTROL } from './state-port-v02-types.ts';
import {
  approvalContextOf,
  authorityOf,
  bindIssuedDecision,
  bindingIdentityDigest,
  bindingMatchesContext,
  holdEventDigest,
  issuedBindingMatches,
  ownerContext,
  planMaterialDigest,
  policyIdentityOf,
  readDecisionBindings,
  readIssuedDecisionBinding,
  recordedResolution,
  rejectionHoldRef,
  requestMatchesAuthority,
  requestRecord,
} from './state-port-v02-verification-records.ts';

export interface DurableVerificationAuthorityOptions {
  readonly store: StatePortStore;
  /** The approval store directory the real UC-05 service writes; absent, both methods fail closed. */
  readonly approvalStorageDir: string | undefined;
  /** The trusted operator whose channel recorded resolutions; absent, no resolution is ever accepted. */
  readonly operator: TrustedOperatorIdentity | undefined;
  /** The fallback control head when no head has been persisted yet (matching readVerificationAuthoritySnapshot). */
  readonly controlSeed?: ControlRecordV02 | undefined;
}

export class DurableVerificationAuthority {
  private readonly options: DurableVerificationAuthorityOptions;

  constructor(options: DurableVerificationAuthorityOptions) {
    this.options = options;
  }

  private controlFallback(): ControlRecordV02 {
    return this.options.controlSeed ?? DEFAULT_CONTROL;
  }

  readIssuedDecisionBinding(taskId: string, decisionId: string): ReturnType<typeof readIssuedDecisionBinding> {
    return readIssuedDecisionBinding(this.options.store, taskId, decisionId);
  }

  private resolutionOf(storageDir: string, taskId: string, decisionId: string) {
    return recordedResolution(storageDir, taskId, decisionId, this.options.operator);
  }

  async resolvePlanDecisionInContext(decisionId: string, context: VerificationApprovalContextV02): Promise<VerificationApprovalResolutionV02> {
    let snapshot: VerificationApprovalContextV02;
    try {
      snapshot = structuredClone(context);
    } catch {
      return { outcome: 'denied', reasonCode: 'INVALID_CONTEXT' };
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(decisionId) || !isVerificationApprovalContextV02(snapshot)) return { outcome: 'denied', reasonCode: 'INVALID_CONTEXT' };
    const storageDir = this.options.approvalStorageDir;
    if (!storageDir) return { outcome: 'unavailable', reasonCode: 'MISSING_APPROVAL_STORE' };
    // A read: the settled-patch lookup takes its own task lock, so this path must not hold one.
    return this.resolveDecision(storageDir, decisionId, snapshot, false);
  }

  /**
   * The one decision-in-context path: durable request, owner-reconstructed context and the validated
   * resolution must all agree. `recorded` is set only when the owner itself is consuming the
   * decision, which is the one place a decision's issuing authority is bound.
   */
  private async resolveDecision(storageDir: string, decisionId: string, snapshot: VerificationApprovalContextV02, recorded: boolean): Promise<VerificationApprovalResolutionV02> {
    const record = requestRecord(storageDir, decisionId);
    if (!record || record.decisionId !== decisionId) return { outcome: 'stale', reasonCode: 'UNKNOWN_DECISION' };
    if (record.taskId !== snapshot.approvalContext.currentTaskId) return { outcome: 'stale', reasonCode: 'CROSS_TASK_DECISION' };
    const owner = await ownerContext(this.options.store, record.taskId, decisionId, snapshot.purpose, this.controlFallback());
    if (!owner) return { outcome: 'stale', reasonCode: 'OWNER_CONTEXT_CHANGED' };
    // Both the authority and the full owner-derived context must equal what the caller named, and the
    // binding must match the owner's own reconstruction — a caller-supplied stale context is never used.
    const authority = owner.authority;
    if (authority.issuerKeyRef !== snapshot.expectedIssuerKeyRef || authority.decisionAuthorityGeneration !== snapshot.expectedDecisionAuthorityGeneration)
      return { outcome: 'stale', reasonCode: 'OWNER_AUTHORITY_CHANGED' };
    if (!requestMatchesAuthority(record, authority)) return { outcome: 'stale', reasonCode: 'OWNER_AUTHORITY_CHANGED' };
    if (snapshot.purpose === 'current-verification' && !decisionId.startsWith('dec-verify-')) return { outcome: 'denied', reasonCode: 'NOT_A_VERIFICATION_DECISION' };
    if (
      !bindingMatchesContext({ ...record.binding, status: 'pending' }, owner.context.approvalContext) ||
      computeCanonicalSha256(owner.context.approvalContext) !== computeCanonicalSha256(snapshot.approvalContext)
    )
      return { outcome: 'stale', reasonCode: 'OWNER_CONTEXT_CHANGED' };
    const recordedResolution = this.resolutionOf(storageDir, record.taskId, decisionId);
    if (recordedResolution.status === 'invalid') return { outcome: 'denied', reasonCode: 'INVALID_HUMAN_RESOLUTION' };
    // No terminal row yet is the pending state, not a refusal: the owner records a hold on it.
    const binding: ApprovalBinding = { ...record.binding, status: recordedResolution.status === 'recorded' ? recordedResolution.resolution.decision : 'pending' };
    const validation = validateApprovalBinding(binding, snapshot.approvalContext);
    if (!validation.ok || !bindingMatchesContext(binding, snapshot.approvalContext)) return { outcome: 'denied', reasonCode: 'ISSUER_CONTEXT_MISMATCH' };
    // Only a terminal decision carries authority, so only it is bound to the issuing authority and
    // generation. A pending row is not yet a decision and stays unbound until the owner consumes it.
    const terminal = binding.status === 'approved' || binding.status === 'rejected';
    if (terminal && recorded) {
      const bound = await bindIssuedDecision(this.options.store, record.taskId, {
        decisionId,
        issuerKeyRef: authority.issuerKeyRef,
        decisionAuthorityGeneration: authority.decisionAuthorityGeneration,
        bindingDigest: bindingIdentityDigest(binding),
      });
      if (!bound) return { outcome: 'denied', reasonCode: 'DECISION_BINDING_CONFLICT' };
    } else if (terminal && !issuedBindingMatches(this.options.store, record.taskId, decisionId, authority.issuerKeyRef, authority.decisionAuthorityGeneration, binding)) {
      // A terminal decision the owner never consumed at this authority cannot be resolved as current.
      return { outcome: 'stale', reasonCode: 'DECISION_NOT_ISSUED' };
    }
    return {
      outcome: 'resolved',
      decisionId,
      binding,
      issuerKeyRef: authority.issuerKeyRef,
      decisionAuthorityGeneration: authority.decisionAuthorityGeneration,
      contextDigest: computeCanonicalSha256(snapshot),
    };
  }

  /** The pre-patch check: one recorded plan decision is still a human approval at the named authority. */
  async planDecisionIsApproved(decisionId: string, context: VerificationApprovalContextV02): Promise<boolean> {
    const storageDir = this.options.approvalStorageDir;
    if (!storageDir || !isVerificationApprovalContextV02(context)) return false;
    const record = requestRecord(storageDir, decisionId);
    if (!record || record.decisionId !== decisionId || record.taskId !== context.approvalContext.currentTaskId) return false;
    const control = await this.options.store.readControl(record.taskId, this.controlFallback());
    const authority = authorityOf(control);
    if (!authority || authority.issuerKeyRef !== context.expectedIssuerKeyRef || authority.decisionAuthorityGeneration !== context.expectedDecisionAuthorityGeneration) return false;
    if (!requestMatchesAuthority(record, authority)) return false;
    const recordedResolution = this.resolutionOf(storageDir, record.taskId, decisionId);
    if (recordedResolution.status !== 'recorded' || recordedResolution.resolution.decision !== 'approved') return false;
    // The decision must still be the one this owner consumed at this authority; an advanced
    // generation cannot relabel an old record as current, so it is refused here.
    if (!issuedBindingMatches(this.options.store, record.taskId, decisionId, authority.issuerKeyRef, authority.decisionAuthorityGeneration, { ...record.binding, status: 'approved' })) return false;
    const binding: ApprovalBinding = { ...record.binding, status: 'approved' };
    return validateApprovalBinding(binding, context.approvalContext).ok && bindingMatchesContext(binding, context.approvalContext);
  }

  private async resolvePlanApprovalFacts(
    taskId: string,
  ): Promise<{ readonly authority: PolicyAuthorityRefV02; readonly decisionId: string; readonly binding: ApprovalBinding; readonly context: VerificationApprovalContextV02 } | undefined> {
    const storageDir = this.options.approvalStorageDir;
    if (!storageDir) return undefined;
    const state = await this.options.store.readTask(taskId);
    const decisionId = state?.activeDecisionId;
    if (!state || !state.plan || state.node !== 'AwaitPlan' || !decisionId || state.plan.decisionRef !== decisionId) return undefined;
    const authority = authorityOf(await this.options.store.readControl(taskId, this.controlFallback()));
    if (!authority) return undefined;
    const record = requestRecord(storageDir, decisionId);
    const recorded = record ? this.resolutionOf(storageDir, record.taskId, decisionId) : { status: 'invalid' as const };
    if (!record || recorded.status !== 'recorded' || recorded.resolution.decision !== 'approved' || record.taskId !== taskId) return undefined;
    if (!requestMatchesAuthority(record, authority)) return undefined;
    const context = approvalContextOf(decisionId, state.plan, state, authority);
    const binding: ApprovalBinding = { ...record.binding, status: 'approved' };
    if (!validateApprovalBinding(binding, context.approvalContext).ok || !bindingMatchesContext(binding, context.approvalContext)) return undefined;
    return { authority, decisionId, binding, context };
  }

  /** The AwaitPlan→Patch trusted approval, derived only from the recorded human decision and the head. Read-only. */
  async trustedPlanApproval(taskId: string): Promise<{ readonly approval: { readonly binding: unknown; readonly freshness: ApprovalBindingContext } } | undefined> {
    const facts = await this.resolvePlanApprovalFacts(taskId);
    if (!facts) return undefined;
    return { approval: { binding: facts.binding, freshness: facts.context.approvalContext } };
  }

  /** Consumes the plan decision on accepted transition: binds it to this authority and generation. */
  async commitPlanApproval(taskId: string): Promise<boolean> {
    const facts = await this.resolvePlanApprovalFacts(taskId);
    if (!facts) return false;
    return bindIssuedDecision(this.options.store, taskId, {
      decisionId: facts.decisionId,
      issuerKeyRef: facts.authority.issuerKeyRef,
      decisionAuthorityGeneration: facts.authority.decisionAuthorityGeneration,
      bindingDigest: bindingIdentityDigest(facts.binding),
    });
  }

  async recordVerificationApproval(request: RecordVerificationApprovalRequestV02): Promise<RecordVerificationApprovalResultV02> {
    let snapshot: RecordVerificationApprovalRequestV02;
    try {
      snapshot = structuredClone(request);
    } catch {
      return { outcome: 'conflict', requestIdentity: '', reasonCode: 'INVALID_REQUEST' };
    }
    if (!isRecordVerificationApprovalRequestV02(snapshot)) return { outcome: 'conflict', requestIdentity: '', reasonCode: 'INVALID_REQUEST' };
    const storageDir = this.options.approvalStorageDir;
    if (!storageDir) return { outcome: 'unavailable', requestIdentity: snapshot.requestIdentity, reasonCode: 'MISSING_APPROVAL_STORE' };
    return this.options.store.locked(snapshot.taskId, async () => this.recordLocked(storageDir, snapshot));
  }

  private async recordLocked(storageDir: string, request: RecordVerificationApprovalRequestV02): Promise<RecordVerificationApprovalResultV02> {
    const state = await this.options.store.readTask(request.taskId);
    const control = await this.options.store.readControl(request.taskId, this.controlFallback());
    const authority = authorityOf(control);
    const fail = (outcome: 'stale' | 'blocked' | 'unavailable' | 'conflict', reasonCode: string): RecordVerificationApprovalResultV02 => ({
      outcome,
      requestIdentity: request.requestIdentity,
      reasonCode,
    });
    const result = (outcome: 'pending' | 'rejected' | 'approved', current: TaskState, head: ControlRecordV02): RecordVerificationApprovalResultV02 => ({
      outcome,
      requestIdentity: request.requestIdentity,
      decisionId: request.decisionId,
      state: current,
      controlVersion: head.controlVersion,
      epoch: head.epoch,
      decisionAuthorityGeneration: authority?.decisionAuthorityGeneration ?? 0,
    });
    if (!state || !authority) return fail('unavailable', 'OWNER_STATE_UNAVAILABLE');
    const plan = state.plan;
    // A replayed request after this owner applied it reproduces the same result from the durable state.
    if (
      plan?.decisionRef === request.decisionId &&
      state.activeDecisionId === request.decisionId &&
      (state.approvalDecisionRefs ?? []).includes(request.decisionId) &&
      planMaterialDigest(state) === request.expectedPlanMaterialDigest
    ) {
      const bindings = readDecisionBindings(this.options.store, request.taskId);
      const issued = bindings?.get(request.decisionId);
      if (!issued || issued.decisionAuthorityGeneration !== authority.decisionAuthorityGeneration || issued.issuerKeyRef !== authority.issuerKeyRef) {
        return fail('stale', 'OWNER_AUTHORITY_CHANGED');
      }
      if (control.controlVersion === request.expectedControlVersion) {
        const next: ControlRecordV02 = { ...control, controlVersion: control.controlVersion + 1 };
        await this.options.store.writeControl(request.taskId, next);
        return result('approved', state, next);
      }
      if (control.controlVersion === request.expectedControlVersion + 1) {
        return result('approved', state, control);
      }
      return fail('stale', 'OWNER_CAS_MISMATCH');
    }
    if (control.mode === 'rejected' && control.holdRef === rejectionHoldRef(request.requestIdentity) && plan?.decisionRef === request.originalDecisionId) return result('rejected', state, control);
    if (state.node !== 'Verify' || !plan || plan.decisionRef !== request.originalDecisionId || state.activeDecisionId !== undefined) return fail('stale', 'VERIFY_STATE_MISMATCH');
    if (
      state.taskId !== request.taskId ||
      state.runId !== request.runId ||
      state.workspaceId !== request.workspaceId ||
      state.repositoryId !== request.repositoryId ||
      state.stateVersion !== request.expectedStateVersion ||
      state.repositoryRevisionDigest !== request.expectedRepositoryRevisionDigest ||
      plan.planVersion !== request.expectedPlanVersion ||
      planMaterialDigest(state) !== request.expectedPlanMaterialDigest ||
      control.controlVersion !== request.expectedControlVersion ||
      control.epoch !== request.expectedEpoch ||
      authority.decisionAuthorityGeneration !== request.expectedDecisionAuthorityGeneration ||
      computeCanonicalSha256(policyIdentityOf(authority)) !== computeCanonicalSha256(request.policyIdentity)
    )
      return fail('stale', 'OWNER_CAS_MISMATCH');
    if (request.decisionId === request.originalDecisionId || (state.approvalDecisionRefs ?? []).includes(request.decisionId)) return fail('conflict', 'DECISION_ID_ALREADY_USED');
    if (control.mode !== 'runnable' || control.holdRef || control.activeClaimId) return fail('blocked', 'OWNER_CONTROL_BLOCKED');

    const resolution = await this.resolveDecision(storageDir, request.decisionId, approvalContextOf(request.decisionId, plan, state, authority), true);
    if (resolution.outcome !== 'resolved') return fail(resolution.outcome === 'unavailable' ? 'unavailable' : 'stale', resolution.reasonCode);
    const status = resolution.binding.status;
    if (status === 'pending') return result('pending', state, control);
    if (status === 'rejected') {
      const holdRef = rejectionHoldRef(request.requestIdentity);
      const next: ControlRecordV02 = { ...control, mode: 'rejected', holdRef, holdEventDigest: holdEventDigest(control, state, holdRef), controlVersion: control.controlVersion + 1 };
      await this.options.store.writeControl(request.taskId, next);
      return result('rejected', state, next);
    }
    if (status !== 'approved') return fail('stale', 'INVALID_ISSUER_STATUS');
    const candidate: TaskState = {
      ...state,
      stateVersion: state.stateVersion + 1,
      plan: { ...plan, decisionRef: request.decisionId },
      activeDecisionId: request.decisionId,
      approvalDecisionRefs: [...(state.approvalDecisionRefs ?? []), request.decisionId],
    };
    if (!validateTaskState(candidate).ok) return fail('conflict', 'INVALID_APPROVED_STATE');
    await this.options.store.writeTask(request.taskId, candidate);
    const next: ControlRecordV02 = { ...control, controlVersion: control.controlVersion + 1 };
    await this.options.store.writeControl(request.taskId, next);
    return result('approved', candidate, next);
  }
}
