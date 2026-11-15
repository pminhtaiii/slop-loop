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
import { computeAdmissionDigest, computeAttemptOutcomeDigest, computeReconciliationDigest } from '../../../src/contracts/foundation/uc03.ts';
import type { AttemptReconciliationReceiptV02, ClaimReceiptV02, RepositoryAdmissionContextV02, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { StatePortStore } from '../../../src/persistence/adapters/state-port-v02-storage.ts';
import { createJournalOperationLookup, journalOperationPath, journalOperationRef } from '../../../src/persistence/adapters/state-port-v02-operation-lookup.ts';
import { createDurableUnattemptedClaimClosureHandoff } from '../../../src/foundation/durable-recovery-handoffs.ts';
import {
  createTestAdmissionTaskStateV02,
  createTestExecutorIdentityV02,
  createTestObservedReconciliationReceiptV02,
  createTestRepositoryAdmissionContextV02,
  createTestRepositoryCommandAdmissionContextV02,
  createTestRepositoryOutcomeReceiptV02,
  createTestUncertainReconciliationReceiptV02,
} from '../support/uc03/state-fixtures.ts';

const context: RepositoryAdmissionContextV02 = createTestRepositoryCommandAdmissionContextV02();

function seedTask(ctx: RepositoryAdmissionContextV02 = context): TaskState {
  const task = createTestAdmissionTaskStateV02(ctx);
  return {
    ...task,
    budgetLedgers: [...(task.budgetLedgers ?? []), { scope: 'task', kind: 'timeoutMs', limit: 60_000, consumed: 0, reservations: [], unit: 'count', configurationId: 'config-v1', version: 1 }],
  };
}

async function openClaim(baseDir: string, ctx: RepositoryAdmissionContextV02 = context): Promise<{ port: DurableStatePortV02; claim: ClaimReceiptV02 }> {
  const store = new DurableStore(baseDir);
  await store.init();
  const port = new DurableStatePortV02({
    store,
    initialControl: { controlVersion: ctx.expectedControlVersion, epoch: ctx.expectedEpoch, activeAuthorityRef: ctx.policyAuthorityRef },
  });
  await port.transition(seedTask(ctx), 0);
  const claim = await port.claim(ctx);
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

test('operation lookup: a forged reconciliation the writer never settled is unknown', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-lookup-recon-forged-'));
  try {
    const { port, claim } = await openClaim(baseDir);
    const state = new StatePortStore(port.store);
    const executor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
    const attempt = await port.beginAttempt(claim.claimId, executor);
    const uncertain = createTestRepositoryOutcomeReceiptV02(claim, attempt, context, { outcome: 'uncertain' });
    assert.deepEqual(await port.recordOutcome(uncertain), { outcome: 'uncertain', receiptId: uncertain.receiptId });
    assert.equal(await port.setTaskControl(context.taskId, 'paused', 'pause-t040-forged-1'), true);
    const fence = await port.fenceAttemptRecipient(claim.claimId, executor);
    assert.ok(fence, 'the uncertain attempt must be fenceable');
    const task = (await port.loadTask(context.taskId)) as TaskState;
    const control = port.getJournalSnapshot(context.taskId) as { controlVersion: number };
    // Digest-valid, but claiming a control head the writer refuses: only the settlement journal
    // (claim and attempt rewritten settled, then control advanced) can make this a commit.
    const forged = createTestUncertainReconciliationReceiptV02(uncertain, claim, attempt, context, {
      disposition: 'proven-not-dispatched',
      fencedRecipientIdentity: fence.recipientIdentity,
      fencingGeneration: fence.fencingGeneration,
      fencingProof: fence.proofRef,
      adapterEvidenceRefs: fence.adapterEvidenceRefs,
      evidenceRefs: [...fence.adapterEvidenceRefs, fence.proofRef],
      expectedCurrentTaskStateVersion: task.stateVersion,
      expectedCurrentControlVersion: control.controlVersion + 1000,
    });
    assert.equal((await port.reconcileUncertain(forged)).outcome, 'conflict', 'the writer must refuse the forged head');
    await state.writeJson(state.statePath(context.taskId, `recon-${forged.reconciliationId}.json`), forged);
    const lookup = createJournalOperationLookup(port);
    assert.deepEqual(await lookup.lookupOperation(journalOperationRef(claim.claimId)), { outcome: 'unknown' }, 'an unsettled claim makes the reconciliation a partial write');

    // Hand-setting the statuses cannot fabricate the advance the writer never made.
    const storedClaim = await state.readClaim(context.taskId, claim.claimId);
    const storedAttempt = await state.readAttempt(context.taskId, attempt.attemptId);
    assert.ok(storedClaim && storedAttempt);
    await state.writeClaim(context.taskId, { ...storedClaim, status: 'settled' });
    await state.writeJson(state.statePath(context.taskId, `attempt-${attempt.attemptId}.json`), { ...storedAttempt, status: 'settled' });
    assert.deepEqual(await lookup.lookupOperation(journalOperationRef(claim.claimId)), { outcome: 'unknown' }, 'a future control head is impossible');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('operation lookup: a settled reconciliation stays committed after control advances further', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-lookup-recon-historical-'));
  try {
    const { port, claim } = await openClaim(baseDir);
    const executor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
    const attempt = await port.beginAttempt(claim.claimId, executor);
    const uncertain = createTestRepositoryOutcomeReceiptV02(claim, attempt, context, { outcome: 'uncertain' });
    assert.deepEqual(await port.recordOutcome(uncertain), { outcome: 'uncertain', receiptId: uncertain.receiptId });
    assert.equal(await port.setTaskControl(context.taskId, 'paused', 'pause-t040-historical-1'), true);
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
    assert.equal(await port.setTaskControl(context.taskId, 'paused', 'pause-t040-historical-2'), true, 'control must advance past the reconcile-time head');

    const result = await createJournalOperationLookup(port).lookupOperation(journalOperationRef(claim.claimId));
    assert.equal(result.outcome, 'committed', 'a real historical settlement stays committed');
    if (result.outcome !== 'committed' || result.commit.kind !== 'claim') return;
    assert.deepEqual(result.commit.reconciliation, reconciliation);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

/** Drives a real uncertain-attempt settlement through the port and returns the receipt it wrote. */
async function settleUncertain(port: DurableStatePortV02, claim: ClaimReceiptV02, pauseRef: string): Promise<AttemptReconciliationReceiptV02> {
  const executor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await port.beginAttempt(claim.claimId, executor);
  const uncertain = createTestRepositoryOutcomeReceiptV02(claim, attempt, context, { outcome: 'uncertain' });
  assert.deepEqual(await port.recordOutcome(uncertain), { outcome: 'uncertain', receiptId: uncertain.receiptId });
  assert.equal(await port.setTaskControl(context.taskId, 'paused', pauseRef), true);
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
  return reconciliation;
}

/** Drives a real observed-unsettled settlement of a repair patch: same-version drift records it unsettled, then reconcile settles. */
async function settleObserved(port: DurableStatePortV02, claim: ClaimReceiptV02, ctx: RepositoryAdmissionContextV02): Promise<AttemptReconciliationReceiptV02> {
  const state = new StatePortStore(port.store);
  const attempt = await port.beginAttempt(claim.claimId, createTestExecutorIdentityV02({ payloadDigest: ctx.actionDigest }));
  const atAttempt = (await port.loadTask(ctx.taskId)) as TaskState;
  await state.writeTask(ctx.taskId, { ...atAttempt, node: 'Verify' });
  const outcome = createTestRepositoryOutcomeReceiptV02(claim, attempt, ctx);
  assert.deepEqual(await port.recordOutcome(outcome), { outcome: 'recorded-unsettled', receiptId: outcome.receiptId });
  assert.ok(outcome.observedResultRevisionDigest, 'a repair patch outcome carries its observed revision');
  await state.writeTask(ctx.taskId, { ...atAttempt, repositoryRevisionDigest: outcome.observedResultRevisionDigest });
  const control = port.getJournalSnapshot(ctx.taskId) as { controlVersion: number };
  const reconciliation = createTestObservedReconciliationReceiptV02(outcome, claim, attempt, ctx, {
    expectedCurrentTaskStateVersion: atAttempt.stateVersion,
    expectedCurrentControlVersion: control.controlVersion,
  });
  assert.deepEqual(await port.reconcileObservedOutcome(reconciliation), { outcome: 'settled', receiptId: reconciliation.reconciliationId });
  return reconciliation;
}

/** A digest-valid reconciliation naming an older control head: only the writer's binding can refuse it. */
function reframeHead(reconciliation: AttemptReconciliationReceiptV02, controlVersion: number): AttemptReconciliationReceiptV02 {
  const forged = { ...reconciliation, expectedCurrentControlVersion: controlVersion } as Record<string, unknown>;
  return { ...forged, reconciliationDigest: computeReconciliationDigest(forged) } as unknown as AttemptReconciliationReceiptV02;
}

test('operation lookup: swapping in an older-head reconciliation the writer never produced is unknown', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-lookup-recon-older-head-'));
  try {
    const { port, claim } = await openClaim(baseDir);
    const state = new StatePortStore(port.store);
    const reconciliation = await settleUncertain(port, claim, 'pause-t040-older-head-1');
    // The merger's probe: a receipt naming the head one before the fence is digest-valid and passes
    // the receipt validator, but the writer's fencing proof was minted at (or past) that head.
    const forged = reframeHead(reconciliation, reconciliation.expectedCurrentControlVersion - 1);
    assert.notEqual(forged.reconciliationDigest, reconciliation.reconciliationDigest);
    await state.writeJson(state.statePath(context.taskId, `recon-${reconciliation.reconciliationId}.json`), forged);

    assert.deepEqual(
      await createJournalOperationLookup(port).lookupOperation(journalOperationRef(claim.claimId)),
      { outcome: 'unknown' },
      'an older-head receipt predates the fencing the writer proved',
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('operation lookup: a settled claim with no settlement binding is unknown', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-lookup-recon-unbound-'));
  try {
    const { port, claim } = await openClaim(baseDir);
    const state = new StatePortStore(port.store);
    await settleUncertain(port, claim, 'pause-t040-unbound-1');
    const stored = await state.readClaim(context.taskId, claim.claimId);
    assert.ok(stored?.settlement, 'a real settlement must carry its binding');
    const unbound = { ...stored, settlement: undefined };
    await state.writeClaim(context.taskId, unbound);

    assert.deepEqual(
      await createJournalOperationLookup(port).lookupOperation(journalOperationRef(claim.claimId)),
      { outcome: 'unknown' },
      'a settled status alone does not prove which receipt settled it',
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('operation lookup: a settlement binding naming another receipt digest is unknown', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-lookup-recon-rebound-'));
  try {
    const { port, claim } = await openClaim(baseDir);
    const state = new StatePortStore(port.store);
    const reconciliation = await settleUncertain(port, claim, 'pause-t040-rebound-1');
    const stored = await state.readClaim(context.taskId, claim.claimId);
    assert.ok(stored?.settlement);
    const otherDigest = reframeHead(reconciliation, reconciliation.expectedCurrentControlVersion - 1).reconciliationDigest;
    assert.notEqual(otherDigest, reconciliation.reconciliationDigest);
    await state.writeClaim(context.taskId, { ...stored, settlement: { ...stored.settlement, receiptDigest: otherDigest } });

    assert.deepEqual(
      await createJournalOperationLookup(port).lookupOperation(journalOperationRef(claim.claimId)),
      { outcome: 'unknown' },
      'a binding to a digest the journal does not hold is not a commit',
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('operation lookup: a real settlement of either kind stays committed after control advances further', async () => {
  const kinds: readonly (readonly [string, (port: DurableStatePortV02, claim: ClaimReceiptV02, ctx: RepositoryAdmissionContextV02) => Promise<AttemptReconciliationReceiptV02>])[] = [
    ['uncertain-attempt', (port, claim) => settleUncertain(port, claim, 'pause-t040-settled-1')],
    ['observed-unsettled', (port, claim, ctx) => settleObserved(port, claim, ctx)],
  ];
  for (const [kind, settle] of kinds) {
    const baseDir = mkdtempSync(join(tmpdir(), `uc04-lookup-settled-${kind}-`));
    try {
      const ctx = kind === 'observed-unsettled' ? createTestRepositoryAdmissionContextV02() : context;
      const { port, claim } = await openClaim(baseDir, ctx);
      const reconciliation = await settle(port, claim, ctx);
      const stored = await new StatePortStore(port.store).readClaim(ctx.taskId, claim.claimId);
      assert.deepEqual(stored?.settlement, { reconciliationId: reconciliation.reconciliationId, receiptDigest: reconciliation.reconciliationDigest }, `${kind}: the writer must persist its binding`);
      assert.equal(await port.setTaskControl(ctx.taskId, 'paused', `pause-t040-${kind}-2`), true, 'control must advance past the reconcile-time head');

      const result = await createJournalOperationLookup(port).lookupOperation(journalOperationRef(claim.claimId));
      assert.equal(result.outcome, 'committed', `${kind}: a real settlement stays committed`);
      if (result.outcome !== 'committed' || result.commit.kind !== 'claim') return;
      assert.deepEqual(result.commit.reconciliation, reconciliation);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
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

test('operation lookup: a structurally corrupt outcome or reconciliation is unknown', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-lookup-corrupt-schema-'));
  try {
    const { port, claim } = await openClaim(baseDir);
    const state = new StatePortStore(port.store);
    const lookup = createJournalOperationLookup(port);
    const attempt = await port.beginAttempt(claim.claimId, createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }));
    const outcome = createTestRepositoryOutcomeReceiptV02(claim, attempt, context);
    assert.deepEqual(await port.recordOutcome(outcome), { outcome: 'settled', receiptId: outcome.receiptId });
    const outcomePath = state.statePath(context.taskId, `outcome-${outcome.receiptId}.json`);
    const otherTask = createTestRepositoryCommandAdmissionContextV02({ taskId: 'task-other-002' });
    const rebound = (raw: Record<string, unknown>): Record<string, unknown> => ({ ...raw, receiptDigest: computeAttemptOutcomeDigest(raw) });

    // Each row is parseable JSON whose digest is self-consistent, so only binding or schema can refuse it.
    const rows: readonly (readonly [string, unknown])[] = [
      ['an empty object', {}],
      ['a wrong claim id', rebound({ ...outcome, claimId: 'claim-other-001' })],
      ['a wrong attempt id', rebound({ ...outcome, attemptId: 'attempt-other-001' })],
      ['a wrong task', rebound({ ...outcome, admissionDigest: computeAdmissionDigest(otherTask) })],
    ];
    for (const [label, value] of rows) {
      await state.writeJson(outcomePath, value);
      assert.deepEqual(await lookup.lookupOperation(journalOperationRef(claim.claimId)), { outcome: 'unknown' }, `${label} is not a recorded commit`);
    }

    await state.writeJson(outcomePath, outcome);
    const bogusReconciliation: Record<string, unknown> = { claimId: claim.claimId, predecessorReceiptId: outcome.receiptId };
    await state.writeJson(state.statePath(context.taskId, 'recon-001.json'), { ...bogusReconciliation, reconciliationDigest: computeReconciliationDigest(bogusReconciliation) });
    assert.deepEqual(await lookup.lookupOperation(journalOperationRef(claim.claimId)), { outcome: 'unknown' }, 'a reconciliation that does not settle this outcome is unknown');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('operation lookup: a self-consistent receipt the canonical validators refuse is unknown', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-lookup-canonical-invalid-'));
  try {
    const { port, claim } = await openClaim(baseDir);
    const state = new StatePortStore(port.store);
    const lookup = createJournalOperationLookup(port);
    const attempt = await port.beginAttempt(claim.claimId, createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }));
    const outcome = createTestRepositoryOutcomeReceiptV02(claim, attempt, context);
    assert.deepEqual(await port.recordOutcome(outcome), { outcome: 'settled', receiptId: outcome.receiptId });
    const outcomePath = state.statePath(context.taskId, `outcome-${outcome.receiptId}.json`);
    const raw = outcome as unknown as Record<string, unknown>;
    const rebound = (receipt: Record<string, unknown>): Record<string, unknown> => ({ ...receipt, receiptDigest: computeAttemptOutcomeDigest(receipt) });

    // Each row keeps every binding valid and recomputes its digest, so only canonical receipt
    // validation can tell it apart from the real commit.
    const rows: readonly (readonly [string, Record<string, unknown>])[] = [
      ['an invalid outcome status', rebound({ ...raw, outcome: 'not-an-outcome' })],
      ['a receipt missing a required field', rebound(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'versions')))],
    ];
    for (const [label, value] of rows) {
      await state.writeJson(outcomePath, value);
      assert.deepEqual(await lookup.lookupOperation(journalOperationRef(claim.claimId)), { outcome: 'unknown' }, `${label} is not a recorded commit`);
    }

    await state.writeJson(outcomePath, outcome);
    const weakReconciliation: Record<string, unknown> = {
      reconciliationId: 'recon-001',
      reconciliationKind: 'observed-unsettled',
      predecessorReceiptId: outcome.receiptId,
      predecessorReceiptDigest: outcome.receiptDigest,
      admissionDigest: computeAdmissionDigest(context),
      claimId: claim.claimId,
      claimDigest: claim.claimDigest,
      attemptId: attempt.attemptId,
      evidenceRefs: outcome.evidenceRefs,
    };
    await state.writeJson(state.statePath(context.taskId, 'recon-001.json'), { ...weakReconciliation, reconciliationDigest: computeReconciliationDigest(weakReconciliation) });
    assert.deepEqual(await lookup.lookupOperation(journalOperationRef(claim.claimId)), { outcome: 'unknown' }, 'a self-consistent reconciliation missing required fields is not a settle');
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
