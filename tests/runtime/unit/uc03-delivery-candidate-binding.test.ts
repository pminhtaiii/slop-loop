/**
 * UC-03 delivery candidate binding regression tests (issue #221 item 1).
 * Verifies stageCompletionReceipt binds facts to expected Review head and candidate identity under task lock,
 * consumes facts only for that exact candidate, and leaves persisted state unchanged on refusal.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { computeCanonicalSha256, type BugTask, type TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { StatePortStore } from '../../../src/persistence/adapters/state-port-v02-storage.ts';
import { createTestBugTask, createTestTaskState } from '../support/uc03/state-fixtures.ts';

const TASK_ID = 'task-binding-001';
const RUN_ID = 'run-binding-001';
const REPO_DIGEST = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const DIFF_DIGEST = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const BASELINE_REF = 'baseline-001';
const REVIEW_ID = 'review-001';

function setupEnvironment() {
  const root = mkdtempSync(join(tmpdir(), 'delivery-binding-'));
  const store = new DurableStore(join(root, 'store'));
  const task: BugTask = createTestBugTask({
    taskId: TASK_ID,
    initialRevisionDigest: REPO_DIGEST,
    acceptanceCriteria: ['Pass test'],
    requiredChecks: [
      {
        checkId: 'check-1',
        executable: 'pytest',
        argv: ['-q'],
        purpose: 'reproduction',
      },
    ],
  });

  const reviewState: TaskState = createTestTaskState({
    taskId: TASK_ID,
    runId: RUN_ID,
    stateVersion: 10,
    node: 'Review',
    repositoryRevisionDigest: REPO_DIGEST,
    acceptanceCriteria: task.acceptanceCriteria,
    requiredCheckIds: ['check-1'],
    taskContext: task,
    evidenceRefs: [BASELINE_REF],
    reviewRefs: [REVIEW_ID],
    latestReviewRef: REVIEW_ID,
    plan: {
      planVersion: 1,
      diagnosis: 'Needs repair',
      suspectedCauseLocations: ['src/calculator.py'],
      scopedChanges: ['src/calculator.py'],
      strategy: 'fix',
      strategyDigest: computeCanonicalSha256('fix'),
      baselineRef: BASELINE_REF,
      checkSetDigest: computeCanonicalSha256(task.requiredChecks),
      evidenceRefs: [BASELINE_REF],
      decisionRef: 'dec-1',
    },
    budgetLedgers: [],
  });

  const deliverCandidate: TaskState = {
    ...reviewState,
    stateVersion: 11,
    node: 'Deliver',
    outcome: 'COMPLETED',
    nextAction: 'deliver-final-report',
  };

  const completionFacts = {
    completion: {
      taskId: TASK_ID,
      runId: RUN_ID,
      repositoryRevisionDigest: REPO_DIGEST,
      diffDigest: DIFF_DIGEST,
      checkSetDigest: computeCanonicalSha256(task.requiredChecks),
      baselineRef: BASELINE_REF,
      criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
      authorizedDiffDigest: DIFF_DIGEST,
      protectedTestsDigest: 'sha256:protected',
      originalProtectedTestsDigest: 'sha256:protected',
      checks: [
        {
          checkId: 'check-1',
          outcome: 'pass' as const,
          repositoryRevisionDigest: REPO_DIGEST,
          diffDigest: DIFF_DIGEST,
        },
      ],
      review: {
        reviewId: REVIEW_ID,
        status: 'accepted' as const,
        repositoryRevisionDigest: REPO_DIGEST,
        diffDigest: DIFF_DIGEST,
        checkSetDigest: computeCanonicalSha256(task.requiredChecks),
        roleConfigId: 'reviewer-v1',
      },
    },
  };

  return { root, store, task, reviewState, deliverCandidate, completionFacts };
}

test('Item 1: stageCompletionReceipt refuses under task lock when current stateVersion differs from expectedReviewHead', async () => {
  const { root, store, reviewState, deliverCandidate, completionFacts } = setupEnvironment();
  try {
    await store.init();
    const port = new DurableStatePortV02({
      store,
      taskId: TASK_ID,
      initialControl: { controlVersion: 1, epoch: 1, mode: 'runnable', activeAuthorityRef: null },
    });
    // Task is at stateVersion 10
    await new StatePortStore(store).writeTask(TASK_ID, reviewState);

    // Call stageCompletionReceipt expecting Review head 9 (mismatch with 10)
    const staged = await port.stageCompletionReceipt(completionFacts, {
      expectedReviewHead: 9,
      candidateDigest: computeCanonicalSha256(deliverCandidate),
    });

    assert.equal(staged, false, 'Staging must return false when expected Review head mismatches current task version');

    // Persisted state must remain unchanged at stateVersion 10
    const loaded = await port.loadTask(TASK_ID);
    assert.equal(loaded?.stateVersion, 10);
    assert.equal(loaded?.node, 'Review');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Item 1: delivery candidate digest mismatch refuses commit and leaves persisted state unchanged', async () => {
  const { root, store, reviewState, deliverCandidate, completionFacts } = setupEnvironment();
  try {
    await store.init();
    const port = new DurableStatePortV02({
      store,
      taskId: TASK_ID,
      initialControl: { controlVersion: 1, epoch: 1, mode: 'runnable', activeAuthorityRef: null },
    });
    await new StatePortStore(store).writeTask(TASK_ID, reviewState);

    // Stage facts specifically for deliverCandidate
    const staged = await port.stageCompletionReceipt(completionFacts, {
      expectedReviewHead: 10,
      candidateDigest: computeCanonicalSha256(deliverCandidate),
    });
    assert.equal(staged, true);

    // Create a different candidate targeting version 11 (e.g. Repair or different nextAction)
    const differentCandidate: TaskState = {
      ...reviewState,
      stateVersion: 11,
      node: 'Repair',
      nextAction: 'other-action',
    };

    // Transition with different candidate must throw and refuse
    await assert.rejects(
      async () => {
        await port.transition(differentCandidate, 10);
      },
      /delivery candidate digest mismatch/,
      'Commit must reject candidate identity mismatch',
    );

    // Persisted task state remains unchanged at version 10 in Review node
    const loaded = await port.loadTask(TASK_ID);
    assert.equal(loaded?.stateVersion, 10);
    assert.equal(loaded?.node, 'Review');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Item 1: matching Review->Deliver transition commits and consumes facts leaving no entry behind', async () => {
  const { root, store, reviewState, deliverCandidate, completionFacts } = setupEnvironment();
  try {
    await store.init();
    const port = new DurableStatePortV02({
      store,
      taskId: TASK_ID,
      initialControl: { controlVersion: 1, epoch: 1, mode: 'runnable', activeAuthorityRef: null },
    });
    await new StatePortStore(store).writeTask(TASK_ID, reviewState);

    const staged = await port.stageCompletionReceipt(completionFacts, {
      expectedReviewHead: 10,
      candidateDigest: computeCanonicalSha256(deliverCandidate),
    });
    assert.equal(staged, true);

    // Matching candidate commits cleanly
    const committed = await port.transition(deliverCandidate, 10);
    assert.equal(committed.stateVersion, 11);
    assert.equal(committed.node, 'Deliver');
    assert.equal(committed.outcome, 'COMPLETED');

    // Facts are consumed; no entry remains in trustedTransitions
    const internalTransitions = (port as unknown as { taskOptions: { trustedTransitions: Record<number, unknown> } }).taskOptions.trustedTransitions;
    assert.equal(internalTransitions[11], undefined, 'Staged entry must be consumed on commit');

    // Staged binding metadata is also cleaned up
    const internalBindings = (port as unknown as { taskOptions: { stagedBindings?: Record<number, unknown> } }).taskOptions.stagedBindings;
    assert.equal(internalBindings?.[11], undefined, 'Staged binding metadata must be consumed on commit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Item 1: caller-supplied trustedTransitions prototype table is preserved and not mutated by staged consumption', async () => {
  const { root, store, reviewState, deliverCandidate, completionFacts } = setupEnvironment();
  try {
    await store.init();
    const callerTransitions: Record<number, unknown> = {
      99: { replanReservation: undefined },
    };
    const port = new DurableStatePortV02({
      store,
      taskId: TASK_ID,
      initialControl: { controlVersion: 1, epoch: 1, mode: 'runnable', activeAuthorityRef: null },
      trustedTransitions: callerTransitions as never,
    });
    await new StatePortStore(store).writeTask(TASK_ID, reviewState);

    const staged = await port.stageCompletionReceipt(completionFacts, {
      expectedReviewHead: 10,
      candidateDigest: computeCanonicalSha256(deliverCandidate),
    });
    assert.equal(staged, true);

    await port.transition(deliverCandidate, 10);

    // Prototype entry 99 must remain on callerTransitions
    assert.notEqual(callerTransitions[99], undefined, 'Caller trustedTransitions must retain its entries');
    const internal = (port as unknown as { taskOptions: { trustedTransitions: Record<number, unknown> } }).taskOptions.trustedTransitions;
    assert.notEqual(internal[99], undefined, 'Port trustedTransitions prototype lookup must still find caller entries');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
