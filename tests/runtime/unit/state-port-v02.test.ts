/**
 * Durable UC-03 v0.2 StatePortV02: claim -> attempt -> outcome survives a restart.
 *
 * The in-memory reference port (tests/runtime/support/uc03/memory-state.ts) is the behavioural oracle
 * for these semantics; this file only proves the on-disk adapter produces the same authoritative
 * results when reconstructed from the durable store.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { computeCanonicalSha256, type RepositoryAdmissionContextV02, type TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { journalSnapshotV02 } from '../../../src/approvals/control-v02.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { DurableStatePortV02, NEUTRAL_CLAIM_RECEIPT_V02, NEUTRAL_OUTCOME_RECORD_RESULT_V02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { fenceClaimRecipient } from '../../../src/persistence/adapters/state-port-v02-control.ts';
import { StatePortStore } from '../../../src/persistence/adapters/state-port-v02-storage.ts';
import {
  createTestAdmissionTaskStateV02,
  createTestExecutorIdentityV02,
  createTestRepositoryCommandAdmissionContextV02,
  createTestRepositoryOutcomeReceiptV02,
  createTestUncertainReconciliationReceiptV02,
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

test('durable v0.2 state port: the journal snapshot reports a begun attempt', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-durable-snapshot-attempt-'));
  try {
    const port = await openPort(baseDir);
    await port.transition(seedTask(), 0);
    const claim = await port.claim(context);
    const attempt = await port.beginAttempt(claim.claimId, createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }));
    assert.notEqual(attempt.attemptId, '', 'the fixture must begin a real attempt');

    const snapshot = journalSnapshotV02(port.getJournalSnapshot(context.taskId));
    assert.ok(snapshot, 'a begun attempt must still project a valid snapshot');
    assert.deepEqual(snapshot.attempts, [{ attemptId: attempt.attemptId, claimId: claim.claimId, status: 'attempting', outcomeReceiptId: null }]);
    assert.deepEqual(snapshot.claims, [{ claimId: claim.claimId, status: 'attempting', attemptId: attempt.attemptId }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('durable v0.2 state port: a persisted fence appears in the journal snapshot and blocks its incarnation', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-durable-snapshot-fence-'));
  try {
    const port = await openPort(baseDir);
    await port.transition(seedTask(), 0);
    const claim = await port.claim(context);
    const recipient = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
    assert.equal(await port.setTaskControl(context.taskId, 'paused', 'pause-fence-snapshot-001'), true);

    const fence = await port.fenceClaimRecipient(claim.claimId, recipient);
    assert.ok(fence, 'a paused, unattempted claim must be fenceable');
    assert.ok(fence.fencingGeneration > recipient.fencingGeneration, 'the fence must raise the recipient generation');

    const snapshot = journalSnapshotV02(port.getJournalSnapshot(context.taskId));
    assert.ok(snapshot, 'a fenced task must still project a valid snapshot');
    assert.deepEqual(snapshot.fenceProofs, [
      { claimId: claim.claimId, proofRef: fence.proofRef, fencingGeneration: fence.fencingGeneration, holdRef: fence.holdRef, controlVersion: fence.controlVersion, epoch: fence.epoch },
    ]);
    assert.deepEqual(snapshot.fencedIncarnations, [`${recipient.adapterIdentity}\u0000${recipient.processIncarnation}`]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('durable v0.2 state port: fenceAttemptRecipient fences an uncertain attempt and refuses a fenced incarnation', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-durable-fence-attempt-'));
  try {
    const port = await openPort(baseDir);
    await port.transition(seedTask(), 0);
    const claim = await port.claim(context);
    const executor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
    const attempt = await port.beginAttempt(claim.claimId, executor);
    assert.notEqual(attempt.attemptId, '', 'the fixture must begin a real attempt');
    assert.deepEqual(await port.recordOutcome(createTestRepositoryOutcomeReceiptV02(claim, attempt, context, { outcome: 'uncertain' })), {
      outcome: 'uncertain',
      receiptId: 'repo-out-001',
    });
    assert.equal(await port.setTaskControl(context.taskId, 'paused', 'pause-fence-attempt-001'), true);

    assert.equal(await port.fenceClaimRecipient(claim.claimId, executor), null, 'an attempted claim must not be fenced as unattempted');
    const fence = await port.fenceAttemptRecipient(claim.claimId, executor);
    assert.ok(fence, 'an uncertain attempted claim must be fenceable');
    assert.ok(fence.fencingGeneration > executor.fencingGeneration, 'the fence must supersede the dispatched recipient');

    const snapshot = journalSnapshotV02(port.getJournalSnapshot(context.taskId));
    assert.ok(snapshot);
    assert.equal(snapshot.fenceProofs.length, 1, 'the fence must be visible in the snapshot');
    assert.deepEqual(snapshot.fencedIncarnations, [`${executor.adapterIdentity}\u0000${executor.processIncarnation}`], 'the fenced incarnation must be recorded');

    // A second fence for the same adapter/incarnation at a higher generation is still refused.
    const higher = { ...executor, fencingGeneration: fence.fencingGeneration + 1 };
    assert.equal(await port.fenceAttemptRecipient(claim.claimId, higher), null, 'a prior fence raises the generation and refuses a repeated incarnation');

    // The fence is usable: proven-not-dispatched settles the uncertain attempt through it.
    const task = await port.loadTask(context.taskId);
    assert.ok(task);
    const reconciliation = createTestUncertainReconciliationReceiptV02(createTestRepositoryOutcomeReceiptV02(claim, attempt, context, { outcome: 'uncertain' }), claim, attempt, context, {
      disposition: 'proven-not-dispatched',
      fencedRecipientIdentity: fence.recipientIdentity,
      fencingGeneration: fence.fencingGeneration,
      fencingProof: fence.proofRef,
      adapterEvidenceRefs: fence.adapterEvidenceRefs,
      evidenceRefs: [...fence.adapterEvidenceRefs, fence.proofRef],
      expectedCurrentTaskStateVersion: task.stateVersion,
      expectedCurrentControlVersion: snapshot.controlVersion,
    });
    assert.deepEqual(await port.reconcileUncertain(reconciliation), { outcome: 'settled', receiptId: reconciliation.reconciliationId });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('durable v0.2 state port: a non-ENOENT fence scan failure aborts instead of fencing at generation 1', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-durable-fence-scan-error-'));
  try {
    const port = await openPort(baseDir);
    await port.transition(seedTask(), 0);
    const claim = await port.claim(context);
    const executor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
    assert.equal(await port.setTaskControl(context.taskId, 'paused', 'pause-fence-scan-error-001'), true);

    // A regular file where the scan's state directory is makes readdir fail with ENOTDIR (not ENOENT) on Windows and Linux.
    writeFileSync(join(baseDir, 'claims', context.taskId, 'blocked'), '');
    const blocked = new (class extends StatePortStore {
      override statePath(taskId: string, name: string): string {
        return name === 'x' ? join(this.taskDir(taskId), 'blocked', 'x') : super.statePath(taskId, name);
      }
    })(port.store);

    await assert.rejects(fenceClaimRecipient(blocked, claim.claimId, executor), { code: 'ENOTDIR' }, 'an unreadable state directory must abort the fence, not fence at generation 1');
    assert.ok(await port.fenceClaimRecipient(claim.claimId, executor), 'the aborted fence must leave no persisted proof behind');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
