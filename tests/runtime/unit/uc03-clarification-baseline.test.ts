import assert from 'node:assert/strict';
import test from 'node:test';

import { computeCanonicalSha256, computeCheckSetDigest, type BugTask, type TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { computeTestProtectionDigest } from '../../../src/uc03/investigation.ts';
import type { BaselineEvidenceCandidate, TrustedHostExpectedContext, TrustedHostPort, TrustedHostSnapshot, TrustedTestFileSnapshot } from '../../../src/uc03/investigation-types.ts';
import { resolveExpectedTestFiles } from '../../../src/uc03/graph-validation.ts';
import { retainClarificationBaseline, reuseClarificationBaseline } from '../../../src/uc03/graph-investigation-baseline.ts';
import { prepareControlledUC03Host } from '../../../src/runtime/uc03-host-bootstrap.ts';
import { runControlledUC03GraphV02 } from '../../../src/uc03/graph-v02.ts';
import { askClarification, recordClarificationAnswer } from '../../../src/uc03/clarification.ts';
import { createFixtureBugTask, createFixtureTaskState } from '../support/uc03/port-fixtures.ts';
import { controlledGeneratedPlanFixture } from '../support/uc03/controlled-host-journey.ts';

const TEST_FILES: readonly TrustedTestFileSnapshot[] = [{ path: 'tests/test_calculator.py', content: 'def test_calc(): pass\n' }];

function runBinding(runId: string, reproductionFailureSignature: string) {
  const task: BugTask = createFixtureBugTask();
  const state: TaskState = createFixtureTaskState({ runId });
  const expectedTestFiles = resolveExpectedTestFiles(task);
  const candidate: BaselineEvidenceCandidate = {
    taskId: task.taskId,
    workspaceId: state.workspaceId,
    repositoryId: task.repositoryId,
    repositorySnapshotDigest: task.initialRevisionDigest,
    acceptanceCriteria: task.acceptanceCriteria,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    requiredChecks: task.requiredChecks,
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    reproductionCheckId: task.requiredChecks[0]?.checkId ?? '',
    expectedPassingCheckIds: [],
    expectedTestFiles,
    testProtectionDigest: computeTestProtectionDigest(TEST_FILES),
    reproductionFailureSignature,
    checkResults: task.requiredChecks.map(check => ({ checkId: check.checkId, outcome: 'fail' as const })),
  };
  const expectedContext: TrustedHostExpectedContext = {
    taskId: task.taskId,
    workspaceId: state.workspaceId,
    repositoryId: task.repositoryId,
    revisionDigest: task.initialRevisionDigest,
    criteriaDigest: candidate.criteriaDigest,
    checkSetDigest: candidate.checkSetDigest,
    expectedTestFiles,
  };
  const hostAuthority: TrustedHostPort = {
    loadSnapshot: async (): Promise<TrustedHostSnapshot> => ({
      taskId: expectedContext.taskId,
      workspaceId: expectedContext.workspaceId,
      repositoryId: expectedContext.repositoryId,
      currentRevision: expectedContext.revisionDigest,
      checkSetDigest: expectedContext.checkSetDigest,
      expectedTestFiles,
      testFiles: TEST_FILES,
    }),
  };
  const reuse = (generation: object | undefined) =>
    reuseClarificationBaseline({
      generation,
      task,
      state,
      statePort: { loadTask: async () => state },
      hostAuthority,
      expectedContext,
    });
  return { task, state, candidate, reuse };
}

test('one generation retains and reuses a separate baseline for each task/run binding', async () => {
  const generation = {};
  const runOne = runBinding('run-001', 'controlled failure one');
  const runTwo = runBinding('run-002', 'controlled failure two');
  const runThree = runBinding('run-003', 'controlled failure three');

  assert.equal(retainClarificationBaseline(generation, runOne.task, runOne.state, runOne.candidate), true);
  assert.equal((await runTwo.reuse(generation)).ok, false, 'an unretained binding must not reuse another run baseline');
  assert.equal(retainClarificationBaseline(generation, runTwo.task, runTwo.state, runTwo.candidate), true, 'a second valid run must retain its own baseline in the shared generation');
  assert.equal((await runThree.reuse(generation)).ok, false, 'a third unretained binding stays refused');

  const reusedOne = await runOne.reuse(generation);
  const reusedTwo = await runTwo.reuse(generation);
  assert.equal(reusedOne.ok && reusedOne.baseline.reproductionFailureSignature, 'controlled failure one');
  assert.equal(reusedTwo.ok && reusedTwo.baseline.reproductionFailureSignature, 'controlled failure two');
});

test('the direct controlled resume retains its reproduced baseline so a later round pauses', async () => {
  // The scripted first response is a second, distinct ask: the resumed turn spends it after the
  // fallback reproduces the baseline, so the round-2 ask must find retained evidence.
  const fixture = await controlledGeneratedPlanFixture({
    firstResponse: {
      proposalId: 'fallback-ask-2',
      content: JSON.stringify({
        kind: 'request-info',
        proposalId: 'fallback-ask-2',
        questions: [{ questionId: 'q-guard', text: 'Which error type should an unguarded denominator raise?' }],
        evidenceRefs: [],
      }),
    },
  });
  const readiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;
  const seeded = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.ok(seeded);
  const open = await askClarification({
    statePort: fixture.statePort,
    prior: seeded,
    proposal: { kind: 'request-info', proposalId: 'fallback-ask-1', questions: [{ questionId: 'q-denominator', text: 'What should a zero denominator do?' }], evidenceRefs: [] },
  });
  assert.ok(open.state.clarification);
  const answered = await recordClarificationAnswer({
    statePort: fixture.statePort,
    prior: open.state,
    answer: { recorderRef: 'reporter-1', items: open.state.clarification.questions.map(question => ({ questionId: question.questionId, text: 'raise a guarded error' })) },
  });
  assert.equal(answered.state.node, 'Investigate');

  const resumed = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  assert.equal(resumed.outcome, 'needs-info', JSON.stringify(resumed.reasons));
  const state = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.equal(state?.node, 'NeedsInfo');
  assert.equal(state?.clarification?.round, 2);
  assert.equal(state?.clarification?.answer, undefined);
});
