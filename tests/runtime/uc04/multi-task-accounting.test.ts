import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetTracker } from '../../../src/persistence/accounting.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { UC01AccountingAdapter } from '../../../src/persistence/adapters/uc01-adapter.ts';
import { UC03AccountingAdapter } from '../../../src/persistence/adapters/uc03-adapter.ts';
import type { BudgetLedger } from '../../../src/persistence/contracts.ts';

const ledgers: BudgetLedger[] = (['tokens', 'cost', 'repair'] as const).map((kind) => ({
  scope: 'task', kind, limit: 1000, consumed: 0, reservations: [], configurationId: `cfg-${kind}`, version: 1,
}));

for (const kind of ['uc01', 'uc03'] as const) {
  test(`${kind} preserves other task reservations and writes only owned consumption across restores`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uc04-multi-'));
    try {
      const store = new DurableStore(dir);
      const tracker = new BudgetTracker(ledgers);
      const adapter = kind === 'uc01' ? new UC01AccountingAdapter(tracker, store) : new UC03AccountingAdapter(tracker, store);
      const reserve = async (instance: typeof adapter, task: string, request: string, amount: number): Promise<string> => {
        if (instance instanceof UC01AccountingAdapter) {
          const result = await instance.reserve({ taskId: task, runId: 'run', requestId: request, accountingRef: request },
            { inputTokens: amount, outputTokens: 0, totalTokens: amount, costUnits: 1, pricingId: 'price' });
          assert.equal(result.ok, true);
          return request;
        }
        return (await instance.reserveInvestigation(task, 'run', amount)).reservationId;
      };
      const settle = async (instance: typeof adapter, task: string, request: string, amount: number): Promise<void> => {
        if (instance instanceof UC01AccountingAdapter) {
          await instance.settle({ taskId: task, runId: 'run', requestId: request, accountingRef: request }, request,
            { inputTokens: amount, outputTokens: 0, totalTokens: amount, costUnits: 1, state: 'settled', reservationRef: request });
        } else await instance.settleAttempt(request, { tokens: amount, cost: 1 });
      };
      const a = await reserve(adapter, 'task-a', 'a', 100);
      await settle(adapter, 'task-a', a, 80);
      const b = await reserve(adapter, 'task-b', 'b', 200);
      assert.equal((await store.loadBudgetJournal('task-b'))?.ledgers.find((l) => l.kind === 'tokens')?.consumed, 0);
      const rebuiltTracker = new BudgetTracker(ledgers);
      const rebuilt = kind === 'uc01' ? new UC01AccountingAdapter(rebuiltTracker, store) : new UC03AccountingAdapter(rebuiltTracker, store);
      await reserve(rebuilt, 'task-b', 'b2', 50);
      await reserve(rebuilt, 'task-a', 'a2', 30);
      assert.equal(rebuiltTracker.getConsumed('task', 'tokens'), 80);
      assert.equal(rebuiltTracker.getAvailable('task', 'tokens'), 640);
      assert.equal((await store.loadBudgetJournal('task-a'))?.ledgers.find((l) => l.kind === 'tokens')?.consumed, 80);
      assert.equal((await store.loadBudgetJournal('task-b'))?.ledgers.find((l) => l.kind === 'tokens')?.consumed, 0);
      assert.equal(rebuiltTracker.getLedger('task', 'tokens')?.reservations.length, 3);
      await settle(rebuilt, 'task-b', b, 40);
      assert.equal(rebuiltTracker.getConsumed('task', 'tokens'), 120);
      assert.equal((await store.loadBudgetJournal('task-a'))?.ledgers.find((l) => l.kind === 'tokens')?.consumed, 80);
      assert.equal((await store.loadBudgetJournal('task-b'))?.ledgers.find((l) => l.kind === 'tokens')?.consumed, 40);
      const foreignTracker = new BudgetTracker(ledgers);
      foreignTracker.reserve('foreign-spent', [{ scope: 'task', kind: 'tokens', amount: 50 }], { taskId: 'task-c' });
      foreignTracker.settle('foreign-spent', { amount: 40 });
      foreignTracker.reserve('foreign-held', [{ scope: 'task', kind: 'tokens', amount: 70 }], { taskId: 'task-c' });
      const foreignAdapter = kind === 'uc01' ? new UC01AccountingAdapter(foreignTracker, store) : new UC03AccountingAdapter(foreignTracker, store);
      await reserve(foreignAdapter, 'task-a', 'a3', 10);
      assert.equal(foreignTracker.getConsumed('task', 'tokens'), 120);
      assert.ok(foreignTracker.getLedger('task', 'tokens')?.reservations.some((r) => r.keyedId === 'foreign-held'));
      assert.equal((await store.loadBudgetJournal('task-a'))?.ledgers.find((l) => l.kind === 'tokens')?.consumed, 80);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
