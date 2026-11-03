/**
 * Differential harness: the durable UC-03 v0.2 state port must produce the same authoritative
 * results as the in-memory behavioural oracle for the same operation sequence.
 *
 * The memory port is exercised heavily elsewhere; the durable adapter is not. Each test below runs
 * one sequence against both ports and compares what each one reports, so a durable-only regression
 * (a record read from the wrong directory, a swapped identity field) fails here instead of shipping.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { journalSnapshotV02 } from '../../../src/approvals/control-v02.ts';
import type { RepositoryAdmissionContextV02, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { DurableStatePortV02, NEUTRAL_CLAIM_RECEIPT_V02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import type { FenceProofV02 } from '../../../src/persistence/adapters/state-port-v02-types.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import type { MemoryFenceProofV02, MemoryJournalSnapshotV02 } from '../support/uc03/memory-state.ts';
import { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import {
  createTestAction,
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

interface Pair {
  readonly memory: MemoryStatePortV02;
  readonly durable: DurableStatePortV02;
}

async function withBoth(body: (pair: Pair) => Promise<void>): Promise<void> {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-parity-'));
  try {
    const memory = new MemoryStatePortV02({
      initialTaskState: seedTask(),
      initialControlVersion: context.expectedControlVersion,
      initialEpoch: context.expectedEpoch,
      initialAuthorityRef: context.policyAuthorityRef,
    });
    const store = new DurableStore(baseDir);
    await store.init();
    const durable = new DurableStatePortV02({
      store,
      initialControl: { controlVersion: context.expectedControlVersion, epoch: context.expectedEpoch, activeAuthorityRef: context.policyAuthorityRef },
    });
    await durable.transition(seedTask(), 0);
    await body({ memory, durable });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

/**
 * Compares the fields both ports authoritatively report. `authorityPublications` and
 * `controlEventRefs` are excluded by design (the durable adapter persists neither log), and fence
 * digests are compared separately by `assertFenceParity`.
 */
function comparable(snapshot: MemoryJournalSnapshotV02) {
  return {
    controlVersion: snapshot.controlVersion,
    epoch: snapshot.epoch,
    mode: snapshot.mode,
    holdRef: snapshot.holdRef,
    holdEventDigest: snapshot.holdEventDigest,
    activeClaimId: snapshot.activeClaimId,
    claims: snapshot.claims,
    attempts: snapshot.attempts,
    outcomes: snapshot.outcomes,
    reconciliations: snapshot.reconciliations,
    closures: snapshot.closures,
    fenceProofs: snapshot.fenceProofs.map(row => ({ ...row, proofRef: row.proofRef.reference })),
    recoveryEvidencePredecessorReceiptIds: [...snapshot.recoveryEvidencePredecessorReceiptIds].sort(),
    fencedIncarnations: [...snapshot.fencedIncarnations].sort(),
  };
}

function snapshotOf(pair: Pair): MemoryJournalSnapshotV02 {
  const durable = journalSnapshotV02(pair.durable.getJournalSnapshot(context.taskId));
  assert.ok(durable, 'the durable journal must project a valid 17-key v0.2 snapshot');
  return durable as unknown as MemoryJournalSnapshotV02;
}

function assertParity(pair: Pair): void {
  assert.deepEqual(comparable(snapshotOf(pair)), comparable(pair.memory.getJournalSnapshot()), 'both ports must report the same journal facts');
}

function assertFenceParity(memory: MemoryFenceProofV02 | null, durable: FenceProofV02 | null): void {
  assert.ok(memory && durable, 'both ports must fence the same claim');
  const semantic = (proof: FenceProofV02) => ({
    claimId: proof.claimId,
    claimDigest: proof.claimDigest,
    taskId: proof.taskId,
    recipientIdentity: proof.recipientIdentity,
    fencedExecutorIdentity: proof.fencedExecutorIdentity,
    fencingGeneration: proof.fencingGeneration,
    holdRef: proof.holdRef,
    controlVersion: proof.controlVersion,
    epoch: proof.epoch,
    proofReference: proof.proofRef.reference,
    evidenceReferences: proof.adapterEvidenceRefs.map(ref => ref.reference),
  });
  assert.deepEqual(semantic(durable), semantic(memory), 'both ports must return the same fence semantics');
  // Both ports digest the same fence payload, `generation` included, so distinct fence generations
  // cannot collide on a reference digest.
  assert.equal(durable.proofRef.digest, memory.proofRef.digest);
  assert.equal(durable.adapterEvidenceRefs[0]?.digest, memory.adapterEvidenceRefs[0]?.digest);
}

test('parity: a claim replays identically and a second admission is refused while one is held', async () => {
  await withBoth(async pair => {
    const memoryClaim = await pair.memory.claim(context);
    const durableClaim = await pair.durable.claim(context);
    assert.notDeepEqual(memoryClaim, NEUTRAL_CLAIM_RECEIPT_V02, 'the fixture must open a claim');
    assert.deepEqual(durableClaim, memoryClaim, 'both ports must mint the same claim receipt');
    assert.equal(durableClaim.postClaimControlVersion, context.expectedControlVersion + 1);
    assert.deepEqual(await pair.memory.claim(context), memoryClaim, 'the memory port must replay the open claim');
    assert.deepEqual(await pair.durable.claim(context), durableClaim, 'the durable port must replay the open claim');
    assertParity(pair);

    const other = createTestRepositoryCommandAdmissionContextV02({
      action: createTestAction({ actionId: 'act-command-admission-002', purpose: 'Run another admitted verification' }),
      reservationRefs: ['res-command-admission-002'],
      expectedControlVersion: context.expectedControlVersion + 1,
    });
    assert.deepEqual(await pair.memory.claim(other), NEUTRAL_CLAIM_RECEIPT_V02, 'the memory port must refuse a second held claim');
    assert.deepEqual(await pair.durable.claim(other), NEUTRAL_CLAIM_RECEIPT_V02, 'the durable port must refuse a second held claim');
    assertParity(pair);
  });
});

test('parity: attempt then a settled outcome leave the same authoritative records', async () => {
  await withBoth(async pair => {
    const memoryClaim = await pair.memory.claim(context);
    const durableClaim = await pair.durable.claim(context);
    const executor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });

    const memoryAttempt = await pair.memory.beginAttempt(memoryClaim.claimId, executor);
    const durableAttempt = await pair.durable.beginAttempt(durableClaim.claimId, executor);
    assert.deepEqual(durableAttempt, memoryAttempt, 'both ports must mint the same attempt receipt');
    assert.equal(memoryAttempt.postBeginControlVersion, memoryClaim.postClaimControlVersion + 1);

    const memoryOutcome = createTestRepositoryOutcomeReceiptV02(memoryClaim, memoryAttempt, context);
    const durableOutcome = createTestRepositoryOutcomeReceiptV02(durableClaim, durableAttempt, context);
    assert.deepEqual(durableOutcome, memoryOutcome, 'the fixtures must build the same outcome receipt');

    const settled = { outcome: 'settled', receiptId: memoryOutcome.receiptId };
    assert.deepEqual(await pair.memory.recordOutcome(memoryOutcome), settled);
    assert.deepEqual(await pair.durable.recordOutcome(durableOutcome), settled);
    const replayed = { outcome: 'already-recorded', receiptId: memoryOutcome.receiptId };
    assert.deepEqual(await pair.memory.recordOutcome(memoryOutcome), replayed);
    assert.deepEqual(await pair.durable.recordOutcome(durableOutcome), replayed);
    assertParity(pair);
  });
});

test('parity: fenceClaimRecipient proves the same unattempted fence on both ports', async () => {
  await withBoth(async pair => {
    const memoryClaim = await pair.memory.claim(context);
    const durableClaim = await pair.durable.claim(context);
    const recipient = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
    assert.equal(await pair.memory.setTaskControl(context.taskId, 'paused', 'pause-parity-fence-001'), true);
    assert.equal(await pair.durable.setTaskControl(context.taskId, 'paused', 'pause-parity-fence-001'), true);

    const memoryFence = await pair.memory.fenceClaimRecipient(memoryClaim.claimId, recipient);
    const durableFence = await pair.durable.fenceClaimRecipient(durableClaim.claimId, recipient);
    assertFenceParity(memoryFence, durableFence);
    assertParity(pair);

    assert.deepEqual(await pair.memory.fenceClaimRecipient(memoryClaim.claimId, recipient), memoryFence, 'a replayed fence must return the stored proof');
    assert.deepEqual(await pair.durable.fenceClaimRecipient(durableClaim.claimId, recipient), durableFence, 'a replayed fence must return the stored proof');

    const other = createTestExecutorIdentityV02({ processIncarnation: 'proc-200', payloadDigest: context.actionDigest });
    assert.equal(await pair.memory.fenceClaimRecipient(memoryClaim.claimId, other), null, 'a different incarnation must be refused');
    assert.equal(await pair.durable.fenceClaimRecipient(durableClaim.claimId, other), null, 'a different incarnation must be refused');
  });
});

test('parity: fenceAttemptRecipient fences an uncertain attempt with the same proof', async () => {
  await withBoth(async pair => {
    const memoryClaim = await pair.memory.claim(context);
    const durableClaim = await pair.durable.claim(context);
    const executor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
    const memoryAttempt = await pair.memory.beginAttempt(memoryClaim.claimId, executor);
    const durableAttempt = await pair.durable.beginAttempt(durableClaim.claimId, executor);
    const memoryOutcome = createTestRepositoryOutcomeReceiptV02(memoryClaim, memoryAttempt, context, { outcome: 'uncertain' });
    const durableOutcome = createTestRepositoryOutcomeReceiptV02(durableClaim, durableAttempt, context, { outcome: 'uncertain' });

    const recorded = { outcome: 'uncertain', receiptId: memoryOutcome.receiptId };
    assert.deepEqual(await pair.memory.recordOutcome(memoryOutcome), recorded);
    assert.deepEqual(await pair.durable.recordOutcome(durableOutcome), recorded);
    assert.equal(await pair.memory.setTaskControl(context.taskId, 'paused', 'pause-parity-fence-002'), true);
    assert.equal(await pair.durable.setTaskControl(context.taskId, 'paused', 'pause-parity-fence-002'), true);

    assert.equal(await pair.memory.fenceClaimRecipient(memoryClaim.claimId, executor), null, 'an attempted claim must not be fenced as unattempted');
    assert.equal(await pair.durable.fenceClaimRecipient(durableClaim.claimId, executor), null, 'an attempted claim must not be fenced as unattempted');

    const memoryFence = await pair.memory.fenceAttemptRecipient(memoryClaim.claimId, executor);
    const durableFence = await pair.durable.fenceAttemptRecipient(durableClaim.claimId, executor);
    assertFenceParity(memoryFence, durableFence);
    assertParity(pair);
  });
});
