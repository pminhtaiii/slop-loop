/**
 * A persisted uncertain outcome whose attempt/claim writes were interrupted must still be completable
 * by the same replay, or the claim is stuck `attempting` with held reservations that no recovery path
 * accepts. These rows fault each write point, replay the exact receipt, then drive the real owner
 * reconciliation to `proven-not-dispatched`.
 *
 * Durable store only: no Docker, network, provider or process restart.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import test from 'node:test';

import { computeCanonicalSha256 } from '../../../src/contracts/foundation/uc03.ts';
import type { AttemptOutcomeReceiptV02, AttemptReceiptV02, ClaimReceiptV02, RepositoryAdmissionContextV02, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { recordOutcome } from '../../../src/persistence/adapters/state-port-v02-claims.ts';
import { StatePortStore } from '../../../src/persistence/adapters/state-port-v02-storage.ts';
import type { ControlRecordV02, StoredClaimV02 } from '../../../src/persistence/adapters/state-port-v02-types.ts';
import { DEFAULT_CONTROL } from '../../../src/persistence/adapters/state-port-v02-types.ts';
import { DurableStatePortV02, NEUTRAL_OUTCOME_RECORD_RESULT_V02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
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

/** A store whose attempt or claim write fails exactly once, after the outcome file has landed. */
class InterruptingStore extends StatePortStore {
  failAttempt = false;
  failClaim = false;
  failControl = false;
  loseControlReply = false;
  attemptWrites = 0;

  override async writeJson(path: string, value: unknown): Promise<void> {
    if (basename(path).startsWith('attempt-')) this.attemptWrites++;
    if (this.failAttempt && basename(path).startsWith('attempt-')) {
      this.failAttempt = false;
      throw new Error('fault: attempt write lost');
    }
    return super.writeJson(path, value);
  }

  override async writeControl(taskId: string, control: ControlRecordV02): Promise<void> {
    if (this.failControl) {
      this.failControl = false;
      throw new Error('fault: control write lost');
    }
    await super.writeControl(taskId, control);
    if (this.loseControlReply) {
      this.loseControlReply = false;
      throw new Error('fault: control reply lost');
    }
  }

  override async writeClaim(taskId: string, claim: StoredClaimV02): Promise<void> {
    if (this.failClaim) {
      this.failClaim = false;
      throw new Error('fault: claim write lost');
    }
    return super.writeClaim(taskId, claim);
  }
}

async function openPort(baseDir: string): Promise<DurableStatePortV02> {
  const store = new DurableStore(baseDir);
  await store.init();
  return new DurableStatePortV02({
    store,
    initialControl: { controlVersion: context.expectedControlVersion, epoch: context.expectedEpoch, activeAuthorityRef: context.policyAuthorityRef },
  });
}

function controlVersionOf(store: DurableStore): Promise<number> {
  return new StatePortStore(store).readControl(context.taskId, DEFAULT_CONTROL).then(control => control.controlVersion);
}

interface Flow {
  readonly baseDir: string;
  readonly port: DurableStatePortV02;
  readonly claim: ClaimReceiptV02;
  readonly attempt: AttemptReceiptV02;
  readonly outcome: AttemptOutcomeReceiptV02;
}

async function claimedAttempt(label: string): Promise<Flow> {
  const baseDir = mkdtempSync(join(tmpdir(), `uc03-replay-${label}-`));
  const port = await openPort(baseDir);
  await port.transition(seedTask(), 0);
  const claim = await port.claim(context);
  assert.notEqual(claim.claimId, '', 'the fixture admission must open a claim');
  const executor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await port.beginAttempt(claim.claimId, executor);
  assert.notEqual(attempt.attemptId, '', 'the fixture must begin an attempt');
  const outcome = createTestRepositoryOutcomeReceiptV02(claim, attempt, context, { outcome: 'uncertain' });
  return { baseDir, port, claim, attempt, outcome };
}

for (const fault of ['attempt', 'claim', 'control'] as const) {
  test(`a ${fault} write lost after the outcome is completed by the same replay and reconciles to proven-not-dispatched`, async () => {
    const flow = await claimedAttempt(fault);
    try {
      const raw = new InterruptingStore(flow.port.store);
      raw[fault === 'attempt' ? 'failAttempt' : fault === 'claim' ? 'failClaim' : 'failControl'] = true;
      const beforeControl = await controlVersionOf(flow.port.store);
      await assert.rejects(() => recordOutcome(raw, flow.outcome), /fault/u);

      // The fault left the outcome durable but the claim still attempting: the state no recovery accepts.
      assert.equal((await raw.readClaim(context.taskId, flow.claim.claimId))?.status, 'attempting');
      assert.notEqual(await raw.readOutcome(context.taskId, flow.outcome.receiptId), null);

      // A differing receipt under the same id still refuses and completes nothing.
      const mismatched = createTestRepositoryOutcomeReceiptV02(flow.claim, flow.attempt, context, {
        outcome: 'uncertain',
        evidenceRefs: [{ reference: 'other-evidence', digest: computeCanonicalSha256('other-evidence') }],
      });
      assert.deepEqual(await flow.port.recordOutcome({ ...mismatched, receiptId: flow.outcome.receiptId } as AttemptOutcomeReceiptV02), NEUTRAL_OUTCOME_RECORD_RESULT_V02);
      assert.equal((await raw.readClaim(context.taskId, flow.claim.claimId))?.status, 'attempting');

      // The exact replay completes the transition, then reconciles through the real owner path.
      const beforeReplayWrites = raw.attemptWrites;
      assert.deepEqual(await recordOutcome(raw, flow.outcome), { outcome: 'uncertain', receiptId: flow.outcome.receiptId });
      assert.equal(raw.attemptWrites - beforeReplayWrites, fault === 'attempt' ? 1 : 0, 'only an incomplete durable attempt is rewritten');
      assert.equal((await raw.readClaim(context.taskId, flow.claim.claimId))?.status, 'uncertain');
      assert.equal((await raw.readAttempt(context.taskId, flow.attempt.attemptId))?.status, 'uncertain');
      assert.equal(await controlVersionOf(flow.port.store), beforeControl + 1, 'the completion advances control exactly once');

      assert.equal(await flow.port.setTaskControl(context.taskId, 'paused', `pause-replay-${fault}`), true);
      const fence = await flow.port.fenceAttemptRecipient(flow.claim.claimId, createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }));
      assert.ok(fence, 'the completed uncertain attempt is fenceable');
      const reconciliation = createTestUncertainReconciliationReceiptV02(flow.outcome, flow.claim, flow.attempt, context, {
        disposition: 'proven-not-dispatched',
        adapterEvidenceRefs: fence.adapterEvidenceRefs,
        fencedRecipientIdentity: fence.recipientIdentity,
        fencingGeneration: fence.fencingGeneration,
        fencingProof: fence.proofRef,
        evidenceRefs: [...fence.adapterEvidenceRefs, fence.proofRef],
        expectedCurrentControlVersion: await controlVersionOf(flow.port.store),
      });
      assert.equal((await flow.port.reconcileUncertain(reconciliation)).outcome, 'settled');

      const task = (await flow.port.loadTask(context.taskId)) as TaskState;
      const ledger = (task.budgetLedgers ?? []).find(item => item.kind === 'timeoutMs');
      assert.ok(ledger);
      assert.deepEqual(ledger.reservations, [], 'proven non-dispatch releases the held reservation');
      assert.equal(ledger.consumed, 0, 'no usage is charged for a non-dispatch');
      assert.equal((await raw.readClaim(context.taskId, flow.claim.claimId))?.status, 'settled');

      assert.deepEqual(await flow.port.recordOutcome(flow.outcome), { outcome: 'already-recorded', receiptId: flow.outcome.receiptId });

      // Replaying the same reconciliation is idempotent: no second accounting or control bump.
      const settledControl = await controlVersionOf(flow.port.store);
      assert.equal((await flow.port.reconcileUncertain(reconciliation)).outcome, 'settled');
      assert.equal(await controlVersionOf(flow.port.store), settledControl);
    } finally {
      rmSync(flow.baseDir, { recursive: true, force: true });
    }
  });
}

test('a fully written uncertain record still replays as already-recorded and never double-bumps control', async () => {
  const flow = await claimedAttempt('complete');
  try {
    assert.deepEqual(await flow.port.recordOutcome(flow.outcome), { outcome: 'uncertain', receiptId: flow.outcome.receiptId });
    const settledControl = await controlVersionOf(flow.port.store);
    assert.deepEqual(await flow.port.recordOutcome(flow.outcome), { outcome: 'already-recorded', receiptId: flow.outcome.receiptId });
    assert.equal(await controlVersionOf(flow.port.store), settledControl, 'a complete record is not rewritten');
  } finally {
    rmSync(flow.baseDir, { recursive: true, force: true });
  }
});

for (const fault of ['lost-reply', 'uncertain-claim'] as const) {
  test(`control publication evidence handles ${fault} without a repeated advance`, async () => {
    const flow = await claimedAttempt(fault);
    try {
      const raw = new InterruptingStore(flow.port.store);
      raw.loseControlReply = fault === 'lost-reply';
      raw.failControl = fault === 'uncertain-claim';
      const beforeControl = await controlVersionOf(flow.port.store);
      await assert.rejects(() => recordOutcome(raw, flow.outcome), /fault/u);
      if (fault === 'uncertain-claim') {
        const claim = await raw.readClaim(context.taskId, flow.claim.claimId);
        assert.ok(claim);
        await raw.writeClaim(context.taskId, { ...claim, status: 'uncertain' });
      }
      const beforeWrites = raw.attemptWrites;
      await recordOutcome(raw, flow.outcome);
      assert.equal(raw.attemptWrites, beforeWrites);
      assert.equal(await controlVersionOf(flow.port.store), beforeControl + 1);
      assert.deepEqual(await recordOutcome(raw, flow.outcome), { outcome: 'already-recorded', receiptId: flow.outcome.receiptId });
      assert.equal(await controlVersionOf(flow.port.store), beforeControl + 1);
    } finally {
      rmSync(flow.baseDir, { recursive: true, force: true });
    }
  });
}

test('a settled claim refuses an uncertain receipt whose persisted attempt has another outcome link', async () => {
  const flow = await claimedAttempt('wrong-settled-link');
  try {
    await flow.port.recordOutcome(flow.outcome);
    const raw = new StatePortStore(flow.port.store);
    const claim = await raw.readClaim(context.taskId, flow.claim.claimId);
    const attempt = await raw.readAttempt(context.taskId, flow.attempt.attemptId);
    assert.ok(claim);
    assert.ok(attempt);
    await raw.writeClaim(context.taskId, { ...claim, status: 'settled' });
    await raw.writeJson(raw.statePath(context.taskId, `attempt-${flow.attempt.attemptId}.json`), { ...attempt, outcomeReceiptId: 'different-outcome' });
    const beforeControl = await controlVersionOf(flow.port.store);
    assert.deepEqual(await flow.port.recordOutcome(flow.outcome), NEUTRAL_OUTCOME_RECORD_RESULT_V02);
    assert.equal(await controlVersionOf(flow.port.store), beforeControl);
    assert.equal((await raw.readAttempt(context.taskId, flow.attempt.attemptId))?.outcomeReceiptId, 'different-outcome');
  } finally {
    rmSync(flow.baseDir, { recursive: true, force: true });
  }
});
