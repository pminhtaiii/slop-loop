import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createWorkflowDriver, type WorkflowCaseHost } from '../../../eval/uc03/workflow-driver.ts';
import { runEvaluation } from '../../../eval/uc03/runner.ts';
import { WORKFLOW_EVALUATION_VERSION } from '../../../eval/uc03/types.ts';
import { runEvaluateCli, type EvaluateCliOptions } from '../../../src/cli/evaluate.ts';
import { computeFileDigest } from '../../../src/foundation/docker-workspace-policy.ts';
import { createGuardedReadCapability, type GuardedReadControlObservation } from '../../../src/foundation/guarded-read-capability.ts';
import { createBaselineEvidenceAdapter } from '../../../src/runtime/baseline-evidence-adapter.ts';
import type { OwnerDelivery } from '../../../src/runtime/evaluation-composition.ts';
import { createRepositoryBaselineSource } from '../../../src/runtime/repository-baseline-source.ts';
import { prepareControlledUC03Host, prepareUC03Host } from '../../../src/runtime/uc03-host-bootstrap.ts';
import { createProductionRoute, runControlledUC03GraphV02, runUC03GraphV02 } from '../../../src/uc03/graph-v02.ts';
import {
  REQUIRED_PORTS_V02_METHODS,
  UC03_PRODUCTION_COMPONENTS_V02,
  portDeclarationsV02,
  type UC03GraphConfigV02,
  type UC03GraphPortsV02,
  type UC03ProductionComponentV02,
} from '../../../src/uc03/graph-types-v02.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
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
  const reviewStateVersion = (reviewed.state?.stateVersion ?? 0) - 1;
  const deliveryStateVersion = reviewed.state?.stateVersion ?? 0;
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
});

type ControlledFixture = Awaited<ReturnType<typeof controlledGeneratedPlanFixture>>;

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
