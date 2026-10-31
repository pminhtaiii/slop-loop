import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetTracker } from '../../../src/persistence/accounting.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { UC01AccountingAdapter } from '../../../src/persistence/adapters/uc01-adapter.ts';
import type { BudgetLedger } from '../../../src/persistence/contracts.ts';

test('UC-04 / UC-01: Accounting & Recovery Adapter', async (t) => {
  const stores: DurableStore[] = [];
  const newStore = (): DurableStore => {
    const store = new DurableStore(mkdtempSync(join(tmpdir(), 'uc01-adapter-test-')));
    stores.push(store);
    return store;
  };

  t.after(() => {
    for (const store of stores) rmSync(store.baseDir, { recursive: true, force: true });
  });

  const taskId = 'task-uc01-triage';
  const runId = 'run-1';

  const initialLedgers: BudgetLedger[] = [
    {
      scope: 'task',
      kind: 'tokens',
      limit: 1000,
      consumed: 0,
      reservations: [],
      configurationId: 'cfg-tokens',
      version: 1,
    },
    {
      scope: 'task',
      kind: 'cost',
      limit: 10,
      consumed: 0,
      reservations: [],
      configurationId: 'cfg-cost',
      version: 1,
    },
  ];

  await t.test('reserves and settles tokens normally for LLM assessment', async () => {
    const budgetTracker = new BudgetTracker(initialLedgers);
    const store = newStore();
    const adapter = new UC01AccountingAdapter(budgetTracker, store);

    const context = {
      taskId,
      runId,
      requestId: 'req-assess-1',
      accountingRef: 'account-1',
    };

    const ceiling = {
      inputTokens: 300,
      outputTokens: 200,
      totalTokens: 500,
      costUnits: 1,
      pricingId: 'pricing-1',
    };

    const reserveResult = await adapter.reserve(context, ceiling);
    assert.equal(reserveResult.ok, true);
    assert.ok(reserveResult.reservationRef);

    const afterReserve = await store.loadBudgetJournal(taskId);
    assert.ok(afterReserve);
    const reservedTokens = afterReserve.ledgers.find((l) => l.kind === 'tokens');
    assert.equal(reservedTokens?.reservations.find((r) => r.keyedId === context.requestId)?.amount, 500);

    // Tokens are now reserved (available should be 500)
    assert.equal(budgetTracker.getAvailable('task', 'tokens'), 500);

    const ref = reserveResult.reservationRef ?? 'ref';
    // Settle observed usage (say, exactly 500 tokens used)
    const settleResult = await adapter.settle(context, ref, {
      inputTokens: 300,
      outputTokens: 200,
      totalTokens: 500,
      costUnits: 1,
      state: 'settled',
      reservationRef: ref,
    });

    assert.equal(settleResult.kind, 'settled');
    assert.equal(settleResult.consumedTokens, 500);
    assert.equal(settleResult.consumedCost, 1);
    assert.equal(budgetTracker.getConsumed('task', 'tokens'), 500);
    assert.equal(budgetTracker.getAvailable('task', 'tokens'), 500);

    const afterSettle = await store.loadBudgetJournal(taskId);
    assert.ok(afterSettle);
    assert.equal(afterSettle.ledgers.find((l) => l.kind === 'tokens')?.consumed, settleResult.consumedTokens);
    assert.equal(afterSettle.ledgers.find((l) => l.kind === 'cost')?.consumed, settleResult.consumedCost);
    assert.equal(afterSettle.ledgers.find((l) => l.kind === 'tokens')?.reservations.length, 0);
  });

  await t.test(
    'reconciliation after interruption: preserves 500 tokens used and prevents blind replay',
    async () => {
      // Scenario: Fresh task with 1,000 token limit
      const budgetTracker = new BudgetTracker(initialLedgers);
      const store = newStore();
      const adapter = new UC01AccountingAdapter(budgetTracker, store);

      const context = {
        taskId,
        runId,
        requestId: 'req-interrupted-call',
        accountingRef: 'account-1',
      };

      const ceiling = {
        inputTokens: 300,
        outputTokens: 200,
        totalTokens: 500,
        costUnits: 1,
        pricingId: 'pricing-1',
      };

      // 1. LLM call reserves 500 tokens and 1 cost unit
      const reserveResult = await adapter.reserve(context, ceiling);
      assert.equal(reserveResult.ok, true);

      // 2. CRASH happens! Process is interrupted before settle is called.
      // 3. On restart / recovery: reconcileAfterInterrupt is called
      const summary = await adapter.reconcileAfterInterrupt(taskId, runId);

      // 4. Verify: Agent does NOT forget the 500 tokens consumed!
      assert.equal(summary.preservedConsumedTokens, 500);
      assert.equal(summary.preservedConsumedCost, 1);
      assert.equal(summary.uncertainReservationsRetained, 2); // token + cost reservations
      assert.equal(summary.blindReplayPrevented, true);

      // Consumed amount remains at least 500
      assert.equal(budgetTracker.getConsumed('task', 'tokens'), 500);
      // Available allowance is reduced to 500
      assert.equal(budgetTracker.getAvailable('task', 'tokens'), 500);

      // Attempting to request 600 tokens now will fail due to budget exhaustion
      const excessiveCeiling = {
        inputTokens: 400,
        outputTokens: 200,
        totalTokens: 600,
        costUnits: 1,
        pricingId: 'pricing-1',
      };
      const deniedResult = await adapter.reserve(context, excessiveCeiling);
      assert.equal(deniedResult.ok, false);
      assert.equal(deniedResult.reasonCode, 'call-budget-exhausted');
    }
  );

  await t.test('saves step checkpoints to durable store', async () => {
    const budgetTracker = new BudgetTracker(initialLedgers);
    const store = newStore();
    const adapter = new UC01AccountingAdapter(budgetTracker, store);

    await adapter.saveCheckpoint(taskId, 'intake', { issueId: 'ISSUE-100', title: 'Bug in auth' });
    await adapter.saveCheckpoint(taskId, 'clarify', { clarified: true, questions: [] });

    const state = await store.loadTask(taskId);
    assert.ok(state);
    assert.equal(state.taskId, taskId);
    assert.equal(state.plan[0]?.status, 'done');
    assert.equal(state.plan[1]?.status, 'done');
    assert.equal(state.plan[2]?.status, 'doing');

    const latestCheckpoint = await store.loadLatestCheckpoint(taskId);
    assert.ok(latestCheckpoint);
    assert.equal(latestCheckpoint.stateVersion, 2);
  });

  await t.test('saveCheckpoint rejects invalid stepData with validation error', async () => {
    const budgetTracker = new BudgetTracker(initialLedgers);
    const store = newStore();
    const adapter = new UC01AccountingAdapter(budgetTracker, store);

    await assert.rejects(
      async () => {
        await adapter.saveCheckpoint(taskId, 'intake', undefined);
      },
      /Invalid stepData/
    );
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    await assert.rejects(
      async () => {
        await adapter.saveCheckpoint(taskId, 'intake', circular);
      },
      /Invalid stepData/
    );
  });

  await t.test('a reservation acknowledged before a crash stays held when rebuilt from the journal alone', async () => {
    const store = newStore();
    const first = new UC01AccountingAdapter(new BudgetTracker(initialLedgers), store);
    const context = { taskId, runId, requestId: 'req-crash', accountingRef: 'account-1' };
    const ceiling = { inputTokens: 300, outputTokens: 200, totalTokens: 500, costUnits: 1, pricingId: 'pricing-1' };
    const reserved = await first.reserve(context, ceiling);
    assert.equal(reserved.ok, true);

    const journal = await store.loadBudgetJournal(taskId);
    assert.ok(journal);
    const tracker = new BudgetTracker(journal.ledgers);
    const rebuilt = new UC01AccountingAdapter(tracker, store);

    assert.equal(tracker.getAvailable('task', 'tokens'), 500);
    const replay = await rebuilt.reserve({ ...context, requestId: 'req-replay' }, {
      inputTokens: 300,
      outputTokens: 200,
      totalTokens: 600,
      costUnits: 1,
      pricingId: 'pricing-1',
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.reasonCode, 'call-budget-exhausted');
  });

  await t.test('a journal write failure refuses the reservation instead of acknowledging it', async () => {
    class FailingStore extends DurableStore {
      override async saveBudgetJournal(): Promise<void> {
        throw new Error('journal unavailable');
      }
    }

    const store = new FailingStore(mkdtempSync(join(tmpdir(), 'uc01-adapter-test-')));
    stores.push(store);
    const budgetTracker = new BudgetTracker(initialLedgers);
    const adapter = new UC01AccountingAdapter(budgetTracker, store);
    const context = { taskId, runId, requestId: 'req-no-journal', accountingRef: 'account-1' };
    const ceiling = { inputTokens: 300, outputTokens: 200, totalTokens: 500, costUnits: 1, pricingId: 'pricing-1' };

    const result = await adapter.reserve(context, ceiling);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'reservation-failed');
    assert.equal(budgetTracker.getAvailable('task', 'tokens'), 1000);
    assert.equal(budgetTracker.getAvailable('task', 'cost'), 10);
  });

  await t.test('reconciliation persists the consumed figures it reports', async () => {
    const budgetTracker = new BudgetTracker(initialLedgers);
    const store = newStore();
    const adapter = new UC01AccountingAdapter(budgetTracker, store);
    const context = { taskId, runId, requestId: 'req-interrupt-journal', accountingRef: 'account-1' };

    const reserved = await adapter.reserve(context, {
      inputTokens: 300,
      outputTokens: 200,
      totalTokens: 500,
      costUnits: 1,
      pricingId: 'pricing-1',
    });
    assert.equal(reserved.ok, true);

    const summary = await adapter.reconcileAfterInterrupt(taskId, runId);
    const journal = await store.loadBudgetJournal(taskId);
    assert.ok(journal);
    assert.equal(journal.ledgers.find((l) => l.kind === 'tokens')?.consumed, summary.preservedConsumedTokens);
    assert.equal(journal.ledgers.find((l) => l.kind === 'cost')?.consumed, summary.preservedConsumedCost);
    assert.equal(journal.ledgers.find((l) => l.kind === 'tokens')?.reservations.length, 0);
  });
});
