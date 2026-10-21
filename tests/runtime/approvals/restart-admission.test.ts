import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApprovalContinuation } from '../../../src/approvals/control.ts';
import { createRecoveryScenario, recoveryProfile } from '../support/uc05/mock-recovery.ts';
import type { ApprovalRecoveryOwner } from '../../../src/approvals/control.ts';

type Scenario = ReturnType<typeof createRecoveryScenario>;
const continuation = (scenario: Scenario, recovery: ApprovalRecoveryOwner = scenario.owner, deadline = 2000) => createApprovalContinuation({ taskId: 'task-1', profile: { ...recoveryProfile, commandRules: recoveryProfile.commandRules.map(rule => ({ ...rule, timeoutMs: deadline })), operationDeadlineMs: deadline }, approval: scenario.service(), recovery });
async function approved(scenario: Scenario): Promise<void> {
  const service = scenario.service();
  await service.requestDecision(scenario.binding);
  await scenario.decide(service);
}

test('local reload admits a fresh approved interrupted action with a retained owner claim and complete reservation', async () => {
  const scenario = createRecoveryScenario();
  const original = scenario.service();
  await original.requestDecision(scenario.binding);
  await scenario.decide(original);
  const continuation = createApprovalContinuation({ taskId: 'task-1', profile: recoveryProfile, approval: scenario.service(), recovery: scenario.owner });
  assert.deepEqual(await continuation.admit('decision-1'), { outcome: 'claimed', claimId: 'claim-1' });
  assert.equal(scenario.store.readHistory('task-1').value?.claims.length, 1);
});

test('waiting and rejected task holds survive new service and continuation instances', async () => {
  for (const rejected of [false, true]) {
    const scenario = createRecoveryScenario();
    const service = scenario.service();
    await service.requestDecision(scenario.binding);
    if (rejected) await scenario.decide(service, 'reject');
    const original = scenario.store.loadTaskControl('task-1');
    assert.equal((await continuation(scenario).admit('decision-1')).outcome, 'blocked');
    assert.deepEqual(scenario.store.loadTaskControl('task-1'), original);
    assert.equal((await scenario.service().resolve('decision-1')).status, rejected ? 'rejected' : 'pending');
    assert.equal(scenario.store.readHistory('task-1').value?.claims.length, 0);
  }
});

test('lost approval commit response reloads exact persisted decision but cannot create consent on failure', async () => {
  for (const committed of [false, true]) {
    const scenario = createRecoveryScenario();
    const backend = { ...scenario.store, resolvePending: (input: unknown) => { if (committed) scenario.store.resolvePending(input); throw new Error('lost-decision-response'); } };
    const service = scenario.service(backend);
    await service.requestDecision(scenario.binding);
    await assert.rejects(scenario.decide(service));
    assert.equal((await continuation(scenario).admit('decision-1')).outcome, committed ? 'claimed' : 'blocked');
    assert.equal(scenario.store.readHistory('task-1').value?.resolutions.length, committed ? 1 : 0);
  }
});

test('failed pending persistence never authorizes an interrupted action', async () => {
  const scenario = createRecoveryScenario();
  scenario.store.failNext('createPendingAndPause');
  await assert.rejects(scenario.service().requestDecision(scenario.binding));
  assert.notEqual((await continuation(scenario).admit('decision-1')).outcome, 'claimed');
  assert.equal(scenario.store.readHistory('task-1').value?.claims.length, 0);
});

test('repository drift invalidates approved consent before a recovery claim', async () => {
  const scenario = createRecoveryScenario();
  await approved(scenario);
  const changed = `sha256:${'b'.repeat(64)}`;
  const context = scenario.current();
  scenario.setContext({ ...context, facts: { ...context.facts, repositoryRevisionDigest: changed }, freshness: { ...context.freshness, currentRepositoryRevisionDigest: changed } });
  assert.equal((await continuation(scenario).admit('decision-1')).outcome, 'blocked');
  assert.equal(scenario.store.readHistory('task-1').value?.claims.length, 0);
});

test('owner serialized pause wins over an already validated approval and prevents a claim', async () => {
  const scenario = createRecoveryScenario();
  await approved(scenario);
  scenario.beforeClaim(async () => { await scenario.service().requestDecision({ ...scenario.binding, decisionId: 'decision-2' }); });
  assert.notEqual((await continuation(scenario).admit('decision-1')).outcome, 'claimed');
  assert.equal(scenario.store.loadTaskControl('task-1').value?.mode, 'waiting');
  assert.equal(scenario.store.readHistory('task-1').value?.claims.length, 0);
});

test('missing and exhausted canonical accounting deny claims despite approval', async () => {
  for (const accounting of ['missing', 'exhausted'] as const) {
    const scenario = createRecoveryScenario({ accounting });
    await approved(scenario);
    assert.equal((await continuation(scenario).admit('decision-1')).outcome, 'unavailable');
    assert.equal(scenario.store.readHistory('task-1').value?.claims.length, 0);
  }
});

test('unsettled canonical reservation cannot be admitted as a fresh attempt', async () => {
  const scenario = createRecoveryScenario();
  await approved(scenario);
  await scenario.accounting.reserveMany([{ scope: 'task', kind: 'tokens', amount: 100 }], 'request-action-1', 'transaction-action-1');
  await scenario.accounting.reconcileUncertain('request-action-1', { reason: 'mock-interruption' });
  assert.equal((await continuation(scenario).admit('decision-1')).outcome, 'unavailable');
  assert.equal(scenario.store.readHistory('task-1').value?.claims.length, 0);
});

test('lost claim response retains owner claim and reservations and forbids replay after reload or a new run', async () => {
  const scenario = createRecoveryScenario();
  await approved(scenario);
  scenario.loseClaimResponse();
  assert.equal((await continuation(scenario).admit('decision-1')).outcome, 'unavailable');
  assert.equal(scenario.store.readHistory('task-1').value?.claims.length, 1);
  scenario.setContext({ ...scenario.current(), runId: 'run-2' });
  assert.equal((await continuation(scenario).admit('decision-1')).outcome, 'blocked');
  await scenario.accounting.reserve('task', 'tokens', 99900, 'remaining');
  await assert.rejects(scenario.accounting.reserve('task', 'tokens', 1, 'must-not-reset'));
});

test('observed, uncertain and reconciled outcomes never blindly replay the interrupted decision', async () => {
  for (const phase of ['observed', 'uncertain', 'reconciled'] as const) {
    const scenario = createRecoveryScenario();
    await approved(scenario);
    assert.equal((await continuation(scenario).admit('decision-1')).outcome, 'claimed');
    const initial = phase === 'observed' ? 'observed' : 'uncertain';
    const response = scenario.store.recordOutcome({ claimId: 'claim-1', expectedControlVersion: 4, resultRef: 'result-1', phase: initial, event: scenario.event(initial === 'observed' ? 'dispatch-effect-observed' : 'dispatch-uncertain', 'claim-1') });
    assert.equal(response.safe.outcome, initial === 'observed' ? 'ok' : 'uncertain');
    if (phase === 'reconciled') assert.equal(scenario.store.reconcile({ claimId: 'claim-1', expectedControlVersion: 5, resultRef: 'evidence-1', event: scenario.event('claim-reconciled', 'claim-1') }).safe.outcome, 'ok');
    assert.equal((await continuation(scenario).admit('decision-1')).outcome, 'blocked');
    assert.equal(scenario.store.readHistory('task-1').value?.claims.length, 1);
    await scenario.accounting.reserve('task', 'tokens', 99900, 'remaining');
    await assert.rejects(scenario.accounting.reserve('task', 'tokens', 1, 'retained-charge'));
  }
});

test('deadline while loading owner state cannot start a late claim', async () => {
  const scenario = createRecoveryScenario();
  await approved(scenario);
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const recovery = { ...scenario.owner, load: async (id: string) => { await gate; return scenario.owner.load(id); } };
  assert.equal((await continuation(scenario, recovery, 10).admit('decision-1')).outcome, 'unavailable');
  release?.();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(scenario.store.readHistory('task-1').value?.claims.length, 0);
});

test('a claim that commits after caller deadline stays retained and cannot yield late admission or replay', async () => {
  const scenario = createRecoveryScenario();
  await approved(scenario);
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  scenario.beforeClaim(async () => gate);
  assert.equal((await continuation(scenario, scenario.owner, 10).admit('decision-1')).outcome, 'unavailable');
  release?.();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(scenario.store.readHistory('task-1').value?.claims.length, 1);
  assert.equal((await continuation(scenario).admit('decision-1')).outcome, 'blocked');
});

test('malformed or protected claim receipts fail closed without releasing actual retained claims', async () => {
  for (const variant of ['accessor', 'proxy', 'protected', 'reservation'] as const) {
    const scenario = createRecoveryScenario();
    await approved(scenario);
    let reads = 0;
    const recovery = { ...scenario.owner, claimDispatch: async (input: Parameters<ApprovalRecoveryOwner['claimDispatch']>[0]) => {
      const receipt = await scenario.owner.claimDispatch(input);
      if (variant === 'accessor') return { get claim() { reads += 1; throw new Error('must-not-read'); } };
      if (variant === 'proxy') return new Proxy({}, { getPrototypeOf() { reads += 1; throw new Error('must-not-trap'); } });
      if (variant === 'protected') return { receipt, secret: '-----BEGIN PRIVATE KEY-----' };
      return { ...(receipt as Record<string, unknown>), reservations: null };
    } };
    assert.equal((await continuation(scenario, recovery).admit('decision-1')).outcome, 'unavailable');
    assert.equal(reads, 0);
    assert.equal(scenario.store.readHistory('task-1').value?.claims.length, 1);
    assert.equal((await continuation(scenario).admit('decision-1')).outcome, 'blocked');
  }
});

test('malformed recovery state closes admission without invoking an accessor', async () => {
  const scenario = createRecoveryScenario();
  let reads = 0;
  const recovery = { ...scenario.owner, load: async () => ({ get control() { reads += 1; return {}; } }) };
  const continuation = createApprovalContinuation({ taskId: 'task-1', profile: recoveryProfile, approval: scenario.service(), recovery });
  assert.deepEqual(await continuation.admit('decision-1'), { outcome: 'unavailable', claimId: null });
  assert.equal(reads, 0);
});

test('an unrelated unresolved owner claim missing its control fence makes recovery unavailable', async () => {
  const scenario = createRecoveryScenario();
  await approved(scenario);
  const foreign = { schemaVersion: 'uc05-approval/0.1-draft', claimId: 'claim-other', actionId: 'action-other', taskId: 'task-1', expectedControlVersion: 1, expectedEpoch: 1,
    repositoryStateDigest: scenario.binding.repositoryRevisionDigest, policyIdentity: recoveryProfile.policyIdentity, decisionRefs: ['decision-other'], reservationRefs: ['bundle-other'], phase: 'claimed', resultRef: null };
  const recovery = { ...scenario.owner, load: async (id: string) => ({ ...(await scenario.owner.load(id) as Record<string, unknown>), claims: [foreign] }) };
  assert.equal((await continuation(scenario, recovery).admit('decision-1')).outcome, 'unavailable');
  assert.equal(scenario.store.readHistory('task-1').value?.claims.length, 0);
});

test('a new run with admitted owner accounting can continue while earlier task spending stays charged', async () => {
  const scenario = createRecoveryScenario({ accountingRunId: 'run-2' });
  await scenario.accounting.reserve('task', 'tokens', 500, 'prior-run-charge');
  await approved(scenario);
  scenario.setContext({ ...scenario.current(), runId: 'run-2' });
  assert.deepEqual(await continuation(scenario).admit('decision-1'), { outcome: 'claimed', claimId: 'claim-1' });
  await scenario.accounting.reserve('task', 'tokens', 99400, 'remaining-after-reload');
  await assert.rejects(scenario.accounting.reserve('task', 'tokens', 1, 'no-reset'));
});

test('owner current-policy and safety checks reject drift between approval validation and claim', async () => {
  for (const changed of ['policy', 'safety', 'run'] as const) {
    const scenario = createRecoveryScenario();
    await approved(scenario);
    scenario.beforeClaim(async () => {
      const context = scenario.current();
      scenario.setContext(changed === 'run' ? { ...context, runId: 'run-2' } : { ...context, facts: { ...context.facts,
        ...(changed === 'policy' ? { policyIdentity: { ...context.facts.policyIdentity, configVersion: '2' } } : { safety: { ...context.facts.safety, isolated: false } }) } });
    });
    assert.notEqual((await continuation(scenario).admit('decision-1')).outcome, 'claimed');
    assert.equal(scenario.store.readHistory('task-1').value?.claims.length, 0);
  }
});

test('sparse owner reservation requirements cannot stand in for complete finite accounting', () => {
  const scenario = createRecoveryScenario();
  const requirements: ApprovalRecoveryOwner['reservationRequirements'] = new Array(1);
  assert.throws(() => continuation(scenario, { ...scenario.owner, reservationRequirements: requirements }), /invalid-approval-recovery-requirements/u);
});
