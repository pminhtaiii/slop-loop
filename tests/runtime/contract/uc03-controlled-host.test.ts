import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareControlledUC03Host, prepareUC03Host, type UC03HostInputs } from '../../../src/runtime/uc03-host-bootstrap.ts';
import { runControlledUC03GraphV02, runUC03GraphV02 } from '../../../src/uc03/graph-v02.ts';
import { REQUIRED_PORTS_V02_METHODS, UC03_PRODUCTION_COMPONENTS_V02, type UC03GraphConfigV02, type UC03GraphPortsV02 } from '../../../src/uc03/graph-types-v02.ts';
import type { OwnerDelivery } from '../../../src/runtime/evaluation-composition.ts';
import { createFixtureBugTask } from '../support/uc03/port-fixtures.ts';
import { createWorkflowDriver } from '../../../eval/uc03/workflow-driver.ts';
import type { EvaluationCaseSpec, WorkflowCaseContext } from '../../../eval/uc03/types.ts';

const revision = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const hostComponents = ['guardedRead', 'baselineEvidence', 'hostAuthority', 'contextSource'];
const config: UC03GraphConfigV02 = {
  trustedExpectedContext: {
    taskId: 'task-calc-001',
    workspaceId: 'workspace-001',
    repositoryId: 'repo-calc',
    revisionDigest: digest,
    criteriaDigest: digest,
    checkSetDigest: digest,
    expectedTestFiles: ['tests/test_calculator.py'],
  },
};

function fixture() {
  const calls: string[] = [];
  const adapters = Object.fromEntries(
    UC03_PRODUCTION_COMPONENTS_V02.map(component => [
      component,
      {
        provenance: 'mock',
        ...Object.fromEntries(
          REQUIRED_PORTS_V02_METHODS[component].map(method => [
            method,
            () => {
              calls.push(`${component}.${method}`);
              return undefined;
            },
          ]),
        ),
      },
    ]),
  );
  const inputs: UC03HostInputs = {
    owner: UC03_PRODUCTION_COMPONENTS_V02.filter(component => !hostComponents.includes(component)).map(component => ({
      component,
      id: `fixture-${component}`,
      contractVersion: 'controlled-owner/1',
      revision,
      provenance: 'mock',
      adapter: adapters[component],
    })) as OwnerDelivery[],
    producers: Object.fromEntries(hostComponents.map(component => [component, adapters[component]])) as unknown as UC03HostInputs['producers'],
    pins: { contractVersion: 'controlled-owner/1', revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, revision])) },
    identity: { profileId: 'controlled', profileDigest: digest, configDigest: digest, pricingDigest: digest },
    config,
  };
  return { inputs, calls, adapters };
}

test('controlled readiness is explicitly tagged and production still rejects the same mocks', () => {
  const { inputs, calls } = fixture();
  assert.equal(prepareControlledUC03Host(inputs).status, 'controlled-ready');
  assert.equal(prepareUC03Host(inputs).status, 'unavailable');
  assert.deepEqual(calls, []);
});

test('controlled admission refuses a real-declared effectful adapter before any call', () => {
  const { inputs, calls, adapters } = fixture();
  adapters['modelPort'] = { ...adapters['modelPort'], provenance: 'real' } as (typeof adapters)[string];
  const owner = inputs.owner.map(delivery => (delivery.component === 'modelPort' ? ({ ...delivery, adapter: adapters['modelPort'] } as OwnerDelivery) : delivery));
  assert.equal(prepareControlledUC03Host({ ...inputs, owner }).status, 'unavailable');
  assert.deepEqual(calls, []);
});

test('missing pin inventory or owner registry is unavailable without invoking ports', () => {
  const { inputs, calls } = fixture();
  for (const malformed of [
    { ...inputs, pins: { contractVersion: 'controlled-owner/1' } },
    { ...inputs, owner: undefined },
  ]) {
    assert.equal(prepareControlledUC03Host(malformed as unknown as UC03HostInputs).status, 'unavailable');
  }
  assert.deepEqual(calls, []);
});

test('only the controlled entry admits mock ports to the shared runner', async () => {
  const { inputs, calls } = fixture();
  const ready = prepareControlledUC03Host(inputs);
  assert.equal(ready.status, 'controlled-ready');
  if (ready.status !== 'controlled-ready') return;
  const refused = await runUC03GraphV02(createFixtureBugTask(), ready.ports, config);
  assert.match(refused.reasons[0] ?? '', /PRODUCTION_ADMISSION_REFUSED/u);
  assert.deepEqual(calls, []);
  const observed = await runControlledUC03GraphV02(createFixtureBugTask(), ready.ports, config);
  assert.deepEqual(observed.reasons, ['Authoritative task state is missing']);
  assert.deepEqual(calls, ['statePort.loadTask']);
  const substituted = { ...ready.ports, modelPort: { ...ready.ports.modelPort, provenance: 'real' } } as UC03GraphPortsV02;
  const blocked = await runControlledUC03GraphV02(createFixtureBugTask(), substituted, config);
  assert.match(blocked.reasons[0] ?? '', /CONTROLLED_ADMISSION_REFUSED/u);
  assert.deepEqual(calls, ['statePort.loadTask']);
});

test('the workflow driver refuses a controlled binding in a real case context', async () => {
  const { inputs, calls } = fixture();
  const ready = prepareControlledUC03Host(inputs);
  assert.equal(ready.status, 'controlled-ready');
  if (ready.status !== 'controlled-ready') return;
  const entry = {
    catalogEntryId: 'controlled-case',
    caseId: 'C02',
    version: '1',
    caseDigest: digest,
    publicTaskDigest: digest,
    initialRepositoryDigest: digest,
    fixturePath: 'host-only',
    fixtureDigest: digest,
    grader: { version: '1', digest, path: 'host-only' },
  };
  const driver = createWorkflowDriver(new Map([['C02', { entry, task: createFixtureBugTask(), expectedWait: null, controlled: ready }]]));
  const spec: EvaluationCaseSpec = {
    caseId: 'C02',
    name: 'controlled boundary',
    description: 'no tier promotion',
    category: 'clarification',
    required: true,
    expectedOutcome: 'INCOMPLETE',
    requirements: ['SC-006'],
  };
  const context: WorkflowCaseContext = {
    spec,
    mode: 'real',
    tier: 'real-integration',
    manifestDigest: digest,
    configDigest: digest,
    profileDigest: digest,
    pricingDigest: digest,
    adapterVersions: ['controlled/1'],
    requestedModel: 'controlled',
  };
  const refused = await driver.executeCase(spec, context);
  assert.ok(typeof refused === 'object' && refused !== null && 'blocked' in refused && 'effects' in refused);
  assert.equal(refused.blocked, 'prerequisite-unavailable');
  assert.equal(refused.effects, 'none');
  assert.deepEqual(calls, []);
  const observed = await driver.executeCase(spec, { ...context, mode: 'mock', tier: 'controlled' });
  assert.ok(typeof observed === 'object' && observed !== null && 'workflowOutcome' in observed);
  assert.equal(observed.workflowOutcome, 'INCOMPLETE');
  assert.deepEqual(calls, ['statePort.loadTask']);
});
