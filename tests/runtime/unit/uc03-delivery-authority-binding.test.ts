/**
 * UC-03 delivery authority binding regression tests (issue #221 item 2).
 * Verifies Review->Deliver commit is bound to the authority that accepted the review,
 * recording control version and decision-authority generation, refusing commit if
 * owner control head or authority generation differs at commit time, leaving persisted
 * state unchanged.
 */
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
import { resolveReviewDeliveryBinding } from '../../../src/uc03/graph-review-authority.ts';
import { createTestBugTask, createTestTaskState } from '../support/uc03/state-fixtures.ts';

const TASK_ID = 'task-auth-001';
const RUN_ID = 'run-auth-001';
const REPO_DIGEST = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const DIFF_DIGEST = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const BASELINE_REF = 'baseline-001';
const REVIEW_ID = 'review-001';

const INITIAL_AUTHORITY: PolicyAuthorityRefV02 = {
  policyId: 'policy-test',
  policyVersion: '1.0.0',
  configId: 'config-test',
  configVersion: '1.0.0',
  issuerKeyRef: 'key-test',
  decisionAuthorityGeneration: 1,
};

function setupEnvironment() {
  const root = mkdtempSync(join(tmpdir(), 'delivery-auth-'));
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

test('Item 2: Review->Deliver commit refuses if authority generation changed between staging and commit', async () => {
  const { root, store, reviewState, deliverCandidate, completionFacts } = setupEnvironment();
  try {
    await store.init();
    const port = new DurableStatePortV02({
      store,
      taskId: TASK_ID,
      initialControl: { controlVersion: 1, epoch: 1, mode: 'runnable', activeAuthorityRef: INITIAL_AUTHORITY },
    });
    await new StatePortStore(store).writeTask(TASK_ID, reviewState);

    // Stage completion facts recording authority generation 1
    const staged = await port.stageCompletionReceipt(completionFacts, {
      expectedReviewHead: 10,
      candidateDigest: computeCanonicalSha256(deliverCandidate),
      controlVersion: 1,
      decisionAuthorityGeneration: 1,
    });
    assert.equal(staged, true);

    // Publish new authority before commit, advancing generation to 2 and controlVersion to 2
    const storage = new StatePortStore(store);
    await storage.writeControl(TASK_ID, {
      ...DEFAULT_CONTROL,
      controlVersion: 2,
      epoch: 1,
      mode: 'runnable',
      activeAuthorityRef: { ...INITIAL_AUTHORITY, decisionAuthorityGeneration: 2 },
    });

    // Deliver transition must refuse at commit time
    await assert.rejects(
      async () => {
        await port.transition(deliverCandidate, 10);
      },
      /Delivery commit refused: .* mismatch/,
      'Commit must be refused when authority generation or control head changed',
    );

    // Persisted task state remains unchanged at version 10 in Review node
    const loaded = await port.loadTask(TASK_ID);
    assert.equal(loaded?.stateVersion, 10);
    assert.equal(loaded?.node, 'Review');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Item 2: Review->Deliver commit refuses if control version changed between staging and commit', async () => {
  const { root, store, reviewState, deliverCandidate, completionFacts } = setupEnvironment();
  try {
    await store.init();
    const port = new DurableStatePortV02({
      store,
      taskId: TASK_ID,
      initialControl: { controlVersion: 1, epoch: 1, mode: 'runnable', activeAuthorityRef: INITIAL_AUTHORITY },
    });
    await new StatePortStore(store).writeTask(TASK_ID, reviewState);

    // Stage completion facts recording controlVersion 1
    const staged = await port.stageCompletionReceipt(completionFacts, {
      expectedReviewHead: 10,
      candidateDigest: computeCanonicalSha256(deliverCandidate),
      controlVersion: 1,
      decisionAuthorityGeneration: 1,
    });
    assert.equal(staged, true);

    // Control version bumps to 2 without changing generation
    const storage = new StatePortStore(store);
    await storage.writeControl(TASK_ID, {
      ...DEFAULT_CONTROL,
      controlVersion: 2,
      epoch: 1,
      mode: 'runnable',
      activeAuthorityRef: INITIAL_AUTHORITY,
    });

    await assert.rejects(
      async () => {
        await port.transition(deliverCandidate, 10);
      },
      /Delivery commit refused: control head version mismatch/,
      'Commit must be refused when control version changed',
    );

    // Persisted state remains unchanged
    const loaded = await port.loadTask(TASK_ID);
    assert.equal(loaded?.stateVersion, 10);
    assert.equal(loaded?.node, 'Review');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Item 2: fixture path with trusted.completion refuses commit when authority is superseded', async () => {
  const { root, store, reviewState, deliverCandidate, completionFacts } = setupEnvironment();
  try {
    await store.init();
    const fixtureFacts = {
      completion: {
        ...completionFacts.completion,
        controlVersion: 1,
        decisionAuthorityGeneration: 1,
      },
    };
    const trustedTransitions = {
      11: fixtureFacts,
    };
    const port = new DurableStatePortV02({
      store,
      taskId: TASK_ID,
      initialControl: { controlVersion: 1, epoch: 1, mode: 'runnable', activeAuthorityRef: INITIAL_AUTHORITY },
      trustedTransitions: trustedTransitions as never,
    });
    await new StatePortStore(store).writeTask(TASK_ID, reviewState);

    // Authority is superseded to generation 2
    const storage = new StatePortStore(store);
    await storage.writeControl(TASK_ID, {
      ...DEFAULT_CONTROL,
      controlVersion: 2,
      epoch: 1,
      mode: 'runnable',
      activeAuthorityRef: { ...INITIAL_AUTHORITY, decisionAuthorityGeneration: 2 },
    });

    await assert.rejects(
      async () => {
        await port.transition(deliverCandidate, 10);
      },
      /Delivery commit refused: .* mismatch/,
      'Fixture path must also refuse commit when authority is superseded',
    );

    const loaded = await port.loadTask(TASK_ID);
    assert.equal(loaded?.stateVersion, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Item 2: matching authority generation and control version commits successfully', async () => {
  const { root, store, reviewState, deliverCandidate, completionFacts } = setupEnvironment();
  try {
    await store.init();
    const port = new DurableStatePortV02({
      store,
      taskId: TASK_ID,
      initialControl: { controlVersion: 1, epoch: 1, mode: 'runnable', activeAuthorityRef: INITIAL_AUTHORITY },
    });
    await new StatePortStore(store).writeTask(TASK_ID, reviewState);

    const staged = await port.stageCompletionReceipt(completionFacts, {
      expectedReviewHead: 10,
      candidateDigest: computeCanonicalSha256(deliverCandidate),
      controlVersion: 1,
      decisionAuthorityGeneration: 1,
    });
    assert.equal(staged, true);

    const committed = await port.transition(deliverCandidate, 10);
    assert.equal(committed.stateVersion, 11);
    assert.equal(committed.node, 'Deliver');
    assert.equal(committed.outcome, 'COMPLETED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Item 2: resolveReviewDeliveryBinding resolves authority from port and observation', () => {
  const { reviewState, deliverCandidate } = setupEnvironment();
  const mockPort = {
    readControlHead: () => ({
      controlVersion: 3,
      epoch: 1,
      mode: 'runnable' as const,
      holdRef: null,
      activeClaimId: null,
      outstandingClaimRefs: [],
      activeAuthorityRef: { ...INITIAL_AUTHORITY, decisionAuthorityGeneration: 4 },
    }),
  };

  const bindingWithoutObs = resolveReviewDeliveryBinding(mockPort, TASK_ID, undefined, deliverCandidate, reviewState.stateVersion);
  assert.equal(bindingWithoutObs.expectedReviewHead, 10);
  assert.equal(bindingWithoutObs.candidateDigest, computeCanonicalSha256(deliverCandidate));
  assert.equal(bindingWithoutObs.controlVersion, 3);
  assert.equal(bindingWithoutObs.decisionAuthorityGeneration, 4);

  const mockObservation = {
    authority: {
      taskStateVersion: 10,
      controlVersion: 5,
      epoch: 1,
      decisionAuthorityGeneration: 6,
      planDecisionRef: 'dec-1',
      planBindingDigest: 'sha256:plan',
    },
  };
  const bindingWithObs = resolveReviewDeliveryBinding(mockPort, TASK_ID, mockObservation as never, deliverCandidate, reviewState.stateVersion);
  assert.equal(bindingWithObs.controlVersion, 5);
  assert.equal(bindingWithObs.decisionAuthorityGeneration, 6);
});
