/**
 * Durable UC-03 v0.2 StatePortV02: claim -> attempt -> outcome survives a restart.
 *
 * The in-memory reference port (tests/runtime/support/uc03/memory-state.ts) is the behavioural oracle
 * for these semantics; this file only proves the on-disk adapter produces the same authoritative
 * results when reconstructed from the durable store.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { computeCanonicalSha256, type RepositoryAdmissionContextV02, type TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { journalSnapshotV02 } from '../../../src/approvals/control-v02.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { DurableStatePortV02, NEUTRAL_CLAIM_RECEIPT_V02, NEUTRAL_OUTCOME_RECORD_RESULT_V02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import {
  createTestAdmissionTaskStateV02,
  createTestExecutorIdentityV02,
  createTestRepositoryCommandAdmissionContextV02,
  createTestRepositoryOutcomeReceiptV02,
} from '../support/uc03/state-fixtures.ts';

const context: RepositoryAdmissionContextV02 = createTestRepositoryCommandAdmissionContextV02();

// The command admission reserves one timeoutMs resource, so the task must carry that ledger.
function seedTask(): TaskState {
  const task = createTestAdmissionTaskStateV02(context);
  return {
    ...task,
    budgetLedgers: [...(task.budgetLedgers ?? []), { scope: 'task', kind: 'timeoutMs', limit: 60_000, consumed: 0, reservations: [], unit: 'count', configurationId: 'config-v1', version: 1 }],
  };
}

async function openPort(baseDir: string): Promise<DurableStatePortV02> {
  const store = new DurableStore(baseDir);
  await store.init();
  return new DurableStatePortV02({
    store,
    initialControl: {
      controlVersion: context.expectedControlVersion,
      epoch: context.expectedEpoch,
      activeAuthorityRef: context.policyAuthorityRef,
    },
  });
}

test('durable v0.2 state port: claim, attempt and outcome settle across a port restart', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-durable-state-'));
  try {
    const seeded = seedTask();
    await (await openPort(baseDir)).transition(seeded, 0);

    const first = await openPort(baseDir);
    assert.equal(Object.getOwnPropertyDescriptor(first, 'executionGuardApiVersion')?.value, '0.2.0', 'the guard must recognise this port as v0.2');
    assert.equal(first.provenance, 'real');
    const claim = await first.claim(context);
    assert.notDeepEqual(claim, NEUTRAL_CLAIM_RECEIPT_V02, 'a valid admission must open a claim');
    assert.equal(claim.postClaimControlVersion, context.expectedControlVersion + 1);
    assert.equal(claim.claimDigest, computeCanonicalSha256({ ...claim, claimDigest: undefined }));

    // A fresh port over the same store proves the claim and control head are durable.
    const afterRestart = await openPort(baseDir);
    const replayClaim = await afterRestart.claim(context);
    assert.deepEqual(replayClaim, claim, 'an identical admission must replay the open claim, not open a second one');

    const attempt = await afterRestart.beginAttempt(claim.claimId, createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }));
    assert.equal(attempt.postBeginControlVersion, claim.postClaimControlVersion + 1);
    assert.equal(attempt.epoch, claim.epoch);
    assert.deepEqual(await afterRestart.claim(context), NEUTRAL_CLAIM_RECEIPT_V02, 'a claim already in flight must not be replayed as open');

    const outcome = createTestRepositoryOutcomeReceiptV02(claim, attempt, context);
    const recorded = await afterRestart.recordOutcome(outcome);
    assert.deepEqual(recorded, { outcome: 'settled', receiptId: outcome.receiptId });
    assert.deepEqual(await afterRestart.recordOutcome(outcome), { outcome: 'already-recorded', receiptId: outcome.receiptId });
    assert.deepEqual(await afterRestart.claim(context), NEUTRAL_CLAIM_RECEIPT_V02, 'a settled admission must not be claimable under its stale control version');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('durable v0.2 state port: mismatched control expectations fail closed without effect', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-durable-state-deny-'));
  try {
    const seeded = seedTask();
    const port = await openPort(baseDir);
    await port.transition(seeded, 0);

    const stale = await port.claim({ ...context, expectedEpoch: context.expectedEpoch + 1 });
    assert.deepEqual(stale, NEUTRAL_CLAIM_RECEIPT_V02, 'a stale epoch must not open a claim');
    assert.deepEqual(await port.loadTask(context.taskId), seeded, 'a refused claim must leave the task unchanged');

    const claim = await port.claim(context);
    assert.notDeepEqual(claim, NEUTRAL_CLAIM_RECEIPT_V02);
    const badActor = await port.beginAttempt(claim.claimId, createTestExecutorIdentityV02({ payloadDigest: computeCanonicalSha256('wrong-payload') }));
    assert.equal(badActor.attemptId, '', 'an executor bound to other content must not begin an attempt');

    const attempt = await port.beginAttempt(claim.claimId, createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }));
    const denied = await port.recordOutcome({ ...createTestRepositoryOutcomeReceiptV02(claim, attempt, context), receiptId: '' });
    assert.deepEqual(denied, NEUTRAL_OUTCOME_RECORD_RESULT_V02, 'an unaddressable receipt id must be refused');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('durable v0.2 state port: its journal snapshot validates and tracks the open claim', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-durable-snapshot-'));
  try {
    const seeded = seedTask();
    const port = await openPort(baseDir);
    await port.transition(seeded, 0);

    const idle = journalSnapshotV02(port.getJournalSnapshot(context.taskId));
    assert.ok(idle, 'the durable task must project a valid 17-key v0.2 snapshot');
    assert.equal(idle.controlVersion, context.expectedControlVersion);
    assert.equal(idle.epoch, context.expectedEpoch);
    assert.equal(idle.mode, 'runnable');
    assert.equal(idle.activeClaimId, null);

    const claim = await port.claim(context);
    const claimed = journalSnapshotV02(port.getJournalSnapshot(context.taskId));
    assert.ok(claimed, 'an open claim must still project a valid snapshot');
    assert.equal(claimed.activeClaimId, claim.claimId, 'a reader must see the open claim and refuse reads');
    assert.deepEqual(claimed.claims, [{ claimId: claim.claimId, status: 'claimed', attemptId: null }]);

    assert.equal(port.getJournalSnapshot('not a task id'), null, 'an unsafe id must not be read');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
