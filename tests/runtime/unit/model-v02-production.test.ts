import assert from 'node:assert/strict';
import test from 'node:test';
import { isAdmittedForProduction } from '../../../src/contracts/foundation/uc03/v01/ports.ts';
import type { AttemptOutcomeReceiptV02, AttemptReceiptV02, ClaimReceiptV02, ProviderAdmissionContextV02 } from '../../../src/contracts/foundation/uc03.ts';
import { createDeepSeekTransport } from '../../../src/foundation/deepseek-transport.ts';
import { computeContextDigest, type HostModelTransport } from '../../../src/foundation/model.ts';
import { HostModelPortV02, derivedModelProvenance } from '../../../src/foundation/model-v02.ts';
import { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import { createFixtureSourceEvidence } from '../support/uc03/port-fixtures.ts';
import { createTestAdmissionTaskStateV02, createTestProviderAdmissionContextV02, createTestProviderRequest, createTestUncertainReconciliationReceiptV02 } from '../support/uc03/state-fixtures.ts';

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
    assert.equal(statePort.getJournalSnapshot().outcomes.length, 1, 'the durable attempt is accounted, not bare-denied');
  });

test('a rejected authority verdict is consumed, sends nothing, and leaves no unhandled rejection', async () => {
  const { state, evidence, request, admission, statePort } = admitted();
  const rejections: unknown[] = [];
  const listener = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const port = new HostModelPortV02({
      statePort,
      transport: {
        async execute() {
          assert.fail('a rejected verdict must send nothing');
        },
      },
      executorIdentity: ACTOR,
      currentExecutorIdentity: () => ACTOR,
      currentDispatchAuthority: (() => Promise.reject(new Error('authority read failed'))) as never,
    });
    const result = await port.propose(state, evidence, request, admission);
    assert.equal(result.outcome, 'denied');
    assert.equal(result.reason, 'FENCED_EXECUTOR');
    // Let any escaped rejection surface before asserting the process saw none.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(rejections, [], 'the rejected verdict must not become an unhandled rejection');

    const journal = statePort.getJournalSnapshot();
    assert.equal(journal.outcomes.length, 1, 'the durable attempt is accounted, not bare-denied');
    assert.equal(journal.claims[0]?.status, 'uncertain');
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('an executor fence after beginAttempt is accounted exactly like a final authority refusal', async () => {
  const { state, evidence, request, admission, statePort } = admitted();
  let generation = 1;
  const ownBegin = statePort.beginAttempt.bind(statePort);
  statePort.beginAttempt = async (claimId: string, executor: never) => {
    const attempt = await ownBegin(claimId, executor);
    // The fence becomes visible only once the attempt is already durable.
    generation = 2;
    return attempt;
  };
  const port = new HostModelPortV02({
    statePort,
    transport: {
      async execute() {
        assert.fail('a fenced port must send nothing');
      },
    },
    executorIdentity: ACTOR,
    currentExecutorIdentity: () => ({ ...ACTOR, fencingGeneration: generation }),
  });
  const first = await port.propose(state, evidence, request, admission);
  assert.equal(first.outcome, 'denied');
  assert.equal(first.reason, 'FENCED_EXECUTOR');

  const journal = statePort.getJournalSnapshot();
  assert.equal(journal.attempts.length, 1, 'the durable attempt is kept');
  assert.equal(journal.outcomes.length, 1, 'the post-beginAttempt fence records an outcome, not a bare denial');
  assert.equal(journal.outcomes[0]?.outcome, 'uncertain');
  assert.equal(journal.claims[0]?.status, 'uncertain', 'the claim is accounted, not left attempting');

  // A retried identical request re-enters the journal instead of replaying the bare denial.
  generation = 1;
  const second = await port.propose(state, evidence, request, admission);
  assert.notEqual(second.reason, 'FENCED_EXECUTOR', 'the fence denial is not cached across a retry');
  assert.equal(second.outcome, 'denied');
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

/* ---------------- M3: a failed fenced-outcome write keeps a replayable recovery payload ---------------- */

function fencedPort(statePort: MemoryStatePortV02) {
  return new HostModelPortV02({
    statePort,
    transport: {
      async execute() {
        assert.fail('a fenced port must send nothing');
      },
    },
    executorIdentity: ACTOR,
    currentExecutorIdentity: () => ACTOR,
    currentDispatchAuthority: () => false,
  });
}

test('a fenced-outcome write that fails once still accounts the attempt on the bounded retry', async () => {
  const { state, evidence, request, admission, statePort } = admitted();
  const record = statePort.recordOutcome.bind(statePort);
  let writes = 0;
  statePort.recordOutcome = async receipt => {
    writes++;
    if (writes === 1) throw new Error('transient write failure');
    return record(receipt);
  };
  const result = await fencedPort(statePort).propose(state, evidence, request, admission);
  assert.equal(result.outcome, 'denied');
  assert.equal(result.reason, 'FENCED_EXECUTOR');
  assert.equal(writes, 2, 'the write is retried once, not infinitely');
  assert.equal(result.recovery, undefined, 'a durable hold needs no recovery payload');
  const journal = statePort.getJournalSnapshot();
  assert.equal(journal.outcomes.length, 1);
  assert.equal(journal.claims[0]?.status, 'uncertain', 'the retried write completes the accounting');
});

test('a persistently failing fenced-outcome write keeps the payload and the owner can still record it', async () => {
  const { state, evidence, request, admission, statePort } = admitted();
  const record = statePort.recordOutcome.bind(statePort);
  let writes = 0;
  statePort.recordOutcome = async () => {
    writes++;
    throw new Error('persistent write failure');
  };
  const result = await fencedPort(statePort).propose(state, evidence, request, admission);
  assert.equal(result.outcome, 'denied');
  assert.equal(result.reason, 'FENCED_EXECUTOR');
  assert.equal(writes, 2, 'the retry is bounded');
  assert.ok(result.recovery, 'the failed write hands the receipt back instead of discarding it');
  const journal = statePort.getJournalSnapshot();
  assert.equal(journal.outcomes.length, 0, 'no outcome was persisted');
  assert.equal(journal.claims[0]?.status, 'attempting', 'the claim is still attributable to the replayable payload');

  // The owner replays the retained receipt; the fenced attempt then accounts and can be reconciled.
  statePort.recordOutcome = record;
  const { receipt } = result.recovery;
  assert.equal((await statePort.recordOutcome(receipt)).outcome, 'uncertain');
  assert.equal(statePort.getJournalSnapshot().claims[0]?.status, 'uncertain');

  // The recovered uncertain attempt still reconciles to proven-not-dispatched through a fenced recipient.
  const executor = receipt.executorIdentity;
  assert.equal(await statePort.setTaskControl(state.taskId, 'paused', 'pause-m3-persistent-001'), true);
  const fence = await statePort.fenceAttemptRecipient(receipt.claimId, executor);
  assert.ok(fence, 'the accounted attempt is fenceable for recovery');
  const task = await statePort.loadTask(state.taskId);
  assert.ok(task);
  const reconciliation = createTestUncertainReconciliationReceiptV02(receipt, result.recovery.claim, result.recovery.attempt, admission, {
    disposition: 'proven-not-dispatched',
    fencedRecipientIdentity: fence.recipientIdentity,
    fencingGeneration: fence.fencingGeneration,
    fencingProof: fence.proofRef,
    adapterEvidenceRefs: fence.adapterEvidenceRefs,
    evidenceRefs: [...fence.adapterEvidenceRefs, fence.proofRef],
    expectedCurrentTaskStateVersion: task.stateVersion,
    expectedCurrentControlVersion: statePort.getJournalSnapshot().controlVersion,
  });
  assert.equal((await statePort.reconcileUncertain(reconciliation)).outcome, 'settled', 'owner reconciliation reaches proven-not-dispatched');
  assert.equal(statePort.getJournalSnapshot().claims[0]?.status, 'settled');
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

test('a fenced denial after beginAttempt leaves the claim settled, and a fresh authorized request is then admitted without replaying the old attempt', async () => {
  const { state, evidence, request, admission, statePort } = admitted();
  let sends = 0;
  const authorized = false;

  let recordedClaim: ClaimReceiptV02 | undefined;
  let recordedAttempt: AttemptReceiptV02 | undefined;
  let recordedOutcome: AttemptOutcomeReceiptV02 | undefined;

  const ownClaim = statePort.claim.bind(statePort);
  statePort.claim = async ctx => {
    const res = await ownClaim(ctx);
    recordedClaim = res;
    return res;
  };
  const ownBegin = statePort.beginAttempt.bind(statePort);
  statePort.beginAttempt = async (cId, exec) => {
    const res = await ownBegin(cId, exec);
    recordedAttempt = res;
    return res;
  };
  const ownRecord = statePort.recordOutcome.bind(statePort);
  statePort.recordOutcome = async rec => {
    recordedOutcome = structuredClone(rec);
    return ownRecord(rec);
  };

  const port = new HostModelPortV02({
    statePort,
    transport: {
      async execute() {
        sends += 1;
        return { proposal: { content: '{"fixed":true}' }, observedUsage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01, billableTokens: 15 } };
      },
    },
    executorIdentity: ACTOR,
    currentExecutorIdentity: () => ACTOR,
    currentDispatchAuthority: () => authorized,
  });

  // 1. First request is denied by the dispatch fence after beginAttempt.
  const first = await port.propose(state, evidence, request, admission);
  assert.equal(first.outcome, 'denied');
  assert.equal(first.reason, 'FENCED_EXECUTOR');
  assert.equal(sends, 0, 'fenced request never reaches transport');

  // The claim is accounted as uncertain, not left stuck in attempting.
  let journal = statePort.getJournalSnapshot();
  assert.equal(journal.attempts.length, 1);
  assert.equal(journal.outcomes.length, 1);
  assert.equal(journal.outcomes[0]?.outcome, 'uncertain');
  assert.equal(journal.claims[0]?.status, 'uncertain');
  assert.ok(recordedClaim);
  assert.ok(recordedAttempt);
  assert.ok(recordedOutcome);

  // 2. Recovery settles the uncertain claim to proven-not-dispatched.
  assert.equal(await statePort.setTaskControl(state.taskId, 'paused', 'pause-settlement-001'), true);
  const fence = await statePort.fenceAttemptRecipient(recordedOutcome.claimId, recordedOutcome.executorIdentity);
  assert.ok(fence, 'fenced claim is fenceable');
  const task = await statePort.loadTask(state.taskId);
  assert.ok(task);
  const reconciliation = createTestUncertainReconciliationReceiptV02(recordedOutcome, recordedClaim, recordedAttempt, admission, {
    disposition: 'proven-not-dispatched',
    fencedRecipientIdentity: fence.recipientIdentity,
    fencingGeneration: fence.fencingGeneration,
    fencingProof: fence.proofRef,
    adapterEvidenceRefs: fence.adapterEvidenceRefs,
    evidenceRefs: [...fence.adapterEvidenceRefs, fence.proofRef],
    expectedCurrentTaskStateVersion: task.stateVersion,
    expectedCurrentControlVersion: statePort.getJournalSnapshot().controlVersion,
  });
  const reconciled = await statePort.reconcileUncertain(reconciliation);
  assert.equal(reconciled.outcome, 'settled', 'recovery leaves the claim settled');

  journal = statePort.getJournalSnapshot();
  assert.equal(journal.claims[0]?.status, 'settled', 'claim is settled');
  const ledger = ((await statePort.loadTask(state.taskId))?.budgetLedgers ?? []).find(item => item.kind === 'cost');
  assert.ok(ledger);
  assert.deepEqual(ledger.reservations, [], 'held reservations released upon settlement');

  // 3. Task control resumed to runnable, port authorized.
  assert.equal(await statePort.setTaskControl(state.taskId, 'runnable', 'resume-task-001'), true);

  // 4. A fresh authorized request is admitted and dispatched without replaying the old attempt.
  const freshActor = { adapterIdentity: ACTOR.adapterIdentity, processIncarnation: 'proc-authority-2', fencingGeneration: 2 };
  const freshPort = new HostModelPortV02({
    statePort,
    transport: {
      async execute() {
        sends += 1;
        return { proposal: { proposalId: 'msg-fresh-1', content: '{"fixed":true}' }, observedUsage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01, billableTokens: 15 } };
      },
    },
    executorIdentity: freshActor,
    currentExecutorIdentity: () => freshActor,
    currentDispatchAuthority: () => true,
  });

  const freshRequestId = 'req-authority-fresh-2';
  const freshDraft = createTestProviderRequest({ providerRequestId: freshRequestId, taskId: TASK_ID, runId: 'run-001', role: 'coder', reservationRef: `res-${freshRequestId}` });
  const freshRequest = createTestProviderRequest({ ...freshDraft, contextDigest: computeContextDigest(state, evidence) });
  const currentControl = statePort.getJournalSnapshot();
  const freshAdmission = createTestProviderAdmissionContextV02({
    providerRequest: freshRequest,
    taskId: TASK_ID,
    runId: 'run-001',
    expectedControlVersion: currentControl.controlVersion,
    expectedEpoch: currentControl.epoch,
  });

  const second = await freshPort.propose(state, evidence, freshRequest, freshAdmission);
  assert.equal(second.outcome, 'observed', `fresh authorized request is admitted and succeeds: ${JSON.stringify(second.errors)}`);
  assert.equal(sends, 1, 'transport is called exactly once (for the fresh request)');

  journal = statePort.getJournalSnapshot() as typeof journal;
  assert.equal(journal.attempts.length, 2, 'second attempt is recorded, not replaying old attempt');
  assert.equal(journal.claims.length, 2, 'fresh claim is recorded');
  assert.equal(journal.claims[0]?.status, 'settled', 'old claim was settled');
  assert.equal(journal.claims[1]?.status, 'settled', 'new claim is settled');
  assert.notEqual(journal.attempts[1]?.attemptId, journal.attempts[0]?.attemptId, 'distinct new attempt');
});
