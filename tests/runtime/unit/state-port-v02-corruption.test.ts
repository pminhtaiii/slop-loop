/**
 * Persisted UC-03 v0.2 records are validated on read. A structurally corrupt record must fail closed
 * with a named corruption error instead of being served as fact to the claim/attempt/outcome flow.
 *
 * Outcome, reconciliation and recovery records have no standalone canonical validator (the v0.2
 * validators that cover them require trusted attempt/claim context), and closure records have no
 * accessor, so those are not exercised here.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ClaimReceiptV02, RepositoryAdmissionContextV02, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { StatePortStore } from '../../../src/persistence/adapters/state-port-v02-storage.ts';
import { DEFAULT_CONTROL } from '../../../src/persistence/adapters/state-port-v02-types.ts';
import { createTestAdmissionTaskStateV02, createTestExecutorIdentityV02, createTestRepositoryCommandAdmissionContextV02 } from '../support/uc03/state-fixtures.ts';

const context: RepositoryAdmissionContextV02 = createTestRepositoryCommandAdmissionContextV02();
const taskId = context.taskId;

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
  const port = new DurableStatePortV02({
    store,
    initialControl: { controlVersion: context.expectedControlVersion, epoch: context.expectedEpoch, activeAuthorityRef: context.policyAuthorityRef },
  });
  await port.transition(seedTask(), 0);
  return port;
}

/** Opens a claimed task and hands the raw store to the body, which corrupts one record. */
async function withClaim(body: (state: StatePortStore, claim: ClaimReceiptV02) => Promise<void>): Promise<void> {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-corrupt-'));
  try {
    const port = await openPort(baseDir);
    const claim = await port.claim(context);
    assert.notEqual(claim.claimId, '', 'the fixture admission must open a claim');
    await body(new StatePortStore(port.store), claim);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

test('corrupt records: an invalid control head fails closed', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc03-corrupt-control-'));
  try {
    const store = new DurableStore(baseDir);
    await store.init();
    const state = new StatePortStore(store);
    await state.writeJson(state.statePath(taskId, 'control.json'), { ...DEFAULT_CONTROL, holdRef: 'hold-without-a-mode' });
    await assert.rejects(state.readControl(taskId, DEFAULT_CONTROL), /Corrupted UC-03 control record/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('corrupt records: a malformed task state fails closed', async () => {
  await withClaim(async state => {
    await state.writeJson(state.statePath(taskId, 'task.json'), { taskId, stateVersion: 'one' });
    await assert.rejects(state.readTask(taskId), /Corrupted UC-03 task state/);
  });
});

test('corrupt records: a claim whose receipt digest does not recompute fails closed', async () => {
  await withClaim(async (state, claim) => {
    const stored = await state.readClaim(taskId, claim.claimId);
    assert.ok(stored);
    await state.writeClaim(taskId, { ...stored, receipt: { ...stored.receipt, claimDigest: `sha256:${'0'.repeat(64)}` } });
    await assert.rejects(state.readClaim(taskId, claim.claimId), /Corrupted UC-03 claim record/);
  });
});

test('corrupt records: a claim carrying a malformed task snapshot fails closed', async () => {
  await withClaim(async (state, claim) => {
    const stored = await state.readClaim(taskId, claim.claimId);
    assert.ok(stored);
    await state.writeClaim(taskId, { ...stored, taskSnapshot: { taskId, stateVersion: 1 } as unknown as TaskState });
    await assert.rejects(state.readClaim(taskId, claim.claimId), /Corrupted UC-03 claim record/);
  });
});

test('corrupt records: a claim whose admission no longer validates against its trusted context fails closed', async () => {
  await withClaim(async (state, claim) => {
    const stored = await state.readClaim(taskId, claim.claimId);
    assert.ok(stored);
    await state.writeClaim(taskId, { ...stored, context: { ...stored.context, runId: 'run-other' } } as typeof stored);
    await assert.rejects(state.readClaim(taskId, claim.claimId), /Corrupted UC-03 claim record/);
  });
});

test('corrupt records: a claim with an unknown lifecycle status fails closed', async () => {
  await withClaim(async (state, claim) => {
    const stored = await state.readClaim(taskId, claim.claimId);
    assert.ok(stored);
    await state.writeClaim(taskId, { ...stored, status: 'zombie' } as unknown as typeof stored);
    await assert.rejects(state.readClaim(taskId, claim.claimId), /Corrupted UC-03 claim record/);
  });
});

test('corrupt records: an attempt whose control versions do not advance by one fails closed', async () => {
  await withClaim(async (state, claim) => {
    const port = new DurableStatePortV02({ store: state.store, initialControl: DEFAULT_CONTROL });
    const attempt = await port.beginAttempt(claim.claimId, createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }));
    assert.notEqual(attempt.attemptId, '', 'the fixture must begin an attempt');

    const stored = await state.readAttempt(taskId, attempt.attemptId);
    assert.ok(stored);
    await state.writeJson(state.statePath(taskId, `attempt-${attempt.attemptId}.json`), {
      ...stored,
      receipt: { ...stored.receipt, postBeginControlVersion: stored.receipt.postBeginControlVersion + 1 },
    });
    await assert.rejects(state.readAttempt(taskId, attempt.attemptId), /Corrupted UC-03 attempt record/);
  });
});

test('corrupt records: an attempt whose claim binding disagrees with its receipt fails closed', async () => {
  await withClaim(async (state, claim) => {
    const port = new DurableStatePortV02({ store: state.store, initialControl: DEFAULT_CONTROL });
    const attempt = await port.beginAttempt(claim.claimId, createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }));

    const stored = await state.readAttempt(taskId, attempt.attemptId);
    assert.ok(stored);
    await state.writeJson(state.statePath(taskId, `attempt-${attempt.attemptId}.json`), { ...stored, claimId: 'claim-other' });
    await assert.rejects(state.readAttempt(taskId, attempt.attemptId), /Corrupted UC-03 attempt record/);
  });
});

test('corrupt records: an attempt whose owning claim is missing fails closed', async () => {
  await withClaim(async (state, claim) => {
    const port = new DurableStatePortV02({ store: state.store, initialControl: DEFAULT_CONTROL });
    const attempt = await port.beginAttempt(claim.claimId, createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }));

    rmSync(state.store.getClaimPath(taskId, claim.claimId));
    await assert.rejects(state.readAttempt(taskId, attempt.attemptId), /Corrupted UC-03 attempt record/);
  });
});

test('corrupt records: a fence proof that no longer validates fails closed', async () => {
  await withClaim(async (state, claim) => {
    const port = new DurableStatePortV02({ store: state.store, initialControl: DEFAULT_CONTROL });
    assert.equal(await port.setTaskControl(taskId, 'paused', 'pause-corrupt-fence-001'), true);
    const fence = await port.fenceClaimRecipient(claim.claimId, createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }));
    assert.ok(fence, 'a paused, unattempted claim must be fenceable');

    await state.writeJson(state.statePath(taskId, `fence-${claim.claimId}.json`), { ...fence, fencingGeneration: 0 });
    await assert.rejects(state.readFence(taskId, claim.claimId), /Corrupted UC-03 fence record/);
  });
});

test('corrupt records: a fence proof naming another claim fails closed', async () => {
  await withClaim(async (state, claim) => {
    const port = new DurableStatePortV02({ store: state.store, initialControl: DEFAULT_CONTROL });
    assert.equal(await port.setTaskControl(taskId, 'paused', 'pause-corrupt-fence-002'), true);
    const fence = await port.fenceClaimRecipient(claim.claimId, createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }));
    assert.ok(fence);

    await state.writeJson(state.statePath(taskId, `fence-${claim.claimId}.json`), { ...fence, claimId: 'claim-other' });
    await assert.rejects(state.readFence(taskId, claim.claimId), /Corrupted UC-03 fence record/);
  });
});
