/**
 * T053: the three UC-03 T026 route gaps recorded at `specs/001-verified-code-repair/tasks.md:197`,
 * re-measured on the current candidate. The legacy `uc03-graph.test.ts` is a read-only input.
 *
 * 1. replan baseline / renewed approval — **closed**. A replan keeps the plan's recorded baseline
 *    evidence ID (`src/uc03/replan.ts:59`) and requires a fresh decision (`replan-owner-result.ts:74`).
 *    Witnessed by `tests/runtime/unit/uc03-agent-route.test.ts:564` (baseline) and
 *    `tests/runtime/unit/uc03-graph.test.ts:1005` (renewed approval). The row below re-asserts the
 *    baseline half at the `executeReplan` seam, because that is the half this task owns.
 * 2. STD-R3-002 post-review accounting — **closed**. `src/uc03/graph-review.ts:180` builds the Repair
 *    proposal from the post-review owner state, so the reviewer's settled ledgers survive the write.
 *    Witnessed by `tests/runtime/integration/uc03-host-pipeline.test.ts:1052`; reverting :180 to the
 *    pre-review snapshot fails that row.
 * 3. SPEC-R3-001 subset-repair cumulative diff — **still open**; see the blocked row at the end.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  CONTRACT_VERSION,
  type BudgetLedger,
  type BugTask,
  type FixPlan,
  type StateTransitionOptions,
  type TaskState,
} from '../../../src/contracts/foundation/uc03.ts';
import { executeReplan } from '../../../src/uc03/replan.ts';
import { MemoryStatePort } from '../support/uc03/memory-state.ts';
import { createTestBugTask } from '../support/uc03/state-fixtures.ts';

const BASELINE_REF = 'uc04://baseline/task-uc03-gap-001/1';
const STRATEGY = 'Check the zero denominator before dividing.';

/** Ledgers sized from the task's own limits; `checkReplanAccounting` refuses any other numbers. */
function ledgers(task: BugTask): BudgetLedger[] {
  const row = (scope: 'task' | 'run', kind: string, limit: number, unit: string): BudgetLedger => ({
    scope,
    kind,
    limit,
    consumed: 0,
    reservations: [],
    unit,
    configurationId: task.configId,
    version: 1,
  });
  return [
    row('task', 'replan', task.budgetLimits.maxReplanCount, 'count'),
    row('task', 'repair', task.budgetLimits.maxRepairAttempts, 'count'),
    row('task', 'tokens', task.budgetLimits.maxTokens, 'count'),
    row('task', 'cost', task.budgetLimits.maxCostUsd, 'usd'),
  ];
}

function investigateFixture(): { task: BugTask; state: TaskState; plan: FixPlan } {
  const task = createTestBugTask({ taskId: 'task-uc03-gap-001' });
  const strategyDigest = computeCanonicalSha256(STRATEGY);
  const plan: FixPlan = {
    planVersion: 1,
    diagnosis: 'The denominator is unguarded.',
    suspectedCauseLocations: ['src/calculator.py'],
    evidenceRefs: [BASELINE_REF],
    strategy: STRATEGY,
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    baselineRef: BASELINE_REF,
    strategyDigest,
    decisionRef: 'dec-plan-gap-001',
  };
  const state: TaskState = {
    schemaVersion: CONTRACT_VERSION,
    stateVersion: 2,
    taskId: task.taskId,
    runId: 'run-gap-001',
    workspaceId: 'ws-gap-001',
    repositoryId: task.repositoryId,
    repositoryRevisionDigest: task.initialRevisionDigest,
    goal: task.goal,
    observedBehavior: task.observedBehavior,
    expectedBehavior: task.expectedBehavior,
    reproduction: task.reproduction,
    acceptanceCriteria: task.acceptanceCriteria,
    constraints: task.constraints,
    requiredCheckIds: task.requiredChecks.map(check => check.checkId),
    taskContext: task,
    node: 'Investigate',
    planVersion: 1,
    replanCount: 0,
    changedPaths: [],
    evidenceRefs: [BASELINE_REF],
    budgetLedgers: ledgers(task),
    risks: [],
    nextAction: 'propose-fix-plan',
    plan,
  };
  return { task, state, plan };
}

function reservation(state: TaskState, proposalId: string) {
  return {
    proposalId,
    taskId: state.taskId,
    configurationId: state.taskContext?.configId ?? '',
    priorCount: state.replanCount,
    nextCount: state.replanCount + 1,
    reservationId: `res-task-replan-${proposalId}`,
  };
}

function transitionContext(state: TaskState, proposalId: string): NonNullable<StateTransitionOptions['trusted']> {
  return { replanReservation: reservation(state, proposalId) };
}

test('replan keeps the plan baseline evidence ID and refuses a candidate that swaps it for the revision digest', async () => {
  const { task, state, plan } = investigateFixture();
  const proposalId = 'gap-material-replan-1';
  const trustedTransitionContext = transitionContext(state, proposalId);
  const statePort = new MemoryStatePort({
    initialTaskState: state,
    transitionContexts: { [state.stateVersion + 1]: trustedTransitionContext },
  });
  const strategy = 'Raise the domain error before dividing, and name the operand.';
  const candidatePlan: FixPlan = { ...plan, strategy, strategyDigest: computeCanonicalSha256(strategy) };

  const accepted = await executeReplan({ taskId: task.taskId, candidatePlan, proposalId }, { statePort, trustedTransitionContext });
  assert.equal(accepted.outcome, 'REPLAN_PREPARED', accepted.reasons.join('; '));
  assert.equal(accepted.state.node, 'AwaitPlan');
  // The recorded baseline evidence ID survives the replan; replacing it with the revision digest
  // would make the plan uncompletable, because completion binds `baseline.evidenceId`.
  assert.equal(accepted.state.plan?.baselineRef, BASELINE_REF);
  assert.equal(accepted.state.plan?.decisionRef, undefined, 'the prior decision is invalidated');
  assert.equal(accepted.state.activeDecisionId, undefined);

  const rejected = investigateFixture();
  const rejectingPort = new MemoryStatePort({ initialTaskState: rejected.state });
  const swapped = await executeReplan(
    { taskId: rejected.task.taskId, candidatePlan: { ...candidatePlan, baselineRef: rejected.task.initialRevisionDigest }, proposalId: 'gap-material-replan-2' },
    { statePort: rejectingPort },
  );
  assert.equal(swapped.outcome, 'INCOMPLETE');
  assert.deepEqual(swapped.reasons, ['candidate-plan-binding-mismatch']);
  assert.deepEqual(await rejectingPort.loadTask(rejected.task.taskId), rejected.state, 'a refused candidate writes nothing');
});

test(
  'subset repair: a settled repair that touches fewer paths than the cumulative diff still completes',
  {
    skip: 'BLOCKED outside T053 owned paths: src/uc03/graph-completion.ts:131 compares the latest admitted patch targetPaths to the cumulative inspectDiff(initialRevision).changedFiles, so an A+B patch followed by a B-only repair is refused. The fix needs graph-completion.ts, which this task does not own.',
  },
  async () => {
    // Kept as the recorded SPEC-R3-001 witness location. Un-skip when the predicate separates the
    // latest attempt's authorization from the cumulative diff inventory.
  },
);
