/**
 * T056: the recorded UC-03 T066 matrix gaps, witnessed against the durable v0.2 state port.
 *
 * The legacy `atomic-admission-matrix.test.ts` is a read-only input; these rows re-measure the
 * gaps at `specs/001-verified-code-repair/tasks.md:527` on the production adapter:
 *
 * 1. SPEC-R1-003 — settled patch ancestry must survive a reconciliation, not only recordOutcome.
 * 2. fresh-receiver recovery state — an observed-unsettled patch reconciles on a new receiver.
 * 3. trusted evidence-invalidation refs/digests — recovery evidence binds them.
 * 4. public dispatched-state visibility — a begun attempt with no outcome is published.
 * 5. public checkpoint/fencing coverage — both are readable from a new receiver.
 *
 * Rows 2-5 hold in the current adapter; row 1 was RED before the reconciler recorded its
 * settlement result.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { computeCanonicalSha256 } from '../../../src/contracts/foundation/uc03.ts';
import { journalSnapshotV02 } from '../../../src/approvals/control-v02.ts';
import type {
  AttemptOutcomeReceiptV02,
  AttemptReconciliationReceiptV02,
  AttemptReceiptV02,
  ClaimReceiptV02,
  RepositoryAdmissionContextV02,
  TaskState,
} from '../../../src/contracts/foundation/uc03.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { DurableStatePortV02, NEUTRAL_CLAIM_RECEIPT_V02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { StatePortStore } from '../../../src/persistence/adapters/state-port-v02-storage.ts';
import { createJournalOperationLookup, journalOperationRef } from '../../../src/persistence/adapters/state-port-v02-operation-lookup.ts';
import {
  createTestAdmissionTaskStateV02,
  createTestExecutorIdentityV02,
  createTestObservedReconciliationReceiptV02,
  createTestRepositoryAdmissionContextV02,
  createTestRepositoryCommandAdmissionContextV02,
  createTestRepositoryOutcomeReceiptV02,
} from '../support/uc03/state-fixtures.ts';

const patchContext: RepositoryAdmissionContextV02 = createTestRepositoryAdmissionContextV02();
const commandContext: RepositoryAdmissionContextV02 = createTestRepositoryCommandAdmissionContextV02();

/** Opens a new receiver over the same durable root: every row crosses a process boundary this way. */
function openReceiver(baseDir: string, ctx: RepositoryAdmissionContextV02): DurableStatePortV02 {
  return new DurableStatePortV02({
    store: new DurableStore(baseDir),
    initialControl: { controlVersion: ctx.expectedControlVersion, epoch: ctx.expectedEpoch, activeAuthorityRef: ctx.policyAuthorityRef },
  });
}

/** The command admission reserves one timeoutMs resource, so that task must carry the ledger too. */
function seedTask(ctx: RepositoryAdmissionContextV02): TaskState {
  const task = createTestAdmissionTaskStateV02(ctx);
  return {
    ...task,
    budgetLedgers: [...(task.budgetLedgers ?? []), { scope: 'task', kind: 'timeoutMs', limit: 60_000, consumed: 0, reservations: [], unit: 'count', configurationId: 'config-v1', version: 1 }],
  };
}

function safeRef(reference: string) {
  return { reference, digest: computeCanonicalSha256(reference) };
}

/** JournalSnapshotV02 is the validator's narrow projection; the rows below read columns it validates but omits. */
interface SnapshotRows {
  readonly outcomes: readonly { readonly receiptId: string; readonly claimId: string; readonly attemptId: string; readonly outcome: string; readonly receiptDigest: string }[];
  readonly recoveryEvidencePredecessorReceiptIds: readonly string[];
}

function rowsOf(snapshot: unknown): SnapshotRows {
  return snapshot as SnapshotRows;
}

async function openClaim(baseDir: string, ctx: RepositoryAdmissionContextV02): Promise<{ receiver: DurableStatePortV02; claim: ClaimReceiptV02; attempt: AttemptReceiptV02 }> {
  const receiver = openReceiver(baseDir, ctx);
  await receiver.transition(seedTask(ctx), 0);
  const claim = await receiver.claim(ctx);
  assert.notEqual(claim.claimId, '', 'the fixture admission must open a claim');
  const attempt = await receiver.beginAttempt(claim.claimId, createTestExecutorIdentityV02({ payloadDigest: ctx.actionDigest }));
  assert.notEqual(attempt.attemptId, '', 'the fixture must begin a real attempt');
  return { receiver, claim, attempt };
}

/** Records the patch outcome, drifts the task so settlement conflicts, and leaves it observed-unsettled. */
async function leaveObservedUnsettled(receiver: DurableStatePortV02, claim: ClaimReceiptV02, attempt: AttemptReceiptV02, ctx: RepositoryAdmissionContextV02): Promise<AttemptOutcomeReceiptV02> {
  const state = new StatePortStore(receiver.store);
  const atAttempt = (await receiver.loadTask(ctx.taskId)) as TaskState;
  await state.writeTask(ctx.taskId, { ...atAttempt, node: 'Verify' });
  const outcome = createTestRepositoryOutcomeReceiptV02(claim, attempt, ctx);
  assert.deepEqual(await receiver.recordOutcome(outcome), { outcome: 'recorded-unsettled', receiptId: outcome.receiptId });
  assert.ok(outcome.observedResultRevisionDigest, 'a patch outcome carries its observed revision');
  await state.writeTask(ctx.taskId, { ...atAttempt, repositoryRevisionDigest: outcome.observedResultRevisionDigest });
  return outcome;
}

async function reconcileFromNewReceiver(
  baseDir: string,
  claim: ClaimReceiptV02,
  attempt: AttemptReceiptV02,
  outcome: AttemptOutcomeReceiptV02,
  ctx: RepositoryAdmissionContextV02,
): Promise<{ task: TaskState; reconciliation: AttemptReconciliationReceiptV02 }> {
  const receiver = openReceiver(baseDir, ctx);
  const control = receiver.getJournalSnapshot(ctx.taskId) as { controlVersion: number };
  const reconciliation = createTestObservedReconciliationReceiptV02(outcome, claim, attempt, ctx, {
    expectedCurrentTaskStateVersion: attempt.postBeginTaskStateVersion,
    expectedCurrentControlVersion: control.controlVersion,
  });
  assert.deepEqual(await receiver.reconcileObservedOutcome(reconciliation), { outcome: 'settled', receiptId: reconciliation.reconciliationId });
  return { task: (await receiver.loadTask(ctx.taskId)) as TaskState, reconciliation };
}

test('SPEC-R1-003: a patch settled by observed reconciliation publishes its settled ancestry to a new receiver', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-gap-ancestry-'));
  try {
    const { receiver, claim, attempt } = await openClaim(baseDir, patchContext);
    const outcome = await leaveObservedUnsettled(receiver, claim, attempt, patchContext);
    const settled = await reconcileFromNewReceiver(baseDir, claim, attempt, outcome, patchContext);

    const afterRestart = openReceiver(baseDir, patchContext);
    const ancestry = await afterRestart.readSettledPatchAncestry({
      taskId: patchContext.taskId,
      runId: patchContext.runId,
      resultingRepositoryRevisionDigest: settled.task.repositoryRevisionDigest,
    });
    assert.ok(ancestry, 'a reconciled patch is a settled execution the verifier must be able to read');
    assert.deepEqual(ancestry.claim, claim);
    assert.deepEqual(ancestry.attempt, attempt);
    assert.deepEqual(ancestry.outcome, outcome);
    assert.deepEqual(ancestry.settlement, { outcome: 'settled', receiptId: outcome.receiptId }, 'the settlement names the observed outcome it settled');
    assert.equal(ancestry.originalTaskState.node, 'Repair', 'ancestry keeps the pre-verify task snapshot');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('fresh-receiver recovery state: an observed-unsettled patch reconciles once on a new receiver and replays idempotently', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-gap-recovery-'));
  try {
    const { receiver, claim, attempt } = await openClaim(baseDir, patchContext);
    const atAttempt = (await receiver.loadTask(patchContext.taskId)) as TaskState;
    const outcome = await leaveObservedUnsettled(receiver, claim, attempt, patchContext);

    // The recovery facts are durable before the receiver that settles them exists.
    const probing = openReceiver(baseDir, patchContext);
    const snapshot = journalSnapshotV02(probing.getJournalSnapshot(patchContext.taskId));
    assert.ok(snapshot, 'the journal must project a valid snapshot after the crash');
    assert.deepEqual(snapshot.claims, [{ claimId: claim.claimId, status: 'observed-unsettled', attemptId: attempt.attemptId }]);
    assert.deepEqual(snapshot.attempts, [{ attemptId: attempt.attemptId, claimId: claim.claimId, status: 'observed-unsettled', outcomeReceiptId: outcome.receiptId }]);
    assert.deepEqual(rowsOf(snapshot).outcomes, [{ receiptId: outcome.receiptId, claimId: claim.claimId, attemptId: attempt.attemptId, outcome: 'observed', receiptDigest: outcome.receiptDigest }]);
    assert.equal(snapshot.activeClaimId, claim.claimId, 'the unsettled attempt still owns the open claim');

    const { task: settled, reconciliation } = await reconcileFromNewReceiver(baseDir, claim, attempt, outcome, patchContext);
    assert.equal(settled.node, 'Verify', 'recovery commits the exact Patch/Repair -> Verify transition');
    assert.equal(settled.stateVersion, atAttempt.stateVersion + 1, 'recovery advances the task exactly once');
    const repairConsumed = settled.budgetLedgers?.find(ledger => ledger.kind === 'repair')?.consumed;

    // A third receiver replays the identical receipt: same result, no second transition, no second charge.
    const third = openReceiver(baseDir, patchContext);
    assert.deepEqual(await third.reconcileObservedOutcome(reconciliation), { outcome: 'settled', receiptId: reconciliation.reconciliationId }, 'the identical receipt replays its settlement');
    const afterReplay = (await third.loadTask(patchContext.taskId)) as TaskState;
    assert.equal(afterReplay.stateVersion, settled.stateVersion, 'a replay cannot advance the task again');
    assert.equal(afterReplay.budgetLedgers?.find(ledger => ledger.kind === 'repair')?.consumed, repairConsumed, 'a replay cannot charge again');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('trusted evidence invalidation: recovery evidence binds its invalidated refs and digests', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-gap-invalidation-'));
  try {
    const { receiver, claim, attempt } = await openClaim(baseDir, patchContext);
    const executor = attempt.executorIdentity;
    const uncertain = createTestRepositoryOutcomeReceiptV02(claim, attempt, patchContext, { outcome: 'uncertain' });
    assert.deepEqual(await receiver.recordOutcome(uncertain), { outcome: 'uncertain', receiptId: uncertain.receiptId });
    assert.equal(await receiver.setTaskControl(patchContext.taskId, 'paused', 'pause-gap-invalidation'), true);
    assert.ok(await openReceiver(baseDir, patchContext).fenceAttemptRecipient(claim.claimId, executor));

    const observedRevisionDigest = computeCanonicalSha256({ synthetic: 'gap-invalidation-revision' });
    const accountingEvidenceRefs = [safeRef('gap-invalidation-accounting')];
    const invalidatedEvidence = [safeRef('gap-invalidation-prior-diagnosis')];
    const effectEvidenceRef = {
      reference: 'gap-invalidation-effect',
      digest: computeCanonicalSha256({
        schemaVersion: 'uc03-observed-patch-recovery/0.2-draft',
        predecessorReceiptId: uncertain.receiptId,
        effectConfirmation: true,
        observedRevisionDigest,
        invalidatedEvidence,
        accountingEvidenceRefs,
      }),
    };
    const evidence = { predecessorReceiptId: uncertain.receiptId, effectEvidenceRef, accountingEvidenceRefs, observedRevisionDigest, invalidatedEvidence };

    const third = openReceiver(baseDir, patchContext);
    assert.equal(await third.publishRecoveryEvidence(patchContext.taskId, evidence), true, 'the bound evidence is accepted');
    const snapshot = journalSnapshotV02(third.getJournalSnapshot(patchContext.taskId));
    assert.ok(snapshot);
    assert.deepEqual(rowsOf(snapshot).recoveryEvidencePredecessorReceiptIds, [uncertain.receiptId], 'published evidence is publicly listed');

    // A ref list or digest the evidence did not bind is refused, and the accepted copy stays authoritative.
    assert.equal(await third.publishRecoveryEvidence(patchContext.taskId, { ...evidence, invalidatedEvidence: [safeRef('gap-invalidation-other')] }), false);
    assert.equal(
      await third.publishRecoveryEvidence(patchContext.taskId, { ...evidence, effectEvidenceRef: { ...effectEvidenceRef, digest: computeCanonicalSha256('gap-invalidation-forged') } }),
      false,
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('public dispatched state: a begun attempt with no recorded outcome is visible and blocks a fresh claim', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-gap-dispatched-'));
  try {
    const { receiver, claim, attempt } = await openClaim(baseDir, commandContext);
    assert.notEqual(attempt.attemptId, '');

    const afterRestart = openReceiver(baseDir, commandContext);
    const snapshot = journalSnapshotV02(afterRestart.getJournalSnapshot(commandContext.taskId));
    assert.ok(snapshot);
    assert.deepEqual(snapshot.claims, [{ claimId: claim.claimId, status: 'attempting', attemptId: attempt.attemptId }]);
    assert.deepEqual(snapshot.attempts, [{ attemptId: attempt.attemptId, claimId: claim.claimId, status: 'attempting', outcomeReceiptId: null }]);
    assert.equal(snapshot.activeClaimId, claim.claimId, 'the dispatched claim is the open one');

    // Dispatched-but-unrecorded proves nothing, so exact-operation lookup stays unknown after restart.
    assert.deepEqual(await createJournalOperationLookup(afterRestart).lookupOperation(journalOperationRef(claim.claimId)), { outcome: 'unknown' });

    const fresh = await afterRestart.claim(createTestRepositoryCommandAdmissionContextV02({ taskId: commandContext.taskId, runId: 'run-gap-competitor' }));
    assert.deepEqual(fresh, NEUTRAL_CLAIM_RECEIPT_V02, 'a fresh action/run claim is denied while one is dispatched');
    assert.equal(receiver.provenance, 'real', 'this is the production adapter, not a double');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('public checkpoint and fencing coverage: both are readable from a new receiver', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-gap-checkpoint-'));
  try {
    const { receiver, claim, attempt } = await openClaim(baseDir, commandContext);
    const current = (await receiver.loadTask(commandContext.taskId)) as TaskState;
    await receiver.checkpoint(current);

    const afterRestart = openReceiver(baseDir, commandContext);
    assert.deepEqual(await afterRestart.recover(commandContext.taskId), current, 'recover returns the checkpointed task');

    assert.deepEqual(await afterRestart.recordOutcome(createTestRepositoryOutcomeReceiptV02(claim, attempt, commandContext, { outcome: 'uncertain' })), {
      outcome: 'uncertain',
      receiptId: 'repo-out-001',
    });
    assert.equal(await afterRestart.setTaskControl(commandContext.taskId, 'paused', 'pause-gap-checkpoint'), true);
    const fence = await openReceiver(baseDir, commandContext).fenceAttemptRecipient(claim.claimId, attempt.executorIdentity);
    assert.ok(fence, 'an uncertain attempt is fenceable from a new receiver');

    const fenced = journalSnapshotV02(openReceiver(baseDir, commandContext).getJournalSnapshot(commandContext.taskId));
    assert.ok(fenced);
    assert.deepEqual(
      fenced.fenceProofs,
      [{ claimId: claim.claimId, proofRef: fence.proofRef, fencingGeneration: fence.fencingGeneration, holdRef: fence.holdRef, controlVersion: fence.controlVersion, epoch: fence.epoch }],
      'the public snapshot carries the persisted fence proof',
    );
    assert.deepEqual(fenced.fencedIncarnations, [`${attempt.executorIdentity.adapterIdentity}\u0000${attempt.executorIdentity.processIncarnation}`]);
    assert.equal(fenced.mode, 'paused', 'the fence preserves the pause hold it was minted under');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
