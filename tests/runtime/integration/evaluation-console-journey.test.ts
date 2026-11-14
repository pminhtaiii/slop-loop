/**
 * T037 controlled HTTP journey over ONE composed console host (host -> graph -> service -> loopback server).
 *
 * Every adapter is controlled/mock, no browser drives the page and the process never restarts: this
 * is controlled loopback-HTTP evidence only, never actual-browser, real-provider or restart acceptance.
 * It reuses the T030 controlled traversal (generated plan, D0/D1 owner approvals, independent grade).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSnapshotGrader } from '../../../eval/uc03/workflow-grade.ts';
import type { EvaluationGraderExecutionRequest, EvaluationGradingAdmissionRequest } from '../../../eval/uc03/types.ts';
import { computeCanonicalSha256, computeCheckSetDigest, type StateTransitionOptions } from '../../../src/contracts/foundation/uc03.ts';
import { admitEvaluationProfile, type CatalogEntry } from '../../../src/runtime/evaluation-profile.ts';
import { createEvaluationConsoleHost, type EvaluationConsoleAssembly } from '../../../src/runtime/evaluation-console-host.ts';
import type { ExperimentReceipt, ExperimentView, ServiceControlReceipt } from '../../../src/runtime/evaluation-service.ts';
import type { WorkflowComparisonReport } from '../../../eval/uc03/compare.ts';
import { prepareControlledUC03Host } from '../../../src/runtime/uc03-host-bootstrap.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import type { UC03CompletionContextRequest, UC03TrustedCompletion } from '../../../src/uc03/graph-types.ts';
import { controlledGeneratedPlanFixture } from '../support/uc03/controlled-host-journey.ts';

const TOKEN = 'controlled-journey-operator-token';
const CHECK_SET = 'checks-configured';

/** Success envelope of the console wire; error bodies are compared whole, never field-read. */
type ConsoleEnvelope<T> = Readonly<{ ok: true; result: T }>;

/** The journey's most common reply: one experiment and the receipt that produced it. */
type ExperimentReply = Readonly<{ experiment: ExperimentView; receipt: ExperimentReceipt }>;

async function composeControlledConsole() {
  const completionContexts = new Map<number, NonNullable<StateTransitionOptions['trusted']>>();
  const fixture = await controlledGeneratedPlanFixture({ transitionContextFor: next => completionContexts.get(next.stateVersion) });
  const files = mkdtempSync(join(tmpdir(), 'uc03-console-journey-'));
  const fixturePath = join(files, 'case.json');
  const graderPath = join(files, 'grader.json');
  writeFileSync(fixturePath, '{}', 'utf8');
  writeFileSync(graderPath, '{}', 'utf8');
  const entry: CatalogEntry = {
    catalogEntryId: 'entry-C01-journey',
    caseId: 'C01',
    version: '1.0.0',
    caseDigest: sha256Text('journey-case'),
    publicTaskDigest: sha256Text('journey-task'),
    initialRepositoryDigest: fixture.task.initialRevisionDigest.replace(/^sha256:/u, ''),
    fixturePath,
    fixtureDigest: sha256Text('journey-fixture'),
    grader: { version: '1.0.0', digest: sha256Text('journey-grader'), path: graderPath },
  };
  const admitted = admitEvaluationProfile({
    endpoint: 'https://api.deepseek.com/v1/messages',
    model: 'controlled-model',
    mode: 'nonstreaming',
    credentialRef: 'controlled-journey-key',
    codeDigest: sha256Text('journey-code'),
    configDigest: sha256Text('journey-config'),
    imageDigest: `sha256:${sha256Text('journey-image')}`,
    platform: 'linux/amd64',
    adapterVersions: ['controlled-journey-adapter-1'],
    pricing: { pricingId: 'journey-price-1', inputRate: 1, outputRate: 1, cacheRate: 0, overheadRate: 0, denominator: 1 },
    limits: {
      totalModelCalls: 24,
      inputTokensPerRequest: 32768,
      outputTokensPerRequest: 8192,
      providerTimeoutMs: 60000,
      activeExecutionMs: 900000,
      repairs: 2,
      reviewerIterations: 2,
      materialReplans: 3,
      commandTimeoutMs: 30000,
      outputBytes: 1048576,
      memoryBytes: 2147483648,
      cpus: 2,
      processes: 64,
    },
    catalog: [entry],
  });
  assert.ok(admitted.ok, admitted.ok ? '' : admitted.reasonCode);
  const profile = admitted.value;
  const configuration = {
    identity: { profileId: profile.profileId, profileDigest: profile.profileDigest, configDigest: profile.configDigest, pricingDigest: profile.pricingDigest },
    profileDigest: profile.profileDigest,
    configDigest: profile.configDigest,
    pricingDigest: profile.pricingDigest,
    requestedModel: profile.model,
    adapterVersions: profile.adapterVersions,
  };
  const readiness = prepareControlledUC03Host({ ...fixture.host.inputs, identity: configuration.identity, config: { ...fixture.host.inputs.config, generation: undefined } });
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') throw new Error('Controlled readiness was refused');

  // Owner completion record minted from the live Review result, as in the T030 traversal.
  Object.assign(readiness.config, {
    async completionContextFor(input: UC03CompletionContextRequest): Promise<UC03TrustedCompletion | undefined> {
      const record: UC03TrustedCompletion = {
        taskId: input.task.taskId,
        runId: input.state.runId,
        repositoryRevisionDigest: input.state.repositoryRevisionDigest,
        diffDigest: input.diffInfo.diffDigest,
        checkSetDigest: input.checkSetDigest,
        baselineRef: input.baseline.evidenceId,
        criteriaDigest: computeCanonicalSha256(input.task.acceptanceCriteria),
        authorizedDiffDigest: input.diffInfo.diffDigest,
        protectedTestsDigest: input.protectedTestsDigest,
        originalProtectedTestsDigest: input.originalProtectedTestsDigest,
        reviewerRoleConfigId: input.reviewResult.reviewerRoleConfigId,
        reviewIterationReservationRef: input.reviewRequest.reservationRef,
        checks: input.verificationResults,
        review: input.reviewResult,
      };
      const prior = completionContexts.get(input.state.stateVersion);
      if (prior) return structuredClone(prior.completion);
      completionContexts.set(input.state.stateVersion, { completion: structuredClone(record) });
      return record;
    },
  });

  const finalTreeFor = async (binding: { taskId: string; runId: string; workspaceId: string; repositoryId: string; initialRevisionDigest: string; finalRevisionDigest: string }) => {
    const source = await fixture.route.repositoryPort.readFile('src/calculator.py');
    const snapshot = await readiness.ports.hostAuthority.loadSnapshot({
      taskId: binding.taskId,
      workspaceId: binding.workspaceId,
      repositoryId: binding.repositoryId,
      expectedRevisionDigest: binding.finalRevisionDigest,
      expectedCriteriaDigest: computeCanonicalSha256(fixture.task.acceptanceCriteria),
      expectedCheckSetDigest: computeCheckSetDigest(fixture.task.requiredChecks),
      expectedTestFiles: ['tests/test_calculator.py'],
    });
    const protectedTest = snapshot?.testFiles.find(file => file.path === 'tests/test_calculator.py');
    assert.ok(protectedTest);
    return {
      ...binding,
      snapshotId: `full.tree.${binding.finalRevisionDigest.replace(/^sha256:/u, '')}`,
      complete: true as const,
      files: [
        { path: 'src/calculator.py', content: source.boundedExcerpt },
        { path: protectedTest.path, content: protectedTest.content },
      ],
    };
  };
  const grader = createSnapshotGrader({
    criteria: {
      digest: `sha256:${sha256Text('journey-criteria')}`,
      criteria: [{ criterionId: 'criterion-C01-journey', caseId: 'C01', predicate: 'repair-success', hiddenCheckId: 'hidden-C01-journey' }],
    },
    profile: {
      profileId: 'controlled-journey-grader',
      digest: `sha256:${sha256Text('journey-grader-profile')}`,
      bounds: { timeoutMs: 10_000, maxCpuMs: 5_000, maxOutputBytes: 65_536, maxMemoryBytes: 536_870_912, maxProcesses: 8 },
    },
    isolationAuthority: {
      admit: (request: EvaluationGradingAdmissionRequest) => ({
        kind: 'injected-mock-isolation-admission',
        admissionId: sha256Text(`mock-isolation-${request.finalSnapshot.digest}`),
        checkId: request.checkId,
        finalSnapshot: request.finalSnapshot,
        profile: request.profile,
        executorId: request.executorId,
      }),
    },
    executor: {
      executorId: 'controlled-journey-hidden-check',
      execute: (request: EvaluationGraderExecutionRequest) => ({
        checkId: request.checkId,
        finalSnapshot: request.finalSnapshot,
        profile: request.profile,
        executorId: request.executorId,
        status: 'pass' as const,
        actualOutcome: 'COMPLETED' as const,
        durationMs: 1,
        cpuMs: 1,
        outputBytes: 1,
      }),
    },
    graderPayload: null,
  });

  // Controlled approval port over the owner's scripted approval; records every effect it performs.
  const approvals = fixture.route.approvalPort;
  const decided = new Set<string>();
  const approvalEffects: string[] = [];
  const directions: { expectedTaskVersion: number; expectedControlVersion: number }[] = [];
  let routeCalls = 0;
  const assembly: EvaluationConsoleAssembly = {
    profile,
    catalog: [entry],
    repositoryIds: [fixture.task.repositoryId],
    checkSetIds: [CHECK_SET],
    control: {
      async issue(input) {
        const ownerState = await fixture.statePort.loadTask(fixture.task.taskId);
        assert.equal(ownerState?.stateVersion, input.expectedTaskVersion);
        directions.push({ expectedTaskVersion: input.expectedTaskVersion, expectedControlVersion: input.expectedControlVersion });
        return { receiptRef: `journey-direction-${directions.length}`, kind: input.kind, taskId: fixture.task.taskId, controlVersion: input.expectedControlVersion + 1 };
      },
    },
    approval: {
      presentation() {
        const pending = approvals.getRecordedBindings().at(-1);
        if (!pending) return { ok: false, status: 'not-found', reasonCode: 'NO_PRESENTATION' };
        return { ok: true, value: { taskId: pending.taskId, decisionId: pending.decisionId, actionKind: pending.actionKind, status: decided.has(pending.decisionId) ? 'decided' : pending.status } };
      },
      async decide(input) {
        const body = input as { decisionId?: unknown; choice?: unknown };
        const pending = approvals.getRecordedBindings().at(-1);
        if (!pending || body.decisionId !== pending.decisionId) return { ok: false, status: 'conflict', reasonCode: 'STALE_DECISION' };
        if (decided.has(pending.decisionId)) return { ok: false, status: 'conflict', reasonCode: 'DECISION_ALREADY_RECORDED' };
        if (body.choice !== 'approve') return { ok: false, status: 'invalid-input', reasonCode: 'UNSUPPORTED_CHOICE' };
        const snapshot = await fixture.statePort.readVerificationAuthoritySnapshot(fixture.task.taskId);
        assert.ok(snapshot);
        const next = { ...snapshot.policyIdentity, decisionAuthorityGeneration: snapshot.decisionAuthorityGeneration + 1 };
        assert.equal((await fixture.statePort.publishAuthority({ authorityRef: next })).status, 'published');
        approvals.setV02AuthorityRef(next);
        approvals.scriptDecision({ ...pending, status: 'approved' });
        decided.add(pending.decisionId);
        approvalEffects.push(pending.decisionId);
        // The route scripts the pre-patch reproduction as failing; after the patch the same command passes.
        if (pending.decisionId.startsWith('dec-verify-')) {
          fixture.route.repositoryPort.setCommandResult('pytest -q tests/test_calculator.py -k test_divide_zero', { exitCode: 0, stdout: '1 passed', stderr: '' });
        }
        return { ok: true, value: { decisionId: pending.decisionId, status: 'approved' } };
      },
    },
    routesFor(ready, catalog) {
      routeCalls += 1;
      return new Map([
        [
          'C01',
          {
            entry: catalog[0],
            readiness: ready,
            coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
            expectedWait: null,
            workflowReport: {
              profileDigest: profile.profileDigest,
              configDigest: profile.configDigest,
              pricingDigest: profile.pricingDigest,
              adapterVersions: profile.adapterVersions,
              requestedModel: profile.model,
              timestamp: '2026-11-13T00:00:00.000Z',
              workflowEvidence: {
                grader,
                finalTree: {
                  async freezeFinalTree(binding: Parameters<typeof finalTreeFor>[0]) {
                    return finalTreeFor(binding);
                  },
                  async recheckCurrentFinalTree(binding: Parameters<typeof finalTreeFor>[0]) {
                    return finalTreeFor(binding);
                  },
                },
              },
            },
            resolveTask: () => fixture.task,
            resolveDirection: () => undefined,
          },
        ],
      ]);
    },
    operatorToken: () => TOKEN,
  };
  return { files, fixture, profile, configuration, readiness, assembly, approvalEffects, directions, counters: () => ({ routeCalls }) };
}

test('controlled HTTP journey: one composed console host drives intake, approval, continuation, report and comparison', async () => {
  const composed = await composeControlledConsole();
  const { fixture, profile } = composed;
  const started = await createEvaluationConsoleHost(composed.readiness, composed.configuration, () => composed.assembly);
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const origin = `http://${started.host.address.host}:${started.host.address.port}`;
  const headers = { 'content-type': 'application/json', origin, 'x-operator-token': TOKEN };
  const get = async <T = ExperimentView>(path: string) => {
    const response = await fetch(`${origin}${path}`);
    return { status: response.status, body: (await response.json()) as ConsoleEnvelope<T> };
  };
  const post = async <T = ExperimentReply>(path: string, body: unknown) => {
    const response = await fetch(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as ConsoleEnvelope<T> };
  };
  try {
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
    const d1 = await decideAndContinue('D1', d0.controlVersion, ['coder:propose-plan', 'coder:propose-plan', 'coder:propose-patch']);
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
  } finally {
    await started.host.close();
    await rm(composed.files, { recursive: true, force: true });
  }
});
