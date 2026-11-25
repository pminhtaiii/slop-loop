import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { issueRealExecutionAdmission } from '../../../eval/shared-admission.ts';
import { runEvaluation } from '../../../eval/uc03/runner.ts';
import { WORKFLOW_EVALUATION_VERSION, type WorkflowCaseContext, type WorkflowCaseResult, type WorkflowObservation } from '../../../eval/uc03/types.ts';
import { runEvaluateCli } from '../../../src/cli/evaluate.ts';
import { createHostAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import type { OperatorIo } from '../../../src/runtime/real-tier-case-operator.ts';
import { REAL_TIER_DELIVERY_CONTRACT } from '../../../src/runtime/real-tier-owners.ts';
import { abandonRealTierProductionCase } from '../../../src/runtime/real-tier-production.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { parseCliReport, prodCopyTempCount, REV, setupProductionScenario } from './real-tier-production-route-fixture.ts';

const COPY_PREFIX = `uc03-real-prod-copy-${process.pid}-`;

interface HarnessGlobals {
  readonly env: Record<string, string | undefined>;
  readonly fetch: typeof globalThis.fetch;
  readonly spawn: Parameters<typeof createHostAssembly>[0] extends infer T ? (T extends { readonly spawn?: infer S } ? S : never) : never;
  readonly stateRoot: string;
  readonly revision: string;
  readonly operatorIo: OperatorIo;
}

function createDriverSetup(scenario: Awaited<ReturnType<typeof setupProductionScenario>>, decisions: readonly ('approve' | 'reject' | undefined)[]) {
  const h = (globalThis as unknown as { __t011Harness: HarnessGlobals }).__t011Harness;
  const queue: ('approve' | 'reject' | undefined)[] = [...decisions];
  const harness: HarnessGlobals = {
    ...h,
    operatorIo: { write: line => scenario.operatorPrompts.push(line), read: async () => queue.shift() },
  };
  const hostBuilt = createHostAssembly(harness);
  assert.notEqual((hostBuilt as { readonly status?: string }).status, 'unavailable');
  const resolved = hostBuilt as Exclude<ReturnType<typeof createHostAssembly>, { readonly status: 'unavailable' }>;
  const produced = resolved.production(
    { status: 'ready', identity: { profileId: 't011-profile', ...scenario.binding } },
    {
      mode: 'real',
      binding: scenario.binding,
      caseIds: ['C01'],
      pins: { contractVersion: REAL_TIER_DELIVERY_CONTRACT, revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(c => [c, REV])) },
    },
  );
  assert.ok('driver' in produced && produced.realAdmission !== undefined);
  const caseContext: WorkflowCaseContext = {
    spec: { caseId: 'C01', name: 'Bug repair', description: 'C01 repair', category: 'repair', required: true, expectedOutcome: 'COMPLETED', requirements: ['fix bug'] },
    mode: 'real',
    tier: 'real-integration',
    manifestDigest: `sha256:${sha256Text('manifest')}`,
    ...scenario.binding,
  };
  return { queue, harness, driver: produced.driver, realAdmission: produced.realAdmission, caseContext };
}

function readTaskRecords(stateRoot: string): readonly {
  readonly runDir: string;
  readonly taskId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly node: string;
  readonly settledPatchClaims: number;
}[] {
  const records: { runDir: string; taskId: string; runId: string; workspaceId: string; node: string; settledPatchClaims: number }[] = [];
  for (const runDir of readdirSync(stateRoot)) {
    const claimsRoot = join(stateRoot, runDir, 'store', 'claims');
    if (!existsSync(claimsRoot)) continue;
    for (const taskDir of readdirSync(claimsRoot)) {
      const taskFile = join(claimsRoot, taskDir, 'v02', 'task.json');
      if (!existsSync(taskFile)) continue;
      const parsed = JSON.parse(readFileSync(taskFile, 'utf8')) as { taskId?: string; runId?: string; workspaceId?: string; node?: string };
      if (!parsed.taskId || !parsed.runId || !parsed.workspaceId || !parsed.node) continue;
      let settledPatchClaims = 0;
      for (const entry of readdirSync(join(claimsRoot, taskDir))) {
        if (!entry.endsWith('.json')) continue;
        const claim = JSON.parse(readFileSync(join(claimsRoot, taskDir, entry), 'utf8')) as {
          status?: string;
          context?: { subjectKind?: string; action?: { kind?: string } };
        };
        if (claim.status === 'settled' && claim.context?.subjectKind === 'repository-action' && claim.context?.action?.kind === 'apply_patch') settledPatchClaims += 1;
      }
      records.push({ runDir, taskId: parsed.taskId, runId: parsed.runId, workspaceId: parsed.workspaceId, node: parsed.node, settledPatchClaims });
    }
  }
  return records;
}

function newCopyDirs(beforeNames: ReadonlySet<string>): readonly string[] {
  return readdirSync(tmpdir()).filter(name => name.startsWith(COPY_PREFIX) && !beforeNames.has(name));
}

function cleanupNewCopies(beforeNames: ReadonlySet<string>): void {
  for (const entry of newCopyDirs(beforeNames)) rmSync(join(tmpdir(), entry), { recursive: true, force: true });
}

function repoCopyInside(workingCopyRoot: string): string {
  const children = readdirSync(workingCopyRoot).filter(name => name.startsWith('repo-'));
  assert.equal(children.length, 1);
  return join(workingCopyRoot, children[0] ?? '');
}

test('same-driver continuation pauses after patch and resumes with identical identity, zero duplicated effects, and terminal cleanup', async () => {
  const beforeNames = new Set(readdirSync(tmpdir()).filter(name => name.startsWith(COPY_PREFIX)));
  const copyBefore = beforeNames.size;
  const s = await setupProductionScenario({ tag: 'cont-verify', fetchMode: 'repair', decisions: [] });
  try {
    const setup = createDriverSetup(s, ['approve', undefined]);
    const evalOpts = { contractVersion: WORKFLOW_EVALUATION_VERSION, mode: 'real' as const, cases: ['C01'] as const, ...s.binding, realAdmission: setup.realAdmission, driver: setup.driver };

    const report1 = await runEvaluation(evalOpts);
    assert.equal(report1.exitCode, 3);
    assert.deepEqual(report1.selectionResult.pendingWaits, ['C01']);
    const pausedCase = report1.cases[0] as WorkflowCaseResult;
    assert.equal(pausedCase.grade, 'not-run');
    assert.equal(pausedCase.gradeReason, 'unresolved-wait');
    assert.equal(pausedCase.workflowOutcome, 'waiting-approval');
    assert.equal(s.spawnSpy.hiddenChecks.length, 0);

    const addedCopies = newCopyDirs(beforeNames);
    assert.equal(addedCopies.length, 1);
    const pausedCopyRoot = join(tmpdir(), addedCopies[0] ?? '');
    const pausedRepoRoot = repoCopyInside(pausedCopyRoot);
    assert.ok(readFileSync(join(pausedRepoRoot, 'src', 'calculator.py'), 'utf8').includes('raise CalculationError'));

    const recordsAtPause = readTaskRecords(setup.harness.stateRoot);
    assert.equal(recordsAtPause.length, 1);
    const pausedRecord = recordsAtPause[0];
    assert.ok(pausedRecord !== undefined);
    assert.equal(pausedRecord.node, 'Verify');
    assert.equal(pausedRecord.settledPatchClaims, 1);
    assert.equal(pausedCase.taskId, pausedRecord.taskId);
    assert.equal(pausedCase.runId, pausedRecord.runId);
    assert.equal(s.fetchSpy.requests.filter(r => r.purpose === 'propose-plan').length, 2);
    assert.equal(s.fetchSpy.requests.filter(r => r.purpose === 'propose-patch').length, 1);
    assert.equal(s.fetchSpy.requests.filter(r => r.role === 'reviewer').length, 0);
    const workspaceVolumes = () => s.spawnSpy.spawnCalls.filter(c => c.args[0] === 'volume' && c.args[1] === 'create' && (c.args[2] ?? '').startsWith('vol-')).length;
    assert.equal(workspaceVolumes(), 2);

    // Continue the exact same driver after explicit operator approval at verification.
    setup.queue.push('approve');
    const report2 = await runEvaluation(evalOpts);
    assert.equal(report2.exitCode, 0);
    assert.deepEqual(report2.selectionResult.pendingWaits, []);
    const doneCase = report2.cases[0] as WorkflowCaseResult;
    assert.equal(doneCase.grade, 'pass');
    assert.equal(doneCase.gradeReason, 'criteria-satisfied');
    assert.equal(doneCase.workflowOutcome, 'COMPLETED');
    assert.equal(doneCase.taskId, pausedRecord.taskId);
    assert.equal(doneCase.runId, pausedRecord.runId);

    const recordsAfterDone = readTaskRecords(setup.harness.stateRoot);
    assert.equal(recordsAfterDone.length, 1);
    assert.equal(recordsAfterDone[0]?.runDir, pausedRecord.runDir);
    assert.equal(recordsAfterDone[0]?.workspaceId, pausedRecord.workspaceId);
    assert.equal(recordsAfterDone[0]?.settledPatchClaims, 1);
    assert.deepEqual(newCopyDirs(beforeNames), []);
    assert.equal(pausedRepoRoot.startsWith(pausedCopyRoot), true);

    assert.equal(s.fetchSpy.requests.filter(r => r.purpose === 'propose-plan').length, 2);
    assert.equal(s.fetchSpy.requests.filter(r => r.purpose === 'propose-patch').length, 1);
    assert.equal(s.fetchSpy.requests.filter(r => r.role === 'reviewer').length, 1);
    assert.equal(workspaceVolumes(), 2);
    assert.equal(s.spawnSpy.hiddenChecks.length, 1);

    assert.equal(existsSync(pausedCopyRoot), false);
    assert.equal(prodCopyTempCount(), copyBefore);
    assert.equal(abandonRealTierProductionCase(setup.driver, 'C01'), false);
  } finally {
    cleanupNewCopies(beforeNames);
    s.cleanup();
  }
});

test('continuation refuses context, spec, profile, grader, and missing-copy drift before effects', async () => {
  const beforeNames = new Set(readdirSync(tmpdir()).filter(name => name.startsWith(COPY_PREFIX)));
  const copyBefore = beforeNames.size;
  const s = await setupProductionScenario({ tag: 'cont-drift', fetchMode: 'repair', decisions: [] });
  try {
    const setup = createDriverSetup(s, ['approve', undefined]);
    const pausedObs = (await setup.driver.executeCase(setup.caseContext.spec, setup.caseContext)) as WorkflowObservation;
    assert.equal(pausedObs.workflowOutcome, 'waiting-approval');
    const added = newCopyDirs(beforeNames);
    assert.equal(added.length, 1);
    const pausedCopyRoot = join(tmpdir(), added[0] ?? '');

    const fetchBefore = s.fetchSpy.requests.length;
    const spawnBefore = s.spawnSpy.spawnCalls.length;
    const profilePath = setup.harness.env.UC03_REAL_TIER_PROFILE ?? '';
    const originalProfile = readFileSync(profilePath, 'utf8');
    const parsedProfile = JSON.parse(originalProfile) as Record<string, unknown> & { readonly catalog: { readonly path: string } };
    const catalog = JSON.parse(readFileSync(parsedProfile.catalog.path, 'utf8')) as {
      readonly catalog: { readonly caseId: string; readonly grader?: { readonly path: string } }[];
    };
    const graderPath = catalog.catalog.find(entry => entry.caseId === 'C01')?.grader?.path ?? '';
    const originalGrader = readFileSync(graderPath, 'utf8');

    const assertBlockedNoEffects = (obs: WorkflowObservation, label: string) => {
      assert.equal(obs.blocked, 'prerequisite-unavailable', label);
      assert.equal(obs.workflowOutcome, 'not-observed', label);
      assert.equal(obs.effects, 'none', label);
      assert.equal(s.fetchSpy.requests.length, fetchBefore, `${label}: must not invoke model`);
      assert.equal(s.spawnSpy.spawnCalls.length, spawnBefore, `${label}: must not invoke spawn`);
      assert.equal(s.spawnSpy.hiddenChecks.length, 0, `${label}: must not invoke grader`);
    };

    assertBlockedNoEffects((await setup.driver.executeCase(setup.caseContext.spec, { ...setup.caseContext, requestedModel: 'cmc/deepseek/drifted' })) as WorkflowObservation, 'model-context-drift');
    assertBlockedNoEffects((await setup.driver.executeCase({ ...setup.caseContext.spec, expectedOutcome: 'INCOMPLETE' }, setup.caseContext)) as WorkflowObservation, 'expected-outcome-drift');

    const parsedGrader = JSON.parse(originalGrader) as Record<string, unknown>;
    writeFileSync(graderPath, JSON.stringify({ ...parsedGrader, profile: { ...(parsedGrader['profile'] as object), profileId: 'drifted-grader' } }), 'utf8');
    assertBlockedNoEffects((await setup.driver.executeCase(setup.caseContext.spec, setup.caseContext)) as WorkflowObservation, 'grader-digest-drift');
    writeFileSync(graderPath, originalGrader, 'utf8');

    writeFileSync(profilePath, JSON.stringify({ ...parsedProfile, campaignId: 'mutated-before-continue' }), 'utf8');
    assertBlockedNoEffects((await setup.driver.executeCase(setup.caseContext.spec, setup.caseContext)) as WorkflowObservation, 'disk-profile-drift');
    writeFileSync(profilePath, originalProfile, 'utf8');

    rmSync(pausedCopyRoot, { recursive: true, force: true });
    assertBlockedNoEffects((await setup.driver.executeCase(setup.caseContext.spec, setup.caseContext)) as WorkflowObservation, 'missing-working-copy');
    assert.equal(prodCopyTempCount(), copyBefore);
    assert.equal(abandonRealTierProductionCase(setup.driver, 'C01'), false);

    // Explicit disposal releases a retained copy when caller abandons without resuming.
    setup.queue.push(undefined);
    const paused2 = (await setup.driver.executeCase(setup.caseContext.spec, setup.caseContext)) as WorkflowObservation;
    assert.equal(paused2.workflowOutcome, 'waiting-approval');
    assert.equal(prodCopyTempCount(), copyBefore + 1);
    assert.equal(abandonRealTierProductionCase(setup.driver, 'C01'), true);
    assert.equal(prodCopyTempCount(), copyBefore);
    assert.equal(abandonRealTierProductionCase(setup.driver, 'C01'), false);
  } finally {
    cleanupNewCopies(beforeNames);
    s.cleanup();
  }
});

test('rejection during continuation releases copy, avoids auto-approval or replay, and yields exit 3', async () => {
  const beforeNames = new Set(readdirSync(tmpdir()).filter(name => name.startsWith(COPY_PREFIX)));
  const copyBefore = beforeNames.size;
  const s = await setupProductionScenario({ tag: 'cont-reject', fetchMode: 'repair', decisions: [] });
  try {
    const setup = createDriverSetup(s, ['approve', undefined]);
    const evalOpts = {
      contractVersion: WORKFLOW_EVALUATION_VERSION,
      mode: 'real' as const,
      cases: ['C01'] as const,
      ...s.binding,
      realAdmission: setup.realAdmission,
      driver: setup.driver,
    };

    const pausedReport = await runEvaluation(evalOpts);
    assert.equal(pausedReport.exitCode, 3);
    assert.equal(prodCopyTempCount(), copyBefore + 1);

    setup.queue.push('reject');
    const rejectedReport = await runEvaluation(evalOpts);
    assert.equal(rejectedReport.exitCode, 3);
    const c01 = rejectedReport.cases[0] as WorkflowCaseResult;
    assert.equal(c01.workflowOutcome, 'waiting-approval');
    assert.equal(c01.grade, 'not-run');
    assert.equal(c01.gradeReason, 'unresolved-wait');
    assert.ok(c01.diagnostic?.includes('Operator rejected approval'));
    assert.equal(s.spawnSpy.hiddenChecks.length, 0);
    assert.equal(prodCopyTempCount(), copyBefore, 'rejection during continuation must release retained copy');
    assert.equal(abandonRealTierProductionCase(setup.driver, 'C01'), false);
  } finally {
    cleanupNewCopies(beforeNames);
    s.cleanup();
  }
});

test('real tier yields exact exit 3 for unresolved waiting-approval while requiring independent grading for passes including C02', async () => {
  const beforeNames = new Set(readdirSync(tmpdir()).filter(name => name.startsWith(COPY_PREFIX)));
  const copyBefore = beforeNames.size;

  // CLI end-to-end exit 3 on unresolved waiting-approval (plan EOF and verify EOF)
  for (const [tag, decisions] of [
    ['cli-exit3-plan', [undefined]],
    ['cli-exit3-verify', ['approve', undefined]],
  ] as const) {
    const s = await setupProductionScenario({ tag, fetchMode: 'repair', decisions });
    try {
      const cliResult = await runEvaluateCli(['run', '--host', s.hostFile, '--mode', 'real', '--cases', 'C01']);
      assert.equal(cliResult.exitCode, 3, tag);
      const report = parseCliReport(cliResult.output);
      assert.deepEqual(report.selectionResult.pendingWaits, ['C01'], tag);
      assert.equal(report.cases[0]?.grade, 'not-run', tag);
      assert.equal(report.cases[0]?.gradeReason, 'unresolved-wait', tag);
      assert.equal(report.cases[0]?.workflowOutcome, 'waiting-approval', tag);
    } finally {
      cleanupNewCopies(beforeNames);
      assert.equal(prodCopyTempCount(), copyBefore);
      s.cleanup();
    }
  }

  // Real-tier grading contract: C02 waiting-info and C01 COMPLETED cannot pass without an independent grade
  const baseObs = (overrides: Partial<WorkflowObservation>): WorkflowObservation => ({
    repositoryId: 'repo-1',
    taskId: 'task-1',
    runId: 'run-1',
    returnedModel: 'deepseek-v4.1-flash',
    graderDigest: null,
    initialRepositoryDigest: null,
    workflowOutcome: 'waiting-approval',
    expectedWait: null,
    blocked: null,
    effects: 'observed',
    usage: 'uncertain',
    diagnostic: null,
    artifacts: [],
    limitations: [],
    ...overrides,
  });

  const bindingFields = {
    profileDigest: sha256Text('profile'),
    configDigest: sha256Text('config'),
    pricingDigest: sha256Text('pricing'),
    adapterVersions: ['uc03-adapter-1'] as const,
    requestedModel: 'deepseek-v4.1-flash',
  };
  const sharedOpts = {
    contractVersion: WORKFLOW_EVALUATION_VERSION,
    mode: 'real' as const,
    ...bindingFields,
  };

  const c01WaitAdm = issueRealExecutionAdmission({ ...bindingFields, caseIds: ['C01'] });
  const c01WaitReport = await runEvaluation({
    ...sharedOpts,
    cases: ['C01'],
    realAdmission: c01WaitAdm,
    driver: { executeCase: () => baseObs({ workflowOutcome: 'waiting-approval', blocked: null }) },
  });
  assert.equal(c01WaitReport.exitCode, 3);
  assert.equal(c01WaitReport.cases[0]?.gradeReason, 'unresolved-wait');

  const c01BlockedReport = await runEvaluation({
    ...sharedOpts,
    cases: ['C01'],
    realAdmission: c01WaitAdm,
    driver: { executeCase: () => baseObs({ workflowOutcome: 'waiting-approval', blocked: 'prerequisite-unavailable' }) },
  });
  assert.equal(c01BlockedReport.exitCode, 4);
  assert.equal(c01BlockedReport.cases[0]?.gradeReason, 'prerequisite-unavailable');

  const c02Adm = issueRealExecutionAdmission({ ...bindingFields, caseIds: ['C02'] });
  const c02UngradedReport = await runEvaluation({
    ...sharedOpts,
    cases: ['C02'],
    realAdmission: c02Adm,
    driver: { executeCase: () => baseObs({ workflowOutcome: 'waiting-info', expectedWait: 'waiting-info' }) },
  });
  assert.equal(c02UngradedReport.exitCode, 1, 'C02 lifecycle alone must not pass real grading without independent grade');
  assert.equal(c02UngradedReport.cases[0]?.grade, 'not-run');
  assert.equal(c02UngradedReport.cases[0]?.gradeReason, 'private-grading');

  const c01UngradedReport = await runEvaluation({
    ...sharedOpts,
    cases: ['C01'],
    realAdmission: c01WaitAdm,
    driver: { executeCase: () => baseObs({ workflowOutcome: 'COMPLETED' }) },
  });
  assert.equal(c01UngradedReport.exitCode, 1, 'C01 COMPLETED without independent grade must not pass');
  assert.equal(c01UngradedReport.cases[0]?.gradeReason, 'private-grading');
});
