import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetTracker } from '../../../src/persistence/accounting.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import {
  UC03AccountingAdapter,
  UC03ReplanExhaustionError,
} from '../../../src/persistence/adapters/uc03-adapter.ts';
import type { BudgetLedger } from '../../../src/persistence/contracts.ts';

test('UC-04 / UC-03: Accounting & Recovery Adapter', async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'uc03-adapter-test-'));

  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const taskId = 'task-bugfix-1';
  const runId = 'run-1';

  const initialLedgers: BudgetLedger[] = [
    {
      scope: 'task',
      kind: 'tokens',
      limit: 5000,
      consumed: 0,
      reservations: [],
      configurationId: 'cfg-tokens',
      version: 1,
    },
    {
      scope: 'task',
      kind: 'cost',
      limit: 20,
      consumed: 0,
      reservations: [],
      configurationId: 'cfg-cost',
      version: 1,
    },
    {
      scope: 'task',
      kind: 'repair',
      limit: 5,
      consumed: 0,
      reservations: [],
      configurationId: 'cfg-repair',
      version: 1,
    },
  ];

  await t.test('reserves and settles for investigation call', async () => {
    const budgetTracker = new BudgetTracker(initialLedgers);
    const store = new DurableStore(tempDir);
    const adapter = new UC03AccountingAdapter(budgetTracker, store);

    const res = await adapter.reserveInvestigation(taskId, runId, 1000, 2);
    assert.ok(res.reservationId);
    assert.equal(res.kind, 'investigation');
    assert.equal(budgetTracker.getAvailable('task', 'tokens'), 4000);

    const settleRes = await adapter.settleAttempt(res.reservationId, { tokens: 800, cost: 2 });
    assert.equal(settleRes.consumedTokens, 800);
    assert.equal(settleRes.consumedCost, 2);
    assert.equal(budgetTracker.getAvailable('task', 'tokens'), 4200);
  });

  await t.test('reserves repair attempt and decrements repair allowance', async () => {
    const budgetTracker = new BudgetTracker(initialLedgers);
    const store = new DurableStore(tempDir);
    const adapter = new UC03AccountingAdapter(budgetTracker, store);

    const res = await adapter.reserveRepairAttempt(taskId, runId, 1500, 3);
    assert.ok(res.reservationId);
    assert.equal(res.kind, 'repair');
    assert.equal(budgetTracker.getAvailable('task', 'repair'), 4); // 5 - 1 = 4

    const settleRes = await adapter.settleAttempt(res.reservationId, { tokens: 1200, cost: 2 });
    assert.equal(settleRes.consumedTokens, 1200);
    assert.equal(settleRes.consumedRepair, 1);
  });

  await t.test('enforces max 3 replans limit strictly (ADR-0004)', async () => {
    const budgetTracker = new BudgetTracker(initialLedgers);
    const store = new DurableStore(tempDir);
    const adapter = new UC03AccountingAdapter(budgetTracker, store);

    // Replans 0, 1, 2 are permitted
    const r1 = await adapter.reserveReplan(taskId, runId, 500, 0);
    assert.ok(r1.reservationId);
    await adapter.settleAttempt(r1.reservationId, { tokens: 400 });

    const r2 = await adapter.reserveReplan(taskId, runId, 500, 1);
    assert.ok(r2.reservationId);
    await adapter.settleAttempt(r2.reservationId, { tokens: 450 });

    const r3 = await adapter.reserveReplan(taskId, runId, 500, 2);
    assert.ok(r3.reservationId);
    await adapter.settleAttempt(r3.reservationId, { tokens: 480 });

    // 4th replan (replanCount = 3) MUST throw UC03ReplanExhaustionError
    await assert.rejects(
      async () => {
        await adapter.reserveReplan(taskId, runId, 500, 3);
      },
      (err: Error) => {
        assert.ok(err instanceof UC03ReplanExhaustionError);
        assert.match(err.message, /maximum 3 replans/);
        return true;
      }
    );
  });

  await t.test('handles interrupted calls without resetting or duplicating allowance', async () => {
    const budgetTracker = new BudgetTracker(initialLedgers);
    const store = new DurableStore(tempDir);
    const adapter = new UC03AccountingAdapter(budgetTracker, store);

    // Reserve 1000 tokens for repair
    const res = await adapter.reserveRepairAttempt(taskId, runId, 1000, 2);
    assert.ok(res.reservationId);

    // Simulate interrupted call (process crash / timeout)
    adapter.handleInterruptedCall(taskId, runId, res.reservationId);

    const reconciled = adapter.reconcileTaskBudgets(taskId, runId);
    assert.equal(reconciled.totalTokensConsumed, 1000);
    assert.equal(reconciled.totalCostConsumed, 2);
    assert.equal(reconciled.totalRepairConsumed, 1);

    // Tokens were retained as consumed; available is 4000
    assert.equal(budgetTracker.getAvailable('task', 'tokens'), 4000);
  });

  await t.test('settleAttempt falls back to reservation ceiling when usage is omitted', async () => {
    const budgetTracker = new BudgetTracker(initialLedgers);
    const store = new DurableStore(tempDir);
    const adapter = new UC03AccountingAdapter(budgetTracker, store);

    const res = await adapter.reserveInvestigation(taskId, runId, 750, 4);
    assert.ok(res.reservationId);

    // Caller omits tokens and cost
    const settleRes = await adapter.settleAttempt(res.reservationId, {});
    assert.equal(settleRes.consumedTokens, 750);
    assert.equal(settleRes.consumedCost, 4);
  });

  await t.test('reconcileTaskBudgets filters reservations by task owner', async () => {
    const budgetTracker = new BudgetTracker(initialLedgers);
    const store = new DurableStore(tempDir);
    const adapter = new UC03AccountingAdapter(budgetTracker, store);

    const res1 = await adapter.reserveInvestigation('task-A', 'run-A', 500, 1);
    const res2 = await adapter.reserveInvestigation('task-B', 'run-B', 300, 1);
    assert.ok(res1.reservationId);
    assert.ok(res2.reservationId);

    // Reconcile task-A only
    const reconciledA = adapter.reconcileTaskBudgets('task-A', 'run-A');
    assert.equal(reconciledA.totalTokensConsumed, 500);

    // task-B reservation should still be pending in the ledger
    const tokensLedger = budgetTracker.getLedgers().find((l) => l.kind === 'tokens');
    const remainingRes = tokensLedger?.reservations.find((r) => r.keyedId === res2.reservationId);
    assert.ok(remainingRes);
    assert.equal(remainingRes.amount, 300);
  });

  await t.test('belongsToTask isolates task prefixes and scopes replan counts', async () => {
    const budgetTracker = new BudgetTracker(initialLedgers);
    const store = new DurableStore(tempDir);
    const adapter = new UC03AccountingAdapter(budgetTracker, store);

    const res1 = await adapter.reserveInvestigation('task-1', 'run-1', 400, 1);
    const res2 = await adapter.reserveInvestigation('task-1-x', 'run-2', 600, 1);
    assert.ok(res1.reservationId);
    assert.ok(res2.reservationId);

    // Reconcile task-1 should not touch task-1-x
    const reconciled = adapter.reconcileTaskBudgets('task-1', 'run-1');
    assert.equal(reconciled.totalTokensConsumed, 400);

    const tokensLedger = budgetTracker.getLedgers().find((l) => l.kind === 'tokens');
    const remainingRes = tokensLedger?.reservations.find((r) => r.keyedId === res2.reservationId);
    assert.ok(remainingRes);
    assert.equal(remainingRes.amount, 600);

    // Reserve and settle replan for task-1 and task-1-x to verify isolated replan counts
    const replan1 = await adapter.reserveReplan('task-1', 'run-1', 100, 0);
    const settle1 = await adapter.settleAttempt(replan1.reservationId, { tokens: 100 });
    assert.equal(settle1.consumedReplan, 1);

    const replan2 = await adapter.reserveReplan('task-1-x', 'run-2', 100, 0);
    const settle2 = await adapter.settleAttempt(replan2.reservationId, { tokens: 100 });
    assert.equal(settle2.consumedReplan, 1);
  });

  await t.test('reserveReplan rejects invalid currentReplanCount with RangeError', async () => {
    const budgetTracker = new BudgetTracker(initialLedgers);
    const store = new DurableStore(tempDir);
    const adapter = new UC03AccountingAdapter(budgetTracker, store);

    await assert.rejects(
      async () => {
        await adapter.reserveReplan('task-1', 'run-1', 100, -1);
      },
      (err: Error) => {
        assert.ok(err instanceof RangeError);
        assert.match(err.message, /non-negative safe integer/);
        return true;
      }
    );
    await assert.rejects(
      async () => {
        await adapter.reserveReplan('task-1', 'run-1', 100, 1.5);
      },
      (err: Error) => {
        assert.ok(err instanceof RangeError);
        return true;
      }
    );
  });
});
