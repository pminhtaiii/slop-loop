/**
 * T028 witness: static assembly only.
 *
 * Every fixture here is a declared-real shell with no behaviour, which is exactly what this stage
 * may accept: it validates identity, pinned revisions and callable surface. Behaviour and evidence
 * binding are proven after service allocation, not here, so nothing below is G-OWNERS or G-ROUTE
 * evidence and no real owner is claimed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareUC03Host, type UC03HostInputs } from '../../../src/runtime/uc03-host-bootstrap.ts';
import type { OwnerDelivery } from '../../../src/runtime/evaluation-composition.ts';
import { REQUIRED_PORTS_V02_METHODS, UC03_PRODUCTION_COMPONENTS_V02, type UC03GraphConfigV02 } from '../../../src/uc03/graph-types-v02.ts';

const CONTRACT = 'uc03-owner-delivery/1';
const REV = 'a'.repeat(40);
const DIGEST = 'sha256:' + 'b'.repeat(64);

/** Components this module does not build: they arrive as accepted owner deliveries. */
const HOST_COMPONENTS = ['guardedRead', 'baselineEvidence', 'hostAuthority', 'contextSource'] as const;
const OWNER_COMPONENTS = UC03_PRODUCTION_COMPONENTS_V02.filter(component => !(HOST_COMPONENTS as readonly string[]).includes(component));

function adapter(component: OwnerDelivery['component'], provenance = 'real'): OwnerDelivery['adapter'] {
  const shell: Record<string, unknown> = { provenance };
  for (const method of REQUIRED_PORTS_V02_METHODS[component]) shell[method] = () => undefined;
  return shell as unknown as OwnerDelivery['adapter'];
}

function delivery(component: OwnerDelivery['component'], overrides: Record<string, unknown> = {}): OwnerDelivery {
  return { component, id: `${component}-id`, contractVersion: CONTRACT, revision: REV, provenance: 'real', adapter: adapter(component), ...overrides } as OwnerDelivery;
}

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

function inputs(overrides: Partial<UC03HostInputs> = {}): UC03HostInputs {
  return {
    pins: { contractVersion: CONTRACT, revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, REV])) },
    owner: OWNER_COMPONENTS.map(component => delivery(component)),
    producers: {
      guardedRead: { provenance: 'real', mediateRead: () => undefined } as never,
      baselineEvidence: { provenance: 'real', persistBaselineEvidence: () => undefined, loadBaselineEvidence: () => undefined } as never,
      hostAuthority: { loadSnapshot: () => undefined } as never,
      contextSource: { provenance: 'real', observe: () => undefined } as never,
    },
    config: CONFIG,
    identity: { profileId: 'profile-001', profileDigest: DIGEST, configDigest: DIGEST, pricingDigest: DIGEST },
    ...overrides,
  };
}

test('a complete, pinned delivery set assembles', () => {
  const readiness = prepareUC03Host(inputs());
  assert.equal(readiness.status, 'ready');
  if (readiness.status !== 'ready') return;
  assert.equal(readiness.ports.guardedRead.provenance, 'real');
  assert.equal(readiness.config, CONFIG);
  assert.equal(readiness.identity.profileId, 'profile-001');
});

test('a missing owner delivery is refused and named', () => {
  const readiness = prepareUC03Host(inputs({ owner: OWNER_COMPONENTS.slice(0, -1).map(component => delivery(component)) }));
  assert.equal(readiness.status, 'unavailable');
  if (readiness.status !== 'unavailable') return;
  assert.deepEqual(readiness.reasons, [{ kind: 'component', component: OWNER_COMPONENTS.at(-1), reasonCode: 'incompatible-delivery' }]);
});

test('a mock owner delivery is refused rather than assembled', () => {
  const owner = OWNER_COMPONENTS.map(component => (component === 'modelPort' ? delivery('modelPort', { provenance: 'mock', adapter: adapter('modelPort', 'mock') }) : delivery(component)));
  const readiness = prepareUC03Host(inputs({ owner }));
  assert.equal(readiness.status, 'unavailable');
  if (readiness.status !== 'unavailable') return;
  assert.deepEqual(readiness.reasons, [{ kind: 'component', component: 'modelPort', reasonCode: 'incompatible-delivery' }]);
});

test('a delivery at an unpinned revision is stale even though it composes', () => {
  const owner = OWNER_COMPONENTS.map(component => (component === 'repositoryPort' ? delivery('repositoryPort', { revision: 'c'.repeat(40) }) : delivery(component)));
  const readiness = prepareUC03Host(inputs({ owner }));
  assert.equal(readiness.status, 'unavailable');
  if (readiness.status !== 'unavailable') return;
  assert.deepEqual(readiness.reasons, [{ kind: 'component', component: 'repositoryPort', reasonCode: 'stale-revision' }]);
});

test('a half-implemented Tai-owned producer is refused before any effect', () => {
  const producers = { ...inputs().producers, guardedRead: { provenance: 'real' } as never };
  const readiness = prepareUC03Host(inputs({ producers }));
  assert.equal(readiness.status, 'unavailable');
  if (readiness.status !== 'unavailable') return;
  assert.ok(
    readiness.reasons.some(reason => reason.kind === 'component' && reason.component === 'guardedRead' && reason.reasonCode === 'incompatible-delivery'),
    JSON.stringify(readiness.reasons),
  );
});

test('an unpinned host producer is stale, so a swapped guard cannot arrive unnoticed', () => {
  const pins = { contractVersion: CONTRACT, revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.filter(component => component !== 'guardedRead').map(component => [component, REV])) };
  const readiness = prepareUC03Host(inputs({ pins }));
  assert.deepEqual(readiness, { status: 'unavailable', reasons: [{ kind: 'component', component: 'guardedRead', reasonCode: 'stale-revision' }] });
});

test('a credential-shaped identity key or value is refused and never echoed', () => {
  for (const identity of [
    { profileId: 'p', profileDigest: DIGEST, configDigest: DIGEST, pricingDigest: DIGEST, apiKey: 'sk-live-123' },
    { profileId: 'p', profileDigest: DIGEST, configDigest: DIGEST, pricingDigest: DIGEST, note: 'token=abc' },
  ]) {
    const readiness = prepareUC03Host(inputs({ identity }));
    assert.deepEqual(readiness, { status: 'unavailable', reasons: [{ kind: 'identity', reasonCode: 'unsafe-identity' }] });
    assert.equal(JSON.stringify(readiness).includes('sk-live-123'), false);
  }
});

test('an incomplete identity is refused and names no value', () => {
  const readiness = prepareUC03Host(inputs({ identity: { profileId: 'p' } }));
  assert.deepEqual(readiness, { status: 'unavailable', reasons: [{ kind: 'identity', reasonCode: 'incomplete-identity' }] });
});

test('assembly calls nothing: a delivery whose every method throws still assembles', () => {
  const hostile = (): never => {
    throw new Error('MARKER_ASSEMBLY_EFFECT');
  };
  const owner = OWNER_COMPONENTS.map(component =>
    delivery(component, { adapter: Object.fromEntries([['provenance', 'real'], ...REQUIRED_PORTS_V02_METHODS[component].map(method => [method, hostile])]) }),
  );
  const readiness = prepareUC03Host(inputs({ owner }));
  assert.equal(readiness.status, 'ready', JSON.stringify(readiness));
});
