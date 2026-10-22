import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetTracker, BudgetExhaustionError, createDispatchClaim } from '../../../src/persistence/accounting.ts';
import type { BudgetLedger, ProviderUsage } from '../../../src/persistence/contracts.ts';

describe('UC-04: BudgetTracker & Durable Accounting', () => {
  const initialLedgers: BudgetLedger[] = [
    {
      scope: 'task',
      kind: 'tokens',
      limit: 10000,
      consumed: 0,
      reservations: [],
      configurationId: 'cfg-default',
      version: 1,
    },
    {
      scope: 'task',
      kind: 'cost',
      limit: 5.0,
      consumed: 0,
      reservations: [],
      configurationId: 'cfg-default',
      version: 1,
    },
    {
      scope: 'run',
      kind: 'repair',
      limit: 3,
      consumed: 0,
      reservations: [],
      configurationId: 'cfg-default',
      version: 1,
    },
  ];

  it('reserves allowance atomically when available', () => {
    const tracker = new BudgetTracker(initialLedgers);
    const bundle = tracker.reserve('req-1', [
      { scope: 'task', kind: 'tokens', amount: 3000 },
      { scope: 'task', kind: 'cost', amount: 1.5 },
    ]);

    assert.equal(bundle.reservations.length, 2);
    assert.equal(tracker.getAvailable('task', 'tokens'), 7000);
    assert.equal(tracker.getAvailable('task', 'cost'), 3.5);
  });

  it('rejects duplicate reservation keys in a single request', () => {
    const tracker = new BudgetTracker(initialLedgers);
    assert.throws(
      () => {
        tracker.reserve('req-dup', [
          { scope: 'task', kind: 'tokens', amount: 500 },
          { scope: 'task', kind: 'tokens', amount: 300 },
        ]);
      },
      /Duplicate reservation key/i
    );
  });

  it('throws BudgetExhaustionError when requested amount exceeds available allowance', () => {
    const tracker = new BudgetTracker(initialLedgers);
    assert.throws(
      () =>
        tracker.reserve('req-2', [
          { scope: 'task', kind: 'tokens', amount: 15000 },
        ]),
      (err: unknown) => err instanceof BudgetExhaustionError && /exhausted.*tokens/i.test((err as Error).message)
    );
  });

  it('settles reservation against observed provider usage', () => {
    const tracker = new BudgetTracker(initialLedgers);
    tracker.reserve('req-3', [
      { scope: 'task', kind: 'tokens', amount: 4000 },
      { scope: 'task', kind: 'cost', amount: 2.0 },
    ]);

    const usage: ProviderUsage = {
      inputTokens: 1500,
      outputTokens: 1000,
      billableTokens: 2500,
      costUsd: 1.25,
    };

    tracker.settle('req-3', usage);

    assert.equal(tracker.getConsumed('task', 'tokens'), 2500);
    assert.equal(tracker.getConsumed('task', 'cost'), 1.25);
    // Reservations cleared
    assert.equal(tracker.getAvailable('task', 'tokens'), 7500);
    assert.equal(tracker.getAvailable('task', 'cost'), 3.75);
  });

  it('reconciles uncertain interrupted reservation without resetting spent allowance', () => {
    const tracker = new BudgetTracker(initialLedgers);
    tracker.reserve('req-interrupted', [
      { scope: 'task', kind: 'tokens', amount: 2000 },
    ]);

    // Process crashed before settle. Reconcile with verified evidence
    tracker.reconcileUncertain('req-interrupted', {
      observedUsage: {
        inputTokens: 800,
        outputTokens: 200,
        costUsd: 0.1,
      },
      reason: 'Verified against external provider log',
    });

    assert.equal(tracker.getConsumed('task', 'tokens'), 1000);
    assert.equal(tracker.getAvailable('task', 'tokens'), 9000);
  });

  it('preserves task-scoped budget across new runId without reset', () => {
    const tracker1 = new BudgetTracker(initialLedgers);
    tracker1.reserve('req-run-1', [{ scope: 'task', kind: 'tokens', amount: 5000 }]);
    tracker1.settle('req-run-1', { inputTokens: 5000, outputTokens: 0, costUsd: 1.0 });

    const savedLedgers = tracker1.getLedgers();

    // Spawn run-2: task-scoped ledgers retain 5000 consumed, run-scoped ledgers reset
    const tracker2 = BudgetTracker.forNewRun(savedLedgers);
    assert.equal(tracker2.getConsumed('task', 'tokens'), 5000);
    assert.equal(tracker2.getAvailable('task', 'tokens'), 5000);
    assert.equal(tracker2.getConsumed('run', 'repair'), 0); // run-scoped resets
  });

  it('creates validated dispatch claim records', () => {
    const claim = createDispatchClaim({
      taskId: 'task-1',
      runId: 'run-1',
      stepId: 'step-1',
      actionId: 'action-exec-1',
      expectedEpoch: 1,
      expectedStateVersion: 2,
      requiredEvidenceRefs: ['evidence-ref-1'],
      reservationRefs: ['res-bundle-1'],
      repoDigest: 'commit-hash-0123456789',
      policyVersion: '1.0.0',
    });

    assert.ok(claim.claimId.startsWith('claim-'));
    assert.equal(claim.phase, 'claimed');
    assert.equal(claim.stepId, 'step-1');
  });
});
