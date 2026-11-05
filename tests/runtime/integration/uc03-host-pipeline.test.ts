/**
 * T030 witness: the host pipeline in one place, at the boundary the controlled tier can honestly reach.
 *
 * Every fixture here is controlled — a mock-provenance delivery, or a declared-real shell whose
 * methods do nothing but count. `checkProductionPortsV02` demands `'real'` provenance and the shared
 * route re-checks it, so a controlled delivery cannot be promoted into production. What this file
 * observes is therefore: assembly and readiness refusals, the v0.2 pre-effect refusal, the owner
 * reload where a declared-real shell set stops, the evaluator's controlled-tier report, the CLI
 * exits, and the pre-admission refusals of the guarded-read and baseline producers.
 *
 * This is not G-OWNERS, G-ROUTE or G-REAL evidence. No owner, profile, route or real repair exists
 * behind these doubles, and nothing below claims one.
 *
 * unreachable: retained baseline -> inspect-read/check -> observed evidence -> fresh request ->
 * generated plan -> explicit approve -> generated patch -> checks -> canonical reviewer ingress ->
 * grade; the reject/revise and material-replan paths inside the graph; persisted task/control/
 * accounting from a real traversal; distinct coder/reviewer claim/attempt/outcome chains; unchanged
 * protected sentinels at grade; view mismatch at command dispatch; explicit request-info pause and
 * continuation; uncertain provider/replan/patch recovery; changed final snapshot at grade; stop and
 * loop exhaustion. Reason: every controlled fixture declares mock or no behaviour, so the production
 * route either refuses it before any effect or stops at the first owner reload; reaching the graph
 * body needs owner deliveries this release does not have.
 */
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
import { prepareUC03Host } from '../../../src/runtime/uc03-host-bootstrap.ts';
import { createProductionRoute, runUC03GraphV02 } from '../../../src/uc03/graph-v02.ts';
import {
  REQUIRED_PORTS_V02_METHODS,
  UC03_PRODUCTION_COMPONENTS_V02,
  type UC03GraphConfigV02,
  type UC03GraphPortsV02,
  type UC03ProductionComponentV02,
} from '../../../src/uc03/graph-types-v02.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { createFixtureBugTask } from '../support/uc03/port-fixtures.ts';

const CONTRACT = 'uc03-owner-delivery/1';
const REV = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const POLICY = `sha256:${'c'.repeat(64)}`;
const HOST_COMPONENTS = ['guardedRead', 'baselineEvidence', 'hostAuthority', 'contextSource'] as const;
const OWNER_COMPONENTS = UC03_PRODUCTION_COMPONENTS_V02.filter(component => !(HOST_COMPONENTS as readonly string[]).includes(component));

const CALLS: string[] = [];
const recording = (component: string, method: string): (() => undefined) => () => {
  CALLS.push(`${component}.${method}`);
  return undefined;
};
const reset = (): void => {
  CALLS.length = 0;
};

function delivery(component: UC03ProductionComponentV02, adapterProvenance: 'real' | 'mock' = 'real'): OwnerDelivery {
  const adapter = { provenance: adapterProvenance, ...Object.fromEntries(REQUIRED_PORTS_V02_METHODS[component].map(method => [method, recording(component, method)])) };
  // The delivery declaration stays `real` here so only the adapter's own provenance varies.
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

/* ---------------------------------------------------------------- assembly */

test('assembly is effect-free and a controlled delivery never becomes ready', () => {
  reset();
  const readiness = prepareUC03Host(assembly());
  assert.equal(readiness.status, 'ready');
  assert.deepEqual(CALLS, [], 'no delivered method runs during assembly');

  for (const provenance of ['mock'] as const) {
    const refused = prepareUC03Host(assembly(provenance));
    assert.equal(refused.status, 'unavailable');
    if (refused.status !== 'unavailable') continue;
    assert.ok(refused.reasons.every(reason => reason.kind === 'component' && reason.reasonCode === 'incompatible-delivery'), JSON.stringify(refused.reasons));
  }
  assert.deepEqual(CALLS, []);

  // A missing owner delivery and a stale revision are the two other gaps the operator can close.
  const missing = prepareUC03Host({ ...assembly(), owner: OWNER_COMPONENTS.slice(0, -1).map(component => delivery(component)) });
  assert.deepEqual(missing, { status: 'unavailable', reasons: [{ kind: 'component', component: OWNER_COMPONENTS.at(-1), reasonCode: 'incompatible-delivery' }] });
  const stale = prepareUC03Host({ ...assembly(), owner: OWNER_COMPONENTS.map(component => (component === 'replanPort' ? { ...delivery(component), revision: 'd'.repeat(40) } : delivery(component))) });
  assert.deepEqual(stale, { status: 'unavailable', reasons: [{ kind: 'component', component: 'replanPort', reasonCode: 'stale-revision' }] });
});

/* ------------------------------------------------------------- route entries */

test('the assembled route stops at the first owner reload, not at a hidden step', async () => {
  reset();
  const result = await runUC03GraphV02(createFixtureBugTask(), readyPorts(), CONFIG);
  assert.equal(result.outcome, 'INCOMPLETE');
  assert.equal(result.state, null);
  assert.deepEqual(result.reasons, ['Authoritative task state is missing']);
  assert.deepEqual(CALLS, ['statePort.loadTask'], 'one owner reload, and no provider, command, patch or approval effect');
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

/* ---------------------------------------------------------------- evaluator */

test('the evaluator reports a refused production run as controlled and incomplete', async () => {
  reset();
  const host: WorkflowCaseHost = { entry: catalogEntry('C01'), task: createFixtureBugTask(), expectedWait: null, production: { ports: readyPorts(), config: CONFIG } };
  const report = await runEvaluation({ ...OPTIONS, mode: 'mock', cases: ['C01'], driver: createWorkflowDriver(new Map([['C01', host]])) });
  const [observed] = report.cases;
  assert.ok(observed);

  assert.equal(report.tier, 'controlled');
  assert.equal(report.isRealVerified, false);
  assert.deepEqual(report.suiteAcceptance, { scope: 'catalog', requiredCases: 17, satisfiedCases: 0, outcome: 'fail' });
  assert.equal(observed.workflowOutcome, 'INCOMPLETE');
  assert.equal(observed.grade, 'fail');
  assert.equal(observed.gradeReason, 'criteria-violation');
  assert.equal(observed.effects, 'uncertain', 'a route that returned no state may have dispatched');
  assert.equal(observed.usage, 'unavailable');
  assert.deepEqual(observed.artifacts, [], 'no evidence artifact was produced');
  assert.deepEqual(observed.limitations, ['No authoritative final report was produced.']);
  assert.deepEqual(CALLS, ['statePort.loadTask']);
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

/* ---------------------------------------------------------------------- CLI */

function hostFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'uc03-pipeline-')), 'host.json');
  writeFileSync(
    path,
    JSON.stringify({ profileId: 'profile-001', profileDigest: DIGEST, configDigest: DIGEST, pricingDigest: DIGEST, requestedModel: 'controlled-model', adapterVersions: ['uc03-adapter-1'], contractVersion: CONTRACT, revisions: PINS.revisions }),
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

test('CLI run binds the assembled route and reports the same incomplete outcome', async () => {
  reset();
  const production = (ready: { ports: UC03GraphPortsV02; config: UC03GraphConfigV02 }) =>
    createWorkflowDriver(new Map([['C01', { entry: catalogEntry('C01'), task: createFixtureBugTask(), expectedWait: null, production: { ports: ready.ports, config: ready.config } }]]));
  const result = await runEvaluateCli(['run', '--host', hostFile(), '--cases', 'C01'], options({ production }));
  assert.equal(result.exitCode, 1, result.output);
  const report = JSON.parse(result.output.slice(0, result.output.indexOf('\nUC-03 Workflow Evaluation'))) as {
    readonly tier: string;
    readonly isRealVerified: boolean;
    readonly suiteAcceptance: { readonly requiredCases: number; readonly satisfiedCases: number; readonly outcome: string };
    readonly cases: readonly { readonly gradeReason: string; readonly workflowOutcome: string }[];
  };
  assert.equal(report.tier, 'controlled');
  assert.equal(report.isRealVerified, false);
  assert.deepEqual(report.suiteAcceptance, { scope: 'catalog', requiredCases: 17, satisfiedCases: 0, outcome: 'fail' });
  assert.equal(report.cases[0]?.gradeReason, 'criteria-violation');
  assert.equal(report.cases[0]?.workflowOutcome, 'INCOMPLETE');
  assert.deepEqual(CALLS, ['statePort.loadTask']);
});

test('CLI run without a production binding is a named prerequisite gap, never a mock fallback', async () => {
  reset();
  const result = await runEvaluateCli(['run', '--host', hostFile(), '--cases', 'C01'], options());
  assert.equal(result.exitCode, 4);
  assert.equal(JSON.parse(result.output).error, 'HOST_ROUTE_UNAVAILABLE');
  assert.deepEqual(CALLS, []);
});

/* --------------------------------------------------- pre-admission producers */

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

  assert.equal(await denied(() => capability({ ...CONTROL, taskId: 'task-other' }, () => ({ ...CONTROL, receiptId: 'r' })).mediateRead({ kind: 'read', targetPath: 'src/app.py', execute: closure })), 'READ_CONTROL_MISMATCH');
  assert.equal(await denied(() => capability(CONTROL, () => null).mediateRead({ kind: 'read', targetPath: 'src/app.py', execute: closure })), 'READ_FENCED');
  assert.equal(executed, 0, 'a refused read never invokes the repository closure');
});

test('the baseline producers refuse an absent owner fact instead of inventing one', async () => {
  const absentLookup = createBaselineEvidenceAdapter({ provenance: 'real', persist: () => ({ outcome: 'denied', reason: 'not supplied' }) });
  await assert.rejects(() => absentLookup.loadBaselineEvidence('task-1', 'ws-1', 'repo-1', 'evidence-1'), /BASELINE_EVIDENCE_LOOKUP_UNAVAILABLE/u);

  const missing = createBaselineEvidenceAdapter({ provenance: 'real', persist: () => ({ outcome: 'denied', reason: 'not supplied' }), load: () => ({ outcome: 'missing' }) });
  assert.equal(await missing.loadBaselineEvidence('task-1', 'ws-1', 'repo-1', 'evidence-1'), null);

  const uncertain = createBaselineEvidenceAdapter({ provenance: 'real', persist: () => ({ outcome: 'denied', reason: 'not supplied' }), load: () => ({ outcome: 'uncertain', reason: 'owner unreachable' }) });
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
