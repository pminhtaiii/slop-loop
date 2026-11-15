/**
 * T044 material replan transaction (real-tier contract §(b)6, host contract §4): one charged plan
 * transition to renewed approval under CAS, written with a `uc04-journal:` operation record;
 * idempotent replay; bounded denials; and an uncertain write outcome resolved only by the T040
 * exact-operation lookup. All values are synthetic; the durable store lives in a temp directory.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { computeCanonicalSha256, computeCheckSetDigest } from '../../../src/contracts/foundation/uc03.ts';
import type { BudgetLedger, BudgetReservation, BugTask, FixPlan, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { createMaterialReplanPort } from '../../../src/persistence/adapters/material-replan-port.ts';
import { createJournalOperationLookup } from '../../../src/persistence/adapters/state-port-v02-operation-lookup.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { executeReplan } from '../../../src/uc03/repair.ts';
import type { TrustedReplanDirection } from '../../../src/uc03/repair-types.ts';
import type { MaterialReplanPortV02, MaterialReplanRequestV02 } from '../../../src/uc03/graph-types-v02.ts';
import { createFixtureBugTask, createFixtureTaskState } from '../support/uc03/port-fixtures.ts';

const PROPOSAL = 'replan-prop-001';
const CHANGED_STRATEGY = 'Check divisor == 0 and raise CalculationError';
const OTHER_STRATEGY = 'Return zero for a zero divisor';
const fixtureTask: BugTask = createFixtureBugTask();

function planOf(source: BugTask): FixPlan {
  const strategy = 'Check divisor == 0 before division';
  return {
    planVersion: 1,
    diagnosis: 'Calculator.divide does not check the divisor',
    suspectedCauseLocations: ['src/calculator.py:3'],
    evidenceRefs: ['evi-repro-001'],
    strategy,
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: computeCheckSetDigest(source.requiredChecks),
    baselineRef: source.initialRevisionDigest,
    strategyDigest: computeCanonicalSha256(strategy),
    decisionRef: 'dec-plan-001',
  };
}

function budget(kind: string, limit: number, unit: 'count' | 'usd', overrides?: Partial<BudgetLedger>): BudgetLedger {
  return { scope: 'task', kind, limit, consumed: 0, reservations: [], unit, configurationId: fixtureTask.configId, version: 1, ...overrides };
}

function defaultLedgers(): readonly BudgetLedger[] {
  return [budget('replan', 3, 'count'), budget('repair', 2, 'count'), budget('tokens', fixtureTask.budgetLimits.maxTokens, 'count'), budget('cost', fixtureTask.budgetLimits.maxCostUsd, 'usd')];
}

/** A task paused at AwaitFeedback with a recorded, approved plan: the only state a revise direction binds. */
function seedState(overrides?: Partial<TaskState>): TaskState {
  const plan = planOf(fixtureTask);
  return createFixtureTaskState({
    stateVersion: 1,
    node: 'AwaitFeedback',
    nextAction: 'await-human-direction',
    planVersion: 1,
    plan,
    activeDecisionId: plan.decisionRef,
    replanCount: 0,
    budgetLedgers: defaultLedgers(),
    ...overrides,
  });
}

function candidateOf(plan: FixPlan, strategy = CHANGED_STRATEGY): FixPlan {
  return { ...plan, strategy, strategyDigest: computeCanonicalSha256(strategy), decisionRef: undefined };
}

function directionOf(state: TaskState, overrides?: Partial<TrustedReplanDirection>): TrustedReplanDirection {
  const plan = state.plan as FixPlan;
  return {
    directive: 'revise',
    taskId: state.taskId,
    workspaceId: state.workspaceId,
    repositoryRevisionDigest: state.repositoryRevisionDigest,
    stateVersion: state.stateVersion,
    planVersion: state.planVersion,
    rejectedDecisionId: plan.decisionRef ?? '',
    strategyDigest: plan.strategyDigest,
    ...overrides,
  };
}

function requestOf(state: TaskState, candidate: FixPlan, overrides?: Partial<MaterialReplanRequestV02>): MaterialReplanRequestV02 {
  return {
    taskId: state.taskId,
    runId: state.runId,
    workspaceId: state.workspaceId,
    repositoryId: state.repositoryId,
    configurationId: state.taskContext?.configId ?? '',
    configurationVersion: state.taskContext?.configVersion ?? '',
    proposalId: PROPOSAL,
    candidatePlan: candidate,
    candidatePlanDigest: computeCanonicalSha256(candidate),
    priorPlanVersion: state.planVersion,
    priorStateVersion: state.stateVersion,
    priorReplanCount: state.replanCount,
    expectedNextReplanCount: state.replanCount + 1,
    direction: directionOf(state),
    ...overrides,
  };
}

interface OpenCase {
  readonly port: DurableStatePortV02;
  readonly state: TaskState;
  readonly replan: MaterialReplanPortV02;
  readonly close: () => void;
}

async function openCase(options?: {
  readonly state?: TaskState;
  readonly verifyDirection?: (state: TaskState) => boolean | Promise<boolean>;
  readonly commitTransaction?: (write: () => Promise<void>) => Promise<void>;
}): Promise<OpenCase> {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-material-replan-'));
  const store = new DurableStore(baseDir);
  await store.init();
  const port = new DurableStatePortV02({ store });
  const state = options?.state ?? seedState();
  await port.transition(state, 0);
  const replan = createMaterialReplanPort({
    state: port,
    verifyDirection: options?.verifyDirection ?? (() => true),
    ...(options?.commitTransaction ? { commitTransaction: options.commitTransaction } : {}),
  });
  return { port, state, replan, close: () => rmSync(baseDir, { recursive: true, force: true }) };
}

test('material replan: one accepted revision charges once, renews approval and clears prior authority in the same write', async () => {
  const c = await openCase();
  try {
    const candidate = candidateOf(c.state.plan as FixPlan);
    const result = await c.replan.accept(requestOf(c.state, candidate));
    assert.equal(result.outcome, 'accepted');
    if (result.outcome !== 'accepted') return;

    const committed = await c.port.loadTask(c.state.taskId);
    assert.ok(committed);
    assert.deepEqual(committed, result.state, 'the receipt must name the state that was persisted');
    assert.equal(committed.stateVersion, c.state.stateVersion + 2, 'AwaitFeedback reaches AwaitPlan only through Investigate');
    assert.equal(committed.node, 'AwaitPlan');
    assert.equal(committed.nextAction, 'approve-fix-plan');
    assert.equal(committed.replanCount, 1);
    assert.equal(committed.planVersion, 2);
    assert.equal(committed.plan?.strategy, CHANGED_STRATEGY);
    assert.equal(committed.plan?.planVersion, 2);
    const renewed = committed.plan?.decisionRef;
    assert.ok(renewed && renewed !== c.state.activeDecisionId, 'a renewed plan needs a fresh decision id');
    assert.equal(committed.activeDecisionId, renewed);
    assert.equal(committed.latestReviewRef, undefined);
    assert.deepEqual(committed.reviewRefs, []);
    assert.deepEqual(committed.approvalDecisionRefs, [], 'prior decision authority cannot survive the renewed plan');

    const replanLedger = committed.budgetLedgers?.find(item => item.scope === 'task' && item.kind === 'replan');
    assert.equal(replanLedger?.reservations.length, 1, 'exactly one replan slot is charged');
    assert.equal(replanLedger?.reservations[0]?.keyedId, PROPOSAL);
    assert.equal(replanLedger?.reservations[0]?.reservationId, result.reservationReceipt);
    assert.equal(replanLedger?.consumed, 0);

    const records = readdirSync(join(c.port.store.claimDir, c.state.taskId, 'v02')).filter(name => name.startsWith('operation-replan-'));
    assert.equal(records.length, 1, 'the transition and its journal record are written together');
  } finally {
    c.close();
  }
});

test('material replan: an identical replay is already-accepted with the same state and receipts and no second charge', async () => {
  const c = await openCase();
  try {
    const candidate = candidateOf(c.state.plan as FixPlan);
    const request = requestOf(c.state, candidate);
    const first = await c.replan.accept(request);
    assert.equal(first.outcome, 'accepted');
    const afterFirst = await c.port.loadTask(c.state.taskId);

    const replay = await c.replan.accept(request);
    assert.equal(replay.outcome, 'already-accepted');
    if (first.outcome !== 'accepted' || replay.outcome !== 'already-accepted') return;
    assert.deepEqual(replay.state, first.state, 'a replay returns the committed state');
    assert.equal(replay.reservationReceipt, first.reservationReceipt);
    assert.equal(replay.transitionReceipt, first.transitionReceipt);
    assert.deepEqual(await c.port.loadTask(c.state.taskId), afterFirst, 'a replay writes nothing');

    const replanLedger = replay.state.budgetLedgers?.find(item => item.scope === 'task' && item.kind === 'replan');
    assert.equal(replanLedger?.reservations.length, 1, 'a replay is never charged twice');
  } finally {
    c.close();
  }
});

test('material replan: the same proposal id with changed content or a substituted digest is denied and leaves state unchanged', async () => {
  const c = await openCase();
  try {
    const plan = c.state.plan as FixPlan;
    const accepted = await c.replan.accept(requestOf(c.state, candidateOf(plan)));
    assert.equal(accepted.outcome, 'accepted');
    const committed = await c.port.loadTask(c.state.taskId);

    const other = candidateOf(plan, OTHER_STRATEGY);
    const rebound = await c.replan.accept(requestOf(c.state, other));
    assert.equal(rebound.outcome, 'denied');
    if (rebound.outcome === 'denied') assert.equal(rebound.reason, 'proposal-bound-to-different-content');
    assert.deepEqual(await c.port.loadTask(c.state.taskId), committed, 'a denial mutates nothing');

    const substituted = await c.replan.accept({ ...requestOf(c.state, other), candidatePlanDigest: computeCanonicalSha256(plan) });
    assert.equal(substituted.outcome, 'denied');
    if (substituted.outcome === 'denied') assert.equal(substituted.reason, 'candidate-plan-digest-mismatch');
    assert.deepEqual(await c.port.loadTask(c.state.taskId), committed);
  } finally {
    c.close();
  }
});

test('material replan: two concurrent proposals under CAS yield exactly one winner', async () => {
  const c = await openCase();
  try {
    const plan = c.state.plan as FixPlan;
    const [a, b] = await Promise.all([
      c.replan.accept(requestOf(c.state, candidateOf(plan, CHANGED_STRATEGY), { proposalId: 'replan-prop-a' })),
      c.replan.accept(requestOf(c.state, candidateOf(plan, OTHER_STRATEGY), { proposalId: 'replan-prop-b' })),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    assert.deepEqual(outcomes, ['accepted', 'denied'], 'exactly one proposal may win the CAS');

    const committed = await c.port.loadTask(c.state.taskId);
    assert.equal(committed?.replanCount, 1);
    const replanLedger = committed?.budgetLedgers?.find(item => item.scope === 'task' && item.kind === 'replan');
    assert.equal(replanLedger?.reservations.length, 1, 'the loser is never charged');
  } finally {
    c.close();
  }
});

test('material replan: the fourth material replan is denied before any mutation', async () => {
  const reservations: readonly BudgetReservation[] = [
    { reservationId: 'res-replan-a', keyedId: 'prop-a', amount: 1 },
    { reservationId: 'res-replan-b', keyedId: 'prop-b', amount: 1 },
    { reservationId: 'res-replan-c', keyedId: 'prop-c', amount: 1 },
  ];
  const capped = seedState({
    replanCount: 3,
    planVersion: 4,
    plan: { ...planOf(fixtureTask), planVersion: 4 },
    budgetLedgers: [budget('replan', 3, 'count', { reservations, version: 2 }), ...defaultLedgers().slice(1)],
  });
  const c = await openCase({ state: capped });
  try {
    const result = await c.replan.accept(requestOf(capped, candidateOf(capped.plan as FixPlan)));
    assert.equal(result.outcome, 'denied');
    if (result.outcome === 'denied') assert.equal(result.reason, 'replan-cap-exceeded');
    assert.deepEqual(await c.port.loadTask(capped.taskId), capped, 'the cap denies before mutation');
  } finally {
    c.close();
  }
});

test('material replan: a direction the injected verifyDirection rejects is denied, as is a stale or non-revise one', async () => {
  const refused = await openCase({ verifyDirection: () => false });
  try {
    const result = await refused.replan.accept(requestOf(refused.state, candidateOf(refused.state.plan as FixPlan)));
    assert.equal(result.outcome, 'denied');
    if (result.outcome === 'denied') assert.equal(result.reason, 'direction-not-verified');
    assert.deepEqual(await refused.port.loadTask(refused.state.taskId), refused.state);
  } finally {
    refused.close();
  }

  const unavailable = await openCase({
    verifyDirection: () => {
      throw new Error('approval service unavailable');
    },
  });
  try {
    const result = await unavailable.replan.accept(requestOf(unavailable.state, candidateOf(unavailable.state.plan as FixPlan)));
    assert.equal(result.outcome, 'denied', 'an unavailable direction authority authorizes nothing');
  } finally {
    unavailable.close();
  }

  const c = await openCase();
  try {
    const plan = c.state.plan as FixPlan;
    const cases: readonly (readonly [string, MaterialReplanRequestV02])[] = [
      ['a resume directive', requestOf(c.state, candidateOf(plan), { direction: directionOf(c.state, { directive: 'resume' }) })],
      ['a stale direction', requestOf(c.state, candidateOf(plan), { direction: directionOf(c.state, { stateVersion: c.state.stateVersion + 1 }) })],
      ['a direction naming another decision', requestOf(c.state, candidateOf(plan), { direction: directionOf(c.state, { rejectedDecisionId: 'dec-plan-other' }) })],
    ];
    for (const [label, request] of cases) {
      const result = await c.replan.accept(request);
      assert.equal(result.outcome, 'denied', label);
      assert.deepEqual(await c.port.loadTask(c.state.taskId), c.state, `${label} mutates nothing`);
    }
  } finally {
    c.close();
  }
});

test('material replan: a held control head denies before mutation', async () => {
  const c = await openCase();
  try {
    assert.equal(await c.port.setTaskControl(c.state.taskId, 'paused', 'pause-t044-0001'), true);
    const result = await c.replan.accept(requestOf(c.state, candidateOf(c.state.plan as FixPlan)));
    assert.equal(result.outcome, 'denied');
    if (result.outcome === 'denied') assert.equal(result.reason, 'control-not-runnable');

    const paused = await c.port.loadTask(c.state.taskId);
    assert.equal(paused?.replanCount, 0, 'a paused task is never charged');
  } finally {
    c.close();
  }
});

test('material replan: an unknown write outcome is uncertain and the exact lookup proves committed after a lost acknowledgement', async () => {
  const c = await openCase({
    commitTransaction: async write => {
      await write();
      throw new Error('lost acknowledgement');
    },
  });
  try {
    const result = await c.replan.accept(requestOf(c.state, candidateOf(c.state.plan as FixPlan)));
    assert.equal(result.outcome, 'uncertain');
    if (result.outcome !== 'uncertain') return;
    assert.ok(result.operationRef.startsWith('uc04-journal:'), 'the ref carries its owner prefix');

    const committed = await c.port.loadTask(c.state.taskId);
    assert.notDeepEqual(committed, c.state, 'the write landed even though its acknowledgement was lost');
    const resolved = await createJournalOperationLookup(c.port).lookupOperation(result.operationRef);
    assert.equal(resolved.outcome, 'committed');
    if (resolved.outcome !== 'committed') return;
    assert.deepEqual(resolved.state, committed);
    assert.equal(resolved.commit.kind, 'operation');
    if (resolved.commit.kind !== 'operation') return;
    assert.match(resolved.commit.receipts[0] ?? '', /^replan-reservation-[0-9a-f]{64}$/u);
    assert.match(resolved.commit.receipts[1] ?? '', /^replan-transition-[0-9a-f]{64}$/u);
  } finally {
    c.close();
  }
});

test('material replan: an unknown write outcome with nothing written stays unknown, never absent', async () => {
  const c = await openCase({
    commitTransaction: async () => {
      throw new Error('write refused');
    },
  });
  try {
    const result = await c.replan.accept(requestOf(c.state, candidateOf(c.state.plan as FixPlan)));
    assert.equal(result.outcome, 'uncertain');
    if (result.outcome !== 'uncertain') return;

    assert.deepEqual(await c.port.loadTask(c.state.taskId), c.state, 'nothing was written');
    assert.deepEqual(await createJournalOperationLookup(c.port).lookupOperation(result.operationRef), { outcome: 'unknown' });
  } finally {
    c.close();
  }
});

test('material replan: the existing replan consumer binds the owner result to a prepared plan', async () => {
  const c = await openCase();
  try {
    const candidate = candidateOf(c.state.plan as FixPlan);
    const result = await executeReplan({ taskId: c.state.taskId, candidatePlan: candidate, proposalId: PROPOSAL }, { statePort: c.port, replanPort: c.replan, trustedDirection: directionOf(c.state) });
    assert.equal(result.outcome, 'REPLAN_PREPARED');
    assert.deepEqual(result.reasons, []);
    assert.equal(result.state.replanCount, 1);
    assert.equal(result.state.node, 'AwaitPlan');
    assert.deepEqual(result.state, await c.port.loadTask(c.state.taskId));
  } finally {
    c.close();
  }
});
