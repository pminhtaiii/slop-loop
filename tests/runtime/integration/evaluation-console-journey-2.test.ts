/**
 * Ticket #265 (Feature 007 T017) controlled loopback HTTP journeys over a composed console host.
 *
 * Exercises plan rejection -> permitted revise/resume/end transitions, stale/duplicate/missing-question
 * command refusals with unchanged owner state and versions, exploratory ungraded custom bug execution,
 * material catalog grade non-reuse, and non-restart page refresh.
 *
 * Every adapter is controlled/mock, no browser drives the page and the process never restarts: this
 * is controlled loopback-HTTP evidence only, never actual-browser, real-provider or restart acceptance.
 */

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import type { WorkflowComparisonReport } from '../../../eval/uc03/compare.ts';
import type { WorkflowEvaluationReport } from '../../../eval/uc03/types.ts';
import { isSnapshotGradeCurrent } from '../../../eval/uc03/workflow-grade.ts';
import { createConsoleServer } from '../../../src/runtime/console-server.ts';
import { createEvaluationConsoleHost } from '../../../src/runtime/evaluation-console-host.ts';
import { createUC03EvaluationGraph } from '../../../src/runtime/evaluation-graph.ts';
import type { CatalogEntry } from '../../../src/runtime/evaluation-profile.ts';
import { createEvaluationService, type ExperimentView } from '../../../src/runtime/evaluation-service.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import {
  DEFAULT_CHECK_SET as CHECK_SET,
  DEFAULT_CONSOLE_TOKEN as TOKEN,
  approveCurrentAndContinue,
  composeControlledConsole,
  createConsoleHttpClient,
  createControlledSnapshotGrader,
  issueControlDirection,
  withControlledConsole,
  type ComposedControlledConsole,
  type ConsoleHttpClient,
  type CustomBugInputConfig,
} from '../support/uc03/controlled-console-journey.ts';

type DirectionKind = 'resume' | 'revise' | 'end';

function createSnapshotGuard(client: ConsoleHttpClient, composed: ComposedControlledConsole, expId: string) {
  const capture = async () => {
    const viewReply = await client.get(`/api/experiments/${expId}`);
    assert.equal(viewReply.status, 200, 'experiment view fetch must succeed');
    assert.equal(viewReply.body.ok, true, 'experiment view reply must be ok');
    return {
      view: viewReply.body.result,
      ownerState: await composed.fixture.statePort.loadTask(composed.fixture.task.taskId),
      journal: composed.fixture.statePort.getJournalSnapshot(),
      modelCalls: composed.fixture.modelCalls.length,
      patches: composed.fixture.route.repositoryPort.patches.length,
      approvals: composed.approvalEffects.length,
      directions: composed.directions.length,
    };
  };
  type Snapshot = Awaited<ReturnType<typeof capture>>;

  const assertUnchanged = async (before: Snapshot, label: string): Promise<void> => {
    const after = await capture();
    assert.deepEqual(after.view, before.view, `${label}: experiment view changed`);
    assert.deepEqual(after.ownerState, before.ownerState, `${label}: owner state changed`);
    assert.deepEqual(after.journal, before.journal, `${label}: owner journal changed`);
    assert.equal(after.modelCalls, before.modelCalls, `${label}: model call count changed`);
    assert.equal(after.patches, before.patches, `${label}: patch count changed`);
    assert.equal(after.approvals, before.approvals, `${label}: approval count changed`);
    assert.equal(after.directions, before.directions, `${label}: direction count changed`);
  };

  const refuse = async (subpath: string, body: unknown, error: string, label: string, prior?: Snapshot, status = 409): Promise<void> => {
    const before = prior ?? (await capture());
    const res = await client.postRaw(`/api/experiments/${expId}/${subpath}`, body);
    assert.deepEqual([res.status, res.body], [status, { ok: false, error }], label);
    await assertUnchanged(before, label);
  };

  const refuseDirs = async (expectedTaskVersion: number, expectedControlVersion: number, kinds: readonly DirectionKind[], prefix: string, decisionRef?: string): Promise<void> => {
    for (const kind of kinds) {
      const payload = { expectedTaskVersion, expectedControlVersion, kind, ...(decisionRef === undefined ? {} : { decisionRef }), idempotencyKey: `${prefix}-${kind}` };
      await refuse('directions', payload, 'INVALID_CONTROL_RECEIPT', `${prefix}: ${kind}`);
    }
  };

  return { capture, assertUnchanged, refuse, refuseDirs };
}

async function startCatalogC01(client: ConsoleHttpClient, profileId: string, idempotencyKey: string): Promise<ExperimentView> {
  const reply = await client.post('/api/experiments', { profileId, idempotencyKey, source: { kind: 'catalog', caseIds: ['C01'] } });
  assert.equal(reply.status, 200);
  return reply.body.result.experiment;
}

async function continueDirection(client: ConsoleHttpClient, expId: string, dir: Awaited<ReturnType<typeof issueControlDirection>>, idempotencyKey: string): Promise<ExperimentView> {
  const res = await client.post(`/api/experiments/${expId}/continue`, { expectedVersion: dir.experiment.version, directionRef: dir.receipt.receiptRef, idempotencyKey });
  assert.equal(res.status, 200);
  return res.body.result.experiment;
}

async function completeTwoApprovals(client: ConsoleHttpClient, composed: ComposedControlledConsole, expId: string, keyPrefix: string): Promise<ExperimentView> {
  const d0 = await approveCurrentAndContinue(client, composed, expId, 0, `${keyPrefix}-d0`);
  const d1 = await approveCurrentAndContinue(client, composed, expId, d0.controlVersion, `${keyPrefix}-d1`);
  assert.equal(d1.experiment.status, 'completed');
  return d1.experiment;
}

async function rejectPlanAndReachFeedback(client: ConsoleHttpClient, composed: ComposedControlledConsole, expId: string, keyPrefix: string) {
  const guard = createSnapshotGuard(client, composed, expId);
  const pres = await client.get<{ decisionId: string; status: string }>(`/api/experiments/${expId}/approval`);
  assert.equal(pres.body.result.status, 'pending');
  const decisionId = pres.body.result.decisionId;
  const rejected = await client.post<{ decisionId: string; status: string }>(`/api/experiments/${expId}/decision`, { decisionId, choice: 'reject' });
  assert.deepEqual([rejected.status, rejected.body], [200, { ok: true, result: { decisionId, status: 'rejected' } }]);

  const ownerAtAwaitPlan = await composed.fixture.statePort.loadTask(composed.fixture.task.taskId);
  assert.ok(ownerAtAwaitPlan && ownerAtAwaitPlan.node === 'AwaitPlan');
  await guard.refuseDirs(ownerAtAwaitPlan.stateVersion, 0, ['revise', 'end'], `${keyPrefix}-await-plan`, decisionId);

  const resumeDir = await issueControlDirection(client, expId, {
    expectedTaskVersion: ownerAtAwaitPlan.stateVersion,
    expectedControlVersion: 0,
    kind: 'resume',
    idempotencyKey: `${keyPrefix}-resume-dir`,
  });
  const feedback = await continueDirection(client, expId, resumeDir, `${keyPrefix}-resume-cont`);
  assert.equal(feedback.status, 'waiting-info');
  const ownerAtFeedback = await composed.fixture.statePort.loadTask(composed.fixture.task.taskId);
  assert.ok(ownerAtFeedback && ownerAtFeedback.node === 'AwaitFeedback');
  return { guard, decisionId, ownerAtFeedback, controlVersion: resumeDir.receipt.controlVersion };
}

test('controlled loopback HTTP: plan rejection requires permitted explicit revise, resume or end, refuses unpermitted options, and completes or terminates', async () => {
  await withControlledConsole(
    {
      replanResponse: {
        proposalId: 'controlled-replan-v2',
        content: JSON.stringify({
          kind: 'propose-plan',
          proposalId: 'controlled-replan-v2',
          diagnosis: 'Denominator validation must explicitly reject zero before division.',
          strategy: 'Validate b == 0 explicitly before division and raise CalculationError.',
          suspectedLocations: ['src/calculator.py'],
          scopedPaths: ['src/calculator.py'],
          evidenceRefs: ['uc04://baseline/task-calc-001/1'],
        }),
      },
    },
    async ({ composed, client }) => {
      const exp = await startCatalogC01(client, composed.profile.profileId, 'ac1-revise-start');
      assert.equal(exp.status, 'waiting-approval');
      assert.equal(exp.taskId, composed.fixture.task.taskId);
      assert.equal(exp.control, null);
      const { guard, decisionId: rejectedDecisionId, ownerAtFeedback, controlVersion: afterRejectCtrl } = await rejectPlanAndReachFeedback(client, composed, exp.id, 'ac1-rev');

      // Pending AwaitPlan check is covered on the renewed plan too; check initial rejected state & feedback guards.
      assert.equal(ownerAtFeedback.planVersion, 1);
      assert.equal(ownerAtFeedback.replanCount, 0);
      assert.equal(ownerAtFeedback.activeDecisionId, rejectedDecisionId);
      assert.deepEqual((await client.get(`/api/experiments/${exp.id}`)).body.result.control, { taskVersion: ownerAtFeedback.stateVersion, controlVersion: afterRejectCtrl });
      await guard.refuseDirs(ownerAtFeedback.stateVersion, afterRejectCtrl, ['resume'], 'ac1-fb-no-resume');
      await guard.refuseDirs(ownerAtFeedback.stateVersion, afterRejectCtrl, ['revise', 'end'], 'ac1-fb-wrong-ref', 'dec-wrong-ref');

      // Explicit `revise` generates plan v2, charges replan once, and pauses at renewed pending AwaitPlan.
      const reviseDir = await issueControlDirection(client, exp.id, {
        expectedTaskVersion: ownerAtFeedback.stateVersion,
        expectedControlVersion: afterRejectCtrl,
        kind: 'revise',
        decisionRef: rejectedDecisionId,
        feedback: 'Guard zero denominator explicitly before division',
        idempotencyKey: 'ac1-revise-dir',
      });
      assert.equal((await continueDirection(client, exp.id, reviseDir, 'ac1-revise-cont')).status, 'waiting-approval');

      const ownerV2 = await composed.fixture.statePort.loadTask(composed.fixture.task.taskId);
      assert.ok(ownerV2 && ownerV2.node === 'AwaitPlan');
      assert.equal(ownerV2.planVersion, 2);
      assert.equal(ownerV2.replanCount, 1);
      assert.notEqual(ownerV2.activeDecisionId, rejectedDecisionId);
      await guard.refuseDirs(ownerV2.stateVersion, reviseDir.receipt.controlVersion, ['revise', 'end'], 'ac1-v2-pending', ownerV2.activeDecisionId);

      // Old v1 decision is stale; approving v2 advances to Verify (refuses revise/end), then D1 completes to Deliver.
      await guard.refuse('decision', { decisionId: rejectedDecisionId, choice: 'approve' }, 'STALE_DECISION', 'stale v1 decision');

      const afterD0 = await approveCurrentAndContinue(client, composed, exp.id, reviseDir.receipt.controlVersion, 'ac1-v2-d0');
      assert.equal(afterD0.experiment.status, 'waiting-approval');
      assert.equal(afterD0.experiment.control, null);
      const ownerVerify = await composed.fixture.statePort.loadTask(composed.fixture.task.taskId);
      assert.ok(ownerVerify && ownerVerify.node === 'Verify');
      await guard.refuseDirs(ownerVerify.stateVersion, afterD0.controlVersion, ['revise', 'end'], 'ac1-verify');

      const afterD1 = await approveCurrentAndContinue(client, composed, exp.id, afterD0.controlVersion, 'ac1-v2-d1');
      assert.equal(afterD1.experiment.status, 'completed');
      assert.equal(afterD1.experiment.control, null);
      assert.equal(afterD1.experiment.workflowReport?.cases[0]?.workflowOutcome, 'COMPLETED');
      assert.equal(afterD1.experiment.workflowReport?.cases[0]?.grade, 'pass');
      assert.equal(composed.fixture.route.repositoryPort.patches.length, 1);

      const ownerDone = await composed.fixture.statePort.loadTask(composed.fixture.task.taskId);
      assert.ok(ownerDone && ownerDone.node === 'Deliver');
      await guard.refuseDirs(ownerDone.stateVersion, afterD1.controlVersion, ['resume', 'revise', 'end'], 'ac1-deliver');
    },
  );

  // Second run: pending AwaitPlan refuses revise/end, plan rejection -> resume -> AwaitFeedback -> explicit `end` terminates cleanly.
  await withControlledConsole({}, async ({ composed, client }) => {
    const exp = await startCatalogC01(client, composed.profile.profileId, 'ac1-end-start');
    const pendingOwner = await composed.fixture.statePort.loadTask(composed.fixture.task.taskId);
    assert.ok(pendingOwner && pendingOwner.node === 'AwaitPlan');
    await createSnapshotGuard(client, composed, exp.id).refuseDirs(pendingOwner.stateVersion, 0, ['revise', 'end'], 'ac1-pending', pendingOwner.activeDecisionId);

    const { guard, decisionId, ownerAtFeedback, controlVersion } = await rejectPlanAndReachFeedback(client, composed, exp.id, 'ac1-end');
    const endDir = await issueControlDirection(client, exp.id, {
      expectedTaskVersion: ownerAtFeedback.stateVersion,
      expectedControlVersion: controlVersion,
      kind: 'end',
      decisionRef: decisionId,
      idempotencyKey: 'ac1-end-dir',
    });
    const terminated = await continueDirection(client, exp.id, endDir, 'ac1-end-cont');
    assert.equal(terminated.status, 'incomplete');
    assert.equal(terminated.control, null);
    assert.equal(terminated.workflowReport?.cases[0]?.workflowOutcome, 'INCOMPLETE');
    assert.equal(terminated.workflowReport?.cases[0]?.grade, 'not-run');
    assert.equal(composed.fixture.route.repositoryPort.patches.length, 0);

    const finalOwner = await composed.fixture.statePort.loadTask(composed.fixture.task.taskId);
    assert.ok(finalOwner && finalOwner.node === 'Incomplete');
    assert.equal(finalOwner.outcome, 'INCOMPLETE');
    assert.equal(finalOwner.nextAction, 'human-directed-termination');
    await guard.refuseDirs(finalOwner.stateVersion, endDir.receipt.controlVersion, ['resume', 'revise', 'end'], 'ac1-term', decisionId);
  });
});

test('controlled loopback HTTP: stale, duplicate, and missing-question commands are refused and leave owner state and versions unchanged', async () => {
  await withControlledConsole(
    {
      includeCustomRoute: true,
      taskState: { evidenceRefs: ['src/calculator.py'] },
      firstResponse: {
        proposalId: 'ac2-clarification-ask',
        content: JSON.stringify({
          kind: 'request-info',
          proposalId: 'ac2-clarification-ask',
          questions: [{ questionId: 'q-zero', text: 'Which exception should zero division raise?' }],
          evidenceRefs: [],
        }),
      },
    },
    async ({ composed, client }) => {
      const ans = (questionId: string, questionDigest: string, expectedVersion: number, answers: string[], idempotencyKey: string) => ({
        questionId,
        questionDigest,
        expectedVersion,
        answers,
        idempotencyKey,
      });

      // Phase A: pre-task custom bug intake (`NeedsInfo` before any UC-05 task exists).
      const intakeStart = await client.post('/api/experiments', {
        profileId: composed.profile.profileId,
        idempotencyKey: 'ac2-intake-start',
        source: {
          kind: 'bug',
          repositoryId: composed.fixture.task.repositoryId,
          checkSetId: CHECK_SET,
          bugInput: {
            goal: 'Prevent ZeroDivisionError on divide(10, 0)',
            observedBehavior: 'divide(10, 0) raises ZeroDivisionError',
            expectedBehavior: 'divide(10, 0) raises CalculationError',
            reproduction: '',
            acceptanceCriteria: ['divide(10, 0) raises CalculationError'],
          },
        },
      });
      assert.equal(intakeStart.status, 200);
      const intakeExp = intakeStart.body.result.experiment;
      assert.equal(intakeExp.status, 'waiting-info');
      assert.equal(intakeExp.taskId, null);
      assert.equal(intakeExp.control, null);
      const intakeQ = intakeExp.submission?.questions[0];
      assert.ok(intakeQ);
      const intakeGuard = createSnapshotGuard(client, composed, intakeExp.id);

      for (const [label, body, err] of [
        ['intake missing questionId', ans('q-nonexistent', intakeQ.questionDigest, intakeExp.version, ['pytest'], 'ac2-i-missing'), 'UNKNOWN_QUESTION'],
        ['intake wrong questionDigest', ans(intakeQ.questionId, sha256Text('wrong'), intakeExp.version, ['pytest'], 'ac2-i-digest'), 'UNKNOWN_QUESTION'],
        ['intake stale version', ans(intakeQ.questionId, intakeQ.questionDigest, intakeExp.version - 1, ['pytest'], 'ac2-i-stale'), 'STALE_VERSION'],
      ] as const) {
        await intakeGuard.refuse('answers', body, err, label);
      }

      const intakeAnswer = ans(intakeQ.questionId, intakeQ.questionDigest, intakeExp.version, ['pytest -q'], 'ac2-i-valid');
      const intakeAfter = (await client.post(`/api/experiments/${intakeExp.id}/answers`, intakeAnswer)).body.result.experiment;
      assert.equal(intakeAfter.version, intakeExp.version + 1);
      assert.equal(intakeAfter.control, null);
      assert.equal((await client.post(`/api/experiments/${intakeExp.id}/answers`, intakeAnswer)).body.result.experiment.version, intakeAfter.version);

      for (const [label, sub, body, err] of [
        ['intake conflicting replay', 'answers', { ...intakeAnswer, answers: ['different'] }, 'CONFLICTING_REPLAY'],
        ['intake duplicate new key', 'answers', { ...intakeAnswer, expectedVersion: intakeAfter.version, idempotencyKey: 'ac2-i-dup-key' }, 'QUESTION_ALREADY_ANSWERED'],
        ['intake resume refused', 'directions', { expectedTaskVersion: 0, expectedControlVersion: 0, kind: 'resume', idempotencyKey: 'ac2-i-resume' }, 'INCOMPLETE_INTAKE'],
      ] as const) {
        await intakeGuard.refuse(sub, body, err, label);
      }
      assert.deepEqual(composed.fixture.modelCalls, []);
      assert.equal(
        (await client.post(`/api/experiments/${intakeExp.id}/directions`, { expectedTaskVersion: 0, expectedControlVersion: 0, kind: 'end', idempotencyKey: 'ac2-i-end' })).body.result.experiment
          .status,
        'incomplete',
      );

      // Phase B: graph-produced Clarification (`NeedsInfo`) -> `AwaitPlan` on catalog case C01.
      const exp = await startCatalogC01(client, composed.profile.profileId, 'ac2-start');
      assert.equal(exp.status, 'waiting-info');
      assert.ok(exp.workflowClarification);
      const clar = exp.workflowClarification;
      const guard = createSnapshotGuard(client, composed, exp.id);
      const beforeNeedsInfo = await guard.capture();
      assert.ok(beforeNeedsInfo.ownerState);
      assert.deepEqual(exp.control, { taskVersion: beforeNeedsInfo.ownerState.stateVersion, controlVersion: 0 });

      for (const [label, body, err] of [
        ['unknown questionId', ans('q-missing', clar.questionDigest, beforeNeedsInfo.view.version, ['Raise CalculationError'], 'ac2-missing-q'), 'UNKNOWN_QUESTION'],
        ['wrong questionDigest', ans(clar.questionId, sha256Text('wrong'), beforeNeedsInfo.view.version, ['Raise CalculationError'], 'ac2-wrong-digest'), 'UNKNOWN_QUESTION'],
        ['stale answer version', ans(clar.questionId, clar.questionDigest, beforeNeedsInfo.view.version - 1, ['Raise CalculationError'], 'ac2-stale-ans'), 'STALE_VERSION'],
      ] as const) {
        await guard.refuse('answers', body, err, label, beforeNeedsInfo);
      }

      const validAnswer = ans(clar.questionId, clar.questionDigest, beforeNeedsInfo.view.version, ['Raise CalculationError on zero division.'], 'ac2-valid-ans');
      const answered = await client.post(`/api/experiments/${exp.id}/answers`, validAnswer);
      assert.equal(answered.status, 200);
      assert.equal(answered.body.result.experiment.version, beforeNeedsInfo.view.version + 1);
      assert.equal((await composed.fixture.statePort.loadTask(composed.fixture.task.taskId))?.clarification?.answer, undefined);

      const afterAnswer = await guard.capture();
      assert.equal((await client.post(`/api/experiments/${exp.id}/answers`, validAnswer)).body.result.experiment.version, afterAnswer.view.version);
      await guard.assertUnchanged(afterAnswer, 'replayed answer');
      await guard.refuse('answers', { ...validAnswer, answers: ['Return 0'] }, 'CONFLICTING_REPLAY', 'conflicting answer replay', afterAnswer);
      await guard.refuse(
        'answers',
        { ...validAnswer, expectedVersion: afterAnswer.view.version, idempotencyKey: 'ac2-dup-ans-key' },
        'QUESTION_ALREADY_ANSWERED',
        'duplicate answer new key',
        afterAnswer,
      );

      const ownerNeedsInfo = afterAnswer.ownerState;
      assert.ok(ownerNeedsInfo);
      assert.deepEqual(afterAnswer.view.control, { taskVersion: ownerNeedsInfo.stateVersion, controlVersion: 0 });
      for (const [label, body] of [
        ['stale taskVersion direction', { expectedTaskVersion: ownerNeedsInfo.stateVersion - 1, expectedControlVersion: 0, kind: 'resume', idempotencyKey: 'ac2-stale-task-dir' }],
        ['stale controlVersion direction', { expectedTaskVersion: ownerNeedsInfo.stateVersion, expectedControlVersion: 99, kind: 'resume', idempotencyKey: 'ac2-stale-ctrl-dir' }],
        ['disallowed revise at NeedsInfo', { expectedTaskVersion: ownerNeedsInfo.stateVersion, expectedControlVersion: 0, kind: 'revise', idempotencyKey: 'ac2-revise-needs-info' }],
        ['disallowed end at NeedsInfo', { expectedTaskVersion: ownerNeedsInfo.stateVersion, expectedControlVersion: 0, kind: 'end', idempotencyKey: 'ac2-end-needs-info' }],
      ] as const) {
        await guard.refuse('directions', body, 'INVALID_CONTROL_RECEIPT', label, afterAnswer);
      }

      assert.ok(afterAnswer.view.control);
      const dirBody = { expectedTaskVersion: afterAnswer.view.control.taskVersion, expectedControlVersion: afterAnswer.view.control.controlVersion, kind: 'resume', idempotencyKey: 'ac2-resume-dir' };
      const issuedDir = await issueControlDirection(client, exp.id, dirBody);
      const afterDir = await guard.capture();
      assert.equal((await issueControlDirection(client, exp.id, dirBody)).receipt.controlVersion, issuedDir.receipt.controlVersion);
      await guard.assertUnchanged(afterDir, 'duplicate direction replay');
      await guard.refuse('directions', { ...dirBody, idempotencyKey: 'ac2-resume-dir-2' }, 'INVALID_CONTROL_RECEIPT', 'duplicate direction new key', afterDir);
      await guard.refuse('directions', { ...dirBody, kind: 'revise' }, 'CONFLICTING_REPLAY', 'conflicting direction replay', afterDir);
      await guard.refuse(
        'continue',
        { expectedVersion: afterDir.view.version - 1, directionRef: issuedDir.receipt.receiptRef, idempotencyKey: 'ac2-stale-cont' },
        'STALE_VERSION',
        'stale continue version',
        afterDir,
      );
      await guard.refuse(
        'continue',
        { expectedVersion: afterDir.view.version, directionRef: 'dir-missing', idempotencyKey: 'ac2-unknown-dir' },
        'UNKNOWN_DIRECTION',
        'unknown directionRef continue',
        afterDir,
      );

      const continueBody = { expectedVersion: afterDir.view.version, directionRef: issuedDir.receipt.receiptRef, idempotencyKey: 'ac2-resume-cont' };
      const resumed = await client.post(`/api/experiments/${exp.id}/continue`, continueBody);
      assert.equal(resumed.status, 200);
      assert.equal(resumed.body.result.experiment.status, 'waiting-approval');
      assert.equal(resumed.body.result.experiment.control, null);

      const afterAwaitPlan = await guard.capture();
      assert.equal(afterAwaitPlan.view.control, null);
      assert.equal((await client.post(`/api/experiments/${exp.id}/continue`, continueBody)).body.result.experiment.version, afterAwaitPlan.view.version);
      await guard.assertUnchanged(afterAwaitPlan, 'duplicate continue replay');
      await guard.refuse('continue', { ...continueBody, expectedVersion: afterDir.view.version, idempotencyKey: 'ac2-resume-cont-2' }, 'STALE_VERSION', 'duplicate continue new key', afterAwaitPlan);
      await guard.refuse(
        'continue',
        { ...continueBody, expectedVersion: afterAwaitPlan.view.version, idempotencyKey: `${continueBody.idempotencyKey}-consumed` },
        'DIRECTION_ALREADY_CONSUMED',
        'consumed directionRef at current version',
        afterAwaitPlan,
      );
      await guard.refuse(
        'answers',
        ans(clar.questionId, clar.questionDigest, afterAwaitPlan.view.version, ['Late answer'], 'ac2-no-sub-ans'),
        'NO_SUBMISSION',
        'missing-question answer after resume',
        afterAwaitPlan,
      );
      await guard.refuse('decision', { decisionId: 'dec-stale-id', choice: 'approve' }, 'STALE_DECISION', 'stale decision', afterAwaitPlan);
      await guard.refuse('decision', { decisionId: afterAwaitPlan.ownerState?.activeDecisionId, choice: 'skip' }, 'UNSUPPORTED_CHOICE', 'unsupported decision choice', afterAwaitPlan, 400);

      assert.equal((await client.post(`/api/experiments/${exp.id}/decision`, { decisionId: afterAwaitPlan.ownerState?.activeDecisionId, choice: 'approve' })).status, 200);
      await guard.refuse('decision', { decisionId: afterAwaitPlan.ownerState?.activeDecisionId, choice: 'approve' }, 'DECISION_ALREADY_RECORDED', 'duplicate decision');
    },
  );
});

test('controlled loopback HTTP: custom bug submission stays exploratory, is never graded, and refuses catalog report binding', async () => {
  const probeComposed = await composeControlledConsole({ includeCustomRoute: true });
  const customBugInput: CustomBugInputConfig = {
    goal: 'Exploratory custom bug: handle zero denominator safely',
    observedBehavior: 'divide(10, 0) raises ZeroDivisionError',
    expectedBehavior: 'divide(10, 0) raises CalculationError',
    reproduction: 'pytest -q tests/test_calculator.py -k test_divide_zero',
    acceptanceCriteria: [...probeComposed.fixture.task.acceptanceCriteria],
    constraints: [...(probeComposed.fixture.task.constraints ?? [])],
  };
  let refusedHost: Awaited<ReturnType<typeof createEvaluationConsoleHost>> | undefined;
  try {
    const customRoute = probeComposed.assembly.customRoute;
    assert.ok(customRoute);
    refusedHost = await createEvaluationConsoleHost(probeComposed.readiness, probeComposed.configuration, () => ({
      ...probeComposed.assembly,
      customRoute: { ...customRoute, workflowReport: probeComposed.workflowReportBinding },
    }));
    assert.deepEqual(refusedHost, { ok: false, reasonCode: 'HOST_CONSOLE_UNAVAILABLE' });
    assert.deepEqual(probeComposed.fixture.modelCalls, []);
  } finally {
    if (refusedHost?.ok) await refusedHost.host.close();
    await rm(probeComposed.files, { recursive: true, force: true });
  }

  await withControlledConsole({ includeCustomRoute: true, customBugInput }, async ({ composed, client }) => {
    const customStart = await client.post('/api/experiments', {
      profileId: composed.profile.profileId,
      idempotencyKey: 'ac3-custom-complete',
      source: { kind: 'bug', repositoryId: composed.fixture.task.repositoryId, checkSetId: CHECK_SET, bugInput: customBugInput },
    });
    assert.equal(customStart.status, 200);
    const assertExploratory = (view: ExperimentView, expectedStatus: string) => {
      assert.equal(view.status, expectedStatus);
      assert.equal(view.scope, 'exploratory');
      assert.equal(view.graded, false);
      assert.deepEqual(view.bindings, []);
      assert.equal(view.workflowReport, null);
    };
    const exp = customStart.body.result.experiment;
    assertExploratory(exp, 'waiting-approval');
    assert.equal(exp.taskId, composed.fixture.task.taskId);

    const afterD0 = await approveCurrentAndContinue(client, composed, exp.id, 0, 'ac3-d0');
    assertExploratory(afterD0.experiment, 'waiting-approval');

    const afterD1 = await approveCurrentAndContinue(client, composed, exp.id, afterD0.controlVersion, 'ac3-d1');
    assertExploratory(afterD1.experiment, 'completed');
    assert.equal(composed.fixture.route.repositoryPort.patches.length, 1);
    assert.equal(composed.graderExecutions(), 0, 'custom exploratory run never invokes snapshot grader');
    assertExploratory((await client.get(`/api/experiments/${exp.id}`)).body.result, 'completed');

    const compareCustom = await client.postRaw('/api/comparisons', { idempotencyKey: 'ac3-compare-custom', baselineId: exp.id, candidateId: exp.id, policy: 'guarded' });
    assert.deepEqual([compareCustom.status, compareCustom.body], [404, { ok: false, error: 'WORKFLOW_REPORT_NOT_FOUND' }]);
  });
});

test('controlled loopback HTTP: material catalog change refuses misbound host/route and forces fresh evaluation instead of reusing an earlier grade', async () => {
  const host1 = await withControlledConsole({ seed: 'v1', graderStatus: 'pass' }, async ({ composed, client }) => {
    const materialV2Entry: CatalogEntry = {
      ...composed.entry,
      catalogEntryId: 'entry-C01-journey-v2',
      version: '2.0.0',
      caseDigest: sha256Text('journey2-case-v2'),
      publicTaskDigest: sha256Text('journey2-task-v2'),
      fixtureDigest: sha256Text('journey2-fixture-v2'),
      grader: { version: '2.0.0', digest: sha256Text('journey2-grader-v2'), path: composed.entry.grader.path },
    };

    let refusedV2Host: Awaited<ReturnType<typeof createEvaluationConsoleHost>> | undefined;
    try {
      refusedV2Host = await createEvaluationConsoleHost(composed.readiness, composed.configuration, () => ({ ...composed.assembly, catalog: [materialV2Entry] }));
      assert.deepEqual(refusedV2Host, {
        ok: false,
        reasonCode: 'HOST_CONSOLE_UNAVAILABLE',
      });
    } finally {
      if (refusedV2Host?.ok) await refusedV2Host.host.close();
    }

    const serviceCatalogMismatch = createEvaluationService({
      profile: composed.profile,
      catalog: [materialV2Entry],
      repositoryIds: [composed.fixture.task.repositoryId],
      checkSetIds: [CHECK_SET],
      control: composed.assembly.control,
      graph: createUC03EvaluationGraph({ catalogRoutes: composed.assembly.routesFor(composed.readiness, [composed.entry]) }),
    });
    assert.deepEqual(await serviceCatalogMismatch.startExperiment({ profileId: composed.profile.profileId, idempotencyKey: 'ac4-catalog-mismatch', source: { kind: 'catalog', caseIds: ['C01'] } }), {
      ok: false,
      status: 'blocked',
      reasonCode: 'CATALOG_MISMATCH',
    });

    const exp = await startCatalogC01(client, composed.profile.profileId, 'ac4-host1-start');
    const done = await completeTwoApprovals(client, composed, exp.id, 'ac4-h1');
    assert.equal(composed.graderExecutions(), 1);
    assert.ok(done.workflowReport);
    assert.equal(done.workflowReport.cases[0]?.grade, 'pass');
    assert.equal(done.workflowReport.cases[0]?.graderDigest, composed.entry.grader.digest);
    return { attempt1Id: exp.id, report1: done.workflowReport, materialV2Entry };
  });

  // Materially changed initialRepositoryDigest that disagrees with task state fails closed without running.
  await withControlledConsole({ seed: 'drift', entryOverrides: { version: '2.0.0', initialRepositoryDigest: sha256Text('drifted-initial-repo-v2') } }, async ({ composed, client }) => {
    const drifted = await startCatalogC01(client, composed.profile.profileId, 'ac4-drift-start');
    assert.equal(drifted.status, 'incomplete');
    assert.equal(drifted.taskId, null);
    assert.equal(drifted.workflowReport, null);
    assert.deepEqual(composed.fixture.modelCalls, []);
  });

  // Host 2 admitted for materially updated catalog entry v2 re-runs and re-grades freshly (grade: 'fail', never reuses 'pass').
  const report2 = await withControlledConsole(
    { seed: 'v2', graderStatus: 'fail', entryOverrides: { ...host1.materialV2Entry, fixturePath: '', grader: { ...host1.materialV2Entry.grader, path: '' } } },
    async ({ composed, client }) => {
      const exp = await startCatalogC01(client, composed.profile.profileId, 'ac4-host2-start');
      const done = await completeTwoApprovals(client, composed, exp.id, 'ac4-h2');
      assert.equal(composed.graderExecutions(), 1);
      assert.ok(done.workflowReport);

      const reports = new Map<string, WorkflowEvaluationReport>([
        [host1.attempt1Id, host1.report1],
        [exp.id, done.workflowReport],
      ]);
      const compareServer = createConsoleServer({
        service: createEvaluationService({
          profile: composed.profile,
          catalog: [composed.entry],
          repositoryIds: [composed.fixture.task.repositoryId],
          checkSetIds: [CHECK_SET],
          control: composed.assembly.control,
          graph: createUC03EvaluationGraph({ catalogRoutes: composed.assembly.routesFor(composed.readiness, [composed.entry]) }),
        }),
        catalog: [composed.entry],
        operatorToken: TOKEN,
        workflowReportLookup: { getWorkflowReport: id => reports.get(id) },
      });
      const addr = await compareServer.listen(0);
      try {
        const compared = await createConsoleHttpClient(`http://${addr.host}:${addr.port}`).post<WorkflowComparisonReport>('/api/comparisons', {
          idempotencyKey: 'ac4-compare-v1-v2',
          baselineId: host1.attempt1Id,
          candidateId: exp.id,
          policy: 'guarded',
        });
        assert.equal(compared.status, 200);
        assert.equal(compared.body.result.compatible, false);
        assert.equal(compared.body.result.verdict, 'INCOMPLETE');
        assert.equal(compared.body.result.exitCode, 1);
        assert.deepEqual(compared.body.result.failedGuards, ['graderDigest']);
        assert.ok(compared.body.result.changedFactors.includes('configDigest'));
      } finally {
        await compareServer.close();
      }
      return done.workflowReport;
    },
  );
  assert.equal(report2.cases[0]?.workflowOutcome, 'COMPLETED');
  assert.equal(report2.cases[0]?.grade, 'fail', 'materially updated catalog entry runs its own grader instead of reusing v1 pass');
  assert.equal(report2.cases[0]?.gradeReason, 'criteria-violation');
  assert.equal(report2.cases[0]?.graderDigest, host1.materialV2Entry.grader.digest);

  // Third run keeps the v1 seed and config, changing only the catalog entry to v2.
  const report3 = await withControlledConsole(
    { seed: 'v1', graderStatus: 'fail', entryOverrides: { ...host1.materialV2Entry, fixturePath: '', grader: { ...host1.materialV2Entry.grader, path: '' } } },
    async ({ composed, client }) => {
      assert.equal(composed.profile.configDigest, host1.report1.configDigest);
      const exp = await startCatalogC01(client, composed.profile.profileId, 'ac4-host3-start');
      const done = await completeTwoApprovals(client, composed, exp.id, 'ac4-h3');
      assert.equal(composed.graderExecutions(), 1);
      assert.ok(done.workflowReport);
      return done.workflowReport;
    },
  );
  assert.equal(report3.cases[0]?.workflowOutcome, 'COMPLETED');
  assert.equal(report3.cases[0]?.grade, 'fail', 'catalog change alone runs its own grader instead of reusing v1 pass');
  assert.equal(report3.cases[0]?.gradeReason, 'criteria-violation');
  assert.equal(report3.cases[0]?.graderDigest, host1.materialV2Entry.grader.digest);

  // Snapshot-level grade currency also invalidates once snapshot or evidence changes.
  const [snap1, snap2] = [
    { snapshotId: 'snap-v1', digest: `sha256:${sha256Text('tree-v1')}` },
    { snapshotId: 'snap-v2', digest: `sha256:${sha256Text('tree-v2')}` },
  ];
  const [ev1, ev2] = [`sha256:${sha256Text('evidence-v1')}`, `sha256:${sha256Text('evidence-v2')}`];
  const diff1 = `sha256:${sha256Text('diff-v1')}`;
  const gradedV1 = await createControlledSnapshotGrader({ seed: 'snap' }).grade('C01', {
    snapshot: snap1,
    evidence: {
      digest: ev1,
      snapshotDigest: snap1.digest,
      diffDigest: diff1,
      baselineFailed: true,
      requiredChecksPassed: true,
      focusedCheckPassed: true,
      testsProtected: true,
      reviewAccepted: true,
      reviewedDiffDigest: diff1,
      sentinelsUnchanged: true,
      speculativePatchApplied: false,
      stoppedBeforeEffect: false,
      completionWithheld: false,
    },
    observation: {
      repositoryId: 'repo-calc',
      taskId: 'task-1',
      runId: 'run-1',
      returnedModel: 'controlled-model',
      graderDigest: host1.materialV2Entry.grader.digest,
      initialRepositoryDigest: host1.materialV2Entry.initialRepositoryDigest,
      workflowOutcome: 'COMPLETED',
      expectedWait: null,
      blocked: null,
      effects: 'observed',
      usage: 'observed',
      diagnostic: null,
      artifacts: [],
      limitations: [],
    },
  });
  assert.equal(gradedV1.grade, 'pass');
  assert.equal(isSnapshotGradeCurrent(gradedV1, snap1, ev1), true);
  assert.equal(isSnapshotGradeCurrent(gradedV1, snap2, ev1), false);
  assert.equal(isSnapshotGradeCurrent(gradedV1, snap1, ev2), false);
});

test('controlled loopback HTTP: page refresh re-reads persisted state across waits and completion without restarting', async () => {
  await withControlledConsole(
    {
      taskState: { evidenceRefs: ['src/calculator.py'] },
      firstResponse: {
        proposalId: 'ac5-clarification-ask',
        content: JSON.stringify({
          kind: 'request-info',
          proposalId: 'ac5-clarification-ask',
          questions: [{ questionId: 'q-refresh', text: 'Confirm zero division exception class?' }],
          evidenceRefs: [],
        }),
      },
    },
    async ({ composed, client }) => {
      const exp = await startCatalogC01(client, composed.profile.profileId, 'ac5-start');
      const taskId = composed.fixture.task.taskId;
      const runId = exp.runId;
      const guard = createSnapshotGuard(client, composed, exp.id);
      assert.equal(exp.status, 'waiting-info');
      assert.ok(exp.workflowClarification);
      const refreshNeedsOwner = await composed.fixture.statePort.loadTask(taskId);
      assert.ok(refreshNeedsOwner);
      assert.deepEqual(exp.control, { taskVersion: refreshNeedsOwner.stateVersion, controlVersion: 0 });

      const simulatePageRefresh = async (expectedView: ExperimentView, checkApprovalPending?: boolean) => {
        const before = await guard.capture();
        const htmlPage = await client.getText('/');
        assert.equal(htmlPage.status, 200);
        assert.equal(htmlPage.headers.get('cache-control'), 'no-store');
        assert.match(htmlPage.text, /<html/iu);
        assert.equal((await client.get('/api/catalog')).status, 200);
        assert.deepEqual((await client.get(`/api/experiments/${exp.id}`)).body.result, expectedView);
        assert.deepEqual((await client.get(`/api/experiments/${exp.id}`)).body.result, expectedView);
        if (checkApprovalPending) {
          const approvalPres = await client.get<{ taskId: string; status: string }>(`/api/experiments/${exp.id}/approval`);
          assert.equal(approvalPres.status, 200);
          assert.equal(approvalPres.body.result.taskId, taskId);
          assert.equal(approvalPres.body.result.status, 'pending');
        }
        await guard.assertUnchanged(before, 'page refresh');
      };

      await simulatePageRefresh(exp);

      const answered = await client.post(`/api/experiments/${exp.id}/answers`, {
        questionId: exp.workflowClarification.questionId,
        questionDigest: exp.workflowClarification.questionDigest,
        expectedVersion: exp.version,
        answers: ['Raise CalculationError.'],
        idempotencyKey: 'ac5-answer',
      });
      assert.equal(answered.status, 200);
      await simulatePageRefresh(answered.body.result.experiment);

      const ownerNeedsInfo = await composed.fixture.statePort.loadTask(taskId);
      assert.ok(ownerNeedsInfo);
      const clarDir = await issueControlDirection(client, exp.id, {
        expectedTaskVersion: ownerNeedsInfo.stateVersion,
        expectedControlVersion: 0,
        kind: 'resume',
        idempotencyKey: 'ac5-clarification-dir',
      });
      const atD0 = await continueDirection(client, exp.id, clarDir, 'ac5-clarification-cont');
      assert.equal(atD0.status, 'waiting-approval');
      assert.equal(atD0.runId, runId);
      assert.equal(atD0.control, null);
      await simulatePageRefresh(atD0, true);

      const atD1 = await approveCurrentAndContinue(client, composed, exp.id, clarDir.receipt.controlVersion, 'ac5-d0');
      assert.equal(atD1.experiment.status, 'waiting-approval');
      assert.equal(atD1.experiment.runId, runId);
      assert.equal(atD1.experiment.control, null);
      await simulatePageRefresh(atD1.experiment, true);

      const completed = await approveCurrentAndContinue(client, composed, exp.id, atD1.controlVersion, 'ac5-d1');
      assert.equal(completed.experiment.status, 'completed');
      assert.equal(completed.experiment.control, null);
      assert.equal(completed.experiment.taskId, taskId);
      assert.equal(completed.experiment.runId, runId);
      assert.equal(completed.experiment.workflowReport?.cases[0]?.grade, 'pass');
      await simulatePageRefresh(completed.experiment);
    },
  );
});
