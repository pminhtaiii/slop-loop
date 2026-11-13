import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createWorkflowDriver, type WorkflowCaseHost } from '../../../eval/uc03/workflow-driver.ts';
import { createSnapshotGrader } from '../../../eval/uc03/workflow-grade.ts';
import { runEvaluation } from '../../../eval/uc03/runner.ts';
import { WORKFLOW_EVALUATION_VERSION, type EvaluationGraderExecutionRequest, type EvaluationGradingAdmissionRequest } from '../../../eval/uc03/types.ts';
import { runEvaluateCli, type EvaluateCliOptions } from '../../../src/cli/evaluate.ts';
import { computeFileDigest } from '../../../src/foundation/docker-workspace-policy.ts';
import { createGuardedReadCapability, type GuardedReadControlObservation } from '../../../src/foundation/guarded-read-capability.ts';
import { createBaselineEvidenceAdapter } from '../../../src/runtime/baseline-evidence-adapter.ts';
import { admitEvaluationProfile } from '../../../src/runtime/evaluation-profile.ts';
import { createEvaluationService } from '../../../src/runtime/evaluation-service.ts';
import { createUC03EvaluationGraph } from '../../../src/runtime/evaluation-graph.ts';
import type { OwnerDelivery } from '../../../src/runtime/evaluation-composition.ts';
import { createRepositoryBaselineSource } from '../../../src/runtime/repository-baseline-source.ts';
import { prepareControlledUC03Host, prepareUC03Host } from '../../../src/runtime/uc03-host-bootstrap.ts';
import { createProductionRoute, runControlledUC03GraphV02, runUC03GraphV02 } from '../../../src/uc03/graph-v02.ts';
import {
  REQUIRED_PORTS_V02_METHODS,
  UC03_PRODUCTION_COMPONENTS_V02,
  type MaterialReplanRequestV02,
  portDeclarationsV02,
  type UC03GraphConfigV02,
  type UC03GraphPortsV02,
  type UC03ProductionComponentV02,
} from '../../../src/uc03/graph-types-v02.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { computeCanonicalSha256, computeCheckSetDigest, type ApprovalBinding, type StateTransitionOptions } from '../../../src/contracts/foundation/uc03.ts';
import { validateTaskState } from '../../../src/contracts/foundation/uc03.ts';
import type { UC03CompletionContextRequest, UC03TrustedCompletion } from '../../../src/uc03/graph-types.ts';
import { isSafeStorageId } from '../../../src/persistence/store.ts';
import { askClarification, recordClarificationAnswer } from '../../../src/uc03/clarification.ts';
import { createFixtureBugTask, createFixtureTaskState } from '../support/uc03/port-fixtures.ts';
import { controlledHostFixture } from '../support/uc03/host-pipeline-fixtures.ts';
import { assertControlledPlanApprovalPatchBarrier, controlledCompletionContext, controlledGeneratedPlanFixture, type ControlledReviewVerdict } from '../support/uc03/controlled-host-journey.ts';

const CONTRACT = 'uc03-owner-delivery/1';
const REV = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const POLICY = `sha256:${'c'.repeat(64)}`;
const HOST_COMPONENTS = ['guardedRead', 'baselineEvidence', 'hostAuthority', 'contextSource'] as const;
const OWNER_COMPONENTS = UC03_PRODUCTION_COMPONENTS_V02.filter(component => !(HOST_COMPONENTS as readonly string[]).includes(component));

const CALLS: string[] = [];
const recording =
  (component: string, method: string): (() => undefined) =>
  () => {
    CALLS.push(`${component}.${method}`);
    return undefined;
  };
const reset = (): void => {
  CALLS.length = 0;
};

function delivery(component: UC03ProductionComponentV02, adapterProvenance: 'real' | 'mock' = 'real'): OwnerDelivery {
  const adapter = {
    provenance: adapterProvenance,
    ...portDeclarationsV02(component),
    ...Object.fromEntries(REQUIRED_PORTS_V02_METHODS[component].map(method => [method, recording(component, method)])),
  };
  return { component, id: `${component}-id`, contractVersion: CONTRACT, revision: REV, provenance: 'real', adapter } as OwnerDelivery;
}

const PRODUCERS = {
  guardedRead: { provenance: 'real', mediateRead: recording('guardedRead', 'mediateRead') },
  baselineEvidence: { provenance: 'real', persistBaselineEvidence: recording('baselineEvidence', 'persist'), loadBaselineEvidence: recording('baselineEvidence', 'load') },
  hostAuthority: { loadSnapshot: recording('hostAuthority', 'loadSnapshot') },
  contextSource: { provenance: 'real', observe: recording('contextSource', 'observe') },
} as never;

const IDENTITY = { profileId: 'profile-001', profileDigest: DIGEST, configDigest: DIGEST, pricingDigest: DIGEST };
const PINS = { contractVersion: CONTRACT, revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, REV])) };
const CONFIG: UC03GraphConfigV02 = {
  trustedExpectedContext: {
    taskId: 'task-calc-001',
    workspaceId: 'workspace-001',
    repositoryId: 'repo-calc',
    revisionDigest: DIGEST,
    criteriaDigest: DIGEST,
    checkSetDigest: DIGEST,
    expectedTestFiles: ['tests/test_calculator.py'],
  },
};

function assembly(adapterProvenance: 'real' | 'mock' = 'real'): Parameters<typeof prepareUC03Host>[0] {
  return { pins: PINS, owner: OWNER_COMPONENTS.map(component => delivery(component, adapterProvenance)), producers: PRODUCERS, config: CONFIG, identity: IDENTITY };
}

function readyPorts(): UC03GraphPortsV02 {
  const readiness = prepareUC03Host(assembly());
  assert.equal(readiness.status, 'ready', JSON.stringify(readiness));
  return readiness.status === 'ready' ? readiness.ports : (undefined as never);
}

function catalogEntry(caseId: string): WorkflowCaseHost['entry'] {
  return {
    catalogEntryId: `entry-${caseId}`,
    caseId,
    version: '1.0.0',
    caseDigest: sha256Text(`case-${caseId}`),
    publicTaskDigest: sha256Text(`task-${caseId}`),
    initialRepositoryDigest: sha256Text(`repo-${caseId}`),
    fixturePath: 'C:/host-only/fixture.json',
    fixtureDigest: sha256Text(`fixture-${caseId}`),
    grader: { version: '1.0.0', digest: sha256Text(`grader-${caseId}`), path: 'C:/host-only/grader.json' },
  };
}

function admittedServiceProfile(entry: NonNullable<WorkflowCaseHost['entry']>) {
  const root = mkdtempSync(join(tmpdir(), 'uc03-service-pipeline-'));
  const fixturePath = join(root, 'case.json');
  const graderPath = join(root, 'grader.json');
  writeFileSync(fixturePath, '{}', 'utf8');
  writeFileSync(graderPath, '{}', 'utf8');
  const catalog = [{
    ...entry,
    fixturePath,
    grader: { ...entry.grader, path: graderPath },
  }];
  const raw = {
    endpoint: 'https://api.deepseek.com/v1/messages',
    model: 'controlled-model',
    mode: 'nonstreaming',
    credentialRef: 'controlled-test-key',
    codeDigest: sha256Text('controlled-service-code'),
    configDigest: sha256Text('controlled-service-config'),
    imageDigest: `sha256:${sha256Text('controlled-service-image')}`,
    platform: 'linux/amd64',
    adapterVersions: ['controlled-service-adapter-1'],
    pricing: { pricingId: 'controlled-price-1', inputRate: 1, outputRate: 1, cacheRate: 0, overheadRate: 0, denominator: 1 },
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
    catalog,
  };
  const admitted = admitEvaluationProfile(raw);
  assert.ok(admitted.ok, admitted.ok ? '' : admitted.reasonCode);
  return { profile: admitted.value, entry: catalog[0] };
}

const OPTIONS = {
  contractVersion: WORKFLOW_EVALUATION_VERSION,
  suite: 'uc03',
  profileDigest: sha256Text('profile'),
  configDigest: sha256Text('config'),
  pricingDigest: sha256Text('pricing'),
  adapterVersions: ['uc03-adapter-1'],
  requestedModel: 'controlled-model',
} as const;

test('assembly is effect-free and a controlled delivery never becomes ready', () => {
  reset();
  const readiness = prepareUC03Host(assembly());
  assert.equal(readiness.status, 'ready');
  assert.deepEqual(CALLS, [], 'no delivered method runs during assembly');

  for (const provenance of ['mock'] as const) {
    const refused = prepareUC03Host(assembly(provenance));
    assert.equal(refused.status, 'unavailable');
    if (refused.status !== 'unavailable') continue;
    assert.ok(
      refused.reasons.every(reason => reason.kind === 'component' && reason.reasonCode === 'incompatible-delivery'),
      JSON.stringify(refused.reasons),
    );
  }
  assert.deepEqual(CALLS, []);

  const missing = prepareUC03Host({ ...assembly(), owner: OWNER_COMPONENTS.slice(0, -1).map(component => delivery(component)) });
  assert.deepEqual(missing, { status: 'unavailable', reasons: [{ kind: 'component', component: OWNER_COMPONENTS.at(-1), reasonCode: 'incompatible-delivery' }] });
  const stale = prepareUC03Host({ ...assembly(), owner: OWNER_COMPONENTS.map(component => (component === 'replanPort' ? { ...delivery(component), revision: 'd'.repeat(40) } : delivery(component))) });
  assert.deepEqual(stale, { status: 'unavailable', reasons: [{ kind: 'component', component: 'replanPort', reasonCode: 'stale-revision' }] });
});

test('controlled graph generates a plan and waits for approval', async () => {
  const fixture = await controlledGeneratedPlanFixture();
  const readiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;
  const result = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  const state = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.equal(result.outcome, 'pending-approval', JSON.stringify({ reasons: result.reasons, node: state?.node, modelCalls: fixture.modelCalls }));
  assert.equal(state?.node, 'AwaitPlan');
  assert.deepEqual(fixture.modelCalls, ['coder:propose-plan', 'coder:propose-plan']);
});

test('D0 approval gates patch and pauses at D1', async () => assertControlledPlanApprovalPatchBarrier(await controlledGeneratedPlanFixture()));

/** Drive the controlled route to its post-patch `dec-verify-*` pause, then approve D1 with the bumped generation. */
async function approveD0AndD1(fixture: Awaited<ReturnType<typeof controlledGeneratedPlanFixture>>) {
  const readiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') throw new Error('Controlled host was not ready');
  await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  const d0 = fixture.route.approvalPort.getRecordedBindings().find(binding => binding.decisionId.startsWith('dec-plan-'));
  assert.ok(d0, 'owner did not issue D0');
  await bumpAuthority(fixture);
  fixture.route.approvalPort.scriptDecision({ ...d0, status: 'approved' });
  const patched = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  assert.equal(patched.outcome, 'pending-approval', JSON.stringify({ reasons: patched.reasons, modelCalls: fixture.modelCalls }));
  const d1 = fixture.route.approvalPort.getRecordedBindings().find(binding => binding.decisionId.startsWith('dec-verify-'));
  assert.ok(d1, 'owner did not issue D1');
  await bumpAuthority(fixture);
  fixture.route.approvalPort.scriptDecision({ ...d1, status: 'approved' });
  // The route scripts the pre-patch reproduction as failing; after the patch the same command passes.
  fixture.route.repositoryPort.setCommandResult('pytest -q tests/test_calculator.py -k test_divide_zero', { exitCode: 0, stdout: '1 passed', stderr: '' });
}

test('verification approval, review, and the owner completion record deliver the controlled run', async () => {
  const probe = await controlledGeneratedPlanFixture();
  await approveD0AndD1(probe);
  const probeReadiness = prepareControlledUC03Host(probe.host.inputs);
  assert.equal(probeReadiness.status, 'controlled-ready');
  if (probeReadiness.status !== 'controlled-ready') return;
  const probeResult = await runControlledUC03GraphV02(probe.task, probeReadiness.ports, probeReadiness.config);
  // The review id carries the Review-state version; the failed delivery record then advances it.
  assert.equal(
    probeResult.state?.latestReviewRef,
    `review-provider-${probe.task.taskId}-${(probeResult.state?.stateVersion ?? 0) - 1}`,
    JSON.stringify({
      reasons: probeResult.reasons,
      state: probeResult.state,
      modelCalls: probe.modelCalls,
    }),
  );
  assert.equal(probeResult.outcome, 'IMPLEMENTED_UNVERIFIED');
  // Without an owner completion record the predicate input is incomplete, so the review node never
  // reaches the field-by-field staleness comparison.
  assert.deepEqual(probeResult.reasons, [
    'Incomplete verification or review evidence for completion',
    'Independent baseline, verification, patch settlement, review, and completion authority are required',
  ]);

  // A fresh fixture reaches the same deterministic review state version; only the completion record differs.
  const fixture = await controlledGeneratedPlanFixture();
  await approveD0AndD1(fixture);
  const reviewedReadiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(reviewedReadiness.status, 'controlled-ready');
  if (reviewedReadiness.status !== 'controlled-ready') return;
  const reviewed = await runControlledUC03GraphV02(fixture.task, reviewedReadiness.ports, reviewedReadiness.config);
  assert.equal(reviewed.state?.latestReviewRef, probeResult.state?.latestReviewRef);
  assert.ok(reviewed.state, 'the review probe halted without a state');
  const reviewStateVersion = reviewed.state.stateVersion - 1;
  const deliveryStateVersion = reviewed.state.stateVersion;
  const completionContext = reviewed.state && (await controlledCompletionContext(fixture, { ...reviewed.state, stateVersion: reviewStateVersion }));
  const completed = await controlledGeneratedPlanFixture({
    transitionContexts: { [deliveryStateVersion]: completionContext },
  });
  await approveD0AndD1(completed);
  const readiness = prepareControlledUC03Host(completed.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;
  const result = await runControlledUC03GraphV02(completed.task, readiness.ports, readiness.config);

  assert.equal(result.outcome, 'COMPLETED', JSON.stringify({ reasons: result.reasons, node: result.state?.node }));
  assert.equal(result.state?.node, 'Deliver');
  assert.equal(result.state?.activeDecisionId, undefined);
  assert.equal(result.finalReport?.isComplete, true);
  assert.equal(result.finalReport?.delivery?.outcome, 'COMPLETED');
  assert.ok(result.finalReport?.evidence.reviewRef);
  assert.deepEqual(await completed.statePort.loadTask(completed.task.taskId), result.state);
  assert.equal(completed.route.repositoryPort.patches.length, 1);
  assert.equal(completed.statePort.getLedgers().find(ledger => ledger.scope === 'task' && ledger.kind === 'repair')?.consumed, 1);
  assert.equal(completed.statePort.getLedgers().find(ledger => ledger.scope === 'task' && ledger.kind === 'iteration')?.consumed, 1);

  // The protected test file is read, never written: the delivery itself must leave the sentinel intact,
  // not just the pre-patch approval barrier.
  const sentinel = await completed.route.repositoryPort.readFile('tests/test_calculator.py');
  assert.equal(sentinel.boundedExcerpt, 'def test_divide(): pass\n', 'the delivered run rewrote the protected test file');

  // Coder and reviewer charges are separate durable chains: each role's claim carries its own attempt
  // and settled outcome, and no receipt is shared across the roles.
  const journal = completed.statePort.getJournalSnapshot();
  const coderClaims = journal.claims.filter(claim => claim.claimId.startsWith('claim-controlled-'));
  const reviewerClaims = journal.claims.filter(claim => claim.claimId.startsWith('claim-provider-'));
  assert.ok(coderClaims.length > 0, JSON.stringify(journal.claims));
  assert.ok(reviewerClaims.length > 0, JSON.stringify(journal.claims));
  assert.equal(new Set([...coderClaims, ...reviewerClaims].map(claim => claim.claimId)).size, coderClaims.length + reviewerClaims.length, 'a claim is charged to both roles');
  for (const claim of [...coderClaims, ...reviewerClaims]) {
    const attempts = journal.attempts.filter(attempt => attempt.claimId === claim.claimId);
    assert.equal(attempts.length, 1, `claim ${claim.claimId} began ${attempts.length} attempts`);
    const outcomes = journal.outcomes.filter(outcome => outcome.claimId === claim.claimId);
    assert.equal(outcomes.length, 1, `claim ${claim.claimId} settled ${outcomes.length} outcomes`);
    assert.equal(outcomes[0]?.outcome, 'observed', `claim ${claim.claimId} recorded no observed outcome: ${JSON.stringify(outcomes)}`);
    assert.equal(claim.status, 'settled', `claim ${claim.claimId} is ${claim.status}, not settled`);
    assert.equal(claim.attemptId, attempts[0]?.attemptId, `claim ${claim.claimId} points at another attempt`);
  }
});

type ControlledFixture = Awaited<ReturnType<typeof controlledGeneratedPlanFixture>>;

test('the controlled EvaluationService drives one bound graph run through owner control and its independent report', async () => {
  const completionContexts = new Map<number, NonNullable<StateTransitionOptions['trusted']>>();
  const fixture = await controlledGeneratedPlanFixture({
    transitionContextFor: next => completionContexts.get(next.stateVersion),
  });
  const catalogCandidate = {
    ...catalogEntry('C01'),
    initialRepositoryDigest: fixture.task.initialRevisionDigest.replace(/^sha256:/u, ''),
  } as NonNullable<WorkflowCaseHost['entry']>;
  const { profile, entry } = admittedServiceProfile(catalogCandidate);
  assert.ok(entry);
  const readiness = prepareControlledUC03Host({
    ...fixture.host.inputs,
    identity: {
      profileId: profile.profileId,
      profileDigest: profile.profileDigest,
      configDigest: profile.configDigest,
      pricingDigest: profile.pricingDigest,
    },
    config: { ...fixture.host.inputs.config, generation: undefined },
  });
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;

  const completionContextFor = async (input: UC03CompletionContextRequest): Promise<UC03TrustedCompletion | undefined> => {
    const persisted = await fixture.statePort.loadTask(input.task.taskId);
    assert.ok(persisted);
    assert.equal(input.state.node, 'Deliver');
    assert.equal(input.state.outcome, 'COMPLETED');
    assert.equal(input.patchAdmission.context.taskId, input.task.taskId);
    assert.equal(input.patchReceipt.outcome.repositoryOperation, 'apply-patch');
    assert.equal(input.patchReceipt.settlement.outcome, 'settled');
    assert.equal(input.patchReceipt.outcome.observedResultRevisionDigest, input.state.repositoryRevisionDigest);
    assert.equal(input.reviewResult.status, 'accepted');
    assert.ok(input.verificationResults.every(result => result.outcome === 'pass'));
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
    const context = { completion: record };
    const prior = completionContexts.get(input.state.stateVersion);
    if (prior) {
      assert.equal(persisted.node, 'Deliver');
      assert.equal(persisted.stateVersion, input.state.stateVersion);
      assert.equal(computeCanonicalSha256(prior), computeCanonicalSha256(context), 'Deliver resolves the same owner-issued completion record');
      return structuredClone(prior.completion);
    }
    assert.equal(persisted.node, 'Review', 'the graph resolver reads the live owner state after the review transition');
    assert.equal(persisted.stateVersion + 1, input.state.stateVersion, 'the owner context is minted for the exact proposed Deliver CAS version');
    completionContexts.set(input.state.stateVersion, structuredClone(context));
    return structuredClone(record);
  };
  Object.assign(readiness.config, { completionContextFor });

  let freezeCalls = 0;
  let recheckCalls = 0;
  const approvedDecisionIds: string[] = [];
  const finalTreeFor = async (binding: {
    readonly taskId: string;
    readonly runId: string;
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly initialRevisionDigest: string;
    readonly finalRevisionDigest: string;
  }) => {
    const source = await fixture.route.repositoryPort.readFile('src/calculator.py');
    const hostSnapshot = await readiness.ports.hostAuthority.loadSnapshot({
      taskId: binding.taskId,
      workspaceId: binding.workspaceId,
      repositoryId: binding.repositoryId,
      expectedRevisionDigest: binding.finalRevisionDigest,
      expectedCriteriaDigest: computeCanonicalSha256(fixture.task.acceptanceCriteria),
      expectedCheckSetDigest: computeCheckSetDigest(fixture.task.requiredChecks),
      expectedTestFiles: ['tests/test_calculator.py'],
    });
    const protectedTest = hostSnapshot?.testFiles.find(file => file.path === 'tests/test_calculator.py');
    assert.ok(protectedTest, 'the trusted host snapshot should supply the protected test bytes');
    return {
      ...binding,
      snapshotId: 'full.tree.' + binding.finalRevisionDigest.replace(/^sha256:/u, ''),
      complete: true as const,
      // This fixture repository contains the implementation file and the separately host-owned
      // protected test file; both contents are captured for every exact task/run/revision binding.
      files: [
        { path: 'src/calculator.py', content: source.boundedExcerpt },
        { path: protectedTest.path, content: protectedTest.content },
      ],
    };
  };
  let hiddenExecutions = 0;
  const grader = createSnapshotGrader({
    criteria: {
      digest: 'sha256:' + sha256Text('controlled-service-criteria'),
      criteria: [{ criterionId: 'criterion-C01-service', caseId: 'C01', predicate: 'repair-success', hiddenCheckId: 'hidden-C01-service' }],
    },
    profile: {
      profileId: 'controlled-service-grader',
      digest: 'sha256:' + sha256Text('controlled-service-grader-profile'),
      bounds: { timeoutMs: 10_000, maxCpuMs: 5_000, maxOutputBytes: 65_536, maxMemoryBytes: 536_870_912, maxProcesses: 8 },
    },
    isolationAuthority: {
      admit: (request: EvaluationGradingAdmissionRequest) => ({
        kind: 'injected-mock-isolation-admission',
        admissionId: sha256Text('mock-isolation-' + request.finalSnapshot.digest),
        finalSnapshot: request.finalSnapshot,
        profile: request.profile,
        executorId: request.executorId,
      }),
    },
    executor: {
      executorId: 'controlled-service-hidden-check',
      execute(request: EvaluationGraderExecutionRequest) {
        hiddenExecutions += 1;
        return {
          finalSnapshot: request.finalSnapshot,
          profile: request.profile,
          executorId: request.executorId,
          status: 'pass' as const,
          actualOutcome: 'COMPLETED' as const,
          durationMs: 1,
          cpuMs: 1,
          outputBytes: 1,
        };
      },
    },
    graderPayload: null,
  });
  const taskResolutions: unknown[] = [];
  const graph = createUC03EvaluationGraph({
    catalogRoutes: new Map([['C01', {
      entry,
      readiness,
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
            async freezeFinalTree(binding) { freezeCalls += 1; return finalTreeFor(binding); },
            async recheckCurrentFinalTree(binding) { recheckCalls += 1; return finalTreeFor(binding); },
          },
        },
      },
      async resolveTask(input) {
        taskResolutions.push(input.priorState);
        return fixture.task;
      },
      resolveDirection: () => undefined,
    }]]),
  });
  const issuedDirections: { expectedTaskVersion: number; expectedControlVersion: number }[] = [];
  const service = createEvaluationService({
    profile,
    catalog: [entry],
    repositoryIds: [fixture.task.repositoryId],
    checkSetIds: ['controlled-checks'],
    control: {
      async issue(input) {
        const ownerState = await fixture.statePort.loadTask(fixture.task.taskId);
        assert.equal(ownerState?.stateVersion, input.expectedTaskVersion);
        issuedDirections.push({ expectedTaskVersion: input.expectedTaskVersion, expectedControlVersion: input.expectedControlVersion });
        const pending = fixture.route.approvalPort.getRecordedBindings().at(-1);
        assert.ok(pending, 'the owner approval port should have issued the current decision');
        assert.equal(pending.status, 'pending');
        await bumpAuthority(fixture);
        fixture.route.approvalPort.scriptDecision({ ...pending, status: 'approved' });
        approvedDecisionIds.push(pending.decisionId);
        if (issuedDirections.length === 2) {
          assert.equal(ownerState?.node, 'Verify');
          fixture.route.repositoryPort.setCommandResult('pytest -q tests/test_calculator.py -k test_divide_zero', { exitCode: 0, stdout: '1 passed', stderr: '' });
        }
        return {
          receiptRef: 'controlled-service-direction-' + issuedDirections.length,
          kind: input.kind,
          taskId: fixture.task.taskId,
          controlVersion: input.expectedControlVersion + 1,
        };
      },
    },
    graph,
    now: () => '2026-11-13T00:00:00.000Z',
    ids: () => 'exp-C01-controlled-service',
  });

  const started = await service.startExperiment({ source: { kind: 'catalog', caseIds: ['C01'] }, profileId: profile.profileId, idempotencyKey: 'service-C01-start' });
  assert.ok(started.ok);
  assert.equal(started.value.experiment.status, 'waiting-approval');
  assert.ok(started.value.experiment.workflowReport);
  assert.equal(started.value.experiment.workflowReport?.cases[0]?.requestedModel, profile.model);
  assert.equal(started.value.experiment.workflowReport?.cases[0]?.grade, 'not-run');
  assert.equal(started.value.experiment.workflowReport?.cases[0]?.gradeReason, 'unresolved-wait');
  assert.equal(started.value.experiment.workflowReport?.exitCode, 3);
  assert.deepEqual(fixture.modelCalls, ['coder:propose-plan', 'coder:propose-plan']);

  const firstOwnerState = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.ok(firstOwnerState);
  const firstDirection = await service.issueDirection({
    id: started.value.experiment.id,
    expectedTaskVersion: firstOwnerState.stateVersion,
    expectedControlVersion: 0,
    kind: 'resume',
    idempotencyKey: 'service-C01-d0-direction',
  });
  assert.ok(firstDirection.ok);
  assert.ok('receiptRef' in firstDirection.value.receipt);
  const afterD0 = await service.continueExperiment({
    id: started.value.experiment.id,
    expectedVersion: firstDirection.value.experiment.version,
    directionRef: firstDirection.value.receipt.receiptRef,
    idempotencyKey: 'service-C01-d0-continue',
  });
  assert.ok(afterD0.ok);
  assert.equal(afterD0.value.experiment.status, 'waiting-approval');
  assert.equal(afterD0.value.experiment.taskId, fixture.task.taskId);
  assert.equal(afterD0.value.experiment.runId, firstOwnerState.runId);
  assert.deepEqual(fixture.modelCalls, ['coder:propose-plan', 'coder:propose-plan', 'coder:propose-patch']);

  const secondOwnerState = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.ok(secondOwnerState);
  const secondDirection = await service.issueDirection({
    id: started.value.experiment.id,
    expectedTaskVersion: secondOwnerState.stateVersion,
    expectedControlVersion: firstDirection.value.receipt.controlVersion,
    kind: 'resume',
    idempotencyKey: 'service-C01-d1-direction',
  });
  assert.ok(secondDirection.ok);
  assert.ok('receiptRef' in secondDirection.value.receipt);
  const completed = await service.continueExperiment({
    id: started.value.experiment.id,
    expectedVersion: secondDirection.value.experiment.version,
    directionRef: secondDirection.value.receipt.receiptRef,
    idempotencyKey: 'service-C01-d1-continue',
  });
  assert.ok(completed.ok);
  assert.equal(completed.value.experiment.status, 'completed', JSON.stringify({ report: completed.value.experiment.workflowReport?.cases[0], state: await fixture.statePort.loadTask(fixture.task.taskId) }));
  assert.equal(completed.value.experiment.taskId, fixture.task.taskId);
  assert.equal(completed.value.experiment.runId, firstOwnerState.runId);
  assert.equal(completed.value.experiment.workflowReport?.cases[0]?.workflowOutcome, 'COMPLETED');
  assert.equal(completed.value.experiment.workflowReport?.cases[0]?.grade, 'not-run', JSON.stringify({ report: completed.value.experiment.workflowReport?.cases[0], freezeCalls, recheckCalls, hiddenExecutions }));
  assert.equal(completed.value.experiment.workflowReport?.cases[0]?.gradeReason, 'private-grading', JSON.stringify({ report: completed.value.experiment.workflowReport?.cases[0], freezeCalls, recheckCalls, hiddenExecutions }));
  assert.equal(completed.value.experiment.workflowReport?.cases[0]?.requestedModel, profile.model);
  assert.equal(completed.value.experiment.workflowReport?.cases[0]?.returnedModel, null, 'the fixture transport publishes no returned-model identity');
  assert.equal(completed.value.experiment.workflowReport?.isRealVerified, false);
  assert.equal(completed.value.experiment.workflowReport?.exitCode, 1, 'a completed repair with unbound hidden-check identity remains not-run/failure-status, not an unresolved-wait exit');
  assert.equal(fixture.route.repositoryPort.patches.length, 1);
  assert.equal(fixture.statePort.getLedgers().find(ledger => ledger.scope === 'task' && ledger.kind === 'repair')?.consumed, 1);
  assert.equal(approvedDecisionIds[0], 'dec-plan-' + fixture.task.taskId + '-1');
  assert.match(approvedDecisionIds[1] ?? '', /^dec-verify-[a-f0-9]{64}$/u, 'the second owner control approves the exact graph-issued verification decision');
  assert.equal(taskResolutions.length, 3);
  assert.equal(taskResolutions[0], null);
  assert.deepEqual(taskResolutions[1], { taskId: fixture.task.taskId, runId: firstOwnerState.runId, workspaceId: firstOwnerState.workspaceId });
  assert.deepEqual(taskResolutions[2], { taskId: fixture.task.taskId, runId: firstOwnerState.runId, workspaceId: firstOwnerState.workspaceId });
  assert.deepEqual(issuedDirections, [
    { expectedTaskVersion: firstOwnerState.stateVersion, expectedControlVersion: 0 },
    { expectedTaskVersion: secondOwnerState.stateVersion, expectedControlVersion: firstDirection.value.receipt.controlVersion },
  ]);
  assert.equal(freezeCalls, recheckCalls, 'every grade rechecks the same full final-tree capture after grading');
  assert.ok(freezeCalls >= 1);
  assert.equal(hiddenExecutions, 1, 'the controlled hidden check runs once; its unbound identity remains not-run');
  const publicReport = JSON.stringify(completed.value.experiment.workflowReport);
  assert.equal(publicReport.includes('C:/host-only'), false);
  assert.equal(publicReport.includes('controlled-test-key'), false);
  assert.equal((await fixture.statePort.loadTask(fixture.task.taskId))?.node, 'Deliver');
  assert.equal(completionContexts.size, 1, 'the actual Review result issued one target-version-bound owner context');
  const delivered = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.ok(delivered);
  const deliveredOwnerContext = completionContexts.get(delivered.stateVersion);
  assert.ok(deliveredOwnerContext?.completion);
  assert.equal(deliveredOwnerContext.completion.review.reviewId, delivered.latestReviewRef);
  assert.equal(deliveredOwnerContext.completion.repositoryRevisionDigest, delivered.repositoryRevisionDigest);
});

function controlledMaterialReplanProposal(taskId: string, proposalId = 'controlled-material-replan-1') {
  return {
    proposalId,
    content: JSON.stringify({
      kind: 'propose-plan',
      proposalId,
      diagnosis: 'The first plan needs a narrower failure explanation.',
      strategy: 'Check zero first, then raise the domain error with the specified message.',
      suspectedLocations: ['src/calculator.py'],
      scopedPaths: ['src/calculator.py'],
      evidenceRefs: [`uc04://baseline/${taskId}/1`],
    }),
  };
}

test('a live completion resolver cannot bypass the graph completion predicate', async () => {
  const fixture = await controlledGeneratedPlanFixture();
  await approveD0AndD1(fixture);
  const readiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;
  let resolverCalls = 0;
  Object.assign(readiness.config, {
    completionContextFor: async (input: UC03CompletionContextRequest): Promise<UC03TrustedCompletion | undefined> => {
      resolverCalls += 1;
      const ownerState = await fixture.statePort.loadTask(input.task.taskId);
      assert.equal(ownerState?.node, 'Review');
      if (!ownerState) return undefined;
      const ownerRecord = await controlledCompletionContext(fixture, ownerState);
      assert.ok(ownerRecord.completion);
      return { ...ownerRecord.completion, authorizedDiffDigest: 'sha256:' + sha256Text('substituted-authorized-diff') };
    },
  });

  const result = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.deepEqual(result.reasons, [
    'Incomplete verification or review evidence for completion',
    'Owner-provided completion evidence is stale or does not match the current route',
  ]);
  assert.equal(resolverCalls, 1);
  const current = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.equal(current?.node, 'Repair');
  assert.equal(current?.outcome, undefined);
  assert.equal(fixture.route.repositoryPort.patches.length, 1);
});

async function prepareControlledReplanResume(options: { initialReplanCount?: number; maxReplans?: number } = {}) {
  const fixture = await controlledGeneratedPlanFixture({
    initialPlanDecision: 'rejected',
    replanResponse: controlledMaterialReplanProposal('task-calc-001'),
    ...(options.initialReplanCount === undefined ? {} : { firstResponse: controlledMaterialReplanProposal('task-calc-001', 'controlled-fourth-replan-1') }),
    ...options,
  });
  const readiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') throw new Error('Controlled host was not ready');
  if (options.initialReplanCount === undefined) {
    const initial = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
    assert.equal(initial.outcome, 'needs-info');
  }
  const feedback = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.ok(feedback?.plan?.decisionRef);
  assert.equal(feedback.node, 'AwaitFeedback');
  const direction = {
    directive: 'revise' as const,
    taskId: feedback.taskId,
    workspaceId: feedback.workspaceId,
    repositoryRevisionDigest: feedback.repositoryRevisionDigest,
    stateVersion: feedback.stateVersion,
    planVersion: feedback.planVersion,
    rejectedDecisionId: feedback.plan.decisionRef,
    strategyDigest: feedback.plan.strategyDigest,
  };
  Object.assign(readiness.config, { trustedDirection: direction });
  return { fixture, readiness, feedback, direction };
}

test('a generated material replan reaches the controlled owner transaction and waits for renewed approval', async () => {
  const transitionContexts = new Map<number, NonNullable<StateTransitionOptions['trusted']>>();
  const fixture = await controlledGeneratedPlanFixture({
    initialPlanDecision: 'rejected',
    replanResponse: {
      proposalId: 'controlled-material-replan-1',
      content: JSON.stringify({
        kind: 'propose-plan',
        proposalId: 'controlled-material-replan-1',
        diagnosis: 'The first plan needs a narrower failure explanation.',
        strategy: 'Check zero first, then raise the domain error with the specified message.',
        suspectedLocations: ['src/calculator.py'],
        scopedPaths: ['src/calculator.py'],
        evidenceRefs: ['uc04://baseline/task-calc-001/1'],
      }),
    },
    transitionContextFor: next => transitionContexts.get(next.stateVersion),
  });
  const readiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;

  const rejected = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  assert.equal(rejected.outcome, 'needs-info');
  const feedback = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.ok(feedback?.plan?.decisionRef);
  assert.equal(feedback.node, 'AwaitFeedback');
  const direction = {
    directive: 'revise' as const,
    taskId: feedback.taskId,
    workspaceId: feedback.workspaceId,
    repositoryRevisionDigest: feedback.repositoryRevisionDigest,
    stateVersion: feedback.stateVersion,
    planVersion: feedback.planVersion,
    rejectedDecisionId: feedback.plan.decisionRef,
    strategyDigest: feedback.plan.strategyDigest,
  };
  Object.assign(readiness.config, { trustedDirection: direction });

  let ownerAccepts = 0;
  let ownerFailure: string | undefined;
  Object.assign(readiness.ports, {
    replanPort: {
      provenance: 'mock' as const,
      async accept(request: MaterialReplanRequestV02) {
        ownerAccepts += 1;
        try {
        const current = await fixture.statePort.loadTask(request.taskId);
        assert.ok(current);
        assert.equal(current.node, 'AwaitFeedback');
        assert.equal(current.stateVersion, request.priorStateVersion);
        assert.equal(current.runId, request.runId);
        assert.equal(current.planVersion, request.priorPlanVersion);
        assert.equal(current.replanCount, request.priorReplanCount);
        assert.equal(computeCanonicalSha256(request.candidatePlan), request.candidatePlanDigest);

        const reservationId = await fixture.statePort.getUnderlying().reserve('task', 'replan', 1, request.proposalId);
        const renewedDecisionId = `renewed-${sha256Text(request.proposalId).slice(0, 24)}`;
        const planWithoutDecision = {
          ...request.candidatePlan,
          planVersion: request.priorPlanVersion + 1,
          decisionRef: undefined,
        };
        const trustedReplan = {
          replanReservation: {
            proposalId: request.proposalId,
            taskId: current.taskId,
            configurationId: fixture.task.configId,
            priorCount: request.priorReplanCount,
            nextCount: request.expectedNextReplanCount,
            reservationId,
          },
        };
        const investigate = {
          ...current,
          stateVersion: current.stateVersion + 1,
          node: 'Investigate' as const,
          nextAction: 'propose-fix-plan',
          planVersion: planWithoutDecision.planVersion,
          plan: planWithoutDecision,
          activeDecisionId: undefined,
          latestReviewRef: undefined,
          reviewRefs: [],
          replanCount: request.expectedNextReplanCount,
          budgetLedgers: fixture.statePort.getLedgers(),
        };
        transitionContexts.set(investigate.stateVersion, trustedReplan);
        const investigated = await fixture.statePort.transition(investigate, current.stateVersion);
        const renewedPlan = { ...planWithoutDecision, decisionRef: renewedDecisionId };
        const pendingBinding: ApprovalBinding = {
          decisionId: renewedDecisionId,
          actionKind: 'fix_plan',
          normalizedActionDigest: computeCanonicalSha256({
            actionId: renewedDecisionId,
            kind: 'approve_fix_plan',
            planVersion: renewedPlan.planVersion,
            strategyDigest: renewedPlan.strategyDigest,
            diagnosisEvidenceRefs: renewedPlan.evidenceRefs,
            checkSetDigest: renewedPlan.checkSetDigest,
          }),
          taskId: current.taskId,
          workspaceId: current.workspaceId,
          repositoryRevisionDigest: current.repositoryRevisionDigest,
          policyId: fixture.task.configId,
          policyVersion: fixture.task.configVersion,
          planVersion: renewedPlan.planVersion,
          strategyDigest: renewedPlan.strategyDigest,
          baselineRef: renewedPlan.baselineRef,
          evidenceRefs: renewedPlan.evidenceRefs,
          criteriaDigest: computeCanonicalSha256(fixture.task.acceptanceCriteria),
          checkSetDigest: renewedPlan.checkSetDigest,
          status: 'pending' as const,
        };
        fixture.route.approvalPort.scriptDecision(pendingBinding);
        assert.equal(pendingBinding.status, 'pending');

        const next = {
          ...investigated,
          stateVersion: investigated.stateVersion + 1,
          node: 'AwaitPlan' as const,
          nextAction: 'approve-fix-plan',
          planVersion: renewedPlan.planVersion,
          plan: renewedPlan,
          activeDecisionId: renewedDecisionId,
          latestReviewRef: undefined,
          reviewRefs: [],
          replanCount: request.expectedNextReplanCount,
          budgetLedgers: fixture.statePort.getLedgers(),
        };
        transitionContexts.set(next.stateVersion, trustedReplan);
        const saved = await fixture.statePort.transition(next, investigated.stateVersion);
        return {
          outcome: 'accepted' as const,
          state: saved,
          reservationReceipt: reservationId,
          transitionReceipt: `transition-${request.proposalId}`,
        };
        } catch (error) {
          ownerFailure = error instanceof Error ? error.message : String(error);
          throw error;
        }
      },
    },
  });

  const replanned = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config, feedback);
  assert.equal(replanned.outcome, 'pending-approval', JSON.stringify({ outcome: replanned.outcome, reasons: replanned.reasons, state: replanned.state, ownerFailure }));
  assert.equal(replanned.state?.node, 'AwaitPlan');
  assert.equal(replanned.state?.planVersion, feedback.planVersion + 1);
  assert.equal(replanned.state?.replanCount, feedback.replanCount + 1);
  assert.notEqual(replanned.state?.activeDecisionId, feedback.activeDecisionId);
  assert.equal(ownerAccepts, 1, 'the graph reaches the controlled owner material-replan transaction once');
  assert.equal(fixture.modelCalls.at(-1), 'coder:propose-replan');
  assert.equal(fixture.coderAdmissions.length, 3);
  assert.equal(fixture.route.repositoryPort.patches.length, 0);
  assert.equal(fixture.route.repositoryPort.commands.length, 2, 'the replan proposal adds no command effects after initial baseline investigation');
  const replanLedger = fixture.statePort.getLedgers().find(ledger => ledger.scope === 'task' && ledger.kind === 'replan');
  assert.equal(replanLedger?.reservations.filter(reservation => reservation.keyedId.startsWith('replan-')).length, 1);
  assert.equal(replanLedger?.consumed, 0, JSON.stringify(replanLedger));
});

test('generated replan owner denial and uncertainty preserve the paused owner state and replan accounting', async t => {
  for (const outcome of [
    { name: 'content conflict', result: { outcome: 'denied' as const, reason: 'replan-idempotency-content-conflict' }, reason: 'replan-idempotency-content-conflict' },
    { name: 'uncertain reply', result: { outcome: 'uncertain' as const, operationRef: 'replan-operation-uncertain-1' }, reason: 'replan-operation-uncertain-1' },
  ]) {
    await t.test(outcome.name, async () => {
      const { fixture, readiness, feedback, direction } = await prepareControlledReplanResume();
      const requests: MaterialReplanRequestV02[] = [];
      Object.assign(readiness.ports, {
        replanPort: {
          provenance: 'mock' as const,
          async accept(request: MaterialReplanRequestV02) {
            requests.push(request);
            return outcome.result;
          },
        },
      });

      const result = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config, feedback);
      assert.equal(result.outcome, 'INCOMPLETE');
      assert.ok(result.reasons.includes(outcome.reason), JSON.stringify(result.reasons));
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0]?.direction, direction);
      const current = await fixture.statePort.loadTask(fixture.task.taskId);
      assert.equal(current?.node, 'AwaitFeedback');
      assert.equal(current?.stateVersion, feedback.stateVersion);
      assert.equal(current?.activeDecisionId, feedback.activeDecisionId);
      assert.equal(current?.replanCount, feedback.replanCount);
      const replanLedger = current?.budgetLedgers?.find(ledger => ledger.scope === 'task' && ledger.kind === 'replan');
      assert.equal(replanLedger?.consumed, feedback.replanCount);
      assert.equal(replanLedger?.reservations.length, 0);
      assert.equal(fixture.route.repositoryPort.patches.length, 0);
      assert.equal(fixture.route.repositoryPort.commands.length, 2, 'only the original baseline commands ran');
    });
  }
});

test('generated fourth replan reaches the graph cap and refuses before owner charge or repository effect', async () => {
  const { fixture, readiness, feedback } = await prepareControlledReplanResume({ initialReplanCount: 3, maxReplans: 4 });
  let ownerCalls = 0;
  Object.assign(readiness.ports, {
    replanPort: {
      provenance: 'mock' as const,
      async accept(_request: MaterialReplanRequestV02) {
        ownerCalls += 1;
        return { outcome: 'denied' as const, reason: 'must-not-reach-owner-after-budget-cap' };
      },
    },
  });

  const result = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config, feedback);
  assert.equal(result.outcome, 'INCOMPLETE');
  assert.ok(result.reasons.includes('replan-cap-exceeded-fourth-replan-refused'), JSON.stringify(result.reasons));
  assert.deepEqual(fixture.modelCalls, ['coder:propose-replan']);
  assert.equal(fixture.coderAdmissions.length, 1, 'one explicit selected revision generated the fourth proposal');
  assert.equal(ownerCalls, 0);
  const current = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.equal(current?.node, 'Incomplete');
  assert.equal(current?.replanCount, 3);
  const replanLedger = current?.budgetLedgers?.find(ledger => ledger.scope === 'task' && ledger.kind === 'replan');
  assert.equal(replanLedger?.consumed, 3);
  assert.equal(replanLedger?.reservations.length, 0);
  assert.equal(fixture.route.repositoryPort.commands.length, 0);
  assert.equal(fixture.route.repositoryPort.patches.length, 0);
});

test('a stale accepted material-replan result cannot overwrite a competing owner completion', async () => {
  const { fixture, readiness, feedback } = await prepareControlledReplanResume();
  let returnedStaleVersion: number | undefined;
  Object.assign(readiness.ports, {
    replanPort: {
      provenance: 'mock' as const,
      async accept(request: MaterialReplanRequestV02) {
        const current = await fixture.statePort.loadTask(request.taskId);
        assert.ok(current);
        returnedStaleVersion = current.stateVersion;
        const competing = await fixture.statePort.transition({
          ...current,
          stateVersion: current.stateVersion + 1,
          node: 'Incomplete',
          outcome: 'INCOMPLETE',
          nextAction: 'human-directed-termination',
          activeDecisionId: undefined,
          plan: current.plan ? { ...current.plan, decisionRef: undefined } : undefined,
          latestReviewRef: undefined,
          reviewRefs: [],
          budgetLedgers: fixture.statePort.getLedgers(),
        }, current.stateVersion);
        assert.equal(competing.node, 'Incomplete');
        return { outcome: 'accepted' as const, state: current, reservationReceipt: 'stale-owner-reservation', transitionReceipt: 'stale-owner-transition' };
      },
    },
  });

  const result = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config, feedback);
  assert.equal(result.outcome, 'INCOMPLETE');
  assert.ok(result.reasons.includes('reserved-task-state-inconsistent'), JSON.stringify(result.reasons));
  const current = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.equal(current?.node, 'Incomplete');
  assert.equal(current?.stateVersion, (returnedStaleVersion ?? feedback.stateVersion) + 1);
  assert.equal(current?.replanCount, feedback.replanCount);
  const replanLedger = current?.budgetLedgers?.find(ledger => ledger.scope === 'task' && ledger.kind === 'replan');
  assert.equal(replanLedger?.consumed, feedback.replanCount);
  assert.equal(replanLedger?.reservations.length, 0);
  assert.equal(fixture.route.repositoryPort.patches.length, 0);
});

test('controlled traversal reports actual graph recursion exhaustion after the generated plan turn', async () => {
  const fixture = await controlledGeneratedPlanFixture();
  const readiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;
  Object.assign(readiness.config, { recursionLimit: 2 });

  const result = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  assert.equal(result.outcome, 'INCOMPLETE');
  assert.deepEqual(result.reasons, ['UC-03 route stopped at the project graph recursion limit']);
  assert.equal(result.diagnostic?.reasonCode, 'graph-recursion-exhausted');
  assert.deepEqual(fixture.modelCalls, ['coder:propose-plan', 'coder:propose-plan']);
  assert.equal(fixture.route.repositoryPort.commands.length, 2, 'the baseline checks ran before the graph recursion boundary');
  assert.equal(fixture.route.repositoryPort.patches.length, 0);
  const persisted = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.equal(persisted?.node, 'AwaitPlan');
  assert.equal(persisted?.activeDecisionId, 'dec-plan-' + fixture.task.taskId + '-1');
});

/** The first review reports a finding; the second review of the repair patch accepts it. */
const REPAIR_VERDICTS: readonly ControlledReviewVerdict[] = [
  {
    status: 'findings',
    findings: [{ file: 'src/calculator.py', line: 2, side: 'new', severity: 'error', message: 'Guard message is not actionable for the operator' }],
  },
  { status: 'accepted', findings: [] },
];

async function bumpAuthority(fixture: ControlledFixture) {
  const snapshot = await fixture.statePort.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.ok(snapshot, 'owner published no authority');
  const next = { ...snapshot.policyIdentity, decisionAuthorityGeneration: snapshot.decisionAuthorityGeneration + 1 };
  assert.equal((await fixture.statePort.publishAuthority({ authorityRef: next })).status, 'published');
  fixture.route.approvalPort.setV02AuthorityRef(next);
}

/** Drive the rejecting run through D0/D1, its finding, and the repair patch's own fresh verification approval. */
async function driveRepairRound(fixture: ControlledFixture) {
  await approveD0AndD1(fixture);
  // Repair admits only through the owner classifier, which leaves an unscripted action pending.
  fixture.route.approvalPort.scriptClassification('apply_patch', 'ALLOWED');
  const readiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') throw new Error('Controlled host was not ready');
  const first = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  // The repair patch is a second owner-settled apply_patch, so it earns its own fresh post-patch
  // verification approval rather than reusing the first patch's.
  assert.equal(first.outcome, 'pending-approval', JSON.stringify({ reasons: first.reasons, node: first.state?.node, modelCalls: fixture.modelCalls }));
  const repairDecision = fixture.route.approvalPort
    .getRecordedBindings()
    .filter(binding => binding.decisionId.startsWith('dec-verify-'))
    .at(-1);
  assert.ok(repairDecision, 'owner issued no repair verification decision');
  await bumpAuthority(fixture);
  fixture.route.approvalPort.scriptDecision({ ...repairDecision, status: 'approved' });
  return runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
}

function assertRepairTraversal(fixture: ControlledFixture, repaired: Awaited<ReturnType<typeof runControlledUC03GraphV02>>) {
  // The reviewer transport is separate from the coder transport, so modelCalls tracks only coder turns.
  assert.deepEqual(fixture.modelCalls, ['coder:propose-plan', 'coder:propose-plan', 'coder:propose-patch', 'coder:propose-repair']);
  assert.equal(fixture.route.repositoryPort.patches.length, 2, JSON.stringify({ reasons: repaired.reasons, node: repaired.state?.node, modelCalls: fixture.modelCalls }));
  assert.notEqual(fixture.route.repositoryPort.patches[0]?.actionId, fixture.route.repositoryPort.patches[1]?.actionId);
  // Round two repeats the same checks against a new revision, so its verification claims must be
  // revision-scoped; reusing round one's `action-verify-<checkId>` ids would be refused by the owner
  // and the run would never reach completion. Claim ids are `claim-<actionId>`.
  const journal = fixture.statePort.getJournalSnapshot();
  const verifyClaims = journal.claims.map(claim => claim.claimId).filter(id => id.startsWith('claim-action-verify-'));
  // Every durable id the verification path derives (`claim-<actionId>`, `att-<claimId>`) must fit the
  // owner's storage-id cap. The durable adapter answers an unsafe id with a neutral receipt rather than
  // an error, so the violation would surface as an unsettleable claim, not a loud failure. This double
  // does not enforce the cap, so the assertion here is the only witness on this tier.
  const verifyClaimIds = new Set(verifyClaims);
  const durableIds = [...verifyClaimIds, ...journal.attempts.filter(attempt => verifyClaimIds.has(attempt.claimId)).map(attempt => attempt.attemptId)];
  for (const id of durableIds) assert.ok(isSafeStorageId(id), `verification id is not a safe storage id (${id.length} chars): ${id}`);
  const roundOne = verifyClaims.filter(id => /^claim-action-verify-check-/u.test(id));
  const roundScoped = verifyClaims.filter(id => /^claim-action-verify-[0-9a-f]{16}-check-/u.test(id));
  assert.ok(roundOne.length > 0, `no round-one verification claim: ${JSON.stringify(verifyClaims)}`);
  assert.ok(roundScoped.length > 0, `no revision-scoped repair verification claim: ${JSON.stringify(verifyClaims)}`);
  assert.equal(roundScoped.length, roundOne.length, `rounds ran different check counts: ${JSON.stringify(verifyClaims)}`);
}

test('a reviewer finding sends the controlled route back to Repair for a second patch', async () => {
  const probe = await controlledGeneratedPlanFixture({ reviewVerdict: REPAIR_VERDICTS });
  const probeRepaired = await driveRepairRound(probe);
  assertRepairTraversal(probe, probeRepaired);
  // Without the owner completion record the repair run halts after both patches with its evidence intact.
  assert.equal(probeRepaired.outcome, 'IMPLEMENTED_UNVERIFIED', JSON.stringify({ reasons: probeRepaired.reasons, node: probeRepaired.state?.node }));
  assert.deepEqual(probeRepaired.reasons, [
    'Incomplete verification or review evidence for completion',
    'Independent baseline, verification, patch settlement, review, and completion authority are required',
  ]);

  assert.ok(probeRepaired.state, 'the repair probe halted without a state');
  const reviewStateVersion = probeRepaired.state.stateVersion - 1;
  const deliveryStateVersion = probeRepaired.state.stateVersion;
  const completionContext = await controlledCompletionContext(probe, { ...probeRepaired.state, stateVersion: reviewStateVersion });
  const fixture = await controlledGeneratedPlanFixture({
    reviewVerdict: REPAIR_VERDICTS,
    transitionContexts: { [deliveryStateVersion]: completionContext },
  });
  const repaired = await driveRepairRound(fixture);
  assertRepairTraversal(fixture, repaired);

  assert.equal(repaired.outcome, 'COMPLETED', JSON.stringify({ reasons: repaired.reasons, node: repaired.state?.node }));
  assert.equal(repaired.state?.node, 'Deliver');
  assert.equal(repaired.finalReport?.isComplete, true);
  assert.equal(repaired.finalReport?.delivery?.outcome, 'COMPLETED');
});

test('a completion record minted before the protected-test content drifted is refused', async () => {
  // Baseline and completion both read one host authority, so a same-fixture content change moves both
  // digests together. Drift needs the completion record minted from the default-content probe and the
  // delivery run's own baseline written from different content. The digest comparison at
  // `graph-completion.ts:160-161` is the guard that fires; the traversal still completes both patches
  // because the divergence is only visible at completion.
  const probe = await controlledGeneratedPlanFixture({ reviewVerdict: REPAIR_VERDICTS });
  const probeRepaired = await driveRepairRound(probe);
  assertRepairTraversal(probe, probeRepaired);
  assert.ok(probeRepaired.state, 'the repair probe halted without a state');
  const reviewStateVersion = probeRepaired.state.stateVersion - 1;
  const deliveryStateVersion = probeRepaired.state.stateVersion;
  const completionContext = await controlledCompletionContext(probe, { ...probeRepaired.state, stateVersion: reviewStateVersion });

  const fixture = await controlledGeneratedPlanFixture({
    reviewVerdict: REPAIR_VERDICTS,
    transitionContexts: { [deliveryStateVersion]: completionContext },
    hostTestFileContent: 'def test_divide(): return None\n',
  });
  const repaired = await driveRepairRound(fixture);
  assertRepairTraversal(fixture, repaired);

  assert.equal(repaired.outcome, 'IMPLEMENTED_UNVERIFIED', JSON.stringify({ reasons: repaired.reasons, node: repaired.state?.node }));
  // The stale-evidence refusal is second, not alone: the review node's drift branch omits the digests
  // from its report input, so the report builder takes its non-evaluable branch and prepends the
  // generic reason. The second element still discriminates the refusal from the unsupplied-context
  // pair the passing test above reports ('Independent baseline, ...').
  assert.deepEqual(repaired.reasons, ['Incomplete verification or review evidence for completion', 'Owner-provided completion evidence is stale or does not match the current route']);
});

test('a long but contract-valid check id completes the repair round inside the durable id cap', async () => {
  // The repair round now scopes its action ids by only 16 hex of the revision, so a check id that a
  // 64-hex scope used to overflow must traverse both rounds and still journal safe storage ids.
  const longCheckId = `check-${'long-denominator-reproduction'.padEnd(34, '-')}`;
  assert.equal(longCheckId.length, 40);
  const fixture = await controlledGeneratedPlanFixture({ reviewVerdict: REPAIR_VERDICTS, reproductionCheckId: longCheckId });
  const repaired = await driveRepairRound(fixture);
  assertRepairTraversal(fixture, repaired);
  assert.equal(repaired.outcome, 'IMPLEMENTED_UNVERIFIED', JSON.stringify({ reasons: repaired.reasons, node: repaired.state?.node }));
  assert.deepEqual(repaired.reasons, [
    'Incomplete verification or review evidence for completion',
    'Independent baseline, verification, patch settlement, review, and completion authority are required',
  ]);
});

test('a record-free NeedsInfo pause dispatches no model call and claims nothing', async () => {
  const fixture = await controlledGeneratedPlanFixture({ taskState: { node: 'NeedsInfo', nextAction: 'request-info' } });
  const readiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;
  const claimsBefore = fixture.statePort.getJournalSnapshot().claims.length;
  const result = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  assert.equal(result.outcome, 'needs-info', JSON.stringify(result.reasons));
  assert.deepEqual(fixture.modelCalls, [], 'no transport dispatch');
  const journal = fixture.statePort.getJournalSnapshot();
  assert.equal(journal.claims.length - claimsBefore, 0, 'no new claim');
  const state = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.equal(state?.node, 'NeedsInfo');
  assert.equal(state?.clarification, undefined);
});

test('the clarification pair: an ask pauses with one claim, and an answered record resumes the coder', async () => {
  // Ask half, produced by the route: Investigate v1 -> NeedsInfo v2, asked at v1.
  const askFixture = await controlledGeneratedPlanFixture({
    firstResponse: {
      proposalId: 'controlled-ask-1',
      content: JSON.stringify({ kind: 'request-info', proposalId: 'controlled-ask-1', questions: [{ questionId: 'q-denominator', text: 'What should a zero denominator do?' }], evidenceRefs: [] }),
    },
  });
  const askReady = prepareControlledUC03Host(askFixture.host.inputs);
  assert.equal(askReady.status, 'controlled-ready');
  if (askReady.status !== 'controlled-ready') return;
  const asked = await runControlledUC03GraphV02(askFixture.task, askReady.ports, askReady.config);
  assert.equal(asked.outcome, 'needs-info', JSON.stringify(asked.reasons));
  assert.deepEqual(askFixture.modelCalls, ['coder:propose-plan'], 'the proposal alone produced the pause');
  const askedState = await askFixture.statePort.loadTask(askFixture.task.taskId);
  assert.equal(askedState?.node, 'NeedsInfo');
  assert.equal(askedState?.stateVersion, 2);
  assert.equal(askedState?.clarification?.askedAtStateVersion, 1);
  assert.equal(askedState?.clarification?.answer, undefined);
  const askRequestId = askFixture.coderAdmissions[0];
  assert.ok(askRequestId);
  assert.equal(askFixture.statePort.getJournalSnapshot().claims.filter(claim => claim.claimId === `claim-${askRequestId}`).length, 1, `exactly one claim for ${askRequestId}`);

  // Answer half, built by the producers from a seeded Investigate v1: ask v2, answer v3.
  const resumeFixture = await controlledGeneratedPlanFixture();
  const resumeReady = prepareControlledUC03Host(resumeFixture.host.inputs);
  assert.equal(resumeReady.status, 'controlled-ready');
  if (resumeReady.status !== 'controlled-ready') return;
  const seeded = await resumeFixture.statePort.loadTask(resumeFixture.task.taskId);
  assert.ok(seeded);
  assert.equal(seeded.node, 'Investigate');
  assert.equal(seeded.stateVersion, 1);
  const open = await askClarification({
    statePort: resumeFixture.statePort,
    prior: seeded,
    proposal: { kind: 'request-info', proposalId: 'controlled-ask-2', questions: [{ questionId: 'q-denominator', text: 'What should a zero denominator do?' }], evidenceRefs: [] },
  });
  assert.equal(open.replayed, false);
  assert.equal(open.state.stateVersion, 2);
  assert.equal(open.state.node, 'NeedsInfo');
  assert.equal(open.state.clarification?.askedAtStateVersion, 1);
  assert.ok(open.state.clarification);
  const answered = await recordClarificationAnswer({
    statePort: resumeFixture.statePort,
    prior: open.state,
    answer: { recorderRef: 'reporter-1', items: open.state.clarification.questions.map(question => ({ questionId: question.questionId, text: 'raise a guarded error' })) },
  });
  assert.equal(answered.replayed, false);
  assert.equal(answered.state.node, 'Investigate');
  assert.equal(answered.state.stateVersion, 3);
  assert.equal(answered.state.clarification?.answer?.answeredAtStateVersion, 2);

  // Validate hands the answered task back to Investigate, which reaches the model again.
  const resumed = await runControlledUC03GraphV02(resumeFixture.task, resumeReady.ports, resumeReady.config);
  assert.ok(resumed.state, JSON.stringify(resumed.reasons));
  assert.ok(resumeFixture.modelCalls.length >= 1, JSON.stringify({ modelCalls: resumeFixture.modelCalls, reasons: resumed.reasons }));
  const resumedRequestId = resumeFixture.coderAdmissions[0];
  assert.ok(resumedRequestId);
  assert.ok(
    resumeFixture.statePort.getJournalSnapshot().claims.some(claim => claim.claimId === `claim-${resumedRequestId}`),
    `the resumed turn's claim is journaled for ${resumedRequestId}`,
  );
});

test('a substituted clarification answer is refused at the graph tier with zero model calls', async () => {
  // Every other substitution row in this file mutates `goal`; this one mutates the clarification
  // `answerDigest`, which is the input §8 binds the resumed coder turn to. The generic graph reason
  // does not name the cause, so the row also asserts the validator code that produced it — otherwise
  // an unrelated task-state mismatch would satisfy it.
  const fixture = await controlledGeneratedPlanFixture();
  const readiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;
  const seeded = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.ok(seeded);
  const open = await askClarification({
    statePort: fixture.statePort,
    prior: seeded,
    proposal: { kind: 'request-info', proposalId: 'substitution-ask', questions: [{ questionId: 'q-denominator', text: 'What should a zero denominator do?' }], evidenceRefs: [] },
  });
  const answered = await recordClarificationAnswer({
    statePort: fixture.statePort,
    prior: open.state,
    answer: { recorderRef: 'reporter-1', items: (open.state.clarification?.questions ?? []).map(question => ({ questionId: question.questionId, text: 'raise a guarded error' })) },
  });
  assert.equal(answered.state.node, 'Investigate');

  // `structuredClone` yields a mutable copy; the interface is readonly by contract, not at runtime.
  const substituted = structuredClone(answered.state) as { clarification?: { answer?: { answerDigest: string } } };
  assert.ok(substituted.clarification?.answer);
  substituted.clarification.answer.answerDigest = `sha256:${'0'.repeat(64)}`;
  // The one non-validating write on this fixture; a re-transition would be refused at the seed.
  fixture.statePort.getUnderlying().internalSetTask(substituted as typeof answered.state);
  const validation = validateTaskState(substituted as typeof answered.state);
  assert.ok(!validation.ok && validation.errors.some(error => error.code === 'CLARIFICATION_ANSWER_DIGEST_MISMATCH'), JSON.stringify(validation));

  // The fixture journal is cumulative, so the baseline (not a bare zero) is what makes "this run
  // claimed nothing" mean the refusal, and not the fixture's own seeding.
  const claimsBefore = fixture.statePort.getJournalSnapshot().claims.length;
  const result = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  assert.equal(result.outcome, 'INCOMPLETE', JSON.stringify(result.reasons));
  assert.ok(result.reasons.includes('Authoritative task state does not match the supplied task'), JSON.stringify(result.reasons));
  assert.equal(fixture.statePort.getJournalSnapshot().claims.length - claimsBefore, 0, 'a substituted answer must claim nothing');
  assert.deepEqual(fixture.modelCalls, [], 'a substituted answer must dispatch nothing');
  // The refusal precedes any coder admission: this is the validator, not a coder-admission refusal.
  assert.deepEqual(fixture.coderAdmissions, [], 'no coder admission was requested');

  // Positive sibling on the same fixture: restore the correct answer and the same invoke dispatches,
  // so the zero above is the refusal and not a branch that was never reached.
  fixture.statePort.getUnderlying().internalSetTask(answered.state);
  const resumed = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  assert.ok(resumed.state, JSON.stringify(resumed.reasons));
  assert.ok(fixture.modelCalls.length >= 1, JSON.stringify({ modelCalls: fixture.modelCalls, reasons: resumed.reasons }));
  // "At least one call" alone would not prove the model boundary claimed: the claim id must be the
  // one derived from the coder request this sibling actually dispatched (`claim-${providerRequestId}`).
  const resumedRequestId = fixture.coderAdmissions[0];
  assert.ok(resumedRequestId);
  assert.ok(
    fixture.statePort.getJournalSnapshot().claims.some(claim => claim.claimId === `claim-${resumedRequestId}`),
    `the resumed turn's claim is journaled for ${resumedRequestId}`,
  );
});

test('a stop proposal withholds completion and accepts no plan', async () => {
  const fixture = await controlledGeneratedPlanFixture({
    firstResponse: {
      proposalId: 'controlled-stop-1',
      content: JSON.stringify({ kind: 'stop', proposalId: 'controlled-stop-1', reasonCode: 'insufficient-evidence', summary: 'Cannot diagnose the failure', evidenceRefs: [] }),
    },
  });
  const readiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;
  const result = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);

  assert.equal(result.outcome, 'INCOMPLETE', JSON.stringify({ reasons: result.reasons, node: result.state?.node }));
  // `graph-nodes.ts` renders stop through the generic wrong-kind refusal, so the reason names that
  // shape rather than a dedicated stop path. Asserting it keeps this row from being read as a stop
  // handler: the claim it supports is only "stop withholds completion".
  assert.ok(
    result.reasons.some(reason => reason.includes('received stop')),
    JSON.stringify(result.reasons),
  );
  assert.equal(result.finalReport?.isComplete, false, 'a stop must not report a complete run');
  assert.equal(result.finalReport?.delivery?.outcome, undefined, 'a stop must not produce a delivery record');
  assert.equal(result.state?.node, 'Investigate');
  const state = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.equal(state?.plan, undefined, 'a stop must not persist a plan');
  assert.deepEqual(fixture.route.repositoryPort.patches, [], 'a stop must apply no patch');
});

test('an uncertain patch recovery halts as IMPLEMENTED_UNVERIFIED and settles no patch receipt', async () => {
  // The fault belongs in the repository receiver, not the model transport: the execution guard's one
  // `catch` serves both `applyPatch` and `runCommand`, and a throw there is what `graph-patch.ts:61`
  // maps to `IMPLEMENTED_UNVERIFIED`. Downstream of a provider fault would be the wrong witness.
  const probe = await controlledGeneratedPlanFixture({ failFirstPatch: true });
  const readiness = prepareControlledUC03Host(probe.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;
  await runControlledUC03GraphV02(probe.task, readiness.ports, readiness.config);
  const d0 = probe.route.approvalPort.getRecordedBindings().find(binding => binding.decisionId.startsWith('dec-plan-'));
  assert.ok(d0, 'owner did not issue D0');
  await bumpAuthority(probe);
  probe.route.approvalPort.scriptDecision({ ...d0, status: 'approved' });
  const result = await runControlledUC03GraphV02(probe.task, readiness.ports, readiness.config);

  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED', JSON.stringify({ reasons: result.reasons, node: result.state?.node }));
  assert.ok(
    result.reasons.some(reason => reason.includes('uncertain-effect')),
    JSON.stringify(result.reasons),
  );
  // The refused patch left no settled receipt, so the uncertain effect is not silently accounted as one.
  assert.equal(probe.patchReceipts.length, 0, 'an uncertain patch must not settle a receipt');
  assert.equal(probe.route.repositoryPort.patches.length, 0, 'the receiver refused before applying');
  assert.equal(result.finalReport?.isComplete, false);
});

test('an uncertain provider dispatch stops the run without a completion record', async () => {
  // The transport throw is classified `uncertain` by the model boundary, which the coder agent turns
  // into `unavailable` and the generation node carries to `INCOMPLETE`. A settled stop must not also
  // look like a completion, and the same dispatch must not be replayed.
  const fixture = await controlledGeneratedPlanFixture({ failFirstResponse: true });
  const readiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;
  const result = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);

  assert.equal(result.outcome, 'INCOMPLETE', JSON.stringify({ reasons: result.reasons, node: result.state?.node }));
  assert.ok(
    result.reasons.some(reason => reason.includes('MODEL_UNCERTAIN') || reason.includes('uncertain')),
    JSON.stringify(result.reasons),
  );
  assert.equal(result.finalReport?.isComplete, false);
  assert.deepEqual(fixture.modelCalls, ['coder:propose-plan'], 'an uncertain dispatch is charged once, never replayed');
  const state = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.equal(state?.plan, undefined, 'an uncertain dispatch must not persist a plan');
});

test('a substituted authoritative task is refused, with a positive sibling on the same fixture', async () => {
  const fixture = await controlledGeneratedPlanFixture({ taskState: { node: 'NeedsInfo', nextAction: 'request-info' } });
  const readiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;

  // Positive sibling: the identical fixture, unmutated, validates.
  const sibling = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  assert.equal(sibling.outcome, 'needs-info', JSON.stringify(sibling.reasons));

  const authoritative = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.ok(authoritative);
  fixture.statePort.getUnderlying().internalSetTask({ ...structuredClone(authoritative), goal: 'A substituted goal the supplied task does not carry' });
  const refused = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  assert.equal(refused.outcome, 'INCOMPLETE');
  assert.ok(refused.reasons.includes('Authoritative task state does not match the supplied task'), JSON.stringify(refused.reasons));
  assert.equal(refused.state, null);
});

test('a post-assembly substitution is refused by the route before any method runs', async () => {
  const ports = readyPorts() as unknown as Record<string, Record<string, unknown>>;
  const substituted: readonly [string, (port: Record<string, unknown>) => Record<string, unknown>, string][] = [
    ['mock provenance', port => ({ ...port, provenance: 'mock' }), 'invalid-provenance'],
    ['missing method', port => Object.fromEntries(Object.entries(port).filter(([key]) => key !== REQUIRED_PORTS_V02_METHODS.replanPort[0])), 'missing-method'],
    ['removed port', () => undefined as unknown as Record<string, unknown>, 'missing-port'],
  ];
  for (const [label, swap, reasonCode] of substituted) {
    reset();
    const candidate = { ...ports, replanPort: swap(ports['replanPort'] as Record<string, unknown>) };
    const result = await runUC03GraphV02(createFixtureBugTask(), candidate as unknown as UC03GraphPortsV02, CONFIG);
    assert.equal(result.state, null, label);
    assert.match(result.reasons[0] ?? '', new RegExp(`PRODUCTION_ADMISSION_REFUSED: replanPort ${reasonCode}`, 'u'), label);
    assert.equal(result.diagnostic?.reasonCode, 'production-admission-refused', label);
    assert.deepEqual(CALLS, [], `${label}: a refused route must not call any port method`);
  }
});

test('createProductionRoute assembles without admitting anything', () => {
  reset();
  const app = createProductionRoute(readyPorts(), CONFIG);
  assert.equal(typeof app.invoke, 'function');
  assert.deepEqual(CALLS, []);
});

test('mock evaluation refuses a production route before any port call', async () => {
  reset();
  const host: WorkflowCaseHost = { entry: catalogEntry('C01'), task: createFixtureBugTask(), expectedWait: null, production: { ports: readyPorts(), config: CONFIG } };
  const report = await runEvaluation({ ...OPTIONS, mode: 'mock', cases: ['C01'], driver: createWorkflowDriver(new Map([['C01', host]])) });
  const [observed] = report.cases;
  assert.ok(observed);

  assert.equal(report.tier, 'controlled');
  assert.equal(report.isRealVerified, false);
  assert.deepEqual(report.suiteAcceptance, { scope: 'catalog', requiredCases: 17, satisfiedCases: 0, outcome: 'incomplete' });
  assert.equal(observed.workflowOutcome, 'not-observed');
  assert.equal(observed.grade, 'not-run');
  assert.equal(observed.gradeReason, 'prerequisite-unavailable');
  assert.equal(observed.effects, 'none');
  assert.equal(observed.usage, 'unavailable');
  assert.deepEqual(observed.artifacts, [], 'no evidence artifact was produced');
  assert.deepEqual(observed.limitations, ['Preflight block PRODUCTION_ROUTE_REQUIRES_REAL_MODE; no graph dispatch occurred.']);
  assert.deepEqual(CALLS, []);
});

test('controlled host resumes the persisted C02 pause and reports an unpinned C01 wait', async () => {
  const task = createFixtureBugTask();
  const paused = createFixtureTaskState({ node: 'NeedsInfo', nextAction: 'request-info' });
  const c02Fixture = controlledHostFixture(paused, CONFIG);
  const c02Ready = prepareControlledUC03Host(c02Fixture.inputs);
  assert.equal(c02Ready.status, 'controlled-ready');
  if (c02Ready.status !== 'controlled-ready') return;
  const c02Host: WorkflowCaseHost = {
    entry: catalogEntry('C02'),
    task,
    expectedWait: 'waiting-info',
    controlled: { ports: c02Ready.ports, config: c02Ready.config },
  };
  const c02 = await runEvaluation({ ...OPTIONS, mode: 'mock', cases: ['C02'], driver: createWorkflowDriver(new Map([['C02', c02Host]])) });
  assert.equal(c02.tier, 'controlled');
  assert.equal(c02.isRealVerified, false);
  assert.equal(c02.exitCode, 0);
  assert.equal(c02.cases[0]?.grade, 'pass');
  assert.equal(c02.cases[0]?.workflowOutcome, 'waiting-info');
  assert.deepEqual(c02Fixture.calls, ['statePort.loadTask']);
  assert.deepEqual(await c02Ready.ports.statePort.loadTask(task.taskId), paused);

  const c01Fixture = controlledHostFixture(paused, CONFIG);
  const c01Ready = prepareControlledUC03Host(c01Fixture.inputs);
  assert.equal(c01Ready.status, 'controlled-ready');
  if (c01Ready.status !== 'controlled-ready') return;
  const c01Host: WorkflowCaseHost = {
    entry: catalogEntry('C01'),
    task,
    expectedWait: null,
    controlled: { ports: c01Ready.ports, config: c01Ready.config },
  };
  const c01 = await runEvaluation({ ...OPTIONS, mode: 'mock', cases: ['C01'], driver: createWorkflowDriver(new Map([['C01', c01Host]])) });
  assert.equal(c01.exitCode, 3);
  assert.equal(c01.cases[0]?.gradeReason, 'unresolved-wait');
  assert.deepEqual(c01Fixture.calls, ['statePort.loadTask']);
});

test('real mode refuses before dispatch and accounts no effect', async () => {
  reset();
  const host: WorkflowCaseHost = { entry: catalogEntry('C01'), task: createFixtureBugTask(), expectedWait: null, production: { ports: readyPorts(), config: CONFIG } };
  const report = await runEvaluation({ ...OPTIONS, mode: 'real', cases: ['C01'], driver: createWorkflowDriver(new Map([['C01', host]])) });
  const [observed] = report.cases;
  assert.ok(observed);
  assert.equal(report.tier, 'real-integration');
  assert.equal(report.isRealVerified, false);
  assert.equal(observed.gradeReason, 'real-execution-unavailable');
  assert.equal(observed.effects, 'none');
  assert.equal(observed.workflowOutcome, 'not-observed');
  assert.deepEqual(report.suiteAcceptance, { scope: 'catalog', requiredCases: 17, satisfiedCases: 0, outcome: 'incomplete' });
  assert.deepEqual(CALLS, [], 'no admission means no owner reload, provider call or command');
});

function hostFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'uc03-pipeline-')), 'host.json');
  writeFileSync(
    path,
    JSON.stringify({
      profileId: 'profile-001',
      profileDigest: DIGEST,
      configDigest: DIGEST,
      pricingDigest: DIGEST,
      requestedModel: 'controlled-model',
      adapterVersions: ['uc03-adapter-1'],
      contractVersion: CONTRACT,
      revisions: PINS.revisions,
    }),
    'utf8',
  );
  return path;
}

function options(overrides: Partial<EvaluateCliOptions> = {}): EvaluateCliOptions {
  return { profileDigest: DIGEST, configDigest: DIGEST, pricingDigest: DIGEST, adapterVersions: ['uc03-adapter-1'], requestedModel: 'controlled-model', host: assembly(), ...overrides };
}

test('CLI preflight reaches assembly and stops there', async () => {
  reset();
  const result = await runEvaluateCli(['preflight', '--host', hostFile()], options());
  assert.equal(result.exitCode, 0, result.output);
  const report = JSON.parse(result.output) as { readonly outcome: string; readonly components: readonly string[] };
  assert.equal(report.outcome, 'ready');
  assert.deepEqual(report.components, [...UC03_PRODUCTION_COMPONENTS_V02]);
  assert.equal(result.output.includes(REV), false, 'a revision never reaches the readiness output');
  assert.deepEqual(CALLS, []);
});

test('CLI mock run refuses the assembled production route without effects', async () => {
  reset();
  const production = (ready: { ports: UC03GraphPortsV02; config: UC03GraphConfigV02 }) =>
    createWorkflowDriver(new Map([['C01', { entry: catalogEntry('C01'), task: createFixtureBugTask(), expectedWait: null, production: { ports: ready.ports, config: ready.config } }]]));
  const result = await runEvaluateCli(['run', '--host', hostFile(), '--cases', 'C01'], options({ production }));
  assert.equal(result.exitCode, 4, result.output);
  const report = JSON.parse(result.output.slice(0, result.output.indexOf('\nUC-03 Workflow Evaluation'))) as {
    readonly tier: string;
    readonly isRealVerified: boolean;
    readonly suiteAcceptance: { readonly requiredCases: number; readonly satisfiedCases: number; readonly outcome: string };
    readonly cases: readonly { readonly gradeReason: string; readonly workflowOutcome: string }[];
  };
  assert.equal(report.tier, 'controlled');
  assert.equal(report.isRealVerified, false);
  assert.deepEqual(report.suiteAcceptance, { scope: 'catalog', requiredCases: 17, satisfiedCases: 0, outcome: 'incomplete' });
  assert.equal(report.cases[0]?.gradeReason, 'prerequisite-unavailable');
  assert.equal(report.cases[0]?.workflowOutcome, 'not-observed');
  assert.deepEqual(CALLS, []);
});

test('CLI run without a production binding is a named prerequisite gap, never a mock fallback', async () => {
  reset();
  const result = await runEvaluateCli(['run', '--host', hostFile(), '--cases', 'C01'], options());
  assert.equal(result.exitCode, 4);
  assert.equal(JSON.parse(result.output).error, 'HOST_ROUTE_UNAVAILABLE');
  assert.deepEqual(CALLS, []);
});

const CONTROL: GuardedReadControlObservation = {
  taskId: 'task-guarded',
  workspaceId: 'ws-guarded',
  repositoryId: 'repo-guarded',
  revisionDigest: DIGEST,
  controlVersion: 3,
  mode: 'runnable',
  holdRef: null,
  fencingGeneration: 5,
  policyDigest: POLICY,
  readAllowed: true,
};

test('the guarded read refuses a control mismatch and a read race before the closure runs', async () => {
  let executed = 0;
  const closure = async (): Promise<string> => {
    executed += 1;
    return 'read';
  };
  const capability = (observed: GuardedReadControlObservation, fence: () => unknown) =>
    createGuardedReadCapability({
      capabilityId: 'cap-1',
      taskId: CONTROL.taskId,
      workspaceId: CONTROL.workspaceId,
      repositoryId: CONTROL.repositoryId,
      expectedRevisionDigest: DIGEST,
      policyDigest: POLICY,
      bounds: { maxPathLength: 128, maxQueryLength: 128 },
      provenance: 'real',
      owner: { observeReadControl: () => observed, fenceReadControl: fence as never },
    });

  const denied = (run: () => Promise<unknown>): Promise<string | undefined> =>
    run().then(
      () => undefined,
      (error: Error) => (error as { reasonCode?: string }).reasonCode,
    );

  assert.equal(
    await denied(() => capability({ ...CONTROL, taskId: 'task-other' }, () => ({ ...CONTROL, receiptId: 'r' })).mediateRead({ kind: 'read', targetPath: 'src/app.py', execute: closure })),
    'READ_CONTROL_MISMATCH',
  );
  assert.equal(await denied(() => capability(CONTROL, () => null).mediateRead({ kind: 'read', targetPath: 'src/app.py', execute: closure })), 'READ_FENCED');
  assert.equal(executed, 0, 'a refused read never invokes the repository closure');
});

test('the baseline producers refuse an absent owner fact instead of inventing one', async () => {
  const absentLookup = createBaselineEvidenceAdapter({ provenance: 'real', persist: () => ({ outcome: 'denied', reason: 'not supplied' }) });
  await assert.rejects(() => absentLookup.loadBaselineEvidence('task-1', 'ws-1', 'repo-1', 'evidence-1'), /BASELINE_EVIDENCE_LOOKUP_UNAVAILABLE/u);

  const missing = createBaselineEvidenceAdapter({ provenance: 'real', persist: () => ({ outcome: 'denied', reason: 'not supplied' }), load: () => ({ outcome: 'missing' }) });
  assert.equal(await missing.loadBaselineEvidence('task-1', 'ws-1', 'repo-1', 'evidence-1'), null);

  const uncertain = createBaselineEvidenceAdapter({
    provenance: 'real',
    persist: () => ({ outcome: 'denied', reason: 'not supplied' }),
    load: () => ({ outcome: 'uncertain', reason: 'owner unreachable' }),
  });
  await assert.rejects(() => uncertain.loadBaselineEvidence('task-1', 'ws-1', 'repo-1', 'evidence-1'), /BASELINE_EVIDENCE_LOOKUP_UNCERTAIN/u);

  const retained = createRepositoryBaselineSource({
    root: join(tmpdir(), `uc03-absent-retention-${process.pid}`),
    taskId: 'task-1',
    workspaceId: 'ws-1',
    repositoryId: 'repo-1',
    baseRevision: DIGEST,
    manifest: [{ path: 'README.md', digest: computeFileDigest('# demo\n'), sizeBytes: 7 }],
    maxFileBytes: 4096,
  });
  const binding = { taskId: 'task-1', workspaceId: 'ws-1', repositoryId: 'repo-1', baseRevision: DIGEST };
  await assert.rejects(() => retained.loadManifest(binding), /MISSING_FILE/u);
  await assert.rejects(() => retained.loadManifest({ ...binding, baseRevision: `sha256:${'e'.repeat(64)}` }), /REVISION_MISMATCH/u);
});
