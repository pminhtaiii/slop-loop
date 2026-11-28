import assert from 'node:assert/strict';
import test from 'node:test';
import { createSnapshotGrader, type SnapshotCriterion, type SnapshotCriteria, type SnapshotEvidence } from '../../../eval/uc03/workflow-grade.ts';
import { createHostIsolationAuthority } from '../../../src/runtime/real-tier-grader.ts';
import { clarificationWasAnswered } from '../../../eval/uc03/workflow-answered-facts.ts';
import { createFixtureTaskState } from '../support/uc03/port-fixtures.ts';
import { computeClarificationQuestionId, computeClarificationQuestionDigest, computeClarificationAnswerDigest } from '../../../src/contracts/foundation/uc03.ts';
import type {
  EvaluationGradingAdmissionRequest,
  EvaluationGraderExecutionRequest,
  EvaluationGraderExecutor,
  EvaluationGradingProfile,
  EvaluationIsolationAuthority,
  EvaluationSnapshotIdentity,
  WorkflowObservation,
} from '../../../eval/uc03/types.ts';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;
const GRADER_PAYLOAD = 'PRIVATE_HIDDEN_TEST_BODY_MARKER';

const SNAPSHOT: EvaluationSnapshotIdentity = { snapshotId: 'snap-1', digest: OTHER_DIGEST };
const PROFILE: EvaluationGradingProfile = {
  profileId: 'profile-1',
  digest: DIGEST,
  bounds: { timeoutMs: 10_000, maxCpuMs: 5_000, maxOutputBytes: 65_536, maxMemoryBytes: 536_870_912, maxProcesses: 8 },
};

function observation(overrides: Partial<WorkflowObservation> = {}): WorkflowObservation {
  return {
    repositoryId: 'repo-1',
    taskId: 'task-1',
    runId: 'run-1',
    returnedModel: 'model-1',
    graderDigest: DIGEST,
    initialRepositoryDigest: DIGEST,
    workflowOutcome: 'COMPLETED',
    expectedWait: null,
    blocked: null,
    effects: 'none',
    usage: 'observed',
    diagnostic: null,
    artifacts: [],
    limitations: [],
    ...overrides,
  };
}

function evidence(overrides: Partial<SnapshotEvidence> = {}): SnapshotEvidence {
  return {
    digest: `sha256:${'c'.repeat(64)}`,
    snapshotDigest: SNAPSHOT.digest,
    diffDigest: `sha256:${'d'.repeat(64)}`,
    baselineFailed: true,
    requiredChecksPassed: true,
    focusedCheckPassed: true,
    testsProtected: true,
    reviewAccepted: true,
    reviewedDiffDigest: `sha256:${'d'.repeat(64)}`,
    sentinelsUnchanged: true,
    speculativePatchApplied: false,
    stoppedBeforeEffect: true,
    completionWithheld: true,
    ...overrides,
  };
}

function criterion(caseId: SnapshotCriterion['caseId'], predicate: SnapshotCriterion['predicate'], hiddenCheckId: string | null = null): SnapshotCriterion {
  return { criterionId: `crit-${caseId.toLowerCase()}`, caseId, predicate, hiddenCheckId };
}

function criteria(entries: readonly SnapshotCriterion[]): SnapshotCriteria {
  return { digest: DIGEST, criteria: entries };
}

function authority(
  admit: EvaluationIsolationAuthority['admit'] = (request: EvaluationGradingAdmissionRequest) => ({ kind: 'injected-mock-isolation-admission', admissionId: 'admission-1', ...request }),
): EvaluationIsolationAuthority {
  return { admit };
}

const PASSING_EXECUTOR: EvaluationGraderExecutor = {
  executorId: 'executor-1',
  execute: (request: EvaluationGraderExecutionRequest) => ({
    finalSnapshot: request.finalSnapshot,
    profile: request.profile,
    executorId: request.executorId,
    status: 'pass',
    actualOutcome: 'COMPLETED',
    durationMs: 10,
    cpuMs: 5,
    outputBytes: 32,
  }),
};

function grader(overrides: { criteria?: SnapshotCriteria; isolationAuthority?: EvaluationIsolationAuthority; executor?: EvaluationGraderExecutor } = {}) {
  return createSnapshotGrader(
    {
      criteria:
        overrides.criteria ??
        criteria([
          criterion('C01', 'repair-success', 'hidden-c01'),
          criterion('C02', 'clarification', 'hidden-c02'),
          criterion('C04', 'exhaustion'),
          criterion('C07', 'expected-refusal'),
          criterion('C05', 'regression'),
        ]),
      profile: PROFILE,
      isolationAuthority: overrides.isolationAuthority ?? authority(),
      executor: overrides.executor ?? PASSING_EXECUTOR,
      graderPayload: GRADER_PAYLOAD,
    },
    'controlled-tier',
  );
}

test('C02 stop paths retain their verdicts and never execute a hidden check', async () => {
  const g = grader({
    executor: {
      executorId: 'unused',
      execute() {
        assert.fail('stop path executed hidden check');
      },
    },
  });
  for (const workflowOutcome of ['waiting-info', 'INCOMPLETE'] as const) {
    const result = await g.grade('C02', {
      observation: observation({ workflowOutcome, expectedWait: workflowOutcome === 'waiting-info' ? 'waiting-info' : null }),
      snapshot: SNAPSHOT,
      evidence: evidence(),
    });
    assert.equal(result.grade, 'pass');
    assert.ok(result.evidenceIds.includes('path:clarification-stop'));
    assert.ok(!result.evidenceIds.includes('check:hidden-c02'));
  }
  for (const workflowOutcome of ['COMPLETED', 'INCOMPLETE'] as const) {
    const result = await g.grade('C02', { observation: observation({ workflowOutcome }), snapshot: SNAPSHOT, evidence: evidence({ speculativePatchApplied: true }) });
    assert.equal(result.grade, 'fail');
    assert.ok(result.evidenceIds.includes('check:no-speculative-patch'));
  }
});

test('answered C02 requires admitted bound hidden success and preserves the real route label', async () => {
  for (const mode of ['pass', 'fail', 'unbound', 'wrong-snapshot', 'denied', 'incomplete', 'missing-check', 'failed-required'] as const) {
    let calls = 0;
    const executor: EvaluationGraderExecutor = {
      executorId: 'c02-executor',
      execute(request) {
        calls += 1;
        return {
          profile: request.profile,
          executorId: request.executorId,
          durationMs: 10,
          cpuMs: 5,
          outputBytes: 32,
          checkId: mode === 'unbound' ? 'other-check' : request.checkId,
          finalSnapshot: mode === 'wrong-snapshot' ? { ...request.finalSnapshot, digest: DIGEST } : request.finalSnapshot,
          status: mode === 'fail' ? 'fail' : 'pass',
          actualOutcome: mode === 'incomplete' ? 'FAILED' : 'COMPLETED',
          exitReason: 'clean-exit',
        };
      },
    };
    const isolationAuthority = createHostIsolationAuthority({ executorId: executor.executorId, executor: () => executor });
    isolationAuthority.bind({ profile: PROFILE, finalSnapshot: () => SNAPSHOT });
    const g = createSnapshotGrader(
      {
        criteria: criteria([criterion('C02', 'clarification', mode === 'missing-check' ? null : 'hidden-c02')]),
        profile: PROFILE,
        isolationAuthority: mode === 'denied' ? authority(() => undefined) : isolationAuthority,
        executor,
        graderPayload: GRADER_PAYLOAD,
      },
      'real-tier',
    );
    const result = await g.grade('C02', {
      observation: observation({ expectedWait: 'waiting-info' }),
      snapshot: SNAPSHOT,
      evidence: evidence({ clarificationAnswered: true, speculativePatchApplied: true, requiredChecksPassed: mode !== 'failed-required' }),
    });
    assert.equal(result.grade, mode === 'pass' ? 'pass' : ['fail', 'incomplete', 'failed-required'].includes(mode) ? 'fail' : 'not-run', mode);
    assert.ok(result.evidenceIds.includes('path:clarification-answered'));
    if (!['missing-check', 'failed-required'].includes(mode)) assert.ok(result.evidenceIds.includes('check:hidden-c02'));
    assert.equal(calls, ['denied', 'missing-check', 'failed-required'].includes(mode) ? 0 : 1);
    if (mode === 'pass') assert.ok(result.limitations.some(label => label.includes('Real-tier') && label.includes('c02-executor')));
    assert.ok(!JSON.stringify(result).includes(GRADER_PAYLOAD));
  }
});

test('answer presence is validated against current owner state, never copied execution evidence alone', async () => {
  const state = createFixtureTaskState({ stateVersion: 4 });
  const questions = [{ questionId: 'zero', text: 'What happens at zero?' }];
  const identity = { taskId: state.taskId, runId: state.runId, round: 1, questions, evidenceRefs: [] };
  const questionId = computeClarificationQuestionId(identity);
  const questionDigest = computeClarificationQuestionDigest({ ...identity, questionId, askedAtStateVersion: 2 });
  const items = [{ questionId: 'zero', text: 'Raise the error.' }];
  const recorderRef = 'reporter-1';
  const answered = {
    ...state,
    clarification: {
      questionId,
      questionDigest,
      askedAtStateVersion: 2,
      round: 1,
      questions,
      evidenceRefs: [],
      answer: { answerDigest: computeClarificationAnswerDigest({ questionDigest, recorderRef, items }), answeredAtStateVersion: 3, recorderRef, items },
    },
  };
  assert.equal(await clarificationWasAnswered(answered, { loadTask: async () => answered }), true);
  assert.equal(await clarificationWasAnswered(answered, undefined), false);
  assert.equal(await clarificationWasAnswered(answered, { loadTask: async () => null }), false);
  assert.equal(await clarificationWasAnswered(answered, { loadTask: async () => ({ ...answered, stateVersion: 5 }) }), false);
  assert.equal(
    await clarificationWasAnswered(
      { ...answered, clarification: { ...answered.clarification, answer: { ...answered.clarification.answer, answerDigest: DIGEST } } },
      { loadTask: async () => answered },
    ),
    false,
  );
  assert.equal(await clarificationWasAnswered(state, { loadTask: async () => answered }), false);
});
