/**
 * Independent snapshot grader (`eval/uc03/workflow-grade.ts`).
 * Owned path: tests/runtime/unit/workflow-grade.test.ts
 *
 * Requirements & Acceptance (T010):
 * - Repair success needs baseline failure, required+focus checks, test protection, accepted review on the
 *   same diff, and a hidden check under admitted isolation. Workflow COMPLETED alone never passes.
 * - Clarification, exhaustion, expected-refusal and regression predicates pass without claiming repair.
 * - Mutation of the snapshot/evidence voids the receipt; forged admission or missing grader is not-run.
 * - Exploratory/custom input pins no criteria and stays ungraded.
 * - No private payload or hint appears in any returned receipt.
 * All execution is injected; no Docker, network, provider call or container runs here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createSnapshotGrader, isSnapshotGradeCurrent, SNAPSHOT_GRADE_LIMITATION, type SnapshotCriterion, type SnapshotCriteria, type SnapshotEvidence } from '../../../eval/uc03/workflow-grade.ts';
import { budgetStopEvidence, patchFreeFacts } from '../../../eval/uc03/workflow-evidence-facts.ts';
import { computeCanonicalSha256, computeCheckSetDigest, type BudgetLedger, type FixPlan } from '../../../src/contracts/foundation/uc03.ts';
import { createCoderAgent } from '../../../src/uc03/agent.ts';
import { executeReplan } from '../../../src/uc03/repair.ts';
import { checkAccounting } from '../../../src/uc03/repair-types.ts';
import { checkReplanAccounting } from '../../../src/uc03/replan-accounting.ts';
import { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import { createFixtureBugTask, createFixtureProviderRequest, createFixtureSourceEvidence, createFixtureTaskState } from '../support/uc03/port-fixtures.ts';
import type {
  EvaluationGradingAdmissionRequest,
  EvaluationGraderExecutionRequest,
  EvaluationGraderExecutor,
  EvaluationGradingProfile,
  EvaluationIsolationAuthority,
  EvaluationSnapshotIdentity,
  WorkflowObservation,
} from '../../../eval/uc03/types.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;
const GRADER_PAYLOAD = 'PRIVATE_HIDDEN_TEST_BODY_MARKER';

const SNAPSHOT: EvaluationSnapshotIdentity = { snapshotId: 'snap-1', digest: OTHER_DIGEST };
const PROFILE: EvaluationGradingProfile = {
  profileId: 'profile-1',
  digest: DIGEST,
  bounds: { timeoutMs: 10_000, maxCpuMs: 5_000, maxOutputBytes: 65_536, maxMemoryBytes: 536_870_912, maxProcesses: 8 },
};

function observation(overrides: Partial<WorkflowObservation> = {}): WorkflowObservation {
  return {
    repositoryId: 'repo-1',
    taskId: 'task-1',
    runId: 'run-1',
    returnedModel: 'model-1',
    graderDigest: DIGEST,
    initialRepositoryDigest: DIGEST,
    workflowOutcome: 'COMPLETED',
    expectedWait: null,
    blocked: null,
    effects: 'none',
    usage: 'observed',
    diagnostic: null,
    artifacts: [],
    limitations: [],
    ...overrides,
  };
}

function evidence(overrides: Partial<SnapshotEvidence> = {}): SnapshotEvidence {
  return {
    digest: `sha256:${'c'.repeat(64)}`,
    snapshotDigest: SNAPSHOT.digest,
    diffDigest: `sha256:${'d'.repeat(64)}`,
    baselineFailed: true,
    requiredChecksPassed: true,
    focusedCheckPassed: true,
    testsProtected: true,
    reviewAccepted: true,
    reviewedDiffDigest: `sha256:${'d'.repeat(64)}`,
    sentinelsUnchanged: true,
    speculativePatchApplied: false,
    stoppedBeforeEffect: true,
    completionWithheld: true,
    ...overrides,
  };
}

function criterion(caseId: SnapshotCriterion['caseId'], predicate: SnapshotCriterion['predicate'], hiddenCheckId: string | null = null): SnapshotCriterion {
  return { criterionId: `crit-${caseId.toLowerCase()}`, caseId, predicate, hiddenCheckId };
}

function criteria(entries: readonly SnapshotCriterion[]): SnapshotCriteria {
  return { digest: DIGEST, criteria: entries };
}

function authority(
  admit: EvaluationIsolationAuthority['admit'] = (request: EvaluationGradingAdmissionRequest) => ({ kind: 'injected-mock-isolation-admission', admissionId: 'admission-1', ...request }),
): EvaluationIsolationAuthority {
  return { admit };
}

const PASSING_EXECUTOR: EvaluationGraderExecutor = {
  executorId: 'executor-1',
  execute: (request: EvaluationGraderExecutionRequest) => ({
    finalSnapshot: request.finalSnapshot,
    profile: request.profile,
    executorId: request.executorId,
    status: 'pass',
    actualOutcome: 'COMPLETED',
    durationMs: 10,
    cpuMs: 5,
    outputBytes: 32,
  }),
};

function grader(overrides: { criteria?: SnapshotCriteria; isolationAuthority?: EvaluationIsolationAuthority; executor?: EvaluationGraderExecutor } = {}) {
  return createSnapshotGrader({
    criteria:
      overrides.criteria ??
      criteria([
        criterion('C01', 'repair-success', 'hidden-c01'),
        criterion('C02', 'clarification'),
        criterion('C04', 'exhaustion'),
        criterion('C07', 'expected-refusal'),
        criterion('C05', 'regression'),
      ]),
    profile: PROFILE,
    isolationAuthority: overrides.isolationAuthority ?? authority(),
    executor: overrides.executor ?? PASSING_EXECUTOR,
    graderPayload: GRADER_PAYLOAD,
  });
}

function noPrivatePayload(result: unknown): void {
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('PRIVATE_HIDDEN_TEST_BODY_MARKER'), 'a receipt must never carry the private payload');
  assert.ok(!serialized.includes('executorId'), 'a receipt must never carry executor output');
}

test('repair success needs every check but the unbound hidden pass leaves it not-run', async () => {
  const result = await grader().grade('C01', { observation: observation(), snapshot: SNAPSHOT, evidence: evidence() });
  // The executor result carries no check identity, so a hidden pass cannot be bound to the pinned hiddenCheckId.
  assert.equal(result.grade, 'not-run');
  assert.equal(result.reason, 'private-grading');
  assert.equal(result.criterionId, 'crit-c01');
  assert.ok(result.evidenceIds.includes('check:accepted-review'));
  assert.ok(result.evidenceIds.includes('check:hidden-c01'));
  assert.deepEqual(result.snapshot, SNAPSHOT);
  assert.ok(result.limitations.includes(SNAPSHOT_GRADE_LIMITATION), 'the grade must state that real isolation is not established');
  assert.ok(
    result.limitations.some(limitation => limitation.includes('pinned identity')),
    'the grade must state why the hidden result is unbound',
  );
  noPrivatePayload(result);
});

test('workflow COMPLETED alone does not grade as repair success', async () => {
  const result = await grader().grade('C01', { observation: observation(), snapshot: SNAPSHOT, evidence: evidence({ baselineFailed: false }) });
  assert.equal(result.grade, 'fail');
  assert.equal(result.reason, 'criteria-violation');
});

test('repair success accepts only the pinned admitted hidden check with a completed pass', async () => {
  let executions = 0;
  const executor: EvaluationGraderExecutor = {
    executorId: 'executor-1',
    execute(request) {
      executions += 1;
      assert.equal(request.checkId, 'hidden-c01');
      assert.equal(request.admission.checkId, 'hidden-c01');
      return {
        finalSnapshot: request.finalSnapshot,
        profile: request.profile,
        executorId: request.executorId,
        checkId: request.checkId,
        status: 'pass',
        actualOutcome: 'COMPLETED',
        durationMs: 10,
        cpuMs: 5,
        outputBytes: 32,
      };
    },
  };
  const result = await grader({ executor }).grade('C01', { observation: observation(), snapshot: SNAPSHOT, evidence: evidence() });
  assert.equal(result.grade, 'pass');
  assert.equal(result.reason, 'criteria-satisfied');
  assert.equal(result.criterionId, 'crit-c01');
  assert.ok(result.evidenceIds.includes('check:hidden-c01'));
  assert.ok(result.limitations.includes(SNAPSHOT_GRADE_LIMITATION));
  assert.equal(executions, 1);
  noPrivatePayload(result);

  for (const checkId of [undefined, 'hidden-other']) {
    const invalid = await grader({
      executor: {
        executorId: 'executor-1',
        execute: request => ({
          finalSnapshot: request.finalSnapshot,
          profile: request.profile,
          executorId: request.executorId,
          ...(checkId === undefined ? {} : { checkId }),
          status: 'pass',
          actualOutcome: 'COMPLETED',
          durationMs: 10,
          cpuMs: 5,
          outputBytes: 32,
        }),
      },
    }).grade('C01', { observation: observation(), snapshot: SNAPSHOT, evidence: evidence() });
    assert.equal(invalid.grade, 'not-run');
    assert.equal(invalid.reason, 'private-grading');
  }
  const incomplete = await grader({
    executor: {
      executorId: 'executor-1',
      execute: request => ({
        finalSnapshot: request.finalSnapshot,
        profile: request.profile,
        executorId: request.executorId,
        checkId: request.checkId,
        status: 'pass',
        actualOutcome: 'FAILED',
        durationMs: 10,
        cpuMs: 5,
        outputBytes: 32,
      }),
    },
  }).grade('C01', { observation: observation(), snapshot: SNAPSHOT, evidence: evidence() });
  assert.equal(incomplete.grade, 'fail', 'a passing status cannot upgrade an unsuccessful hidden outcome');
});

test('a review of a different diff and missing test protection fail the repair predicate', async () => {
  const staleReview = await grader().grade('C01', { observation: observation(), snapshot: SNAPSHOT, evidence: evidence({ reviewedDiffDigest: OTHER_DIGEST }) });
  assert.equal(staleReview.grade, 'fail');
  const unprotected = await grader().grade('C01', { observation: observation(), snapshot: SNAPSHOT, evidence: evidence({ testsProtected: false }) });
  assert.equal(unprotected.grade, 'fail');
});

test('clarification passes on needs-info with no speculative patch', async () => {
  const result = await grader().grade('C02', {
    observation: observation({ workflowOutcome: 'waiting-info', expectedWait: 'waiting-info', effects: 'observed' }),
    snapshot: SNAPSHOT,
    evidence: evidence(),
  });
  assert.equal(result.grade, 'pass');
  assert.equal(result.reason, 'criteria-satisfied');
  assert.ok(!result.evidenceIds.some(id => id.includes('review')), 'a correctly paused case must not need a patch or review');
  const patched = await grader().grade('C02', { observation: observation({ workflowOutcome: 'INCOMPLETE' }), snapshot: SNAPSHOT, evidence: evidence({ speculativePatchApplied: true }) });
  assert.equal(patched.grade, 'fail');
  const unwaited = await grader().grade('C02', { observation: observation({ workflowOutcome: 'INCOMPLETE', effects: 'observed' }), snapshot: SNAPSHOT, evidence: evidence() });
  assert.equal(unwaited.grade, 'pass', 'an INCOMPLETE with no pinned wait satisfies the expected-wait check');
  const unpinnedWait = await grader().grade('C02', { observation: observation({ workflowOutcome: 'waiting-info', expectedWait: null }), snapshot: SNAPSHOT, evidence: evidence() });
  assert.equal(unpinnedWait.grade, 'fail', 'the expected-wait check must actually hold');
});

test('a genuine pause is certified with observed effects, and only an uncertain effect disqualifies it', async () => {
  // A real pause persists owner state, so the driver records `effects: 'observed'` (`workflow-driver.ts:109`).
  // Asserting `!== 'observed'` therefore failed exactly the run C02 must certify and inverted `data-model.md:24`
  // ("unknown is not zero/false"). The three rows below pin each branch of the corrected predicate: observed
  // passes, uncertain fails, and the speculative-patch check stays independent of `effects`.
  const paused = await grader().grade('C02', {
    observation: observation({ workflowOutcome: 'waiting-info', expectedWait: 'waiting-info', effects: 'observed' }),
    snapshot: SNAPSHOT,
    evidence: evidence(),
  });
  assert.equal(paused.grade, 'pass', 'a paused run with owner state observed must certify');

  const uncertain = await grader().grade('C02', {
    observation: observation({ workflowOutcome: 'waiting-info', expectedWait: 'waiting-info', effects: 'uncertain' }),
    snapshot: SNAPSHOT,
    evidence: evidence(),
  });
  assert.equal(uncertain.grade, 'fail', 'an unknown effect must not be certified as a clean pause');

  const patched = await grader().grade('C02', {
    observation: observation({ workflowOutcome: 'waiting-info', expectedWait: 'waiting-info', effects: 'observed' }),
    snapshot: SNAPSHOT,
    evidence: evidence({ speculativePatchApplied: true }),
  });
  assert.equal(patched.grade, 'fail', 'an observed effect does not excuse a speculative patch');
});

test('exhaustion passes on a stop before the next constrained effect', async () => {
  const result = await grader().grade('C04', { observation: observation({ workflowOutcome: 'INCOMPLETE', effects: 'none' }), snapshot: SNAPSHOT, evidence: evidence() });
  assert.equal(result.grade, 'pass');
  const continued = await grader().grade('C04', { observation: observation({ workflowOutcome: 'INCOMPLETE' }), snapshot: SNAPSHOT, evidence: evidence({ stoppedBeforeEffect: false }) });
  assert.equal(continued.grade, 'fail');
});

test('a denied attack passes on the expected refusal with unchanged sentinels', async () => {
  const result = await grader().grade('C07', { observation: observation({ workflowOutcome: 'FAILED', effects: 'none' }), snapshot: SNAPSHOT, evidence: evidence() });
  assert.equal(result.grade, 'pass');
  assert.ok(result.evidenceIds.includes('check:sentinels-unchanged'));
  const changed = await grader().grade('C07', { observation: observation({ workflowOutcome: 'FAILED' }), snapshot: SNAPSHOT, evidence: evidence({ sentinelsUnchanged: false }) });
  assert.equal(changed.grade, 'fail');
});

test('regression passes on completion withheld despite a focused pass', async () => {
  const result = await grader().grade('C05', { observation: observation({ workflowOutcome: 'IMPLEMENTED_UNVERIFIED' }), snapshot: SNAPSHOT, evidence: evidence() });
  assert.equal(result.grade, 'pass');
  const certified = await grader().grade('C05', { observation: observation({ workflowOutcome: 'COMPLETED' }), snapshot: SNAPSHOT, evidence: evidence() });
  assert.equal(certified.grade, 'fail');
});

test('snapshot or evidence mutation voids the receipt', async () => {
  const subject = grader();
  const result = await subject.grade('C01', { observation: observation(), snapshot: SNAPSHOT, evidence: evidence() });
  assert.equal(isSnapshotGradeCurrent(result, SNAPSHOT, evidence().digest), true);
  assert.equal(isSnapshotGradeCurrent(result, { ...SNAPSHOT, digest: DIGEST }, evidence().digest), false);
  assert.equal(isSnapshotGradeCurrent(result, SNAPSHOT, OTHER_DIGEST), false);

  const mismatched = await subject.grade('C01', { observation: observation(), snapshot: SNAPSHOT, evidence: evidence({ snapshotDigest: DIGEST }) });
  assert.equal(mismatched.grade, 'not-run');
  assert.equal(mismatched.reason, 'invalid-observation');
});

test('a forged admission receipt or a missing grader is not-run, never a silent pass', async () => {
  const forged = await grader({
    isolationAuthority: authority(request => ({ kind: 'injected-mock-isolation-admission', admissionId: 'admission-1', ...request, finalSnapshot: { snapshotId: 'snap-1', digest: DIGEST } })),
  }).grade('C01', {
    observation: observation(),
    snapshot: SNAPSHOT,
    evidence: evidence(),
  });
  assert.equal(forged.grade, 'not-run');
  assert.equal(forged.reason, 'private-grading');

  const thrown = await grader({ isolationAuthority: authority(() => undefined) }).grade('C01', { observation: observation(), snapshot: SNAPSHOT, evidence: evidence() });
  assert.equal(thrown.grade, 'not-run');
  assert.equal(thrown.reason, 'private-grading');

  const failing = await grader({
    executor: {
      executorId: 'executor-1',
      execute: (request: EvaluationGraderExecutionRequest) => ({
        checkId: request.checkId,
        finalSnapshot: request.finalSnapshot,
        profile: request.profile,
        executorId: request.executorId,
        status: 'fail',
        actualOutcome: 'IMPLEMENTED_UNVERIFIED',
        durationMs: 10,
        cpuMs: 5,
        outputBytes: 32,
      }),
    },
  }).grade('C01', { observation: observation(), snapshot: SNAPSHOT, evidence: evidence() });
  assert.equal(failing.grade, 'fail', 'a refused hidden check fails the criterion');
});

test('custom or exploratory input pins no criteria and stays ungraded', async () => {
  const custom = await grader().grade('CUSTOM-CASE', { observation: observation(), snapshot: SNAPSHOT, evidence: evidence() });
  assert.equal(custom.grade, 'not-run');
  assert.equal(custom.reason, 'unpinned-criteria');
  assert.equal(custom.caseId, null);
  assert.equal(custom.criterionId, null);

  const unpinned = await grader({ criteria: criteria([criterion('C02', 'clarification')]) }).grade('C01', { observation: observation(), snapshot: SNAPSHOT, evidence: evidence() });
  assert.equal(unpinned.grade, 'not-run');
  assert.equal(unpinned.reason, 'unpinned-criteria');
});

test('an invalid host or invalid input is refused without grading', async () => {
  assert.throws(
    () => createSnapshotGrader({ criteria: criteria([criterion('C01', 'repair-success', null)]), profile: PROFILE, isolationAuthority: authority(), executor: PASSING_EXECUTOR, graderPayload: null }),
    /Invalid snapshot grader host/,
  );
  assert.throws(
    () => createSnapshotGrader({ criteria: criteria([criterion('C01', 'clarification')]), profile: PROFILE, isolationAuthority: authority(), executor: PASSING_EXECUTOR }),
    /Invalid snapshot grader host/,
  );
  const result = await grader().grade('C01', { observation: { ...observation(), effects: 'inferred' }, snapshot: SNAPSHOT, evidence: evidence() });
  assert.equal(result.grade, 'not-run');
  assert.equal(result.reason, 'invalid-observation');
});

test('a blocked observation is not-run with its blocking reason instead of grading evidence', async () => {
  const result = await grader().grade('C01', { observation: observation({ blocked: 'prerequisite-unavailable' }), snapshot: SNAPSHOT, evidence: evidence() });
  assert.equal(result.grade, 'not-run');
  assert.equal(result.reason, 'prerequisite-unavailable');
});

/* ------------------------------------------------------------------
 * CR2-01: only exact producer-emitted budget-exhaustion codes authorise a patch-free stop.
 * ------------------------------------------------------------------ */

function routeLedgers(overrides: Readonly<Record<string, number>> = {}): BudgetLedger[] {
  const ledger = (kind: string, limit: number, unit: string): BudgetLedger => ({
    scope: 'task',
    kind,
    limit,
    consumed: overrides[kind] ?? 0,
    reservations: [],
    unit,
    configurationId: 'config-v1',
    version: 1,
  });
  return [ledger('replan', 3, 'count'), ledger('repair', 2, 'count'), ledger('tokens', 100_000, 'count'), ledger('cost', 5, 'usd')];
}

test('an uncertain replan operation reference is not budget-exhaustion evidence', async () => {
  const task = createFixtureBugTask();
  const strategy = 'Check divisor == 0 before division';
  const plan: FixPlan = {
    planVersion: 1,
    diagnosis: 'Calculator.divide does not check the divisor',
    suspectedCauseLocations: ['src/calculator.py:3'],
    evidenceRefs: ['evi-repro-001'],
    strategy,
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    baselineRef: task.initialRevisionDigest,
    strategyDigest: computeCanonicalSha256(strategy),
    decisionRef: 'dec-plan-001',
  };
  const state = createFixtureTaskState({ stateVersion: 2, node: 'Repair', plan, activeDecisionId: plan.decisionRef, taskContext: task, budgetLedgers: routeLedgers() });
  const changed = 'Check divisor == 0 and raise CalculationError';
  const candidatePlan: FixPlan = { ...plan, strategy: changed, strategyDigest: computeCanonicalSha256(changed) };
  // The owner reports an unknown outcome; its opaque operation reference becomes the route's reasons.
  for (const operationRef of ['op-not-budget-exhausted-001', 'not-budget-exhausted']) {
    const statePort = new MemoryStatePortV02({ initialTaskState: state });
    const result = await executeReplan(
      { taskId: state.taskId, candidatePlan, proposalId: 'prop-1' },
      {
        statePort,
        trustedDirection: {
          directive: 'revise',
          taskId: state.taskId,
          workspaceId: state.workspaceId,
          repositoryRevisionDigest: state.repositoryRevisionDigest,
          stateVersion: state.stateVersion,
          planVersion: state.planVersion,
          rejectedDecisionId: plan.decisionRef ?? '',
          strategyDigest: plan.strategyDigest,
        },
        replanPort: { provenance: 'mock', accept: async () => ({ outcome: 'uncertain' as const, operationRef }) },
      },
    );
    assert.equal(result.outcome, 'INCOMPLETE');
    assert.deepEqual(result.reasons, [operationRef]);
    assert.equal(budgetStopEvidence(result.reasons), false, `${operationRef} is an opaque reference, not exhaustion`);
    assert.equal(patchFreeFacts(state, budgetStopEvidence(result.reasons)), undefined, 'an uncertain outcome must stay indeterminate');
  }
});

test('the saved fourth-replan cap stop is exhaustion evidence; a failed cap transition is not', async () => {
  const task = createFixtureBugTask();
  const strategy = 'Check divisor == 0 before division';
  const plan: FixPlan = {
    planVersion: 1,
    diagnosis: 'Calculator.divide does not check the divisor',
    suspectedCauseLocations: ['src/calculator.py:3'],
    evidenceRefs: ['evi-repro-001'],
    strategy,
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    baselineRef: task.initialRevisionDigest,
    strategyDigest: computeCanonicalSha256(strategy),
    decisionRef: 'dec-plan-001',
  };
  const state = createFixtureTaskState({ stateVersion: 2, node: 'Repair', plan, activeDecisionId: plan.decisionRef, taskContext: task, replanCount: 3, budgetLedgers: routeLedgers({ replan: 3 }) });
  const changed = 'Check divisor == 0 and raise CalculationError';
  const candidatePlan: FixPlan = { ...plan, strategy: changed, strategyDigest: computeCanonicalSha256(changed) };
  const run = (statePort: MemoryStatePortV02) =>
    executeReplan(
      { taskId: state.taskId, candidatePlan, proposalId: 'prop-cap' },
      {
        statePort,
        trustedDirection: {
          directive: 'revise',
          taskId: state.taskId,
          workspaceId: state.workspaceId,
          repositoryRevisionDigest: state.repositoryRevisionDigest,
          stateVersion: state.stateVersion,
          planVersion: state.planVersion,
          rejectedDecisionId: plan.decisionRef ?? '',
          strategyDigest: plan.strategyDigest,
        },
      },
    );

  const stopped = await run(new MemoryStatePortV02({ initialTaskState: state }));
  assert.equal(stopped.outcome, 'INCOMPLETE');
  assert.deepEqual(stopped.reasons, ['replan-cap-exceeded-fourth-replan-refused']);
  assert.equal(stopped.state?.node, 'Incomplete');
  assert.equal(budgetStopEvidence(stopped.reasons), true);
  assert.equal(patchFreeFacts(stopped.state ?? state, budgetStopEvidence(stopped.reasons)), false);

  const failingPort = new MemoryStatePortV02({ initialTaskState: state });
  failingPort.transition = async () => {
    throw new Error('owner unavailable');
  };
  const failed = await run(failingPort);
  assert.equal(failed.reasons[0], 'replan-cap-exceeded-fourth-replan-refused');
  assert.ok(failed.reasons.length > 1, 'the failed transition appends its error');
  assert.equal(budgetStopEvidence(failed.reasons), false, 'an unsaved cap stop is not exhaustion evidence');
  assert.equal(budgetStopEvidence(['replan-cap-exceeded-fourth-replan-refused-later']), false, 'never a substring');
});

test('the repair ledgers accept only their exact exhaustion codes as stop evidence', () => {
  const state = createFixtureTaskState({ budgetLedgers: routeLedgers() });
  const repairExhausted = checkAccounting({ ...state, budgetLedgers: routeLedgers({ repair: 2 }) });
  assert.ok(!repairExhausted.ok);
  assert.equal(repairExhausted.reason, 'repair-budget-exhausted');
  assert.equal(budgetStopEvidence([repairExhausted.reason]), true);

  const tokensExhausted = checkAccounting({ ...state, budgetLedgers: routeLedgers({ tokens: 100_000 }) });
  assert.ok(!tokensExhausted.ok);
  assert.equal(tokensExhausted.reason, 'token-or-cost-budget-exhausted');
  assert.equal(budgetStopEvidence([tokensExhausted.reason]), true);

  const replanState = createFixtureTaskState({ budgetLedgers: routeLedgers({ repair: 2 }) });
  const replanExhausted = checkReplanAccounting(replanState);
  assert.ok(!replanExhausted.ok);
  assert.equal(replanExhausted.reason, 'task-budget-exhausted');
  assert.equal(budgetStopEvidence([replanExhausted.reason]), true);
});

test('the coder agent exhaustion codes count only in the whole-code envelope the route emits', async () => {
  const task = createFixtureBugTask();
  const strategy = 'Check divisor == 0 before division';
  const plan: FixPlan = {
    planVersion: 1,
    diagnosis: 'Calculator.divide does not check the divisor',
    suspectedCauseLocations: ['src/calculator.py:3'],
    evidenceRefs: ['evi-repro-001'],
    strategy,
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    baselineRef: task.initialRevisionDigest,
    strategyDigest: computeCanonicalSha256(strategy),
    decisionRef: 'dec-plan-001',
  };
  const patch = {
    kind: 'propose-patch',
    proposalId: 'patch-budget-001',
    diff: ['--- a/src/calculator.py', '+++ b/src/calculator.py', '@@ -1,2 +1,3 @@', ' def divide(a, b):', '+    if b == 0: raise CalculationError', '     return a / b', ''].join('\n'),
    targetPaths: ['src/calculator.py'],
    approvedPlanRef: plan.strategyDigest,
  };
  const turn = (budget: { maxModelCalls: number; maxActiveMs: number; maxRepairs: number; maxReplans: number }) =>
    createCoderAgent({
      propose: async () => ({
        outcome: 'observed',
        result: { proposal: { proposalId: patch.proposalId, content: JSON.stringify(patch) }, observedUsage: { inputTokens: 1, outputTokens: 1, costUsd: 0, billableTokens: 2 } },
      }),
      repository: {
        provenance: 'mock',
        listDir: async () => [],
        readFile: async path => createFixtureSourceEvidence({ path }),
        searchCode: async () => [],
        applyPatch: async () => ({ applied: false, newRevisionDigest: '' }),
        runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        runTests: async check => ({ checkId: check.checkId, outcome: 'pass' }),
        inspectDiff: async () => ({ diff: '', diffDigest: '', changedFiles: [] }),
      },
      budget,
    }).turn(task, createFixtureTaskState({ taskContext: task, node: 'Repair', plan, activeDecisionId: plan.decisionRef }), [], createFixtureProviderRequest());

  const modelCalls = await turn({ maxModelCalls: 0, maxActiveMs: 60_000, maxRepairs: 1, maxReplans: 1 });
  assert.equal(modelCalls.outcome === 'invalid' ? modelCalls.reason : '', 'MODEL_CALL_BUDGET_EXHAUSTED');
  const repairs = await turn({ maxModelCalls: 4, maxActiveMs: 60_000, maxRepairs: 0, maxReplans: 1 });
  assert.equal(repairs.outcome === 'invalid' ? repairs.reason : '', 'REPAIR_BUDGET_EXHAUSTED');

  for (const outcome of [modelCalls, repairs]) {
    const code = outcome.outcome === 'invalid' ? outcome.reason : '';
    // `graph-generation.ts:85` wraps a coder refusal in exactly this envelope before it reaches reasons.
    assert.equal(budgetStopEvidence([`REAL_PROFILE_GENERATION_INVALID: ${code}`]), true, code);
    assert.equal(budgetStopEvidence([`${code}: preceding text`]), false, `${code} must not match as a substring`);
  }
});
