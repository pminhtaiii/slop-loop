import assert from 'node:assert/strict';
import test from 'node:test';
import { checkProductionPortsV02, UC03_PRODUCTION_COMPONENTS_V02, REQUIRED_PORTS_V02_METHODS } from '../../../src/uc03/graph-types-v02.ts';

const METHODS = REQUIRED_PORTS_V02_METHODS;

function port(provenance: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { provenance, ...overrides };
}

function full(provenance = 'real'): Record<string, unknown> {
  const ports: Record<string, unknown> = {};
  for (const component of UC03_PRODUCTION_COMPONENTS_V02) {
    ports[component] = port(provenance, Object.fromEntries(METHODS[component].map(m => [m, () => undefined])));
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

/*
 * Compile-time fixture. The runtime guard above catches substituted deliveries; this pins which
 * substitutions the type system also catches, so a future widening that makes a legacy port
 * structurally acceptable fails the build instead of silently passing at runtime.
 */
import type { ExecutionGuard, ExecutionGuardV02, RepositoryPort, RepositoryPortV02, StatePort, StatePortV02, ModelPort, ModelPortV02 } from '../../../src/contracts/foundation/uc03.ts';

export function checkProductionPortAssignability(
  statePortV01: StatePort,
  repositoryPortV01: RepositoryPort,
  executionGuardV01: ExecutionGuard,
  modelPortV01: ModelPort,
  statePortV02: StatePortV02,
  repositoryPortV02: RepositoryPortV02,
  executionGuardV02: ExecutionGuardV02,
  modelPortV02: ModelPortV02,
): void {
  // @ts-expect-error A v0.1 state port lacks the claim/attempt/journal methods a production route calls.
  const rejectedState: StatePortV02 = statePortV01;
  // @ts-expect-error A v0.1 repository result carries no execution receipt, so its effects cannot be settled.
  const rejectedRepository: RepositoryPortV02 = repositoryPortV01;

  // These three ARE assignable: a narrower-arity method fits a wider slot. Provenance and method
  // presence are therefore enforced at assembly by `checkProductionPortsV02`, not by this assignment.
  const acceptedGuard: ExecutionGuardV02 = executionGuardV01;
  const acceptedModel: ModelPortV02 = modelPortV01;
  void [rejectedState, rejectedRepository, acceptedGuard, acceptedModel, statePortV02, repositoryPortV02, executionGuardV02, modelPortV02];
}
