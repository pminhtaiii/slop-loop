/**
 * UC-03 Verified Code Repair - Unit Tests for Gated LangGraph Route & CLI
 *
 * Owned path: tests/runtime/unit/uc03-graph.test.ts
 * Feature: specs/001-verified-code-repair
 * Task: T026 (wire gated LangGraph route and thin entry point)
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  computeActionDigest,
  computeCanonicalSha256,
  computeCheckSetDigest,
  computeRequestContentDigest,
  type Baseline,
  type ApprovalBindingContext,
  type ApprovalBinding,
  type ApprovalPort,
  type BugTask,
  type ClaimReceiptV02,
  type FixPlan,
  type ProviderAdmissionContextV02,
  type ProviderRequest,
  type ProviderPricingIdentityV02,
  type PolicyAuthorityRefV02,
  type ReviewResult,
  type SourceEvidence,
  type StateTransitionOptions,
  type TaskState,
  type VerificationResult,
  validateStateTransition,
} from '../../../src/contracts/foundation/uc03.ts';
import {
  runUC03Graph,
  type UC03GraphPorts,
  type UC03GraphState,
} from '../../../src/uc03/graph.ts';
import { createAwaitFeedbackNode, validSettledPatchEvidence } from '../../../src/uc03/graph-validation.ts';
import { createRepairNode } from '../../../src/uc03/graph-nodes.ts';
import {
  runUC03Cli,
} from '../../../src/cli/uc03.ts';
import {
  createFixtureBugTask,
  createFixtureCheckDefinition,
  createFixtureExecutorIdentityV02,
  createFixturePolicyAuthorityRefV02,
  createFixtureProviderAdmissionReceiptV02,
} from '../support/uc03/port-fixtures.ts';
import { createGraphRepositoryPort, createGraphTaskState, seedGraphTaskState } from '../support/uc03/graph-fixtures.ts';
import {
  createTestApprovalBinding,
  createTestProviderAdmissionContextV02,
  createTestProviderAdmissionTrustedContextV02,
  createTestProviderOutcomeReceiptV02,
  createTestProviderRequest,
  createTestRepositoryAdmissionContextV02,
  createTestRepositoryCommandAdmissionContextV02,
  createTestRepositoryAdmissionTrustedContextV02,
  createTestClaimReceiptV02,
} from '../support/uc03/state-fixtures.ts';
import { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';
import { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import { ScriptedModelPort } from '../support/uc03/scripted-model.ts';
import type {
  TrustedHostPort,
  TrustedHostSnapshot,
  TrustedHostSnapshotRequest,
  TrustedHostExpectedContext,
  BaselineEvidenceWriter,
  BaselineEvidenceWriteRequest,
  BaselineEvidenceAcknowledgement,
} from '../../../src/uc03/investigation.ts';
import { computeTestProtectionDigest } from '../../../src/uc03/investigation.ts';
import { createExecutionGuardV02 } from '../../../src/foundation/execution-guard.ts';
import { transitionState } from '../../../src/uc03/graph-validation.ts';
import { validReviewerClaim } from '../../../src/uc03/graph-types.ts';

function createMockHostAuthority(
  expectedTestFileContent = 'def test_divide(): pass\n'
): TrustedHostPort {
  return {
    async loadSnapshot(request: TrustedHostSnapshotRequest): Promise<TrustedHostSnapshot> {
      const testFilePath = 'tests/test_calculator.py';
      return {
        taskId: request.taskId,
        workspaceId: request.workspaceId,
        repositoryId: request.repositoryId,
        currentRevision: request.expectedRevisionDigest,
        checkSetDigest: request.expectedCheckSetDigest,
        testFiles: [
          {
            path: testFilePath,
            content: expectedTestFileContent,
          },
        ],
        expectedTestFiles: request.expectedTestFiles,
      };
    },
  };
}

function createMockBaselineEvidenceWriter(onPersist?: (request: BaselineEvidenceWriteRequest) => void): BaselineEvidenceWriter {
  return {
    async persistBaselineEvidence(request: BaselineEvidenceWriteRequest): Promise<BaselineEvidenceAcknowledgement> {
      onPersist?.(request);
      const { content } = request;
      return {
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
        requiredCheckIds: content.requiredChecks.map((c) => c.checkId),
      };
    },
  };
}

interface ControllableApprovalPort extends ApprovalPort {
  setDecision(d: 'approved' | 'pending' | 'rejected'): void;
}

function createControllableApprovalPort(
  initialDecision: 'approved' | 'pending' | 'rejected' = 'approved'
): ControllableApprovalPort {
  let currentDecision = initialDecision;
  let currentBinding: ApprovalBinding | undefined;
  return {
    provenance: 'mock' as const,
    setDecision(d: 'approved' | 'pending' | 'rejected') {
      currentDecision = d;
    },
    async classify() {
      return 'APPROVAL_REQUIRED' as const;
    },
    async requestDecision(binding: ApprovalBinding): Promise<ApprovalBinding> {
      currentBinding = binding;
      return {
        ...binding,
        status: currentDecision,
        ...(currentDecision === 'rejected' ? { reason: 'explicit rejection' } : {}),
      };
    },
    async validateBinding(binding: ApprovalBinding): Promise<boolean> {
      return currentDecision === 'approved' && binding.status === 'approved' && currentBinding?.decisionId === binding.decisionId;
    },
    async resolve(decisionId: string): Promise<ApprovalBinding> {
      if (!currentBinding || currentBinding.decisionId !== decisionId) throw new Error('Decision binding was not persisted by the approval owner');
      return {
        ...currentBinding,
        status: currentDecision,
        ...(currentDecision === 'rejected' ? { reason: 'explicit rejection' } : {}),
      };
    },
  };
}

interface ControllableReviewerPort {
  readonly provenance: 'mock' | 'real';
  review(
    task: BugTask,
    diff: string,
    evidence: readonly SourceEvidence[],
    request: ProviderRequest,
    admission: ProviderAdmissionContextV02,
    claim: ClaimReceiptV02,
  ): Promise<ReviewResult>;
  setStatus(s: 'accepted' | 'findings'): void;
}

function createControllableReviewerPort(
  repositoryPort: FakeRepositoryPort,
  statePort: MemoryStatePortV02,
  initialStatus: 'accepted' | 'findings' = 'accepted'
): ControllableReviewerPort {
  let currentStatus = initialStatus;
  return {
    provenance: 'mock' as const,
    setStatus(s: 'accepted' | 'findings') {
      currentStatus = s;
    },
    async review(
      task: BugTask,
      diff: string,
      _evidence,
      request: ProviderRequest,
      admission: ProviderAdmissionContextV02,
      claim: ClaimReceiptV02,
    ): Promise<ReviewResult> {
      if (!claim.claimId) throw new Error('Persisted reviewer allowance was not supplied by the route');
      const attempt = await statePort.beginAttempt(
        claim.claimId,
        createFixtureExecutorIdentityV02({ payloadDigest: computeRequestContentDigest(request) }),
      );
      if (!attempt.attemptId) throw new Error('Persisted reviewer attempt was refused');
      const outcome = await statePort.recordOutcome(createTestProviderOutcomeReceiptV02(claim, attempt, admission));
      if (outcome.outcome !== 'settled') throw new Error('Persisted reviewer allowance did not settle');
      return {
        reviewId: `review-${request.providerRequestId}`,
        status: currentStatus,
        repoDigest: repositoryPort.currentRevision,
        diffDigest: computeCanonicalSha256(diff || ''),
        checkSetDigest: computeCheckSetDigest(task.requiredChecks),
        reviewerRoleConfigId: admission.providerIdentity.configId,
        iterationReservationRef: request.reservationRef,
        findings: currentStatus === 'findings'
          ? [
              {
                file: 'src/calculator.py',
                line: 2,
                side: 'new',
                severity: 'error',
                message: 'Zero check missing',
              },
            ]
          : [],
      };
    },
  };
}

const ROUTE_PLAN_DETAILS = {
  diagnosis: 'The divide implementation lacks a zero denominator guard.',
  strategy: 'Reject a zero denominator before division.',
  suspectedCauseLocations: ['src/calculator.py'],
  scopedChanges: ['src/calculator.py'],
  decisionRef: 'decision-route-test-001',
} as const;

function createGraphState(input: {
  task: BugTask;
  state: TaskState;
  baseline?: Baseline;
  failureEvidence?: readonly (VerificationResult | ReviewResult)[];
  patchAdmission?: UC03GraphState['patchAdmission'];
  patchReceipt?: UC03GraphState['patchReceipt'];
}): UC03GraphState {
  return {
    task: input.task, state: input.state, baseline: input.baseline,
    verificationResults: [], reviewResult: undefined, reviewRequest: undefined,
    patchAdmission: input.patchAdmission, patchReceipt: input.patchReceipt,
    failureEvidence: input.failureEvidence ?? [], finalReport: undefined, reasons: [],
    terminalOutcome: undefined, milestones: [],
  };
}

function createPlanApprovalContext(task: BugTask): Readonly<Record<number, NonNullable<StateTransitionOptions['trusted']>>> {
  const state = createGraphTaskState(task);
  const baselineRef = `uc04://baseline/${task.taskId}/1`;
  const evidenceRefs = [baselineRef];
  const checkSetDigest = computeCheckSetDigest(task.requiredChecks);
  const strategyDigest = computeCanonicalSha256(ROUTE_PLAN_DETAILS.strategy);
  const action = {
    actionId: ROUTE_PLAN_DETAILS.decisionRef,
    kind: 'approve_fix_plan' as const,
    planVersion: state.planVersion,
    strategyDigest,
    diagnosisEvidenceRefs: evidenceRefs,
    checkSetDigest,
  };
  const digest = computeCanonicalSha256(action);
  const binding = createTestApprovalBinding({
    decisionId: ROUTE_PLAN_DETAILS.decisionRef,
    actionKind: 'fix_plan',
    normalizedActionDigest: digest,
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
  const freshness: ApprovalBindingContext = {
    currentTaskId: task.taskId,
    currentWorkspaceId: state.workspaceId,
    currentRepositoryRevisionDigest: task.initialRevisionDigest,
    currentPolicyId: task.configId,
    currentPolicyVersion: task.configVersion,
    currentNormalizedActionDigest: digest,
    currentPlanVersion: state.planVersion,
    currentStrategyDigest: strategyDigest,
    currentBaselineRef: baselineRef,
    currentEvidenceRefs: evidenceRefs,
    currentCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    currentCheckSetDigest: checkSetDigest,
  };
  return { 3: { approval: { binding, freshness } } };
}

test('Mock route approval fixture binds its transition to the exact generated plan', () => {
  const task = createFixtureBugTask();
  const initial = createGraphTaskState(task);
  const baselineRef = `uc04://baseline/${task.taskId}/1`;
  const plan: FixPlan = {
    planVersion: initial.planVersion,
    diagnosis: ROUTE_PLAN_DETAILS.diagnosis,
    suspectedCauseLocations: ROUTE_PLAN_DETAILS.suspectedCauseLocations,
    evidenceRefs: [baselineRef],
    strategy: ROUTE_PLAN_DETAILS.strategy,
    scopedChanges: ROUTE_PLAN_DETAILS.scopedChanges,
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    baselineRef,
    strategyDigest: computeCanonicalSha256(ROUTE_PLAN_DETAILS.strategy),
    decisionRef: ROUTE_PLAN_DETAILS.decisionRef,
  };
  const current: TaskState = {
    ...initial,
    stateVersion: 2,
    node: 'AwaitPlan',
    plan,
    activeDecisionId: ROUTE_PLAN_DETAILS.decisionRef,
    evidenceRefs: [baselineRef],
  };
  const next: TaskState = { ...current, stateVersion: 3, node: 'Patch', nextAction: 'apply-patch' };
  const trusted = createPlanApprovalContext(task)[3];
  assert.ok(trusted?.approval);
  const validation = validateStateTransition(current, next, { trusted });
  assert.ok(validation.ok, validation.ok ? '' : validation.errors.map((error) => error.message).join('; '));
});

function createResourceReservationRefs(actionId: string): readonly string[] {
  const kinds = ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'] as const;
  return (['task', 'run'] as const).flatMap((scope) => kinds.map((kind) => `${scope}:${kind}:${actionId}`));
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

function createMockPatchAdmissionResolver(repositoryPort: FakeRepositoryPort, statePort: MemoryStatePortV02) {
  return async ({ task, state, patchContent, targetPaths, actionId }: {
    readonly task: BugTask;
    readonly state: TaskState;
    readonly patchContent: string;
    readonly targetPaths: readonly string[];
    readonly actionId?: string | undefined;
  }) => {
    if (state.node === 'Patch') repositoryPort.setCommandResult('pytest -q tests/test_calculator.py -k test_divide_zero', { exitCode: 0, stdout: '1 passed', stderr: '' });
    const action = {
      actionId: actionId ?? `patch-${state.taskId}-${state.stateVersion}`,
      kind: 'apply_patch' as const,
      patchContent,
      targetPaths,
      baseRevisionDigest: state.repositoryRevisionDigest,
    };
    const journal = statePort.getJournalSnapshot();
    const context = createTestRepositoryAdmissionContextV02({
      taskId: state.taskId,
      runId: state.runId,
      workspaceId: state.workspaceId,
      repositoryId: state.repositoryId,
      canonicalRevision: state.repositoryRevisionDigest,
      expectedTaskStateVersion: state.stateVersion,
      expectedControlVersion: journal.controlVersion,
      expectedEpoch: journal.epoch,
      action,
      planDecisionRef: state.plan?.decisionRef,
      planBindingDigest: createPlanBindingDigest(task, state),
      reservationRefs: [`repair-slot:${state.taskId}:${state.stateVersion}`],
      runnableNode: state.node,
      planApplicability: 'approved-plan',
    });
    repositoryPort.setExecutorIdentity(createFixtureExecutorIdentityV02({ payloadDigest: computeActionDigest(action) }));
    return { context, trustedContext: createTestRepositoryAdmissionTrustedContextV02(context) };
  };
}

function createMockReviewerAdmissionResolver(statePort: MemoryStatePortV02) {
  return async ({ task, state, diff }: {
    readonly task: BugTask;
    readonly state: TaskState;
    readonly diff: { readonly diff: string; readonly diffDigest: string; readonly changedFiles: readonly string[] };
  }) => {
    const request = createTestProviderRequest({
      providerRequestId: `provider-${task.taskId}-${state.stateVersion}`,
      taskId: task.taskId,
      runId: state.runId,
      role: 'reviewer',
      purpose: 'final-review',
      contextDigest: diff.diffDigest,
      reservationRef: `review-allowance:${task.taskId}:${state.stateVersion}`,
    });
    const providerIdentity: ProviderPricingIdentityV02 = {
      providerId: request.providerId,
      modelId: request.modelId,
      configId: request.configId,
      configVersion: '1.0.0',
      pricingPolicyId: request.pricingPolicyId,
      pricingPolicyVersion: '1.0.0',
      issuerKeyRef: 'key-authority-provider-001',
      decisionAuthorityGeneration: 4,
    };
    const providerAdmissionReceipt = createFixtureProviderAdmissionReceiptV02({
      providerRequestId: request.providerRequestId,
      role: 'reviewer',
      requestContentDigest: computeRequestContentDigest(request),
      providerId: providerIdentity.providerId,
      modelId: providerIdentity.modelId,
      configId: providerIdentity.configId,
      configVersion: providerIdentity.configVersion,
      decisionAuthorityGeneration: providerIdentity.decisionAuthorityGeneration,
    });
    const authorityRef: PolicyAuthorityRefV02 = {
      policyId: providerIdentity.pricingPolicyId,
      policyVersion: providerIdentity.pricingPolicyVersion,
      configId: providerIdentity.configId,
      configVersion: providerIdentity.configVersion,
      issuerKeyRef: providerIdentity.issuerKeyRef,
      decisionAuthorityGeneration: providerIdentity.decisionAuthorityGeneration,
    };
    const publication = await statePort.publishAuthority({ authorityRef });
    if (publication.status !== 'published') return undefined;
    const journal = statePort.getJournalSnapshot();
    const context = createTestProviderAdmissionContextV02({
      providerRequest: request,
      providerIdentity,
      providerAdmissionReceipt,
      taskId: task.taskId,
      runId: state.runId,
      runnableNode: 'Review',
      role: 'reviewer',
      expectedTaskStateVersion: state.stateVersion,
      expectedControlVersion: journal.controlVersion,
      expectedEpoch: journal.epoch,
      planApplicability: 'approved-plan',
      planDecisionRef: state.plan?.decisionRef,
      planBindingDigest: createPlanBindingDigest(task, state),
      budgetRefs: [
        `task-tokens:${request.providerRequestId}`,
        `task-cost:${request.providerRequestId}`,
        `run-tokens:${request.providerRequestId}`,
        `run-cost:${request.providerRequestId}`,
        `task-iteration:${request.providerRequestId}`,
      ],
    });
    return { request, context, trustedContext: createTestProviderAdmissionTrustedContextV02(context) };
  };
}

function createTestSetup(overrides?: {
  taskOverrides?: Partial<BugTask>;
  initialDecision?: 'approved' | 'pending' | 'rejected';
  initialReviewStatus?: 'accepted' | 'findings';
  transitionContexts?: Readonly<Record<number, NonNullable<StateTransitionOptions['trusted']>>>;
}) {
  const checkRepro = createFixtureCheckDefinition({
    checkId: 'check-pytest-reproduction',
    executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py', '-k', 'test_divide_zero'],
    purpose: 'reproduction',
  });
  const checkRegression = createFixtureCheckDefinition({
    checkId: 'check-pytest-regression',
    executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py'],
    purpose: 'regression',
  });

  const task = createFixtureBugTask({
    requiredChecks: [checkRepro, checkRegression],
    ...overrides?.taskOverrides,
  });

  const transitionContexts = { ...createPlanApprovalContext(task), ...(overrides?.transitionContexts ?? {}) };
  const statePort = new MemoryStatePortV02({
    transitionContexts,
    initialAuthorityRef: createFixturePolicyAuthorityRefV02({ decisionAuthorityGeneration: 3 }),
  });

  const repositoryPort = new FakeRepositoryPort({
    initialRevision: task.initialRevisionDigest,
    initialFiles: {
      'tests/test_calculator.py': 'def test_divide(): pass\n',
      'src/calculator.py': 'def divide(a, b): return a / b\n',
    },
    commandResults: {
      'pytest -q tests/test_calculator.py -k test_divide_zero': {
        exitCode: 1,
        stdout: 'FAILED tests/test_calculator.py::test_divide_zero - ZeroDivisionError: division by zero',
        stderr: '',
      },
      'pytest -q tests/test_calculator.py': {
        exitCode: 0,
        stdout: '1 passed',
        stderr: '',
      },
      default: {
        exitCode: 0,
        stdout: '1 passed',
        stderr: '',
      },
    },
  });
  repositoryPort.setStatePort(statePort);
  const ownerSettledRepositoryPort = createGraphRepositoryPort(repositoryPort, statePort);

  const approvalPort = createControllableApprovalPort(overrides?.initialDecision ?? 'approved');
  const modelPort = new ScriptedModelPort();
  const reviewerPort = createControllableReviewerPort(repositoryPort, statePort, overrides?.initialReviewStatus ?? 'accepted');
  const executionGuard = createExecutionGuardV02({ ports: { statePort, repositoryPort: ownerSettledRepositoryPort, approvalPort } });
  const hostAuthority = createMockHostAuthority();
  let baselineEvidenceRequest: BaselineEvidenceWriteRequest | undefined;
  const baselineEvidenceWriter = createMockBaselineEvidenceWriter((request) => { baselineEvidenceRequest = request; });

  // Verification results for post-patch
  repositoryPort.setTestResult('check-pytest-reproduction', {
    checkId: 'check-pytest-reproduction',
    outcome: 'pass',
    outputExcerpt: '1 passed',
    durationMs: 100,
  });
  repositoryPort.setTestResult('check-pytest-regression', {
    checkId: 'check-pytest-regression',
    outcome: 'pass',
    outputExcerpt: '1 passed',
    durationMs: 100,
  });

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
    admissionContextForCheck: ({ check, action, currentState }) => {
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
        action,
        reservationRefs: createResourceReservationRefs(action.actionId),
        runnableNode: isVerify ? 'Verify' : 'Investigate',
        planApplicability: isVerify ? 'approved-plan' : 'pre-plan-diagnostic',
        diagnosticPurpose: isVerify ? undefined : check.purpose,
        taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
        checkSetDigest: computeCheckSetDigest(task.requiredChecks),
        checkId: check.checkId,
        testPath: 'tests/test_calculator.py',
        planBindingDigest,
        planDecisionRef: isVerify ? currentState.plan?.decisionRef : undefined,
      });
      repositoryPort.setExecutorIdentity(createFixtureExecutorIdentityV02({ payloadDigest: computeActionDigest(action) }));
      return context;
    },
  };

  const ports: UC03GraphPorts = {
    statePort: statePort.getUnderlying(),
    approvalPort,
    repositoryPort: ownerSettledRepositoryPort,
    modelPort,
    reviewerPort,
    hostAuthority,
    baselineEvidenceWriter,
    executionGuard,
  };

  return {
    task,
    ports,
    statePort,
    repositoryPort,
    approvalPort,
    modelPort,
    reviewerPort,
    hostAuthority,
    baselineEvidenceWriter,
    executionGuard,
    trustedExpectedContext,
    get baselineEvidenceRequest() { return baselineEvidenceRequest; },
  };
}

/* ------------------------------------------------------------------
 * 1. Production Mode Fail-Closed & Provenance Guard
 * ------------------------------------------------------------------ */

test('Production guard: refuses mock dependencies and real dispatch when mode is production', async () => {
  const { task, ports } = createTestSetup();

  assert.equal(ports.statePort.provenance, 'mock');
  assert.equal(ports.repositoryPort.provenance, 'mock');

  const result = await runUC03Graph(task, ports, { mode: 'production' });

  assert.equal(result.outcome, 'INCOMPLETE');
  assert.ok(
    result.reasons.some((r) => r.includes('PRODUCTION_ADMISSION_REFUSED')),
    `Expected PRODUCTION_ADMISSION_REFUSED in reasons, got: ${result.reasons.join(', ')}`
  );
  assert.equal(result.finalReport, undefined);
});

test('State transition rejection propagates instead of returning the proposed state', async () => {
  const task = createFixtureBugTask();
  const state = createGraphTaskState(task);
  const statePort = new MemoryStatePortV02({ initialTaskState: state }).getUnderlying();
  statePort.transition = async () => { throw new Error('CAS_CONFLICT'); };

  await assert.rejects(
    transitionState(statePort, { ...state, stateVersion: 2, node: 'AwaitPlan' }, 1),
    /CAS_CONFLICT/,
  );
});

test('Route exceptions return a fixed safe reason and do not expose exception text', async () => {
  const { task, ports, statePort, repositoryPort, trustedExpectedContext } = createTestSetup();
  await seedGraphTaskState(statePort, createGraphTaskState(task, { node: 'Validate' }));
  statePort.getUnderlying().transition = async () => { throw new Error('MARKER_SECRET_GRAPH_EXCEPTION'); };

  const result = await runUC03Graph(task, ports, {
    mode: 'development', trustedExpectedContext, planDetails: ROUTE_PLAN_DETAILS,
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.outcome, 'INCOMPLETE');
  assert.deepEqual(result.reasons, ['UC-03 route stopped after an unconfirmed owner transition']);
  assert.doesNotMatch(serialized, /MARKER_SECRET_GRAPH_EXCEPTION/u);
  assert.equal(repositoryPort.patches.length, 0);
  assert.equal(repositoryPort.commands.length, 0);
});

test('Reviewer dispatch claim must bind the current owner version and exact allowance refs', () => {
  const task = createFixtureBugTask();
  const state = createGraphTaskState(task);
  const request = createTestProviderRequest({
    taskId: state.taskId,
    runId: state.runId,
    role: 'reviewer',
    reservationRef: 'owner-review-reservation',
  });
  const budgetRefs = ['task-token-reservation', 'run-token-reservation', 'review-iteration-reservation'];
  const admission = createTestProviderAdmissionContextV02({
    taskId: state.taskId,
    runId: state.runId,
    providerRequest: request,
    runnableNode: 'Review',
    role: 'reviewer',
    expectedTaskStateVersion: state.stateVersion,
    requestReservationReceipt: request.reservationRef,
    budgetRefs,
  });
  const claim = createTestClaimReceiptV02({
    claimId: 'owner-review-claim',
    taskId: state.taskId,
    runId: state.runId,
    subjectKind: 'provider-request',
    planApplicability: 'approved-plan',
    preClaimTaskStateVersion: state.stateVersion,
    reservationRefs: [request.reservationRef, ...budgetRefs],
  });

  assert.equal(validReviewerClaim(claim, admission, state), true);
  assert.equal(validReviewerClaim(createTestClaimReceiptV02({ ...claim, reservationRefs: ['other-reservation'] }), admission, state), false);
  assert.equal(validReviewerClaim(createTestClaimReceiptV02({ ...claim, preClaimTaskStateVersion: state.stateVersion + 1 }), admission, state), false);
});

test('Rejected approval CAS halts before the graph enters Patch', async () => {
  const { task, ports, statePort, approvalPort, repositoryPort, reviewerPort, trustedExpectedContext } = createTestSetup({ initialDecision: 'pending' });
  await seedGraphTaskState(statePort, createGraphTaskState(task));
  const config = { mode: 'development' as const, trustedExpectedContext, planDetails: ROUTE_PLAN_DETAILS };
  const paused = await runUC03Graph(task, ports, config);
  assert.equal(paused.outcome, 'pending-approval');
  assert.equal(paused.state?.node, 'AwaitPlan');
  assert.ok(paused.state);
  assert.deepEqual(await statePort.loadTask(task.taskId), paused.state);

  approvalPort.setDecision('approved');
  const ownerBeforeRejectedCas = await statePort.loadTask(task.taskId);
  const transition = ports.statePort.transition.bind(ports.statePort);
  ports.statePort.transition = async (next, expectedVersion) => {
    if (next.node === 'Patch') throw new Error('CAS_CONFLICT');
    return transition(next, expectedVersion);
  };
  let diffReads = 0;
  let reviewerCalls = 0;
  const inspectDiff = repositoryPort.inspectDiff.bind(repositoryPort);
  const review = reviewerPort.review.bind(reviewerPort);
  repositoryPort.inspectDiff = async (revision) => { diffReads += 1; return inspectDiff(revision); };
  reviewerPort.review = async (...args) => { reviewerCalls += 1; return review(...args); };

  const result = await runUC03Graph(task, ports, {
    ...config,
    admissionContext: createMockPatchAdmissionResolver(repositoryPort, statePort),
    patchContent: 'diff --git a/src/calculator.py b/src/calculator.py\n',
    targetPaths: ['src/calculator.py'],
  }, paused.state);

  const persisted = await statePort.loadTask(task.taskId);
  assert.equal(result.outcome, 'INCOMPLETE');
  assert.deepEqual(result.state, ownerBeforeRejectedCas);
  assert.equal(result.finalReport, undefined);
  assert.deepEqual(result.reasons, ['UC-03 route stopped after an unconfirmed owner transition']);
  assert.doesNotMatch(JSON.stringify(result), /CAS_CONFLICT/u);
  assert.ok(persisted !== null);
  assert.equal(persisted.node, 'AwaitPlan');
  assert.deepEqual(result.state, persisted);
  assert.deepEqual(persisted.changedPaths, []);
  assert.equal(repositoryPort.patches.length, 0);
  assert.equal(diffReads, 0);
  assert.equal(reviewerCalls, 0);
});

test('Stale restored state is refused before repository, approval, or model effects', async () => {
  const { task, ports, statePort, repositoryPort, approvalPort, modelPort, hostAuthority } = createTestSetup();
  const current = createGraphTaskState(task);
  await seedGraphTaskState(statePort, current);
  let repositoryEffects = 0;
  let snapshotReads = 0;
  let approvalResolves = 0;
  let modelCalls = 0;
  const inspectDiff = repositoryPort.inspectDiff.bind(repositoryPort);
  const runTests = repositoryPort.runTests.bind(repositoryPort);
  const resolveDecision = approvalPort.resolve.bind(approvalPort);
  const propose = modelPort.propose.bind(modelPort);
  const loadSnapshot = hostAuthority.loadSnapshot.bind(hostAuthority);
  repositoryPort.inspectDiff = async (revision) => { repositoryEffects += 1; return inspectDiff(revision); };
  repositoryPort.runTests = async (check) => { repositoryEffects += 1; return runTests(check); };
  approvalPort.resolve = async (decisionId) => { approvalResolves += 1; return resolveDecision(decisionId); };
  modelPort.propose = async (...args) => { modelCalls += 1; return propose(...args); };
  hostAuthority.loadSnapshot = async (request) => { snapshotReads += 1; return loadSnapshot(request); };

  const result = await runUC03Graph(task, ports, { mode: 'development' }, { ...current, stateVersion: 2 });
  const invalidTaskResult = await runUC03Graph(
    { ...task, acceptanceCriteria: [] }, ports, { mode: 'development' }, current,
  );
  const crossTaskResult = await runUC03Graph(
    { ...task, taskId: 'task-cross-owner' }, ports, { mode: 'development' }, current,
  );

  assert.notEqual(result.outcome, 'COMPLETED');
  assert.equal(invalidTaskResult.outcome, 'needs-info');
  assert.notEqual(crossTaskResult.outcome, 'COMPLETED');
  assert.equal(repositoryEffects, 0);
  assert.equal(snapshotReads, 0);
  assert.equal(approvalResolves, 0);
  assert.equal(modelCalls, 0);
  const persisted = await statePort.loadTask(task.taskId);
  assert.equal(persisted?.stateVersion, current.stateVersion);
  assert.equal(persisted?.node, current.node);
});

test('AwaitFeedback requires a bound revise direction and a validated changed candidate', async () => {
  const { task, ports, statePort, repositoryPort } = createTestSetup();
  const baselineRef = task.initialRevisionDigest;
  const strategy = 'Retain the current bounded repair strategy';
  const plan: FixPlan = {
    planVersion: 1, diagnosis: 'The denominator guard is missing.', suspectedCauseLocations: ['src/calculator.py'],
    evidenceRefs: [baselineRef], strategy, scopedChanges: ['src/calculator.py'],
    checkSetDigest: computeCheckSetDigest(task.requiredChecks), baselineRef,
    strategyDigest: computeCanonicalSha256(strategy), decisionRef: 'decision-feedback-001',
  };
  const decisionRef = plan.decisionRef;
  assert.ok(decisionRef);
  const feedback = createGraphTaskState(task, {
    stateVersion: 1, node: 'AwaitFeedback', plan, evidenceRefs: [baselineRef], nextAction: 'await-human-feedback-and-direction',
  });
  await seedGraphTaskState(statePort, feedback);
  const direction = {
    directive: 'revise' as const, taskId: feedback.taskId, workspaceId: feedback.workspaceId,
    repositoryRevisionDigest: feedback.repositoryRevisionDigest, stateVersion: feedback.stateVersion,
    planVersion: feedback.planVersion, rejectedDecisionId: decisionRef, strategyDigest: plan.strategyDigest,
  };
  const missing = await createAwaitFeedbackNode(ports, { trustedDirection: direction })(createGraphState({ task, state: feedback }));
  assert.equal(missing.terminalOutcome, 'needs-info');
  assert.deepEqual(await statePort.loadTask(task.taskId), feedback);

  const revisedStrategy = 'Use an explicit zero denominator check before division';
  const revisedPlan: FixPlan = { ...plan, strategy: revisedStrategy, strategyDigest: computeCanonicalSha256(revisedStrategy) };
  const denied = await createAwaitFeedbackNode(ports, { trustedDirection: direction, revisedPlan })(createGraphState({ task, state: feedback }));
  assert.equal(denied.terminalOutcome, 'INCOMPLETE');
  assert.deepEqual(await statePort.loadTask(task.taskId), feedback);
  const replanLedger = statePort.getLedgers().find((ledger) => ledger.scope === 'task' && ledger.kind === 'replan');
  assert.equal(replanLedger?.consumed, 0);
  assert.deepEqual(replanLedger?.reservations, []);
  assert.equal(repositoryPort.patches.length, 0);
  assert.equal(repositoryPort.commands.length, 0);
});

test('Restored Deliver without baseline, current checks, and review cannot claim completion', async () => {
  const { task, ports, statePort, repositoryPort, reviewerPort } = createTestSetup();
  const delivered = createGraphTaskState(task, { node: 'Deliver', outcome: 'COMPLETED' });
  await seedGraphTaskState(statePort, delivered);
  let repositoryReads = 0;
  let reviewerCalls = 0;
  const inspectDiff = repositoryPort.inspectDiff.bind(repositoryPort);
  const review = reviewerPort.review.bind(reviewerPort);
  repositoryPort.inspectDiff = async (revision) => { repositoryReads += 1; return inspectDiff(revision); };
  reviewerPort.review = async (...args) => { reviewerCalls += 1; return review(...args); };

  const result = await runUC03Graph(task, ports, { mode: 'development' }, delivered);

  assert.notEqual(result.outcome, 'COMPLETED');
  assert.notEqual(result.finalReport?.outcome, 'COMPLETED');
  assert.equal(result.outcome, result.finalReport?.outcome);
  assert.equal(result.finalReport?.isComplete, false);
  assert.equal(repositoryReads, 0);
  assert.equal(reviewerCalls, 0);
});

/* ------------------------------------------------------------------
 * 2. Full Gated Success Route
 * ------------------------------------------------------------------ */

test('Mock route delivers only after baseline, owner-settled patch, current checks, and accounted review', async () => {
  const patchContent = '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1 +1,2 @@\n-def divide(a, b): return a / b\n+def divide(a, b):\n+    if b == 0: raise CalculationError("zero denominator")\n+    return a / b\n';
  const runPassingMockRoute = async (
    setup: ReturnType<typeof createTestSetup>,
    trustedTransitionContext?: NonNullable<StateTransitionOptions['trusted']>,
    onReview?: (result: ReviewResult, request: ProviderRequest) => void,
  ) => {
    await seedGraphTaskState(setup.statePort, createGraphTaskState(setup.task));
    const guardReasons: string[] = [];
    const execute = setup.executionGuard.validateAndExecute.bind(setup.executionGuard);
    setup.executionGuard.validateAndExecute = async (...args) => {
      const effect = await execute(...args);
      if (effect.outcome !== 'success') guardReasons.push(effect.reason ?? effect.outcome);
      return effect;
    };
    const review = setup.reviewerPort.review.bind(setup.reviewerPort);
    let reviewerCalls = 0;
    setup.reviewerPort.review = async (task, diff, evidence, request, admission, claim) => {
      reviewerCalls += 1;
      const result = await review(task, diff, evidence, request, admission, claim);
      onReview?.(result, request);
      return result;
    };
    setup.repositoryPort.setTestResult('check-pytest-reproduction', {
      checkId: 'check-pytest-reproduction', outcome: 'fail',
      outputExcerpt: 'FAILED tests/test_calculator.py::test_divide_zero - ZeroDivisionError: division by zero', durationMs: 150,
    });
    setup.repositoryPort.setTestResult('check-pytest-regression', { checkId: 'check-pytest-regression', outcome: 'pass', outputExcerpt: '1 passed', durationMs: 100 });
    const result = await runUC03Graph(setup.task, setup.ports, {
      mode: 'development', trustedExpectedContext: setup.trustedExpectedContext, planDetails: ROUTE_PLAN_DETAILS,
      admissionContext: createMockPatchAdmissionResolver(setup.repositoryPort, setup.statePort),
      reviewerAdmission: createMockReviewerAdmissionResolver(setup.statePort), patchContent, targetPaths: ['src/calculator.py'],
      ...(trustedTransitionContext ? { trustedTransitionContext } : {}),
    });
    return { result, reviewerCalls, guardReasons };
  };

  // A first source run captures the mock owners' actual baseline, checks, patch revision, and review record.
  const probe = createTestSetup();
  let observedReview: ReviewResult | undefined;
  let observedRequest: ProviderRequest | undefined;
  const probeRun = await runPassingMockRoute(probe, undefined, (review, request) => { observedReview = review; observedRequest = request; });
  assert.equal(probeRun.result.outcome, 'IMPLEMENTED_UNVERIFIED');
  const probeState = probeRun.result.state;
  const baselineWrite = probe.baselineEvidenceRequest;
  assert.ok(baselineWrite, 'Mock route did not persist its baseline evidence');
  assert.ok(probeState, 'Mock route did not retain the owner task state');
  assert.ok(observedReview && observedRequest, `Mock route did not reach independently accounted review: ${probeRun.guardReasons.join('; ') || probeRun.result.reasons.join('; ')}`);
  const ownerReview = observedReview;
  const ownerRequest = observedRequest;
  assert.equal(probeState.node, 'Repair');
  const baseline: Baseline = {
    evidenceId: `uc04://baseline/${probe.task.taskId}/1`,
    repositorySnapshotDigest: baselineWrite.content.repositorySnapshotDigest,
    checkSetDigest: baselineWrite.content.checkSetDigest,
    reproductionFailureSignature: baselineWrite.content.reproductionFailureSignature,
    checkResults: baselineWrite.content.checkResults,
    testProtectionDigest: baselineWrite.content.testProtectionDigest,
  };
  const diffInfo = await probe.repositoryPort.inspectDiff(probe.task.initialRevisionDigest);
  const protectedSnapshot = await probe.hostAuthority.loadSnapshot({
    taskId: probe.task.taskId, workspaceId: probeState.workspaceId, repositoryId: probe.task.repositoryId,
    expectedRevisionDigest: probeState.repositoryRevisionDigest,
    expectedCriteriaDigest: computeCanonicalSha256(probe.task.acceptanceCriteria),
    expectedCheckSetDigest: computeCheckSetDigest(probe.task.requiredChecks), expectedTestFiles: probe.trustedExpectedContext.expectedTestFiles,
  });
  const deliveryTrustedContext: NonNullable<StateTransitionOptions['trusted']> = {
    ...(createPlanApprovalContext(probe.task)[3] ?? {}),
    completion: {
      taskId: probe.task.taskId, runId: probeState.runId,
      repositoryRevisionDigest: probeState.repositoryRevisionDigest,
      diffDigest: diffInfo.diffDigest, checkSetDigest: computeCheckSetDigest(probe.task.requiredChecks),
      baselineRef: baseline.evidenceId, criteriaDigest: computeCanonicalSha256(probe.task.acceptanceCriteria),
      authorizedDiffDigest: diffInfo.diffDigest,
      protectedTestsDigest: computeTestProtectionDigest(protectedSnapshot.testFiles),
      originalProtectedTestsDigest: baseline.testProtectionDigest,
      reviewerRoleConfigId: ownerReview.reviewerRoleConfigId,
      reviewIterationReservationRef: ownerRequest.reservationRef,
      checks: probe.task.requiredChecks.map((check) => ({
        checkId: check.checkId, outcome: 'pass' as const,
        repositoryRevisionDigest: probeState.repositoryRevisionDigest, diffDigest: diffInfo.diffDigest,
      })),
      review: ownerReview,
    },
  };
  const deliveryExpectedVersion = probeState.stateVersion - 1;
  const setup = createTestSetup({ transitionContexts: { [deliveryExpectedVersion]: deliveryTrustedContext } });
  const { task, statePort, repositoryPort } = setup;
  const { result, reviewerCalls } = await runPassingMockRoute(setup, deliveryTrustedContext);

  assert.equal(result.outcome, 'COMPLETED', result.reasons.join('; '));
  assert.ok(result.state !== null);
  assert.equal(result.state.node, 'Deliver');
  assert.ok(result.finalReport !== undefined);
  assert.equal(result.finalReport.isComplete, true);
  assert.equal(result.finalReport.outcome, 'COMPLETED');
  assert.equal(result.finalReport.evidence.verificationRefs.length, task.requiredChecks.length);
  assert.ok(result.finalReport.evidence.baselineRef);
  assert.ok(result.finalReport.evidence.reviewRef);
  assert.equal(result.finalReport.delivery?.outcome, 'COMPLETED');
  assert.deepEqual(await statePort.loadTask(task.taskId), result.state);
  assert.equal(result.state.plan?.decisionRef, ROUTE_PLAN_DETAILS.decisionRef);
  assert.equal(result.state.plan?.baselineRef, result.finalReport.evidence.baselineRef);
  assert.notEqual(result.state.repositoryRevisionDigest, task.initialRevisionDigest);
  assert.equal(repositoryPort.patches.length, 1);
  assert.equal(repositoryPort.commands.length, task.requiredChecks.length);
  assert.equal(reviewerCalls, 1);
  assert.equal(statePort.getLedgers().find((ledger) => ledger.scope === 'task' && ledger.kind === 'repair')?.consumed, 1);
  assert.equal(statePort.getLedgers().find((ledger) => ledger.scope === 'task' && ledger.kind === 'iteration')?.consumed, 1);
  assert.equal(statePort.getJournalSnapshot().attempts.length, 1 + task.requiredChecks.length + 1);
  assert.ok(result.milestones.some((milestone) => milestone.kind === 'task_completed'));
});

/* ------------------------------------------------------------------
 * 3. Pending Plan Approval & Resume from Restored State
 * ------------------------------------------------------------------ */

test('Pending plan approval: pauses at AwaitPlan and resumes when approved', async () => {
  const { task, ports, statePort, approvalPort, repositoryPort, reviewerPort, trustedExpectedContext } =
    createTestSetup({ initialDecision: 'pending' });
  await seedGraphTaskState(statePort, createGraphTaskState(task));
  let diffReads = 0;
  let reviewerCalls = 0;
  const inspectDiff = repositoryPort.inspectDiff.bind(repositoryPort);
  const review = reviewerPort.review.bind(reviewerPort);
  repositoryPort.inspectDiff = async (revision) => { diffReads += 1; return inspectDiff(revision); };
  reviewerPort.review = async (...args) => { reviewerCalls += 1; return review(...args); };

  // First run: should pause at AwaitPlan
  const pausedResult = await runUC03Graph(task, ports, {
    mode: 'development',
    trustedExpectedContext,
    planDetails: ROUTE_PLAN_DETAILS,
  });

  assert.equal(pausedResult.outcome, 'pending-approval');
  assert.ok(pausedResult.state !== null);
  assert.equal(pausedResult.state.node, 'AwaitPlan');
  assert.ok(pausedResult.state.plan !== undefined);
  assert.deepEqual(await statePort.loadTask(task.taskId), pausedResult.state);
  assert.equal(repositoryPort.patches.length, 0);
  assert.equal(diffReads, 0);
  assert.equal(reviewerCalls, 0);

  // Now simulate human approval and post-patch test pass
  approvalPort.setDecision('approved');
  repositoryPort.setTestResult('check-pytest-reproduction', {
    checkId: 'check-pytest-reproduction',
    outcome: 'pass',
    outputExcerpt: '1 passed',
    durationMs: 100,
  });

  // Second run: resume from restored state
  const resumedResult = await runUC03Graph(
    task,
    ports,
    {
      mode: 'development',
      trustedExpectedContext,
      planDetails: ROUTE_PLAN_DETAILS,
      admissionContext: createMockPatchAdmissionResolver(repositoryPort, statePort),
      reviewerAdmission: createMockReviewerAdmissionResolver(statePort),
      patchContent:
        '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1 +1,2 @@\n-def divide(a, b): return a / b\n+def divide(a, b):\n+    if b == 0: raise CalculationError("zero denominator")\n+    return a / b\n',
      targetPaths: ['src/calculator.py'],
    },
    pausedResult.state
  );

  assert.equal(resumedResult.outcome, 'IMPLEMENTED_UNVERIFIED', `${resumedResult.reasons.join('; ')}; state=${resumedResult.state?.node ?? 'none'}`);
  assert.equal(resumedResult.state?.node, 'Repair');
  assert.deepEqual(await statePort.loadTask(task.taskId), resumedResult.state);
  assert.ok(resumedResult.state && resumedResult.state.stateVersion > pausedResult.state.stateVersion);
  assert.ok(resumedResult.state?.evidenceRefs.includes('execution-guard:denied'));
  assert.notEqual(resumedResult.state?.repositoryRevisionDigest, task.initialRevisionDigest);
  assert.equal(repositoryPort.patches.length, 1);
  assert.equal(repositoryPort.commands.length, 2);
  assert.equal(diffReads, 1);
  assert.equal(reviewerCalls, 0);
  assert.equal(statePort.getJournalSnapshot().authorityPublications.length, 0);
});

/* ------------------------------------------------------------------
 * 4. Plan Rejection & Human Feedback
 * ------------------------------------------------------------------ */

test('Plan rejection: transitions to AwaitFeedback and pauses or replans', async () => {
  const { task, ports, statePort, trustedExpectedContext } = createTestSetup({
    initialDecision: 'rejected',
  });
  await seedGraphTaskState(statePort, createGraphTaskState(task));

  // First run without direction: should enter AwaitFeedback and pause
  const feedbackResult = await runUC03Graph(task, ports, {
    mode: 'development',
    trustedExpectedContext,
    planDetails: ROUTE_PLAN_DETAILS,
  });

  assert.equal(feedbackResult.outcome, 'needs-info');
  assert.ok(feedbackResult.state !== null);
  assert.equal(feedbackResult.state.node, 'AwaitFeedback');

  // Now terminate via human direction
  const terminateResult = await runUC03Graph(
    task,
    ports,
    {
      mode: 'development',
      trustedExpectedContext,
      planDetails: ROUTE_PLAN_DETAILS,
      trustedDirection: {
        directive: 'terminate',
        taskId: task.taskId,
        workspaceId: feedbackResult.state.workspaceId,
        repositoryRevisionDigest: feedbackResult.state.repositoryRevisionDigest,
        stateVersion: feedbackResult.state.stateVersion,
        planVersion: feedbackResult.state.planVersion,
        rejectedDecisionId: feedbackResult.state.plan?.decisionRef ?? 'dec-plan-rejected',
        strategyDigest: feedbackResult.state.plan?.strategyDigest ?? '',
      },
    },
    feedbackResult.state
  );

  assert.equal(terminateResult.outcome, 'INCOMPLETE');
  assert.equal(terminateResult.state?.node, 'Incomplete');
});

/* ------------------------------------------------------------------
 * 5. Verification Failure & Repair Route
 * ------------------------------------------------------------------ */

test('Verification failure: routes to Repair on test failure', async () => {
  const { task, ports, statePort, repositoryPort, trustedExpectedContext } = createTestSetup({
    initialDecision: 'approved',
  });
  await seedGraphTaskState(statePort, createGraphTaskState(task));

  // Script post-patch test run to fail (regression check fails)
  repositoryPort.setTestResult('check-pytest-regression', {
    checkId: 'check-pytest-regression',
    outcome: 'fail',
    outputExcerpt: 'FAILED tests/test_calculator.py - AssertionError',
    durationMs: 120,
  });
  repositoryPort.setCommandResult('pytest -q tests/test_calculator.py', {
    exitCode: 1,
    stdout: 'FAILED tests/test_calculator.py - AssertionError',
    stderr: '',
  });

  const result = await runUC03Graph(task, ports, {
    mode: 'development',
    trustedExpectedContext,
    planDetails: ROUTE_PLAN_DETAILS,
    admissionContext: createMockPatchAdmissionResolver(repositoryPort, statePort),
    patchContent:
      '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1 +1,2 @@\n-def divide(a, b): return a / b\n+def divide(a, b): return 0\n',
    targetPaths: ['src/calculator.py'],
  });

  // Repair without repair proposal stops at INCOMPLETE
  assert.equal(result.outcome, 'INCOMPLETE');
  assert.ok(
    result.milestones.some((m) => m.node === 'Repair' || m.kind === 'task_failed'),
    'Expected Repair or task_failed milestone'
  );
});

for (const evidenceKind of ['verification', 'review'] as const) {
  test(`Repair forwards its exact owner receipt after ${evidenceKind} failure`, async () => {
    const { task, ports, statePort, repositoryPort, trustedExpectedContext, approvalPort } = createTestSetup();
    const checkSetDigest = computeCheckSetDigest(task.requiredChecks);
    const baselineRef = `uc04://baseline/${task.taskId}/1`;
    const strategyDigest = computeCanonicalSha256(ROUTE_PLAN_DETAILS.strategy);
    const plan: FixPlan = {
      planVersion: 1, diagnosis: ROUTE_PLAN_DETAILS.diagnosis,
      suspectedCauseLocations: [...ROUTE_PLAN_DETAILS.suspectedCauseLocations], evidenceRefs: [baselineRef],
      strategy: ROUTE_PLAN_DETAILS.strategy, scopedChanges: [...ROUTE_PLAN_DETAILS.scopedChanges], checkSetDigest,
      baselineRef, strategyDigest, decisionRef: ROUTE_PLAN_DETAILS.decisionRef,
    };
    const failureDigest = computeCanonicalSha256(`failure-${evidenceKind}`);
    const verificationFailure: VerificationResult = {
      evidenceId: `evidence-failed-${evidenceKind}`, taskId: task.taskId, runId: 'run-graph-001',
      actionId: 'action-verify-check-pytest-reproduction', phase: 'focused',
      repoDigest: task.initialRevisionDigest, diffDigest: failureDigest,
      commandIdentity: 'pytest -q tests/test_calculator.py -k test_divide_zero', outcome: 'fail',
      testedIds: ['check-pytest-reproduction'], diagnosticRefs: [`verify-${evidenceKind}-failure`],
    };
    const reviewFailure: ReviewResult = {
      reviewId: `review-failed-${evidenceKind}`, status: 'findings', repoDigest: task.initialRevisionDigest,
      diffDigest: failureDigest, checkSetDigest, reviewerRoleConfigId: 'reviewer-config-route-test',
      iterationReservationRef: 'review-allowance-route-test',
      findings: [{ file: 'src/calculator.py', line: 1, side: 'new', severity: 'error', message: 'Zero check is missing', evidenceRef: `review-${evidenceKind}-finding` }],
    };
    const failure = evidenceKind === 'verification' ? verificationFailure : reviewFailure;
    const evidenceRefs = evidenceKind === 'verification'
      ? [baselineRef, verificationFailure.evidenceId, verificationFailure.actionId, ...verificationFailure.diagnosticRefs]
      : [baselineRef, reviewFailure.reviewId, reviewFailure.iterationReservationRef, `review-${evidenceKind}-finding`];
    const repairState = createGraphTaskState(task, {
      stateVersion: 1, node: 'Repair', plan, activeDecisionId: plan.decisionRef,
      changedPaths: ['src/calculator.py'], evidenceRefs,
      ...(evidenceKind === 'review' ? { latestReviewRef: reviewFailure.reviewId, reviewRefs: [reviewFailure.reviewId] } : {}),
    });
    await seedGraphTaskState(statePort, repairState);
    approvalPort.classify = async () => 'ALLOWED';
    approvalPort.validateBinding = async () => true;
    const repairPatch = {
      diff: 'add a zero denominator guard', affectedPaths: ['src/calculator.py'],
      evidenceRefs: [evidenceKind === 'verification' ? verificationFailure.evidenceId : reviewFailure.reviewId],
      diagnosticRefs: evidenceKind === 'verification' ? [...verificationFailure.diagnosticRefs] : [`review-${evidenceKind}-finding`],
    };
    const baseline: Baseline = {
      evidenceId: baselineRef, repositorySnapshotDigest: task.initialRevisionDigest, checkSetDigest,
      reproductionFailureSignature: 'baseline reproduction failed',
      checkResults: task.requiredChecks.map((check) => ({ checkId: check.checkId, outcome: check.purpose === 'reproduction' ? 'fail' : 'pass', outputExcerpt: 'mock check', durationMs: 1 })),
      testProtectionDigest: computeCanonicalSha256('protected-test-snapshot'),
    };
    const graphState = createGraphState({ task, state: repairState, baseline, failureEvidence: [failure] });
    const repaired = await createRepairNode(ports, {
      mode: 'development', trustedExpectedContext, trustedTransitionContext: createPlanApprovalContext(task)[3],
      admissionContext: createMockPatchAdmissionResolver(repositoryPort, statePort), repairPatch,
    })(graphState);

    assert.equal(repaired.terminalOutcome, undefined, repaired.reasons?.join('; '));
    assert.equal(repaired.state?.node, 'Verify');
    assert.equal(repaired.patchAdmission?.context.runnableNode, 'Repair');
    assert.ok(repaired.patchReceipt);
    assert.equal(repaired.patchReceipt.outcome.observedResultRevisionDigest, repaired.state?.repositoryRevisionDigest);
    const repairedState = repaired.state;
    assert.ok(repairedState);
    const nextEvidence = createGraphState({ task, state: repairedState, baseline, failureEvidence: [failure], patchAdmission: repaired.patchAdmission, patchReceipt: repaired.patchReceipt });
    assert.equal(validSettledPatchEvidence(nextEvidence, task, repairedState), true);
    const staleState = { ...repairedState, repositoryRevisionDigest: task.initialRevisionDigest };
    assert.equal(validSettledPatchEvidence({ ...nextEvidence, state: staleState }, task, staleState), false);
    assert.equal(repositoryPort.patches.length, 1);
    assert.equal(statePort.getJournalSnapshot().attempts.length, 1);
    assert.equal(statePort.getLedgers().find((ledger) => ledger.scope === 'task' && ledger.kind === 'repair')?.consumed, 1);
  });
}

/* ------------------------------------------------------------------
 * 6. CLI Thin Adapter Tests
 * ------------------------------------------------------------------ */

test('CLI: rejects missing task arguments and unknown flags', async () => {
  const noArgs = await runUC03Cli([]);
  assert.equal(noArgs.exitCode, 2);

  const unknown = await runUC03Cli(['--task', 'task.json', '--wat', 'value']);
  assert.equal(unknown.exitCode, 2);
  assert.ok(unknown.output.includes('INVALID_ARGUMENTS'));
  const badMode = await runUC03Cli(['--task', 'task.json', '--mode', 'real']);
  assert.equal(badMode.exitCode, 2);
});

test('CLI: validates task file with --command validate', async () => {
  const task = createFixtureBugTask();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc03-cli-test-'));
  const taskFile = path.join(tmpDir, 'task.json');
  fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf8');

  try {
    const res = await runUC03Cli(['--task-file', taskFile, '--command', 'validate']);
    assert.equal(res.exitCode, 0);
    assert.ok(res.output.includes('"outcome":"ok"'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI: rejects unavailable production configuration on run', async () => {
  const task = createFixtureBugTask();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc03-cli-test-'));
  const taskFile = path.join(tmpDir, 'task.json');
  const configFile = path.join(tmpDir, 'trusted-config.json');
  fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf8');
  fs.writeFileSync(configFile, JSON.stringify({ mode: 'production' }), 'utf8');

  try {
    const res = await runUC03Cli([
      '--task',
      taskFile,
      '--config',
      configFile,
      '--mode',
      'production',
    ]);
    assert.equal(res.exitCode, 5);
    assert.ok(res.output.includes('unavailable-production-configuration'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI source entry point writes output and exits nonzero when real ports are unavailable', () => {
  const task = createFixtureBugTask();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc03-cli-process-'));
  const taskFile = path.join(tmpDir, 'task.json');
  const configFile = path.join(tmpDir, 'trusted-config.json');
  const outputFile = path.join(tmpDir, 'report.json');
  fs.writeFileSync(taskFile, JSON.stringify(task), 'utf8');
  fs.writeFileSync(configFile, JSON.stringify({ mode: 'production' }), 'utf8');

  try {
    const cliPath = path.resolve(process.cwd(), 'src/cli/uc03.ts');
    const child = spawnSync(process.execPath, [
      '--experimental-strip-types', cliPath,
      '--task', taskFile,
      '--config', configFile,
      '--output', outputFile,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(child.status, 5, child.stderr || child.stdout);
    assert.ok(child.stdout.includes('unavailable-production-configuration'));
    assert.match(fs.readFileSync(outputFile, 'utf8'), /"outcome":"unavailable-production-configuration"/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function assertSafeCliError(output: string, code: string, protectedContent: string): void {
  assert.ok(Buffer.byteLength(output, 'utf8') <= 256);
  assert.equal(output.includes(protectedContent), false);
  const result = JSON.parse(output) as { readonly error?: unknown };
  assert.equal(result.error, code);
}

function trackRuntimePortCalls(ports: UC03GraphPorts): { readonly ports: UC03GraphPorts; readonly calls: string[] } {
  const calls: string[] = [];
  const trackedPorts = new Proxy(ports, {
    get(target, portName, receiver) {
      const port: unknown = Reflect.get(target, portName, receiver);
      if (typeof port !== 'object' || port === null) return port;
      return new Proxy(port, {
        get(portTarget, methodName, portReceiver) {
          const method: unknown = Reflect.get(portTarget, methodName, portReceiver);
          if (typeof method !== 'function') return method;
          return (...args: unknown[]) => {
            calls.push(`${String(portName)}.${String(methodName)}`);
            return Reflect.apply(method, portTarget, args);
          };
        },
      });
    },
  });
  return { ports: trackedPorts, calls };
}

test('CLI: malformed task and config JSON diagnostics omit input and make no runtime port calls', async () => {
  const task = createFixtureBugTask();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc03-cli-safe-json-'));
  const taskFile = path.join(tmpDir, 'task.json');
  const configFile = path.join(tmpDir, 'config.json');
  const tracked = trackRuntimePortCalls(createTestSetup().ports);

  try {
    const taskMarker = 'tSKR3t!!';
    fs.writeFileSync(taskFile, `${taskMarker} is not JSON`, 'utf8');
    const taskResult = await runUC03Cli(['--task', taskFile], { ports: tracked.ports });
    assert.equal(taskResult.exitCode, 2);
    assertSafeCliError(taskResult.output, 'TASK_JSON_ERROR', taskMarker);

    const configMarker = 'cFGR3t!!';
    fs.writeFileSync(taskFile, JSON.stringify(task), 'utf8');
    fs.writeFileSync(configFile, `${configMarker} is not JSON`, 'utf8');
    const configResult = await runUC03Cli(['--task', taskFile, '--config', configFile], { ports: tracked.ports });
    assert.equal(configResult.exitCode, 2);
    assertSafeCliError(configResult.output, 'CONFIG_JSON_ERROR', configMarker);
    assert.deepEqual(tracked.calls, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI: oversized malformed task and config JSON stay bounded in results and process output', async () => {
  const task = createFixtureBugTask();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc03-cli-safe-large-'));
  const taskFile = path.join(tmpDir, 'task.json');
  const configFile = path.join(tmpDir, 'config.json');
  const taskOutputFile = path.join(tmpDir, 'task-output.json');
  const configOutputFile = path.join(tmpDir, 'config-output.json');
  const tracked = trackRuntimePortCalls(createTestSetup().ports);
  const taskMarker = 'tSKR3t!!';
  const configMarker = 'cFGR3t!!';
  const largeTaskInput = `${taskMarker} ${'x'.repeat(128 * 1024)}`;
  const largeConfigInput = `${configMarker} ${'y'.repeat(128 * 1024)}`;

  try {
    fs.writeFileSync(taskFile, largeTaskInput, 'utf8');
    const taskResult = await runUC03Cli(['--task', taskFile], { ports: tracked.ports });
    assert.equal(taskResult.exitCode, 2);
    assertSafeCliError(taskResult.output, 'TASK_JSON_ERROR', taskMarker);

    fs.writeFileSync(taskFile, JSON.stringify(task), 'utf8');
    fs.writeFileSync(configFile, largeConfigInput, 'utf8');
    const configResult = await runUC03Cli(['--task', taskFile, '--config', configFile], { ports: tracked.ports });
    assert.equal(configResult.exitCode, 2);
    assertSafeCliError(configResult.output, 'CONFIG_JSON_ERROR', configMarker);
    assert.deepEqual(tracked.calls, []);

    for (const scenario of [
      { taskInput: largeTaskInput, errorCode: 'TASK_JSON_ERROR', marker: taskMarker, outputFile: taskOutputFile, configInput: undefined },
      { taskInput: JSON.stringify(task), errorCode: 'CONFIG_JSON_ERROR', marker: configMarker, outputFile: configOutputFile, configInput: largeConfigInput },
    ]) {
      fs.writeFileSync(taskFile, scenario.taskInput, 'utf8');
      if (scenario.configInput !== undefined) fs.writeFileSync(configFile, scenario.configInput, 'utf8');
      const cliArgs = [
        '--experimental-strip-types',
        path.resolve(process.cwd(), 'src/cli/uc03.ts'),
        '--task', taskFile,
        '--output', scenario.outputFile,
        ...(scenario.configInput === undefined ? [] : ['--config', configFile]),
      ];
      const child = spawnSync(process.execPath, cliArgs, { cwd: process.cwd(), encoding: 'utf8' });
      assert.equal(child.status, 2);
      assertSafeCliError(child.stdout.trimEnd(), scenario.errorCode, scenario.marker);
      assert.equal(fs.existsSync(scenario.outputFile), false);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI: argument, validation, read, and write errors omit input and paths', async () => {
  const task = createFixtureBugTask();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc03-cli-safe-errors-'));
  const taskFile = path.join(tmpDir, 'task.json');
  const protectedPathMarker = 'PATH_MARKER_SECRET';
  const tracked = trackRuntimePortCalls(createTestSetup().ports);

  try {
    const argumentMarker = 'ARGUMENT_MARKER_SECRET';
    const argumentResult = await runUC03Cli([`--${argumentMarker}`], { ports: tracked.ports });
    assert.equal(argumentResult.exitCode, 2);
    assertSafeCliError(argumentResult.output, 'INVALID_ARGUMENTS', argumentMarker);

    fs.writeFileSync(taskFile, JSON.stringify({ [argumentMarker]: 'protected value' }), 'utf8');
    const validationResult = await runUC03Cli(['--task', taskFile], { ports: tracked.ports });
    assert.equal(validationResult.exitCode, 2);
    assertSafeCliError(validationResult.output, 'INVALID_TASK_PAYLOAD', argumentMarker);

    const missingTaskResult = await runUC03Cli(['--task', path.join(tmpDir, `${protectedPathMarker}.json`)], { ports: tracked.ports });
    assert.equal(missingTaskResult.exitCode, 2);
    assertSafeCliError(missingTaskResult.output, 'TASK_READ_ERROR', protectedPathMarker);

    fs.writeFileSync(taskFile, JSON.stringify(task), 'utf8');
    const missingConfigResult = await runUC03Cli([
      '--task', taskFile,
      '--config', path.join(tmpDir, `${protectedPathMarker}.json`),
    ], { ports: tracked.ports });
    assert.equal(missingConfigResult.exitCode, 2);
    assertSafeCliError(missingConfigResult.output, 'CONFIG_READ_ERROR', protectedPathMarker);

    const outputDirectory = path.join(tmpDir, protectedPathMarker);
    fs.mkdirSync(outputDirectory);
    const writeResult = await runUC03Cli(['--task', taskFile, '--command', 'validate', '--output', outputDirectory], { ports: tracked.ports });
    assert.equal(writeResult.exitCode, 2);
    assertSafeCliError(writeResult.output, 'OUTPUT_WRITE_ERROR', protectedPathMarker);

    const runMarker = 'RUN_MARKER_SECRET';
    const throwingPorts = new Proxy(tracked.ports, {
      get() { throw new Error(runMarker); },
    });
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ mode: 'production' }), 'utf8');
    const runResult = await runUC03Cli(['--task', taskFile, '--config', path.join(tmpDir, 'config.json')], { ports: throwingPorts });
    assert.equal(runResult.exitCode, 1);
    assertSafeCliError(runResult.output, 'UC03_RUN_FAILED', runMarker);
    assert.deepEqual(tracked.calls, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
