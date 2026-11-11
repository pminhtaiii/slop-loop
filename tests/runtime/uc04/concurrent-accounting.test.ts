import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DurableStore } from '../../../src/persistence/store.ts';
import { UC04_SCHEMA_VERSION, type BudgetJournalRecord, type BudgetLedger } from '../../../src/persistence/contracts.ts';

function makeMockLedger(scope: 'task' | 'run', kind: 'tokens' | 'cost' | 'repair', reservations: { keyedId: string; amount: number }[]): BudgetLedger {
  return {
    scope,
    kind,
    limit: 1000,
    consumed: 0,
    reservations: reservations.map((r, idx) => ({
      reservationId: `res-${idx}`,
      keyedId: r.keyedId,
      amount: r.amount,
    })),
    version: 1,
    configurationId: 'cfg-test',
  };
}

test('UC-04: Concurrent Accounting & Concurrency Safety (SPEC-C-006)', async t => {
  let tempBase: string;
  let store: DurableStore;

  t.beforeEach(async () => {
    tempBase = await mkdtemp(join(tmpdir(), 'uc04-concurrency-test-'));
    store = new DurableStore(tempBase);
    await store.init();
  });

  t.afterEach(async () => {
    await rm(tempBase, { recursive: true, force: true });
  });

  await t.test('withLockRetry retries and succeeds when lock is briefly held', async () => {
    const resourceId = 'test-resource';
    let backgroundFinished = false;
    let lockAcquired = false;

    // Launch a background task that holds the lock for 60ms
    const backgroundHold = store.withLock(resourceId, async () => {
      lockAcquired = true;
      await new Promise(resolve => setTimeout(resolve, 60));
      backgroundFinished = true;
      return 'held';
    });

    while (!lockAcquired) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    // Try acquiring with retry (e.g. 15 retries with 15ms wait = up to 225ms wait)
    const result = await store.withLockRetry(
      resourceId,
      async () => {
        assert.equal(backgroundFinished, true, 'Lock must wait until background hold finishes');
        return 'acquired';
      },
      { maxRetries: 15, retryDelayMs: 15 },
    );

    assert.equal(result, 'acquired');
    await backgroundHold;
  });

  await t.test('withLockRetry throws when resource stays locked beyond retry limit', async () => {
    const resourceId = 'timeout-resource';

    let lockAcquired = false;
    const backgroundHold = store.withLock(resourceId, async () => {
      lockAcquired = true;
      await new Promise(resolve => setTimeout(resolve, 300));
      return 'held';
    });

    while (!lockAcquired) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    // Attempt with tiny retry count so it times out
    await assert.rejects(async () => {
      await store.withLockRetry(
        resourceId,
        async () => {
          return 'should-not-reach';
        },
        { maxRetries: 2, retryDelayMs: 10 },
      );
    }, /Resource timeout-resource is busy \/ already locked after 2 attempts/);

    await backgroundHold;
  });

  await t.test('mutateBudgetJournal serializes concurrent reservations without lost updates (SPEC-C-006)', async () => {
    const taskId = 'task-concurrent-1';

    // Initial journal
    await store.saveBudgetJournal({
      schemaVersion: UC04_SCHEMA_VERSION,
      taskId,
      runId: 'run-1',
      ledgers: [makeMockLedger('task', 'tokens', [])],
      replanCount: 0,
      updatedAt: new Date().toISOString(),
    });

    // Concurrently simulate 5 operations appending distinct reservations
    const operations = Array.from({ length: 5 }, (_, i) => async () => {
      return store.mutateBudgetJournal(
        taskId,
        async current => {
          assert.ok(current, 'Current journal must exist');
          // Add a slight async delay to expose race conditions if unlocked
          await new Promise(resolve => setTimeout(resolve, 15));
          const baseLedger = current.ledgers[0];
          assert.ok(baseLedger, 'Base ledger must exist');

          const currentRes = baseLedger.reservations ?? [];
          const newRes = [
            ...currentRes,
            {
              reservationId: `res-worker-${i}`,
              keyedId: `key-worker-${i}`,
              amount: (i + 1) * 10,
            },
          ];

          const updatedLedger: BudgetLedger = {
            ...baseLedger,
            reservations: newRes,
            version: baseLedger.version + 1,
          };

          const updated: BudgetJournalRecord = {
            ...current,
            ledgers: [updatedLedger],
            updatedAt: new Date().toISOString(),
          };
          return updated;
        },
        { maxRetries: 50, retryDelayMs: 15 },
      );
    });

    // Execute concurrently via Promise.all
    await Promise.all(operations.map(op => op()));

    // Verify final persisted journal contains all 5 reservations
    const finalJournal = await store.loadBudgetJournal(taskId);
    assert.ok(finalJournal, 'Final journal must exist');
    const finalLedger = finalJournal.ledgers[0];
    assert.ok(finalLedger, 'Final ledger must exist');
    assert.equal(finalLedger.reservations.length, 5, 'All 5 concurrent reservations must be preserved');

    const expectedKeys = new Set(Array.from({ length: 5 }, (_, i) => `key-worker-${i}`));
    for (const res of finalLedger.reservations) {
      assert.ok(expectedKeys.has(res.keyedId), `Missing reservation key: ${res.keyedId}`);
      expectedKeys.delete(res.keyedId);
    }
    assert.equal(expectedKeys.size, 0, 'No reservation should be lost or missing');
    assert.equal(finalLedger.version, 6, 'Version must be incremented 5 times (1 -> 6)');
  });

  await t.test('withLockRetry recovers from stale lock file abandoned by crashed process', async () => {
    const resourceId = 'abandoned-resource';
    const lockDir = join(tempBase, 'locks');
    const lockPath = join(lockDir, `${resourceId}.lock`);
    const { mkdir: fsMkdir, writeFile: fsWriteFile, utimes: fsUtimes } = await import('node:fs/promises');

    await fsMkdir(lockDir, { recursive: true });
    await fsWriteFile(lockPath, 'stale-pid-1234', 'utf8');

    // Set modification time to 40 seconds ago (older than 30s stale threshold)
    const pastTime = (Date.now() - 40_000) / 1000;
    await fsUtimes(lockPath, pastTime, pastTime);

    // withLockRetry should notice the stale lock, unlink it, and succeed
    const res = await store.withLockRetry(resourceId, async () => 'recovered', { staleThresholdMs: 30_000, maxRetries: 10, retryDelayMs: 20 });

    assert.equal(res, 'recovered');
  });
});
