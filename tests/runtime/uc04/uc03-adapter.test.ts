import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetExhaustionError, BudgetTracker } from '../../../src/persistence/accounting.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import {
  UC03AccountingAdapter,
  UC03ReplanExhaustionError,
} from '../../../src/persistence/adapters/uc03-adapter.ts';
import type { BudgetLedger } from '../../../src/persistence/contracts.ts';

test('UC-04 / UC-03: Accounting & Recovery Adapter', async (t) => {
  const stores: DurableStore[] = [];
  const newStore = (): DurableStore => {
    const store = new DurableStore(mkdtempSync(join(tmpdir(), 'uc03-adapter-test-')));
    stores.push(store);
    return store;
  };

  t.after(() => {
    for (const store of stores) rmSync(store.baseDir, { recursive: true, force: true });
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
    const store = newStore();
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
    const store = newStore();
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
    const store = newStore();
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
    const store = newStore();
    const adapter = new UC03AccountingAdapter(budgetTracker, store);

    // Reserve 1000 tokens for repair
    const res = await adapter.reserveRepairAttempt(taskId, runId, 1000, 2);
    assert.ok(res.reservationId);

    // Simulate interrupted call (process crash / timeout)
    await adapter.handleInterruptedCall(taskId, runId, res.reservationId);

    const reconciled = await adapter.reconcileTaskBudgets(taskId, runId);
    assert.equal(reconciled.totalTokensConsumed, 1000);
    assert.equal(reconciled.totalCostConsumed, 2);
    assert.equal(reconciled.totalRepairConsumed, 1);

    // Tokens were retained as consumed; available is 4000
    assert.equal(budgetTracker.getAvailable('task', 'tokens'), 4000);
  });

  await t.test('settleAttempt falls back to reservation ceiling when usage is omitted', async () => {
    const budgetTracker = new BudgetTracker(initialLedgers);
    const store = newStore();
    const adapter = new UC03AccountingAdapter(budgetTracker, store);

    const res = await adapter.reserveInvestigation(taskId, runId, 750, 4);
    assert.ok(res.reservationId);

    // Caller omits tokens and cost
    const settleRes = await adapter.settleAttempt(res.reservationId, {});
    assert.equal(settleRes.consumedTokens, 750);
    assert.equal(settleRes.consumedCost, 4);
  });

  await t.test('a task journal holds only its own reservations after another task reserves', async () => {
    const budgetTracker = new BudgetTracker(initialLedgers);
    const store = newStore();
    const adapter = new UC03AccountingAdapter(budgetTracker, store);

    const resA = await adapter.reserveInvestigation('task-A', 'run-A', 500, 1);
    const resB = await adapter.reserveInvestigation('task-B', 'run-B', 300, 1);

    const journalB = await store.loadBudgetJournal('task-B');
    assert.ok(journalB);
    const keyedB = journalB.ledgers.flatMap((l) => l.reservations.map((r) => r.keyedId));
    assert.ok(keyedB.every((keyed) => keyed === resB.reservationId));
    assert.equal(keyedB.includes(resA.reservationId), false);

    const rebuilt = new UC03AccountingAdapter(new BudgetTracker(initialLedgers), store);
    const reconciledB = await rebuilt.reconcileTaskBudgets('task-B', 'run-B');
    assert.equal(reconciledB.totalTokensConsumed, 300);
  });

  await t.test('reconcileTaskBudgets filters reservations by task owner', async () => {
    const budgetTracker = new BudgetTracker(initialLedgers);
    const store = newStore();
    const adapter = new UC03AccountingAdapter(budgetTracker, store);

    const res1 = await adapter.reserveInvestigation('task-A', 'run-A', 500, 1);
    const res2 = await adapter.reserveInvestigation('task-B', 'run-B', 300, 1);
    assert.ok(res1.reservationId);
    assert.ok(res2.reservationId);

    // Reconcile task-A only
    const reconciledA = await adapter.reconcileTaskBudgets('task-A', 'run-A');
    assert.equal(reconciledA.totalTokensConsumed, 500);

    // task-B reservation should still be pending in the ledger
    const tokensLedger = budgetTracker.getLedgers().find((l) => l.kind === 'tokens');
    const remainingRes = tokensLedger?.reservations.find((r) => r.keyedId === res2.reservationId);
    assert.ok(remainingRes);
    assert.equal(remainingRes.amount, 300);
  });

  await t.test('belongsToTask isolates task prefixes and scopes replan counts', async () => {
    const budgetTracker = new BudgetTracker(initialLedgers);
    const store = newStore();
    const adapter = new UC03AccountingAdapter(budgetTracker, store);

    const res1 = await adapter.reserveInvestigation('task-1', 'run-1', 400, 1);
    const res2 = await adapter.reserveInvestigation('task-1-x', 'run-2', 600, 1);
    assert.ok(res1.reservationId);
    assert.ok(res2.reservationId);

    // Reconcile task-1 should not touch task-1-x
    const reconciled = await adapter.reconcileTaskBudgets('task-1', 'run-1');
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
    const store = newStore();
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

  await t.test('reserveInvestigation persists the reservation before acknowledging it', async () => {
    const budgetTracker = new BudgetTracker(initialLedgers);
    const store = newStore();
    const adapter = new UC03AccountingAdapter(budgetTracker, store);

    const res = await adapter.reserveInvestigation(taskId, runId, 1000, 2);

    const journal = await store.loadBudgetJournal(taskId);
    assert.ok(journal);
    assert.equal(journal.taskId, taskId);
    assert.equal(journal.runId, runId);
    assert.equal(journal.replanCount, 0);
    const tokens = journal.ledgers.find((l) => l.kind === 'tokens');
    const cost = journal.ledgers.find((l) => l.kind === 'cost');
    assert.equal(tokens?.reservations.find((r) => r.keyedId === res.reservationId)?.amount, 1000);
    assert.equal(cost?.reservations.find((r) => r.keyedId === res.reservationId)?.amount, 2);
  });

  await t.test('a reservation acknowledged before a crash stays held when rebuilt from the journal alone', async () => {
    const store = newStore();
    const first = new UC03AccountingAdapter(new BudgetTracker(initialLedgers), store);
    const res = await first.reserveInvestigation(taskId, runId, 1000, 2);

    const journal = await store.loadBudgetJournal(taskId);
    assert.ok(journal);
    const tracker = new BudgetTracker(journal.ledgers);
    const rebuilt = new UC03AccountingAdapter(tracker, store);

    assert.equal(tracker.getAvailable('task', 'tokens'), 4000);
    await assert.rejects(
      async () => {
        await rebuilt.reserveInvestigation(taskId, runId, 4500, 2);
      },
      (err: unknown) => err instanceof BudgetExhaustionError
    );
    const replay = await rebuilt.reserveInvestigation(taskId, runId, 4000, 2);
    assert.ok(replay.reservationId);
    assert.notEqual(replay.reservationId, res.reservationId);
    assert.equal(tracker.getAvailable('task', 'tokens'), 0);
  });

  await t.test('the durable journal overrides a stale caller-supplied tracker', async () => {
    const store = newStore();
    const first = new UC03AccountingAdapter(new BudgetTracker(initialLedgers), store);
    const res = await first.reserveInvestigation(taskId, runId, 1000, 2);
    await first.settleAttempt(res.reservationId, { tokens: 800, cost: 2 });

    const staleTracker = new BudgetTracker(initialLedgers);
    const rebuilt = new UC03AccountingAdapter(staleTracker, store);
    await rebuilt.reserveInvestigation(taskId, runId, 100, 1);

    assert.equal(staleTracker.getConsumed('task', 'tokens'), 800);
    assert.equal(staleTracker.getConsumed('task', 'cost'), 2);
    assert.equal(staleTracker.getAvailable('task', 'tokens'), 5000 - 800 - 100);
  });

  await t.test('a reconstructed adapter refuses the fourth replan even when the caller reports zero', async () => {
    const store = newStore();
    const tracker = new BudgetTracker(initialLedgers);
    const first = new UC03AccountingAdapter(tracker, store);
    for (let i = 0; i < 3; i++) {
      const r = await first.reserveReplan(taskId, runId, 100, i);
      await first.settleAttempt(r.reservationId, { tokens: 100 });
    }

    const journal = await store.loadBudgetJournal(taskId);
    assert.ok(journal);
    assert.equal(journal.replanCount, 3);

    const rebuilt = new UC03AccountingAdapter(new BudgetTracker(tracker.getLedgers()), store);
    await assert.rejects(
      async () => {
        await rebuilt.reserveReplan(taskId, runId, 100, 0);
      },
      (err: unknown) => err instanceof UC03ReplanExhaustionError
    );
  });

  await t.test('the persisted replan count is a high-water mark a caller cannot lower', async () => {
    const store = newStore();
    const tracker = new BudgetTracker(initialLedgers);
    const first = new UC03AccountingAdapter(tracker, store);
    for (let i = 0; i < 2; i++) {
      const r = await first.reserveReplan(taskId, runId, 100, i);
      await first.settleAttempt(r.reservationId, { tokens: 100 });
    }

    const rebuilt = new UC03AccountingAdapter(new BudgetTracker(tracker.getLedgers()), store);
    const third = await rebuilt.reserveReplan(taskId, runId, 100, 0);
    const settled = await rebuilt.settleAttempt(third.reservationId, { tokens: 100 });
    assert.equal(settled.consumedReplan, 3);

    await assert.rejects(
      async () => {
        await rebuilt.reserveReplan(taskId, runId, 100, 0);
      },
      (err: unknown) => err instanceof UC03ReplanExhaustionError
    );
  });

  await t.test('a failed journal write neither acknowledges nor retains the reservation', async () => {
    class ToggleStore extends DurableStore {
      failSaves = true;
      override async saveBudgetJournal(...args: Parameters<DurableStore['saveBudgetJournal']>): Promise<void> {
        if (this.failSaves) throw new Error('journal unavailable');
        await super.saveBudgetJournal(...args);
      }
    }

    const store = new ToggleStore(mkdtempSync(join(tmpdir(), 'uc03-adapter-test-')));
    stores.push(store);
    const budgetTracker = new BudgetTracker(initialLedgers);
    const adapter = new UC03AccountingAdapter(budgetTracker, store);

    await assert.rejects(
      async () => {
        await adapter.reserveInvestigation(taskId, runId, 1000, 2);
      },
      /journal unavailable/
    );
    assert.equal(budgetTracker.getAvailable('task', 'tokens'), 5000);
    assert.equal(budgetTracker.getAvailable('task', 'cost'), 20);
    assert.equal(await store.loadBudgetJournal(taskId), null);

    for (let i = 0; i < 4; i++) {
      await assert.rejects(
        async () => {
          await adapter.reserveReplan(taskId, runId, 100, 0);
        },
        /journal unavailable/
      );
    }
    assert.equal(budgetTracker.getAvailable('task', 'tokens'), 5000);

    store.failSaves = false;
    for (let i = 0; i < 3; i++) {
      const r = await adapter.reserveReplan(taskId, runId, 100, 0);
      await adapter.settleAttempt(r.reservationId, { tokens: 100 });
    }
    await assert.rejects(
      async () => {
        await adapter.reserveReplan(taskId, runId, 100, 0);
      },
      (err: unknown) => err instanceof UC03ReplanExhaustionError
    );
  });

  await t.test('settlement and reconciliation persist the consumed figures they report', async () => {
    const budgetTracker = new BudgetTracker(initialLedgers);
    const store = newStore();
    const adapter = new UC03AccountingAdapter(budgetTracker, store);

    const invest = await adapter.reserveInvestigation(taskId, runId, 1000, 2);
    const settled = await adapter.settleAttempt(invest.reservationId, { tokens: 800, cost: 2 });
    const afterSettle = await store.loadBudgetJournal(taskId);
    assert.ok(afterSettle);
    assert.equal(afterSettle.ledgers.find((l) => l.kind === 'tokens')?.consumed, settled.consumedTokens);
    assert.equal(afterSettle.ledgers.find((l) => l.kind === 'cost')?.consumed, settled.consumedCost);
    assert.equal(afterSettle.ledgers.find((l) => l.kind === 'tokens')?.reservations.length, 0);

    const repair = await adapter.reserveRepairAttempt(taskId, runId, 1000, 2);
    await adapter.handleInterruptedCall(taskId, runId, repair.reservationId);
    const afterInterrupt = await store.loadBudgetJournal(taskId);
    assert.ok(afterInterrupt);
    assert.equal(afterInterrupt.ledgers.find((l) => l.kind === 'tokens')?.consumed, 1800);
    assert.equal(afterInterrupt.ledgers.find((l) => l.kind === 'repair')?.consumed, 1);
    assert.equal(afterInterrupt.ledgers.find((l) => l.kind === 'tokens')?.reservations.length, 0);

    const reconciled = await adapter.reconcileTaskBudgets(taskId, runId);
    const afterReconcile = await store.loadBudgetJournal(taskId);
    assert.ok(afterReconcile);
    assert.equal(afterReconcile.ledgers.find((l) => l.kind === 'tokens')?.consumed, reconciled.totalTokensConsumed);
    assert.equal(afterReconcile.ledgers.find((l) => l.kind === 'cost')?.consumed, reconciled.totalCostConsumed);
    assert.equal(afterReconcile.ledgers.find((l) => l.kind === 'repair')?.consumed, reconciled.totalRepairConsumed);
  });

  await t.test('settling via a fresh instance keeps the journal run identity', async () => {
    const store = newStore();
    const tracker = new BudgetTracker(initialLedgers);
    const first = new UC03AccountingAdapter(tracker, store);
    const res = await first.reserveInvestigation(taskId, runId, 1000, 2);

    const rebuilt = new UC03AccountingAdapter(new BudgetTracker(tracker.getLedgers()), store);
    await rebuilt.settleAttempt(res.reservationId, { tokens: 800 });

    const journal = await store.loadBudgetJournal(taskId);
    assert.ok(journal);
    assert.equal(journal.runId, runId);
  });

  await t.test('settling an unknown task without a journal writes no journal', async () => {
    const budgetTracker = new BudgetTracker(initialLedgers);
    const store = newStore();

    const held = await new UC03AccountingAdapter(budgetTracker).reserveInvestigation('task-ghost', 'run-ghost', 100, 1);
    const rebuilt = new UC03AccountingAdapter(budgetTracker, store);
    const settled = await rebuilt.settleAttempt(held.reservationId, { tokens: 100, cost: 1 });

    assert.equal(settled.consumedTokens, 100);
    assert.equal(await store.loadBudgetJournal('task-ghost'), null);
  });
});
