/**
 * T054 / Issue #245: Task isolation in DurableStatePortV02 and StatePortStore.
 *
 * Verifies that:
 * 1. Multiple tasks sharing the same claim ID (e.g. `claim-check-reproduction`) in a single
 *    durable store operate independently when bound to their respective taskId.
 * 2. A settled claim on task A does not prevent task B from beginning and settling its own attempt.
 * 3. A task-bound port refuses a missing claim without falling through to a foreign task.
 * 4. An unbound store lookup fails closed (returns null / unknown) when claim ownership is ambiguous (>1 task),
 *    while preserving legacy single-task unambiguous resolution.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { type RepositoryAdmissionContextV02, type RunCommandAction, type TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { DurableStatePortV02, NEUTRAL_ATTEMPT_RECEIPT_V02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { StatePortStore } from '../../../src/persistence/adapters/state-port-v02-storage.ts';
import { createJournalOperationLookup, journalOperationRef } from '../../../src/persistence/adapters/state-port-v02-operation-lookup.ts';
import {
  createTestAction,
  createTestAdmissionTaskStateV02,
  createTestExecutorIdentityV02,
  createTestRepositoryCommandAdmissionContextV02,
  createTestRepositoryOutcomeReceiptV02,
} from '../support/uc03/state-fixtures.ts';

const SHARED_ACTION: RunCommandAction = createTestAction({
  actionId: 'check-reproduction',
  argv: ['-q', 'tests/test_calculator.py', '-k', 'test_divide_zero'],
  purpose: 'Reproduce calculator bug across tasks',
});

function seedTask(ctx: RepositoryAdmissionContextV02): TaskState {
  const task = createTestAdmissionTaskStateV02(ctx);
  return {
    ...task,
    budgetLedgers: [
      ...(task.budgetLedgers ?? []),
      {
        scope: 'task',
        kind: 'timeoutMs',
        limit: 60_000,
        consumed: 0,
        reservations: [],
        unit: 'count',
        configurationId: 'config-v1',
        version: 1,
      },
    ],
  };
}

test('two tasks sharing same claim ID: task-bound port settles both tasks independently', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-task-isolation-settle-'));
  try {
    const store = new DurableStore(baseDir);
    await store.init();

    const task1Id = 'task-uc03-calc-001';
    const task2Id = 'task-uc03-calc-002';

    const ctx1 = createTestRepositoryCommandAdmissionContextV02({
      taskId: task1Id,
      runId: 'run-001',
      workspaceId: 'workspace-001',
      action: SHARED_ACTION,
    });
    const ctx2 = createTestRepositoryCommandAdmissionContextV02({
      taskId: task2Id,
      runId: 'run-002',
      workspaceId: 'workspace-002',
      action: SHARED_ACTION,
    });

    // Ports bound to their respective taskId
    const port1 = new DurableStatePortV02({
      store,
      taskId: task1Id,
      initialControl: {
        controlVersion: ctx1.expectedControlVersion,
        epoch: ctx1.expectedEpoch,
        activeAuthorityRef: ctx1.policyAuthorityRef,
      },
    });

    const port2 = new DurableStatePortV02({
      store,
      taskId: task2Id,
      initialControl: {
        controlVersion: ctx2.expectedControlVersion,
        epoch: ctx2.expectedEpoch,
        activeAuthorityRef: ctx2.policyAuthorityRef,
      },
    });

    // Seed task 1 and task 2
    await port1.transition(seedTask(ctx1), 0);
    await port2.transition(seedTask(ctx2), 0);

    // 1. Task 1 opens claim, begins attempt, and settles outcome
    const claim1 = await port1.claim(ctx1);
    assert.equal(claim1.claimId, 'claim-check-reproduction');
    assert.equal(claim1.taskId, task1Id);

    const executor1 = createTestExecutorIdentityV02({ payloadDigest: ctx1.actionDigest });
    const attempt1 = await port1.beginAttempt(claim1.claimId, executor1);
    assert.notEqual(attempt1.attemptId, '', 'task 1 must begin attempt successfully');
    assert.equal(attempt1.taskId, task1Id);

    const outcome1 = createTestRepositoryOutcomeReceiptV02(claim1, attempt1, ctx1);
    const recorded1 = await port1.recordOutcome(outcome1);
    assert.deepEqual(recorded1, { outcome: 'settled', receiptId: outcome1.receiptId });

    // Verify task 1 claim state is settled
    const claimState1 = await port1.readClaimState(claim1.claimId);
    assert.ok(claimState1);
    assert.equal(claimState1.status, 'settled');
    assert.equal(claimState1.taskId, task1Id);

    // 2. Task 2 opens identical claimId ('claim-check-reproduction')
    const claim2 = await port2.claim(ctx2);
    assert.equal(claim2.claimId, 'claim-check-reproduction');
    assert.equal(claim2.taskId, task2Id);

    // 3. Task 2 begins attempt: must resolve within task 2, NOT select task 1's settled claim!
    const executor2 = createTestExecutorIdentityV02({ payloadDigest: ctx2.actionDigest });
    const attempt2 = await port2.beginAttempt(claim2.claimId, executor2);
    assert.notDeepEqual(attempt2, NEUTRAL_ATTEMPT_RECEIPT_V02, 'task 2 beginAttempt must not return neutral receipt');
    assert.notEqual(attempt2.attemptId, '', 'task 2 must begin attempt successfully');
    assert.equal(attempt2.taskId, task2Id, 'task 2 attempt must belong to task 2');

    // 4. Task 2 records outcome: settles cleanly on task 2
    const outcome2 = createTestRepositoryOutcomeReceiptV02(claim2, attempt2, ctx2);
    const recorded2 = await port2.recordOutcome(outcome2);
    assert.deepEqual(recorded2, { outcome: 'settled', receiptId: outcome2.receiptId });

    const claimState2 = await port2.readClaimState(claim2.claimId);
    assert.ok(claimState2);
    assert.equal(claimState2.status, 'settled');
    assert.equal(claimState2.taskId, task2Id);

    // Verify task 1 remains unchanged and isolated
    const claimState1After = await port1.readClaimState(claim1.claimId);
    assert.ok(claimState1After);
    assert.equal(claimState1After.status, 'settled');
    assert.equal(claimState1After.taskId, task1Id);
    assert.equal(claimState1After.attempt?.attemptId, attempt1.attemptId);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('task-bound port: missing bound claim never falls through to another task or mutates foreign task', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-task-isolation-nofallthrough-'));
  try {
    const store = new DurableStore(baseDir);
    await store.init();

    const task1Id = 'task-uc03-calc-001';
    const task2Id = 'task-uc03-calc-002';

    const ctx1 = createTestRepositoryCommandAdmissionContextV02({
      taskId: task1Id,
      action: SHARED_ACTION,
    });
    const ctx2 = createTestRepositoryCommandAdmissionContextV02({
      taskId: task2Id,
      action: createTestAction({
        actionId: 'check-different-action',
        argv: ['-q'],
        purpose: 'Different action',
      }),
    });

    const port1 = new DurableStatePortV02({
      store,
      taskId: task1Id,
      initialControl: {
        controlVersion: ctx1.expectedControlVersion,
        epoch: ctx1.expectedEpoch,
        activeAuthorityRef: ctx1.policyAuthorityRef,
      },
    });

    const port2 = new DurableStatePortV02({
      store,
      taskId: task2Id,
      initialControl: {
        controlVersion: ctx2.expectedControlVersion,
        epoch: ctx2.expectedEpoch,
        activeAuthorityRef: ctx2.policyAuthorityRef,
      },
    });

    await port1.transition(seedTask(ctx1), 0);
    await port2.transition(seedTask(ctx2), 0);

    // Open claim on task 1 only
    const claim1 = await port1.claim(ctx1);
    assert.equal(claim1.claimId, 'claim-check-reproduction');

    // Snapshot task 1 state before task 2 operations
    const task1Before = await port1.loadTask(task1Id);
    const claim1StateBefore = await port1.readClaimState('claim-check-reproduction');

    // Task 2 attempts to begin task 1's claim: must refuse without falling through
    const executor = createTestExecutorIdentityV02({ payloadDigest: ctx1.actionDigest });
    const foreignAttempt = await port2.beginAttempt('claim-check-reproduction', executor);
    assert.deepEqual(foreignAttempt, NEUTRAL_ATTEMPT_RECEIPT_V02, 'task 2 must return neutral attempt for missing bound claim');

    // Task 2 reads claim state for task 1's claim: must return null
    const foreignClaimState = await port2.readClaimState('claim-check-reproduction');
    assert.equal(foreignClaimState, null, 'task 2 readClaimState must return null for claim not in task 2');

    // Task 1 must remain completely unmutated
    const task1After = await port1.loadTask(task1Id);
    assert.deepEqual(task1After, task1Before, 'task 1 must not be mutated by foreign port operations');
    const claim1StateAfter = await port1.readClaimState('claim-check-reproduction');
    assert.deepEqual(claim1StateAfter, claim1StateBefore, 'task 1 claim state must remain unchanged');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('unbound store: ambiguous claim ownership fails closed, unambiguous legacy succeeds', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-task-isolation-unbound-'));
  try {
    const store = new DurableStore(baseDir);
    await store.init();

    const task1Id = 'task-uc03-calc-001';
    const task2Id = 'task-uc03-calc-002';
    const task3Id = 'task-uc03-calc-003';

    const ctx1 = createTestRepositoryCommandAdmissionContextV02({
      taskId: task1Id,
      action: SHARED_ACTION,
    });
    const ctx2 = createTestRepositoryCommandAdmissionContextV02({
      taskId: task2Id,
      action: SHARED_ACTION,
    });
    const ctx3Unique = createTestRepositoryCommandAdmissionContextV02({
      taskId: task3Id,
      action: createTestAction({
        actionId: 'check-unique-to-task3',
        argv: ['-q'],
        purpose: 'Unique action',
      }),
    });

    const port1 = new DurableStatePortV02({
      store,
      taskId: task1Id,
      initialControl: {
        controlVersion: ctx1.expectedControlVersion,
        epoch: ctx1.expectedEpoch,
        activeAuthorityRef: ctx1.policyAuthorityRef,
      },
    });

    const port2 = new DurableStatePortV02({
      store,
      taskId: task2Id,
      initialControl: {
        controlVersion: ctx2.expectedControlVersion,
        epoch: ctx2.expectedEpoch,
        activeAuthorityRef: ctx2.policyAuthorityRef,
      },
    });

    const port3 = new DurableStatePortV02({
      store,
      taskId: task3Id,
      initialControl: {
        controlVersion: ctx3Unique.expectedControlVersion,
        epoch: ctx3Unique.expectedEpoch,
        activeAuthorityRef: ctx3Unique.policyAuthorityRef,
      },
    });

    await port1.transition(seedTask(ctx1), 0);
    await port2.transition(seedTask(ctx2), 0);
    await port3.transition(seedTask(ctx3Unique), 0);

    // Open unique claim on task 3
    const uniqueClaim = await port3.claim(ctx3Unique);
    assert.equal(uniqueClaim.claimId, 'claim-check-unique-to-task3');

    // Open shared claim on task 1
    const sharedClaim1 = await port1.claim(ctx1);
    assert.equal(sharedClaim1.claimId, 'claim-check-reproduction');

    // Unbound store instance (no taskId)
    const unboundStore = new StatePortStore(store);

    // 1. Unambiguous legacy lookup: only task 3 has 'claim-check-unique-to-task3'
    const uniqueLocated = await unboundStore.findClaimTask('claim-check-unique-to-task3');
    assert.ok(uniqueLocated, 'unambiguous claim must resolve');
    assert.equal(uniqueLocated.taskId, task3Id);
    assert.equal(uniqueLocated.claim.receipt.claimId, 'claim-check-unique-to-task3');

    // At this point, only task 1 has 'claim-check-reproduction'
    const singleShared = await unboundStore.findClaimTask('claim-check-reproduction');
    assert.ok(singleShared, 'single-owner shared claim must resolve before second task claims it');
    assert.equal(singleShared.taskId, task1Id);

    // 2. Task 2 now claims the same claimId
    const sharedClaim2 = await port2.claim(ctx2);
    assert.equal(sharedClaim2.claimId, 'claim-check-reproduction');

    // 3. Ambiguous lookup fails closed: >1 task owns 'claim-check-reproduction'
    // On unpatched code, unboundStore.findClaimTask returns the first task (arbitrary match) instead of null!
    const ambiguousLocated = await unboundStore.findClaimTask('claim-check-reproduction');
    assert.equal(ambiguousLocated, null, 'unbound findClaimTask must return null when >1 task owns claim');

    // Operation lookup on ambiguous claim must return unknown
    const unboundPort = new DurableStatePortV02({
      store,
      initialControl: {
        controlVersion: ctx1.expectedControlVersion,
        epoch: ctx1.expectedEpoch,
        activeAuthorityRef: ctx1.policyAuthorityRef,
      },
    });
    const opLookup = createJournalOperationLookup(unboundPort);
    const opResult = await opLookup.lookupOperation(journalOperationRef('claim-check-reproduction'));
    assert.equal(opResult.outcome, 'unknown', 'operation lookup for ambiguous claim must return unknown');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('task-bound control and fence: fencing shared claim on task 1 does not affect task 2', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-task-isolation-fence-'));
  try {
    const store = new DurableStore(baseDir);
    await store.init();

    const task1Id = 'task-uc03-calc-001';
    const task2Id = 'task-uc03-calc-002';

    const ctx1 = createTestRepositoryCommandAdmissionContextV02({
      taskId: task1Id,
      action: SHARED_ACTION,
    });
    const ctx2 = createTestRepositoryCommandAdmissionContextV02({
      taskId: task2Id,
      action: SHARED_ACTION,
    });

    const port1 = new DurableStatePortV02({
      store,
      taskId: task1Id,
      initialControl: {
        controlVersion: ctx1.expectedControlVersion,
        epoch: ctx1.expectedEpoch,
        activeAuthorityRef: ctx1.policyAuthorityRef,
      },
    });

    const port2 = new DurableStatePortV02({
      store,
      taskId: task2Id,
      initialControl: {
        controlVersion: ctx2.expectedControlVersion,
        epoch: ctx2.expectedEpoch,
        activeAuthorityRef: ctx2.policyAuthorityRef,
      },
    });

    await port1.transition(seedTask(ctx1), 0);
    await port2.transition(seedTask(ctx2), 0);

    const claim1 = await port1.claim(ctx1);
    const claim2 = await port2.claim(ctx2);
    assert.equal(claim1.claimId, 'claim-check-reproduction');
    assert.equal(claim2.claimId, 'claim-check-reproduction');

    const executor = createTestExecutorIdentityV02({ payloadDigest: ctx1.actionDigest });

    // Pause task 1 only and fence claim recipient
    assert.equal(await port1.setTaskControl(task1Id, 'paused', 'pause-task1-event'), true);
    const fence1 = await port1.fenceClaimRecipient(claim1.claimId, executor);
    assert.ok(fence1, 'task 1 claim must be fenceable');
    assert.equal(fence1.taskId, task1Id);

    // Verify task 2 control is STILL runnable and activeClaimId is still intact
    const head2 = port2.readControlHead(task2Id);
    assert.ok(head2);
    assert.equal(head2.mode, 'runnable', 'task 2 must remain runnable');
    assert.equal(head2.holdRef, null, 'task 2 must have no hold');
    assert.equal(head2.activeClaimId, claim2.claimId);

    // Task 2 can begin its attempt unimpeded by task 1's fence
    const attempt2 = await port2.beginAttempt(claim2.claimId, executor);
    assert.notEqual(attempt2.attemptId, '', 'task 2 attempt must succeed despite task 1 fence');
    assert.equal(attempt2.taskId, task2Id);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
