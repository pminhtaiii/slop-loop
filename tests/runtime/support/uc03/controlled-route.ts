/**
 * Controlled UC-03 route harness shared by the integration witnesses.
 *
 * The plan approval starts pending, so the route parks at AwaitPlan and every witness observes a
 * stable, repeatable stop. Ports are the mock fixtures; nothing here dispatches to a provider.
 */

import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  computeRequestContentDigest,
  type ApprovalBinding,
  type ApprovalBindingContext,
  type ApprovalPort,
  type BugTask,
  type ContextualApprovalVerifierV02,
  type PolicyAuthorityRefV02,
  type PermissionClass,
  type ProviderAdmissionContextV02,
  type ProviderRequest,
  type ReviewResult,
  type SourceEvidence,
  type ClaimReceiptV02,
  type StateTransitionOptions,
  type TaskState,
} from '../../../../src/contracts/foundation/uc03.ts';
import { createExecutionGuardV02 } from '../../../../src/foundation/execution-guard.ts';
import type { UC03GraphConfig, UC03GraphPorts, UC03ReviewerPort } from '../../../../src/uc03/graph-types.ts';
import type { BaselineEvidenceAcknowledgement, BaselineEvidenceWriteRequest, BaselineEvidenceWriter, TrustedHostExpectedContext, TrustedHostPort } from '../../../../src/uc03/investigation.ts';
import { createFixtureBugTask, createFixtureCheckDefinition, createFixtureExecutorIdentityV02, createFixturePolicyAuthorityRefV02 } from './port-fixtures.ts';
import { createGraphRepositoryPort, createGraphTaskState } from './graph-fixtures.ts';
import { createTestApprovalBinding, createTestProviderOutcomeReceiptV02, createTestRepositoryCommandAdmissionContextV02 } from './state-fixtures.ts';
import { FakeRepositoryPort } from './fake-repository.ts';
import { MemoryStatePortV02 } from './memory-state.ts';
import { ScriptedApprovalPort } from './scripted-approval.ts';
import { ScriptedModelPort } from './scripted-model.ts';

export const ROUTE_PLAN_DETAILS = {
  diagnosis: 'The divide implementation lacks a zero denominator guard.',
  strategy: 'Reject a zero denominator before division.',
  suspectedCauseLocations: ['src/calculator.py'],
  scopedChanges: ['src/calculator.py'],
  decisionRef: 'decision-route-test-001',
} as const;

export function createMockHostAuthority(expectedTestFileContent = 'def test_divide(): pass\n'): TrustedHostPort {
  return {
    async loadSnapshot(request) {
      return {
        taskId: request.taskId,
        workspaceId: request.workspaceId,
        repositoryId: request.repositoryId,
        currentRevision: request.expectedRevisionDigest,
        checkSetDigest: request.expectedCheckSetDigest,
        testFiles: [{ path: 'tests/test_calculator.py', content: expectedTestFileContent }],
        expectedTestFiles: request.expectedTestFiles,
      };
    },
  };
}

export function createMockBaselineEvidenceWriter(): BaselineEvidenceWriter {
  const records = new Map<string, { readonly content: BaselineEvidenceWriteRequest['content']; readonly acknowledgement: BaselineEvidenceAcknowledgement }>();
  return {
    async persistBaselineEvidence(request) {
      const { content } = request;
      const acknowledgement: BaselineEvidenceAcknowledgement = {
        evidenceId: `uc04://baseline/${content.taskId}/1`,
        taskId: content.taskId,
        workspaceId: content.workspaceId,
        repositoryId: content.repositoryId,
        contentDigest: request.contentDigest,
        repositorySnapshotDigest: content.repositorySnapshotDigest,
        criteriaDigest: content.criteriaDigest,
        checkSetDigest: content.checkSetDigest,
        testProtectionDigest: content.testProtectionDigest,
        reproductionCheckId: content.reproductionCheckId,
        expectedPassingCheckIds: content.expectedPassingCheckIds,
        expectedTestFiles: content.expectedTestFiles,
        requiredCheckIds: content.requiredChecks.map(check => check.checkId),
      };
      records.set(acknowledgement.evidenceId, { content: structuredClone(content), acknowledgement: structuredClone(acknowledgement) });
      return acknowledgement;
    },
    async loadBaselineEvidence(_taskId, _workspaceId, _repositoryId, evidenceId) {
      const stored = records.get(evidenceId);
      return stored?.acknowledgement ? structuredClone(stored.content) : null;
    },
  } as BaselineEvidenceWriter;
}

type RouteApprovalPort = ApprovalPort &
  ContextualApprovalVerifierV02 & {
    readonly provenance: 'mock';
    setDecision(status: ApprovalBinding['status']): void;
    scriptDecision(binding: ApprovalBinding): void;
    /** Repair admits through the route's classifier, which leaves unknown actions at APPROVAL_REQUIRED. */
    scriptClassification(actionIdOrKind: string, permission: PermissionClass): void;
    getRecordedBindings(): readonly ApprovalBinding[];
    setV02AuthorityRef(authority: PolicyAuthorityRefV02 | undefined): void;
  };

export function createContextualApprovalPort(initialBinding: ApprovalBinding, currentContext: ApprovalBindingContext, authorityRef: PolicyAuthorityRefV02): RouteApprovalPort {
  const issuer = new ScriptedApprovalPort({ decisions: [initialBinding], currentContext, v02AuthorityRef: authorityRef });
  return {
    provenance: 'mock' as const,
    setDecision(status: ApprovalBinding['status']) {
      issuer.scriptDecision({ ...(issuer.getRecordedBindings().at(-1) ?? initialBinding), status });
    },
    classify: (action: Parameters<ScriptedApprovalPort['classify']>[0]) => issuer.classify(action),
    requestDecision: (binding: ApprovalBinding) => issuer.requestDecision(binding),
    validateBinding: (binding: ApprovalBinding) => issuer.validateBinding(binding),
    resolve: (decisionId: string) => issuer.resolve(decisionId),
    scriptDecision: (binding: ApprovalBinding) => issuer.scriptDecision(binding),
    scriptClassification: (actionIdOrKind: string, permission: PermissionClass) => issuer.scriptClassification(actionIdOrKind, permission),
    getRecordedBindings: () => issuer.getRecordedBindings(),
    setV02AuthorityRef: (authority: PolicyAuthorityRefV02 | undefined) => issuer.setV02AuthorityRef(authority),
    resolvePlanDecisionInContext: (decisionId: string, context: Parameters<ContextualApprovalVerifierV02['resolvePlanDecisionInContext']>[1]) =>
      issuer.resolvePlanDecisionInContext(decisionId, context),
  };
}

export function createControllableReviewerPort(repositoryPort: FakeRepositoryPort, statePort: MemoryStatePortV02): UC03ReviewerPort {
  return {
    provenance: 'mock' as const,
    async review(
      task: Parameters<UC03GraphPorts['reviewerPort']['review']>[0],
      diff: string,
      _evidence: readonly SourceEvidence[],
      request: ProviderRequest,
      admission: ProviderAdmissionContextV02,
      claim?: ClaimReceiptV02,
    ): Promise<ReviewResult> {
      const effectiveClaim = claim ?? (await statePort.claim(admission));
      const attempt = await statePort.beginAttempt(effectiveClaim.claimId, createFixtureExecutorIdentityV02({ payloadDigest: computeRequestContentDigest(request) }));
      const outcome = await statePort.recordOutcome(createTestProviderOutcomeReceiptV02(effectiveClaim, attempt, admission));
      if (outcome.outcome !== 'settled') throw new Error('Persisted reviewer allowance did not settle');
      return {
        reviewId: `review-${request.providerRequestId}`,
        status: 'accepted',
        repoDigest: repositoryPort.currentRevision,
        diffDigest: computeCanonicalSha256(diff || ''),
        checkSetDigest: computeCheckSetDigest(task.requiredChecks),
        reviewerRoleConfigId: admission.providerIdentity.configId,
        iterationReservationRef: request.reservationRef,
        findings: [],
      };
    },
  };
}

export function createPlanApprovalContext(
  task: Parameters<typeof createGraphTaskState>[0],
  decisionRef: string = ROUTE_PLAN_DETAILS.decisionRef,
): Readonly<Record<number, NonNullable<StateTransitionOptions['trusted']>>> {
  const state = createGraphTaskState(task);
  const baselineRef = `uc04://baseline/${task.taskId}/1`;
  const evidenceRefs = [baselineRef];
  const checkSetDigest = computeCheckSetDigest(task.requiredChecks);
  const strategyDigest = computeCanonicalSha256(ROUTE_PLAN_DETAILS.strategy);
  const action = { actionId: decisionRef, kind: 'approve_fix_plan' as const, planVersion: state.planVersion, strategyDigest, diagnosisEvidenceRefs: evidenceRefs, checkSetDigest };
  const binding = createTestApprovalBinding({
    decisionId: decisionRef,
    actionKind: 'fix_plan',
    normalizedActionDigest: computeCanonicalSha256(action),
    taskId: task.taskId,
    workspaceId: state.workspaceId,
    repositoryRevisionDigest: task.initialRevisionDigest,
    policyId: task.configId,
    policyVersion: task.configVersion,
    planVersion: state.planVersion,
    strategyDigest,
    baselineRef,
    evidenceRefs,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest,
    status: 'approved',
  });
  const freshness = {
    currentTaskId: task.taskId,
    currentWorkspaceId: state.workspaceId,
    currentRepositoryRevisionDigest: task.initialRevisionDigest,
    currentPolicyId: task.configId,
    currentPolicyVersion: task.configVersion,
    currentNormalizedActionDigest: computeCanonicalSha256(action),
    currentPlanVersion: state.planVersion,
    currentStrategyDigest: strategyDigest,
    currentBaselineRef: baselineRef,
    currentEvidenceRefs: evidenceRefs,
    currentCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    currentCheckSetDigest: checkSetDigest,
  };
  return { 3: { approval: { binding, freshness } } } as Readonly<Record<number, NonNullable<StateTransitionOptions['trusted']>>>;
}

export function createResourceReservationRefs(actionId: string): readonly string[] {
  const kinds = ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'] as const;
  return (['task', 'run'] as const).flatMap(scope => kinds.map(kind => `${scope}:${kind}:${actionId}`));
}

export function createPlanBindingDigest(task: Parameters<typeof createGraphTaskState>[0], state: TaskState): string {
  const plan = state.plan;
  if (!plan?.decisionRef) return '';
  return computeCanonicalSha256({
    taskId: state.taskId,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef ?? '',
    evidenceRefs: plan.evidenceRefs ?? [],
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: plan.checkSetDigest,
    decisionRef: plan.decisionRef,
  });
}

/** Controlled route. A pending plan approval parks the route at AwaitPlan; `approved` lets it run on. */
export function createPendingApprovalRoute(
  initialDecision: 'approved' | 'pending' | 'rejected' = 'pending',
  decisionRef: string = ROUTE_PLAN_DETAILS.decisionRef,
  extraTransitionContexts: Readonly<Record<number, NonNullable<StateTransitionOptions['trusted']>>> = {},
  reproductionCheckId = 'check-pytest-reproduction',
): {
  readonly task: BugTask;
  readonly ports: UC03GraphPorts;
  readonly statePort: MemoryStatePortV02;
  readonly config: UC03GraphConfig;
  readonly approvalPort: RouteApprovalPort;
  readonly repositoryPort: FakeRepositoryPort;
  readonly patchFailureReasons: string[];
  readonly hostAuthority: TrustedHostPort;
} {
  const checkRepro = createFixtureCheckDefinition({
    checkId: reproductionCheckId,
    executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py', '-k', 'test_divide_zero'],
    purpose: 'reproduction',
  });
  const checkRegression = createFixtureCheckDefinition({ checkId: 'check-pytest-regression', executable: 'pytest', argv: ['-q', 'tests/test_calculator.py'], purpose: 'regression' });
  const task = createFixtureBugTask({ requiredChecks: [checkRepro, checkRegression] });
  const authorityRef = createFixturePolicyAuthorityRefV02({
    policyId: task.configId,
    policyVersion: task.configVersion,
    configId: task.configId,
    configVersion: task.configVersion,
    decisionAuthorityGeneration: 3,
  });
  const transitionContexts = createPlanApprovalContext(task, decisionRef);
  const planApproval = transitionContexts[3]?.approval;
  if (!planApproval) throw new Error('Plan approval fixture is missing its transition context');
  const approvalPort = createContextualApprovalPort({ ...(planApproval.binding as ApprovalBinding), status: initialDecision }, planApproval.freshness, authorityRef);
  const autoApprovingPort = approvalPort;
  const statePort = new MemoryStatePortV02({
    transitionContexts: { ...transitionContexts, ...extraTransitionContexts },
    initialAuthorityRef: authorityRef,
    verificationApprovalVerifier: autoApprovingPort,
  });
  const repositoryPort = new FakeRepositoryPort({
    initialRevision: task.initialRevisionDigest,
    initialFiles: { 'tests/test_calculator.py': 'def test_divide(): pass\n', 'src/calculator.py': 'def divide(a, b): return a / b\n' },
    commandResults: {
      'pytest -q tests/test_calculator.py -k test_divide_zero': { exitCode: 1, stdout: 'FAILED tests/test_calculator.py::test_divide_zero - ZeroDivisionError', stderr: '' },
      'pytest -q tests/test_calculator.py': { exitCode: 0, stdout: '1 passed', stderr: '' },
      default: { exitCode: 0, stdout: '1 passed', stderr: '' },
    },
  });
  repositoryPort.setStatePort(statePort);
  repositoryPort.setTestResult(reproductionCheckId, { checkId: reproductionCheckId, outcome: 'pass', outputExcerpt: '1 passed', durationMs: 100 });
  repositoryPort.setTestResult('check-pytest-regression', { checkId: 'check-pytest-regression', outcome: 'pass', outputExcerpt: '1 passed', durationMs: 100 });
  const patchFailureReasons: string[] = [];
  const ownerSettledRepositoryPort = createGraphRepositoryPort(repositoryPort, statePort, reason => patchFailureReasons.push(reason));
  const executionGuard = createExecutionGuardV02({ ports: { statePort, repositoryPort: ownerSettledRepositoryPort, approvalPort: autoApprovingPort } });
  const trustedExpectedContext = {
    taskId: task.taskId,
    workspaceId: createGraphTaskState(task).workspaceId,
    repositoryId: task.repositoryId,
    revisionDigest: task.initialRevisionDigest,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    expectedTestFiles: ['tests/test_calculator.py'],
    executionGuard,
    statePort,
    admissionContextForCheck: async ({ check, action, currentState }: Parameters<NonNullable<TrustedHostExpectedContext['admissionContextForCheck']>>[0]) => {
      const ownerAuthority = await statePort.readVerificationAuthoritySnapshot(currentState.taskId);
      if (!ownerAuthority) return undefined;
      const isVerify = currentState.node === 'Verify';
      const journal = statePort.getJournalSnapshot();
      const planBindingDigest = isVerify ? createPlanBindingDigest(task, currentState) : undefined;
      const context = createTestRepositoryCommandAdmissionContextV02({
        taskId: currentState.taskId,
        runId: currentState.runId,
        workspaceId: currentState.workspaceId,
        repositoryId: currentState.repositoryId,
        canonicalRevision: currentState.repositoryRevisionDigest,
        expectedTaskStateVersion: currentState.stateVersion,
        expectedControlVersion: journal.controlVersion,
        expectedEpoch: journal.epoch,
        policyAuthorityRef: { ...ownerAuthority.policyIdentity, decisionAuthorityGeneration: ownerAuthority.decisionAuthorityGeneration },
        action,
        reservationRefs: createResourceReservationRefs(action.actionId),
        runnableNode: isVerify ? 'Verify' : 'Investigate',
        planApplicability: isVerify ? 'approved-plan' : 'pre-plan-diagnostic',
        taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
        checkSetDigest: computeCheckSetDigest(task.requiredChecks),
        checkId: check.checkId,
        testPath: 'tests/test_calculator.py',
        ...(isVerify ? { planBindingDigest, planDecisionRef: currentState.plan?.decisionRef } : { planBindingDigest: undefined, planDecisionRef: undefined, diagnosticPurpose: check.purpose }),
      });
      repositoryPort.setExecutorIdentity(createFixtureExecutorIdentityV02({ payloadDigest: computeCanonicalSha256(action) }));
      return context;
    },
  };
  const hostAuthority = createMockHostAuthority();
  const ports: UC03GraphPorts = {
    statePort: statePort.getUnderlying(),
    approvalPort: autoApprovingPort,
    repositoryPort: ownerSettledRepositoryPort,
    modelPort: new ScriptedModelPort(),
    reviewerPort: createControllableReviewerPort(repositoryPort, statePort),
    hostAuthority,
    baselineEvidenceWriter: createMockBaselineEvidenceWriter(),
    executionGuard,
  };
  const planDetails = { ...ROUTE_PLAN_DETAILS, decisionRef };
  const config: UC03GraphConfig = {
    mode: 'development',
    trustedExpectedContext,
    planDetails,
  };
  return { task, ports, statePort, config, approvalPort: autoApprovingPort, repositoryPort, patchFailureReasons, hostAuthority };
}
