/**
 * Shared reads and records for the durable verification-approval authority
 * (`state-port-v02-verification-authority.ts`). They are split out only to keep each file within
 * the source-size budget; they hold no authority and perform no write.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeCanonicalSha256 } from '../../contracts/foundation/uc03.ts';
import type {
  ApprovalBinding,
  CompleteApprovalBindingContextV02,
  PolicyAuthorityRefV02,
  TaskState,
  VerificationApprovalContextV02,
  VerificationPolicyIdentityV02,
} from '../../contracts/foundation/uc03.ts';
import type { ApprovalRequestRecord, HumanResolution } from '../../contracts/approvals/contracts.ts';
import { validateApprovalRequestRecord } from '../../contracts/approvals/contracts.ts';
import { decisionDir, taskDir } from './approval-types.ts';
import type { ControlRecordV02 } from './state-port-v02-types.ts';

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function requestRecord(approvalStorageDir: string, decisionId: string): ApprovalRequestRecord | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(decisionId)) return null;
  const checked = validateApprovalRequestRecord(readJson<unknown>(join(decisionDir(approvalStorageDir, decisionId), 'request.json')));
  return checked.ok ? checked.value : null;
}

export function recordedResolution(approvalStorageDir: string, taskId: string, decisionId: string): HumanResolution | null {
  const history = readJson<{ readonly resolutions?: readonly HumanResolution[] }>(join(taskDir(approvalStorageDir, taskId), 'history.json'));
  return history?.resolutions?.find(row => row.decisionId === decisionId) ?? null;
}

export function bindingMatchesContext(binding: ApprovalBinding, context: CompleteApprovalBindingContextV02): boolean {
  return (
    binding.actionKind === 'fix_plan' &&
    binding.taskId === context.currentTaskId &&
    binding.workspaceId === context.currentWorkspaceId &&
    binding.repositoryRevisionDigest === context.currentRepositoryRevisionDigest &&
    binding.policyId === context.currentPolicyId &&
    binding.policyVersion === context.currentPolicyVersion &&
    binding.normalizedActionDigest === context.currentNormalizedActionDigest &&
    binding.planVersion === context.currentPlanVersion &&
    binding.strategyDigest === context.currentStrategyDigest &&
    binding.baselineRef === context.currentBaselineRef &&
    computeCanonicalSha256(binding.evidenceRefs ?? []) === computeCanonicalSha256(context.currentEvidenceRefs) &&
    binding.criteriaDigest === context.currentCriteriaDigest &&
    binding.checkSetDigest === context.currentCheckSetDigest
  );
}

export function policyIdentityOf(authority: PolicyAuthorityRefV02): VerificationPolicyIdentityV02 {
  return { policyId: authority.policyId, policyVersion: authority.policyVersion, configId: authority.configId, configVersion: authority.configVersion, issuerKeyRef: authority.issuerKeyRef };
}

/** The exact context a plan decision is re-issued in; same fields as `createVerificationApprovalContext`. */
export function approvalContextOf(decisionId: string, plan: NonNullable<TaskState['plan']>, task: TaskState, authority: PolicyAuthorityRefV02): VerificationApprovalContextV02 {
  const action = {
    actionId: decisionId,
    kind: 'approve_fix_plan' as const,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    diagnosisEvidenceRefs: plan.evidenceRefs,
    checkSetDigest: plan.checkSetDigest,
  };
  return {
    purpose: 'current-verification',
    expectedIssuerKeyRef: authority.issuerKeyRef,
    expectedDecisionAuthorityGeneration: authority.decisionAuthorityGeneration,
    approvalContext: {
      currentTaskId: task.taskId,
      currentWorkspaceId: task.workspaceId,
      currentRepositoryRevisionDigest: task.repositoryRevisionDigest,
      currentPolicyId: authority.policyId,
      currentPolicyVersion: authority.policyVersion,
      currentNormalizedActionDigest: computeCanonicalSha256(action),
      currentPlanVersion: plan.planVersion,
      currentStrategyDigest: plan.strategyDigest,
      currentBaselineRef: plan.baselineRef,
      currentEvidenceRefs: [...plan.evidenceRefs],
      currentCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
      currentCheckSetDigest: plan.checkSetDigest,
    },
  };
}

export function planMaterialDigest(task: TaskState): string {
  const plan = task.plan;
  if (!plan) return '';
  return computeCanonicalSha256({
    taskId: task.taskId,
    planVersion: plan.planVersion,
    diagnosis: plan.diagnosis,
    suspectedCauseLocations: plan.suspectedCauseLocations,
    evidenceRefs: plan.evidenceRefs,
    strategy: plan.strategy,
    scopedChanges: plan.scopedChanges,
    checkSetDigest: plan.checkSetDigest,
    baselineRef: plan.baselineRef,
    strategyDigest: plan.strategyDigest,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
  });
}

/** The authority the validated head carries; `null` fails closed exactly as `readVerificationAuthoritySnapshot`. */
export function authorityOf(control: ControlRecordV02): PolicyAuthorityRefV02 | null {
  const authority = control.activeAuthorityRef;
  if (!authority) return null;
  if (![authority.policyId, authority.policyVersion, authority.configId, authority.configVersion, authority.issuerKeyRef].every(value => typeof value === 'string' && value.trim().length > 0))
    return null;
  if (!Number.isSafeInteger(authority.decisionAuthorityGeneration) || authority.decisionAuthorityGeneration <= 0) return null;
  return authority;
}

/** The control-event digest `setTaskControl` writes, so a rejection hold is the same durable fact. */
export function holdEventDigest(control: ControlRecordV02, task: TaskState, holdRef: string): string {
  return computeCanonicalSha256({
    schemaVersion: 'uc04-control-event/0.2-draft',
    taskId: task.taskId,
    runId: task.runId,
    taskStateVersion: task.stateVersion,
    eventKind: 'denial',
    mode: 'rejected',
    eventRef: holdRef,
    controlVersion: control.controlVersion + 1,
    epoch: control.epoch,
  });
}

export function rejectionHoldRef(requestIdentity: string): string {
  return `verification-rejected-${requestIdentity.slice('sha256:'.length)}`;
}

/** `current-verification` resolves only while the head is pre-rebind or already rebound to this decision. */
export function currentVerificationMatches(task: TaskState, decisionId: string): boolean {
  if (!task.plan) return false;
  const pendingBeforeRebind = task.node === 'Verify' && task.activeDecisionId === undefined;
  const currentPointer = task.plan.decisionRef === decisionId && (task.activeDecisionId === undefined || task.activeDecisionId === decisionId);
  return pendingBeforeRebind || currentPointer;
}
