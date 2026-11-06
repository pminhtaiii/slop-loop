import assert from 'node:assert/strict';
import test from 'node:test';
import { checkProductionPortsV02, UC03_PRODUCTION_COMPONENTS_V02, REQUIRED_PORTS_V02_METHODS } from '../../../src/uc03/graph-types-v02.ts';

const METHODS = REQUIRED_PORTS_V02_METHODS;

/**
 * Pinned marker names. A v0.1 adapter has every method; only these separate the versions, so they
 * are asserted here rather than read back from the implementation.
 */
const MARKERS: Readonly<Record<string, string>> = { modelPort: 'modelPortApiVersion', reviewerModelPort: 'modelPortApiVersion', executionGuard: 'executionGuardApiVersion' };

/** The reviewer seam is the same model boundary in a distinct role; pinned here for the same reason. */
const ROLES: Readonly<Record<string, string>> = { reviewerModelPort: 'reviewer' };

function port(component: string, provenance: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const marker = MARKERS[component];
  const role = ROLES[component];
  return {
    provenance,
    ...(marker === undefined ? {} : { [marker]: '0.2.0' }),
    ...(role === undefined ? {} : { providerRole: role }),
    ...overrides,
  };
}

function full(provenance = 'real'): Record<string, unknown> {
  const ports: Record<string, unknown> = {};
  for (const component of UC03_PRODUCTION_COMPONENTS_V02) {
    ports[component] = port(component, provenance, Object.fromEntries(METHODS[component].map(m => [m, () => undefined])));
  }
  return ports;
}

test('a complete real port set is admitted', () => {
  assert.equal(checkProductionPortsV02(full()), null);
});

test('every component is independently required', () => {
  for (const component of UC03_PRODUCTION_COMPONENTS_V02) {
    const ports = Object.fromEntries(Object.entries(full()).filter(([key]) => key !== component));
    const rejection = checkProductionPortsV02(ports);
    assert.equal(rejection?.component, component, component);
    assert.equal(rejection?.reasonCode, 'missing-port');
  }
});

test('every declared method is independently required', () => {
  for (const component of UC03_PRODUCTION_COMPONENTS_V02) {
    for (const method of METHODS[component]) {
      const ports = full();
      ports[component] = Object.fromEntries(Object.entries(ports[component] as Record<string, unknown>).filter(([key]) => key !== method));
      const rejection = checkProductionPortsV02(ports);
      assert.equal(rejection?.component, component, `${component}.${method}`);
      assert.equal(rejection?.reasonCode, 'missing-method');
    }
  }
});

test('a mock delivery is named as a provenance failure, not a missing method', () => {
  const rejection = checkProductionPortsV02(full('mock'));
  assert.deepEqual(rejection, { status: 'rejected', component: 'statePort', reasonCode: 'invalid-provenance' });
});

test('a substituted method name does not satisfy the surface', () => {
  const ports = full();
  const { applyPatch, ...renamed } = ports['repositoryPort'] as Record<string, unknown>;
  ports['repositoryPort'] = { ...renamed, applyPatchLegacy: applyPatch };
  assert.equal(checkProductionPortsV02(ports)?.reasonCode, 'missing-method');
});

test('a non-object candidate is refused rather than thrown on', () => {
  for (const candidate of [null, undefined, 42, 'ports', []]) {
    assert.equal(checkProductionPortsV02(candidate)?.status, 'rejected');
  }
});

test('a v0.1-shaped adapter with the right methods is still refused for its missing version marker', () => {
  for (const component of ['modelPort', 'reviewerModelPort', 'executionGuard'] as const) {
    const ports = full();
    const adapter = Object.fromEntries(Object.entries(ports[component] as Record<string, unknown>).filter(([key]) => !Object.values(MARKERS).includes(key)));
    ports[component] = adapter;
    assert.deepEqual(checkProductionPortsV02(ports), { status: 'rejected', component, reasonCode: 'missing-version-marker' });
  }
});

test('a stale version marker is refused rather than accepted as v0.2', () => {
  const ports = full();
  ports['modelPort'] = { ...(ports['modelPort'] as Record<string, unknown>), modelPortApiVersion: '0.1.0' };
  assert.deepEqual(checkProductionPortsV02(ports), { status: 'rejected', component: 'modelPort', reasonCode: 'missing-version-marker' });
});

test('an accessor-defined marker is not read as a declared version', () => {
  const ports = full();
  const adapter = Object.fromEntries(Object.entries(ports['modelPort'] as Record<string, unknown>).filter(([key]) => key !== 'modelPortApiVersion'));
  ports['modelPort'] = Object.defineProperty(adapter, 'modelPortApiVersion', { get: () => '0.2.0' });
  assert.deepEqual(checkProductionPortsV02(ports), { status: 'rejected', component: 'modelPort', reasonCode: 'missing-version-marker' });
});

test('a coder-role model port is refused at the reviewer seam', () => {
  const ports = full();
  ports['reviewerModelPort'] = { ...(ports['reviewerModelPort'] as Record<string, unknown>), providerRole: 'coder' };
  assert.deepEqual(checkProductionPortsV02(ports), { status: 'rejected', component: 'reviewerModelPort', reasonCode: 'wrong-provider-role' });
});

/*
 * Compile-time fixture. The runtime guard above catches substituted deliveries; this pins which
 * substitutions the type system also catches, so a future widening that makes a legacy port
 * structurally acceptable fails the build instead of silently passing at runtime.
 */
import type { ExecutionGuard, RepositoryPort, StatePort, ModelPort, ModelPortV02, ProviderRequest } from '../../../src/contracts/foundation/uc03.ts';
import type { CoderAgent, CoderAgentV02, CoderTurnInputV02 } from '../../../src/uc03/agent-types.ts';
import type { UC03GraphPortsV02, UC03ProductionExecutionGuardV02, UC03ProductionModelPortV02, UC03RoutePorts } from '../../../src/uc03/graph-types-v02.ts';

/** Genuine v0.2 adapters still satisfy the surface, and that surface still feeds the shared route types. */
export function checkProductionPortAcceptability(ports: UC03GraphPortsV02, modelPortV02: UC03ProductionModelPortV02, executionGuardV02: UC03ProductionExecutionGuardV02): void {
  const shared: UC03RoutePorts = ports;
  const acceptedModel: ModelPortV02 = modelPortV02;
  const acceptedGuard: UC03ProductionExecutionGuardV02 = executionGuardV02;
  void [shared, acceptedModel, acceptedGuard];
}

export function checkProductionPortAssignability(
  statePortV01: StatePort,
  repositoryPortV01: RepositoryPort,
  executionGuardV01: ExecutionGuard,
  modelPortV01: ModelPort,
  modelPortV02: UC03ProductionModelPortV02,
  executionGuardV02: UC03ProductionExecutionGuardV02,
): void {
  // @ts-expect-error A v0.1 state port lacks the claim/attempt/journal methods a production route calls.
  const rejectedState: StatePortV02 = statePortV01;
  // @ts-expect-error A v0.1 repository result carries no execution receipt, so its effects cannot be settled.
  const rejectedRepository: RepositoryPortV02 = repositoryPortV01;
  // A narrower-arity method fits a wider slot, so the method set alone cannot separate the versions.
  // The version marker can, which is why the production types require one.
  // @ts-expect-error A v0.1 model port is not a production model port: it declares no v0.2 version marker.
  const rejectedModel: UC03ProductionModelPortV02 = modelPortV01;
  // @ts-expect-error A v0.1 execution guard declares no v0.2 version marker.
  const rejectedGuard: UC03ProductionExecutionGuardV02 = executionGuardV01;
  void [rejectedState, rejectedRepository, rejectedModel, rejectedGuard, modelPortV02, executionGuardV02];
}

/** Legacy callers keep compiling; the production agent surface is not satisfied by the v0.1 agent. */
export function checkLegacyCoderCallStillCompiles(legacy: CoderAgent, production: CoderAgentV02): void {
  const stillCompiles: CoderAgent = legacy;
  // @ts-expect-error A v0.1 coder agent passes the request to `turn`; it cannot stand in for the admission-taking v0.2 agent.
  const rejectedAgent: CoderAgentV02 = legacy;
  void [stillCompiles, rejectedAgent, production];
}

/**
 * The production turn takes one owner-issued admission with request, context and trusted context.
 * A legacy caller that passes only the request, or an admission missing either context, cannot build it.
 */
export function checkCoderAdmissionRequiresCompleteContext(task: CoderTurnInputV02, request: ProviderRequest): void {
  const accepted: CoderTurnInputV02 = task;
  void accepted;
  // @ts-expect-error A v0.1 caller supplies only the request; the production turn needs a full admission.
  const rejectedLegacy: CoderTurnInputV02 = { ...task, admission: request };
  // @ts-expect-error An admission without context/trustedContext cannot satisfy the production turn.
  const rejectedPartial: CoderTurnInputV02 = { ...task, admission: { request } };
  void [rejectedLegacy, rejectedPartial];
}
