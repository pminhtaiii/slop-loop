/**
 * T037 controlled HTTP journey over ONE composed console host (host -> graph -> service -> loopback server).
 *
 * Every adapter is controlled/mock, no browser drives the page and the process never restarts: this
 * is controlled loopback-HTTP evidence only, never actual-browser, real-provider or restart acceptance.
 * It reuses the T030 controlled traversal (generated plan, D0/D1 owner approvals, independent grade).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowComparisonReport } from '../../../eval/uc03/compare.ts';
import type { ExperimentView, ServiceControlReceipt } from '../../../src/runtime/evaluation-service.ts';
import { DEFAULT_CHECK_SET as CHECK_SET, DEFAULT_CONSOLE_TOKEN as TOKEN, withControlledConsole } from '../support/uc03/controlled-console-journey.ts';

test('controlled HTTP journey: one composed console host drives intake, approval, continuation, report and comparison', async () => {
  await withControlledConsole({}, async ({ composed, origin, client }) => {
    const { fixture, profile } = composed;
    const get = client.get.bind(client);
    const post = client.post.bind(client);

    assert.deepEqual(composed.counters(), { routeCalls: 1 }, 'one composed route factory call backs every request below');

    // Transport protection stays in front of the composed service: no token, no effect.
    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/iu);
    const noToken = await fetch(`${origin}/api/experiments`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}' });
    assert.equal(noToken.status, 403);
    assert.equal((await get<{ cases: readonly { caseId: string }[] }>('/api/catalog')).body.result.cases[0]?.caseId, 'C01');

    // --- Immutable intake and a reporter answer that never resumes anything ---------------------
    const bugSource = {
      kind: 'bug',
      repositoryId: fixture.task.repositoryId,
      checkSetId: CHECK_SET,
      bugInput: { goal: 'Divide safely', observedBehavior: 'divide(1, 0) raises ZeroDivisionError', expectedBehavior: 'divide(1, 0) raises a domain error' },
    };
    const intake = await post('/api/experiments', { profileId: profile.profileId, idempotencyKey: 'journey-intake', source: bugSource });
    assert.equal(intake.status, 200);
    const custom = intake.body.result.experiment;
    assert.equal(custom.status, 'waiting-info');
    assert.equal(custom.graded, false, 'a custom submission never borrows catalog acceptance');
    assert.equal(custom.taskId, null, 'incomplete intake allocates no task');
    assert.ok(custom.submission);
    const questions = custom.submission.questions;
    assert.ok(questions.some(question => question.questionId === 'q-reproduction'));
    const replayIntake = await post('/api/experiments', { profileId: profile.profileId, idempotencyKey: 'journey-intake', source: bugSource });
    assert.equal(replayIntake.body.result.experiment.id, custom.id, 'the same key and body returns the one stored experiment');
    const alteredIntake = await post('/api/experiments', {
      profileId: profile.profileId,
      idempotencyKey: 'journey-intake',
      source: { ...bugSource, bugInput: { ...bugSource.bugInput, goal: 'Changed goal' } },
    });
    assert.deepEqual([alteredIntake.status, alteredIntake.body], [409, { ok: false, error: 'CONFLICTING_REPLAY' }]);

    const question = questions.find(item => item.questionId === 'q-reproduction');
    assert.ok(question);
    const answerBody = { questionId: question.questionId, questionDigest: question.questionDigest, expectedVersion: custom.version, answers: ['Call divide(1, 0).'], idempotencyKey: 'journey-answer' };
    const answered = await post(`/api/experiments/${custom.id}/answers`, answerBody);
    assert.equal(answered.status, 200);
    assert.equal(answered.body.result.experiment.status, 'waiting-info', 'a reporter answer alone does not resume');
    assert.equal(answered.body.result.experiment.taskId, null);
    assert.equal(answered.body.result.experiment.version, custom.version + 1);
    const replayedAnswer = await post(`/api/experiments/${custom.id}/answers`, answerBody);
    assert.equal(replayedAnswer.body.result.experiment.version, custom.version + 1, 'duplicate answer adds no second record');
    assert.equal(replayedAnswer.body.result.experiment.answers.length, 1);
    const staleAnswer = await post(`/api/experiments/${custom.id}/answers`, { ...answerBody, idempotencyKey: 'journey-answer-stale' });
    assert.deepEqual([staleAnswer.status, staleAnswer.body], [409, { ok: false, error: 'STALE_VERSION' }]);
    const resumeEarly = await post(`/api/experiments/${custom.id}/directions`, { expectedTaskVersion: 0, expectedControlVersion: 0, kind: 'resume', idempotencyKey: 'journey-early-resume' });
    assert.deepEqual([resumeEarly.status, resumeEarly.body], [409, { ok: false, error: 'INCOMPLETE_INTAKE' }]);
    assert.deepEqual(fixture.modelCalls, [], 'intake and answers made no model call');
    assert.equal(composed.directions.length, 0, 'no owner direction was issued');
    const ended = await post(`/api/experiments/${custom.id}/directions`, { expectedTaskVersion: 0, expectedControlVersion: 0, kind: 'end', idempotencyKey: 'journey-end-intake' });
    assert.equal(ended.status, 200);
    assert.equal(ended.body.result.experiment.status, 'incomplete');

    // --- Catalog attempt 1: generated plan -> D0 -> patch -> D1 -> independent grade ------------
    const startBody = { profileId: profile.profileId, idempotencyKey: 'journey-attempt-1', source: { kind: 'catalog', caseIds: ['C01'] } };
    const first = await post('/api/experiments', startBody);
    assert.equal(first.status, 200);
    const attempt1 = first.body.result.experiment;
    assert.equal(attempt1.status, 'waiting-approval');
    assert.equal(attempt1.taskId, fixture.task.taskId);
    assert.equal(attempt1.bindings[0]?.caseId, 'C01');
    assert.ok(attempt1.workflowReport);
    assert.equal(attempt1.workflowReport.cases[0]?.gradeReason, 'unresolved-wait');
    assert.deepEqual(fixture.modelCalls, ['coder:propose-plan', 'coder:propose-plan']);
    const replayStart = await post('/api/experiments', startBody);
    assert.equal(replayStart.body.result.experiment.id, attempt1.id);
    assert.equal(replayStart.body.result.experiment.version, attempt1.version);
    assert.equal(fixture.modelCalls.length, 2, 'a duplicate start makes no second model call');
    const busy = await post('/api/experiments', { ...startBody, idempotencyKey: 'journey-attempt-busy' });
    assert.deepEqual([busy.status, busy.body], [409, { ok: false, error: 'EXPERIMENT_ACTIVE' }]);

    const decideAndContinue = async (label: string, expectedControlVersion: number, afterModelCalls: readonly string[]) => {
      const presented = await get<{ taskId: string; decisionId: string; status: string }>(`/api/experiments/${attempt1.id}/approval`);
      assert.equal(presented.status, 200);
      const presentation = presented.body.result;
      assert.equal(presentation.taskId, fixture.task.taskId, 'the presentation is bound to the experiment task');
      assert.equal(presentation.status, 'pending');
      const staleDecision = await post(`/api/experiments/${attempt1.id}/decision`, { decisionId: 'dec-stale', choice: 'approve' });
      assert.deepEqual([staleDecision.status, staleDecision.body], [409, { ok: false, error: 'STALE_DECISION' }]);
      assert.equal(composed.approvalEffects.length, label === 'D0' ? 0 : 1, 'a stale decision records nothing');
      const decision = await post(`/api/experiments/${attempt1.id}/decision`, { decisionId: presentation.decisionId, choice: 'approve' });
      assert.deepEqual([decision.status, decision.body], [200, { ok: true, result: { decisionId: presentation.decisionId, status: 'approved' } }]);
      const duplicateDecision = await post(`/api/experiments/${attempt1.id}/decision`, { decisionId: presentation.decisionId, choice: 'approve' });
      assert.deepEqual([duplicateDecision.status, duplicateDecision.body], [409, { ok: false, error: 'DECISION_ALREADY_RECORDED' }]);
      assert.equal(composed.approvalEffects.length, label === 'D0' ? 1 : 2, 'a duplicate decision records no second approval');

      const ownerState = await fixture.statePort.loadTask(fixture.task.taskId);
      assert.ok(ownerState);
      const directionBody = { expectedTaskVersion: ownerState.stateVersion, expectedControlVersion, kind: 'resume', idempotencyKey: `journey-${label}-direction` };
      const before = (await get(`/api/experiments/${attempt1.id}`)).body.result;
      const direction = await post<{ experiment: ExperimentView; receipt: ServiceControlReceipt }>(`/api/experiments/${attempt1.id}/directions`, directionBody);
      assert.equal(direction.status, 200);
      assert.equal(direction.body.result.receipt.taskId, fixture.task.taskId);
      const receipt = direction.body.result.receipt;
      const directionRef = receipt.receiptRef;
      const issuedBefore = composed.directions.length;
      const replayDirection = await post<{ experiment: ExperimentView; receipt: ServiceControlReceipt }>(`/api/experiments/${attempt1.id}/directions`, directionBody);
      assert.equal(replayDirection.body.result.receipt.receiptRef, directionRef);
      assert.equal(composed.directions.length, issuedBefore, 'a duplicate direction issues no second owner control');
      assert.equal(fixture.modelCalls.length, label === 'D0' ? 2 : 3, 'issuing a direction alone resumes nothing');
      assert.equal(before.version + 1, direction.body.result.experiment.version);

      const staleContinue = await post(`/api/experiments/${attempt1.id}/continue`, { expectedVersion: before.version, directionRef, idempotencyKey: `journey-${label}-stale` });
      assert.deepEqual([staleContinue.status, staleContinue.body], [409, { ok: false, error: 'STALE_VERSION' }]);
      assert.equal(fixture.modelCalls.length, label === 'D0' ? 2 : 3, 'a stale continue runs nothing');
      const continueBody = { expectedVersion: direction.body.result.experiment.version, directionRef, idempotencyKey: `journey-${label}-continue` };
      const continued = await post(`/api/experiments/${attempt1.id}/continue`, continueBody);
      assert.equal(continued.status, 200);
      assert.deepEqual(fixture.modelCalls, afterModelCalls);
      const replayContinue = await post(`/api/experiments/${attempt1.id}/continue`, continueBody);
      assert.equal(replayContinue.body.result.experiment.version, continued.body.result.experiment.version);
      assert.deepEqual(fixture.modelCalls, afterModelCalls, 'a duplicate continue makes no second model call');
      const experiment = continued.body.result.experiment;
      assert.equal(experiment.taskId, fixture.task.taskId);
      assert.equal(experiment.runId, attempt1.runId);
      return { experiment, controlVersion: receipt.controlVersion };
    };
    const d0 = await decideAndContinue('D0', 0, ['coder:propose-plan', 'coder:propose-plan', 'coder:propose-patch']);
    assert.equal(d0.experiment.status, 'waiting-approval');
    const d0Milestones = (d0.experiment as unknown as { milestones?: readonly Record<string, unknown>[] | null }).milestones;
    assert.ok(Array.isArray(d0Milestones), 'D0 continuation displays persisted milestones');
    const d0Kinds = d0Milestones.map(entry => entry['kind']);
    assert.ok(d0Kinds.includes('plan_proposed'), 'D0 milestones include plan_proposed');
    assert.ok(d0Kinds.includes('patch_applied'), 'D0 milestones include patch_applied');
    for (const entry of d0Milestones) {
      assert.deepEqual(Object.keys(entry).sort(), ['kind', 'node', 'outcome', 'summary', 'timestamp']);
    }
    const d1 = await decideAndContinue('D1', d0.controlVersion, ['coder:propose-plan', 'coder:propose-plan', 'coder:propose-patch']);
    const d1Milestones = (d1.experiment as unknown as { milestones?: readonly Record<string, unknown>[] | null }).milestones;
    assert.ok(Array.isArray(d1Milestones), 'delivered experiment displays persisted milestones');
    const d1Kinds = d1Milestones.map(entry => entry['kind']);
    assert.ok(d1Kinds.includes('verification_completed'), 'delivered milestones include verification_completed');
    assert.ok(d1Kinds.includes('review_completed'), 'delivered milestones include review_completed');
    const report = d1.experiment.workflowReport;
    assert.ok(report);
    assert.equal(d1.experiment.status, 'completed');
    assert.equal(report.cases[0]?.workflowOutcome, 'COMPLETED');
    assert.equal(report.cases[0]?.grade, 'pass');
    assert.equal(report.cases[0]?.gradeReason, 'criteria-satisfied');
    assert.equal(report.isRealVerified, false);
    assert.equal(report.suiteAcceptance.outcome, 'incomplete');
    assert.deepEqual((await get(`/api/experiments/${attempt1.id}`)).body.result.workflowReport, report, 'the page reads the same live-service report');
    assert.equal(fixture.route.repositoryPort.patches.length, 1);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes('C:/'), false);
    assert.equal(serialized.includes('controlled-journey-key'), false);
    assert.equal(serialized.includes(TOKEN), false);

    // --- Attempt 2 and live comparison ----------------------------------------------------------
    // The delivered owner task cannot be re-run: the graph fails closed and the service reports that
    // observation as-is (no task identity, ungraded). Nothing here fabricates a CaseResult or reruns for reporting.
    const modelCallsBefore = fixture.modelCalls.length;
    const second = await post('/api/experiments', { profileId: profile.profileId, idempotencyKey: 'journey-attempt-2', source: { kind: 'catalog', caseIds: ['C01'] } });
    assert.equal(second.status, 200);
    const attempt2 = second.body.result.experiment;
    assert.notEqual(attempt2.id, attempt1.id);
    assert.equal(attempt2.status, 'implemented-unverified');
    assert.equal(attempt2.taskId, null);
    assert.equal((attempt2 as unknown as { milestones?: unknown }).milestones, null, 'blocked repeat attempt reports no milestones');
    assert.equal(attempt2.workflowReport?.cases[0]?.grade, 'not-run');
    assert.equal(fixture.modelCalls.length, modelCallsBefore, 'the second attempt made no model call');
    assert.equal(fixture.route.repositoryPort.patches.length, 1, 'the second attempt applied no patch');

    const compare = await post<WorkflowComparisonReport>('/api/comparisons', { idempotencyKey: 'journey-compare', baselineId: attempt1.id, candidateId: attempt2.id, policy: 'guarded' });
    assert.equal(compare.status, 200);
    assert.equal(compare.body.result.compatible, true, 'same case, grader and configuration across both live reports');
    assert.deepEqual(compare.body.result.failedGuards, []);
    assert.deepEqual(compare.body.result.unverifiedGuards, []);
    assert.equal(compare.body.result.verdict, 'REGRESSED', 'a completed pass followed by a not-run attempt is a regression, not a pass');

    // Unknown or report-less experiments refuse; the ended custom intake never produced a report.
    for (const [key, baselineId] of [
      ['journey-compare-unknown', 'exp-missing'],
      ['journey-compare-noreport', custom.id],
    ] as const) {
      const refused = await post('/api/comparisons', { idempotencyKey: key, baselineId, candidateId: attempt1.id, policy: 'guarded' });
      assert.deepEqual([refused.status, refused.body], [404, { ok: false, error: 'WORKFLOW_REPORT_NOT_FOUND' }]);
    }
    assert.equal(composed.approvalEffects.length, 2, 'approvals were recorded exactly once per owner decision across the whole journey');
    assert.equal(composed.directions.length, 2, 'owner control issued exactly the two explicit directions');
  });
});
