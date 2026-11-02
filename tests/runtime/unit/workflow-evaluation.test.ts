/**
 * UC-03 workflow evaluation - graph-backed driver, registration and evaluation service.
 *
 * Drives the real `runUC03Graph` route with the controlled fixtures in tests/runtime/support/uc03;
 * no CaseResult is fabricated and nothing leaves the process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { admitEvaluationProfile, type CatalogEntry, type EvaluationProfile } from '../../../src/runtime/evaluation-profile.ts';
import { createEvaluationService, type ServiceControlReceipt } from '../../../src/runtime/evaluation-service.ts';
import { canonicalDigest, sha256Text } from '../../../src/uc01/contracts.ts';
import { createWorkflowDriver, type WorkflowCaseHost } from '../../../eval/uc03/workflow-driver.ts';
import { registerUC03WorkflowEvaluation } from '../../../eval/uc03/registration.ts';
import { validateWorkflowObservation } from '../../../eval/uc03/validation.ts';
import type { EvaluationCaseSpec, WorkflowCaseContext } from '../../../eval/uc03/types.ts';
import { createFixtureBugTask, createFixtureCheckDefinition, createFixtureExecutorIdentityV02, createFixturePolicyAuthorityRefV02 } from '../support/uc03/port-fixtures.ts';
import { createGraphRepositoryPort, createGraphTaskState, seedGraphTaskState } from '../support/uc03/graph-fixtures.ts';
import { createTestApprovalBinding, createTestProviderOutcomeReceiptV02, createTestRepositoryCommandAdmissionContextV02 } from '../support/uc03/state-fixtures.ts';
import { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';
import { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import { ScriptedApprovalPort } from '../support/uc03/scripted-approval.ts';
import { ScriptedModelPort } from '../support/uc03/scripted-model.ts';

const digest = (seed: string): string => sha256Text(seed);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/* ------------------------------------------------------------------
 * Controlled route fixtures (subset of tests/runtime/unit/uc03-graph.test.ts)
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
 * Driver
 * ------------------------------------------------------------------ */

const observationContext = (caseId: string): WorkflowCaseContext => ({
  spec: { caseId, name: 'case', description: 'case', category: 'success', required: true, expectedOutcome: 'COMPLETED', requirements: ['FR-001'] } as EvaluationCaseSpec,
  mode: 'mock',
  tier: 'controlled',
  manifestDigest: digest('manifest'),
  configDigest: digest('config'),
  profileDigest: digest('profile'),
  pricingDigest: digest('pricing'),
  adapterVersions: ['adapter@1'],
  requestedModel: 'deepseek-v4.1',
});

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

test('driver maps a paused real graph route to a validated waiting-approval observation', async () => {
  const route = createPendingApprovalRoute();
  await seedGraphTaskState(route.statePort, createGraphTaskState(route.task));
  const host: WorkflowCaseHost = { entry: catalogEntryFor('C01', route.task), task: route.task, ports: route.ports, expectedWait: 'waiting-approval', config: route.config };
  const driver = createWorkflowDriver(new Map([['C01', host]]));

  const observation = validateWorkflowObservation(await driver.executeCase(observationContext('C01').spec, observationContext('C01')));

  assert.equal(observation.workflowOutcome, 'waiting-approval');
  assert.equal(observation.expectedWait, 'waiting-approval');
  assert.equal(observation.blocked, null);
  assert.equal(observation.effects, 'observed');
  assert.equal(observation.taskId, route.task.taskId);
  assert.ok(observation.runId !== null && ID.test(observation.runId));
  assert.deepEqual(Object.keys(observation).sort(), [
    'artifacts',
    'blocked',
    'diagnostic',
    'effects',
    'expectedWait',
    'graderDigest',
    'limitations',
    'repositoryId',
    'returnedModel',
    'runId',
    'taskId',
    'usage',
    'workflowOutcome',
  ]);
  assert.equal(JSON.stringify(observation).includes('C:/host-only'), false);
});

test('driver maps a needs-info intake task to waiting-info without allocating a task', async () => {
  const route = createPendingApprovalRoute();
  const needsInfoTask = { ...route.task, reproduction: '' };
  const driver = createWorkflowDriver(new Map([['C02', { entry: catalogEntryFor('C02', route.task), task: needsInfoTask, ports: route.ports, expectedWait: 'waiting-info', config: route.config }]]));

  const observation = validateWorkflowObservation(await driver.executeCase(observationContext('C02').spec, observationContext('C02')));

  assert.equal(observation.workflowOutcome, 'waiting-info');
  assert.equal(observation.expectedWait, 'waiting-info');
  assert.equal(observation.taskId, null);
  assert.equal(observation.runId, null);
});

test('driver blocks before dispatch on an unknown case or a missing pinned digest', async () => {
  const route = createPendingApprovalRoute();
  const calls: string[] = [];
  const statePort = { ...route.ports.statePort, loadTask: async (taskId: string) => (calls.push(taskId), Promise.resolve(null)) };
  const ports = { ...route.ports, statePort } as UC03GraphPorts;
  const driver = createWorkflowDriver(new Map([['C03', { entry: catalogEntryFor('C03', route.task, { caseDigest: 'not-a-digest' }), task: route.task, ports, expectedWait: null }]]));

  const missingDigest = await driver.executeCase(observationContext('C03').spec, observationContext('C03'));
  const unknownCase = await driver.executeCase(observationContext('C04').spec, observationContext('C04'));

  assert.equal((missingDigest as { blocked: string }).blocked, 'prerequisite-unavailable');
  assert.equal((missingDigest as { effects: string }).effects, 'none');
  assert.equal((unknownCase as { blocked: string }).blocked, 'prerequisite-unavailable');
  assert.deepEqual(calls, []);
});

test('observation validation rejects an extra key', async () => {
  const route = createPendingApprovalRoute();
  await seedGraphTaskState(route.statePort, createGraphTaskState(route.task));
  const driver = createWorkflowDriver(new Map([['C01', { entry: catalogEntryFor('C01', route.task), task: route.task, ports: route.ports, expectedWait: 'waiting-approval', config: route.config }]]));
  const observation = await driver.executeCase(observationContext('C01').spec, observationContext('C01'));

  assert.throws(() => validateWorkflowObservation({ ...(observation as object), extra: true }));
});

/* ------------------------------------------------------------------
 * Registration
 * ------------------------------------------------------------------ */

test('registration pins UC-03 public payload digests and never scores', () => {
  const spec = (caseId: string, category: string) => ({
    caseId,
    name: `case ${caseId}`,
    description: 'public case',
    category,
    required: true,
    expectedOutcome: 'INCOMPLETE',
    requirements: ['FR-001'],
  });
  const registered = registerUC03WorkflowEvaluation([spec('C01', 'success'), spec('C06', 'test-protection')]);

  assert.equal(registered.ucId, 'UC-03');
  assert.equal(registered.provenance, 'mock');
  assert.deepEqual(
    registered.cases.map(item => item.caseId),
    ['UC-03:C01', 'UC-03:C06'],
  );
  for (const item of registered.cases) {
    assert.equal(item.gate, 'hard');
    assert.equal(item.classificationScored, false);
    assert.equal(item.digestProfile, 'canonical-json-v1');
    assert.equal(item.caseDigest, canonicalDigest('PublicCase', item.payload));
  }
  assert.throws(() => registerUC03WorkflowEvaluation([spec('C99', 'success')]));
  assert.throws(() => registerUC03WorkflowEvaluation([spec('C01', 'success'), spec('C01', 'success')]));
});

/* ------------------------------------------------------------------
 * Service
 * ------------------------------------------------------------------ */

const fixtureDir = mkdtempSync(join(tmpdir(), 'uc03-workflow-evaluation-'));
writeFileSync(join(fixtureDir, 'case-001.json'), '{}', 'utf8');
writeFileSync(join(fixtureDir, 'case-001.grader.json'), '{}', 'utf8');

const catalogEntry: CatalogEntry = {
  catalogEntryId: 'entry-case-001',
  caseId: 'case-001',
  version: '1.0.0',
  caseDigest: digest('case-case-001'),
  publicTaskDigest: digest('task-case-001'),
  initialRepositoryDigest: digest('repo-case-001'),
  fixturePath: join(fixtureDir, 'case-001.json'),
  fixtureDigest: digest('fixture-case-001'),
  grader: { version: '1.0.0', digest: digest('grader-case-001'), path: join(fixtureDir, 'case-001.grader.json') },
};
const catalog = [catalogEntry] as const;

const rawProfile = (): Record<string, unknown> => ({
  endpoint: 'https://api.deepseek.com/v1/messages',
  model: 'deepseek-v4.1',
  mode: 'nonstreaming',
  credentialRef: 'host-deepseek-key',
  codeDigest: digest('code'),
  configDigest: digest('config'),
  imageDigest: `sha256:${digest('image')}`,
  platform: 'linux/amd64',
  adapterVersions: ['uc03-adapter@1'],
  pricing: { pricingId: 'deepseek-pin-v1', inputRate: 270, outputRate: 1100, cacheRate: 27, overheadRate: 10, denominator: 1 },
  limits: {
    totalModelCalls: 24,
    inputTokensPerRequest: 32768,
    outputTokensPerRequest: 8192,
    providerTimeoutMs: 60000,
    activeExecutionMs: 900000,
    repairs: 2,
    reviewerIterations: 2,
    materialReplans: 3,
    commandTimeoutMs: 30000,
    outputBytes: 1048576,
    memoryBytes: 2147483648,
    cpus: 2,
    processes: 64,
  },
  catalog,
});

function admittedProfile(): EvaluationProfile {
  const admitted = admitEvaluationProfile(rawProfile());
  assert.ok(admitted.ok, admitted.ok ? '' : admitted.reasonCode);
  return admitted.value;
}

const completeBugSource = {
  kind: 'bug',
  repositoryId: 'repo-configured',
  checkSetId: 'checks-configured',
  bugInput: {
    goal: 'Fix division',
    observedBehavior: 'ZeroDivisionError',
    expectedBehavior: 'Return an error',
    reproduction: 'pytest -q tests/test_calculator.py',
    acceptanceCriteria: ['No ZeroDivisionError'],
  },
};
const needsInfoBugSource = { ...completeBugSource, bugInput: { ...completeBugSource.bugInput, reproduction: '' } };
const catalogSource = { kind: 'catalog', caseIds: ['case-001'] };

interface GraphCalls {
  readonly run: number;
  readonly portsFor: number;
}

function createService(overrides: Partial<Parameters<typeof createEvaluationService>[0]> = {}): { service: ReturnType<typeof createEvaluationService>; calls: GraphCalls } {
  const calls = { run: 0, portsFor: 0 };
  const controlReceipts: ServiceControlReceipt[] = [];
  const service = createEvaluationService({
    profile: admittedProfile(),
    catalog,
    repositoryIds: ['repo-configured'],
    checkSetIds: ['checks-configured'],
    control: {
      issue: input => {
        const receipt = { receiptRef: `ctrl-${controlReceipts.length + 1}-${input.kind}`, kind: input.kind, taskId: 'task-001', controlVersion: 7 };
        controlReceipts.push(receipt);
        return receipt;
      },
    },
    graph: {
      portsFor: () => {
        calls.portsFor += 1;
        return { ports: 'host-only' };
      },
      run: async () => {
        calls.run += 1;
        return { outcome: 'pending-approval', state: { taskId: 'task-001', runId: 'run-001', workspaceId: 'ws-001' }, usage: { tokensConsumed: 10, costUsd: 0.01 } };
      },
    },
    now: () => '2026-11-02T00:00:00.000Z',
    ids: () => 'exp-001',
    ...overrides,
  });
  return { service, calls };
}

test('service blocks an unadmitted profile and unknown ids before any graph call', async () => {
  const { service, calls } = createService({ profile: rawProfile() });
  const blocked = await service.startExperiment({ source: catalogSource, profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-1' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok ? '' : blocked.reasonCode, 'NOT_ADMITTED');
  assert.deepEqual(calls, { run: 0, portsFor: 0 });

  const unknownRepo = await createService().service.startExperiment({
    source: { ...completeBugSource, repositoryId: 'repo-unknown' },
    profileId: 'uc03-runtime-evaluation-v1',
    idempotencyKey: 'key-2',
  });
  assert.equal(unknownRepo.ok ? '' : unknownRepo.reasonCode, 'UNCONFIGURED_REPOSITORY');
  const unknownChecks = await createService().service.startExperiment({
    source: { ...completeBugSource, checkSetId: 'checks-unknown' },
    profileId: 'uc03-runtime-evaluation-v1',
    idempotencyKey: 'key-3',
  });
  assert.equal(unknownChecks.ok ? '' : unknownChecks.reasonCode, 'UNCONFIGURED_CHECK_SET');
  const unknownCase = await createService().service.startExperiment({ source: { kind: 'catalog', caseIds: ['case-999'] }, profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-4' });
  assert.equal(unknownCase.ok ? '' : unknownCase.reasonCode, 'UNKNOWN_CASE');
});

test('service resolves catalog bindings, executes them, and keeps custom submissions ungraded', async () => {
  const { service, calls } = createService();
  const catalogStart = await service.startExperiment({ source: catalogSource, profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-catalog' });
  assert.ok(catalogStart.ok);
  assert.equal(catalogStart.value.experiment.graded, true);
  assert.equal(catalogStart.value.experiment.scope, 'catalog');
  assert.equal(catalogStart.value.experiment.status, 'waiting-approval');
  assert.equal(catalogStart.value.experiment.taskId, 'task-001');
  assert.deepEqual(calls, { run: 1, portsFor: 1 });
  assert.deepEqual(
    catalogStart.value.experiment.bindings.map(binding => binding.catalogEntryId),
    ['entry-case-001'],
  );

  const { service: customService, calls: customCalls } = createService({ ids: () => 'exp-002' });
  const customStart = await customService.startExperiment({ source: completeBugSource, profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-custom' });
  assert.ok(customStart.ok);
  assert.equal(customStart.value.experiment.graded, false);
  assert.equal(customStart.value.experiment.scope, 'exploratory');
  assert.deepEqual(customStart.value.experiment.bindings, []);
  assert.deepEqual(customCalls, { run: 1, portsFor: 1 });
});

test('service returns the original receipt for a duplicate key and denies stale or conflicting replay', async () => {
  const { service, calls } = createService();
  const first = await service.startExperiment({ source: catalogSource, profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-dup' });
  assert.ok(first.ok);
  const runsAfterFirst = calls.run;

  const duplicate = await service.startExperiment({ source: catalogSource, profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-dup' });
  assert.ok(duplicate.ok);
  assert.equal(duplicate.value.receipt, first.value.receipt);
  assert.equal(calls.run, runsAfterFirst);

  const conflicting = await service.startExperiment({ source: { kind: 'catalog', caseIds: ['case-001'] }, profileId: 'other-profile', idempotencyKey: 'key-dup' });
  assert.equal(conflicting.ok ? '' : conflicting.reasonCode, 'CONFLICTING_REPLAY');

  const stale = await service.answerClarification({ id: 'exp-001', questionId: 'q-reproduction', questionDigest: digest('q'), expectedVersion: 99, answers: ['answer'], idempotencyKey: 'key-answer' });
  assert.equal(stale.ok ? '' : stale.reasonCode, 'STALE_VERSION');
});

test('service persists needs-info submissions with bound questions and answers never resume', async () => {
  const { service, calls } = createService();
  const started = await service.startExperiment({ source: needsInfoBugSource, profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-needs-info' });
  assert.ok(started.ok);
  const experiment = started.value.experiment;
  assert.equal(experiment.status, 'waiting-info');
  assert.equal(experiment.taskId, null);
  assert.equal(experiment.runId, null);
  assert.equal(experiment.workspaceId, null);
  assert.equal(experiment.graded, false);
  assert.deepEqual(calls, { run: 0, portsFor: 0 });
  const question = experiment.submission?.questions.find(item => item.questionId === 'q-reproduction');
  assert.ok(question);
  assert.ok(question.questionDigest.length === 64);

  const answered = await service.answerClarification({
    id: experiment.id,
    questionId: question.questionId,
    questionDigest: question.questionDigest,
    expectedVersion: experiment.version,
    answers: ['pytest -q tests/test_calculator.py'],
    idempotencyKey: 'key-answer-1',
  });
  assert.ok(answered.ok);
  assert.equal(answered.value.experiment.status, 'waiting-info');
  assert.equal(answered.value.experiment.taskId, null);
  assert.equal(answered.value.experiment.answers.length, 1);
  assert.equal(answered.value.experiment.answers[0]?.questionDigest, question.questionDigest);
  assert.deepEqual(calls, { run: 0, portsFor: 0 });

  const direction = await service.issueDirection({ id: experiment.id, expectedTaskVersion: 0, expectedControlVersion: 0, kind: 'resume', idempotencyKey: 'key-direction-intake' });
  assert.equal(direction.ok ? '' : direction.reasonCode, 'INCOMPLETE_INTAKE');

  const ended = await service.issueDirection({ id: experiment.id, expectedTaskVersion: 0, expectedControlVersion: 0, kind: 'end', idempotencyKey: 'key-end-intake' });
  assert.ok(ended.ok);
  assert.equal(ended.value.experiment.status, 'incomplete');
  assert.equal(ended.value.experiment.version, experiment.version + 2);
  assert.ok('receiptId' in ended.value.receipt);
  assert.equal(ended.value.receipt.receiptId, `rcpt-direction-${experiment.id}-${ended.value.experiment.version}`);
  assert.equal(ended.value.receipt.kind, 'direction');
  assert.deepEqual(calls, { run: 0, portsFor: 0 });

  const replayed = await service.issueDirection({ id: experiment.id, expectedTaskVersion: 0, expectedControlVersion: 0, kind: 'end', idempotencyKey: 'key-end-intake' });
  assert.ok(replayed.ok);
  assert.equal(replayed.value.receipt, ended.value.receipt);
  assert.equal(replayed.value.experiment.status, 'incomplete');

  const next = await service.startExperiment({ source: needsInfoBugSource, profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-needs-info-2' });
  assert.ok(next.ok);
  assert.equal(next.value.experiment.status, 'waiting-info');
});

test('service allows one active experiment and forwards directions to control', async () => {
  const { service } = createService();
  const first = await service.startExperiment({ source: catalogSource, profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-active-1' });
  assert.ok(first.ok);
  const busy = await service.startExperiment({ source: catalogSource, profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-active-2' });
  assert.equal(busy.ok, false);
  assert.equal(busy.ok ? '' : busy.status, 'busy');

  const direction = await service.issueDirection({ id: first.value.experiment.id, expectedTaskVersion: 1, expectedControlVersion: 1, kind: 'resume', idempotencyKey: 'key-dir-1' });
  assert.ok(direction.ok);
  assert.equal(direction.value.receipt.kind, 'resume');

  const continuation = await service.continueExperiment({
    id: first.value.experiment.id,
    expectedVersion: direction.value.experiment.version,
    directionRef: direction.value.receipt.receiptRef,
    idempotencyKey: 'key-continue-1',
  });
  assert.ok(continuation.ok);
  assert.equal(continuation.value.experiment.taskId, 'task-001');

  const unknownDirection = await service.continueExperiment({
    id: first.value.experiment.id,
    expectedVersion: continuation.value.experiment.version,
    directionRef: 'ctrl-unknown',
    idempotencyKey: 'key-continue-2',
  });
  assert.equal(unknownDirection.ok ? '' : unknownDirection.reasonCode, 'UNKNOWN_DIRECTION');
});
