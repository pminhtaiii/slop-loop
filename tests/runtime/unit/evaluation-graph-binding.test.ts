/** Per-case evaluation graph binding and startup route validation tests. */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { BugTask } from '../../../src/contracts/foundation/uc03.ts';
import { createEvaluationConsoleHost, type EvaluationConsoleAssembly } from '../../../src/runtime/evaluation-console-host.ts';
import { createUC03EvaluationGraph, type UC03EvaluationGraphRoute } from '../../../src/runtime/evaluation-graph.ts';
import { reportUC03GraphResult, validateEvaluationGraphReportBinding, type EvaluationGraphReportBinding } from '../../../src/runtime/evaluation-graph-report.ts';
import { admitEvaluationProfile, type CatalogEntry } from '../../../src/runtime/evaluation-profile.ts';
import { createEvaluationService, type ServiceControlReceipt } from '../../../src/runtime/evaluation-service.ts';
import { prepareControlledUC03Host, type UC03ControlledHostReadiness, type UC03HostReadiness } from '../../../src/runtime/uc03-host-bootstrap.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { checkProductionPortsV02, type UC03GraphConfigV02, type UC03GraphPortsV02 } from '../../../src/uc03/graph-types-v02.ts';
import { controlledGeneratedPlanFixture } from '../support/uc03/controlled-host-journey.ts';

const digest = (seed: string): string => sha256Text(seed);

function throwingStartupReadiness(identity: Readonly<Record<string, string>>, touches: string[]): Extract<UC03ControlledHostReadiness, { status: 'controlled-ready' }> {
  const throwUnbound = (area: string): never => {
    touches.push(area);
    throw new Error(`TASK_UNBOUND:${area}`);
  };
  const throwingProxy = <T extends object>(area: string): T =>
    new Proxy({} as T, {
      get(_target, property) {
        return throwUnbound(`${area}.${String(property)}`);
      },
      has(_target, property) {
        return throwUnbound(`${area}.has(${String(property)})`);
      },
      ownKeys() {
        return throwUnbound(`${area}.ownKeys`);
      },
    });
  return {
    status: 'controlled-ready',
    identity: Object.freeze({ ...identity }),
    ports: throwingProxy<UC03GraphPortsV02>('ports'),
    config: throwingProxy<UC03GraphConfigV02>('config'),
  };
}

function throwingRealStartupReadiness(identity: Readonly<Record<string, string>>, touches: string[]): Extract<UC03HostReadiness, { status: 'ready' }> {
  const controlled = throwingStartupReadiness(identity, touches);
  return { ...controlled, status: 'ready' };
}

function createCatalogProfile(entries: readonly { caseId: string; initialRevisionDigest: string }[]) {
  const files = mkdtempSync(join(tmpdir(), 'uc03-case-binding-'));
  const catalog: CatalogEntry[] = entries.map(item => {
    const fixturePath = join(files, `${item.caseId}-case.json`);
    const graderPath = join(files, `${item.caseId}-grader.json`);
    writeFileSync(fixturePath, '{}', 'utf8');
    writeFileSync(graderPath, '{}', 'utf8');
    return {
      catalogEntryId: `entry-${item.caseId}-bind`,
      caseId: item.caseId,
      version: '1.0.0',
      caseDigest: digest(`case-${item.caseId}`),
      publicTaskDigest: digest(`task-${item.caseId}`),
      initialRepositoryDigest: item.initialRevisionDigest.replace(/^sha256:/u, ''),
      fixturePath,
      fixtureDigest: digest(`fixture-${item.caseId}`),
      grader: { version: '1.0.0', digest: digest(`grader-${item.caseId}`), path: graderPath },
    };
  });
  const admitted = admitEvaluationProfile({
    endpoint: 'https://provider.invalid/v1/messages',
    model: 'controlled-model',
    mode: 'nonstreaming',
    credentialRef: 'controlled-binding-key',
    codeDigest: digest('binding-code'),
    configDigest: digest('binding-config'),
    imageDigest: `sha256:${digest('binding-image')}`,
    platform: 'linux/amd64',
    adapterVersions: ['controlled-binding-adapter-1'],
    pricing: { pricingId: 'binding-price-1', inputRate: 1, outputRate: 1, cacheRate: 0, overheadRate: 0, denominator: 1 },
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
  });
  assert.ok(admitted.ok, admitted.ok ? '' : admitted.reasonCode);
  const profile = admitted.value;
  const identity = {
    profileId: profile.profileId,
    profileDigest: profile.profileDigest,
    configDigest: profile.configDigest,
    pricingDigest: profile.pricingDigest,
  };
  const configuration = {
    identity,
    profileDigest: profile.profileDigest,
    configDigest: profile.configDigest,
    pricingDigest: profile.pricingDigest,
    requestedModel: profile.model,
    adapterVersions: profile.adapterVersions,
  };
  return { files, catalog, profile, identity, configuration };
}

function prepareCaseBundle(fixture: Awaited<ReturnType<typeof controlledGeneratedPlanFixture>>, identity: Readonly<Record<string, string>>) {
  const readiness = prepareControlledUC03Host({
    ...fixture.host.inputs,
    identity,
    config: { ...fixture.host.inputs.config, generation: undefined },
  });
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') throw new Error('Controlled case bundle was refused');
  return { task: fixture.task, ports: readiness.ports, config: readiness.config };
}

test('bound cases run on distinct per-case ports and config across intake, generation and continuation without touching startup readiness', async () => {
  const fixtureA = await controlledGeneratedPlanFixture();
  const fixtureB = await controlledGeneratedPlanFixture({
    firstResponse: {
      proposalId: 'case-b-ask',
      content: JSON.stringify({ kind: 'request-info', proposalId: 'case-b-ask', questions: [{ questionId: 'q-denominator', text: 'What error should divide(a, 0) raise?' }], evidenceRefs: [] }),
    },
  });
  const env = createCatalogProfile([
    { caseId: 'C01', initialRevisionDigest: fixtureA.task.initialRevisionDigest },
    { caseId: 'C02', initialRevisionDigest: fixtureB.task.initialRevisionDigest },
  ]);
  const startupTouches: string[] = [];
  const startupReadiness = throwingStartupReadiness(env.identity, startupTouches);
  const bundleA = prepareCaseBundle(fixtureA, env.identity);
  const bundleB = prepareCaseBundle(fixtureB, env.identity);
  const events: string[] = [];
  let bindCallsA = 0;
  let bindCallsB = 0;

  try {
    const graph = createUC03EvaluationGraph({
      catalogRoutes: new Map<string, UC03EvaluationGraphRoute>([
        [
          'C01',
          {
            entry: env.catalog[0],
            readiness: startupReadiness,
            coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
            expectedWait: 'waiting-approval',
            resolveTask: () => {
              events.push('resolveTask:C01');
              return fixtureA.task;
            },
            bindCase: input => {
              bindCallsA += 1;
              events.push(`bindCase:C01:${input.experimentId}`);
              assert.equal(input.task.taskId, fixtureA.task.taskId);
              return { ok: true, ...bundleA };
            },
            resolveDirection: () => undefined,
          },
        ],
        [
          'C02',
          {
            entry: env.catalog[1],
            readiness: startupReadiness,
            coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
            expectedWait: 'waiting-info',
            resolveTask: () => {
              events.push('resolveTask:C02');
              return { ...fixtureB.task, goal: 'Initial unresolved placeholder goal' };
            },
            bindCase: input => {
              bindCallsB += 1;
              events.push(`bindCase:C02:${input.experimentId}`);
              assert.equal(input.task.goal, 'Initial unresolved placeholder goal');
              return { ok: true, ...bundleB };
            },
            resolveDirection: () => undefined,
          },
        ],
      ]),
    });

    let seq = 0;
    const service = createEvaluationService({
      profile: env.profile,
      catalog: env.catalog,
      repositoryIds: [fixtureA.task.repositoryId],
      checkSetIds: ['checks-configured'],
      control: {
        issue: input => ({
          receiptRef: `ctrl-${input.experimentId}-${input.expectedControlVersion + 1}`,
          kind: input.kind,
          taskId: fixtureA.task.taskId,
          controlVersion: input.expectedControlVersion + 1,
        }),
      },
      graph,
      ids: () => `exp-bind-${++seq}`,
    });

    const startedA = await service.startExperiment({
      source: { kind: 'catalog', caseIds: ['C01'] },
      profileId: env.profile.profileId,
      idempotencyKey: 'bind-start-a',
    });
    assert.ok(startedA.ok);
    assert.equal(startedA.value.experiment.status, 'waiting-approval');
    assert.equal(startedA.value.experiment.taskId, fixtureA.task.taskId);
    assert.deepEqual(fixtureA.modelCalls, ['coder:propose-plan', 'coder:propose-plan']);
    assert.deepEqual(fixtureB.modelCalls, []);
    assert.deepEqual(events.slice(0, 2), ['resolveTask:C01', 'bindCase:C01:exp-bind-1']);

    // Approve D0 on fixtureA only, then continue the same experiment -> bindCase must NOT run again.
    const d0 = fixtureA.route.approvalPort.getRecordedBindings().at(-1);
    assert.ok(d0);
    const snapA = await fixtureA.statePort.readVerificationAuthoritySnapshot(fixtureA.task.taskId);
    assert.ok(snapA);
    const nextA = { ...snapA.policyIdentity, decisionAuthorityGeneration: snapA.decisionAuthorityGeneration + 1 };
    assert.equal((await fixtureA.statePort.publishAuthority({ authorityRef: nextA })).status, 'published');
    fixtureA.route.approvalPort.setV02AuthorityRef(nextA);
    fixtureA.route.approvalPort.scriptDecision({ ...d0, status: 'approved' });
    const ownerA = await fixtureA.statePort.loadTask(fixtureA.task.taskId);
    assert.ok(ownerA);
    const dirA = await service.issueDirection({
      id: startedA.value.experiment.id,
      expectedTaskVersion: ownerA.stateVersion,
      expectedControlVersion: 0,
      kind: 'resume',
      idempotencyKey: 'bind-dir-a',
    });
    assert.ok(dirA.ok);
    assert.ok('receiptRef' in dirA.value.receipt);
    const contA = await service.continueExperiment({
      id: startedA.value.experiment.id,
      expectedVersion: dirA.value.experiment.version,
      directionRef: dirA.value.receipt.receiptRef,
      idempotencyKey: 'bind-cont-a',
    });
    assert.ok(contA.ok);
    assert.equal(contA.value.experiment.status, 'waiting-approval');
    assert.deepEqual(fixtureA.modelCalls, ['coder:propose-plan', 'coder:propose-plan', 'coder:propose-patch']);
    assert.equal(bindCallsA, 1);

    // Approve D1 on fixtureA so experiment 1 reaches terminal implemented-unverified before starting C02.
    const d1 = fixtureA.route.approvalPort.getRecordedBindings().at(-1);
    assert.ok(d1);
    const snapA2 = await fixtureA.statePort.readVerificationAuthoritySnapshot(fixtureA.task.taskId);
    assert.ok(snapA2);
    const nextA2 = { ...snapA2.policyIdentity, decisionAuthorityGeneration: snapA2.decisionAuthorityGeneration + 1 };
    assert.equal((await fixtureA.statePort.publishAuthority({ authorityRef: nextA2 })).status, 'published');
    fixtureA.route.approvalPort.setV02AuthorityRef(nextA2);
    fixtureA.route.approvalPort.scriptDecision({ ...d1, status: 'approved' });
    fixtureA.route.repositoryPort.setCommandResult('pytest -q tests/test_calculator.py -k test_divide_zero', { exitCode: 0, stdout: '1 passed', stderr: '' });
    const ownerA2 = await fixtureA.statePort.loadTask(fixtureA.task.taskId);
    assert.ok(ownerA2);
    const dirA2 = await service.issueDirection({
      id: startedA.value.experiment.id,
      expectedTaskVersion: ownerA2.stateVersion,
      expectedControlVersion: 1,
      kind: 'resume',
      idempotencyKey: 'bind-dir-a2',
    });
    assert.ok(dirA2.ok);
    assert.ok('receiptRef' in dirA2.value.receipt);
    const contA2 = await service.continueExperiment({
      id: startedA.value.experiment.id,
      expectedVersion: dirA2.value.experiment.version,
      directionRef: dirA2.value.receipt.receiptRef,
      idempotencyKey: 'bind-cont-a2',
    });
    assert.ok(contA2.ok);
    assert.equal(contA2.value.experiment.status, 'implemented-unverified');
    assert.equal(bindCallsA, 1);

    const startedB = await service.startExperiment({
      source: { kind: 'catalog', caseIds: ['C02'] },
      profileId: env.profile.profileId,
      idempotencyKey: 'bind-start-b',
    });
    assert.ok(startedB.ok);
    assert.equal(startedB.value.experiment.status, 'waiting-info');
    assert.deepEqual(fixtureB.modelCalls, ['coder:propose-plan']);
    assert.equal(bindCallsB, 1);
    assert.equal((await fixtureB.statePort.loadTask(fixtureB.task.taskId))?.node, 'NeedsInfo');
    assert.deepEqual(startupTouches, [], 'startup readiness ports/config must never be touched');
  } finally {
    await rm(env.files, { recursive: true, force: true });
  }
});

test('clarification resume and custom route use the per-case binding once per experiment without touching startup readiness', async () => {
  const fixture = await controlledGeneratedPlanFixture({
    taskState: { evidenceRefs: ['src/calculator.py'] },
    firstResponse: {
      proposalId: 'bind-clarification-ask',
      content: JSON.stringify({
        kind: 'request-info',
        proposalId: 'bind-clarification-ask',
        questions: [{ questionId: 'q-denominator', text: 'What should zero division return?' }],
        evidenceRefs: [],
      }),
    },
  });
  const env = createCatalogProfile([{ caseId: 'C02', initialRevisionDigest: fixture.task.initialRevisionDigest }]);
  const startupTouches: string[] = [];
  const startupReadiness = throwingStartupReadiness(env.identity, startupTouches);
  const bundle = prepareCaseBundle(fixture, env.identity);
  const ownerDirections = new Map<string, Readonly<{ receipt: ServiceControlReceipt; taskVersion: number }>>();
  let catalogBindCalls = 0;
  let customBindCalls = 0;

  try {
    const graph = createUC03EvaluationGraph({
      catalogRoutes: new Map([
        [
          'C02',
          {
            entry: env.catalog[0],
            readiness: startupReadiness,
            coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
            expectedWait: 'waiting-info',
            resolveTask: () => fixture.task,
            bindCase: () => {
              catalogBindCalls += 1;
              return { ok: true, ...bundle };
            },
            resolveDirection: () => undefined,
            async resolveClarificationResume(input) {
              const current = await fixture.statePort.loadTask(fixture.task.taskId);
              const stored = input.direction ? ownerDirections.get(input.direction.receiptRef) : undefined;
              if (!current || !stored || !input.direction || stored.taskVersion !== current.stateVersion || current.node !== 'NeedsInfo' || !current.clarification) return undefined;
              return {
                receiptRef: input.direction.receiptRef,
                controlVersion: input.direction.controlVersion,
                taskId: current.taskId,
                runId: current.runId,
                workspaceId: current.workspaceId,
                stateVersion: current.stateVersion,
                questionId: current.clarification.questionId,
                questionDigest: current.clarification.questionDigest,
                answerDigest: input.expectedAnswerDigest,
              };
            },
          },
        ],
      ]),
    });
    let seq = 0;
    const service = createEvaluationService({
      profile: env.profile,
      catalog: env.catalog,
      repositoryIds: [fixture.task.repositoryId],
      checkSetIds: ['checks-configured'],
      control: {
        async issue(input) {
          const receipt = Object.freeze({ receiptRef: `ctrl-clar-${++seq}`, kind: input.kind, taskId: fixture.task.taskId, controlVersion: input.expectedControlVersion + 1 });
          ownerDirections.set(receipt.receiptRef, { receipt, taskVersion: input.expectedTaskVersion });
          return receipt;
        },
      },
      graph,
      ids: () => `exp-clar-${seq + 1}`,
    });

    const started = await service.startExperiment({
      source: { kind: 'catalog', caseIds: ['C02'] },
      profileId: env.profile.profileId,
      idempotencyKey: 'clar-start',
    });
    assert.ok(started.ok);
    assert.equal(started.value.experiment.status, 'waiting-info');
    const paused = await fixture.statePort.loadTask(fixture.task.taskId);
    assert.ok(paused?.clarification);

    const answered = await service.answerClarification({
      id: started.value.experiment.id,
      questionId: paused.clarification.questionId,
      questionDigest: paused.clarification.questionDigest,
      expectedVersion: started.value.experiment.version,
      answers: ['Raise CalculationError when dividing by zero.'],
      idempotencyKey: 'clar-answer',
    });
    assert.ok(answered.ok);

    const direction = await service.issueDirection({
      id: started.value.experiment.id,
      expectedTaskVersion: paused.stateVersion,
      expectedControlVersion: 0,
      kind: 'resume',
      idempotencyKey: 'clar-dir',
    });
    assert.ok(direction.ok);
    assert.ok('receiptRef' in direction.value.receipt);

    const continued = await service.continueExperiment({
      id: started.value.experiment.id,
      expectedVersion: direction.value.experiment.version,
      directionRef: direction.value.receipt.receiptRef,
      idempotencyKey: 'clar-cont',
    });
    assert.ok(continued.ok);
    assert.equal(continued.value.experiment.status, 'waiting-approval');
    assert.equal((await fixture.statePort.loadTask(fixture.task.taskId))?.node, 'AwaitPlan');
    assert.deepEqual(fixture.modelCalls, ['coder:propose-plan', 'coder:propose-plan']);
    assert.equal(catalogBindCalls, 1, 'clarification resume reuses the single bound session');
    assert.equal(customBindCalls, 0);
    assert.deepEqual(startupTouches, []);

    // Custom route binding refuses if startup readiness ports are touched, and succeeds on its own ports.
    const customFixture = await controlledGeneratedPlanFixture();
    const customBundle = prepareCaseBundle(customFixture, env.identity);
    const customGraph = createUC03EvaluationGraph({
      catalogRoutes: new Map(),
      customRoute: {
        readiness: startupReadiness,
        coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
        expectedWait: 'waiting-approval',
        resolveTask: () => customFixture.task,
        bindCase: () => {
          customBindCalls += 1;
          return { ok: true, ...customBundle };
        },
        resolveDirection: () => undefined,
      },
    });
    const customService = createEvaluationService({
      profile: env.profile,
      catalog: env.catalog,
      repositoryIds: [customFixture.task.repositoryId],
      checkSetIds: ['checks-configured'],
      control: { issue: input => ({ receiptRef: 'unused', kind: input.kind, taskId: customFixture.task.taskId, controlVersion: input.expectedControlVersion + 1 }) },
      graph: customGraph,
      ids: () => 'exp-custom-bind',
    });
    const customStarted = await customService.startExperiment({
      source: {
        kind: 'bug',
        repositoryId: customFixture.task.repositoryId,
        checkSetId: 'checks-configured',
        bugInput: {
          goal: customFixture.task.goal,
          observedBehavior: customFixture.task.observedBehavior,
          expectedBehavior: customFixture.task.expectedBehavior,
          reproduction: customFixture.task.reproduction,
          acceptanceCriteria: [...customFixture.task.acceptanceCriteria],
          constraints: [...customFixture.task.constraints],
        },
      },
      profileId: env.profile.profileId,
      idempotencyKey: 'custom-bind-start',
    });
    assert.ok(customStarted.ok);
    assert.equal(customStarted.value.experiment.status, 'waiting-approval');
    assert.equal(customBindCalls, 1);
    assert.deepEqual(startupTouches, []);
  } finally {
    await rm(env.files, { recursive: true, force: true });
  }
});

test('failing, throwing or malformed per-case bindings refuse without graph effects or startup fallback', async () => {
  const fixture = await controlledGeneratedPlanFixture();
  const env = createCatalogProfile([{ caseId: 'C01', initialRevisionDigest: fixture.task.initialRevisionDigest }]);
  const startupTouches: string[] = [];
  const startupControlled = throwingStartupReadiness(env.identity, startupTouches);
  const startupReal = throwingRealStartupReadiness(env.identity, startupTouches);
  const validBundle = prepareCaseBundle(fixture, env.identity);

  let stateLoads = 0;
  const wrappedStatePort = new Proxy(validBundle.ports.statePort, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property === 'loadTask' && typeof value === 'function') {
        return (...args: Parameters<typeof target.loadTask>) => {
          stateLoads += 1;
          return value.apply(target, args);
        };
      }
      return value;
    },
  });
  const trackedPorts = { ...validBundle.ports, statePort: wrappedStatePort };

  const badCases: readonly Readonly<{
    name: string;
    readiness: UC03EvaluationGraphRoute['readiness'];
    bindCase: UC03EvaluationGraphRoute['bindCase'];
  }>[] = [
    {
      name: 'bounded refusal',
      readiness: startupControlled,
      bindCase: () => ({ ok: false, reasonCode: 'CASE_BINDING_REFUSED' }),
    },
    {
      name: 'throwing bindCase',
      readiness: startupControlled,
      bindCase: () => {
        throw new Error('private-bind-error');
      },
    },
    {
      name: 'null binding',
      readiness: startupControlled,
      bindCase: () => null as unknown as ReturnType<NonNullable<UC03EvaluationGraphRoute['bindCase']>>,
    },
    {
      name: 'invalid task',
      readiness: startupControlled,
      bindCase: () => ({ ok: true, task: { ...fixture.task, taskId: '' } as BugTask, ports: trackedPorts, config: validBundle.config }),
    },
    {
      name: 'mismatched initial revision',
      readiness: startupControlled,
      bindCase: () => ({
        ok: true,
        task: { ...fixture.task, initialRevisionDigest: `sha256:${digest('wrong-rev')}` },
        ports: trackedPorts,
        config: validBundle.config,
      }),
    },
    {
      name: 'missing port',
      readiness: startupControlled,
      bindCase: () => ({
        ok: true,
        task: fixture.task,
        ports: { ...trackedPorts, statePort: undefined } as unknown as UC03GraphPortsV02,
        config: validBundle.config,
      }),
    },
    {
      name: 'mock ports on production-ready route',
      readiness: startupReal,
      bindCase: () => ({ ok: true, task: fixture.task, ports: trackedPorts, config: validBundle.config }),
    },
    {
      name: 'pre-supplied generation in config',
      readiness: startupControlled,
      bindCase: () => ({
        ok: true,
        task: fixture.task,
        ports: trackedPorts,
        config: { ...validBundle.config, generation: { agentFor: () => undefined as never } },
      }),
    },
    {
      name: 'invalid recursionLimit in config',
      readiness: startupControlled,
      bindCase: () => ({
        ok: true,
        task: fixture.task,
        ports: trackedPorts,
        config: { ...validBundle.config, recursionLimit: 0 },
      }),
    },
    {
      name: 'missing admissionContextForCheck in config',
      readiness: startupControlled,
      bindCase: () => ({
        ok: true,
        task: fixture.task,
        ports: trackedPorts,
        config: {
          ...validBundle.config,
          trustedExpectedContext: { ...validBundle.config.trustedExpectedContext, admissionContextForCheck: undefined },
        } as unknown as UC03GraphConfigV02,
      }),
    },
    {
      name: 'mismatched taskId in trustedExpectedContext',
      readiness: startupControlled,
      bindCase: () => ({
        ok: true,
        task: fixture.task,
        ports: trackedPorts,
        config: {
          ...validBundle.config,
          trustedExpectedContext: { ...validBundle.config.trustedExpectedContext, taskId: 'other-task-id' },
        },
      }),
    },
  ];

  try {
    let idx = 0;
    for (const item of badCases) {
      const graph = createUC03EvaluationGraph({
        catalogRoutes: new Map([
          [
            'C01',
            {
              entry: env.catalog[0],
              readiness: item.readiness,
              coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
              expectedWait: 'waiting-approval',
              resolveTask: () => fixture.task,
              bindCase: item.bindCase,
              resolveDirection: () => undefined,
            },
          ],
        ]),
      });
      const service = createEvaluationService({
        profile: env.profile,
        catalog: env.catalog,
        repositoryIds: [fixture.task.repositoryId],
        checkSetIds: ['checks-configured'],
        control: { issue: input => ({ receiptRef: 'unused', kind: input.kind, taskId: fixture.task.taskId, controlVersion: input.expectedControlVersion + 1 }) },
        graph,
        ids: () => `exp-bad-${++idx}`,
      });
      const started = await service.startExperiment({
        source: { kind: 'catalog', caseIds: ['C01'] },
        profileId: env.profile.profileId,
        idempotencyKey: `bad-bind-${idx}`,
      });
      assert.ok(started.ok, item.name);
      assert.equal(started.value.experiment.status, 'incomplete', item.name);
      assert.equal(started.value.experiment.taskId, null, item.name);
    }
    assert.equal(stateLoads, 0, 'malformed or refused bindings must not invoke loadTask');
    assert.deepEqual(fixture.modelCalls, [], 'malformed or refused bindings must not invoke model');
    assert.deepEqual(startupTouches, [], 'malformed or refused bindings must never fall back to startup readiness');
  } finally {
    await rm(env.files, { recursive: true, force: true });
  }
});

test('console host startup route validation admits valid bound routes, rejects malformed ones, and leaves readiness untouched until request', async () => {
  const fixture = await controlledGeneratedPlanFixture();
  const env = createCatalogProfile([{ caseId: 'C01', initialRevisionDigest: fixture.task.initialRevisionDigest }]);
  const startupTouches: string[] = [];
  const startupReadiness = throwingStartupReadiness(env.identity, startupTouches);
  const bundle = prepareCaseBundle(fixture, env.identity);
  const token = 'controlled-binding-operator-token';
  let bindCalls = 0;

  const baseAssembly: EvaluationConsoleAssembly = {
    profile: env.profile,
    catalog: env.catalog,
    repositoryIds: [fixture.task.repositoryId],
    checkSetIds: ['checks-configured'],
    control: { issue: input => ({ receiptRef: 'ctrl-host', kind: input.kind, taskId: fixture.task.taskId, controlVersion: input.expectedControlVersion + 1 }) },
    approval: {
      presentation: () => ({ ok: true, value: { status: 'pending' } }),
      decide: () => ({ ok: true, value: { status: 'approved' } }),
    },
    routesFor: (ready, catalog) =>
      new Map([
        [
          'C01',
          {
            entry: catalog[0],
            readiness: ready,
            coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
            expectedWait: 'waiting-approval',
            resolveTask: () => fixture.task,
            bindCase: () => {
              bindCalls += 1;
              return { ok: true, ...bundle };
            },
            resolveDirection: () => undefined,
          },
        ],
      ]),
    operatorToken: () => token,
  };

  try {
    const malformed = await createEvaluationConsoleHost(startupReadiness, env.configuration, () => ({
      ...baseAssembly,
      routesFor: (ready, catalog) => {
        const route = baseAssembly.routesFor(ready, catalog).get('C01');
        assert.ok(route);
        return new Map([['C01', { ...route, bindCase: 'not-a-function' as unknown as UC03EvaluationGraphRoute['bindCase'] }]]);
      },
    }));
    assert.deepEqual(malformed, { ok: false, reasonCode: 'HOST_CONSOLE_UNAVAILABLE' });

    const malformedCustom = await createEvaluationConsoleHost(startupReadiness, env.configuration, () => ({
      ...baseAssembly,
      customRoute: {
        readiness: startupReadiness,
        coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
        expectedWait: 'waiting-approval',
        resolveTask: () => fixture.task,
        bindCase: 'not-a-function' as unknown as UC03EvaluationGraphRoute['bindCase'],
        resolveDirection: () => undefined,
      },
    }));
    assert.deepEqual(malformedCustom, { ok: false, reasonCode: 'HOST_CONSOLE_UNAVAILABLE' });

    const mismatchedReadiness = await createEvaluationConsoleHost(startupReadiness, env.configuration, () => ({
      ...baseAssembly,
      routesFor: (ready, catalog) => {
        const route = baseAssembly.routesFor(ready, catalog).get('C01');
        assert.ok(route);
        return new Map([['C01', { ...route, readiness: { ...ready } }]]);
      },
    }));
    assert.deepEqual(mismatchedReadiness, { ok: false, reasonCode: 'HOST_CONSOLE_UNAVAILABLE' });
    assert.equal(bindCalls, 0);

    const started = await createEvaluationConsoleHost(startupReadiness, env.configuration, () => baseAssembly);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    try {
      assert.equal(bindCalls, 0, 'startup validation must not invoke bindCase');
      assert.deepEqual(startupTouches, [], 'startup validation must not touch readiness ports or config');
      const origin = `http://${started.host.address.host}:${started.host.address.port}`;
      const response = await fetch(`${origin}/api/experiments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-operator-token': token },
        body: JSON.stringify({ profileId: env.profile.profileId, idempotencyKey: 'host-bind-start', source: { kind: 'catalog', caseIds: ['C01'] } }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { ok: boolean; result: { experiment: { status: string; taskId: string | null } } };
      assert.equal(body.ok, true);
      assert.equal(body.result.experiment.status, 'waiting-approval');
      assert.equal(body.result.experiment.taskId, fixture.task.taskId);
      assert.equal(bindCalls, 1);
      assert.deepEqual(startupTouches, []);
    } finally {
      await started.host.close();
    }
  } finally {
    await rm(env.files, { recursive: true, force: true });
  }
});

test('unbound route without bindCase retains pre-resolution generation check', async () => {
  const fixture = await controlledGeneratedPlanFixture();
  const env = createCatalogProfile([{ caseId: 'C01', initialRevisionDigest: fixture.task.initialRevisionDigest }]);
  const ready = prepareControlledUC03Host({ ...fixture.host.inputs, identity: env.identity });
  assert.equal(ready.status, 'controlled-ready');
  if (ready.status !== 'controlled-ready') return;
  let resolveTaskCalls = 0;

  try {
    // readiness.config.generation is defined (prepared without clearing generation) -> refuses before resolveTask.
    const graph = createUC03EvaluationGraph({
      catalogRoutes: new Map([
        [
          'C01',
          {
            entry: env.catalog[0],
            readiness: ready,
            coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
            expectedWait: 'waiting-approval',
            resolveTask: () => {
              resolveTaskCalls += 1;
              return fixture.task;
            },
            resolveDirection: () => undefined,
          },
        ],
      ]),
    });
    const service = createEvaluationService({
      profile: env.profile,
      catalog: env.catalog,
      repositoryIds: [fixture.task.repositoryId],
      checkSetIds: ['checks-configured'],
      control: { issue: input => ({ receiptRef: 'unused', kind: input.kind, taskId: fixture.task.taskId, controlVersion: input.expectedControlVersion + 1 }) },
      graph,
      ids: () => 'exp-unbound-gen',
    });
    const started = await service.startExperiment({
      source: { kind: 'catalog', caseIds: ['C01'] },
      profileId: env.profile.profileId,
      idempotencyKey: 'unbound-gen-start',
    });
    assert.ok(started.ok);
    assert.equal(started.value.experiment.status, 'incomplete');
    assert.equal(resolveTaskCalls, 0);
  } finally {
    await rm(env.files, { recursive: true, force: true });
  }
});

test('real-ready route refuses missing or malformed workflowEvidence at startup and rejects ungraded non-pending real reports', async () => {
  const fixture = await controlledGeneratedPlanFixture();
  const env = createCatalogProfile([{ caseId: 'C01', initialRevisionDigest: fixture.task.initialRevisionDigest }]);
  const startupTouches: string[] = [];
  const startupReal = throwingRealStartupReadiness(env.identity, startupTouches);
  const bundle = prepareCaseBundle(fixture, env.identity);
  const token = 'real-binding-operator-token';
  let bindCalls = 0;

  const baseBinding: EvaluationGraphReportBinding = {
    profileDigest: env.profile.profileDigest,
    configDigest: env.profile.configDigest,
    pricingDigest: env.profile.pricingDigest,
    adapterVersions: env.profile.adapterVersions,
    requestedModel: env.profile.model,
    timestamp: '2026-11-25T00:00:00.000Z',
  };
  const stubEvidence: NonNullable<EvaluationGraphReportBinding['workflowEvidence']> = {
    grader: {
      grade: async caseId => ({
        caseId: caseId === 'C01' ? 'C01' : null,
        criterionId: null,
        grade: 'not-run',
        reason: 'private-grading',
        evidenceIds: [],
        snapshot: null,
        evidenceDigest: null,
        criteriaDigest: `sha256:${digest('criteria')}`,
        limitations: ['stub'],
      }),
    },
    finalTree: {
      freezeFinalTree: () => undefined,
      recheckCurrentFinalTree: () => undefined,
    },
  };

  try {
    assert.throws(() => validateEvaluationGraphReportBinding('C01', env.identity, baseBinding, 'real'), /Real workflow report route requires host grading evidence/u);
    assert.throws(
      () => validateEvaluationGraphReportBinding('C01', env.identity, { ...baseBinding, workflowEvidence: {} as unknown as NonNullable<EvaluationGraphReportBinding['workflowEvidence']> }, 'real'),
      /Invalid workflow report evidence binding/u,
    );

    const ungradedRoute = {
      entry: env.catalog[0],
      readiness: startupReal,
      coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
      expectedWait: 'waiting-approval' as const,
      workflowReport: baseBinding,
      resolveTask: () => fixture.task,
      bindCase: () => {
        bindCalls += 1;
        return { ok: true as const, ...bundle };
      },
      resolveDirection: () => undefined,
    };

    assert.throws(() => createUC03EvaluationGraph({ catalogRoutes: new Map([['C01', ungradedRoute]]) }), /Real workflow report route requires host grading evidence/u);

    const consoleRefused = await createEvaluationConsoleHost(startupReal, env.configuration, () => ({
      profile: env.profile,
      catalog: env.catalog,
      repositoryIds: [fixture.task.repositoryId],
      checkSetIds: ['checks-configured'],
      control: { issue: input => ({ receiptRef: 'unused', kind: input.kind, taskId: fixture.task.taskId, controlVersion: input.expectedControlVersion + 1 }) },
      approval: { presentation: () => ({ ok: true, value: { status: 'pending' } }), decide: () => ({ ok: true, value: { status: 'approved' } }) },
      routesFor: () => new Map([['C01', ungradedRoute]]),
      operatorToken: () => token,
    }));
    assert.deepEqual(consoleRefused, { ok: false, reasonCode: 'HOST_CONSOLE_UNAVAILABLE' });

    const customRefused = await createEvaluationConsoleHost(startupReal, env.configuration, () => ({
      profile: env.profile,
      catalog: env.catalog,
      repositoryIds: [fixture.task.repositoryId],
      checkSetIds: ['checks-configured'],
      control: { issue: input => ({ receiptRef: 'unused', kind: input.kind, taskId: fixture.task.taskId, controlVersion: input.expectedControlVersion + 1 }) },
      approval: { presentation: () => ({ ok: true, value: { status: 'pending' } }), decide: () => ({ ok: true, value: { status: 'approved' } }) },
      routesFor: () => new Map([['C01', { ...ungradedRoute, workflowReport: { ...baseBinding, workflowEvidence: stubEvidence } }]]),
      customRoute: {
        readiness: startupReal,
        coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
        expectedWait: 'waiting-approval',
        workflowReport: { ...baseBinding, workflowEvidence: stubEvidence },
        resolveTask: () => fixture.task,
        resolveDirection: () => undefined,
      },
      operatorToken: () => token,
    }));
    assert.deepEqual(customRefused, { ok: false, reasonCode: 'HOST_CONSOLE_UNAVAILABLE' });
    assert.equal(bindCalls, 0);
    assert.deepEqual(startupTouches, []);

    const firstEntry = env.catalog[0];
    assert.ok(firstEntry);
    await assert.rejects(
      () =>
        reportUC03GraphResult({
          host: { entry: firstEntry, task: fixture.task, expectedWait: 'waiting-approval' },
          result: { outcome: 'COMPLETED', state: null, reasons: [], milestones: [] },
          ports: bundle.ports,
          generation: {},
          trustedExpectedContext: bundle.config.trustedExpectedContext,
          binding: baseBinding,
          mode: 'real',
        }),
      /Real workflow report requires host grading evidence/u,
    );

    let loadCalls = 0;
    const withRealProvenance = <T extends object>(port: T, extra?: Partial<T>): T =>
      new Proxy(port, {
        get(target, property) {
          if (property === 'provenance') return 'real';
          if (extra && Object.hasOwn(extra, property)) return Reflect.get(extra, property);
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const realTrackedPorts: UC03GraphPortsV02 = {
      ...bundle.ports,
      statePort: withRealProvenance(bundle.ports.statePort, {
        loadTask: async taskId => {
          loadCalls += 1;
          return bundle.ports.statePort.loadTask(taskId);
        },
      }),
      approvalPort: withRealProvenance(bundle.ports.approvalPort),
      repositoryPort: withRealProvenance(bundle.ports.repositoryPort),
      modelPort: withRealProvenance(bundle.ports.modelPort),
      reviewerModelPort: withRealProvenance(bundle.ports.reviewerModelPort),
      executionGuard: withRealProvenance(bundle.ports.executionGuard),
      guardedRead: withRealProvenance(bundle.ports.guardedRead),
      baselineEvidence: withRealProvenance(bundle.ports.baselineEvidence),
      contextSource: withRealProvenance(bundle.ports.contextSource),
      replanPort: withRealProvenance(bundle.ports.replanPort),
    };
    assert.equal(checkProductionPortsV02(realTrackedPorts), null);

    const runWithEvidence = async (id: string, workflowEvidence: NonNullable<EvaluationGraphReportBinding['workflowEvidence']>) => {
      loadCalls = 0;
      const graph = createUC03EvaluationGraph({
        catalogRoutes: new Map([
          [
            'C01',
            {
              entry: env.catalog[0],
              readiness: startupReal,
              coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
              expectedWait: 'waiting-approval',
              workflowReport: { ...baseBinding, workflowEvidence: stubEvidence },
              resolveTask: () => fixture.task,
              bindCase: () => ({
                ok: true,
                task: fixture.task,
                ports: realTrackedPorts,
                config: bundle.config,
                workflowEvidence,
              }),
              resolveDirection: () => undefined,
            },
          ],
        ]),
      });
      const service = createEvaluationService({
        profile: env.profile,
        catalog: env.catalog,
        repositoryIds: [fixture.task.repositoryId],
        checkSetIds: ['checks-configured'],
        control: { issue: input => ({ receiptRef: 'unused', kind: input.kind, taskId: fixture.task.taskId, controlVersion: input.expectedControlVersion + 1 }) },
        graph,
        ids: () => id,
      });
      const started = await service.startExperiment({
        source: { kind: 'catalog', caseIds: ['C01'] },
        profileId: env.profile.profileId,
        idempotencyKey: `${id}-start`,
      });
      return { started, loads: loadCalls };
    };

    const control = await runWithEvidence('exp-valid-evidence', stubEvidence);
    assert.ok(control.started.ok);
    assert.ok(control.loads > 0, 'control with valid workflowEvidence and real-provenance ports must reach loadTask');

    const malformed = await runWithEvidence('exp-bad-evidence', { grader: {}, finalTree: {} } as unknown as NonNullable<EvaluationGraphReportBinding['workflowEvidence']>);
    assert.ok(malformed.started.ok);
    assert.equal(malformed.started.value.experiment.status, 'incomplete');
    assert.equal(malformed.loads, 0);
  } finally {
    await rm(env.files, { recursive: true, force: true });
  }
});

test('clarification end closes NeedsInfo as bounded INCOMPLETE with zero model calls and refuses missing, mismatched, or revise directions', async () => {
  const mkClarifyFixture = () =>
    controlledGeneratedPlanFixture({
      taskState: { evidenceRefs: ['src/calculator.py'] },
      firstResponse: {
        proposalId: 'bind-clarification-end-ask',
        content: JSON.stringify({
          kind: 'request-info',
          proposalId: 'bind-clarification-end-ask',
          questions: [{ questionId: 'q-denominator', text: 'What should zero division return?' }],
          evidenceRefs: [],
        }),
      },
    });
  const fixture = await mkClarifyFixture();
  const followUp = await controlledGeneratedPlanFixture();
  const env = createCatalogProfile([
    { caseId: 'C02', initialRevisionDigest: fixture.task.initialRevisionDigest },
    { caseId: 'C01', initialRevisionDigest: followUp.task.initialRevisionDigest },
  ]);
  const startupTouches: string[] = [];
  const startupReadiness = throwingStartupReadiness(env.identity, startupTouches);
  const bundleC02 = prepareCaseBundle(fixture, env.identity);
  const bundleC01 = prepareCaseBundle(followUp, env.identity);
  const ownerDirections = new Map<string, Readonly<{ receipt: ServiceControlReceipt; taskVersion: number }>>();
  let endCalls = 0;

  try {
    const graph = createUC03EvaluationGraph({
      catalogRoutes: new Map<string, UC03EvaluationGraphRoute>([
        [
          'C02',
          {
            entry: env.catalog[0],
            readiness: startupReadiness,
            coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
            expectedWait: 'waiting-info',
            resolveTask: () => fixture.task,
            bindCase: () => ({ ok: true, ...bundleC02 }),
            resolveDirection: () => undefined,
            async resolveClarificationEnd(input) {
              endCalls += 1;
              const current = await fixture.statePort.loadTask(fixture.task.taskId);
              const stored = input.direction ? ownerDirections.get(input.direction.receiptRef) : undefined;
              if (!current || !stored || !input.direction || stored.taskVersion !== current.stateVersion || current.node !== 'NeedsInfo') return undefined;
              return {
                receiptRef: input.direction.receiptRef,
                controlVersion: input.direction.controlVersion,
                taskId: current.taskId,
                runId: current.runId,
                workspaceId: current.workspaceId,
                stateVersion: current.stateVersion,
              };
            },
          },
        ],
        [
          'C01',
          {
            entry: env.catalog[1],
            readiness: startupReadiness,
            coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
            expectedWait: 'waiting-approval',
            resolveTask: () => followUp.task,
            bindCase: () => ({ ok: true, ...bundleC01 }),
            resolveDirection: () => undefined,
          },
        ],
      ]),
    });

    let seq = 0;
    const service = createEvaluationService({
      profile: env.profile,
      catalog: env.catalog,
      repositoryIds: [fixture.task.repositoryId, followUp.task.repositoryId],
      checkSetIds: ['checks-configured'],
      control: {
        async issue(input) {
          const receipt = Object.freeze({ receiptRef: `ctrl-clar-end-${++seq}`, kind: input.kind, taskId: fixture.task.taskId, controlVersion: input.expectedControlVersion + 1 });
          ownerDirections.set(receipt.receiptRef, { receipt, taskVersion: input.expectedTaskVersion });
          return receipt;
        },
      },
      graph,
      ids: () => `exp-clar-end-${seq + 1}`,
    });

    const started = await service.startExperiment({
      source: { kind: 'catalog', caseIds: ['C02'] },
      profileId: env.profile.profileId,
      idempotencyKey: 'clar-end-start',
    });
    assert.ok(started.ok);
    assert.equal(started.value.experiment.status, 'waiting-info');
    assert.ok(started.value.experiment.workflowClarification);
    const paused = await fixture.statePort.loadTask(fixture.task.taskId);
    assert.ok(paused);
    const modelCallsAtPause = fixture.modelCalls.length;

    // Issue revise and continue -> refused without model call; owner state remains at NeedsInfo.
    const badReviseDir = await service.issueDirection({
      id: started.value.experiment.id,
      expectedTaskVersion: paused.stateVersion,
      expectedControlVersion: 0,
      kind: 'revise',
      idempotencyKey: 'clar-end-revise-dir',
    });
    assert.ok(badReviseDir.ok);
    assert.ok('receiptRef' in badReviseDir.value.receipt);
    const c02Entry = env.catalog[0];
    assert.ok(c02Entry);
    const ports = graph.portsFor({ experimentId: started.value.experiment.id, source: { kind: 'catalog', status: 'bound', bindings: [c02Entry] } });
    const refusedRevise = await graph.run({
      experimentId: started.value.experiment.id,
      source: { kind: 'catalog', status: 'bound', bindings: [c02Entry] },
      ports,
      priorState: { taskId: paused.taskId, runId: paused.runId, workspaceId: paused.workspaceId },
      direction: badReviseDir.value.receipt,
      answers: [],
    });
    assert.equal(refusedRevise.outcome, 'INCOMPLETE');
    assert.equal(fixture.modelCalls.length, modelCallsAtPause);
    assert.equal((await fixture.statePort.loadTask(fixture.task.taskId))?.node, 'NeedsInfo');

    // Valid end without answers closes experiment as incomplete, clears workflowClarification, and frees the server for the next experiment.
    const endDir = await service.issueDirection({
      id: started.value.experiment.id,
      expectedTaskVersion: paused.stateVersion,
      expectedControlVersion: 1,
      kind: 'end',
      idempotencyKey: 'clar-end-dir',
    });
    assert.ok(endDir.ok);
    assert.ok('receiptRef' in endDir.value.receipt);

    const ended = await service.continueExperiment({
      id: started.value.experiment.id,
      expectedVersion: endDir.value.experiment.version,
      directionRef: endDir.value.receipt.receiptRef,
      idempotencyKey: 'clar-end-cont',
    });
    assert.ok(ended.ok);
    assert.equal(ended.value.experiment.status, 'incomplete');
    assert.equal(ended.value.experiment.workflowClarification, null);
    assert.equal(endCalls, 1);
    assert.equal(fixture.modelCalls.length, modelCallsAtPause);
    const ownerAfterEnd = await fixture.statePort.loadTask(fixture.task.taskId);
    assert.equal(ownerAfterEnd?.node, 'NeedsInfo');
    assert.equal(ownerAfterEnd?.stateVersion, paused.stateVersion);

    // Follow-up experiment starts cleanly with no active conflict.
    const nextExp = await service.startExperiment({
      source: { kind: 'catalog', caseIds: ['C01'] },
      profileId: env.profile.profileId,
      idempotencyKey: 'clar-end-next-start',
    });
    assert.ok(nextExp.ok);
    assert.equal(nextExp.value.experiment.status, 'waiting-approval');

    // Missing or mismatched resolveClarificationEnd refuses cleanly with zero model calls.
    const makeIsolatedGraph = (badFixture: Awaited<ReturnType<typeof mkClarifyFixture>>, resolveClarificationEnd?: UC03EvaluationGraphRoute['resolveClarificationEnd']) => {
      const badBundle = prepareCaseBundle(badFixture, env.identity);
      return createUC03EvaluationGraph({
        catalogRoutes: new Map([
          [
            'C02',
            {
              entry: env.catalog[0],
              readiness: startupReadiness,
              coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
              expectedWait: 'waiting-info',
              resolveTask: () => badFixture.task,
              bindCase: () => ({ ok: true, ...badBundle }),
              resolveDirection: () => undefined,
              ...(resolveClarificationEnd === undefined ? {} : { resolveClarificationEnd }),
            },
          ],
        ]),
      });
    };

    for (const [label, createResolver] of [
      ['omitted-resolver', () => undefined],
      [
        'mismatched-receipt-stateVersion',
        (badFixture: Awaited<ReturnType<typeof mkClarifyFixture>>) => async () => {
          const cur = await badFixture.statePort.loadTask(badFixture.task.taskId);
          return cur ? { receiptRef: 'bad-ref', controlVersion: 1, taskId: cur.taskId, runId: cur.runId, workspaceId: cur.workspaceId, stateVersion: cur.stateVersion + 9 } : undefined;
        },
      ],
      [
        'throwing-resolver',
        () => () => {
          throw new Error('simulated-end-resolver-failure');
        },
      ],
    ] as const) {
      const badFixture = await mkClarifyFixture();
      const g = makeIsolatedGraph(badFixture, createResolver(badFixture));
      const s = createEvaluationService({
        profile: env.profile,
        catalog: env.catalog,
        repositoryIds: [badFixture.task.repositoryId],
        checkSetIds: ['checks-configured'],
        control: {
          issue: input => ({ receiptRef: `ctrl-bad-${input.expectedControlVersion + 1}`, kind: input.kind, taskId: badFixture.task.taskId, controlVersion: input.expectedControlVersion + 1 }),
        },
        graph: g,
        ids: () => `exp-bad-end-${label}`,
      });
      const st = await s.startExperiment({ source: { kind: 'catalog', caseIds: ['C02'] }, profileId: env.profile.profileId, idempotencyKey: `s-${label}` });
      assert.ok(st.ok, label);
      const owner = await badFixture.statePort.loadTask(badFixture.task.taskId);
      assert.ok(owner, label);
      const callsBefore = badFixture.modelCalls.length;
      const dr = await s.issueDirection({ id: st.value.experiment.id, expectedTaskVersion: owner.stateVersion, expectedControlVersion: 0, kind: 'end', idempotencyKey: `d-${label}` });
      assert.ok(dr.ok && 'receiptRef' in dr.value.receipt, label);
      const ct = await s.continueExperiment({ id: st.value.experiment.id, expectedVersion: dr.value.experiment.version, directionRef: dr.value.receipt.receiptRef, idempotencyKey: `c-${label}` });
      assert.ok(ct.ok, label);
      assert.equal(ct.value.experiment.status, 'incomplete', label);
      assert.equal(badFixture.modelCalls.length, callsBefore, label);
      assert.equal((await badFixture.statePort.loadTask(badFixture.task.taskId))?.node, 'NeedsInfo', label);
    }
    assert.deepEqual(startupTouches, []);
  } finally {
    await rm(env.files, { recursive: true, force: true });
  }
});
