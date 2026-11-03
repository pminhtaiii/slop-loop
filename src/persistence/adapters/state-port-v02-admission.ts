/**
 * Admission and task-shape helpers for the durable UC-03 v0.2 state port.
 *
 * Pure functions over an admission context and a task snapshot; no storage access.
 */
import { computeCanonicalSha256, validateAdmissionV02, validateTaskState } from '../../contracts/foundation/uc03.ts';
import type {
  AdmissionContextV02,
  AdmissionTrustedContextV02,
  BudgetLedger,
  ExecutorIdentityV02,
  PolicyAuthorityRefV02,
  ProviderAdmissionContextV02,
  ProviderAdmissionTrustedContextV02,
  RepositoryAdmissionContextV02,
  RepositoryAdmissionTrustedContextV02,
  SafeReferenceV02,
  TaskState,
} from '../../contracts/foundation/uc03.ts';
import { SHA256 } from './state-port-v02-types.ts';

export function equal(left: unknown, right: unknown): boolean {
  try {
    return computeCanonicalSha256(left) === computeCanonicalSha256(right);
  } catch {
    return false;
  }
}

export function actorPayloadDigest(context: AdmissionContextV02): string {
  return context.subjectKind === 'repository-action' ? context.actionDigest : context.requestContentDigest;
}

export function authorityFor(context: AdmissionContextV02): PolicyAuthorityRefV02 {
  if (context.subjectKind === 'repository-action') return context.policyAuthorityRef;
  return {
    policyId: context.providerIdentity.pricingPolicyId,
    policyVersion: context.providerIdentity.pricingPolicyVersion,
    configId: context.providerIdentity.configId,
    configVersion: context.providerIdentity.configVersion,
    issuerKeyRef: context.providerIdentity.issuerKeyRef,
    decisionAuthorityGeneration: context.providerIdentity.decisionAuthorityGeneration,
  };
}

export function isRepairPatch(context: AdmissionContextV02): boolean {
  return context.subjectKind === 'repository-action' && context.planApplicability === 'approved-plan' && context.action.kind === 'apply_patch';
}

export function isDiagnosticPatch(context: AdmissionContextV02): boolean {
  return context.subjectKind === 'repository-action' && context.planApplicability === 'pre-plan-diagnostic' && context.action.kind === 'apply_patch';
}

export function isRepositoryPatch(context: AdmissionContextV02): boolean {
  return isRepairPatch(context) || isDiagnosticPatch(context);
}

/** Trusted context derived from the admission itself; see the shortcut note on validateAdmission. */
export function deriveTrustedContext(context: RepositoryAdmissionContextV02): RepositoryAdmissionTrustedContextV02;
export function deriveTrustedContext(context: ProviderAdmissionContextV02): ProviderAdmissionTrustedContextV02;
export function deriveTrustedContext(context: AdmissionContextV02): AdmissionTrustedContextV02;
export function deriveTrustedContext(context: AdmissionContextV02): AdmissionTrustedContextV02 {
  if (context.subjectKind === 'provider-request') {
    const request = context.providerRequest;
    return {
      subjectKind: 'provider-request',
      taskStateSchemaVersion: context.taskStateSchemaVersion,
      expectedTaskStateVersion: context.expectedTaskStateVersion,
      controlSchemaVersion: context.controlSchemaVersion,
      expectedControlVersion: context.expectedControlVersion,
      expectedEpoch: context.expectedEpoch,
      taskId: context.taskId,
      runId: context.runId,
      runnableNode: context.runnableNode,
      planApplicability: context.planApplicability,
      ...(context.planApplicability === 'approved-plan'
        ? { planBindingDigest: context.planBindingDigest, planDecisionRef: context.planDecisionRef }
        : { diagnosticPurpose: context.diagnosticPurpose, taskCriteriaDigest: context.taskCriteriaDigest }),
      role: context.role,
      providerRequestId: context.providerRequestId,
      requestContentDigest: context.requestContentDigest,
      providerAdmissionReceiptRef: context.providerAdmissionReceipt.receiptId,
      providerAdmissionReceiptDigest: context.providerAdmissionReceipt.receiptDigest,
      requestReservationReceipt: context.requestReservationReceipt,
      budgetRefs: context.budgetRefs,
      providerIdentity: context.providerIdentity,
      requestLimits: {
        timeoutMs: request.timeoutMs,
        maxInputTokens: context.finiteBounds.maxInputTokens,
        maxOutputTokens: context.finiteBounds.maxOutputTokens,
        maxBillableTokens: context.finiteBounds.maxBillableTokens,
        maxCostUsd: context.finiteBounds.maxCostUsd,
        ...(context.finiteBounds.maxReviewerIterations !== undefined ? { maxReviewerIterations: context.finiteBounds.maxReviewerIterations } : {}),
      },
    };
  }
  return {
    subjectKind: 'repository-action',
    taskStateSchemaVersion: context.taskStateSchemaVersion,
    expectedTaskStateVersion: context.expectedTaskStateVersion,
    controlSchemaVersion: context.controlSchemaVersion,
    expectedControlVersion: context.expectedControlVersion,
    expectedEpoch: context.expectedEpoch,
    taskId: context.taskId,
    runId: context.runId,
    workspaceId: context.workspaceId,
    repositoryId: context.repositoryId,
    runnableNode: context.runnableNode,
    canonicalRevision: context.canonicalRevision,
    executionProfileId: context.executionProfileId,
    planApplicability: context.planApplicability,
    planBindingDigest: context.planApplicability === 'approved-plan' ? context.planBindingDigest : undefined,
    planDecisionRef: context.planApplicability === 'approved-plan' ? context.planDecisionRef : undefined,
    policyAuthorityRef: context.policyAuthorityRef,
    policyEvaluationReceiptRef: context.policyEvaluationReceipt.receiptId,
    policyEvaluationReceiptDigest: context.policyEvaluationReceipt.receiptDigest,
    ...(context.actionDecisionReceipt !== undefined
      ? { actionDecisionReceiptRef: context.actionDecisionReceipt.decisionId, actionDecisionReceiptDigest: context.actionDecisionReceipt.decisionDigest }
      : {}),
    freshnessContextDigest: context.policyEvaluationReceipt.freshnessContextDigest,
    ...(context.action.kind === 'run_command' && context.commandView ? { commandViewDigest: context.commandView.viewDigest } : {}),
    executionProfile: {
      isolationProfileRef: context.executionProfileId,
      exclusionsPolicyVersion: 'exclusions-v1',
      scratchIdentity: 'scratch-admission-v02',
      commandBounds: { timeoutMs: 30_000, maxOutputBytes: 1_048_576, maxCpuSeconds: 120, maxMemoryBytes: 536_870_912, maxProcessCount: 64 },
      patchBounds: { maxPatchBytes: 4096, maxChangedPaths: 5 },
    },
    allowedDiagnosticChecks:
      context.planApplicability === 'pre-plan-diagnostic' &&
      context.action.kind === 'run_command' &&
      context.checkId &&
      context.testPath &&
      context.diagnosticPurpose &&
      context.taskCriteriaDigest &&
      context.checkSetDigest
        ? [
            {
              checkId: context.checkId,
              testPath: context.testPath,
              diagnosticPurpose: context.diagnosticPurpose,
              taskCriteriaDigest: context.taskCriteriaDigest,
              checkSetDigest: context.checkSetDigest,
              action: context.action,
            },
          ]
        : [],
    allowedDiagnosticTestPaths: context.planApplicability === 'pre-plan-diagnostic' && context.testPath ? [context.testPath] : [],
  };
}

// shortcut: the trusted admission is derived from the caller's own context, so this re-establishes
// structural integrity, not independent owner trust. Swap in an owner-issued trusted context when
// production gains one; the validators stay unchanged.
export function admissionValid(context: AdmissionContextV02): boolean {
  try {
    return validateAdmissionV02(context, deriveTrustedContext(context)).ok;
  } catch {
    return false;
  }
}

export function planDigest(task: TaskState): string | undefined {
  const plan = task.plan;
  if (!plan) return undefined;
  return computeCanonicalSha256({
    taskId: task.taskId,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef,
    evidenceRefs: plan.evidenceRefs,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: plan.checkSetDigest,
    decisionRef: plan.decisionRef,
  });
}

export function taskSemantic(task: TaskState): Record<string, unknown> {
  const clone = structuredClone(task) as unknown as Record<string, unknown>;
  delete clone['stateVersion'];
  delete clone['budgetLedgers'];
  return clone;
}

export function observedPatchTaskState(task: TaskState, invalidatedEvidence: readonly SafeReferenceV02[], revisionDigest: string, repairPatch: boolean, ledgers: readonly BudgetLedger[]): TaskState {
  const invalidated = new Set(invalidatedEvidence.map(reference => reference.reference));
  return {
    ...task,
    ...(repairPatch ? { node: 'Verify' as TaskState['node'] } : {}),
    stateVersion: task.stateVersion + 1,
    repositoryRevisionDigest: revisionDigest,
    evidenceRefs: task.evidenceRefs.filter(reference => !invalidated.has(reference)),
    activeDecisionId: undefined,
    reviewRefs: [],
    latestReviewRef: undefined,
    budgetLedgers: [...ledgers],
  };
}

export function validExecutorIdentity(value: unknown): value is ExecutorIdentityV02 {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 4 &&
    Object.keys(record).every(key => ['adapterIdentity', 'processIncarnation', 'fencingGeneration', 'payloadDigest'].includes(key)) &&
    typeof record['adapterIdentity'] === 'string' &&
    !!record['adapterIdentity'].trim() &&
    typeof record['processIncarnation'] === 'string' &&
    !!record['processIncarnation'].trim() &&
    Number.isSafeInteger(record['fencingGeneration']) &&
    Number(record['fencingGeneration']) > 0 &&
    typeof record['payloadDigest'] === 'string' &&
    SHA256.test(record['payloadDigest'])
  );
}

export function safeRef(ref: SafeReferenceV02): boolean {
  return Boolean(ref && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(ref.reference) && SHA256.test(ref.digest));
}

/** Re-checks a stored task against the admission it claims to serve. */
export function contextMatchesTask(context: AdmissionContextV02, task: TaskState): boolean {
  if (!admissionValid(context) || task.taskId !== context.taskId || task.runId !== context.runId || task.stateVersion !== context.expectedTaskStateVersion || task.node !== context.runnableNode)
    return false;
  if (
    context.subjectKind === 'repository-action' &&
    (task.workspaceId !== context.workspaceId || task.repositoryId !== context.repositoryId || task.repositoryRevisionDigest !== context.canonicalRevision)
  )
    return false;
  if (context.planApplicability === 'pre-plan-diagnostic') {
    if (task.node !== 'Investigate' || task.plan !== undefined || task.activeDecisionId !== undefined) return false;
  } else if (!task.plan || task.plan.decisionRef !== context.planDecisionRef || task.activeDecisionId !== context.planDecisionRef || planDigest(task) !== context.planBindingDigest) return false;
  return true;
}

export function taskMatchesAttempt(claim: { readonly taskSnapshot: TaskState }, task: TaskState, repairPatch: boolean, expectedRevision?: string): boolean {
  const expected: TaskState = {
    ...structuredClone(claim.taskSnapshot),
    ...(repairPatch ? { node: 'Patch' as TaskState['node'] } : {}),
    ...(expectedRevision !== undefined ? { repositoryRevisionDigest: expectedRevision } : {}),
  };
  return equal(taskSemantic(task), taskSemantic(expected));
}

export { validateTaskState };
