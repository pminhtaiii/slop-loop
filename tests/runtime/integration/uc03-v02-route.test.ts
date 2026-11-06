/**
 * T027 witness: the v0.2 production entry refuses before any effect.
 *
 * Every controlled fixture declares `provenance: 'mock'`, and `checkProductionPortsV02` demands
 * `'real'`. That is the point: a controlled delivery cannot be promoted into this route, so these
 * witnesses can only observe the refusal. They are not G-OWNERS, G-ROUTE or G-REAL evidence, and no
 * port below is claimed to be a real owner.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductionRoute, runUC03GraphV02 } from '../../../src/uc03/graph-v02.ts';
import { REQUIRED_PORTS_V02_METHODS, UC03_PRODUCTION_COMPONENTS_V02, type UC03GraphConfigV02, type UC03GraphPortsV02 } from '../../../src/uc03/graph-types-v02.ts';
import { createFixtureBugTask } from '../support/uc03/port-fixtures.ts';

const COUNTERS = { calls: 0 };

/** A structurally complete port set. Only the declared provenance varies. */
function portSet(provenance: string): Record<string, Record<string, unknown>> {
  const counted = (): unknown => () => {
    COUNTERS.calls += 1;
    return undefined;
  };
  return Object.fromEntries(
    UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, { provenance, ...Object.fromEntries(REQUIRED_PORTS_V02_METHODS[component].map(method => [method, counted()])) }]),
  );
}

function config(): UC03GraphConfigV02 {
  return {
    trustedExpectedContext: {
      taskId: 'task-calc-001',
      workspaceId: 'workspace-001',
      repositoryId: 'repo-calc',
      revisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      criteriaDigest: 'sha256:criteria',
      checkSetDigest: 'sha256:checks',
      expectedTestFiles: ['tests/test_calculator.py'],
    },
  };
}

const asPorts = (ports: Record<string, unknown>): UC03GraphPortsV02 => ports as unknown as UC03GraphPortsV02;

function reset(): void {
  COUNTERS.calls = 0;
}

test('a mock delivery is refused before any port method runs', async () => {
  reset();
  const result = await runUC03GraphV02(createFixtureBugTask(), asPorts(portSet('mock')), config());
  assert.equal(result.outcome, 'INCOMPLETE');
  assert.equal(result.state, null);
  assert.match(result.reasons[0] ?? '', /PRODUCTION_ADMISSION_REFUSED: statePort invalid-provenance/u);
  assert.equal(result.diagnostic?.reasonCode, 'production-admission-refused');
  assert.equal(COUNTERS.calls, 0, 'a refused route must not call any port method');
});

test('every production component is required, in declaration order', async () => {
  for (const component of UC03_PRODUCTION_COMPONENTS_V02) {
    const ports = Object.fromEntries(Object.entries(portSet('real')).filter(([key]) => key !== component));
    const result = await runUC03GraphV02(createFixtureBugTask(), asPorts(ports), config());
    assert.equal(result.state, null, component);
    assert.match(result.reasons[0] ?? '', new RegExp(`PRODUCTION_ADMISSION_REFUSED: ${component} missing-port`, 'u'), component);
  }
});

test('every declared method is required and is named separately from provenance', async () => {
  for (const component of UC03_PRODUCTION_COMPONENTS_V02) {
    for (const method of REQUIRED_PORTS_V02_METHODS[component]) {
      const ports = portSet('real');
      const port = ports[component] as Record<string, unknown>;
      ports[component] = Object.fromEntries(Object.entries(port).filter(([key]) => key !== method));
      const result = await runUC03GraphV02(createFixtureBugTask(), asPorts(ports), config());
      assert.match(result.reasons[0] ?? '', new RegExp(`PRODUCTION_ADMISSION_REFUSED: ${component} missing-method`, 'u'), `${component}.${method}`);
    }
  }
});

test('a single mock component is named as such even when the rest declare real', async () => {
  const ports = portSet('real');
  ports['replanPort'] = { ...(ports['replanPort'] as Record<string, unknown>), provenance: 'mock' };
  const result = await runUC03GraphV02(createFixtureBugTask(), asPorts(ports), config());
  assert.match(result.reasons[0] ?? '', /PRODUCTION_ADMISSION_REFUSED: replanPort invalid-provenance/u);
});

test('a real-declared stub ingress is refused by the shared runner before effects', async () => {
  reset();
  const result = await runUC03GraphV02(createFixtureBugTask(), asPorts(portSet('real')), config());
  assert.equal(result.outcome, 'INCOMPLETE');
  assert.equal(result.state, null);
  assert.ok(result.reasons.some(reason => reason.includes('canonical accounted model ingress')));
  assert.equal(COUNTERS.calls, 0);
});

test('createProductionRoute assembles without admitting anything', () => {
  const app = createProductionRoute(asPorts(portSet('mock')), config());
  assert.equal(typeof app.invoke, 'function');
});

test('the route refuses a non-object candidate rather than throwing', async () => {
  for (const candidate of [null, undefined, 42, 'ports']) {
    const result = await runUC03GraphV02(createFixtureBugTask(), candidate as unknown as UC03GraphPortsV02, config());
    assert.equal(result.outcome, 'INCOMPLETE');
    assert.match(result.reasons[0] ?? '', /PRODUCTION_ADMISSION_REFUSED: statePort missing-port/u);
  }
});
