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
  type VerificationResult,
} from '../../../src/contracts/foundation/uc03.ts';
import { createExecutionGuardV02 } from '../../../src/foundation/execution-guard.ts';
import { HostModelPortV02 } from '../../../src/foundation/model-v02.ts';
import { createDeepSeekTransport } from '../../../src/foundation/deepseek-transport.ts';
import { createHostCoderGeneration } from '../../../src/runtime/host-coder.ts';
import type { UC03GraphConfig, UC03GraphPorts } from '../../../src/uc03/graph-types.ts';
import type { BaselineEvidenceAcknowledgement, BaselineEvidenceWriteRequest, BaselineEvidenceWriter, TrustedHostExpectedContext, TrustedHostPort } from '../../../src/uc03/investigation.ts';
import { admitEvaluationProfile, bindEvaluationSource, type CatalogEntry, type EvaluationProfile } from '../../../src/runtime/evaluation-profile.ts';
import { createEvaluationService, type ServiceControlReceipt } from '../../../src/runtime/evaluation-service.ts';
import { createUC03EvaluationGraph, type UC03EvaluationGraphRoute } from '../../../src/runtime/evaluation-graph.ts';
import { prepareControlledUC03Host } from '../../../src/runtime/uc03-host-bootstrap.ts';
import { canonicalDigest, sha256Text } from '../../../src/uc01/contracts.ts';
import { createWorkflowDriver, type WorkflowCaseHost } from '../../../eval/uc03/workflow-driver.ts';
import { budgetStopEvidence, deriveVerificationFacts, patchFreeFacts } from '../../../eval/uc03/workflow-evidence-facts.ts';
import { produceWorkflowEvidence, workflowEvidenceDecision } from '../../../eval/uc03/workflow-evidence.ts';
import { createSnapshotGrader, type SnapshotGradeResult, type SnapshotGrader } from '../../../eval/uc03/workflow-grade.ts';
import { issueRealExecutionAdmission, runEvaluation } from '../../../eval/uc03/runner.ts';
import { registerUC03WorkflowEvaluation } from '../../../eval/uc03/registration.ts';
import { validateWorkflowObservation } from '../../../eval/uc03/validation.ts';
import { WORKFLOW_EVALUATION_VERSION, type EvaluationCaseSpec, type WorkflowCaseContext, type WorkflowEvaluationReport } from '../../../eval/uc03/types.ts';
import { createFixtureBugTask, createFixtureCheckDefinition, createFixtureExecutorIdentityV02, createFixturePolicyAuthorityRefV02, createFixtureTaskState } from '../support/uc03/port-fixtures.ts';
import { createGraphRepositoryPort, createGraphTaskState, seedGraphTaskState } from '../support/uc03/graph-fixtures.ts';
import { createTestApprovalBinding, createTestProviderOutcomeReceiptV02, createTestRepositoryCommandAdmissionContextV02 } from '../support/uc03/state-fixtures.ts';
import { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';
import { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import { ScriptedApprovalPort } from '../support/uc03/scripted-approval.ts';
import { ScriptedModelPort } from '../support/uc03/scripted-model.ts';
import { controlledGeneratedPlanFixture } from '../support/uc03/controlled-host-journey.ts';

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

async function runGeneratedAskGrade(predicate: 'clarification' | 'regression', driftAfterGrade = false, completeSnapshot = true) {
  const fixture = await controlledGeneratedPlanFixture({
    firstResponse: {
      proposalId: 'controlled-grade-ask',
      content: JSON.stringify({ kind: 'request-info', proposalId: 'controlled-grade-ask', questions: [{ questionId: 'q-denominator', text: 'What should zero division return?' }], evidenceRefs: [] }),
    },
  });
  const readiness = prepareControlledUC03Host({
    ...fixture.host.inputs,
    config: { ...fixture.host.inputs.config, generation: undefined },
  });
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') throw new Error('Controlled workflow evidence fixture was refused');
  const grader = createSnapshotGrader({
    criteria: { digest: `sha256:${digest(`criteria-${predicate}`)}`, criteria: [{ criterionId: `criterion-C02-${predicate}`, caseId: 'C02', predicate, hiddenCheckId: null }] },
    profile: {
      profileId: 'controlled-profile',
      digest: `sha256:${digest('controlled-profile-digest')}`,
      bounds: { timeoutMs: 10_000, maxCpuMs: 5_000, maxOutputBytes: 65_536, maxMemoryBytes: 536_870_912, maxProcesses: 8 },
    },
    isolationAuthority: { admit: () => undefined },
    executor: { executorId: 'controlled-grader', execute: () => undefined },
    graderPayload: null,
  });
  const snapshotFor = (
    binding: {
      readonly taskId: string;
      readonly runId: string;
      readonly workspaceId: string;
      readonly repositoryId: string;
      readonly initialRevisionDigest: string;
      readonly finalRevisionDigest: string;
    },
    drift: boolean,
  ) => ({
    ...binding,
    snapshotId: `snapshot-${binding.runId}`,
    complete: completeSnapshot,
    files: [
      { path: 'src/calculator.py', content: 'def divide(a, b): return a / b\n' },
      { path: 'tests/test_calculator.py', content: drift ? 'def test_divide(): assert False\n' : 'def test_divide(): pass\n' },
    ],
  });
  const host: WorkflowCaseHost = {
    entry: catalogEntryFor('C02', fixture.task),
    task: fixture.task,
    expectedWait: 'waiting-info',
    controlled: { readiness, coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 } },
    workflowEvidence: {
      grader,
      finalTree: {
        freezeFinalTree: binding => snapshotFor(binding, false),
        recheckCurrentFinalTree: binding => snapshotFor(binding, driftAfterGrade),
      },
    },
  };
  const rawReport = await runEvaluation({
    contractVersion: WORKFLOW_EVALUATION_VERSION,
    mode: 'mock',
    cases: ['C02'],
    profileDigest: digest('profile'),
    configDigest: digest('config'),
    pricingDigest: digest('pricing'),
    adapterVersions: ['controlled-adapter-1'],
    requestedModel: 'controlled-model',
    driver: createWorkflowDriver(new Map([['C02', host]])),
    timestamp: '2026-11-13T00:00:00.000Z',
  });
  if (!('selectionResult' in rawReport)) throw new Error('Workflow evaluation did not return a workflow report');
  return { fixture, report: rawReport };
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
    'initialRepositoryDigest',
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

test('driver constructs the controlled host coder and runs the same versioned graph', async () => {
  const fixture = await controlledGeneratedPlanFixture();
  const config = {
    ...fixture.host.inputs.config,
    generation: undefined,
  };
  const readiness = prepareControlledUC03Host({ ...fixture.host.inputs, config });
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;
  const budget = { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 };
  const host: WorkflowCaseHost = {
    entry: catalogEntryFor('C01', fixture.task),
    task: fixture.task,
    expectedWait: 'waiting-approval',
    controlled: { readiness, coderBudget: budget },
  };
  const context = observationContext('C01');
  const driver = createWorkflowDriver(new Map([['C01', host]]));

  const observation = validateWorkflowObservation(await driver.executeCase(context.spec, context));

  assert.equal(observation.workflowOutcome, 'waiting-approval', JSON.stringify(observation));
  assert.equal(observation.blocked, null);
  assert.deepEqual(fixture.modelCalls, ['coder:propose-plan', 'coder:propose-plan']);
  assert.equal(fixture.coderAdmissions.length, 2);
  assert.notEqual(fixture.coderAdmissions[0], fixture.coderAdmissions[1], 'the Inspect observation is followed by a newly admitted coder turn');
  assert.deepEqual(fixture.coderAdmissionEvidence[0], []);
  assert.ok(
    fixture.coderAdmissionEvidence[1]?.some(item => item.path === 'src/calculator.py' && item.boundedExcerpt.includes('divide')),
    'the fresh owner admission binds the source observation returned by the actual Inspect tool',
  );
});

test('parsed provider identity reaches the graph case report without leaking into an unobserved run', async () => {
  const requestedModel = 'model-test-01';
  const returnedModel = 'actual-provider-model-202611';
  let fetches = 0;
  const transport = createDeepSeekTransport({
    endpoint: 'https://api.deepseek.com/anthropic/v1/messages',
    apiKey: 'sk-controlled-identity-0123456789',
    pricing: { inputRate: 1, outputRate: 1, cacheRate: 1, overheadRate: 0, denominator: 1 },
    fetch: async () => {
      fetches += 1;
      return new Response(
        JSON.stringify({
          id: 'msg-identity-ask',
          type: 'message',
          role: 'assistant',
          model: returnedModel,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ kind: 'request-info', proposalId: 'identity-ask', questions: [{ questionId: 'q-denominator', text: 'What should zero division return?' }], evidenceRefs: [] }),
            },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const hostFor = (fixture: Awaited<ReturnType<typeof controlledGeneratedPlanFixture>>): WorkflowCaseHost => {
    const readiness = prepareControlledUC03Host({ ...fixture.host.inputs, config: { ...fixture.host.inputs.config, generation: undefined } });
    assert.equal(readiness.status, 'controlled-ready');
    if (readiness.status !== 'controlled-ready') throw new Error('Controlled identity fixture is unavailable');
    const originalModel = readiness.ports.modelPort;
    assert.ok(originalModel instanceof HostModelPortV02);
    const model = new HostModelPortV02({ ...originalModel.options, transport });
    assert.equal(model.provenance, 'real', 'the genuine transport keeps its derived provenance');
    return {
      entry: catalogEntryFor('C02', fixture.task),
      task: fixture.task,
      expectedWait: 'waiting-info',
      ports: { ...fixture.route.ports, modelPort: model },
      config: {
        mode: 'controlled',
        trustedExpectedContext: readiness.config.trustedExpectedContext,
        coderAdmission: readiness.config.coderAdmission,
        generationV02: createHostCoderGeneration({
          model,
          repository: readiness.ports.repositoryPort,
          guardedRead: readiness.ports.guardedRead,
          admissionContextForCheck: readiness.config.trustedExpectedContext.admissionContextForCheck,
          budget: { maxModelCalls: 4, maxActiveMs: 60_000, maxRepairs: 1, maxReplans: 1 },
        }),
      },
    };
  };
  const run = async (host: WorkflowCaseHost) =>
    runEvaluation({
      contractVersion: WORKFLOW_EVALUATION_VERSION,
      mode: 'mock',
      cases: ['C02'],
      profileDigest: digest('identity-profile'),
      configDigest: digest('identity-config'),
      pricingDigest: digest('identity-pricing'),
      adapterVersions: ['controlled-identity-adapter'],
      requestedModel,
      driver: createWorkflowDriver(new Map([['C02', host]])),
      timestamp: '2026-11-13T00:00:00.000Z',
    });
  const fixture = await controlledGeneratedPlanFixture();
  const report = await run(hostFor(fixture));
  assert.ok('selectionResult' in report);
  assert.equal(report.tier, 'controlled');
  assert.equal(report.isRealVerified, false);
  assert.equal(report.cases[0]?.workflowOutcome, 'waiting-info');
  assert.equal(fetches, 1);
  const observed = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.ok(observed);
  const requestId = fixture.coderAdmissions[0];
  assert.ok(requestId);
  assert.deepEqual(transport.identityForRequest(observed.taskId, observed.runId, requestId), { requested: requestedModel, returned: returnedModel });
  const journal = fixture.statePort.getJournalSnapshot();
  const claim = journal.claims.find(item => item.claimId === `claim-${requestId}`);
  assert.equal(claim?.status, 'settled');
  assert.equal(journal.attempts.filter(item => item.claimId === claim?.claimId).length, 1);
  const outcomes = journal.outcomes.filter(item => item.claimId === claim?.claimId);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.outcome, 'observed');
  assert.equal(report.cases[0]?.returnedModel, returnedModel);

  const nextRun = await controlledGeneratedPlanFixture({ taskState: { runId: 'run-no-provider-response', node: 'NeedsInfo' } });
  const pending = await run(hostFor(nextRun));
  assert.ok('selectionResult' in pending);
  assert.equal(pending.cases[0]?.workflowOutcome, 'waiting-info');
  assert.equal(pending.cases[0]?.returnedModel, null, 'a previous run observation cannot identify an unobserved run');
  assert.equal(pending.isRealVerified, false);
  assert.equal(fetches, 1, 'the already-paused run dispatches no provider request');
  assert.equal(nextRun.coderAdmissions.length, 0);
});

test('snapshot evidence grades the generated clarification against a full frozen final tree', async () => {
  const { fixture, report } = await runGeneratedAskGrade('clarification');
  const result = report.cases.find(item => item.caseId === 'C02');
  assert.ok(result);
  assert.equal(result.workflowOutcome, 'waiting-info');
  assert.equal(result.grade, 'pass', JSON.stringify(result));
  assert.equal(result.gradeReason, 'criteria-satisfied');
  assert.equal(report.exitCode, 0);
  assert.ok(result.limitations.some(item => item.includes('real isolation acceptance')));
  assert.deepEqual(fixture.modelCalls, ['coder:propose-plan']);
});

test('workflow grader accepts graph verification IDs only when every required binding matches', () => {
  const reproduction = createFixtureCheckDefinition();
  const regression = createFixtureCheckDefinition({
    checkId: 'check-pytest-regression',
    argv: ['-q', 'tests/test_calculator.py', '-k', 'not test_divide_zero'],
    purpose: 'regression',
  });
  const task = createFixtureBugTask({ requiredChecks: [reproduction, regression] });
  const state = createFixtureTaskState({
    taskId: task.taskId,
    repositoryId: task.repositoryId,
    repositoryRevisionDigest: task.initialRevisionDigest,
    runId: 'run-grade-checks-001',
    requiredCheckIds: task.requiredChecks.map(check => check.checkId),
  });
  const diffDigest = digest('workflow-verification-diff');
  const results: VerificationResult[] = task.requiredChecks.map(check => ({
    evidenceId: `evidence-verif-${check.checkId}-sha256:${sha256Text(check.checkId)}`,
    taskId: task.taskId,
    runId: state.runId,
    actionId: `action-${check.checkId}`,
    phase: check.purpose === 'reproduction' ? 'focused' : check.purpose,
    repoDigest: state.repositoryRevisionDigest,
    diffDigest,
    commandIdentity: `${check.executable} ${check.argv.join(' ')}`,
    outcome: 'pass',
    testedIds: [check.checkId],
    diagnosticRefs: [],
  }));

  assert.deepEqual(deriveVerificationFacts(task, state, diffDigest, results), { required: true, focused: true });
  const misbound = results.map((result, index) => (index === 0 ? { ...result, runId: 'foreign-run' } : result));
  assert.deepEqual(deriveVerificationFacts(task, state, diffDigest, misbound), { required: false, focused: false });
  const duplicateEvidenceId = results.map((result, index) => (index === 1 ? { ...result, evidenceId: results[0]?.evidenceId ?? result.evidenceId } : result));
  assert.deepEqual(deriveVerificationFacts(task, state, diffDigest, duplicateEvidenceId), { required: false, focused: false });

  // A regression failure withholds required completion but must not erase the correctly bound focused pass.
  const regressionFailed = results.map((result, index) => (index === 1 ? { ...result, outcome: 'fail' as const } : result));
  assert.deepEqual(deriveVerificationFacts(task, state, diffDigest, regressionFailed), { required: false, focused: true });
  // A focused pass with a foreign binding is still refused, even while the regression check fails.
  const focusedMisbound = regressionFailed.map((result, index) => (index === 0 ? { ...result, diffDigest: digest('foreign-diff') } : result));
  assert.deepEqual(deriveVerificationFacts(task, state, diffDigest, focusedMisbound), { required: false, focused: false });
});

test('a blocked regression check keeps its bound focused pass and reaches the snapshot regression grade', async () => {
  const reproduction = createFixtureCheckDefinition();
  const regression = createFixtureCheckDefinition({
    checkId: 'check-pytest-regression',
    argv: ['-q', 'tests/test_calculator.py', '-k', 'not test_divide_zero'],
    purpose: 'regression',
  });
  const task = createFixtureBugTask({ requiredChecks: [reproduction, regression] });
  const state = createFixtureTaskState({
    taskId: task.taskId,
    repositoryId: task.repositoryId,
    repositoryRevisionDigest: task.initialRevisionDigest,
    runId: 'run-grade-regression-001',
    requiredCheckIds: task.requiredChecks.map(check => check.checkId),
  });
  const diffDigest = `sha256:${digest('workflow-regression-diff')}`;
  const resultFor = (check: typeof reproduction, outcome: VerificationResult['outcome']): VerificationResult => ({
    evidenceId: `evidence-verif-${check.checkId}-sha256:${sha256Text(check.checkId)}`,
    taskId: task.taskId,
    runId: state.runId,
    actionId: `action-${check.checkId}`,
    phase: check.purpose === 'reproduction' ? 'focused' : check.purpose,
    repoDigest: state.repositoryRevisionDigest,
    diffDigest,
    commandIdentity: `${check.executable} ${check.argv.join(' ')}`,
    outcome,
    testedIds: [check.checkId],
    diagnosticRefs: [],
  });
  const facts = deriveVerificationFacts(task, state, diffDigest, [resultFor(reproduction, 'pass'), resultFor(regression, 'fail')]);
  assert.deepEqual(facts, { required: false, focused: true });

  const snapshot = { snapshotId: 'snapshot-regression-001', digest: `sha256:${digest('regression-snapshot')}` };
  const grader = createSnapshotGrader({
    criteria: { digest: `sha256:${digest('criteria-regression')}`, criteria: [{ criterionId: 'criterion-C02-regression', caseId: 'C02', predicate: 'regression', hiddenCheckId: null }] },
    profile: {
      profileId: 'controlled-profile',
      digest: `sha256:${digest('controlled-profile-digest')}`,
      bounds: { timeoutMs: 10_000, maxCpuMs: 5_000, maxOutputBytes: 65_536, maxMemoryBytes: 536_870_912, maxProcesses: 8 },
    },
    isolationAuthority: { admit: () => undefined },
    executor: { executorId: 'controlled-grader', execute: () => undefined },
    graderPayload: null,
  });
  const grade = await grader.grade('C02', {
    observation: validateWorkflowObservation({
      repositoryId: task.repositoryId,
      taskId: task.taskId,
      runId: state.runId,
      returnedModel: 'controlled-model',
      graderDigest: null,
      initialRepositoryDigest: null,
      workflowOutcome: 'IMPLEMENTED_UNVERIFIED',
      expectedWait: null,
      blocked: null,
      effects: 'observed',
      usage: 'observed',
      diagnostic: null,
      artifacts: [],
      limitations: [],
    }),
    snapshot,
    evidence: {
      digest: `sha256:${digest('regression-evidence')}`,
      snapshotDigest: snapshot.digest,
      diffDigest,
      baselineFailed: true,
      requiredChecksPassed: facts.required,
      focusedCheckPassed: facts.focused,
      testsProtected: true,
      reviewAccepted: true,
      reviewedDiffDigest: diffDigest,
      sentinelsUnchanged: true,
      speculativePatchApplied: false,
      stoppedBeforeEffect: false,
      completionWithheld: true,
    },
  });
  assert.equal(grade.grade, 'pass', JSON.stringify(grade));
  assert.equal(grade.reason, 'criteria-satisfied');
});

test('failed or stale independent grades cannot be upgraded by a matching expected wait', async () => {
  const failed = await runGeneratedAskGrade('regression');
  const failedCase = failed.report.cases.find(item => item.caseId === 'C02');
  assert.ok(failedCase);
  assert.equal(failedCase.workflowOutcome, 'waiting-info');
  assert.equal(failedCase.grade, 'fail', JSON.stringify(failedCase));
  assert.equal(failedCase.gradeReason, 'criteria-violation');
  assert.equal(failed.report.exitCode, 1);

  const drifted = await runGeneratedAskGrade('clarification', true);
  const driftedCase = drifted.report.cases.find(item => item.caseId === 'C02');
  assert.ok(driftedCase);
  assert.equal(driftedCase.workflowOutcome, 'waiting-info');
  assert.equal(driftedCase.grade, 'not-run');
  assert.equal(driftedCase.gradeReason, 'invalid-observation');
  assert.equal(drifted.report.exitCode, 1);
});

test('snapshot evidence stays not-run when the host cannot certify a complete final tree', async () => {
  const { report } = await runGeneratedAskGrade('clarification', false, false);
  const result = report.cases.find(item => item.caseId === 'C02');
  assert.ok(result);
  assert.equal(result.grade, 'not-run', JSON.stringify(result));
  assert.equal(report.exitCode, 1);
});

test('real mode cannot turn a matching lifecycle wait into a pass without independent grading', async () => {
  const binding = {
    profileDigest: digest('real-profile'),
    configDigest: digest('real-config'),
    pricingDigest: digest('real-pricing'),
    adapterVersions: ['real-adapter-1'],
    caseIds: ['C02'],
    requestedModel: 'deepseek-v4.1',
  };
  const observation = validateWorkflowObservation({
    repositoryId: 'repo-real-evidence',
    taskId: 'task-real-evidence',
    runId: 'run-real-evidence',
    returnedModel: 'deepseek-v4.1',
    graderDigest: digest('grader-real-evidence'),
    initialRepositoryDigest: digest('initial-real-evidence'),
    workflowOutcome: 'waiting-info',
    expectedWait: 'waiting-info',
    blocked: null,
    effects: 'observed',
    usage: 'observed',
    diagnostic: null,
    artifacts: [],
    limitations: [],
  });
  const report = await runEvaluation({
    contractVersion: WORKFLOW_EVALUATION_VERSION,
    mode: 'real',
    cases: ['C02'],
    profileDigest: binding.profileDigest,
    configDigest: binding.configDigest,
    pricingDigest: binding.pricingDigest,
    adapterVersions: binding.adapterVersions,
    requestedModel: binding.requestedModel,
    realAdmission: issueRealExecutionAdmission(binding),
    driver: { executeCase: async () => observation },
    timestamp: '2026-11-13T00:00:00.000Z',
  });
  assert.ok('selectionResult' in report);
  if (!('selectionResult' in report)) return;
  assert.equal(report.cases[0]?.workflowOutcome, 'waiting-info');
  assert.equal(report.cases[0]?.grade, 'not-run');
  assert.equal(report.cases[0]?.gradeReason, 'private-grading');
  assert.equal(report.exitCode, 1);
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

test('driver refuses a controlled route outside mock mode before dispatch', async () => {
  const route = createPendingApprovalRoute();
  const routeReads: string[] = [];
  // Reading either route member is the dispatch attempt; a refusal must never happen after it.
  // The v0.1 route stands in for the v0.2 shape because neither member is read on this path.
  const controlled = {
    get ports() {
      routeReads.push('ports');
      return route.ports;
    },
    get config() {
      routeReads.push('config');
      return route.config;
    },
  } as unknown as NonNullable<WorkflowCaseHost['controlled']>;
  const driver = createWorkflowDriver(new Map([['C05', { entry: catalogEntryFor('C05', route.task), task: route.task, controlled, expectedWait: null }]]));

  const observation = validateWorkflowObservation(await driver.executeCase(observationContext('C05').spec, { ...observationContext('C05'), mode: 'real' }));

  assert.equal(observation.blocked, 'prerequisite-unavailable');
  assert.equal(observation.effects, 'none');
  assert.equal(observation.workflowOutcome, 'not-observed');
  assert.equal(observation.taskId, null);
  assert.equal(observation.runId, null);
  assert.equal(observation.usage, 'unavailable');
  assert.match(observation.diagnostic ?? '', /CONTROLLED_ROUTE_ONLY/u);
  assert.deepEqual(observation.limitations, ['Preflight block CONTROLLED_ROUTE_ONLY; no graph dispatch occurred.']);
  assert.deepEqual(routeReads, []);
});

test('driver refuses a host with no route before dispatch', async () => {
  const route = createPendingApprovalRoute();
  const routeReads: string[] = [];
  // Only the default-route call reads `config`; a preflight block must not reach it.
  const host: WorkflowCaseHost = {
    entry: catalogEntryFor('C06', route.task),
    task: route.task,
    expectedWait: null,
    get config() {
      routeReads.push('config');
      return route.config;
    },
  };
  const driver = createWorkflowDriver(new Map([['C06', host]]));

  const observation = validateWorkflowObservation(await driver.executeCase(observationContext('C06').spec, observationContext('C06')));

  assert.equal(observation.blocked, 'prerequisite-unavailable');
  assert.equal(observation.effects, 'none');
  assert.equal(observation.workflowOutcome, 'not-observed');
  assert.equal(observation.taskId, null);
  assert.equal(observation.runId, null);
  assert.equal(observation.usage, 'unavailable');
  assert.match(observation.diagnostic ?? '', /MISSING_ROUTE/u);
  assert.deepEqual(observation.limitations, ['Preflight block MISSING_ROUTE; no graph dispatch occurred.']);
  assert.deepEqual(routeReads, []);
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

const rawProfile = (profileCatalog: readonly CatalogEntry[] = catalog): Record<string, unknown> => ({
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
  catalog: profileCatalog,
});

function admittedProfile(profileCatalog: readonly CatalogEntry[] = catalog): EvaluationProfile {
  const admitted = admitEvaluationProfile(rawProfile(profileCatalog));
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

test('the service evaluation graph runs the selected v0.2 route and reuses owner task identity on continuation', async () => {
  const fixture = await controlledGeneratedPlanFixture();
  const entry: CatalogEntry = {
    ...catalogEntry,
    catalogEntryId: 'entry-C01-controlled',
    caseId: 'C01',
    initialRepositoryDigest: fixture.task.initialRevisionDigest.replace(/^sha256:/u, ''),
  };
  const readiness = prepareControlledUC03Host({
    ...fixture.host.inputs,
    config: { ...fixture.host.inputs.config, generation: undefined },
  });
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;
  const taskResolutions: (Readonly<{ priorState: unknown; sourceKind: string }> | null)[] = [];
  const selectedDirections: (ServiceControlReceipt | null)[] = [];
  const currentStates: TaskState[] = [];
  const graph = createUC03EvaluationGraph({
    catalogRoutes: new Map([
      [
        'C01',
        {
          entry,
          readiness,
          coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
          expectedWait: 'waiting-approval',
          workflowReport: {
            profileDigest: readiness.identity.profileDigest ?? '',
            configDigest: readiness.identity.configDigest ?? '',
            pricingDigest: readiness.identity.pricingDigest ?? '',
            adapterVersions: ['controlled-service-adapter-1'],
            requestedModel: 'controlled-service-model',
            timestamp: '2026-11-13T00:00:00.000Z',
          },
          async resolveTask(input) {
            taskResolutions.push({ priorState: input.priorState, sourceKind: input.source.kind });
            return fixture.task;
          },
          async resolveDirection(input) {
            selectedDirections.push(input.direction);
            currentStates.push(input.currentState);
            return undefined;
          },
        },
      ],
    ]),
  });
  const controlCalls: { expectedTaskVersion: number; expectedControlVersion: number }[] = [];
  const evaluationProfile = admittedProfile([entry]);
  const service = createEvaluationService({
    profile: evaluationProfile,
    catalog: [entry],
    repositoryIds: [fixture.task.repositoryId],
    checkSetIds: ['checks-configured'],
    control: {
      issue(input) {
        controlCalls.push({ expectedTaskVersion: input.expectedTaskVersion, expectedControlVersion: input.expectedControlVersion });
        return { receiptRef: 'ctrl-C01-resume', kind: input.kind, taskId: fixture.task.taskId, controlVersion: input.expectedControlVersion + 1 };
      },
    },
    graph,
    now: () => '2026-11-02T00:00:00.000Z',
    ids: () => 'exp-C01',
  });

  const started = await service.startExperiment({ source: { kind: 'catalog', caseIds: ['C01'] }, profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-C01-start' });
  assert.ok(started.ok);
  assert.equal(started.value.experiment.status, 'waiting-approval');
  assert.ok(started.value.experiment.workflowReport, 'the service should retain the report for the graph result it just ran');
  assert.equal(started.value.experiment.workflowReport?.cases[0]?.grade, 'pass');
  assert.equal(started.value.experiment.workflowReport?.cases[0]?.requestedModel, 'controlled-service-model');
  assert.deepEqual(fixture.modelCalls, ['coder:propose-plan', 'coder:propose-plan']);
  assert.equal(taskResolutions.length, 1);
  assert.equal(taskResolutions[0]?.priorState, null);

  const ownerState = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.ok(ownerState);
  const direction = await service.issueDirection({
    id: 'exp-C01',
    expectedTaskVersion: ownerState.stateVersion,
    expectedControlVersion: 7,
    kind: 'resume',
    idempotencyKey: 'key-C01-direction',
  });
  assert.ok(direction.ok);
  assert.ok('receiptRef' in direction.value.receipt);
  const continued = await service.continueExperiment({
    id: 'exp-C01',
    expectedVersion: direction.value.experiment.version,
    directionRef: direction.value.receipt.receiptRef,
    idempotencyKey: 'key-C01-continue',
  });
  assert.ok(continued.ok);
  assert.equal(continued.value.experiment.taskId, fixture.task.taskId);
  assert.equal(continued.value.experiment.runId, ownerState.runId);
  assert.equal(taskResolutions.length, 2);
  assert.deepEqual(taskResolutions[1], { priorState: { taskId: fixture.task.taskId, runId: ownerState.runId, workspaceId: ownerState.workspaceId }, sourceKind: 'catalog' });
  assert.equal(selectedDirections.length, 2);
  assert.equal(selectedDirections[0], null);
  assert.equal(selectedDirections[1]?.receiptRef, 'ctrl-C01-resume');
  assert.equal(currentStates[1]?.taskId, fixture.task.taskId);
  assert.deepEqual(controlCalls, [{ expectedTaskVersion: ownerState.stateVersion, expectedControlVersion: 7 }]);
  assert.deepEqual(fixture.modelCalls, ['coder:propose-plan', 'coder:propose-plan']);
});

async function runServiceClarificationReportGrade(predicate: 'clarification' | 'regression', driftAfterGrade = false) {
  const fixture = await controlledGeneratedPlanFixture({
    firstResponse: {
      proposalId: 'service-c02-ask',
      content: JSON.stringify({ kind: 'request-info', proposalId: 'service-c02-ask', questions: [{ questionId: 'q-denominator', text: 'What should zero division return?' }], evidenceRefs: [] }),
    },
  });
  const catalogRoot = mkdtempSync(join(tmpdir(), 'uc03-service-c02-grade-'));
  const fixturePath = join(catalogRoot, 'case.json');
  const graderPath = join(catalogRoot, 'grader.json');
  writeFileSync(fixturePath, '{}', 'utf8');
  writeFileSync(graderPath, '{}', 'utf8');
  const entry: CatalogEntry = {
    ...catalogEntryFor('C02', fixture.task),
    catalogEntryId: 'entry-C02-service-report',
    initialRepositoryDigest: fixture.task.initialRevisionDigest.replace(/^sha256:/u, ''),
    fixturePath,
    grader: { ...catalogEntryFor('C02', fixture.task).grader, path: graderPath },
  };
  const profileAdmission = admitEvaluationProfile({ ...rawProfile([entry]), adapterVersions: ['uc03-adapter-1'] });
  assert.ok(profileAdmission.ok, profileAdmission.ok ? '' : profileAdmission.reasonCode);
  const profile = profileAdmission.value;
  const readiness = prepareControlledUC03Host({
    ...fixture.host.inputs,
    identity: {
      profileId: profile.profileId,
      profileDigest: profile.profileDigest,
      configDigest: profile.configDigest,
      pricingDigest: profile.pricingDigest,
    },
    config: { ...fixture.host.inputs.config, generation: undefined },
  });
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') throw new Error('Controlled C02 report route was refused');

  const grader = createSnapshotGrader({
    criteria: {
      digest: `sha256:${digest(`service-C02-${predicate}`)}`,
      criteria: [{ criterionId: `criterion-service-C02-${predicate}`, caseId: 'C02', predicate, hiddenCheckId: null }],
    },
    profile: {
      profileId: 'controlled-service-C02-grader',
      digest: `sha256:${digest('controlled-service-C02-grader-profile')}`,
      bounds: { timeoutMs: 10_000, maxCpuMs: 5_000, maxOutputBytes: 65_536, maxMemoryBytes: 536_870_912, maxProcesses: 8 },
    },
    isolationAuthority: { admit: () => undefined },
    executor: { executorId: 'controlled-service-C02-grader', execute: () => undefined },
    graderPayload: null,
  });
  let freezeCalls = 0;
  let recheckCalls = 0;
  const finalTreeFor = async (
    binding: {
      readonly taskId: string;
      readonly runId: string;
      readonly workspaceId: string;
      readonly repositoryId: string;
      readonly initialRevisionDigest: string;
      readonly finalRevisionDigest: string;
    },
    drift: boolean,
  ) => {
    const implementation = await fixture.route.repositoryPort.readFile('src/calculator.py');
    const hostSnapshot = await readiness.ports.hostAuthority.loadSnapshot({
      taskId: binding.taskId,
      workspaceId: binding.workspaceId,
      repositoryId: binding.repositoryId,
      expectedRevisionDigest: binding.finalRevisionDigest,
      expectedCriteriaDigest: computeCanonicalSha256(fixture.task.acceptanceCriteria),
      expectedCheckSetDigest: computeCheckSetDigest(fixture.task.requiredChecks),
      expectedTestFiles: ['tests/test_calculator.py'],
    });
    const protectedTest = hostSnapshot?.testFiles.find(file => file.path === 'tests/test_calculator.py');
    assert.ok(protectedTest, 'the trusted host snapshot supplies the protected test file in the full tree');
    return {
      ...binding,
      snapshotId: 'service-c02-tree-' + binding.runId,
      complete: true as const,
      // This fixture worktree contains exactly these implementation and protected-test files.
      files: [
        { path: 'src/calculator.py', content: implementation.boundedExcerpt },
        { path: protectedTest.path, content: drift ? 'def test_divide(): assert False\n' : protectedTest.content },
      ],
    };
  };
  const graph = createUC03EvaluationGraph({
    catalogRoutes: new Map([
      [
        'C02',
        {
          entry,
          readiness,
          coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
          expectedWait: 'waiting-info',
          workflowReport: {
            profileDigest: profile.profileDigest,
            configDigest: profile.configDigest,
            pricingDigest: profile.pricingDigest,
            adapterVersions: profile.adapterVersions,
            requestedModel: profile.model,
            timestamp: '2026-11-13T00:00:00.000Z',
            workflowEvidence: {
              grader,
              finalTree: {
                async freezeFinalTree(binding) {
                  freezeCalls += 1;
                  return finalTreeFor(binding, false);
                },
                async recheckCurrentFinalTree(binding) {
                  recheckCalls += 1;
                  return finalTreeFor(binding, driftAfterGrade);
                },
              },
            },
          },
          resolveTask: () => fixture.task,
          resolveDirection: () => undefined,
        },
      ],
    ]),
  });
  const service = createEvaluationService({
    profile,
    catalog: [entry],
    repositoryIds: [fixture.task.repositoryId],
    checkSetIds: ['checks-configured'],
    control: { issue: input => ({ receiptRef: 'service-C02-unused-direction', kind: input.kind, taskId: fixture.task.taskId, controlVersion: input.expectedControlVersion + 1 }) },
    graph,
    now: () => '2026-11-13T00:00:00.000Z',
    ids: () => 'exp-C02-service-report',
  });
  const started = await service.startExperiment({ source: { kind: 'catalog', caseIds: ['C02'] }, profileId: profile.profileId, idempotencyKey: `service-C02-${predicate}-${driftAfterGrade}` });
  return { fixture, started, freezeCalls, recheckCalls };
}

test('EvaluationService reports a generated C02 clarification from one graph run and grades the expected wait', async () => {
  const { fixture, started, freezeCalls, recheckCalls } = await runServiceClarificationReportGrade('clarification');
  assert.ok(started.ok);
  const report = started.value.experiment.workflowReport;
  assert.ok(report, 'the service retains the report for the graph result it just ran');
  assert.equal(started.value.experiment.status, 'waiting-info');
  const ownerState = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.ok(ownerState?.clarification);
  assert.equal(started.value.experiment.workflowClarification?.questionId, ownerState.clarification.questionId);
  assert.equal(started.value.experiment.workflowClarification?.questions[0]?.questionId, 'q-denominator');
  assert.equal(report.cases[0]?.workflowOutcome, 'waiting-info');
  assert.equal(report.cases[0]?.grade, 'pass', JSON.stringify(report.cases[0]));
  assert.equal(report.cases[0]?.gradeReason, 'criteria-satisfied');
  assert.equal(report.exitCode, 0);
  assert.deepEqual(fixture.modelCalls, ['coder:propose-plan']);
  assert.equal(fixture.coderAdmissions.length, 1, 'one generated question is backed by one admitted coder turn');
  assert.equal(fixture.route.repositoryPort.commands.length, 2, 'the graph runs one baseline command pair');
  assert.deepEqual(fixture.route.repositoryPort.patches, []);
  assert.equal((await fixture.statePort.loadTask(fixture.task.taskId))?.node, 'NeedsInfo');
  assert.equal((await fixture.statePort.loadTask(fixture.task.taskId))?.clarification?.answer, undefined);
  assert.equal(freezeCalls, 1);
  assert.equal(recheckCalls, 1);
});

test('independent fail or stale C02 grade overrides the service expected-wait pass', async () => {
  const failed = await runServiceClarificationReportGrade('regression');
  assert.ok(failed.started.ok);
  const failedReport = failed.started.value.experiment.workflowReport;
  assert.ok(failedReport);
  assert.equal(failedReport.cases[0]?.workflowOutcome, 'waiting-info');
  assert.equal(failedReport.cases[0]?.grade, 'fail');
  assert.equal(failedReport.cases[0]?.gradeReason, 'criteria-violation');
  assert.equal(failedReport.exitCode, 1);
  assert.equal(failed.freezeCalls, 1);
  assert.equal(failed.recheckCalls, 1);

  const drifted = await runServiceClarificationReportGrade('clarification', true);
  assert.ok(drifted.started.ok);
  const driftedReport = drifted.started.value.experiment.workflowReport;
  assert.ok(driftedReport);
  assert.equal(driftedReport.cases[0]?.workflowOutcome, 'waiting-info');
  assert.equal(driftedReport.cases[0]?.grade, 'not-run');
  assert.equal(driftedReport.cases[0]?.gradeReason, 'invalid-observation');
  assert.equal(driftedReport.exitCode, 1);
  assert.equal(drifted.freezeCalls, 1);
  assert.equal(drifted.recheckCalls, 1);
  assert.equal(drifted.fixture.modelCalls.length, 1, 'grading and stability recheck do not replay the graph');
  assert.equal(drifted.fixture.route.repositoryPort.commands.length, 2, 'the retained baseline commands are not replayed');
});

test('a workflow report with a mismatched host identity is rejected before owner or graph calls', async () => {
  const fixture = await controlledGeneratedPlanFixture();
  const entry = catalogEntryFor('C01', fixture.task);
  const ready = prepareControlledUC03Host({ ...fixture.host.inputs, config: { ...fixture.host.inputs.config, generation: undefined } });
  assert.equal(ready.status, 'controlled-ready');
  if (ready.status !== 'controlled-ready') return;

  let ownerReads = 0;
  let taskResolutions = 0;
  const statePort = new Proxy(ready.ports.statePort, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property === 'loadTask' && typeof value === 'function') {
        return (...args: Parameters<typeof target.loadTask>) => {
          ownerReads += 1;
          return value.apply(target, args);
        };
      }
      return value;
    },
  });
  const readiness = { ...ready, ports: { ...ready.ports, statePort } };
  const profileDigest = ready.identity['profileDigest'];
  const configDigest = ready.identity['configDigest'];
  const pricingDigest = ready.identity['pricingDigest'];
  assert.ok(profileDigest && configDigest && pricingDigest);
  const reportIdentity: NonNullable<UC03EvaluationGraphRoute['workflowReport']> = {
    profileDigest,
    configDigest,
    pricingDigest,
    adapterVersions: ['controlled-service-adapter-1'],
    requestedModel: 'controlled-service-model',
  };

  for (const field of ['profileDigest', 'configDigest', 'pricingDigest'] as const) {
    assert.throws(
      () =>
        createUC03EvaluationGraph({
          catalogRoutes: new Map([
            [
              'C01',
              {
                entry,
                readiness,
                coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
                expectedWait: 'waiting-approval',
                workflowReport: {
                  profileDigest: field === 'profileDigest' ? digest(`wrong-${field}`) : reportIdentity.profileDigest,
                  configDigest: field === 'configDigest' ? digest(`wrong-${field}`) : reportIdentity.configDigest,
                  pricingDigest: field === 'pricingDigest' ? digest(`wrong-${field}`) : reportIdentity.pricingDigest,
                  adapterVersions: reportIdentity.adapterVersions,
                  requestedModel: reportIdentity.requestedModel,
                },
                resolveTask() {
                  taskResolutions += 1;
                  return fixture.task;
                },
                resolveDirection: () => undefined,
              },
            ],
          ]),
        }),
      /does not match the validated host route/u,
    );
    assert.equal(ownerReads, 0);
    assert.equal(taskResolutions, 0);
    assert.deepEqual(fixture.modelCalls, []);
  }
});

test('graph clarification answers stay reporter-only until an owner-bound resume continues the same task', async () => {
  const fixture = await controlledGeneratedPlanFixture({
    taskState: { evidenceRefs: ['src/calculator.py'] },
    firstResponse: {
      proposalId: 'controlled-graph-ask',
      content: JSON.stringify({ kind: 'request-info', proposalId: 'controlled-graph-ask', questions: [{ questionId: 'q-denominator', text: 'What should zero division return?' }], evidenceRefs: [] }),
    },
  });
  const entry: CatalogEntry = {
    ...catalogEntry,
    catalogEntryId: 'entry-C02-controlled',
    caseId: 'C02',
    initialRepositoryDigest: fixture.task.initialRevisionDigest.replace(/^sha256:/u, ''),
  };
  const readiness = prepareControlledUC03Host({ ...fixture.host.inputs, config: { ...fixture.host.inputs.config, generation: undefined } });
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;

  const ownerDirections = new Map<string, Readonly<{ receipt: ServiceControlReceipt; taskVersion: number }>>();
  const graph = createUC03EvaluationGraph({
    catalogRoutes: new Map([
      [
        'C02',
        {
          entry,
          readiness,
          coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
          expectedWait: 'waiting-info',
          resolveTask: () => fixture.task,
          resolveDirection: () => undefined,
          async resolveClarificationResume(input) {
            const ownerState = await fixture.statePort.loadTask(fixture.task.taskId);
            const stored = input.direction ? ownerDirections.get(input.direction.receiptRef) : undefined;
            if (
              !ownerState ||
              !stored ||
              !input.direction ||
              stored.receipt.receiptRef !== input.direction.receiptRef ||
              stored.receipt.kind !== input.direction.kind ||
              stored.receipt.taskId !== input.direction.taskId ||
              stored.receipt.controlVersion !== input.direction.controlVersion ||
              stored.taskVersion !== ownerState.stateVersion
            )
              return undefined;
            if (ownerState.node !== 'NeedsInfo' || !ownerState.clarification || ownerState.clarification.answer) return undefined;
            return {
              receiptRef: input.direction.receiptRef,
              controlVersion: input.direction.controlVersion,
              taskId: ownerState.taskId,
              runId: ownerState.runId,
              workspaceId: ownerState.workspaceId,
              stateVersion: ownerState.stateVersion,
              questionId: ownerState.clarification.questionId,
              questionDigest: ownerState.clarification.questionDigest,
              answerDigest: input.expectedAnswerDigest,
            };
          },
        },
      ],
    ]),
  });
  const evaluationProfile = admittedProfile([entry]);
  const service = createEvaluationService({
    profile: evaluationProfile,
    catalog: [entry],
    repositoryIds: [fixture.task.repositoryId],
    checkSetIds: ['checks-configured'],
    control: {
      async issue(input) {
        const receipt = Object.freeze({ receiptRef: 'ctrl-C02-resume', kind: input.kind, taskId: fixture.task.taskId, controlVersion: input.expectedControlVersion + 1 });
        ownerDirections.set(receipt.receiptRef, { receipt, taskVersion: input.expectedTaskVersion });
        return receipt;
      },
    },
    graph,
    now: () => '2026-11-02T00:00:00.000Z',
    ids: () => 'exp-C02',
  });

  const started = await service.startExperiment({ source: { kind: 'catalog', caseIds: ['C02'] }, profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-C02-start' });
  assert.ok(started.ok);
  assert.equal(started.value.experiment.status, 'waiting-info');
  assert.deepEqual(fixture.modelCalls, ['coder:propose-plan']);
  const asked = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.ok(asked?.clarification);
  assert.deepEqual(started.value.experiment.workflowClarification, {
    questionId: asked.clarification.questionId,
    questionDigest: asked.clarification.questionDigest,
    questions: [{ questionId: 'q-denominator', text: 'What should zero division return?' }],
  });

  const answered = await service.answerClarification({
    id: 'exp-C02',
    questionId: asked.clarification.questionId,
    questionDigest: asked.clarification.questionDigest,
    expectedVersion: started.value.experiment.version,
    answers: ['Raise CalculationError for a zero denominator.'],
    idempotencyKey: 'key-C02-answer',
  });
  assert.ok(answered.ok);
  assert.equal(answered.value.experiment.status, 'waiting-info');
  assert.deepEqual(fixture.modelCalls, ['coder:propose-plan']);
  assert.equal((await fixture.statePort.loadTask(fixture.task.taskId))?.clarification?.answer, undefined);
  const ownerState = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.ok(ownerState);
  const direction = await service.issueDirection({
    id: 'exp-C02',
    expectedTaskVersion: ownerState.stateVersion,
    expectedControlVersion: 7,
    kind: 'resume',
    idempotencyKey: 'key-C02-direction',
  });
  assert.ok(direction.ok);
  assert.ok('receiptRef' in direction.value.receipt);
  const baselineCommandCount = fixture.route.repositoryPort.commands.length;
  assert.equal(baselineCommandCount, 2, 'the initial investigation runs exactly the two admitted baseline commands');
  const freshGraph = createUC03EvaluationGraph({
    catalogRoutes: new Map([
      [
        'C02',
        {
          entry,
          readiness,
          coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
          expectedWait: 'waiting-info',
          resolveTask: () => fixture.task,
          resolveDirection: () => undefined,
          async resolveClarificationResume(input) {
            const current = await fixture.statePort.loadTask(fixture.task.taskId);
            const stored = input.direction ? ownerDirections.get(input.direction.receiptRef) : undefined;
            if (!current || !stored || !input.direction || stored.taskVersion !== current.stateVersion || current.node !== 'NeedsInfo' || !current.clarification || current.clarification.answer)
              return undefined;
            return {
              receiptRef: input.direction.receiptRef,
              controlVersion: input.direction.controlVersion,
              taskId: current.taskId,
              runId: current.runId,
              workspaceId: current.workspaceId,
              stateVersion: current.stateVersion,
              questionId: current.clarification.questionId,
              questionDigest: current.clarification.questionDigest,
              answerDigest: input.expectedAnswerDigest,
            };
          },
        },
      ],
    ]),
  });
  const freshBound = bindEvaluationSource(
    { kind: 'catalog', caseIds: ['C02'] },
    {
      profile: evaluationProfile,
      catalog: [entry],
      repositoryIds: [fixture.task.repositoryId],
      checkSetIds: ['checks-configured'],
    },
  );
  assert.ok(freshBound.ok);
  if (!freshBound.ok) return;
  const freshSource = freshBound.value;
  const hostAuthority = readiness.ports.hostAuthority;
  const originalLoadSnapshot = hostAuthority.loadSnapshot.bind(hostAuthority);
  hostAuthority.loadSnapshot = async request => {
    const snapshot = await originalLoadSnapshot(request);
    return { ...snapshot, testFiles: snapshot.testFiles.map(file => ({ ...file, content: 'drifted protected test content' })) };
  };
  const driftedRetention = await graph.run({
    experimentId: 'exp-C02',
    source: freshSource,
    ports: graph.portsFor({ experimentId: 'exp-C02', source: freshSource }),
    priorState: { taskId: ownerState.taskId, runId: ownerState.runId, workspaceId: ownerState.workspaceId },
    direction: direction.value.receipt,
    answers: answered.value.experiment.answers,
  });
  hostAuthority.loadSnapshot = originalLoadSnapshot;
  assert.equal(driftedRetention.outcome, 'INCOMPLETE');
  assert.equal((await fixture.statePort.loadTask(fixture.task.taskId))?.node, 'NeedsInfo', 'protected-test drift refuses before the answer transition');
  assert.equal((await fixture.statePort.loadTask(fixture.task.taskId))?.clarification?.answer, undefined);
  assert.equal(fixture.route.repositoryPort.commands.length, baselineCommandCount, 'protected-test drift does not rerun a baseline command');
  assert.deepEqual(fixture.modelCalls, ['coder:propose-plan'], 'protected-test drift does not dispatch another provider turn');
  const missingRetention = await freshGraph.run({
    experimentId: 'exp-C02-fresh-process',
    source: freshSource,
    ports: freshGraph.portsFor({ experimentId: 'exp-C02-fresh-process', source: freshSource }),
    priorState: { taskId: ownerState.taskId, runId: ownerState.runId, workspaceId: ownerState.workspaceId },
    direction: direction.value.receipt,
    answers: answered.value.experiment.answers,
  });
  assert.equal(missingRetention.outcome, 'INCOMPLETE');
  assert.equal((await fixture.statePort.loadTask(fixture.task.taskId))?.node, 'NeedsInfo', 'missing private run evidence refuses before the answer transition');
  assert.equal((await fixture.statePort.loadTask(fixture.task.taskId))?.clarification?.answer, undefined);
  assert.equal(fixture.route.repositoryPort.commands.length, baselineCommandCount, 'missing evidence does not rerun a baseline command');
  assert.deepEqual(fixture.modelCalls, ['coder:propose-plan'], 'missing evidence does not dispatch another provider turn');
  const continued = await service.continueExperiment({
    id: 'exp-C02',
    expectedVersion: direction.value.experiment.version,
    directionRef: direction.value.receipt.receiptRef,
    idempotencyKey: 'key-C02-continue',
  });
  assert.ok(continued.ok);
  assert.equal(
    continued.value.experiment.status,
    'waiting-approval',
    JSON.stringify({
      answers: continued.value.experiment.answers,
      workflowClarification: continued.value.experiment.workflowClarification,
      modelCalls: fixture.modelCalls,
      ownerState: await fixture.statePort.loadTask(fixture.task.taskId),
    }),
  );
  assert.equal(continued.value.experiment.taskId, fixture.task.taskId);
  assert.equal(continued.value.experiment.runId, ownerState.runId);
  assert.equal(continued.value.experiment.workflowClarification, null);
  assert.deepEqual(fixture.modelCalls, ['coder:propose-plan', 'coder:propose-plan']);
  const resumed = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.equal(resumed?.node, 'AwaitPlan');
  assert.deepEqual(resumed?.clarification?.answer?.items, [{ questionId: 'q-denominator', text: 'Raise CalculationError for a zero denominator.' }]);
});

test('a foreign-task resume receipt refuses before clarification owner calls or persisted effects', async () => {
  const fixture = await controlledGeneratedPlanFixture({
    taskState: { evidenceRefs: ['src/calculator.py'] },
    firstResponse: {
      proposalId: 'foreign-task-ask',
      content: JSON.stringify({ kind: 'request-info', proposalId: 'foreign-task-ask', questions: [{ questionId: 'q-denominator', text: 'What should zero division return?' }], evidenceRefs: [] }),
    },
  });
  const entry: CatalogEntry = {
    ...catalogEntry,
    catalogEntryId: 'entry-C02-foreign-task',
    caseId: 'C02',
    initialRepositoryDigest: fixture.task.initialRevisionDigest.replace(/^sha256:/u, ''),
  };
  const readiness = prepareControlledUC03Host({ ...fixture.host.inputs, config: { ...fixture.host.inputs.config, generation: undefined } });
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;
  let directionLookups = 0;
  let clarificationLookups = 0;
  const graph = createUC03EvaluationGraph({
    catalogRoutes: new Map([
      [
        'C02',
        {
          entry,
          readiness,
          coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
          expectedWait: 'waiting-info',
          resolveTask: () => fixture.task,
          resolveDirection() {
            directionLookups += 1;
            return undefined;
          },
          async resolveClarificationResume(input) {
            clarificationLookups += 1;
            const current = await fixture.statePort.loadTask(fixture.task.taskId);
            if (!current?.clarification || !input.direction) return undefined;
            return {
              receiptRef: input.direction.receiptRef,
              controlVersion: input.direction.controlVersion,
              taskId: current.taskId,
              runId: current.runId,
              workspaceId: current.workspaceId,
              stateVersion: current.stateVersion,
              questionId: current.clarification.questionId,
              questionDigest: current.clarification.questionDigest,
              answerDigest: input.expectedAnswerDigest,
            };
          },
        },
      ],
    ]),
  });
  const service = createEvaluationService({
    profile: admittedProfile([entry]),
    catalog: [entry],
    repositoryIds: [fixture.task.repositoryId],
    checkSetIds: ['checks-configured'],
    graph,
    control: { issue: input => ({ receiptRef: 'ctrl-foreign-task', kind: input.kind, taskId: 'task-other', controlVersion: input.expectedControlVersion + 1 }) },
    ids: () => 'exp-foreign-task',
  });
  const started = await service.startExperiment({ source: { kind: 'catalog', caseIds: ['C02'] }, profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'foreign-start' });
  assert.ok(started.ok);
  assert.equal(started.value.experiment.status, 'waiting-info');
  const paused = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.ok(paused?.clarification);
  const answered = await service.answerClarification({
    id: 'exp-foreign-task',
    questionId: paused.clarification.questionId,
    questionDigest: paused.clarification.questionDigest,
    expectedVersion: started.value.experiment.version,
    answers: ['Raise CalculationError for a zero denominator.'],
    idempotencyKey: 'foreign-answer',
  });
  assert.ok(answered.ok);
  const direction = await service.issueDirection({ id: 'exp-foreign-task', expectedTaskVersion: paused.stateVersion, expectedControlVersion: 7, kind: 'resume', idempotencyKey: 'foreign-direction' });
  assert.ok(direction.ok);
  assert.ok('receiptRef' in direction.value.receipt);
  const ownerBefore = await fixture.statePort.loadTask(fixture.task.taskId);
  const journalBefore = fixture.statePort.getJournalSnapshot();
  const lookupsBefore = directionLookups;
  const commandsBefore = fixture.route.repositoryPort.commands.length;
  const modelCallsBefore = [...fixture.modelCalls];

  const continued = await service.continueExperiment({
    id: 'exp-foreign-task',
    expectedVersion: direction.value.experiment.version,
    directionRef: direction.value.receipt.receiptRef,
    idempotencyKey: 'foreign-continue',
  });

  assert.ok(continued.ok);
  assert.equal(continued.value.experiment.status, 'incomplete');
  assert.deepEqual(await fixture.statePort.loadTask(fixture.task.taskId), ownerBefore, 'the selected foreign task must refuse before persisting the answer');
  assert.deepEqual(fixture.statePort.getJournalSnapshot(), journalBefore);
  assert.equal(directionLookups, lookupsBefore, 'a foreign task must not reach the continuation direction owner');
  assert.equal(clarificationLookups, 0, 'a foreign task must not reach the clarification owner');
  assert.equal(commandsBefore, 2);
  assert.equal(fixture.route.repositoryPort.commands.length, commandsBefore);
  assert.deepEqual(modelCallsBefore, ['coder:propose-plan']);
  assert.deepEqual(fixture.modelCalls, modelCallsBefore);
});

test('service stores a frozen detached copy of the graph workflow report', async () => {
  const report: WorkflowEvaluationReport = {
    suite: 'uc03',
    contractVersion: WORKFLOW_EVALUATION_VERSION,
    mode: 'mock',
    tier: 'controlled',
    manifestDigest: digest('manifest'),
    configDigest: digest('config'),
    timestamp: '2026-11-13T00:00:00.000Z',
    isRealVerified: false,
    selectionResult: { selected: ['C01'], passed: 0, failed: 0, incomplete: 1, pendingWaits: [], outcome: 'incomplete' },
    suiteAcceptance: { scope: 'catalog', requiredCases: 17, satisfiedCases: 0, outcome: 'incomplete' },
    exitCode: 3,
    cases: [
      {
        caseId: 'C01',
        repositoryId: 'repo-1',
        taskId: 'task-1',
        runId: 'run-1',
        requestedModel: 'm',
        returnedModel: 'm',
        profileDigest: digest('profile'),
        configDigest: digest('config'),
        pricingDigest: digest('pricing'),
        adapterVersions: ['a@1'],
        graderDigest: null,
        initialRepositoryDigest: null,
        workflowOutcome: 'waiting-approval' as const,
        expectedOutcome: 'COMPLETED',
        tier: 'controlled',
        grade: 'not-run',
        gradeReason: 'unresolved-wait',
        effects: 'observed',
        usage: 'observed',
        diagnostic: null,
        artifacts: [],
        limitations: ['paused'],
      },
    ],
    limitations: ['controlled only'],
  };
  const { service } = createService({
    graph: {
      portsFor: () => ({}),
      run: async () => ({ outcome: 'pending-approval', state: { taskId: 'task-001', runId: 'run-001', workspaceId: 'ws-001' }, workflowReport: report }),
    },
  });
  const started = await service.startExperiment({ source: catalogSource, profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-report' });
  assert.ok(started.ok);

  // The graph's retained reference cannot rewrite the stored report.
  (report.cases[0]?.limitations as string[]).push('mutated by the producer');
  assert.deepEqual(started.value.experiment.workflowReport?.cases[0]?.limitations, ['paused']);
  assert.equal(Object.isFrozen(started.value.experiment.workflowReport), true);

  // A returned view cannot rewrite it either.
  const next = service.getExperiment('exp-001');
  assert.ok(next.ok);
  const view = next.value.workflowReport;
  assert.ok(view);
  assert.throws(() => (view.cases[0]?.limitations as string[]).push('mutated by a view'), TypeError);
  const reread = service.getExperiment('exp-001');
  assert.ok(reread.ok);
  assert.deepEqual(reread.value.workflowReport?.cases[0]?.limitations, ['paused']);
});

test('a continuation result without a report clears the previous execution report', async () => {
  const report: WorkflowEvaluationReport = {
    suite: 'uc03',
    contractVersion: WORKFLOW_EVALUATION_VERSION,
    mode: 'mock',
    tier: 'controlled',
    manifestDigest: digest('manifest'),
    configDigest: digest('config'),
    timestamp: '2026-11-13T00:00:00.000Z',
    isRealVerified: false,
    selectionResult: { selected: ['C01'], passed: 1, failed: 0, incomplete: 0, pendingWaits: [], outcome: 'pass' },
    suiteAcceptance: { scope: 'catalog', requiredCases: 17, satisfiedCases: 1, outcome: 'incomplete' },
    exitCode: 0,
    cases: [
      {
        caseId: 'C01',
        repositoryId: 'repo-1',
        taskId: 'task-1',
        runId: 'run-1',
        requestedModel: 'm',
        returnedModel: 'm',
        profileDigest: digest('profile'),
        configDigest: digest('config'),
        pricingDigest: digest('pricing'),
        adapterVersions: ['a@1'],
        graderDigest: null,
        initialRepositoryDigest: null,
        workflowOutcome: 'COMPLETED',
        expectedOutcome: 'COMPLETED',
        tier: 'controlled',
        grade: 'pass',
        gradeReason: 'criteria-satisfied',
        effects: 'observed',
        usage: 'observed',
        diagnostic: null,
        artifacts: [],
        limitations: [],
      },
    ],
    limitations: ['controlled only'],
  };
  let stop = false;
  const { service } = createService({
    graph: {
      portsFor: () => ({}),
      // The second execution is a refused continuation: the graph returns INCOMPLETE with no report.
      run: async () =>
        stop
          ? { outcome: 'INCOMPLETE', state: { taskId: 'task-001', runId: 'run-001', workspaceId: 'ws-001' } }
          : { outcome: 'pending-approval', state: { taskId: 'task-001', runId: 'run-001', workspaceId: 'ws-001' }, workflowReport: report },
    },
  });
  const started = await service.startExperiment({ source: catalogSource, profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-stale-report-start' });
  assert.ok(started.ok);
  assert.ok(started.value.experiment.workflowReport, 'the start execution retained its report');

  const direction = await service.issueDirection({ id: 'exp-001', expectedTaskVersion: 1, expectedControlVersion: 1, kind: 'resume', idempotencyKey: 'key-stale-report-direction' });
  assert.ok(direction.ok);
  stop = true;
  const continued = await service.continueExperiment({
    id: 'exp-001',
    expectedVersion: direction.value.experiment.version,
    directionRef: 'receiptRef' in direction.value.receipt ? direction.value.receipt.receiptRef : direction.value.receipt.receiptId,
    idempotencyKey: 'key-stale-report-continue',
  });
  assert.ok(continued.ok);
  assert.equal(continued.value.experiment.status, 'incomplete');
  // The earlier passing report no longer describes the latest execution, so it cannot be current.
  assert.equal(continued.value.experiment.workflowReport, null);
  const reread = service.getExperiment('exp-001');
  assert.ok(reread.ok);
  assert.equal(reread.value.workflowReport, null);
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

test('service forwards a direction for a task-bearing graph wait to control and accepts continuation', async () => {
  const issued: string[] = [];
  const { service } = createService({
    graph: {
      portsFor: () => ({ ports: 'host-only' }),
      run: async () => ({ outcome: 'needs-info', state: { taskId: 'task-001', runId: 'run-001', workspaceId: 'ws-001' }, usage: { tokensConsumed: 10, costUsd: 0.01 } }),
    },
    control: {
      issue: input => {
        issued.push(input.kind);
        return { receiptRef: `ctrl-1-${input.kind}`, kind: input.kind, taskId: 'task-001', controlVersion: 7 };
      },
    },
  });
  const started = await service.startExperiment({ source: completeBugSource, profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-graph-wait' });
  assert.ok(started.ok);
  assert.equal(started.value.experiment.status, 'waiting-info');
  assert.equal(started.value.experiment.taskId, 'task-001');

  const direction = await service.issueDirection({ id: 'exp-001', expectedTaskVersion: 2, expectedControlVersion: 1, kind: 'revise', idempotencyKey: 'key-graph-revise' });
  assert.ok(direction.ok);
  assert.deepEqual(issued, ['revise']);
  assert.ok('receiptRef' in direction.value.receipt);
  assert.deepEqual(direction.value.experiment.directions, ['ctrl-1-revise']);

  const replayed = await service.issueDirection({ id: 'exp-001', expectedTaskVersion: 2, expectedControlVersion: 1, kind: 'revise', idempotencyKey: 'key-graph-revise' });
  assert.ok(replayed.ok);
  assert.equal(replayed.value.receipt, direction.value.receipt);
  assert.deepEqual(issued, ['revise']);

  const continuation = await service.continueExperiment({
    id: 'exp-001',
    expectedVersion: direction.value.experiment.version,
    directionRef: 'ctrl-1-revise',
    idempotencyKey: 'key-graph-continue',
  });
  assert.ok(continuation.ok);
  assert.equal(continuation.value.experiment.taskId, 'task-001');
});

/* ------------------------------------------------------------------
 * CodeRabbit repair batch cr-E: budget-stop evidence, verdict binding, stale reports
 * ------------------------------------------------------------------ */

test('a patch-free Repair stop counts as no patch only when the stop evidence confirms budget exhaustion', () => {
  const state = createFixtureTaskState({ node: 'Repair', nextAction: 'repair-review-findings' });
  assert.equal(state.changedPaths.length, 0);
  assert.equal(patchFreeFacts(state, true), false);
  assert.equal(patchFreeFacts(state, false), undefined, 'a Repair halt without budget evidence is indeterminate, not patch-free');

  const terminal = createFixtureTaskState({ node: 'Incomplete', outcome: 'INCOMPLETE', nextAction: 'halt-no-repair-proposal' });
  assert.equal(patchFreeFacts(terminal, true), false);
  assert.equal(patchFreeFacts(terminal, false), undefined);

  // A state that already recorded a change is never patch-free, budget or not.
  assert.equal(patchFreeFacts(createFixtureTaskState({ node: 'Repair', changedPaths: ['src/calculator.py'] }), true), undefined);

  // The repair ledger's exact lower-case reason and the coder agent's codes in their route envelope both qualify.
  assert.equal(budgetStopEvidence(['repair-budget-exhausted']), true);
  assert.equal(budgetStopEvidence(['REAL_PROFILE_GENERATION_INVALID: REPAIR_BUDGET_EXHAUSTED']), true);
  assert.equal(budgetStopEvidence(['REAL_PROFILE_GENERATION_INVALID: MODEL_CALL_BUDGET_EXHAUSTED']), true);
  // A bare upper-case code never reaches reasons: `graph-generation.ts:205` always adds the envelope.
  assert.equal(budgetStopEvidence(['MODEL_CALL_BUDGET_EXHAUSTED']), false);
  assert.equal(budgetStopEvidence(['No repair patch proposal provided']), false);
});

test('a private verdict is bound to its case id and exact graded observation contents', async () => {
  const observation = {
    repositoryId: 'repo-calc',
    taskId: 'task-calc-001',
    runId: 'run-001',
    returnedModel: null,
    graderDigest: null,
    initialRepositoryDigest: null,
    workflowOutcome: 'waiting-approval' as const,
    expectedWait: 'waiting-approval' as const,
    blocked: null,
    effects: 'observed' as const,
    usage: 'unavailable' as const,
    diagnostic: null,
    artifacts: [],
    limitations: [],
  };
  // Without task state and ports the facts never certify a snapshot, so the producer records its
  // bounded not-run verdict against the exact observation object it was handed.
  const grader: SnapshotGrader = {
    grade: async (caseId: string): Promise<SnapshotGradeResult> => ({
      caseId: caseId as Exclude<SnapshotGradeResult['caseId'], null>,
      criterionId: null,
      grade: 'not-run' as const,
      reason: 'private-grading' as const,
      evidenceIds: [],
      snapshot: null,
      evidenceDigest: null,
      criteriaDigest: digest('criteria'),
      limitations: [],
    }),
  };
  await produceWorkflowEvidence({
    caseId: 'C01',
    task: createFixtureBugTask(),
    result: { outcome: 'pending-approval', state: null, reasons: [], milestones: [] },
    observation,
    repository: undefined,
    host: { grader, finalTree: { freezeFinalTree: () => ({}), recheckCurrentFinalTree: () => ({}) } },
  });

  const stored = workflowEvidenceDecision('C01', observation);
  assert.ok(stored, 'the graded case returns the verdict it earned');
  assert.equal(workflowEvidenceDecision('C02', observation), undefined, 'another case cannot borrow it');
  assert.equal(workflowEvidenceDecision('C01', validateWorkflowObservation(observation)), undefined, 'a copied observation cannot borrow it');

  // Mutating a graded field on the same object voids the verdict instead of silently reusing it.
  (observation as { runId: string | null }).runId = 'run-002';
  assert.equal(workflowEvidenceDecision('C01', observation), undefined);
});
