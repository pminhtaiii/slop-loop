/**
 * UC-03 T008 - real-profile generation refusal and proposal on the graph route.
 *
 * Owned path: tests/runtime/unit/uc03-agent-route.test.ts
 * Feature: specs/007-runtime-evaluation-integration
 *
 * The real profile must take plan/patch/repair/replan answers from the generation agent. A supplied
 * answer alongside `generation` in production is refused with no effects; with no supplied answer the
 * route obtains the plan through an owner-issued coder admission, or reports the unwired seam.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  computeRequestContentDigest,
  type ApprovalBinding,
  type ApprovalBindingContext,
  type ContextualApprovalVerifierV02,
  type PolicyAuthorityRefV02,
  type ProviderPricingIdentityV02,
  type BugTask,
  type FixPlan,
  type StateTransitionOptions,
  type TaskState,
} from '../../../src/contracts/foundation/uc03.ts';
import { createExecutionGuardV02 } from '../../../src/foundation/execution-guard.ts';
import { createCoderAgent, type CoderAgent } from '../../../src/uc03/agent.ts';
import { createAwaitFeedbackNode } from '../../../src/uc03/graph-feedback.ts';
import { coderContextDigest, createInvestigateNode, createPatchNode, createRepairNode } from '../../../src/uc03/graph-nodes.ts';
import type { UC03CoderAdmission, UC03CoderAdmissionResolver, UC03GraphConfig, UC03GraphPorts } from '../../../src/uc03/graph-types.ts';
import type { UC03GraphState } from '../../../src/uc03/graph-state.ts';
import type { BaselineEvidenceAcknowledgement, BaselineEvidenceWriteRequest, BaselineEvidenceWriter, TrustedHostExpectedContext, TrustedHostPort } from '../../../src/uc03/investigation.ts';
import {
  createFixtureBugTask,
  createFixtureCheckDefinition,
  createFixtureExecutorIdentityV02,
  createFixturePolicyAuthorityRefV02,
  createFixtureProviderAdmissionReceiptV02,
} from '../support/uc03/port-fixtures.ts';
import { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';
import { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import { ScriptedApprovalPort } from '../support/uc03/scripted-approval.ts';
import { ScriptedModelPort } from '../support/uc03/scripted-model.ts';
import { ScriptedReviewerPort } from '../support/uc03/scripted-reviewer.ts';
import { createGraphRepositoryPort, createGraphTaskState, seedGraphTaskState } from '../support/uc03/graph-fixtures.ts';
import {
  createTestApprovalBinding,
  createTestProviderAdmissionContextV02,
  createTestProviderAdmissionTrustedContextV02,
  createTestProviderRequest,
  createTestRepositoryCommandAdmissionContextV02,
} from '../support/uc03/state-fixtures.ts';

const AGENT_BUDGET = { maxModelCalls: 4, maxActiveMs: 60_000, maxRepairs: 1, maxReplans: 1 };
const PLAN_DETAILS = { diagnosis: 'zero denominator is unguarded', strategy: 'guard zero', suspectedCauseLocations: ['src/calculator.py'], scopedChanges: ['src/calculator.py'] } as const;
const REPAIR_PATCH = { diff: 'guard zero', affectedPaths: ['src/calculator.py'], evidenceRefs: ['evidence-1'], diagnosticRefs: ['diag-1'] } as const;

/** Fixed model answer: no randomness, and its evidence refs are seeded in the route state. */
const MODEL_PLAN = {
  diagnosis: 'divide() performs a raw division and never rejects a zero denominator',
  strategy: 'raise CalculationError before the division when the denominator is zero',
  suspectedLocations: ['src/calculator.py'],
  scopedPaths: ['src/calculator.py'],
  evidenceRefs: ['src/calculator.py'],
} as const;

const propose = async () => ({
  outcome: 'observed' as const,
  result: {
    proposal: { proposalId: 'prop-plan-1', content: JSON.stringify({ kind: 'propose-plan', proposalId: 'prop-plan-1', ...MODEL_PLAN }) },
    observedUsage: { inputTokens: 1, outputTokens: 1, costUsd: 0, billableTokens: 2 },
  },
});

/** A real `CoderAgent` over scripted seams; its `counters.modelCalls` proves the agent was not called. */
function scriptedAgent(): CoderAgent {
  return createCoderAgent({
    propose: async () => ({ outcome: 'observed', result: { proposal: { proposalId: 'p-1', content: '{}' }, observedUsage: { inputTokens: 1, outputTokens: 1, costUsd: 0, billableTokens: 2 } } }),
    repository: new FakeRepositoryPort(),
    budget: AGENT_BUDGET,
  });
}

/** Throws if a node reaches model generation while the seam is unwired. */
const unusedAgent = (): CoderAgent => ({
  counters: { modelCalls: 0, modelOutputFailures: 0, repairs: 0, replans: 0, activeMs: 0 },
  turn: async () => {
    throw new Error('the generation agent must not be called while the provider seam is unwired');
  },
});

function setup() {
  const task = createFixtureBugTask();
  const repositoryPort = new FakeRepositoryPort();
  const statePort = new MemoryStatePortV02();
  const approvalPort = new ScriptedApprovalPort();
  const modelPort = new ScriptedModelPort();
  const reviewerPort = new ScriptedReviewerPort();
  const ports: UC03GraphPorts = { statePort: statePort.getUnderlying(), approvalPort, repositoryPort, modelPort, reviewerPort };
  return { task, ports, statePort, approvalPort, repositoryPort, modelPort, reviewerPort };
}

function graphState(task: BugTask, state: TaskState): UC03GraphState {
  return {
    task,
    state,
    baseline: undefined,
    verificationResults: [],
    reviewResult: undefined,
    reviewRequest: undefined,
    patchAdmission: undefined,
    patchReceipt: undefined,
    failureEvidence: [],
    finalReport: undefined,
    reasons: [],
    terminalOutcome: undefined,
    milestones: [],
  };
}

async function seed(task: BugTask, statePort: MemoryStatePortV02, overrides: Partial<TaskState>) {
  const state = createGraphTaskState(task, overrides);
  await seedGraphTaskState(statePort, state);
  return state;
}

const production = (agent: CoderAgent): UC03GraphConfig => ({ mode: 'production', generation: { agent, budget: AGENT_BUDGET } });

/* ------------------------------------------------------------------
 * Generation route: the controlled route with the model's plan in place of config.planDetails
 * ------------------------------------------------------------------ */

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

function createResourceReservationRefs(actionId: string): readonly string[] {
  const kinds = ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'] as const;
  return (['task', 'run'] as const).flatMap(scope => kinds.map(kind => `${scope}:${kind}:${actionId}`));
}

function createPlanBindingDigest(task: BugTask, state: TaskState): string {
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

/** The pending fix-plan approval for the model's strategy, at the identity `prepareFixPlanAndApproval` derives. */
function createPlanApprovalContext(task: BugTask, strategy: string) {
  const state = createGraphTaskState(task);
  const baselineRef = `uc04://baseline/${task.taskId}/1`;
  const evidenceRefs = [baselineRef];
  const checkSetDigest = computeCheckSetDigest(task.requiredChecks);
  const strategyDigest = computeCanonicalSha256(strategy);
  const decisionRef = `dec-plan-${task.taskId}-1`;
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
  return { 2: { approval: { binding, freshness } } } as unknown as Readonly<Record<number, NonNullable<StateTransitionOptions['trusted']>>>;
}

/** Owner-issued coder admission for one pre-plan proposal, bound to the current state version. */
function createCoderAdmissionResolver(statePort: MemoryStatePortV02): UC03CoderAdmissionResolver {
  return async (request): Promise<UC03CoderAdmission | undefined> => {
    const ownerAuthority = await statePort.readVerificationAuthoritySnapshot(request.task.taskId);
    if (!ownerAuthority) return undefined;
    const providerRequest = createTestProviderRequest({
      providerRequestId: `provider-coder-${request.task.taskId}-${request.state.stateVersion}`,
      taskId: request.task.taskId,
      runId: request.state.runId,
      role: 'coder',
      purpose: request.purpose,
      configId: ownerAuthority.policyIdentity.configId,
      pricingPolicyId: ownerAuthority.policyIdentity.policyId,
      contextDigest: coderContextDigest(request.task, request.state, request.purpose, request.evidence),
      reservationRef: `coder-allowance:${request.task.taskId}:${request.state.stateVersion}`,
    });
    const providerIdentity: ProviderPricingIdentityV02 = {
      providerId: providerRequest.providerId,
      modelId: providerRequest.modelId,
      configId: providerRequest.configId,
      configVersion: ownerAuthority.policyIdentity.configVersion,
      pricingPolicyId: providerRequest.pricingPolicyId,
      pricingPolicyVersion: ownerAuthority.policyIdentity.policyVersion,
      issuerKeyRef: ownerAuthority.policyIdentity.issuerKeyRef,
      decisionAuthorityGeneration: ownerAuthority.decisionAuthorityGeneration,
    };
    const providerAdmissionReceipt = createFixtureProviderAdmissionReceiptV02({
      providerRequestId: providerRequest.providerRequestId,
      role: 'coder',
      requestContentDigest: computeRequestContentDigest(providerRequest),
      providerId: providerIdentity.providerId,
      modelId: providerIdentity.modelId,
      configId: providerIdentity.configId,
      configVersion: providerIdentity.configVersion,
      decisionAuthorityGeneration: providerIdentity.decisionAuthorityGeneration,
    });
    const journal = statePort.getJournalSnapshot();
    const context = createTestProviderAdmissionContextV02({
      providerRequest,
      providerIdentity,
      providerAdmissionReceipt,
      taskId: request.task.taskId,
      runId: request.state.runId,
      runnableNode: 'Investigate',
      role: 'coder',
      expectedTaskStateVersion: request.state.stateVersion,
      expectedControlVersion: journal.controlVersion,
      expectedEpoch: journal.epoch,
      planApplicability: 'pre-plan-diagnostic',
      diagnosticPurpose: 'diagnose-zero-denominator',
      taskCriteriaDigest: computeCanonicalSha256(request.task.acceptanceCriteria),
      budgetRefs: [
        `task-tokens:${providerRequest.providerRequestId}`,
        `task-cost:${providerRequest.providerRequestId}`,
        `run-tokens:${providerRequest.providerRequestId}`,
        `run-cost:${providerRequest.providerRequestId}`,
      ],
    });
    // The shared fixture always seeds approved-plan fields; a pre-plan diagnostic forbids them.
    const prePlan = context as unknown as Record<string, unknown>;
    delete prePlan['planBindingDigest'];
    delete prePlan['planDecisionRef'];
    return { request: providerRequest, context, trustedContext: createTestProviderAdmissionTrustedContextV02(context) };
  };
}

/**
 * The controlled route with `generation` and no supplied answer. `admission` picks the coder source:
 * the owner resolver (default), a replacement over it, or none at all.
 */
function createGenerateRoute(agent: CoderAgent, admission: 'owner' | 'none' | ((resolve: UC03CoderAdmissionResolver) => UC03CoderAdmissionResolver) = 'owner') {
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
  const transitionContexts = createPlanApprovalContext(task, MODEL_PLAN.strategy);
  const planApproval = transitionContexts[2]?.approval;
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
  const trustedExpectedContext: TrustedHostExpectedContext = {
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
    reviewerPort: new ScriptedReviewerPort(),
    hostAuthority: createMockHostAuthority(),
    baselineEvidenceWriter: createMockBaselineEvidenceWriter(),
    executionGuard,
  };
  const resolveAdmission = createCoderAdmissionResolver(statePort);
  const coderAdmission = admission === 'none' ? undefined : admission === 'owner' ? resolveAdmission : admission(resolveAdmission);
  const config: UC03GraphConfig = {
    mode: 'production',
    generation: { agent, budget: AGENT_BUDGET },
    trustedExpectedContext,
    ...(coderAdmission ? { coderAdmission } : {}),
  };
  return { task, ports, statePort, config };
}

async function seedRoute(task: BugTask, statePort: MemoryStatePortV02): Promise<TaskState> {
  const state = createGraphTaskState(task, { evidenceRefs: ['src/calculator.py'] });
  await seedGraphTaskState(statePort, state);
  return state;
}

test('production generation refuses a supplied plan before any owner effect', async () => {
  const { task, ports, statePort, approvalPort, repositoryPort } = setup();
  const seeded = await seed(task, statePort, {});
  const agent = unusedAgent();
  const result = await createInvestigateNode(ports, { ...production(agent), planDetails: PLAN_DETAILS })(graphState(task, seeded));

  assert.equal(result.terminalOutcome, 'INCOMPLETE');
  assert.match(result.reasons?.[0] ?? '', /^REAL_PROFILE_SUPPLIED_ANSWER_REFUSED: Investigate takes no config\.planDetails/u);
  assert.equal(result.state, undefined);
  assert.deepEqual(await statePort.loadTask(task.taskId), seeded);
  assert.deepEqual(approvalPort.getRecordedBindings(), []);
  assert.deepEqual(repositoryPort.reads, []);
  assert.equal(agent.counters.modelCalls, 0);
});

test('production generation without a supplied answer reports the unwired seam instead of calling the agent', async () => {
  const agent = unusedAgent();
  const { task, ports, statePort, config } = createGenerateRoute(agent, 'none');
  const seeded = await seedRoute(task, statePort);
  const result = await createInvestigateNode(ports, config)(graphState(task, seeded));

  assert.equal(result.terminalOutcome, 'INCOMPLETE');
  assert.match(result.reasons?.[0] ?? '', /^REAL_PROFILE_GENERATION_UNWIRED: no owner-issued coder admission/u);
  const persisted = await statePort.loadTask(task.taskId);
  assert.equal(persisted?.node, 'Investigate');
  assert.equal(persisted?.plan, undefined);
  assert.equal(agent.counters.modelCalls, 0);
});

test('production generation obtains a plan proposal from the model and pauses at AwaitPlan', async () => {
  const agent = createCoderAgent({ propose, repository: new FakeRepositoryPort(), budget: AGENT_BUDGET });
  const { task, ports, statePort, config } = createGenerateRoute(agent);
  const seeded = await seedRoute(task, statePort);
  const result = await createInvestigateNode(ports, config)(graphState(task, seeded));

  assert.equal(result.terminalOutcome, undefined, result.reasons?.join(' | '));
  assert.equal(result.state?.node, 'AwaitPlan');
  assert.equal(result.state?.plan?.diagnosis, MODEL_PLAN.diagnosis);
  assert.equal(result.state?.plan?.strategy, MODEL_PLAN.strategy);
  assert.equal(result.state?.activeDecisionId, `dec-plan-${task.taskId}-1`);
  assert.equal(agent.counters.modelCalls, 1);
  assert.equal(agent.counters.modelOutputFailures, 0);
});

test('production generation refuses an admission that does not bind the current state', async () => {
  const agent = unusedAgent();
  const { task, ports, statePort, config } = createGenerateRoute(agent, resolve => async request => {
    const admission = await resolve(request);
    return admission && { ...admission, context: { ...admission.context, expectedTaskStateVersion: 99 } };
  });
  const seeded = await seedRoute(task, statePort);
  const result = await createInvestigateNode(ports, config)(graphState(task, seeded));

  assert.equal(result.terminalOutcome, 'INCOMPLETE');
  assert.match(result.reasons?.[0] ?? '', /does not bind the current task, run, state/u);
  assert.equal(agent.counters.modelCalls, 0);
  const coderRequestId = `provider-coder-${task.taskId}-${seeded.stateVersion}`;
  const taskTokens = statePort.getLedgers().find(ledger => ledger.scope === 'task' && ledger.kind === 'tokens');
  assert.equal(
    taskTokens?.reservations.some(reservation => reservation.keyedId === coderRequestId),
    false,
  );
});

test('production generation refuses supplied patch and repair answers before any effect', async () => {
  const agent = unusedAgent();

  const patchSetup = setup();
  const patchState = await seed(patchSetup.task, patchSetup.statePort, { node: 'Patch' });
  const patch = await createPatchNode(patchSetup.ports, { ...production(agent), patchContent: '--- a/src/calculator.py\n+++ b/src/calculator.py\n', targetPaths: ['src/calculator.py'] })(
    graphState(patchSetup.task, patchState),
  );
  assert.equal(patch.terminalOutcome, 'INCOMPLETE');
  assert.match(patch.reasons?.[0] ?? '', /^REAL_PROFILE_SUPPLIED_ANSWER_REFUSED: Patch takes no config\.patchContent/u);
  assert.deepEqual(await patchSetup.statePort.loadTask(patchSetup.task.taskId), patchState);

  const repairSetup = setup();
  const repairState = await seed(repairSetup.task, repairSetup.statePort, { node: 'Repair' });
  const repair = await createRepairNode(repairSetup.ports, { ...production(agent), repairPatch: REPAIR_PATCH })(graphState(repairSetup.task, repairState));
  assert.equal(repair.terminalOutcome, 'INCOMPLETE');
  assert.match(repair.reasons?.[0] ?? '', /^REAL_PROFILE_SUPPLIED_ANSWER_REFUSED: Repair takes no config\.repairPatch/u);
  // The controlled no-proposal branch persists halt-no-repair-proposal; a refusal must not.
  assert.deepEqual(await repairSetup.statePort.loadTask(repairSetup.task.taskId), repairState);

  assert.equal(patchSetup.repositoryPort.patches.length, 0);
  assert.equal(repairSetup.repositoryPort.patches.length, 0);
  assert.equal(agent.counters.modelCalls, 0);
});

test('production generation refuses a supplied revised plan before any replan reservation', async () => {
  const { task, ports, statePort, repositoryPort } = setup();
  const agent = unusedAgent();
  const baselineRef = task.initialRevisionDigest;
  const strategy = 'retain the current bounded strategy';
  const plan: FixPlan = {
    planVersion: 1,
    diagnosis: 'zero denominator is unguarded',
    suspectedCauseLocations: ['src/calculator.py'],
    evidenceRefs: [baselineRef],
    strategy,
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    baselineRef,
    strategyDigest: computeCanonicalSha256(strategy),
    decisionRef: 'decision-agent-route-001',
  };
  const feedback = await seed(task, statePort, { node: 'AwaitFeedback', plan, evidenceRefs: [baselineRef], nextAction: 'await-human-feedback-and-direction' });
  const direction = {
    directive: 'revise' as const,
    taskId: feedback.taskId,
    workspaceId: feedback.workspaceId,
    repositoryRevisionDigest: feedback.repositoryRevisionDigest,
    stateVersion: feedback.stateVersion,
    planVersion: feedback.planVersion,
    rejectedDecisionId: plan.decisionRef as string,
    strategyDigest: plan.strategyDigest,
  };
  const revisedPlan: FixPlan = { ...plan, strategy: 'guard zero explicitly', strategyDigest: computeCanonicalSha256('guard zero explicitly') };

  const result = await createAwaitFeedbackNode(ports, { ...production(agent), trustedDirection: direction, revisedPlan })(graphState(task, feedback));
  assert.equal(result.terminalOutcome, 'INCOMPLETE');
  assert.match(result.reasons?.[0] ?? '', /^REAL_PROFILE_SUPPLIED_ANSWER_REFUSED: AwaitFeedback takes no config\.revisedPlan/u);
  assert.deepEqual(await statePort.loadTask(task.taskId), feedback);
  assert.equal(statePort.getLedgers().find(ledger => ledger.scope === 'task' && ledger.kind === 'replan')?.consumed, 0);
  assert.equal(repositoryPort.patches.length, 0);
  assert.equal(agent.counters.modelCalls, 0);
});

test('a revise direction at AwaitFeedback persists a replan that keeps the baseline evidence ID', async () => {
  // Verification and completion bind the baseline evidence ID, not the revision digest; a replan
  // that replaced it with `initialRevisionDigest` could never complete.
  const { task, ports, statePort } = setup();
  const baselineRef = `uc04://baseline/${task.taskId}/1`;
  const strategy = 'retain the current bounded strategy';
  const plan: FixPlan = {
    planVersion: 1,
    diagnosis: 'zero denominator is unguarded',
    suspectedCauseLocations: ['src/calculator.py'],
    evidenceRefs: [baselineRef],
    strategy,
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    baselineRef,
    strategyDigest: computeCanonicalSha256(strategy),
    decisionRef: 'decision-agent-route-002',
  };
  const feedback = await seed(task, statePort, { node: 'AwaitFeedback', plan, evidenceRefs: [baselineRef], nextAction: 'await-human-feedback-and-direction' });
  const direction = {
    directive: 'revise' as const,
    taskId: feedback.taskId,
    workspaceId: feedback.workspaceId,
    repositoryRevisionDigest: feedback.repositoryRevisionDigest,
    stateVersion: feedback.stateVersion,
    planVersion: feedback.planVersion,
    rejectedDecisionId: plan.decisionRef as string,
    strategyDigest: plan.strategyDigest,
  };
  const revised: FixPlan = { ...plan, decisionRef: undefined, evidenceRefs: ['src/calculator.py'] };

  const result = await createAwaitFeedbackNode(ports, { mode: 'development', trustedDirection: direction, revisedPlan: revised })(graphState(task, feedback));
  assert.equal(result.terminalOutcome, undefined, result.reasons?.join(' | '));
  assert.equal(result.state?.node, 'AwaitPlan');
  assert.equal(result.state?.plan?.baselineRef, baselineRef);
  assert.equal(result.state?.plan?.decisionRef, undefined);
  assert.equal(statePort.getLedgers().find(ledger => ledger.scope === 'task' && ledger.kind === 'replan')?.reservations.length, 0);

  // A candidate that swaps the evidence ID for the revision digest is refused, not silently persisted.
  const rejecting = setup();
  const stale = await seed(rejecting.task, rejecting.statePort, { node: 'AwaitFeedback', plan, evidenceRefs: [baselineRef], nextAction: 'await-human-feedback-and-direction' });
  const refused = await createAwaitFeedbackNode(rejecting.ports, {
    mode: 'development',
    trustedDirection: { ...direction, taskId: stale.taskId, stateVersion: stale.stateVersion },
    revisedPlan: { ...revised, baselineRef: rejecting.task.initialRevisionDigest },
  })(graphState(rejecting.task, stale));
  assert.equal(refused.terminalOutcome, 'INCOMPLETE');
  assert.deepEqual(refused.reasons, ['candidate-plan-binding-mismatch']);
  assert.deepEqual(await rejecting.statePort.loadTask(rejecting.task.taskId), stale);
});

test('production generation still lets a human wait and a human stop through', async () => {
  // Generation answers the revise branch only. A human pause or terminate must never be
  // converted into a generation refusal, which would strand the run at propose-fix-plan.
  const waiting = setup();
  const paused = await seed(waiting.task, waiting.statePort, { node: 'AwaitFeedback' });
  const wait = await createAwaitFeedbackNode(waiting.ports, production(unusedAgent()))(graphState(waiting.task, paused));
  assert.equal(wait.terminalOutcome, 'needs-info');
  assert.equal(wait.reasons, undefined);

  const stopping = setup();
  const pausedForStop = await seed(stopping.task, stopping.statePort, { node: 'AwaitFeedback' });
  const stop = await createAwaitFeedbackNode(stopping.ports, {
    ...production(unusedAgent()),
    trustedDirection: {
      directive: 'terminate',
      taskId: pausedForStop.taskId,
      workspaceId: pausedForStop.workspaceId,
      repositoryRevisionDigest: pausedForStop.repositoryRevisionDigest,
      stateVersion: pausedForStop.stateVersion,
      planVersion: pausedForStop.planVersion,
      rejectedDecisionId: pausedForStop.plan?.decisionRef as string,
      strategyDigest: pausedForStop.plan?.strategyDigest as string,
    },
  })(graphState(stopping.task, pausedForStop));
  assert.equal(stop.terminalOutcome, 'INCOMPLETE');
  assert.equal(stop.reasons, undefined);
  assert.equal((await stopping.statePort.loadTask(stopping.task.taskId))?.nextAction, 'human-directed-termination');
});

test('the controlled route is unchanged without generation', async () => {
  // Repair without a proposal still persists the controlled halt, not the real-profile refusal.
  const controlled = setup();
  const repairState = await seed(controlled.task, controlled.statePort, { node: 'Repair' });
  const repair = await createRepairNode(controlled.ports, { mode: 'development' })(graphState(controlled.task, repairState));
  assert.equal(repair.terminalOutcome, 'INCOMPLETE');
  assert.deepEqual(repair.reasons, ['No repair patch proposal provided']);
  const halted = await controlled.statePort.loadTask(controlled.task.taskId);
  assert.equal(halted?.node, 'Incomplete');
  assert.equal(halted?.nextAction, 'halt-no-repair-proposal');

  // A non-production mode keeps the controlled supplied-answer branch reachable, with no agent call.
  const development = setup();
  const agent = unusedAgent();
  const investigateState = await seed(development.task, development.statePort, {});
  const result = await createInvestigateNode(development.ports, { mode: 'development', generation: { agent } })(graphState(development.task, investigateState));
  assert.equal(result.terminalOutcome, 'INCOMPLETE');
  assert.deepEqual(result.reasons, ['Investigation requires explicit plan, host snapshot, and v0.2 admission configuration']);
  assert.deepEqual(await development.statePort.loadTask(development.task.taskId), investigateState);
  assert.equal(agent.counters.modelCalls, 0);

  // The config accepts a real CoderAgent in the generation slot.
  assert.equal(scriptedAgent().counters.modelCalls, 0);
});
