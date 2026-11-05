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
    node: 'AwaitPlan',
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
    if (expected === 'REPLAN_PREPARED') assert.equal(result.state.replanCount, 1, outcome);
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
