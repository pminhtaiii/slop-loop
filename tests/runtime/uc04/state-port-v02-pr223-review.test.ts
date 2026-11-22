import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { computeCanonicalSha256, type BugTask, type PolicyAuthorityRefV02, type TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { StatePortStore } from '../../../src/persistence/adapters/state-port-v02-storage.ts';
import { DEFAULT_CONTROL } from '../../../src/persistence/adapters/state-port-v02-types.ts';
import { createTestBugTask, createTestTaskState } from '../support/uc03/state-fixtures.ts';

const TASK_ID = 'task-223-01';
const RUN_ID = 'run-223-01';
const REPO_ID = 'project.invalid';
const REPO_DIGEST = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const DIFF_DIGEST = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const BASELINE_REF = 'baseline-223-01';
const REVIEW_ID = 'review-223-01';

const INITIAL_POLICY: PolicyAuthorityRefV02 = {
  policyId: 'policy-test',
  policyVersion: '1.0.0',
  configId: 'config-test',
  configVersion: '1.0.0',
  issuerKeyRef: 'signer-ref-01',
  decisionAuthorityGeneration: 1,
};

function setupEnvironment() {
  const root = mkdtempSync(join(tmpdir(), 'delivery-pr223-'));
  const store = new DurableStore(join(root, 'store'));
  const task: BugTask = createTestBugTask({
    taskId: TASK_ID,
    repositoryId: REPO_ID,
    initialRevisionDigest: REPO_DIGEST,
    goal: 'Repair computation',
    observedBehavior: 'Zero division failure',
    expectedBehavior: 'Handled gracefully',
    reproduction: 'test-runner -q',
    acceptanceCriteria: ['Pass test'],
    constraints: ['Maintain single thread'],
    requiredChecks: [
      {
        checkId: 'check-1',
        executable: 'test-runner',
        argv: ['-q'],
        purpose: 'reproduction',
      },
    ],
  });

  const reviewState: TaskState = createTestTaskState({
    taskId: TASK_ID,
    runId: RUN_ID,
    repositoryId: REPO_ID,
    goal: task.goal,
    observedBehavior: task.observedBehavior,
    expectedBehavior: task.expectedBehavior,
    reproduction: task.reproduction,
    acceptanceCriteria: task.acceptanceCriteria,
    constraints: task.constraints,
    stateVersion: 10,
    node: 'Review',
    repositoryRevisionDigest: REPO_DIGEST,
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
      decisionRef: 'dec-pr223-1',
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

test('PR223 A: writeTask rejection during Review->Deliver leaves staged facts intact for retry', async () => {
  const { root, store, reviewState, deliverCandidate, completionFacts } = setupEnvironment();
  try {
    await store.init();
    const port = new DurableStatePortV02({
      store,
      taskId: TASK_ID,
      initialControl: { controlVersion: 1, epoch: 1, mode: 'runnable', activeAuthorityRef: INITIAL_POLICY },
    });
    const statePortStore = new StatePortStore(store);
    await statePortStore.writeTask(TASK_ID, reviewState);

    const staged = await port.stageCompletionReceipt(completionFacts, {
      expectedReviewHead: 10,
      candidateDigest: computeCanonicalSha256(deliverCandidate),
      controlVersion: 1,
      decisionAuthorityGeneration: 1,
    });
    assert.equal(staged, true);

    const targetStore = (port as unknown as { statePort: StatePortStore }).statePort;
    const origWriteTask = targetStore.writeTask.bind(targetStore);
    let failOnce = true;
    const writeErr = new Error('SIMULATED_WRITE_FAILURE');

    targetStore.writeTask = async (taskId, task) => {
      if (task.node === 'Deliver' && failOnce) {
        failOnce = false;
        throw writeErr;
      }
      return origWriteTask(taskId, task);
    };

    // First transition attempt fails on writeTask
    await assert.rejects(
      async () => {
        await port.transition(deliverCandidate, 10);
      },
      (err: unknown) => err === writeErr,
    );

    // Persisted task state is still version 10 in Review node
    const uncommitted = await port.loadTask(TASK_ID);
    assert.equal(uncommitted?.stateVersion, 10);
    assert.equal(uncommitted?.node, 'Review');

    // Immediate retry with no restaging must succeed
    const committed = await port.transition(deliverCandidate, 10);
    assert.equal(committed.stateVersion, 11);
    assert.equal(committed.node, 'Deliver');

    // Persisted task state is now version 11 in Deliver node
    const loaded = await port.loadTask(TASK_ID);
    assert.equal(loaded?.stateVersion, 11);
    assert.equal(loaded?.node, 'Deliver');

    // Once successfully committed, staged facts are consumed
    await assert.rejects(async () => {
      await port.transition({ ...deliverCandidate, stateVersion: 12 }, 11);
    }, /State transition validation failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PR223 B1: omitting controlVersion stages seed version and detects control head version mismatch', async () => {
  const { root, store, reviewState, deliverCandidate, completionFacts } = setupEnvironment();
  try {
    await store.init();
    const port = new DurableStatePortV02({
      store,
      taskId: TASK_ID,
      initialControl: { controlVersion: 1, epoch: 1, mode: 'runnable', activeAuthorityRef: INITIAL_POLICY },
    });
    const statePortStore = new StatePortStore(store);
    await statePortStore.writeTask(TASK_ID, reviewState);

    // Stage completion facts omitting controlVersion in binding
    const staged = await port.stageCompletionReceipt(completionFacts, {
      expectedReviewHead: 10,
      candidateDigest: computeCanonicalSha256(deliverCandidate),
    });
    assert.equal(staged, true);

    // A control write happens between staging and commit, advancing control version to 2
    await statePortStore.writeControl(TASK_ID, {
      ...DEFAULT_CONTROL,
      controlVersion: 2,
      epoch: 1,
      mode: 'runnable',
      activeAuthorityRef: INITIAL_POLICY,
    });

    // Commit must refuse with control head version mismatch
    await assert.rejects(async () => {
      await port.transition(deliverCandidate, 10);
    }, /Delivery commit refused: control head version mismatch/);

    // Persisted task state remains unchanged at version 10 in Review node
    const loaded = await port.loadTask(TASK_ID);
    assert.equal(loaded?.stateVersion, 10);
    assert.equal(loaded?.node, 'Review');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PR223 B2: matching controlVersion stages and commits successfully', async () => {
  const { root, store, reviewState, deliverCandidate, completionFacts } = setupEnvironment();
  try {
    await store.init();
    const port = new DurableStatePortV02({
      store,
      taskId: TASK_ID,
      initialControl: { controlVersion: 1, epoch: 1, mode: 'runnable', activeAuthorityRef: INITIAL_POLICY },
    });
    const statePortStore = new StatePortStore(store);
    await statePortStore.writeTask(TASK_ID, reviewState);

    // Stage with binding carrying matching controlVersion 1
    const staged = await port.stageCompletionReceipt(completionFacts, {
      expectedReviewHead: 10,
      candidateDigest: computeCanonicalSha256(deliverCandidate),
      controlVersion: 1,
      decisionAuthorityGeneration: 1,
    });
    assert.equal(staged, true);

    // Commit succeeds
    const committed = await port.transition(deliverCandidate, 10);
    assert.equal(committed.stateVersion, 11);
    assert.equal(committed.node, 'Deliver');

    // Persisted state updated
    const loaded = await port.loadTask(TASK_ID);
    assert.equal(loaded?.stateVersion, 11);
    assert.equal(loaded?.node, 'Deliver');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
