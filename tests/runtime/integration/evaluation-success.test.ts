/**
 * First-case proof surface: the operator CLI over the real workflow runner and a real graph-backed driver.
 *
 * C02 (expected wait satisfied) and C01 (unresolved wait) are separate CLI invocations on purpose:
 * combined they only ever show `incomplete`. Suite acceptance still counts all 17 required cases.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  computeRequestContentDigest,
  type ApprovalBinding,
  type ApprovalBindingContext,
  type ContextualApprovalVerifierV02,
  type PolicyAuthorityRefV02,
  type ProviderAdmissionContextV02,
  type ProviderRequest,
  type ReviewResult,
  type SourceEvidence,
  type ClaimReceiptV02,
  type StateTransitionOptions,
  type TaskState,
} from '../../../src/contracts/foundation/uc03.ts';
import { createExecutionGuardV02 } from '../../../src/foundation/execution-guard.ts';
import type { UC03GraphConfig, UC03GraphPorts } from '../../../src/uc03/graph-types.ts';
import type { BaselineEvidenceAcknowledgement, BaselineEvidenceWriteRequest, BaselineEvidenceWriter, TrustedHostExpectedContext, TrustedHostPort } from '../../../src/uc03/investigation.ts';
import type { CatalogEntry } from '../../../src/runtime/evaluation-profile.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { createWorkflowDriver, type WorkflowCaseHost } from '../../../eval/uc03/workflow-driver.ts';
import { runEvaluateCli } from '../../../src/cli/evaluate.ts';
import { createFixtureBugTask, createFixtureCheckDefinition, createFixtureExecutorIdentityV02, createFixturePolicyAuthorityRefV02 } from '../support/uc03/port-fixtures.ts';
import { createGraphRepositoryPort, createGraphTaskState, seedGraphTaskState } from '../support/uc03/graph-fixtures.ts';
import { createTestApprovalBinding, createTestProviderOutcomeReceiptV02, createTestRepositoryCommandAdmissionContextV02 } from '../support/uc03/state-fixtures.ts';
import { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';
import { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import { ScriptedApprovalPort } from '../support/uc03/scripted-approval.ts';
import { ScriptedModelPort } from '../support/uc03/scripted-model.ts';

const digest = (seed: string): string => sha256Text(seed);

/* ------------------------------------------------------------------
 * Controlled route (copied from tests/runtime/unit/workflow-evaluation.test.ts:51-305)
 * ------------------------------------------------------------------ */

const ROUTE_PLAN_DETAILS = {
  diagnosis: 'The divide implementation lacks a zero denominator guard.',
  strategy: 'Reject a zero denominator before division.',
  suspectedCauseLocations: ['src/calculator.py'],
  scopedChanges: ['src/calculator.py'],
  decisionRef: 'decision-route-test-001',
} as const;

function createMockHostAuthority(expectedTestFileContent = 'def test_divide(): pass\n'): TrustedHostPort {
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

function createMockBaselineEvidenceWriter(): BaselineEvidenceWriter {
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

function createContextualApprovalPort(initialBinding: ApprovalBinding, currentContext: ApprovalBindingContext, authorityRef: PolicyAuthorityRefV02) {
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
    getRecordedBindings: () => issuer.getRecordedBindings(),
    setV02AuthorityRef: (authority: PolicyAuthorityRefV02 | undefined) => issuer.setV02AuthorityRef(authority),
    resolvePlanDecisionInContext: (decisionId: string, context: Parameters<ContextualApprovalVerifierV02['resolvePlanDecisionInContext']>[1]) =>
      issuer.resolvePlanDecisionInContext(decisionId, context),
  };
}

function createControllableReviewerPort(repositoryPort: FakeRepositoryPort, statePort: MemoryStatePortV02) {
  return {
    provenance: 'mock' as const,
    async review(
      task: Parameters<UC03GraphPorts['reviewerPort']['review']>[0],
      diff: string,
      _evidence: readonly SourceEvidence[],
      request: ProviderRequest,
      admission: ProviderAdmissionContextV02,
      claim: ClaimReceiptV02,
    ): Promise<ReviewResult> {
      const attempt = await statePort.beginAttempt(claim.claimId, createFixtureExecutorIdentityV02({ payloadDigest: computeRequestContentDigest(request) }));
      const outcome = await statePort.recordOutcome(createTestProviderOutcomeReceiptV02(claim, attempt, admission));
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

function createPlanApprovalContext(task: Parameters<typeof createGraphTaskState>[0]) {
  const state = createGraphTaskState(task);
  const baselineRef = `uc04://baseline/${task.taskId}/1`;
  const evidenceRefs = [baselineRef];
  const checkSetDigest = computeCheckSetDigest(task.requiredChecks);
  const strategyDigest = computeCanonicalSha256(ROUTE_PLAN_DETAILS.strategy);
  const action = { actionId: ROUTE_PLAN_DETAILS.decisionRef, kind: 'approve_fix_plan' as const, planVersion: state.planVersion, strategyDigest, diagnosisEvidenceRefs: evidenceRefs, checkSetDigest };
  const binding = createTestApprovalBinding({
    decisionId: ROUTE_PLAN_DETAILS.decisionRef,
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

function createResourceReservationRefs(actionId: string): readonly string[] {
  const kinds = ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'] as const;
  return (['task', 'run'] as const).flatMap(scope => kinds.map(kind => `${scope}:${kind}:${actionId}`));
}

function createPlanBindingDigest(task: Parameters<typeof createGraphTaskState>[0], state: TaskState): string {
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

/** Controlled route: the plan approval is pending, so the route stops at AwaitPlan. */
function createPendingApprovalRoute() {
  const checkRepro = createFixtureCheckDefinition({
    checkId: 'check-pytest-reproduction',
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
  const transitionContexts = createPlanApprovalContext(task);
  const planApproval = transitionContexts[3]?.approval;
  assert.ok(planApproval);
  const approvalPort = createContextualApprovalPort({ ...(planApproval.binding as ApprovalBinding), status: 'pending' }, planApproval.freshness, authorityRef);
  const statePort = new MemoryStatePortV02({ transitionContexts, initialAuthorityRef: authorityRef, verificationApprovalVerifier: approvalPort });
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
  repositoryPort.setTestResult('check-pytest-reproduction', { checkId: 'check-pytest-reproduction', outcome: 'pass', outputExcerpt: '1 passed', durationMs: 100 });
  repositoryPort.setTestResult('check-pytest-regression', { checkId: 'check-pytest-regression', outcome: 'pass', outputExcerpt: '1 passed', durationMs: 100 });
  const ownerSettledRepositoryPort = createGraphRepositoryPort(repositoryPort, statePort);
  const executionGuard = createExecutionGuardV02({ ports: { statePort, repositoryPort: ownerSettledRepositoryPort, approvalPort } });
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
  const ports: UC03GraphPorts = {
    statePort: statePort.getUnderlying(),
    approvalPort,
    repositoryPort: ownerSettledRepositoryPort,
    modelPort: new ScriptedModelPort(),
    reviewerPort: createControllableReviewerPort(repositoryPort, statePort),
    hostAuthority: createMockHostAuthority(),
    baselineEvidenceWriter: createMockBaselineEvidenceWriter(),
    executionGuard,
  };
  const config: UC03GraphConfig = { mode: 'development', trustedExpectedContext, planDetails: ROUTE_PLAN_DETAILS };
  return { task, ports, statePort, config };
}

/* ------------------------------------------------------------------
 * Host binding and driver
 * ------------------------------------------------------------------ */

function catalogEntryFor(caseId: string, task: { initialRevisionDigest: string }, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    catalogEntryId: `entry-${caseId}`,
    caseId,
    version: '1.0.0',
    caseDigest: digest(`case-${caseId}`),
    publicTaskDigest: digest(`task-${caseId}`),
    initialRepositoryDigest: task.initialRevisionDigest,
    fixturePath: 'C:/host-only/fixture.json',
    fixtureDigest: digest(`fixture-${caseId}`),
    grader: { version: '1.0.0', digest: digest(`grader-${caseId}`), path: 'C:/host-only/grader.json' },
    ...overrides,
  };
}

const HOST_OPTIONS = {
  profileDigest: digest('profile'),
  configDigest: digest('config'),
  pricingDigest: digest('pricing'),
  adapterVersions: ['uc03-adapter-1'],
  requestedModel: 'deepseek-v4.1',
} as const;

interface CliOutput {
  readonly exitCode: number;
  readonly selectionResult: { readonly outcome: string; readonly passed: number; readonly failed: number; readonly incomplete: number; readonly pendingWaits: readonly string[] };
  readonly suiteAcceptance: { readonly scope: string; readonly requiredCases: number; readonly satisfiedCases: number; readonly outcome: string };
  readonly cases: readonly { readonly caseId: string; readonly grade: string; readonly gradeReason: string; readonly taskId: string | null; readonly workflowOutcome: string }[];
  readonly limitations: readonly string[];
  readonly mode: string;
  readonly tier: string;
  readonly isRealVerified: boolean;
}

function parseOutput(output: string): CliOutput {
  const json = output.slice(0, output.indexOf('\nUC-03 Workflow Evaluation'));
  return JSON.parse(json) as CliOutput;
}

test('C02 expected wait: exit 0 and a selected pass while the suite stays incomplete over 17 required cases', async () => {
  const route = createPendingApprovalRoute();
  const needsInfoTask = { ...route.task, reproduction: '' };
  const host: WorkflowCaseHost = { entry: catalogEntryFor('C02', route.task), task: needsInfoTask, ports: route.ports, expectedWait: 'waiting-info', config: route.config };

  const result = await runEvaluateCli(['--mode', 'mock', '--cases', 'C02'], { ...HOST_OPTIONS, driver: createWorkflowDriver(new Map([['C02', host]])) });
  const report = parseOutput(result.output);

  assert.equal(result.exitCode, 0);
  assert.equal(report.mode, 'mock');
  assert.equal(report.tier, 'controlled');
  assert.equal(report.isRealVerified, false);
  assert.equal(report.selectionResult.outcome, 'pass');
  assert.equal(report.selectionResult.passed, 1);
  // The decisive pair: the case passed, the catalog did not.
  assert.deepEqual(report.suiteAcceptance, { scope: 'catalog', requiredCases: 17, satisfiedCases: 1, outcome: 'incomplete' });
  const [observed] = report.cases;
  assert.ok(observed);
  assert.equal(observed.caseId, 'C02');
  assert.equal(observed.grade, 'pass');
  assert.equal(observed.gradeReason, 'expected-wait-satisfied');
  assert.equal(observed.workflowOutcome, 'waiting-info');
  // Pause proof: a needs-info intake allocates no task.
  assert.equal(observed.taskId, null);
  assert.match(result.output, /UC-03 Workflow Evaluation \[MOCK\]: Selected = pass, Suite = incomplete, ExitCode = 0/);
  assert.equal(result.output.includes('C:/host-only'), false);
});

test('C01 unresolved wait: exit 3 with the case pending in the catalog suite', async () => {
  const route = createPendingApprovalRoute();
  await seedGraphTaskState(route.statePort, createGraphTaskState(route.task));
  const host: WorkflowCaseHost = { entry: catalogEntryFor('C01', route.task), task: route.task, ports: route.ports, expectedWait: null, config: route.config };

  const result = await runEvaluateCli(['--mode', 'mock', '--cases', 'C01'], { ...HOST_OPTIONS, driver: createWorkflowDriver(new Map([['C01', host]])) });
  const report = parseOutput(result.output);

  assert.equal(result.exitCode, 3);
  assert.equal(report.selectionResult.outcome, 'incomplete');
  assert.deepEqual(report.selectionResult.pendingWaits, ['C01']);
  assert.equal(report.cases[0]?.grade, 'not-run');
  assert.equal(report.cases[0]?.gradeReason, 'unresolved-wait');
  assert.equal(report.cases[0]?.workflowOutcome, 'waiting-approval');
  assert.equal(report.suiteAcceptance.outcome, 'incomplete');
  assert.equal(report.suiteAcceptance.satisfiedCases, 0);
  assert.match(result.output, /ExitCode = 3/);
});

/** A blocked precondition was never dispatched, so it is ungraded (not-run), never a pass. */
test('blocked driver entry never grades as a pass and never leaks a host path', async () => {
  const route = createPendingApprovalRoute();
  const host: WorkflowCaseHost = {
    entry: catalogEntryFor('C01', route.task, { caseDigest: 'not-a-digest' }),
    task: route.task,
    ports: route.ports,
    expectedWait: null,
    config: route.config,
  };

  const result = await runEvaluateCli(['--mode', 'mock', '--cases', 'C01'], { ...HOST_OPTIONS, driver: createWorkflowDriver(new Map([['C01', host]])) });

  assert.equal(result.output.includes('C:/host-only'), false);
  assert.equal(result.output.includes('EVALUATION_REFUSED'), false);
  assert.equal(result.exitCode, 4);
  const report = parseOutput(result.output);
  assert.equal(report.cases[0]?.grade, 'not-run');
  assert.equal(report.cases[0]?.gradeReason, 'prerequisite-unavailable');
  assert.equal(report.selectionResult.outcome, 'incomplete');
});

test('host binding digests reach the report unchanged; no real-tier claim is made', async () => {
  const route = createPendingApprovalRoute();
  const needsInfoTask = { ...route.task, reproduction: '' };
  const host: WorkflowCaseHost = { entry: catalogEntryFor('C02', route.task), task: needsInfoTask, ports: route.ports, expectedWait: 'waiting-info', config: route.config };

  const result = await runEvaluateCli(['--cases', 'C02'], { ...HOST_OPTIONS, driver: createWorkflowDriver(new Map([['C02', host]])) });
  const report = parseOutput(result.output) as CliOutput & { readonly configDigest: string };

  assert.equal(result.exitCode, 0);
  assert.equal(report.mode, 'mock');
  assert.equal(report.configDigest, HOST_OPTIONS.configDigest);
  assert.equal(report.isRealVerified, false);
});
