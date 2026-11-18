import assert from 'node:assert/strict';
import test from 'node:test';
import { isAdmittedForProduction } from '../../../src/contracts/foundation/uc03/v01/ports.ts';
import type { AttemptOutcomeReceiptV02, ProviderAdmissionContextV02 } from '../../../src/contracts/foundation/uc03.ts';
import { createDeepSeekTransport } from '../../../src/foundation/deepseek-transport.ts';
import { computeContextDigest, type HostModelTransport } from '../../../src/foundation/model.ts';
import { HostModelPortV02, derivedModelProvenance } from '../../../src/foundation/model-v02.ts';
import { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import { createFixtureSourceEvidence } from '../support/uc03/port-fixtures.ts';
import { createTestAdmissionTaskStateV02, createTestProviderAdmissionContextV02, createTestProviderRequest } from '../support/uc03/state-fixtures.ts';

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

test('the trusted DeepSeek transport yields a real, production-admissible model port', () => {
  const transport = deepSeek();
  assert.equal(derivedModelProvenance(transport), 'real');
  const port = new HostModelPortV02({ transport, statePort });
  assert.equal(port.provenance, 'real');
  // A getter slot is not a data property, so the port must carry provenance as its own data field.
  assert.equal(isAdmittedForProduction([port]), true);
});

test('an unbranded transport stays mock even when it can dispatch', () => {
  const transport = { execute: async () => ({ outcome: 'observed' as const }) };
  assert.equal(derivedModelProvenance(transport), 'mock');
  const port = new HostModelPortV02({ transport, statePort });
  assert.equal(port.provenance, 'mock');
  assert.equal(isAdmittedForProduction([port]), false);
});

test('an identity-channel-shaped fake stays mock', () => {
  const transport = {
    execute: async () => ({ outcome: 'observed' as const }),
    get lastModelIdentity() {
      return undefined;
    },
  };
  assert.equal(derivedModelProvenance(transport), 'mock');
  assert.equal(new HostModelPortV02({ transport, statePort }).provenance, 'mock');
  // Spreading a genuine transport copies the getter as a data field but not the non-enumerable brand.
  const copied = { ...deepSeek() };
  assert.equal(Object.getOwnPropertyDescriptor(copied, 'lastModelIdentity') !== undefined, true);
  assert.equal(derivedModelProvenance(copied), 'mock');
});

test('provenance is captured once at construction from the injected transport', () => {
  const transport: HostModelTransport = { execute: async () => ({ outcome: 'observed' as const }) };
  const port = new HostModelPortV02({ transport, statePort });
  // shortcut: the brand is inspected at construction; a transport branded later stays mock.
  Object.defineProperty(transport, 'lastModelIdentity', { get: () => undefined });
  assert.equal(port.provenance, 'mock');
});

/* --------------- dispatch authority: synchronous only, and an accounted fence --------------- */

const TASK_ID = 'task-calc-001';
const ACTOR = { adapterIdentity: 'adapter-authority', processIncarnation: 'proc-authority', fencingGeneration: 1 };

/** One admission and its matching task state, on a memory owner port. */
function admitted() {
  const providerRequestId = 'req-authority-1';
  const draft = createTestProviderRequest({ providerRequestId, taskId: TASK_ID, runId: 'run-001', role: 'coder', reservationRef: `res-${providerRequestId}` });
  const seed = createTestProviderAdmissionContextV02({ providerRequest: draft, taskId: TASK_ID, runId: 'run-001', expectedControlVersion: 2, expectedEpoch: 1 });
  const state = createTestAdmissionTaskStateV02(seed);
  const evidence = [createFixtureSourceEvidence({ revisionDigest: state.repositoryRevisionDigest })];
  const request = createTestProviderRequest({ ...seed.providerRequest, contextDigest: computeContextDigest(state, evidence) });
  const admission = createTestProviderAdmissionContextV02({ providerRequest: request, taskId: TASK_ID, runId: 'run-001', expectedControlVersion: 2, expectedEpoch: 1 });
  const statePort = new MemoryStatePortV02({ initialTaskState: state, initialControlVersion: 2, initialEpoch: 1, initialAuthorityRef: authorityOf(admission) });
  return { state, evidence, request, admission, statePort };
}

function authorityOf(context: ProviderAdmissionContextV02) {
  const identity = context.providerIdentity;
  return {
    policyId: identity.pricingPolicyId,
    policyVersion: identity.pricingPolicyVersion,
    configId: identity.configId,
    configVersion: identity.configVersion,
    issuerKeyRef: identity.issuerKeyRef,
    decisionAuthorityGeneration: identity.decisionAuthorityGeneration,
  };
}

for (const verdict of [
  () => Promise.resolve(true),
  () => {
    throw new Error('authority unavailable');
  },
])
  test('a non-synchronous or unavailable dispatch verdict fails closed before transport', async () => {
    const { state, evidence, request, admission, statePort } = admitted();
    const dispatches: string[] = [];
    const port = new HostModelPortV02({
      statePort,
      transport: {
        async execute() {
          dispatches.push(request.providerRequestId);
          return { proposal: { content: '{}' }, observedUsage: { inputTokens: 1, outputTokens: 1, costUsd: 0, billableTokens: 2 } };
        },
      },
      executorIdentity: ACTOR,
      currentExecutorIdentity: () => ACTOR,
      // A promise that would resolve `true` is not a synchronous verdict, so it cannot authorize the send.
      currentDispatchAuthority: verdict as never,
    });
    const result = await port.propose(state, evidence, request, admission);
    assert.equal(result.outcome, 'denied');
    assert.equal(result.reason, 'FENCED_EXECUTOR');
    assert.deepEqual(dispatches, [], 'a non-synchronous verdict sends nothing');
  });

test('a post-beginAttempt fence is recorded and keeps the attempt reservations held', async () => {
  const { state, evidence, request, admission, statePort } = admitted();
  const receipts: AttemptOutcomeReceiptV02[] = [];
  const recordOutcome = statePort.recordOutcome.bind(statePort);
  statePort.recordOutcome = async receipt => {
    receipts.push(structuredClone(receipt));
    return recordOutcome(receipt);
  };
  const contenders: { role: string }[] = [];
  const port = new HostModelPortV02({
    statePort,
    transport: {
      async execute() {
        contenders.push({ role: request.role });
        assert.fail('a fenced port must send nothing');
      },
    },
    executorIdentity: ACTOR,
    currentExecutorIdentity: () => ACTOR,
    currentDispatchAuthority: () => false,
  });
  const result = await port.propose(state, evidence, request, admission);
  assert.equal(result.outcome, 'denied');
  assert.equal(result.reason, 'FENCED_EXECUTOR');
  assert.deepEqual(contenders, []);

  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.proposedEffects.accounting.disposition, 'hold');
  assert.ok(receipts[0]);
  assert.equal(Object.hasOwn(receipts[0], 'observedUsage'), false);
  assert.equal(receipts[0].proposedEffects.accounting.observedUsage, undefined);

  // The attempted claim is not left dangling: a usage-free uncertain outcome exists to account for it.
  const journal = statePort.getJournalSnapshot();
  assert.equal((journal as { readonly attempts: readonly unknown[] }).attempts.length, 1, 'the durable attempt is kept');
  const outcomes = (journal as { readonly outcomes: readonly { readonly outcome: string; readonly claimId: string }[] }).outcomes;
  assert.equal(outcomes.length, 1, 'the fence records one outcome, not a silently attempting claim');
  assert.equal(outcomes[0]?.outcome, 'uncertain');
  const claims = (journal as { readonly claims: readonly { readonly status: string }[] }).claims;
  assert.equal(claims[0]?.status, 'uncertain', 'the claim is accounted, not left attempting');
});

test('a pre-transport fence is not cached: the same request id is answered from the journal, not a stored denial', async () => {
  const { state, evidence, request, admission, statePort } = admitted();
  let fenced = true;
  let sends = 0;
  const port = new HostModelPortV02({
    statePort,
    transport: {
      async execute() {
        sends += 1;
        return { proposal: { content: '{}' }, observedUsage: { inputTokens: 1, outputTokens: 1, costUsd: 0, billableTokens: 2 } };
      },
    },
    executorIdentity: ACTOR,
    currentExecutorIdentity: () => ACTOR,
    currentDispatchAuthority: () => !fenced,
  });
  const first = await port.propose(state, evidence, request, admission);
  assert.equal(first.reason, 'FENCED_EXECUTOR');
  assert.equal(sends, 0);

  // The fence dropped the in-flight entry, so a retry re-enters the journal instead of replaying the
  // denial. Its attempt is already recorded as uncertain, so the claim refuses — never a second send.
  fenced = false;
  const second = await port.propose(state, evidence, request, admission);
  assert.notEqual(second.reason, 'FENCED_EXECUTOR', 'the same identity is not answered by a cached fence');
  assert.equal(second.outcome, 'denied');
  assert.equal(sends, 0, 'a fenced attempt never reaches transport, even on retry');
  // The recorded uncertain attempt is what recovery releases; the claim is accounted, not dangling.
  const journal = statePort.getJournalSnapshot() as { readonly claims: readonly { readonly status: string }[] };
  assert.equal(journal.claims[0]?.status, 'uncertain');
});
