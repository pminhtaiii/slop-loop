import { isDeepStrictEqual } from 'node:util';
import type { ApprovalBinding } from '../contracts/foundation/uc03.ts';
import { computeCanonicalSha256, validateTaskState } from '../contracts/foundation/uc03.ts';
import { validateAdmissionV02 } from '../contracts/foundation/uc03/admission-v02.ts';
import type {
  AdmissionContextV02,
  AdmissionTrustedContextV02,
  ClaimReceiptV02,
  PolicyAuthorityRefV02,
} from '../contracts/foundation/uc03/ports-v02.ts';
import type { DispatchClaimV02 } from '../contracts/approvals/contracts.ts';
import {
  UC05_APPROVAL_SCHEMA_VERSION_V02,
  computeDispatchClaimDigestV02,
  validateDispatchClaimV02,
  validatePolicyProfile,
} from '../contracts/approvals/contracts.ts';
import type { ApprovalService } from './service.ts';
import {
  authorityRefV02,
  dataMethodV02,
  dataPropertyV02,
  isIdV02,
  journalClaimV02,
  journalSnapshotV02,
  exactKeysV02,
  plainRecordV02,
  safeDataV02,
  type JournalClaimV02,
} from './control-v02.ts';

export interface ApprovalContinuationResultV02 {
  readonly outcome: 'claimed' | 'blocked' | 'unavailable';
  readonly claimId: string | null;
  readonly claimState: {
    readonly taskId: string;
    readonly decisionId: string;
    readonly status: 'approved';
    readonly claim: DispatchClaimV02;
    readonly journalReceipt: ClaimReceiptV02;
  } | null;
}
export interface ApprovalContinuationV02 {
  admit(decisionId: string): Promise<ApprovalContinuationResultV02>;
}

interface ApprovalRecoveryPortV02 {
  readonly provenance?: 'mock' | 'real';
  loadAdmission?(decisionId: string): Promise<unknown>;
}
interface JournalClaimPortV02 {
  readonly provenance?: 'mock' | 'real';
  loadTask?(taskId: string): Promise<unknown>;
  getJournalSnapshot?(): unknown;
  claim?(context: AdmissionContextV02): Promise<unknown>;
}

export function createApprovalContinuationV02(options: {
  readonly taskId: string;
  readonly profile: unknown;
  readonly approval: ApprovalService;
  readonly recovery: ApprovalRecoveryPortV02;
  readonly journal?: JournalClaimPortV02;
}): ApprovalContinuationV02 {
  const profile = safeDataV02(options.profile) ? validatePolicyProfile(options.profile) : null;
  if (!profile?.ok || !isIdV02(options.taskId)) throw new Error('invalid-approval-recovery-profile');
  const operationDeadlineMs = profile.value.operationDeadlineMs;
  let closed = false;
  let busy = false;
  return {
    admit: async decisionId => {
      if (closed) return result('unavailable');
      if (busy || !isIdV02(decisionId)) return result('blocked');
      busy = true;
      let expired = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const active = (): void => { if (expired) throw new Error('approval-recovery-expired'); };
      try {
        return await Promise.race([
          Promise.resolve().then(async () => {
            const loadAdmission = dataMethodV02(options.recovery, 'loadAdmission');
            const loadTask = dataMethodV02(options.journal, 'loadTask');
            const getSnapshot = dataMethodV02(options.journal, 'getJournalSnapshot');
            const claimMethod = dataMethodV02(options.journal, 'claim');
            if (dataPropertyV02(options.recovery, 'provenance') !== 'mock' ||
              dataPropertyV02(options.journal, 'provenance') !== 'mock' ||
              !loadAdmission || !loadTask || !getSnapshot || !claimMethod ||
              dataPropertyV02(options.approval, 'provenance') !== 'mock') throw new Error('approval-recovery-unavailable');

            const loaded = await loadAdmission(decisionId);
            active();
            if (!safeDataV02(loaded)) throw new Error('approval-recovery-unavailable');
            const admission = plainRecordV02(loaded, ['context', 'trustedContext']);
            if (!admission || !exactKeysV02(admission, ['context', 'trustedContext'])) throw new Error('approval-recovery-unavailable');
            const checked = validateAdmissionV02(admission['context'], admission['trustedContext'] as AdmissionTrustedContextV02);
            if (!checked.ok) throw new Error('approval-recovery-unavailable');
            const context = checked.value;
            if (context.taskId !== options.taskId || context.planApplicability !== 'approved-plan' ||
              !hasDecisionConsent(context, decisionId)) return result('blocked');
            const expectedAuthority = authorityFor(context);
            const profileIdentity = profile.value.policyIdentity;
            if (!expectedAuthority || expectedAuthority.policyId !== profileIdentity.policyId ||
              expectedAuthority.policyVersion !== profileIdentity.policyVersion || expectedAuthority.configId !== profileIdentity.configId ||
              expectedAuthority.configVersion !== profileIdentity.configVersion) return result('blocked');

            const binding = await options.approval.resolve(decisionId);
            active();
            if (!safeDataV02(binding) || binding.status !== 'approved' || binding.decisionId !== decisionId ||
              !await options.approval.validateBinding(binding) || !bindingMatches(context, binding, expectedAuthority)) return result('blocked');
            active();

            const before = journalSnapshotV02(await getSnapshot());
            const taskBefore = validateTaskState(await loadTask(options.taskId));
            active();
            if (!before || !taskBefore.ok) throw new Error('approval-recovery-unavailable');
            if (before.mode !== 'runnable' || before.holdRef !== null || before.activeClaimId !== null ||
              before.controlVersion !== context.expectedControlVersion || before.epoch !== context.expectedEpoch ||
              !sameAuthority(before.activeAuthorityRef, expectedAuthority) ||
              taskBefore.value.taskId !== context.taskId || taskBefore.value.runId !== context.runId ||
              taskBefore.value.stateVersion !== context.expectedTaskStateVersion || taskBefore.value.node !== context.runnableNode ||
              (context.subjectKind === 'repository-action' && taskBefore.value.repositoryRevisionDigest !== context.canonicalRevision)) return result('blocked');

            active();
            const rawReceipt = await claimMethod(context);
            active();
            const journalReceipt = journalClaimV02(rawReceipt);
            if (!journalReceipt || !claimMatchesContext(journalReceipt, context)) throw new Error('approval-recovery-unconfirmed');
            const claim = makeDispatchClaim(context, journalReceipt);
            if (!claim) throw new Error('approval-recovery-unconfirmed');

            const after = journalSnapshotV02(await getSnapshot());
            const taskAfter = validateTaskState(await loadTask(options.taskId));
            active();
            const activeClaim = after?.claims.find(row => row.claimId === journalReceipt.claimId);
            if (!after || !taskAfter.ok || !activeClaim || after.mode !== 'runnable' || after.holdRef !== null ||
              after.controlVersion !== before.controlVersion + 1 || after.epoch !== before.epoch ||
              after.activeClaimId !== journalReceipt.claimId || activeClaim.status !== 'claimed' || activeClaim.attemptId !== null ||
              after.claims.length !== before.claims.length + 1 ||
              !before.claims.every(row => after.claims.some(retained => isDeepStrictEqual(retained, row))) ||
              after.attempts.length !== before.attempts.length || !sameAuthority(after.activeAuthorityRef, expectedAuthority) ||
              taskAfter.value.taskId !== taskBefore.value.taskId || taskAfter.value.runId !== taskBefore.value.runId ||
              taskAfter.value.stateVersion !== taskBefore.value.stateVersion || taskAfter.value.node !== taskBefore.value.node ||
              taskAfter.value.repositoryRevisionDigest !== taskBefore.value.repositoryRevisionDigest) throw new Error('approval-recovery-unconfirmed');

            return {
              outcome: 'claimed' as const,
              claimId: journalReceipt.claimId,
              claimState: { taskId: options.taskId, decisionId, status: 'approved' as const, claim, journalReceipt },
            };
          }),
          new Promise<ApprovalContinuationResultV02>(resolve => {
            timer = setTimeout(() => { expired = true; closed = true; resolve(result('unavailable')); }, operationDeadlineMs);
          }),
        ]);
      } catch { closed = true; return result('unavailable'); }
      finally { expired = true; busy = false; if (timer !== undefined) clearTimeout(timer); }
    },
  };
}

function result(outcome: 'blocked' | 'unavailable'): ApprovalContinuationResultV02 {
  return { outcome, claimId: null, claimState: null };
}

function authorityFor(context: AdmissionContextV02): PolicyAuthorityRefV02 | null {
  if (context.subjectKind === 'repository-action') return context.policyAuthorityRef;
  const identity = context.providerIdentity;
  return {
    policyId: identity.pricingPolicyId,
    policyVersion: identity.pricingPolicyVersion,
    configId: identity.configId,
    configVersion: identity.configVersion,
    issuerKeyRef: identity.issuerKeyRef,
    decisionAuthorityGeneration: identity.decisionAuthorityGeneration,
  };
}

function bindingMatches(context: AdmissionContextV02, binding: ApprovalBinding, authority: PolicyAuthorityRefV02): boolean {
  if (binding.taskId !== context.taskId || binding.policyId !== authority.policyId || binding.policyVersion !== authority.policyVersion) return false;
  if (context.subjectKind === 'repository-action') {
    return binding.workspaceId === context.workspaceId && binding.normalizedActionDigest === context.actionDigest &&
      binding.repositoryRevisionDigest === context.canonicalRevision;
  }
  return binding.policyId === context.providerIdentity.pricingPolicyId &&
    binding.policyVersion === context.providerIdentity.pricingPolicyVersion;
}

function hasDecisionConsent(context: AdmissionContextV02, decisionId: string): boolean {
  if (context.subjectKind === 'repository-action' && context.actionDecisionReceipt) {
    return context.actionDecisionReceipt.status === 'approved' && context.actionDecisionReceipt.decisionId === decisionId &&
      context.actionDecisionReceipt.actionDigest === context.actionDigest;
  }
  return context.planDecisionRef === decisionId;
}

function sameAuthority(left: unknown, right: PolicyAuthorityRefV02): boolean {
  const checkedLeft = authorityRefV02(left);
  const checkedRight = authorityRefV02(right);
  return !!checkedLeft && !!checkedRight && computeCanonicalSha256(checkedLeft) === computeCanonicalSha256(checkedRight);
}

function claimMatchesContext(receipt: JournalClaimV02, context: AdmissionContextV02): boolean {
  const refs = context.subjectKind === 'repository-action'
    ? context.reservationRefs
    : [context.requestReservationReceipt, ...context.budgetRefs];
  return receipt.taskId === context.taskId && receipt.runId === context.runId &&
    receipt.subjectKind === context.subjectKind && receipt.planApplicability === context.planApplicability &&
    receipt.preClaimTaskStateVersion === context.expectedTaskStateVersion &&
    receipt.preClaimControlVersion === context.expectedControlVersion &&
    receipt.postClaimControlVersion === context.expectedControlVersion + 1 &&
    receipt.epoch === context.expectedEpoch && receipt.status === 'claimed' &&
    isDeepStrictEqual(receipt.reservationRefs, refs);
}

function makeDispatchClaim(context: AdmissionContextV02, receipt: JournalClaimV02): DispatchClaimV02 | null {
  const authority = authorityFor(context);
  if (!authority || !claimMatchesContext(receipt, context)) return null;
  const common = {
    schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
    claimId: receipt.claimId,
    claimDigest: '',
    taskId: receipt.taskId,
    runId: receipt.runId,
    taskStateSchemaVersion: context.taskStateSchemaVersion,
    expectedTaskStateVersion: receipt.preClaimTaskStateVersion,
    controlSchemaVersion: context.controlSchemaVersion,
    expectedControlVersion: receipt.preClaimControlVersion,
    expectedEpoch: receipt.epoch,
    policyIdentity: {
      policyId: authority.policyId,
      policyVersion: authority.policyVersion,
      configId: authority.configId,
      configVersion: authority.configVersion,
    },
    decisionRefs: [...new Set([
      context.planDecisionRef,
      ...(context.subjectKind === 'repository-action' && context.actionDecisionReceipt
        ? [context.actionDecisionReceipt.decisionId]
        : []),
    ])],
    reservationRefs: [...receipt.reservationRefs],
    phase: 'claimed' as const,
    resultRef: null,
    subjectKind: context.subjectKind,
    planApplicability: context.planApplicability,
    planBindingDigest: context.planBindingDigest,
    planDecisionRef: context.planDecisionRef,
  };
  const specific = context.subjectKind === 'repository-action'
    ? { actionId: context.action.actionId, actionDigest: context.actionDigest, repositoryStateDigest: context.canonicalRevision }
    : { providerRequestId: context.providerRequestId, requestContentDigest: context.requestContentDigest, role: context.role };
  const unsigned = { ...common, ...specific };
  const candidate = { ...unsigned, claimDigest: computeDispatchClaimDigestV02(unsigned) };
  const validated = validateDispatchClaimV02(candidate);
  return validated.ok ? validated.value : null;
}
