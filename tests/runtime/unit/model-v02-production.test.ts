import assert from 'node:assert/strict';
import test from 'node:test';
import { isAdmittedForProduction } from '../../../src/contracts/foundation/uc03/v01/ports.ts';
import { createDeepSeekTransport } from '../../../src/foundation/deepseek-transport.ts';
import { HostModelPortV02, derivedModelProvenance } from '../../../src/foundation/model-v02.ts';
import type { HostModelTransport } from '../../../src/foundation/model.ts';

// T006: provenance is derived from the injected transport, never declared on the port.

function deepSeek() {
  return createDeepSeekTransport({
    endpoint: 'https://api.deepseek.com/anthropic/v1/messages',
    apiKey: 'sk-host-only-ref-0123456789',
    pricing: { inputRate: 1, outputRate: 1, cacheRate: 1, overheadRate: 0, denominator: 1 },
    fetch: async () => assert.fail('no network in this test'),
  });
}

const statePort = { claim: async () => undefined, beginAttempt: async () => undefined, recordOutcome: async () => undefined } as never;

test('a transport that exposes the provider-identity channel yields a real, production-admissible model port', () => {
  const transport = deepSeek();
  assert.equal(derivedModelProvenance(transport), 'real');
  const port = new HostModelPortV02({ transport, statePort });
  assert.equal(port.provenance, 'real');
  // A getter slot is not a data property, so the port must carry provenance as its own data field.
  assert.equal(isAdmittedForProduction([port]), true);
});

test('a transport without the identity channel stays mock even though it can dispatch', () => {
  const transport = { execute: async () => ({ outcome: 'observed' as const }) };
  assert.equal(derivedModelProvenance(transport), 'mock');
  const port = new HostModelPortV02({ transport, statePort });
  assert.equal(port.provenance, 'mock');
  assert.equal(isAdmittedForProduction([port]), false);
});

test('provenance is captured once at construction from the injected transport', () => {
  const transport: HostModelTransport = { execute: async () => ({ outcome: 'observed' as const }) };
  const port = new HostModelPortV02({ transport, statePort });
  Object.defineProperty(transport, 'lastModelIdentity', { get: () => undefined });
  // shortcut: the channel is inspected at construction; a transport that grows it later stays mock.
  assert.equal(port.provenance, 'mock');
});
