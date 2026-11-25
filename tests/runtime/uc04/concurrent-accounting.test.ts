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
    let markAcquired!: () => void;
    const acquiredGate = new Promise<void>(resolve => {
      markAcquired = resolve;
    });
    let releaseHold!: () => void;
    const holdGate = new Promise<void>(resolve => {
      releaseHold = resolve;
    });

    const backgroundHold = store.withLock(resourceId, async () => {
      markAcquired();
      await holdGate;
      backgroundFinished = true;
      return 'held';
    });

    await acquiredGate;

    // Launch contender while lock is definitely held, then release shortly after
    const retryPromise = store.withLockRetry(
      resourceId,
      async () => {
        assert.equal(backgroundFinished, true, 'Lock must wait until background hold finishes');
        return 'acquired';
      },
      { maxRetries: 15, retryDelayMs: 15 },
    );

    await new Promise(resolve => setTimeout(resolve, 30));
    releaseHold();

    const result = await retryPromise;
    assert.equal(result, 'acquired');
    await backgroundHold;
  });

  await t.test('withLockRetry throws when resource stays locked beyond retry limit', async () => {
    const resourceId = 'timeout-resource';
    let markAcquired!: () => void;
    const acquiredGate = new Promise<void>(resolve => {
      markAcquired = resolve;
    });
    let releaseHold!: () => void;
    const holdGate = new Promise<void>(resolve => {
      releaseHold = resolve;
    });

    const backgroundHold = store.withLock(resourceId, async () => {
      markAcquired();
      await holdGate;
      return 'held';
    });

    await acquiredGate;

    // Keep the lock deterministically held until bounded retries exhaust
    try {
      await assert.rejects(async () => {
        await store.withLockRetry(
          resourceId,
          async () => {
            return 'should-not-reach';
          },
          { maxRetries: 2, retryDelayMs: 10 },
        );
      }, /Resource timeout-resource is busy \/ already locked after 2 attempts/);
    } finally {
      releaseHold();
      await backgroundHold;
    }
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

    // Deterministic start barrier so all 5 operations contend on the same tick,
    // plus an active-mutator guard and event-loop yield instead of a wall-clock sleep.
    let startedCount = 0;
    let releaseStart!: () => void;
    const allStarted = new Promise<void>(resolve => {
      releaseStart = resolve;
    });
    let activeMutators = 0;

    // Concurrently simulate 5 operations appending distinct reservations
    const operations = Array.from({ length: 5 }, (_, i) => async () => {
      startedCount += 1;
      if (startedCount === 5) {
        releaseStart();
      }
      await allStarted;

      return store.mutateBudgetJournal(
        taskId,
        async current => {
          activeMutators += 1;
          assert.equal(activeMutators, 1, 'Lock must serialize mutator execution without overlap');
          try {
            assert.ok(current, 'Current journal must exist');
            // Deterministic async yield across microtask/macrotask boundaries to expose races if unlocked
            await Promise.resolve();
            await new Promise<void>(resolve => setImmediate(resolve));
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
          } finally {
            activeMutators -= 1;
          }
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

  await t.test('withLockRetry preserves lock held by a live operation even if past staleThresholdMs', async () => {
    const resourceId = 'live-long-running';
    const lockDir = join(tempBase, 'locks');
    const lockPath = join(lockDir, `${resourceId}.lock`);
    const { mkdir: fsMkdir, writeFile: fsWriteFile, utimes: fsUtimes } = await import('node:fs/promises');

    await fsMkdir(lockDir, { recursive: true });
    // Write lock held by current (alive) process
    const liveLockPayload = JSON.stringify({
      pid: process.pid,
      token: 'live-token-123',
      createdAt: Date.now() - 60_000,
    });
    await fsWriteFile(lockPath, liveLockPayload, 'utf8');

    // Set mtime to 60 seconds ago
    const pastTime = (Date.now() - 60_000) / 1000;
    await fsUtimes(lockPath, pastTime, pastTime);

    // Contender should NOT steal lock from live process, and should fail after retries
    await assert.rejects(async () => {
      await store.withLockRetry(resourceId, async () => 'should-fail', {
        staleThresholdMs: 10_000,
        maxRetries: 2,
        retryDelayMs: 10,
      });
    }, /Resource live-long-running is busy \/ already locked after 2 attempts/);
  });

  await t.test('mutateBudgetJournal succeeds for task IDs of maximum length (128 characters)', async () => {
    // 128 characters safe ID
    const longTaskId = `task-${'a'.repeat(123)}`;
    assert.equal(longTaskId.length, 128);

    await store.saveBudgetJournal({
      schemaVersion: UC04_SCHEMA_VERSION,
      taskId: longTaskId,
      runId: 'run-long-1',
      ledgers: [makeMockLedger('task', 'tokens', [])],
      replanCount: 0,
      updatedAt: new Date().toISOString(),
    });

    const mutated = await store.mutateBudgetJournal(longTaskId, current => {
      assert.ok(current);
      return {
        ...current,
        replanCount: current.replanCount + 1,
        updatedAt: new Date().toISOString(),
      };
    });

    assert.equal(mutated.replanCount, 1);
    const reloaded = await store.loadBudgetJournal(longTaskId);
    assert.equal(reloaded?.replanCount, 1);
  });

  await t.test('withLockRetry enforces bounded retries for in-process contenders and leaves queue clean after timeout', async () => {
    const resourceId = 'queued-timeout-resource';
    let markAcquired!: () => void;
    const acquiredGate = new Promise<void>(resolve => {
      markAcquired = resolve;
    });
    let releaseHold!: () => void;
    const holdGate = new Promise<void>(resolve => {
      releaseHold = resolve;
    });

    const holder = store.withLockRetry(resourceId, async () => {
      markAcquired();
      await holdGate;
      return 'held';
    });

    await acquiredGate;

    try {
      await assert.rejects(async () => {
        await store.withLockRetry(resourceId, async () => 'should-not-acquire', {
          maxRetries: 2,
          retryDelayMs: 10,
        });
      }, /Resource queued-timeout-resource is busy \/ already locked after 2 attempts/);
    } finally {
      releaseHold();
      assert.equal(await holder, 'held');
    }

    // Subsequent acquisition with zero retries proves neither the lock file nor in-process queue state leaked.
    const nextResult = await store.withLockRetry(resourceId, async () => 'clean-after-timeout', {
      maxRetries: 0,
      retryDelayMs: 1,
    });
    assert.equal(nextResult, 'clean-after-timeout');
  });
});
