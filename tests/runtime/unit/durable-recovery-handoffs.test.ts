/**
 * Stand-in recovery handoffs: the no-attempt closure really pauses, fences and closes the claim,
 * and the two unimplemented paths refuse by name instead of fabricating evidence.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ClaimReceiptV02, RepositoryAdmissionContextV02, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { createDurableAttemptStartRecoveryHandoff, createDurableUnattemptedClaimClosureHandoff, createRefusingPatchRecoveryHandoff } from '../../../src/foundation/durable-recovery-handoffs.ts';
import { createTestAdmissionTaskStateV02, createTestExecutorIdentityV02, createTestRepositoryCommandAdmissionContextV02 } from '../support/uc03/state-fixtures.ts';

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

function snapshotOf(port: DurableStatePortV02): { mode: string; activeClaimId: string | null } {
  return port.getJournalSnapshot(context.taskId) as { mode: string; activeClaimId: string | null };
}

test('durable recovery handoffs: closure pauses, fences and closes an unattempted claim', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-handoff-closure-'));
  try {
    const { port, claim } = await openClaim(baseDir);
    const handoff = createDurableUnattemptedClaimClosureHandoff(port);
    const recipient = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });

    const receipt = await handoff.closeUnattemptedClaim({ admission: context, claim, recipientIdentity: recipient });
    assert.equal(receipt.closed, true, 'closure must succeed');
    assert.match(receipt.receiptId, /^closure-[0-9a-f]{20}$/, 'the receipt id must derive from the closure digest');
    assert.equal(snapshotOf(port).mode, 'paused', 'closure pauses the task rather than resuming it');
    assert.equal(snapshotOf(port).activeClaimId, null, 'closure leaves no open claim');

    assert.deepEqual(await handoff.closeUnattemptedClaim({ admission: context, claim, recipientIdentity: recipient }), receipt, 'an identical closure must be idempotent');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('durable recovery handoffs: a recipient bound to other content cannot close the claim', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-handoff-deny-'));
  try {
    const { port, claim } = await openClaim(baseDir);
    const receipt = await createDurableUnattemptedClaimClosureHandoff(port).closeUnattemptedClaim({
      admission: context,
      claim,
      recipientIdentity: createTestExecutorIdentityV02({ payloadDigest: `sha256:${'0'.repeat(64)}` }),
    });
    assert.deepEqual(receipt, { closed: false, receiptId: '' }, 'a mismatched recipient must not close the claim');
    assert.equal(snapshotOf(port).activeClaimId, claim.claimId, 'a refused closure must leave the claim open');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('durable recovery handoffs: attempt start reports the fenced closure it can prove', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-handoff-attempt-start-'));
  try {
    const { port, claim } = await openClaim(baseDir);
    const requester = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
    const handoff = createDurableAttemptStartRecoveryHandoff(port);
    const request = { recoveryId: 'attempt-start:test', admission: context, claim, executorIdentity: requester };

    assert.deepEqual(await handoff.queryAttemptStart(request), { outcome: 'unknown' }, 'an open claim with no fence proves nothing yet');

    const closure = await createDurableUnattemptedClaimClosureHandoff(port).closeUnattemptedClaim({ admission: context, claim, recipientIdentity: requester });
    assert.equal(closure.closed, true, 'the closure must exist before the query can report it');

    const reply = (await handoff.queryAttemptStart(request)) as { outcome: string; claim: { hasCommittedAttempt: boolean }; closureReceipt: { receiptId: string } };
    assert.equal(reply.outcome, 'unattempted', 'a fenced, closed, unattempted claim must be reported as such');
    assert.equal(reply.claim.hasCommittedAttempt, false);
    assert.equal(reply.closureReceipt.receiptId, closure.receiptId, 'the query must return the durable closure receipt');

    const newer = { ...request, executorIdentity: { ...requester, fencingGeneration: 2 } };
    assert.deepEqual(await handoff.queryAttemptStart(newer), { outcome: 'unknown' }, 'a fence at or below the requester generation proves no newer fencing');

    assert.deepEqual(await handoff.queryAttemptStart({ ...request, claim: { ...claim, taskId: 'other-task' } }), { outcome: 'unknown' }, 'a claim from another task must not be reported');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('durable recovery handoffs: attempt start reports a committed attempt', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-handoff-committed-'));
  try {
    const { port, claim } = await openClaim(baseDir);
    const attempt = await port.beginAttempt(claim.claimId, createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }));
    assert.notEqual(attempt.attemptId, '', 'the fixture must begin a real attempt');

    const reply = (await createDurableAttemptStartRecoveryHandoff(port).queryAttemptStart({
      recoveryId: 'attempt-start:committed',
      admission: context,
      claim,
      executorIdentity: createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }),
    })) as { outcome: string; attempt: { attemptId: string } };
    assert.equal(reply.outcome, 'committed', 'a begun attempt must be queryable after a presumed crash');
    assert.equal(reply.attempt.attemptId, attempt.attemptId, 'the reported attempt must be the durable one');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('durable recovery handoffs: patch reconciliation refuses by name', async () => {
  await assert.rejects(() => createRefusingPatchRecoveryHandoff().prepare({} as never), /PATCH_RECOVERY_UNSUPPORTED/, 'patch reconciliation must refuse rather than invent a receipt');
});
