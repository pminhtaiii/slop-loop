/**
 * UC-03 v0.2.0 Atomic Admission Mock Journal Tests (T041 / T042).
 *
 * T041 keeps the real test-only StatePortV02 methods neutral. Valid positive
 * flows therefore stop at the first neutral predecessor assertion until T042.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAdmittedForProduction,
  validateAdmissionV02,
  validateAttemptOutcomeReceiptV02,
  validateAttemptReceiptV02,
  validateAttemptReconciliationReceiptV02,
  validateBudgetLedger,
  validateClaimClosureReceiptV02,
  validateTaskState,
  type AdmissionContextV02,
  type AttemptOutcomeReceiptV02,
  type AttemptReconciliationReceiptV02,
  type AttemptReceiptV02,
  type ClaimReceiptV02,
  type ExecutorIdentityV02,
  type ProviderAdmissionContextV02,
  type RepositoryAdmissionContextV02,
  type TaskState,
} from '../../../src/contracts/foundation/uc03.ts';
import {
  MemoryStatePort,
  MemoryStatePortV02,
  NEUTRAL_CLAIM_RECEIPT_V02,
  NEUTRAL_ATTEMPT_RECEIPT_V02,
  NEUTRAL_OUTCOME_RECORD_RESULT_V02,
  NEUTRAL_RECONCILIATION_RESULT_V02,
  NEUTRAL_CLAIM_CLOSURE_RESULT_V02,
  isNeutralClaimReceiptV02,
  isNeutralAttemptReceiptV02,
  isNeutralOutcomeRecordResultV02,
  isNeutralReconciliationResultV02,
  isNeutralClaimClosureResultV02,
} from '../support/uc03/memory-state.ts';
import {
  createTestAdmissionTaskStateV02,
  createTestAdmissionTransitionContextsV02,
  createTestAttemptReceiptV02,
  createTestClaimClosureReceiptV02,
  createTestClaimReceiptV02,
  createTestExecutorIdentityV02,
  createTestObservedReconciliationReceiptV02,
  createTestProviderAdmissionContextV02,
  createTestProviderAdmissionTrustedContextV02,
  createTestProviderOutcomeReceiptV02,
  createTestRepositoryAdmissionContextV02,
  createTestRepositoryAdmissionTrustedContextV02,
  createTestRepositoryOutcomeReceiptV02,
  createTestTaskState,
  createTestUncertainReconciliationReceiptV02,
} from '../support/uc03/state-fixtures.ts';

const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VALID_DIGEST = /^sha256:[0-9a-f]{64}$/i;

function assertIdentity(value: string, label: string): void {
  assert.match(value, VALID_ID, `${label} must be a non-empty identity`);
}

function assertDigest(value: string, label: string): void {
  assert.match(value, VALID_DIGEST, `${label} must be a canonical SHA-256 digest`);
}

function assertAdmissionFixture(context: AdmissionContextV02): {
  readonly initialTaskState: TaskState;
  readonly transitionContexts: ReturnType<typeof createTestAdmissionTransitionContextsV02>;
} {
  const validation = context.subjectKind === 'repository-action'
    ? validateAdmissionV02(context, createTestRepositoryAdmissionTrustedContextV02(context))
    : validateAdmissionV02(context, createTestProviderAdmissionTrustedContextV02(context));
  assert.equal(validation.ok, true, `${context.subjectKind} admission fixture: ${JSON.stringify(validation)}`);

  const initialTaskState = createTestAdmissionTaskStateV02(context);
  const stateValidation = validateTaskState(initialTaskState);
  assert.equal(stateValidation.ok, true, `task-state fixture: ${JSON.stringify(stateValidation)}`);
  assert.equal(initialTaskState.taskId, context.taskId);
  assert.equal(initialTaskState.runId, context.runId);
  assert.ok(initialTaskState.budgetLedgers?.length);
  for (const ledger of initialTaskState.budgetLedgers ?? []) {
    const ledgerValidation = validateBudgetLedger(ledger);
    assert.equal(ledgerValidation.ok, true, `budget-ledger fixture (${ledger.scope}/${ledger.kind}): ${JSON.stringify(ledgerValidation)}`);
    assert.ok(Number.isFinite(ledger.limit) && ledger.limit > 0, `finite ${ledger.scope}/${ledger.kind} limit`);
  }

  return {
    initialTaskState,
    transitionContexts: createTestAdmissionTransitionContextsV02(context, initialTaskState),
  };
}

function createPort(context: AdmissionContextV02): MemoryStatePortV02 {
  return new MemoryStatePortV02(assertAdmissionFixture(context));
}

function assertClaimMatchesContext(claim: ClaimReceiptV02, context: AdmissionContextV02): void {
  assertIdentity(claim.claimId, 'claimId');
  assertDigest(claim.claimDigest, 'claimDigest');
  assert.equal(claim.taskId, context.taskId);
  assert.equal(claim.runId, context.runId);
  assert.equal(claim.subjectKind, context.subjectKind);
  assert.equal(claim.planApplicability, context.planApplicability);
  assert.equal(claim.status, 'claimed');
  assert.equal(claim.preClaimTaskStateVersion, context.expectedTaskStateVersion);
  assert.equal(claim.preClaimControlVersion, context.expectedControlVersion);
  assert.equal(claim.postClaimControlVersion, context.expectedControlVersion + 1);
  assert.equal(claim.epoch, context.expectedEpoch);

  const requiredRefs = context.subjectKind === 'repository-action'
    ? context.reservationRefs
    : [context.requestReservationReceipt, ...context.budgetRefs];
  for (const ref of requiredRefs) assert.ok(claim.reservationRefs.includes(ref), `claim binds current reservation ${ref}`);
}

function assertAttemptMatchesContext(
  attempt: AttemptReceiptV02,
  claim: ClaimReceiptV02,
  executor: ExecutorIdentityV02,
  context: AdmissionContextV02,
): void {
  assertIdentity(attempt.attemptId, 'attemptId');
  assert.equal(attempt.claimId, claim.claimId);
  assert.equal(attempt.taskId, context.taskId);
  assert.deepEqual(attempt.executorIdentity, executor);
  assert.equal(attempt.status, 'attempting');
  assert.equal(attempt.epoch, claim.epoch);
  assert.equal(attempt.preAttemptTaskStateVersion, claim.preClaimTaskStateVersion);
  assert.equal(attempt.preAttemptControlVersion, claim.postClaimControlVersion);
  assert.equal(attempt.postBeginControlVersion, claim.postClaimControlVersion + 1);
  const isRepairPatch = context.subjectKind === 'repository-action' && context.action.kind === 'apply_patch';
  assert.equal(attempt.postBeginTaskStateVersion, attempt.preAttemptTaskStateVersion + (isRepairPatch ? 1 : 0));
  const validation = validateAttemptReceiptV02(attempt, {
    expectedTaskId: context.taskId,
    expectedClaimId: claim.claimId,
    expectedAttemptId: attempt.attemptId,
    expectedEpoch: claim.epoch,
    isRepairPatch,
  });
  assert.equal(validation.ok, true, `attempt receipt: ${JSON.stringify(validation)}`);
}

function assertOutcomeMatchesFlow(
  receipt: AttemptOutcomeReceiptV02,
  claim: ClaimReceiptV02,
  attempt: AttemptReceiptV02,
  context: AdmissionContextV02,
): void {
  assertIdentity(receipt.receiptId, 'outcome receiptId');
  assertDigest(receipt.receiptDigest, 'outcome receiptDigest');
  assert.equal(receipt.claimId, claim.claimId);
  assert.equal(receipt.attemptId, attempt.attemptId);
  assert.equal(receipt.subjectKind, context.subjectKind);
  assert.equal(receipt.planApplicability, context.planApplicability);

  const trusted = context.subjectKind === 'repository-action'
    ? {
        expectedClaimId: claim.claimId,
        expectedAttemptId: attempt.attemptId,
        expectedPlanApplicability: context.planApplicability,
        expectedActionDigest: context.actionDigest,
      }
    : {
        expectedClaimId: claim.claimId,
        expectedAttemptId: attempt.attemptId,
        expectedPlanApplicability: context.planApplicability,
        expectedRequestContentDigest: context.requestContentDigest,
        expectedProviderRequestId: context.providerRequestId,
        expectedRole: context.role,
        expectedProviderAdmissionReceiptRef: context.providerAdmissionReceipt.receiptId,
        expectedBudgetRefs: context.budgetRefs,
      };
  const validation = validateAttemptOutcomeReceiptV02(receipt, trusted);
  assert.equal(validation.ok, true, `outcome receipt: ${JSON.stringify(validation)}`);

  if (receipt.subjectKind === 'repository-action') {
    assert.equal(context.subjectKind, 'repository-action');
    assert.equal(receipt.actionDigest, (context as RepositoryAdmissionContextV02).actionDigest);
  } else {
    assert.equal(context.subjectKind, 'provider-request');
    const providerContext = context as ProviderAdmissionContextV02;
    assert.equal(receipt.providerRequestId, providerContext.providerRequestId);
    assert.equal(receipt.requestContentDigest, providerContext.requestContentDigest);
    assert.equal(receipt.role, providerContext.role);
    assert.equal(receipt.providerAdmissionReceiptRef, providerContext.providerAdmissionReceipt.receiptId);
    assert.deepEqual(receipt.budgetRefs, providerContext.budgetRefs);
  }
}

function assertReconciliationMatchesPredecessor(
  receipt: AttemptReconciliationReceiptV02,
  predecessor: AttemptOutcomeReceiptV02,
): void {
  assertIdentity(receipt.reconciliationId, 'reconciliationId');
  assertDigest(receipt.reconciliationDigest, 'reconciliationDigest');
  assert.equal(receipt.predecessorReceiptId, predecessor.receiptId);
  assert.equal(receipt.predecessorReceiptDigest, predecessor.receiptDigest);
  assert.equal(receipt.claimId, predecessor.claimId);
  assert.equal(receipt.attemptId, predecessor.attemptId);
  assert.equal(receipt.subjectKind, predecessor.subjectKind);
  assert.equal(receipt.planApplicability, predecessor.planApplicability);
  const validation = validateAttemptReconciliationReceiptV02(receipt, {
    predecessor: predecessor as unknown as Record<string, unknown>,
    predecessorReceiptDigest: predecessor.receiptDigest,
  });
  assert.equal(validation.ok, true, `reconciliation receipt: ${JSON.stringify(validation)}`);
}

async function claimRepositoryFlow(context = createTestRepositoryAdmissionContextV02()) {
  const port = createPort(context);
  const claim = await port.claim(context);
  assertClaimMatchesContext(claim, context);
  return { port, context, claim };
}

async function beginRepositoryAttempt() {
  const flow = await claimRepositoryFlow();
  const executor = createTestExecutorIdentityV02({ payloadDigest: flow.context.actionDigest });
  const attempt = await flow.port.beginAttempt(flow.claim.claimId, executor);
  assertAttemptMatchesContext(attempt, flow.claim, executor, flow.context);
  return { ...flow, executor, attempt };
}

async function beginProviderAttempt(context = createTestProviderAdmissionContextV02()) {
  const port = createPort(context);
  const claim = await port.claim(context);
  assertClaimMatchesContext(claim, context);
  const executor = createTestExecutorIdentityV02({ payloadDigest: context.requestContentDigest });
  const attempt = await port.beginAttempt(claim.claimId, executor);
  assertAttemptMatchesContext(attempt, claim, executor, context);
  return { port, context, claim, executor, attempt };
}

function providerLedgers(port: MemoryStatePortV02) {
  return port.getLedgers().filter((ledger) => ledger.kind === 'tokens' || ledger.kind === 'cost');
}

// ---------------------------------------------------------------------------
// Scaffolding and invariant tests (GREEN at T041)
// ---------------------------------------------------------------------------

test('Scaffolding: MemoryStatePortV02 implements StatePortV02 and rejects production admission by mock provenance', () => {
  const port = new MemoryStatePortV02();
  assert.equal(port.provenance, 'mock');
  assert.equal(isAdmittedForProduction([port]), false);
});

test('Scaffolding: neutral methods capture zero effects on task state and ledgers', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const before = await port.loadTask(context.taskId);
  const beforeLedgers = port.getLedgers();

  const claim = await port.claim(context);
  assert.equal(isNeutralClaimReceiptV02(claim), true);

  const executor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await port.beginAttempt(claim.claimId, executor);
  assert.equal(isNeutralAttemptReceiptV02(attempt), true);

  const outcomeReceipt = createTestRepositoryOutcomeReceiptV02(claim, attempt, context, { outcome: 'uncertain' });
  const outcome = await port.recordOutcome(outcomeReceipt);
  assert.equal(isNeutralOutcomeRecordResultV02(outcome), true);

  const after = await port.loadTask(context.taskId);
  assert.deepEqual(after, before);
  assert.deepEqual(port.getLedgers(), beforeLedgers);
});

test('Scaffolding: neutral placeholders are distinguishable from canonical valid receipts', () => {
  assert.equal(isNeutralClaimReceiptV02(NEUTRAL_CLAIM_RECEIPT_V02), true);
  assert.equal(isNeutralAttemptReceiptV02(NEUTRAL_ATTEMPT_RECEIPT_V02), true);
  assert.equal(isNeutralOutcomeRecordResultV02(NEUTRAL_OUTCOME_RECORD_RESULT_V02), true);
  assert.equal(isNeutralReconciliationResultV02(NEUTRAL_RECONCILIATION_RESULT_V02), true);
  assert.equal(isNeutralClaimClosureResultV02(NEUTRAL_CLAIM_CLOSURE_RESULT_V02), true);

  assert.equal(isNeutralClaimReceiptV02(createTestClaimReceiptV02()), false);
  assert.equal(isNeutralAttemptReceiptV02(createTestAttemptReceiptV02()), false);
  assert.equal(isNeutralOutcomeRecordResultV02({ outcome: 'settled', receiptId: 'receipt-fixture' }), false);
  assert.equal(isNeutralReconciliationResultV02({ outcome: 'settled', receiptId: 'receipt-fixture' }), false);
  assert.equal(isNeutralClaimClosureResultV02({ closed: true, receiptId: 'receipt-fixture' }), false);
});

test('Scaffolding: MemoryStatePort original v0.1 remains source and behavior compatible', async () => {
  const initialTaskState = createTestTaskState();
  const v1 = new MemoryStatePort({ initialTaskState });
  assert.equal(v1.provenance, 'mock');
  const loaded = await v1.loadTask(initialTaskState.taskId);
  assert.ok(loaded);
  assert.equal(loaded.taskId, initialTaskState.taskId);
  const resId = await v1.reserve('task', 'tokens', 100, 'act-cmd-001');
  assert.ok(resId);
});

test('Scaffolding: MemoryStatePortV02 preserves task loading, transition, checkpoint, and recovery', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const loaded = await port.loadTask(context.taskId);
  assert.ok(loaded);
  assert.equal(loaded.taskId, context.taskId);
  await port.checkpoint(loaded);
  const recovered = await port.recover(context.taskId);
  assert.equal(recovered.taskId, context.taskId);
});

test('Scaffolding: admission, state, and finite-ledger fixtures satisfy v0.2 validators', () => {
  assertAdmissionFixture(createTestRepositoryAdmissionContextV02());
  assertAdmissionFixture(createTestProviderAdmissionContextV02());
});

// ---------------------------------------------------------------------------
// Positive journal vectors (behavioral assertion RED in T041; GREEN in T042)
// ---------------------------------------------------------------------------

test('Positive vector: valid claim CAS on repository admission context (RED in T041, GREEN in T042)', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const receipt = await port.claim(context);

  assertClaimMatchesContext(receipt, context);
});

test('Positive vector: valid claim CAS on provider admission context (RED in T041, GREEN in T042)', async () => {
  const context = createTestProviderAdmissionContextV02();
  const port = createPort(context);
  const receipt = await port.claim(context);

  assertClaimMatchesContext(receipt, context);
});

test('Positive vector: single-use beginAttempt returns the claimed attempt identity (RED in T041, GREEN in T042)', async () => {
  const flow = await beginRepositoryAttempt();
  const beforeReplay = await flow.port.loadTask(flow.context.taskId);
  const beforeLedgers = flow.port.getLedgers();

  const replay = await flow.port.beginAttempt(flow.claim.claimId, flow.executor);
  assert.equal(isNeutralAttemptReceiptV02(replay), true);
  assert.deepEqual(await flow.port.loadTask(flow.context.taskId), beforeReplay);
  assert.deepEqual(flow.port.getLedgers(), beforeLedgers);
});

test('Positive vector: recordOutcome for observed repository action binds the actual attempt (RED in T041, GREEN in T042)', async () => {
  const flow = await beginRepositoryAttempt();
  const beforeProviderLedgers = providerLedgers(flow.port);
  const outcomeReceipt = createTestRepositoryOutcomeReceiptV02(flow.claim, flow.attempt, flow.context);
  assertOutcomeMatchesFlow(outcomeReceipt, flow.claim, flow.attempt, flow.context);

  const result = await flow.port.recordOutcome(outcomeReceipt);

  assert.equal(result.outcome, 'settled');
  assert.equal(result.receiptId, outcomeReceipt.receiptId);
  assert.deepEqual(providerLedgers(flow.port), beforeProviderLedgers, 'repository-only action does not charge provider token/cost ledgers');
});

test('Positive vector: recordOutcome for observed provider request binds role and reservations (RED in T041, GREEN in T042)', async () => {
  const flow = await beginProviderAttempt();
  const outcomeReceipt = createTestProviderOutcomeReceiptV02(flow.claim, flow.attempt, flow.context);
  assertOutcomeMatchesFlow(outcomeReceipt, flow.claim, flow.attempt, flow.context);

  const result = await flow.port.recordOutcome(outcomeReceipt);

  assert.equal(result.outcome, 'settled');
  assert.equal(result.receiptId, outcomeReceipt.receiptId);
});

test('Positive vector: observed-unsettled recovery uses a recorded predecessor and preserves a conflicting task state (RED in T041, GREEN in T042)', async () => {
  const flow = await beginRepositoryAttempt();
  const afterAttempt = await flow.port.loadTask(flow.context.taskId);
  assert.ok(afterAttempt);
  assert.equal(afterAttempt.node, 'Patch');

  // Patch -> Repair is an allowed task transition and creates a real state conflict
  // after the attempt, before the observed effect receipt is recorded.
  await flow.port.transition({ ...afterAttempt, stateVersion: afterAttempt.stateVersion + 1, node: 'Repair' }, afterAttempt.stateVersion);
  const outcomeReceipt = createTestRepositoryOutcomeReceiptV02(flow.claim, flow.attempt, flow.context);
  assertOutcomeMatchesFlow(outcomeReceipt, flow.claim, flow.attempt, flow.context);
  const recorded = await flow.port.recordOutcome(outcomeReceipt);
  assert.equal(recorded.outcome, 'recorded-unsettled');
  assert.equal(recorded.receiptId, outcomeReceipt.receiptId);

  const reconciliation = createTestObservedReconciliationReceiptV02(outcomeReceipt);
  assertReconciliationMatchesPredecessor(reconciliation, outcomeReceipt);
  const beforeRecovery = await flow.port.loadTask(flow.context.taskId);
  const beforeLedgers = flow.port.getLedgers();
  const result = await flow.port.reconcileObservedOutcome(reconciliation);

  assert.equal(result.outcome, 'conflict');
  assert.equal(result.receiptId, reconciliation.reconciliationId);
  assert.deepEqual(await flow.port.loadTask(flow.context.taskId), beforeRecovery);
  assert.deepEqual(flow.port.getLedgers(), beforeLedgers, 'conflicting recovery leaves task accounting unchanged');
});

test('Positive vector: closeUnattemptedClaim closes a claimed task without beginning an attempt (RED in T041, GREEN in T042)', async () => {
  const flow = await claimRepositoryFlow();
  const executor = createTestExecutorIdentityV02({ payloadDigest: flow.context.actionDigest });
  const closureReceipt = createTestClaimClosureReceiptV02(flow.claim, executor);
  assert.equal('attemptId' in closureReceipt, false);
  const closureValidation = validateClaimClosureReceiptV02(closureReceipt, {
    expectedTaskId: flow.claim.taskId,
    expectedClaimId: flow.claim.claimId,
    claim: { ...flow.claim, hasCommittedAttempt: false },
    hasCommittedAttempt: false,
    expectedAdapterIdentity: executor.adapterIdentity,
    expectedMinFencingGeneration: executor.fencingGeneration,
    expectedFencedExecutorIdentity: executor,
  });
  assert.equal(closureValidation.ok, true, `claim closure receipt: ${JSON.stringify(closureValidation)}`);

  const result = await flow.port.closeUnattemptedClaim(closureReceipt);

  assert.equal(result.closed, true);
  assert.equal(result.receiptId, closureReceipt.receiptId);
});

test('Positive vector: reconcileUncertain consumes the exact recorded uncertain predecessor (RED in T041, GREEN in T042)', async () => {
  const flow = await beginRepositoryAttempt();
  const outcomeReceipt = createTestRepositoryOutcomeReceiptV02(flow.claim, flow.attempt, flow.context, { outcome: 'uncertain' });
  assertOutcomeMatchesFlow(outcomeReceipt, flow.claim, flow.attempt, flow.context);
  const recorded = await flow.port.recordOutcome(outcomeReceipt);
  assert.equal(recorded.outcome, 'uncertain');
  assert.equal(recorded.receiptId, outcomeReceipt.receiptId);

  const reconciliation = createTestUncertainReconciliationReceiptV02(outcomeReceipt, { disposition: 'observed-and-accounted' });
  assertReconciliationMatchesPredecessor(reconciliation, outcomeReceipt);
  const result = await flow.port.reconcileUncertain(reconciliation);

  assert.equal(result.outcome, 'settled');
  assert.equal(result.receiptId, reconciliation.reconciliationId);
});
