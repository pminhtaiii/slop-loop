/**
 * Durable verification-approval authority for the real-tier owner (T061, contract §"verification authority").
 *
 * `resolvePlanDecisionInContext` re-issues one recorded human plan decision as a resolution only when
 * the caller's explicit authority context and the durable approval-store record agree in every field.
 * `recordVerificationApproval` is the owner's one write for the post-patch D1: it revalidates the exact
 * request against the durable head, resolves the decision in context, and then holds it pending,
 * records the rejection hold, or applies the single `plan.decisionRef`/`activeDecisionId` rebind.
 * `planDecisionIsApproved` and `trustedPlanApproval` expose the same durable facts to the pre-patch
 * admissions. Shared reads/records live in `state-port-v02-verification-records.ts`.
 *
 * Everything comes from durable owner state that already exists — the approval store's recorded
 * requests/resolutions, the control head, and the journal's settled patch ancestry. No authority is
 * minted here. Semantics are ported from `tests/runtime/support/uc03/memory-state.ts`.
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
import type { StatePortStore } from './state-port-v02-storage.ts';
import type { ControlRecordV02 } from './state-port-v02-types.ts';
import { DEFAULT_CONTROL } from './state-port-v02-types.ts';
import { readSettledPatchAncestry } from './state-port-v02-journal.ts';
import {
  approvalContextOf,
  authorityOf,
  bindingMatchesContext,
  currentVerificationMatches,
  holdEventDigest,
  planMaterialDigest,
  policyIdentityOf,
  recordedResolution,
  rejectionHoldRef,
  requestRecord,
} from './state-port-v02-verification-records.ts';

export interface DurableVerificationAuthorityOptions {
  readonly store: StatePortStore;
  /** The approval store directory the real UC-05 service writes; absent, both methods fail closed. */
  readonly approvalStorageDir: string | undefined;
}

export class DurableVerificationAuthority {
  private readonly options: DurableVerificationAuthorityOptions;

  constructor(options: DurableVerificationAuthorityOptions) {
    this.options = options;
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
    return this.resolveDecision(storageDir, decisionId, snapshot);
  }

  private async resolveDecision(storageDir: string, decisionId: string, snapshot: VerificationApprovalContextV02): Promise<VerificationApprovalResolutionV02> {
    const record = requestRecord(storageDir, decisionId);
    if (!record || record.decisionId !== decisionId) return { outcome: 'stale', reasonCode: 'UNKNOWN_DECISION' };
    if (record.taskId !== snapshot.approvalContext.currentTaskId) return { outcome: 'stale', reasonCode: 'CROSS_TASK_DECISION' };
    const authority =
      snapshot.purpose === 'historical-patch' ? await this.historicalAuthority(record.taskId, decisionId) : authorityOf(await this.options.store.readControl(record.taskId, DEFAULT_CONTROL));
    // The decision must be resolvable at the exact authority generation and issuer the caller names.
    if (!authority || authority.issuerKeyRef !== snapshot.expectedIssuerKeyRef || authority.decisionAuthorityGeneration !== snapshot.expectedDecisionAuthorityGeneration)
      return { outcome: 'stale', reasonCode: 'OWNER_AUTHORITY_CHANGED' };
    if (snapshot.purpose === 'current-verification') {
      const task = await this.options.store.readTask(record.taskId);
      if (!task) return { outcome: 'stale', reasonCode: 'OWNER_STATE_UNAVAILABLE' };
      if (!decisionId.startsWith('dec-verify-')) return { outcome: 'denied', reasonCode: 'NOT_A_VERIFICATION_DECISION' };
      if (!currentVerificationMatches(task, decisionId)) return { outcome: 'stale', reasonCode: 'OWNER_CONTEXT_CHANGED' };
    }
    const binding: ApprovalBinding = { ...record.binding, status: recordedResolution(storageDir, record.taskId, decisionId)?.decision ?? 'pending' };
    const validation = validateApprovalBinding(binding, snapshot.approvalContext);
    if (!validation.ok || !bindingMatchesContext(binding, snapshot.approvalContext)) return { outcome: 'denied', reasonCode: 'ISSUER_CONTEXT_MISMATCH' };
    return {
      outcome: 'resolved',
      decisionId,
      binding,
      issuerKeyRef: snapshot.expectedIssuerKeyRef,
      decisionAuthorityGeneration: snapshot.expectedDecisionAuthorityGeneration,
      contextDigest: computeCanonicalSha256(snapshot),
    };
  }

  /**
   * The authority the settled approved-plan patch ending at the current revision ran under. The
   * ancestry itself names the decision, so a later node (Review/Deliver, or a repair round) can still
   * re-read the patch's own authority; `null` when no single settled patch ends at this revision or it
   * names a different decision.
   */
  private async historicalAuthority(taskId: string, decisionId: string): Promise<PolicyAuthorityRefV02 | null> {
    const task = await this.options.store.readTask(taskId);
    if (!task) return null;
    const ancestry = await readSettledPatchAncestry(this.options.store, { taskId, runId: task.runId, resultingRepositoryRevisionDigest: task.repositoryRevisionDigest });
    return ancestry?.originalTaskState.plan?.decisionRef === decisionId ? ancestry.originalAuthorityRef : null;
  }

  /** The pre-patch check: one recorded plan decision is still a human approval at the named authority. */
  async planDecisionIsApproved(decisionId: string, context: VerificationApprovalContextV02): Promise<boolean> {
    const storageDir = this.options.approvalStorageDir;
    if (!storageDir || !isVerificationApprovalContextV02(context)) return false;
    const record = requestRecord(storageDir, decisionId);
    if (!record || record.decisionId !== decisionId || record.taskId !== context.approvalContext.currentTaskId) return false;
    const authority = authorityOf(await this.options.store.readControl(record.taskId, DEFAULT_CONTROL));
    if (!authority || authority.issuerKeyRef !== context.expectedIssuerKeyRef || authority.decisionAuthorityGeneration !== context.expectedDecisionAuthorityGeneration) return false;
    const resolution = recordedResolution(storageDir, record.taskId, decisionId);
    if (!resolution || resolution.decision !== 'approved') return false;
    const binding: ApprovalBinding = { ...record.binding, status: 'approved' };
    return validateApprovalBinding(binding, context.approvalContext).ok && bindingMatchesContext(binding, context.approvalContext);
  }

  /** The AwaitPlan→Patch trusted approval, derived only from the recorded human decision and the head. */
  async trustedPlanApproval(taskId: string): Promise<{ readonly approval: { readonly binding: unknown; readonly freshness: ApprovalBindingContext } } | undefined> {
    const storageDir = this.options.approvalStorageDir;
    if (!storageDir) return undefined;
    const state = await this.options.store.readTask(taskId);
    const decisionId = state?.activeDecisionId;
    if (!state || !state.plan || state.node !== 'AwaitPlan' || !decisionId || state.plan.decisionRef !== decisionId) return undefined;
    const authority = authorityOf(await this.options.store.readControl(taskId, DEFAULT_CONTROL));
    if (!authority) return undefined;
    const record = requestRecord(storageDir, decisionId);
    const resolution = record ? recordedResolution(storageDir, record.taskId, decisionId) : null;
    if (!record || !resolution || resolution.decision !== 'approved' || record.taskId !== taskId) return undefined;
    const context = approvalContextOf(decisionId, state.plan, state, authority);
    const binding: ApprovalBinding = { ...record.binding, status: 'approved' };
    if (!validateApprovalBinding(binding, context.approvalContext).ok || !bindingMatchesContext(binding, context.approvalContext)) return undefined;
    return { approval: { binding, freshness: context.approvalContext } };
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
    const control = await this.options.store.readControl(request.taskId, DEFAULT_CONTROL);
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
    )
      return result('approved', state, control);
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

    const resolution = await this.resolveDecision(storageDir, request.decisionId, approvalContextOf(request.decisionId, plan, state, authority));
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
