/** T027: material replan routes through the UC-04 transaction, never legacy reserve/settle. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeCanonicalSha256, computeCheckSetDigest, type BudgetLedger, type FixPlan, type StatePort, type TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { executeReplan } from '../../../src/uc03/repair.ts';
import type { TrustedReplanDirection } from '../../../src/uc03/repair-types.ts';
import type { MaterialReplanPortV02, MaterialReplanRequestV02, MaterialReplanResultV02 } from '../../../src/uc03/graph-types-v02.ts';
import { MemoryStatePort } from '../support/uc03/memory-state.ts';
import { createFixtureBugTask, createFixtureTaskState } from '../support/uc03/port-fixtures.ts';

class CountingPort extends MemoryStatePort {
  reserveCalls = 0;
  transitionCalls = 0;
  override async reserve(scope: 'task' | 'run', kind: string, amount: number, actionId: string): Promise<string> {
    this.reserveCalls += 1;
    return super.reserve(scope, kind, amount, actionId);
  }
  override async transition(state: TaskState, expectedVersion: number): Promise<TaskState> {
    this.transitionCalls += 1;
    return super.transition(state, expectedVersion);
  }
}

function fixture(): { state: TaskState; candidatePlan: FixPlan } {
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
  const ledger = (kind: string, limit: number, unit: 'count' | 'usd'): BudgetLedger => ({
    scope: 'task',
    kind,
    limit,
    consumed: 0,
    reservations: [],
    unit,
    configurationId: task.configId,
    version: 1,
  });
  const state = createFixtureTaskState({
    stateVersion: 2,
    node: 'Repair',
    planVersion: 1,
    replanCount: 0,
    plan,
    activeDecisionId: plan.decisionRef,
    taskContext: task,
    budgetLedgers: [ledger('replan', 3, 'count'), ledger('repair', 2, 'count'), ledger('tokens', 100000, 'count'), ledger('cost', 5, 'usd')],
  });
  const changed = 'Check divisor == 0 and raise CalculationError';
  return { state, candidatePlan: { ...plan, strategy: changed, strategyDigest: computeCanonicalSha256(changed) } };
}

test('replan: v0.2 material replan maps all four owner outcomes with no legacy accounting', async () => {
  const { state, candidatePlan } = fixture();
  const direction: TrustedReplanDirection = {
    directive: 'revise',
    taskId: state.taskId,
    workspaceId: state.workspaceId,
    repositoryRevisionDigest: state.repositoryRevisionDigest,
    stateVersion: state.stateVersion,
    planVersion: state.planVersion,
    rejectedDecisionId: state.plan?.decisionRef ?? '',
    strategyDigest: state.plan?.strategyDigest ?? '',
  };
  const committed: TaskState = {
    ...state,
    stateVersion: 3,
    planVersion: 2,
    node: 'AwaitPlan',
    nextAction: 'approve-fix-plan',
    plan: { ...candidatePlan, planVersion: 2, decisionRef: 'dec-plan-002' },
    activeDecisionId: 'dec-plan-002',
    latestReviewRef: undefined,
    reviewRefs: [],
    replanCount: 1,
    budgetLedgers: state.budgetLedgers?.map(ledger => (ledger.kind === 'replan' ? { ...ledger, consumed: 1 } : ledger)),
  };
  const cases = [
    ['accepted', 'REPLAN_PREPARED', []],
    ['already-accepted', 'REPLAN_PREPARED', []],
    ['denied', 'DENIED', ['owner-denied-cap']],
    ['uncertain', 'INCOMPLETE', ['op-ref-1']],
  ] as const;
  for (const [outcome, expected, reasons] of cases) {
    const statePort = new CountingPort({ initialTaskState: state });
    const calls: MaterialReplanRequestV02[] = [];
    const replanPort: MaterialReplanPortV02 = {
      provenance: 'mock',
      accept: async (request): Promise<MaterialReplanResultV02> => {
        calls.push(request);
        return outcome === 'denied'
          ? { outcome, reason: 'owner-denied-cap' }
          : outcome === 'uncertain'
            ? { outcome, operationRef: 'op-ref-1' }
            : { outcome, state: committed, reservationReceipt: 'res-1', transitionReceipt: 'tr-1' };
      },
    };
    const result = await executeReplan({ taskId: state.taskId, candidatePlan, proposalId: 'prop-1' }, { statePort, replanPort, trustedDirection: direction });
    assert.equal(result.outcome, expected, outcome);
    assert.deepEqual(result.reasons, reasons, outcome);
    assert.equal(calls.length, 1, outcome);
    assert.equal(calls[0]?.expectedNextReplanCount, 1, outcome);
    assert.equal(calls[0]?.candidatePlanDigest, computeCanonicalSha256(candidatePlan), outcome);
    assert.equal(statePort.reserveCalls, 0, `${outcome} must not reserve`);
    assert.equal(statePort.transitionCalls, 0, `${outcome} must not transition locally`);
    if (expected === 'REPLAN_PREPARED') {
      assert.equal(result.state.replanCount, 1, outcome);
      assert.equal(result.state.planVersion, 2, outcome);
      assert.deepEqual(result.state.plan, committed.plan, outcome);
      assert.equal(result.state.activeDecisionId, committed.activeDecisionId, outcome);
      assert.equal(result.state.latestReviewRef, undefined, outcome);
      assert.deepEqual(result.state.reviewRefs, [], outcome);
    }
  }
});

test('replan: owner-committed state must bind to this task, run and one-step replan advance', async () => {
  const { state, candidatePlan } = fixture();
  const direction: TrustedReplanDirection = {
    directive: 'revise',
    taskId: state.taskId,
    workspaceId: state.workspaceId,
    repositoryRevisionDigest: state.repositoryRevisionDigest,
    stateVersion: state.stateVersion,
    planVersion: state.planVersion,
    rejectedDecisionId: state.plan?.decisionRef ?? '',
    strategyDigest: state.plan?.strategyDigest ?? '',
  };
  const charged = state.budgetLedgers?.map(ledger => (ledger.kind === 'replan' ? { ...ledger, consumed: 1 } : ledger));
  const committed: TaskState = {
    ...state,
    stateVersion: 3,
    planVersion: 2,
    node: 'AwaitPlan',
    nextAction: 'approve-fix-plan',
    plan: { ...candidatePlan, planVersion: 2, decisionRef: 'dec-plan-002' },
    activeDecisionId: 'dec-plan-002',
    latestReviewRef: undefined,
    reviewRefs: [],
    replanCount: 1,
    budgetLedgers: charged,
  };
  const committedPlan = committed.plan;
  assert.ok(committedPlan);
  const cases: readonly (readonly [string, Partial<TaskState>, string])[] = [
    ['bound', {}, 'REPLAN_PREPARED'],
    ['replanCount does not advance', { replanCount: 0 }, 'INCOMPLETE'],
    ['replanCount advances by two', { replanCount: 2 }, 'INCOMPLETE'],
    ['candidate plan was not committed', { plan: state.plan }, 'INCOMPLETE'],
    ['renewed approval pointer is missing', { activeDecisionId: undefined }, 'INCOMPLETE'],
    ['renewed approval pointer is mismatched', { activeDecisionId: 'dec-plan-other' }, 'INCOMPLETE'],
    ['old approval pointer remains active', { activeDecisionId: state.activeDecisionId, plan: { ...committedPlan, decisionRef: 'dec-plan-001' } }, 'INCOMPLETE'],
    ['stale review remains active', { latestReviewRef: 'review-stale', reviewRefs: ['review-stale'] }, 'INCOMPLETE'],
    ['different taskId', { taskId: 'task-other' }, 'INCOMPLETE'],
    ['different runId', { runId: 'run-other' }, 'INCOMPLETE'],
    ['different workspace', { workspaceId: 'workspace-other' }, 'INCOMPLETE'],
    ['different repository', { repositoryId: 'repository-other' }, 'INCOMPLETE'],
    ['different repository revision', { repositoryRevisionDigest: 'revision-other' }, 'INCOMPLETE'],
    ['different configuration id', { taskContext: { ...state.taskContext!, configId: 'config-other' } }, 'INCOMPLETE'],
    ['different configuration version', { taskContext: { ...state.taskContext!, configVersion: 'config-version-other' } }, 'INCOMPLETE'],
  ];
  for (const [label, override, expected] of cases) {
    const statePort = new CountingPort({ initialTaskState: state });
    const replanPort: MaterialReplanPortV02 = {
      provenance: 'mock',
      accept: async (): Promise<MaterialReplanResultV02> => ({ outcome: 'accepted', state: { ...committed, ...override }, reservationReceipt: 'res-1', transitionReceipt: 'tr-1' }),
    };
    const result = await executeReplan({ taskId: state.taskId, candidatePlan, proposalId: 'prop-1' }, { statePort, replanPort, trustedDirection: direction });
    assert.equal(result.outcome, expected, label);
    if (expected === 'REPLAN_PREPARED') {
      assert.deepEqual(result.reasons, [], label);
      assert.equal(result.state.replanCount, 1, label);
    } else {
      assert.deepEqual(result.reasons, ['reserved-task-state-inconsistent'], label);
      assert.deepEqual(result.state, state, `${label} must not accept the owner state`);
      assert.equal(result.state.replanCount, 0, label);
    }
    assert.equal(statePort.reserveCalls, 0, `${label} must not reserve`);
    assert.equal(statePort.transitionCalls, 0, `${label} must not transition locally`);
  }
});

test('replan: missing owner receipts cannot report a prepared replan', async () => {
  const { state, candidatePlan } = fixture();
  const direction: TrustedReplanDirection = {
    directive: 'revise',
    taskId: state.taskId,
    workspaceId: state.workspaceId,
    repositoryRevisionDigest: state.repositoryRevisionDigest,
    stateVersion: state.stateVersion,
    planVersion: state.planVersion,
    rejectedDecisionId: state.plan?.decisionRef ?? '',
    strategyDigest: state.plan?.strategyDigest ?? '',
  };
  const committed: TaskState = {
    ...state,
    stateVersion: state.stateVersion + 1,
    planVersion: state.planVersion + 1,
    node: 'AwaitPlan',
    nextAction: 'approve-fix-plan',
    plan: { ...candidatePlan, planVersion: state.planVersion + 1, decisionRef: 'dec-plan-002' },
    activeDecisionId: 'dec-plan-002',
    latestReviewRef: undefined,
    reviewRefs: [],
    replanCount: state.replanCount + 1,
    budgetLedgers: state.budgetLedgers?.map(ledger => (ledger.kind === 'replan' ? { ...ledger, consumed: ledger.consumed + 1 } : ledger)),
  };
  for (const [reservationReceipt, transitionReceipt] of [[undefined, 'tr-1'], ['res-1', undefined], ['', 'tr-1'], ['res-1', '']] as const) {
    const statePort = new CountingPort({ initialTaskState: state });
    const replanPort: MaterialReplanPortV02 = {
      provenance: 'mock',
      accept: async () => ({
        outcome: 'accepted', state: committed,
        reservationReceipt: reservationReceipt as string,
        transitionReceipt: transitionReceipt as string,
      }),
    };
    const result = await executeReplan({ taskId: state.taskId, candidatePlan, proposalId: 'prop-1' }, { statePort, replanPort, trustedDirection: direction });
    assert.equal(result.outcome, 'INCOMPLETE', `receipts ${String(reservationReceipt)}/${String(transitionReceipt)}`);
    assert.deepEqual(result.reasons, ['reserved-task-state-inconsistent']);
    assert.deepEqual(result.state, state);
    assert.equal(statePort.reserveCalls, 0);
    assert.equal(statePort.transitionCalls, 0);
  }
});

test('replan: absent replanPort keeps the controlled legacy reserve path', async () => {
  const { state, candidatePlan } = fixture();
  const proposalId = 'prop-legacy';
  const replanReservation = { proposalId, taskId: state.taskId, configurationId: state.taskContext?.configId ?? '', priorCount: 0, nextCount: 1, reservationId: `res-task-replan-${proposalId}` };
  const statePort = new CountingPort({ initialTaskState: state, transitionContexts: { [state.stateVersion + 1]: { replanReservation } } });
  const result = await executeReplan({ taskId: state.taskId, candidatePlan, proposalId }, { statePort: statePort as StatePort, trustedTransitionContext: { replanReservation } });
  assert.equal(result.outcome, 'REPLAN_PREPARED');
  assert.equal(statePort.reserveCalls, 1);
});
