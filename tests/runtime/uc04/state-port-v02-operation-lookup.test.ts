/**
 * T040 exact-operation lookup: `uc04-journal:` refs resolve from the durable claim/attempt journal
 * alone — committed with the exact persisted state and receipts, absent, or unknown. Every row is
 * built from a real claim → beginAttempt (→ recordOutcome) sequence; nothing writes or replays here.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ClaimReceiptV02, RepositoryAdmissionContextV02, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { StatePortStore } from '../../../src/persistence/adapters/state-port-v02-storage.ts';
import { createJournalOperationLookup, journalOperationPath, journalOperationRef } from '../../../src/persistence/adapters/state-port-v02-operation-lookup.ts';
import { createDurableUnattemptedClaimClosureHandoff } from '../../../src/foundation/durable-recovery-handoffs.ts';
import {
  createTestAdmissionTaskStateV02,
  createTestExecutorIdentityV02,
  createTestRepositoryCommandAdmissionContextV02,
  createTestRepositoryOutcomeReceiptV02,
  createTestUncertainReconciliationReceiptV02,
} from '../support/uc03/state-fixtures.ts';

const context: RepositoryAdmissionContextV02 = createTestRepositoryCommandAdmissionContextV02();

function seedTask(): TaskState {
  const task = createTestAdmissionTaskStateV02(context);
  return {
    ...task,
    budgetLedgers: [...(task.budgetLedgers ?? []), { scope: 'task', kind: 'timeoutMs', limit: 60_000, consumed: 0, reservations: [], unit: 'count', configurationId: 'config-v1', version: 1 }],
  };
}

async function openClaim(baseDir: string): Promise<{ port: DurableStatePortV02; claim: ClaimReceiptV02 }> {
  const store = new DurableStore(baseDir);
  await store.init();
  const port = new DurableStatePortV02({
    store,
    initialControl: { controlVersion: context.expectedControlVersion, epoch: context.expectedEpoch, activeAuthorityRef: context.policyAuthorityRef },
  });
  await port.transition(seedTask(), 0);
  const claim = await port.claim(context);
  assert.notEqual(claim.claimId, '', 'the fixture admission must open a claim');
  return { port, claim };
}

test('operation lookup: a recorded outcome is committed with the exact persisted state and receipts', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-lookup-committed-'));
  try {
    const { port, claim } = await openClaim(baseDir);
    const executor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
    const attempt = await port.beginAttempt(claim.claimId, executor);
    const outcome = createTestRepositoryOutcomeReceiptV02(claim, attempt, context);
    assert.deepEqual(await port.recordOutcome(outcome), { outcome: 'settled', receiptId: outcome.receiptId });

    const lookup = createJournalOperationLookup(port);
    const result = await lookup.lookupOperation(journalOperationRef(claim.claimId));
    assert.equal(result.outcome, 'committed');
    if (result.outcome !== 'committed') return;
    assert.deepEqual(result.state, await port.loadTask(context.taskId), 'the lookup must return the persisted task, not a reconstruction');
    assert.equal(result.commit.kind, 'claim');
    if (result.commit.kind !== 'claim') return;
    assert.deepEqual(result.commit.claim, claim);
    assert.deepEqual(result.commit.attempt, attempt);
    assert.deepEqual(result.commit.outcome, outcome);
    assert.equal(result.commit.reconciliation, null);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('operation lookup: a claim closed unattempted is absent and leaves no trace', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-lookup-absent-closed-'));
  try {
    const { port, claim } = await openClaim(baseDir);
    const handoff = createDurableUnattemptedClaimClosureHandoff(port);
    const closure = await handoff.closeUnattemptedClaim({
      admission: context,
      claim,
      recipientIdentity: createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }),
    });
    assert.equal(closure.closed, true, 'the closure must commit before its absence can be asserted');

    const before = await port.loadTask(context.taskId);
    assert.deepEqual(await createJournalOperationLookup(port).lookupOperation(journalOperationRef(claim.claimId)), { outcome: 'absent' });
    assert.deepEqual(await port.loadTask(context.taskId), before, 'a lookup must never write');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('operation lookup: a begun attempt with no outcome is unknown, as is an unknown id', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-lookup-unknown-attempt-'));
  try {
    const { port, claim } = await openClaim(baseDir);
    const lookup = createJournalOperationLookup(port);
    assert.deepEqual(await lookup.lookupOperation(journalOperationRef(claim.claimId)), { outcome: 'unknown' }, 'a claimed but unattempted claim proves nothing');

    const attempt = await port.beginAttempt(claim.claimId, createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }));
    assert.notEqual(attempt.attemptId, '', 'the fixture must begin a real attempt');
    assert.deepEqual(await lookup.lookupOperation(journalOperationRef(claim.claimId)), { outcome: 'unknown' }, 'a dispatched attempt with no recorded outcome stays unknown');

    assert.deepEqual(await lookup.lookupOperation(journalOperationRef('claim-never-issued')), { outcome: 'absent' }, 'no journal record is absent');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('operation lookup: a recorded uncertain outcome (no reconciliation) is still a recorded commit', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-lookup-recorded-uncertain-'));
  try {
    const { port, claim } = await openClaim(baseDir);
    const attempt = await port.beginAttempt(claim.claimId, createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }));
    const uncertain = createTestRepositoryOutcomeReceiptV02(claim, attempt, context, { outcome: 'uncertain' });
    assert.deepEqual(await port.recordOutcome(uncertain), { outcome: 'uncertain', receiptId: uncertain.receiptId });

    const result = await createJournalOperationLookup(port).lookupOperation(journalOperationRef(claim.claimId));
    assert.equal(result.outcome, 'committed', 'a recorded outcome is a durable fact, not an unknown');
    if (result.outcome !== 'committed' || result.commit.kind !== 'claim') return;
    assert.deepEqual(result.commit.outcome, uncertain);
    assert.equal(result.commit.reconciliation, null, 'no reconciliation was recorded');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('operation lookup: a reconciled uncertain attempt is committed with its reconciliation', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-lookup-reconciled-'));
  try {
    const { port, claim } = await openClaim(baseDir);
    const executor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
    const attempt = await port.beginAttempt(claim.claimId, executor);
    const uncertain = createTestRepositoryOutcomeReceiptV02(claim, attempt, context, { outcome: 'uncertain' });
    assert.deepEqual(await port.recordOutcome(uncertain), { outcome: 'uncertain', receiptId: uncertain.receiptId });
    assert.equal(await port.setTaskControl(context.taskId, 'paused', 'pause-t040-lookup-1'), true);
    const fence = await port.fenceAttemptRecipient(claim.claimId, executor);
    assert.ok(fence, 'the uncertain attempt must be fenceable');
    const task = (await port.loadTask(context.taskId)) as TaskState;
    const control = port.getJournalSnapshot(context.taskId) as { controlVersion: number };
    const reconciliation = createTestUncertainReconciliationReceiptV02(uncertain, claim, attempt, context, {
      disposition: 'proven-not-dispatched',
      fencedRecipientIdentity: fence.recipientIdentity,
      fencingGeneration: fence.fencingGeneration,
      fencingProof: fence.proofRef,
      adapterEvidenceRefs: fence.adapterEvidenceRefs,
      evidenceRefs: [...fence.adapterEvidenceRefs, fence.proofRef],
      expectedCurrentTaskStateVersion: task.stateVersion,
      expectedCurrentControlVersion: control.controlVersion,
    });
    assert.deepEqual(await port.reconcileUncertain(reconciliation), { outcome: 'settled', receiptId: reconciliation.reconciliationId });

    const result = await createJournalOperationLookup(port).lookupOperation(journalOperationRef(claim.claimId));
    assert.equal(result.outcome, 'committed');
    if (result.outcome !== 'committed' || result.commit.kind !== 'claim') return;
    assert.deepEqual(result.commit.outcome, uncertain, 'the recorded uncertain receipt is the durable fact');
    assert.deepEqual(result.commit.reconciliation, reconciliation, 'the settling reconciliation must be returned');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('operation lookup: a committed replan operation record resolves with its receipts', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-lookup-operation-'));
  try {
    const { port, claim } = await openClaim(baseDir);
    const state = new StatePortStore(port.store);
    const task = (await port.loadTask(context.taskId)) as TaskState;
    await state.writeJson(journalOperationPath(state, context.taskId, 'replan-op-001'), {
      taskId: context.taskId,
      stateVersion: task.stateVersion,
      receipts: ['replan-reservation-001', 'replan-transition-001'],
    });
    // The claim ref prefix is shared, so prove the claim branch still wins for its own id.
    const lookup = createJournalOperationLookup(port);
    const operation = await lookup.lookupOperation(journalOperationRef('replan-op-001'));
    assert.equal(operation.outcome, 'committed');
    if (operation.outcome === 'committed') {
      assert.deepEqual(operation.state, task);
      assert.deepEqual(operation.commit, { kind: 'operation', receipts: ['replan-reservation-001', 'replan-transition-001'] });
    }
    assert.equal((await lookup.lookupOperation(journalOperationRef(claim.claimId))).outcome, 'unknown', 'an open claim is not superseded by an operation record');

    // A record whose task version moved on is no longer that commit.
    await state.writeJson(journalOperationPath(state, context.taskId, 'replan-op-001'), { taskId: context.taskId, stateVersion: task.stateVersion + 1, receipts: [] });
    assert.deepEqual(await lookup.lookupOperation(journalOperationRef('replan-op-001')), { outcome: 'unknown' });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('operation lookup: a corrupt entry and any other prefix are unknown, and nothing writes', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-lookup-corrupt-'));
  try {
    const { port, claim } = await openClaim(baseDir);
    const lookup = createJournalOperationLookup(port);
    const state = new StatePortStore(port.store);
    assert.ok(await port.loadTask(context.taskId));

    assert.deepEqual(await lookup.lookupOperation(`uc04-baseline:${'a'.repeat(64)}`), { outcome: 'unknown' }, 'another owner prefix is not this journal');
    assert.deepEqual(await lookup.lookupOperation(claim.claimId), { outcome: 'unknown' }, 'an unprefixed ref is not this journal');
    assert.deepEqual(await lookup.lookupOperation(`${journalOperationRef('../../escape')}`), { outcome: 'unknown' }, 'an unsafe id is refused, not resolved');

    // A present entry that cannot be parsed must fail closed rather than report an absence.
    writeFileSync(state.statePath(context.taskId, 'recon-broken.json'), '{not json');
    const executor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
    const attempt = await port.beginAttempt(claim.claimId, executor);
    const outcome = createTestRepositoryOutcomeReceiptV02(claim, attempt, context);
    assert.deepEqual(await port.recordOutcome(outcome), { outcome: 'settled', receiptId: outcome.receiptId });
    const settled = await port.loadTask(context.taskId);
    assert.deepEqual(await lookup.lookupOperation(journalOperationRef(claim.claimId)), { outcome: 'unknown' }, 'an unreadable reconciled entry is unknown');

    assert.deepEqual(await port.loadTask(context.taskId), settled, 'no lookup may write');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
