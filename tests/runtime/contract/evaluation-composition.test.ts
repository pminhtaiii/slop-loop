import assert from 'node:assert/strict';
import test from 'node:test';
import { composeEvaluationPorts, EVALUATION_COMPOSITION_VERSION, type OwnerDelivery } from '../../../src/runtime/evaluation-composition.ts';
import { REQUIRED_PORTS_V02_METHODS, UC03_PRODUCTION_COMPONENTS_V02, checkProductionPortsV02 } from '../../../src/uc03/graph-types-v02.ts';

const CONTRACT = 'uc03-owner-delivery/1';
const REV = 'a'.repeat(40);

/** A structurally complete adapter per component. Only the declared provenance varies. */
function adapterFor(component: OwnerDelivery['component'], provenance: 'real' | 'mock'): OwnerDelivery['adapter'] {
  const shell: Record<string, unknown> = { provenance };
  for (const method of REQUIRED_PORTS_V02_METHODS[component]) shell[method] = () => undefined;
  return shell as unknown as OwnerDelivery['adapter'];
}

function port(component: OwnerDelivery['component'], provenance: 'real' | 'mock' = 'real', id = `${component}-id`): OwnerDelivery {
  return { component, id, contractVersion: CONTRACT, revision: REV, provenance, adapter: adapterFor(component, provenance) } as OwnerDelivery;
}

function allReal(): OwnerDelivery[] {
  return UC03_PRODUCTION_COMPONENTS_V02.map(component => port(component));
}

test('a complete, compatible real delivery set composes', () => {
  const result = composeEvaluationPorts(allReal(), CONTRACT);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.composition.version, EVALUATION_COMPOSITION_VERSION);
  assert.equal(result.composition.deliveries.modelPort, 'modelPort-id');
  assert.equal(result.composition.revisions['modelPort-id'], REV);
  assert.equal(result.ports.reviewerModelPort.provenance, 'real');
});

test('a missing component denies before any effect and names the component', () => {
  const result = composeEvaluationPorts(allReal().slice(0, -1), CONTRACT);
  assert.deepEqual(result, { status: 'denied', reasonCode: 'incompatible-delivery', component: 'replanPort' });
});

test('any mock port denies and names that component', () => {
  const deliveries = allReal().map(delivery => (delivery.component === 'modelPort' ? port('modelPort', 'mock') : delivery));
  assert.deepEqual(composeEvaluationPorts(deliveries, CONTRACT), { status: 'denied', reasonCode: 'incompatible-delivery', component: 'modelPort' });
});

/** Replace one component's delivery, keeping the rest intact. */
function over(component: OwnerDelivery['component'], patch: Record<string, unknown>): OwnerDelivery[] {
  return allReal().map(delivery => (delivery.component === component ? ({ ...delivery, ...patch } as OwnerDelivery) : delivery));
}

test('a delivery pinned to another contract version denies', () => {
  const result = composeEvaluationPorts(over('repositoryPort', { contractVersion: 'uc03-owner-delivery/2' }), CONTRACT);
  assert.deepEqual(result, { status: 'denied', reasonCode: 'incompatible-delivery', component: 'repositoryPort' });
});

test('an adapter missing a required method, a duplicate component or a bad revision all deny', () => {
  const missingMethod = over('approvalPort', { adapter: { provenance: 'real', classify: () => undefined } as unknown as OwnerDelivery['adapter'] });
  assert.deepEqual(composeEvaluationPorts(missingMethod, CONTRACT), { status: 'denied', reasonCode: 'incompatible-delivery', component: 'approvalPort' });

  // The v0.2 dial is required state capability: a v0.1 reserve/settle port denies.
  const legacyState = over('statePort', {
    adapter: {
      provenance: 'real',
      loadTask: () => undefined,
      transition: () => undefined,
      reserve: () => undefined,
      settle: () => undefined,
      reconcileUncertain: () => undefined,
    } as unknown as OwnerDelivery['adapter'],
  });
  assert.deepEqual(composeEvaluationPorts(legacyState, CONTRACT), { status: 'denied', reasonCode: 'incompatible-delivery', component: 'statePort' });

  const duplicate = [...allReal(), port('statePort', 'real', 'statePort-other')];
  assert.deepEqual(composeEvaluationPorts(duplicate, CONTRACT), { status: 'denied', reasonCode: 'incompatible-delivery', component: 'registry' });

  const badRevision = over('statePort', { revision: 'not-a-revision' });
  assert.deepEqual(composeEvaluationPorts(badRevision, CONTRACT), { status: 'denied', reasonCode: 'incompatible-delivery', component: 'statePort' });
});

test('the composed set is the one the runtime guard admits', () => {
  const result = composeEvaluationPorts(allReal(), CONTRACT);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  // Composition cannot return a set the route entry would refuse.
  assert.equal(checkProductionPortsV02(result.ports), null, 'composition produced a port set the production guard would refuse');
});
