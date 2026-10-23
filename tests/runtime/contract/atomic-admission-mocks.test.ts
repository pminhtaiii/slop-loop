/**
 * UC-03 v0.2.0 Atomic Admission Mock Journal Tests (T041 / T042).
 *
 * T041 keeps the real test-only StatePortV02 methods neutral. Valid positive
 * flows therefore stop at the first neutral predecessor assertion until T042.
 * T042 implements the StatePortV02 journal mock and validates both positive
 * progressions and negative denial vectors with zero state/accounting changes.
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
  computeAttemptOutcomeDigest,
  computeReconciliationDigest,
  computeCanonicalSha256,
  type AdmissionContextV02,
  type AttemptOutcomeReceiptV02,
  type AttemptReconciliationReceiptV02,
  type AttemptReceiptV02,
  type ClaimReceiptV02,
  type ExecutorIdentityV02,
  type BudgetLedger,
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
  createTestDiagnosticPatchAdmissionContextV02,
  createTestAdmissionTransitionContextsV02,
  createTestAttemptReceiptV02,
  createTestAttemptOutcomeValidationContextV02,
  createTestClaimClosureReceiptV02,
  createTestClaimReceiptV02,
  createTestExecutorIdentityV02,
  createTestObservedReconciliationReceiptV02,
  createTestProviderAdmissionContextV02,
  createTestProviderRequest,
  createTestProviderAdmissionTrustedContextV02,
  createTestProviderOutcomeReceiptV02,
  createTestRepositoryAdmissionContextV02,
  createTestRepositoryCommandAdmissionContextV02,
  createTestRepositoryAdmissionTrustedContextV02,
  createTestRepositoryOutcomeReceiptV02,
  createTestReconciliationValidationContextV02,
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

function authorityFor(context: AdmissionContextV02) {
  if (context.subjectKind === 'repository-action') return context.policyAuthorityRef;
  return {
    policyId: context.providerIdentity.pricingPolicyId,
    policyVersion: context.providerIdentity.pricingPolicyVersion,
    configId: context.providerIdentity.configId,
    configVersion: context.providerIdentity.configVersion,
    issuerKeyRef: context.providerIdentity.issuerKeyRef,
    decisionAuthorityGeneration: context.providerIdentity.decisionAuthorityGeneration,
  };
}

function createPort(context: AdmissionContextV02, options?: { readonly neutral?: boolean; readonly initialTaskState?: TaskState }): MemoryStatePortV02 {
  const fixture = assertAdmissionFixture(context);
  return new MemoryStatePortV02({
    ...fixture,
    initialTaskState: options?.initialTaskState ?? fixture.initialTaskState,
    neutral: options?.neutral,
    initialControlVersion: context.expectedControlVersion,
    initialEpoch: context.expectedEpoch,
    initialAuthorityRef: authorityFor(context),
  });
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
  const isRepairPatch = context.subjectKind === 'repository-action' && context.action.kind === 'apply_patch' && context.planApplicability === 'approved-plan';
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

  const trusted = createTestAttemptOutcomeValidationContextV02(claim, attempt, context);
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
  claim: ClaimReceiptV02,
  attempt: AttemptReceiptV02,
  context: AdmissionContextV02,
): void {
  assertIdentity(receipt.reconciliationId, 'reconciliationId');
  assertDigest(receipt.reconciliationDigest, 'reconciliationDigest');
  assert.equal(receipt.predecessorReceiptId, predecessor.receiptId);
  assert.equal(receipt.predecessorReceiptDigest, predecessor.receiptDigest);
  assert.equal(receipt.claimId, predecessor.claimId);
  assert.equal(receipt.attemptId, predecessor.attemptId);
  assert.equal(receipt.subjectKind, predecessor.subjectKind);
  assert.equal(receipt.planApplicability, predecessor.planApplicability);
  const validation = validateAttemptReconciliationReceiptV02(
    receipt,
    createTestReconciliationValidationContextV02(receipt, predecessor, claim, attempt, context),
  );
  assert.equal(validation.ok, true, `reconciliation receipt: ${JSON.stringify(validation)}`);
}

async function claimRepositoryFlow(context = createTestRepositoryAdmissionContextV02()) {
  const port = createPort(context);
  const claim = await port.claim(context);
  assertClaimMatchesContext(claim, context);
  return { port, context, claim };
}

async function beginRepositoryAttempt(context = createTestRepositoryAdmissionContextV02()) {
  const flow = await claimRepositoryFlow(context);
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
  const port = createPort(context, { neutral: true });
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

  // Inject same-version semantic drift so canonical receipt validation still
  // uses the exact task version while the journal detects the conflict.
  flow.port.getUnderlying().internalSetTask({ ...afterAttempt, node: 'Repair' });
  const outcomeReceipt = createTestRepositoryOutcomeReceiptV02(flow.claim, flow.attempt, flow.context);
  assertOutcomeMatchesFlow(outcomeReceipt, flow.claim, flow.attempt, flow.context);
  const recorded = await flow.port.recordOutcome(outcomeReceipt);
  assert.equal(recorded.outcome, 'recorded-unsettled');
  assert.equal(recorded.receiptId, outcomeReceipt.receiptId);

  const reconciliation = createTestObservedReconciliationReceiptV02(outcomeReceipt, flow.claim, flow.attempt, flow.context);
  assertReconciliationMatchesPredecessor(reconciliation, outcomeReceipt, flow.claim, flow.attempt, flow.context);
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
  assert.equal(await flow.port.setTaskControl(flow.context.taskId, 'paused', 'pause-close-001'), true);
  const fence = await flow.port.fenceClaimRecipient(flow.claim.claimId, executor);
  assert.ok(fence);
  const closureReceipt = createTestClaimClosureReceiptV02(flow.claim, fence.fencedExecutorIdentity, { reason: fence.holdRef });
  assert.equal('attemptId' in closureReceipt, false);
  const closureValidation = validateClaimClosureReceiptV02(closureReceipt, {
    expectedTaskId: flow.claim.taskId,
    expectedClaimId: flow.claim.claimId,
    claim: { ...flow.claim, hasCommittedAttempt: false },
    hasCommittedAttempt: false,
    expectedAdapterIdentity: fence.fencedExecutorIdentity.adapterIdentity,
    expectedMinFencingGeneration: fence.fencingGeneration,
    expectedFencedExecutorIdentity: fence.fencedExecutorIdentity,
  });
  assert.equal(closureValidation.ok, true, `claim closure receipt: ${JSON.stringify(closureValidation)}`);

  const result = await flow.port.closeUnattemptedClaim(closureReceipt);

  assert.equal(result.closed, true);
  assert.equal(result.receiptId, closureReceipt.receiptId);
  const closedSnapshot = flow.port.getJournalSnapshot();
  assert.deepEqual(closedSnapshot.closures, [{ receiptId: closureReceipt.receiptId, claimId: flow.claim.claimId, receiptDigest: closureReceipt.receiptDigest }]);
  assert.equal(closedSnapshot.claims.find((item) => item.claimId === flow.claim.claimId)?.status, 'closed');
});

test('Positive vector: reconcileUncertain consumes trusted provider usage for the exact uncertain predecessor (RED in T041, GREEN in T042)', async () => {
  const flow = await beginProviderAttempt();
  const outcomeReceipt = createTestProviderOutcomeReceiptV02(flow.claim, flow.attempt, flow.context, { outcome: 'uncertain' });
  assertOutcomeMatchesFlow(outcomeReceipt, flow.claim, flow.attempt, flow.context);
  const recorded = await flow.port.recordOutcome(outcomeReceipt);
  assert.equal(recorded.outcome, 'uncertain');
  assert.equal(recorded.receiptId, outcomeReceipt.receiptId);

  const effectEvidenceRef = { reference: 'evidence-reconciled-effect', digest: computeCanonicalSha256('evidence-reconciled-effect') };
  const accountingEvidenceRefs = [{ reference: 'evidence-reconciled-accounting', digest: computeCanonicalSha256('evidence-reconciled-accounting') }];
  const observedUsage = { inputTokens: 100, outputTokens: 20, billableTokens: 120, costUsd: 0.003 };
  assert.equal(await flow.port.publishRecoveryEvidence({
    predecessorReceiptId: outcomeReceipt.receiptId,
    effectEvidenceRef,
    accountingEvidenceRefs,
    observedUsage,
  }), true);
  assert.equal(await flow.port.setTaskControl(flow.context.taskId, 'paused', 'pause-provider-recovery-positive-001'), true);
  assert.ok(await flow.port.fenceAttemptRecipient(flow.claim.claimId, flow.executor));
  const reconciliation = createTestUncertainReconciliationReceiptV02(outcomeReceipt, flow.claim, flow.attempt, flow.context, {
    disposition: 'observed-and-accounted',
    effectEvidenceRef,
    accountingEvidenceRefs,
    evidenceRefs: [effectEvidenceRef, ...accountingEvidenceRefs],
    observedUsage,
    expectedCurrentControlVersion: flow.port.getJournalSnapshot().controlVersion,
  });
  assertReconciliationMatchesPredecessor(reconciliation, outcomeReceipt, flow.claim, flow.attempt, flow.context);
  const result = await flow.port.reconcileUncertain(reconciliation);

  assert.equal(result.outcome, 'settled');
  assert.equal(result.receiptId, reconciliation.reconciliationId);
  const after = flow.port.getLedgers();
  for (const ledger of after.filter((item) => item.kind === 'tokens')) assert.equal(ledger.consumed, observedUsage.billableTokens);
  for (const ledger of after.filter((item) => item.kind === 'cost')) assert.equal(ledger.consumed, observedUsage.costUsd);
  assert.ok(after.every((ledger) => ledger.reservations.length === 0));
});

// ---------------------------------------------------------------------------
// Extended Acceptance Vectors (T042: CAS, Denial, Concurrency, and Ledgers)
// ---------------------------------------------------------------------------

test('Extended Acceptance: claim denies on stale expectedTaskStateVersion with zero state/accounting changes', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const beforeTask = await port.loadTask(context.taskId);
  const beforeLedgers = port.getLedgers();
  const beforeSnapshot = port.getJournalSnapshot();

  const staleContext = createTestRepositoryAdmissionContextV02({ expectedTaskStateVersion: 99 });
  const receipt = await port.claim(staleContext);
  assert.equal(isNeutralClaimReceiptV02(receipt), true);

  assert.deepEqual(await port.loadTask(context.taskId), beforeTask);
  assert.deepEqual(port.getLedgers(), beforeLedgers);
  assert.deepEqual(port.getJournalSnapshot(), beforeSnapshot);
});

test('Extended Acceptance: claim denies on stale expectedControlVersion with zero state/accounting changes', async () => {
  const baseContext = createTestRepositoryAdmissionContextV02();
  const port = createPort(baseContext);
  // Establish control version progression to 3
  const firstClaim = await port.claim(baseContext);
  assert.equal(firstClaim.postClaimControlVersion, baseContext.expectedControlVersion + 1);

  // Close through the held and fenced public journal path.
  const executor = createTestExecutorIdentityV02({ payloadDigest: baseContext.actionDigest });
  assert.equal(await port.setTaskControl(baseContext.taskId, 'paused', 'pause-stale-cas-001'), true);
  const fence = await port.fenceClaimRecipient(firstClaim.claimId, executor);
  assert.ok(fence);
  const closure = createTestClaimClosureReceiptV02(firstClaim, fence.fencedExecutorIdentity, { reason: fence.holdRef });
  assert.equal((await port.closeUnattemptedClaim(closure)).closed, true);
  assert.equal(await port.setTaskControl(baseContext.taskId, 'runnable', 'resume-stale-cas-001'), true);

  // The journal is runnable at a newer control version; the old expected version must still fail.
  const beforeTask = await port.loadTask(baseContext.taskId);
  const beforeLedgers = port.getLedgers();
  const beforeSnapshot = port.getJournalSnapshot();
  const staleContext = createTestRepositoryAdmissionContextV02({ expectedControlVersion: 2 });
  const staleReceipt = await port.claim(staleContext);
  assert.equal(isNeutralClaimReceiptV02(staleReceipt), true);
  assert.deepEqual(await port.loadTask(baseContext.taskId), beforeTask);
  assert.deepEqual(port.getLedgers(), beforeLedgers);
  assert.deepEqual(port.getJournalSnapshot(), beforeSnapshot);
});

test('Extended Acceptance: open claim blocks fresh claim with different ID', async () => {
  const context1 = createTestRepositoryAdmissionContextV02({ action: { actionId: 'act-001', kind: 'apply_patch', patchContent: 'x', targetPaths: ['src/calculator.py'], baseRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' } });
  const port = createPort(context1);
  const claim1 = await port.claim(context1);
  assert.equal(isNeutralClaimReceiptV02(claim1), false);

  const context2 = createTestRepositoryAdmissionContextV02({ action: { actionId: 'act-002', kind: 'apply_patch', patchContent: 'y', targetPaths: ['src/calculator.py'], baseRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' } });
  const beforeTask = await port.loadTask(context1.taskId);
  const beforeLedgers = port.getLedgers();
  const beforeSnapshot = port.getJournalSnapshot();
  const claim2 = await port.claim(context2);
  assert.equal(isNeutralClaimReceiptV02(claim2), true, 'Different claim while one is open must deny');
  assert.deepEqual(await port.loadTask(context1.taskId), beforeTask);
  assert.deepEqual(port.getLedgers(), beforeLedgers);
  assert.deepEqual(port.getJournalSnapshot(), beforeSnapshot);
});

test('Extended Acceptance: idempotent claim retry with identical context returns the existing claim receipt', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const claim1 = await port.claim(context);
  assert.equal(isNeutralClaimReceiptV02(claim1), false);

  const claim2 = await port.claim(context);
  assert.deepEqual(claim2, claim1, 'Idempotent retry returns identical receipt');
});

test('Extended Acceptance: beginAttempt denies for unknown claimId with neutral attempt receipt', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const executor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });

  const attempt = await port.beginAttempt('non-existent-claim', executor);
  assert.equal(isNeutralAttemptReceiptV02(attempt), true);
});

test('Extended Acceptance: beginAttempt denies for executor payloadDigest mismatch', async () => {
  const flow = await claimRepositoryFlow();
  const badExecutor = createTestExecutorIdentityV02({ payloadDigest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' });

  const attempt = await flow.port.beginAttempt(flow.claim.claimId, badExecutor);
  assert.equal(isNeutralAttemptReceiptV02(attempt), true);
});

test('Extended Acceptance: beginAttempt denies for unfenced executor below minimum generation', async () => {
  const flow = await claimRepositoryFlow();
  const recipient = createTestExecutorIdentityV02({ payloadDigest: flow.context.actionDigest, fencingGeneration: 2 });
  assert.equal(await flow.port.setTaskControl(flow.context.taskId, 'paused', 'pause-generation-fence-001'), true);
  const fence = await flow.port.fenceClaimRecipient(flow.claim.claimId, recipient);
  assert.ok(fence);
  const closure = createTestClaimClosureReceiptV02(flow.claim, fence.fencedExecutorIdentity, { reason: fence.holdRef });
  assert.equal((await flow.port.closeUnattemptedClaim(closure)).closed, true);
  assert.equal(await flow.port.setTaskControl(flow.context.taskId, 'runnable', 'resume-generation-fence-001'), true);
  const task = await flow.port.loadTask(flow.context.taskId);
  assert.ok(task);

  // A closed claim released its reserved slot; a fresh action can claim it.
  const context2 = createTestRepositoryAdmissionContextV02({
    action: { ...flow.context.action, actionId: 'act-patch-after-fence-001' },
    expectedTaskStateVersion: task.stateVersion,
    expectedControlVersion: flow.port.getJournalSnapshot().controlVersion,
  });
  const claim2 = await flow.port.claim(context2);
  assert.equal(isNeutralClaimReceiptV02(claim2), false);

  const beforeTask = await flow.port.loadTask(context2.taskId);
  const beforeLedgers = flow.port.getLedgers();
  const beforeSnapshot = flow.port.getJournalSnapshot();
  const oldIncarnation = await flow.port.beginAttempt(claim2.claimId, {
    ...fence.fencedExecutorIdentity,
    payloadDigest: context2.actionDigest,
  });
  assert.equal(isNeutralAttemptReceiptV02(oldIncarnation), true, 'Fenced incarnation cannot reuse its new generation');
  const lowerGeneration = await flow.port.beginAttempt(claim2.claimId, {
    ...fence.fencedExecutorIdentity,
    processIncarnation: 'proc-fresh-001',
    fencingGeneration: fence.fencingGeneration - 1,
    payloadDigest: context2.actionDigest,
  });
  assert.equal(isNeutralAttemptReceiptV02(lowerGeneration), true, 'Fresh incarnation below the fence generation must deny');
  assert.deepEqual(await flow.port.loadTask(context2.taskId), beforeTask);
  assert.deepEqual(flow.port.getLedgers(), beforeLedgers);
  assert.deepEqual(flow.port.getJournalSnapshot(), beforeSnapshot);

  const currentRecipient = await flow.port.beginAttempt(claim2.claimId, {
    ...fence.fencedExecutorIdentity,
    processIncarnation: 'proc-fresh-001',
    payloadDigest: context2.actionDigest,
  });
  assert.equal(isNeutralAttemptReceiptV02(currentRecipient), false, 'New incarnation at the current fence generation can begin');
});

test('Extended Acceptance: beginAttempt consumes exactly one repair allowance on repair patch', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const beforeLedgers = port.getLedgers();
  const beforeRepair = beforeLedgers.find((l) => l.scope === 'task' && l.kind === 'repair');
  assert.ok(beforeRepair);
  const initialConsumed = beforeRepair.consumed;

  const claim = await port.claim(context);
  const executor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await port.beginAttempt(claim.claimId, executor);
  assert.equal(isNeutralAttemptReceiptV02(attempt), false);

  const afterLedgers = port.getLedgers();
  const afterRepair = afterLedgers.find((l) => l.scope === 'task' && l.kind === 'repair');
  assert.ok(afterRepair);
  assert.equal(afterRepair.consumed, initialConsumed + 1, 'Exactly one repair allowance consumed at beginAttempt');
});

test('Extended Acceptance: closeUnattemptedClaim denies when an attempt has already begun', async () => {
  const flow = await beginRepositoryAttempt();
  const closure = createTestClaimClosureReceiptV02(flow.claim, flow.executor);
  const result = await flow.port.closeUnattemptedClaim(closure);

  assert.equal(result.closed, false, 'Cannot close claim as unattempted once attempt has begun');
});

test('Extended Acceptance: reconcileUncertain denies when predecessor is not uncertain', async () => {
  const flow = await beginRepositoryAttempt();
  const observedReceipt = createTestRepositoryOutcomeReceiptV02(flow.claim, flow.attempt, flow.context, { outcome: 'observed' });
  await flow.port.recordOutcome(observedReceipt);

  const fakeUncertainPredecessor = createTestRepositoryOutcomeReceiptV02(flow.claim, flow.attempt, flow.context, { outcome: 'uncertain' });
  const reconciliation = createTestUncertainReconciliationReceiptV02(
    fakeUncertainPredecessor,
    flow.claim,
    flow.attempt,
    flow.context
  );
  const result = await flow.port.reconcileUncertain(reconciliation);
  assert.equal(result.outcome, 'conflict', 'reconcileUncertain requires recorded uncertain predecessor');
});

test('Extended Acceptance: replay of reconcileUncertain returns original settled result', async () => {
  const flow = await beginProviderAttempt();
  const outcomeReceipt = createTestProviderOutcomeReceiptV02(flow.claim, flow.attempt, flow.context, { outcome: 'uncertain' });
  await flow.port.recordOutcome(outcomeReceipt);

  const effectEvidenceRef = { reference: 'evidence-reconciled-effect', digest: computeCanonicalSha256('evidence-reconciled-effect') };
  const accountingEvidenceRefs = [{ reference: 'evidence-reconciled-accounting', digest: computeCanonicalSha256('evidence-reconciled-accounting') }];
  const observedUsage = { inputTokens: 100, outputTokens: 20, billableTokens: 120, costUsd: 0.003 };
  assert.equal(await flow.port.publishRecoveryEvidence({ predecessorReceiptId: outcomeReceipt.receiptId, effectEvidenceRef, accountingEvidenceRefs, observedUsage }), true);
  assert.equal(await flow.port.setTaskControl(flow.context.taskId, 'paused', 'pause-provider-recovery-replay-001'), true);
  assert.ok(await flow.port.fenceAttemptRecipient(flow.claim.claimId, flow.executor));
  const reconciliation = createTestUncertainReconciliationReceiptV02(outcomeReceipt, flow.claim, flow.attempt, flow.context, {
    disposition: 'observed-and-accounted',
    effectEvidenceRef,
    accountingEvidenceRefs,
    evidenceRefs: [effectEvidenceRef, ...accountingEvidenceRefs],
    observedUsage,
    expectedCurrentControlVersion: flow.port.getJournalSnapshot().controlVersion,
  });
  const res1 = await flow.port.reconcileUncertain(reconciliation);
  assert.equal(res1.outcome, 'settled');
  const afterLedgers = flow.port.getLedgers();
  const afterTask = await flow.port.loadTask(flow.context.taskId);
  const afterSnapshot = flow.port.getJournalSnapshot();

  const res2 = await flow.port.reconcileUncertain(reconciliation);
  assert.equal(res2.outcome, 'settled', 'Replay of reconcileUncertain returns settled without duplication');
  assert.deepEqual(flow.port.getLedgers(), afterLedgers);
  assert.deepEqual(await flow.port.loadTask(flow.context.taskId), afterTask);
  assert.deepEqual(flow.port.getJournalSnapshot(), afterSnapshot);
});

test('Extended Acceptance: reconcileUncertain with proven-not-dispatched records fenced actor', async () => {
  const flow = await beginRepositoryAttempt();
  const outcomeReceipt = createTestRepositoryOutcomeReceiptV02(flow.claim, flow.attempt, flow.context, { outcome: 'uncertain' });
  await flow.port.recordOutcome(outcomeReceipt);

  assert.equal(await flow.port.setTaskControl(flow.context.taskId, 'paused', 'pause-nondispatch-001'), true);
  const fence = await flow.port.fenceAttemptRecipient(flow.claim.claimId, flow.executor);
  assert.ok(fence);

  const reconciliation = createTestUncertainReconciliationReceiptV02(
    outcomeReceipt,
    flow.claim,
    flow.attempt,
    flow.context,
    {
      disposition: 'proven-not-dispatched',
      adapterEvidenceRefs: fence.adapterEvidenceRefs,
      fencedRecipientIdentity: fence.recipientIdentity,
      fencingGeneration: fence.fencingGeneration,
      fencingProof: fence.proofRef,
      evidenceRefs: [...fence.adapterEvidenceRefs, fence.proofRef],
      expectedCurrentControlVersion: flow.port.getJournalSnapshot().controlVersion,
    }
  );
  const result = await flow.port.reconcileUncertain(reconciliation);
  assert.equal(result.outcome, 'settled');
  const repair = flow.port.getLedgers().find((ledger) => ledger.scope === 'task' && ledger.kind === 'repair');
  assert.ok(repair);
  assert.equal(repair.consumed, 1, 'proven non-dispatch after begin does not refund the consumed repair slot');
  assert.equal(repair.reservations.length, 0);
});

test('Extended Acceptance: reconcileObservedOutcome settles when task state and revision match eligible predecessor', async () => {
  const flow = await beginRepositoryAttempt();
  const afterAttempt = await flow.port.loadTask(flow.context.taskId);
  assert.ok(afterAttempt);
  assert.equal(afterAttempt.node, 'Patch');

  // Inject same-version semantic drift to force recorded-unsettled.
  flow.port.getUnderlying().internalSetTask({ ...afterAttempt, node: 'Repair' });
  const outcomeReceipt = createTestRepositoryOutcomeReceiptV02(flow.claim, flow.attempt, flow.context);
  const recorded = await flow.port.recordOutcome(outcomeReceipt);
  assert.equal(recorded.outcome, 'recorded-unsettled');

  // Restore the Patch state and independently observed result revision.
  assert.equal(outcomeReceipt.subjectKind, 'repository-action');
  if (outcomeReceipt.subjectKind !== 'repository-action' || !outcomeReceipt.observedResultRevisionDigest) assert.fail('patch outcome must carry its observed revision');
  flow.port.getUnderlying().internalSetTask({
    ...afterAttempt,
    repositoryRevisionDigest: outcomeReceipt.observedResultRevisionDigest,
  });
  const current = await flow.port.loadTask(flow.context.taskId);
  assert.ok(current);
  const reconciliation = createTestObservedReconciliationReceiptV02(outcomeReceipt, flow.claim, flow.attempt, flow.context, {
    expectedCurrentTaskStateVersion: current.stateVersion,
    expectedCurrentControlVersion: flow.port.getJournalSnapshot().controlVersion,
  });
  const result = await flow.port.reconcileObservedOutcome(reconciliation);
  assert.equal(result.outcome, 'settled');

  const finalTask = await flow.port.loadTask(flow.context.taskId);
  assert.ok(finalTask);
  assert.equal(finalTask.node, 'Verify', 'Task transitioned to Verify upon successful recovery settlement');
});

test('Journal regressions: claim reserves exact provider task/run ledgers before beginAttempt', async () => {
  const context = createTestProviderAdmissionContextV02();
  const port = createPort(context);
  const before = port.getLedgers();
  const beforeSnapshot = port.getJournalSnapshot();

  const claim = await port.claim(context);

  assert.equal(isNeutralClaimReceiptV02(claim), false);
  const reservations = port.getLedgers().flatMap((ledger) => ledger.reservations.map((reservation) => ({
    scope: ledger.scope,
    kind: ledger.kind,
    ...reservation,
  })));
  assert.deepEqual(
    reservations.map(({ scope, kind }) => `${scope}:${kind}`).sort(),
    ['run:cost', 'run:tokens', 'task:cost', 'task:tokens'],
  );
  assert.deepEqual(reservations.map((reservation) => reservation.reservationId).sort(), [...context.budgetRefs].sort());
  assert.deepEqual(
    Object.fromEntries(reservations.map((reservation) => [`${reservation.scope}:${reservation.kind}`, reservation.reservationId])),
    {
      'task:tokens': context.budgetRefs[0], 'task:cost': context.budgetRefs[1],
      'run:tokens': context.budgetRefs[2], 'run:cost': context.budgetRefs[3],
    },
    'each exact finite provider ref is reserved on its specified task/run ledger',
  );
  assert.ok(port.getLedgers().every((ledger, index) => ledger.version === (before[index]?.version ?? 0) + (ledger.kind === 'tokens' || ledger.kind === 'cost' ? 1 : 0)));
  assert.equal(port.getJournalSnapshot().controlVersion, beforeSnapshot.controlVersion + 1);
});

test('Journal regressions: concurrent begins admit one repair attempt and consume its reserved slot once', async () => {
  const flow = await claimRepositoryFlow();
  const before = flow.port.getLedgers();
  const results = await Promise.all([
    flow.port.beginAttempt(flow.claim.claimId, createTestExecutorIdentityV02({ payloadDigest: flow.context.actionDigest })),
    flow.port.beginAttempt(flow.claim.claimId, createTestExecutorIdentityV02({ payloadDigest: flow.context.actionDigest })),
  ]);

  assert.equal(results.filter((result) => !isNeutralAttemptReceiptV02(result)).length, 1);
  const afterTask = await flow.port.loadTask(flow.context.taskId);
  assert.ok(afterTask);
  assert.equal(afterTask.node, 'Patch');
  assert.equal(afterTask.stateVersion, flow.context.expectedTaskStateVersion + 1);
  const repairBefore = before.find((ledger) => ledger.scope === 'task' && ledger.kind === 'repair');
  const repairAfter = flow.port.getLedgers().find((ledger) => ledger.scope === 'task' && ledger.kind === 'repair');
  assert.ok(repairBefore && repairAfter);
  assert.equal(repairAfter.consumed, repairBefore.consumed + 1);
  assert.equal(repairAfter.reservations.length, 0);
});

test('Journal regressions: missing or partial resource ledgers deny claim without partial reservation', async () => {
  const repairContext = createTestRepositoryAdmissionContextV02();
  const repairState = createTestAdmissionTaskStateV02(repairContext);
  const missingRepairState: TaskState = {
    ...repairState,
    budgetLedgers: repairState.budgetLedgers?.filter((ledger) => ledger.kind !== 'repair'),
  };
  const repairPort = createPort(repairContext, { initialTaskState: missingRepairState });
  const repairBefore = repairPort.getLedgers();
  const repairSnapshot = repairPort.getJournalSnapshot();
  const repairClaim = await repairPort.claim(repairContext);
  assert.equal(isNeutralClaimReceiptV02(repairClaim), true);
  assert.deepEqual(repairPort.getLedgers(), repairBefore);
  assert.deepEqual(repairPort.getJournalSnapshot(), repairSnapshot);
  assert.equal((await repairPort.loadTask(repairContext.taskId))?.node, repairState.node);

  const providerContext = createTestProviderAdmissionContextV02();
  const providerState = createTestAdmissionTaskStateV02(providerContext);
  const partialProviderState: TaskState = {
    ...providerState,
    budgetLedgers: providerState.budgetLedgers?.filter((ledger) => !(ledger.scope === 'run' && ledger.kind === 'cost')),
  };
  const providerPort = createPort(providerContext, { initialTaskState: partialProviderState });
  const providerBefore = providerPort.getLedgers();
  const providerSnapshot = providerPort.getJournalSnapshot();
  const providerClaim = await providerPort.claim(providerContext);
  assert.equal(isNeutralClaimReceiptV02(providerClaim), true);
  assert.deepEqual(providerPort.getLedgers(), providerBefore);
  assert.deepEqual(providerPort.getJournalSnapshot(), providerSnapshot);
  assert.equal((await providerPort.loadTask(providerContext.taskId))?.stateVersion, providerState.stateVersion);
});

test('Journal regressions: malformed admission digest is refused with no task or ledger mutation', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const beforeTask = await port.loadTask(context.taskId);
  const beforeLedgers = port.getLedgers();
  const beforeSnapshot = port.getJournalSnapshot();

  const invalid = { ...context, actionDigest: `sha256:${'f'.repeat(64)}` };
  const claim = await port.claim(invalid);

  assert.equal(isNeutralClaimReceiptV02(claim), true);
  assert.deepEqual(await port.loadTask(context.taskId), beforeTask);
  assert.deepEqual(port.getLedgers(), beforeLedgers);
  assert.deepEqual(port.getJournalSnapshot(), beforeSnapshot);
});

test('Journal regressions: diagnostic test patch does not reserve or consume repair allowance', async () => {
  const context = createTestDiagnosticPatchAdmissionContextV02();
  const port = createPort(context);
  const before = port.getLedgers().find((ledger) => ledger.scope === 'task' && ledger.kind === 'repair');
  assert.ok(before);

  const claim = await port.claim(context);
  assert.equal(isNeutralClaimReceiptV02(claim), false);
  assert.deepEqual(claim.reservationRefs, context.reservationRefs);
  const executor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await port.beginAttempt(claim.claimId, executor);
  assert.equal(isNeutralAttemptReceiptV02(attempt), false);
  assert.equal(attempt.postBeginTaskStateVersion, attempt.preAttemptTaskStateVersion);

  const after = port.getLedgers().find((ledger) => ledger.scope === 'task' && ledger.kind === 'repair');
  assert.ok(after);
  assert.deepEqual(after, before);
  assert.equal((await port.loadTask(context.taskId))?.node, 'Investigate');
});

test('Journal R3: observed diagnostic patch settles revision and exact invalidation without repair charges', async () => {
  const context = createTestDiagnosticPatchAdmissionContextV02();
  const initial = createTestAdmissionTaskStateV02(context);
  const task: TaskState = {
    ...initial,
    evidenceRefs: ['baseline-admission-v02', 'evidence-prior-baseline', 'evidence-retained-diagnostic-r3'],
  };
  const port = createPort(context, { initialTaskState: task });
  const beforeLedgers = port.getLedgers();
  const claim = await port.claim(context);
  assert.equal(isNeutralClaimReceiptV02(claim), false);
  assert.equal(claim.planApplicability, 'pre-plan-diagnostic');
  assert.deepEqual(claim.reservationRefs, context.reservationRefs);

  const executor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await port.beginAttempt(claim.claimId, executor);
  assert.equal(isNeutralAttemptReceiptV02(attempt), false);
  assert.equal(attempt.postBeginTaskStateVersion, attempt.preAttemptTaskStateVersion);
  const outcome = createTestRepositoryOutcomeReceiptV02(claim, attempt, context);
  assert.deepEqual(outcome.proposedEffects.taskTransition, { kind: 'none' });

  const result = await port.recordOutcome(outcome);
  assert.deepEqual(result, { outcome: 'settled', receiptId: outcome.receiptId });
  const settledTask = await port.loadTask(context.taskId);
  assert.ok(settledTask);
  assert.equal(settledTask.node, 'Investigate');
  assert.equal(settledTask.stateVersion, attempt.postBeginTaskStateVersion + 1);
  assert.equal(settledTask.repositoryRevisionDigest, outcome.observedResultRevisionDigest);
  assert.deepEqual(settledTask.evidenceRefs, ['baseline-admission-v02', 'evidence-retained-diagnostic-r3']);
  assert.equal(settledTask.plan, undefined);
  assert.equal(context.planBindingDigest, undefined);
  assert.equal(context.planDecisionRef, undefined);
  assert.deepEqual(port.getLedgers(), beforeLedgers);
  const settledSnapshot = port.getJournalSnapshot();
  assert.equal(settledSnapshot.claims.find((row) => row.claimId === claim.claimId)?.status, 'settled');
  assert.ok(settledSnapshot.outcomes.some((row) => row.receiptId === outcome.receiptId));

  assert.deepEqual(await port.recordOutcome(outcome), { outcome: 'already-recorded', receiptId: outcome.receiptId });
  assert.deepEqual(await port.loadTask(context.taskId), settledTask);
  assert.deepEqual(port.getLedgers(), beforeLedgers);
  assert.deepEqual(port.getJournalSnapshot(), settledSnapshot);
});

test('Journal R3: uncertain diagnostic patch requires its exact predecessor, evidence, and fence', async () => {
  const context = createTestDiagnosticPatchAdmissionContextV02();
  const initial = createTestAdmissionTaskStateV02(context);
  const task: TaskState = {
    ...initial,
    evidenceRefs: ['baseline-admission-v02', 'evidence-prior-diagnostic-r3', 'evidence-retained-diagnostic-r3'],
  };
  const port = createPort(context, { initialTaskState: task });
  const beforeLedgers = port.getLedgers();
  const claim = await port.claim(context);
  const executor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await port.beginAttempt(claim.claimId, executor);
  assert.equal(attempt.postBeginTaskStateVersion, attempt.preAttemptTaskStateVersion);
  const uncertain = createTestRepositoryOutcomeReceiptV02(claim, attempt, context, { outcome: 'uncertain' });
  const beforeOutcomeTask = await port.loadTask(context.taskId);
  assert.deepEqual(await port.recordOutcome(uncertain), { outcome: 'uncertain', receiptId: uncertain.receiptId });

  const retainedTask = await port.loadTask(context.taskId);
  const retainedSnapshot = port.getJournalSnapshot();
  assert.deepEqual(retainedTask, beforeOutcomeTask);
  assert.equal(retainedSnapshot.claims.find((row) => row.claimId === claim.claimId)?.status, 'uncertain');
  assert.ok(retainedSnapshot.outcomes.some((row) => row.receiptId === uncertain.receiptId));
  assert.deepEqual(port.getLedgers(), beforeLedgers);

  const invalidatedEvidence = [{ reference: 'evidence-prior-diagnostic-r3', digest: computeCanonicalSha256('evidence-prior-diagnostic-r3') }];
  const accountingEvidenceRefs = [{ reference: 'evidence-accounted-diagnostic-r3', digest: computeCanonicalSha256('evidence-accounted-diagnostic-r3') }];
  const observedRevisionDigest = computeCanonicalSha256('observed-diagnostic-revision-r3');
  const effectEvidenceRef = {
    reference: 'evidence-observed-diagnostic-r3',
    digest: computeCanonicalSha256({
      schemaVersion: 'uc03-observed-patch-recovery/0.2-draft',
      predecessorReceiptId: uncertain.receiptId,
      observedRevisionDigest,
      invalidatedEvidence,
      accountingEvidenceRefs,
    }),
  };
  const evidenceRefs = [effectEvidenceRef, ...accountingEvidenceRefs];
  const wrongPredecessor = createTestUncertainReconciliationReceiptV02(uncertain, claim, attempt, context, {
    reconciliationId: 'recon-diagnostic-wrong-predecessor-r3',
    predecessorReceiptId: 'foreign-diagnostic-predecessor-r3',
    disposition: 'observed-and-accounted', effectEvidenceRef, accountingEvidenceRefs, evidenceRefs,
    expectedCurrentControlVersion: retainedSnapshot.controlVersion,
  });
  assert.equal((await port.reconcileUncertain(wrongPredecessor)).outcome, 'conflict');
  assert.deepEqual(await port.loadTask(context.taskId), retainedTask);
  assert.deepEqual(port.getLedgers(), beforeLedgers);
  assert.deepEqual(port.getJournalSnapshot(), retainedSnapshot);

  const missingEvidence = createTestUncertainReconciliationReceiptV02(uncertain, claim, attempt, context, {
    reconciliationId: 'recon-diagnostic-missing-evidence-r3',
    disposition: 'observed-and-accounted', effectEvidenceRef, accountingEvidenceRefs, evidenceRefs,
    expectedCurrentControlVersion: retainedSnapshot.controlVersion,
  });
  assert.equal((await port.reconcileUncertain(missingEvidence)).outcome, 'conflict');
  assert.equal(await port.publishRecoveryEvidence({ predecessorReceiptId: uncertain.receiptId, effectEvidenceRef, accountingEvidenceRefs }), false);
  assert.deepEqual(port.getJournalSnapshot(), retainedSnapshot);

  const recoveryEvidence = {
    predecessorReceiptId: uncertain.receiptId,
    effectEvidenceRef,
    accountingEvidenceRefs,
    observedRevisionDigest,
    invalidatedEvidence,
  };
  assert.equal(await port.publishRecoveryEvidence(recoveryEvidence), true);
  const evidenceSnapshot = port.getJournalSnapshot();
  const unfenced = createTestUncertainReconciliationReceiptV02(uncertain, claim, attempt, context, {
    reconciliationId: 'recon-diagnostic-unfenced-r3',
    disposition: 'observed-and-accounted', effectEvidenceRef, accountingEvidenceRefs, evidenceRefs,
    expectedCurrentControlVersion: evidenceSnapshot.controlVersion,
  });
  assert.equal((await port.reconcileUncertain(unfenced)).outcome, 'conflict');
  assert.deepEqual(await port.loadTask(context.taskId), retainedTask);
  assert.deepEqual(port.getLedgers(), beforeLedgers);
  assert.deepEqual(port.getJournalSnapshot(), evidenceSnapshot);

  assert.equal(await port.setTaskControl(context.taskId, 'paused', 'pause-diagnostic-recovery-r3'), true);
  assert.ok(await port.fenceAttemptRecipient(claim.claimId, executor));
  const recovery = createTestUncertainReconciliationReceiptV02(uncertain, claim, attempt, context, {
    reconciliationId: 'recon-diagnostic-fenced-r3',
    disposition: 'observed-and-accounted', effectEvidenceRef, accountingEvidenceRefs, evidenceRefs,
    expectedCurrentTaskStateVersion: attempt.postBeginTaskStateVersion,
    expectedCurrentControlVersion: port.getJournalSnapshot().controlVersion,
  });
  const settled = await port.reconcileUncertain(recovery);
  assert.deepEqual(settled, { outcome: 'settled', receiptId: recovery.reconciliationId });
  const settledTask = await port.loadTask(context.taskId);
  assert.ok(settledTask);
  assert.equal(settledTask.node, 'Investigate');
  assert.equal(settledTask.stateVersion, attempt.postBeginTaskStateVersion + 1);
  assert.equal(settledTask.repositoryRevisionDigest, observedRevisionDigest);
  assert.deepEqual(settledTask.evidenceRefs, ['baseline-admission-v02', 'evidence-retained-diagnostic-r3']);
  assert.deepEqual(port.getLedgers(), beforeLedgers);
  const settledSnapshot = port.getJournalSnapshot();
  assert.equal(settledSnapshot.mode, 'paused');
  assert.equal(settledSnapshot.claims.find((row) => row.claimId === claim.claimId)?.status, 'settled');

  assert.deepEqual(await port.recordOutcome(uncertain), { outcome: 'already-recorded', receiptId: uncertain.receiptId });
  assert.deepEqual(await port.reconcileUncertain(recovery), { outcome: 'settled', receiptId: recovery.reconciliationId });
  assert.deepEqual(await port.loadTask(context.taskId), settledTask);
  assert.deepEqual(port.getLedgers(), beforeLedgers);
  assert.deepEqual(port.getJournalSnapshot(), settledSnapshot);
});

test('Journal regressions: a provider outcome settles one attempt once and exact replay is status-only', async () => {
  const flow = await beginProviderAttempt();
  const outcome = createTestProviderOutcomeReceiptV02(flow.claim, flow.attempt, flow.context);
  assert.ok(outcome.observedUsage);
  const first = await flow.port.recordOutcome(outcome);
  assert.deepEqual(first, { outcome: 'settled', receiptId: outcome.receiptId });
  const afterFirst = flow.port.getLedgers();
  const afterFirstTask = await flow.port.loadTask(flow.context.taskId);
  const afterFirstSnapshot = flow.port.getJournalSnapshot();
  const settledProviderLedgers = afterFirst.filter((ledger) => ledger.kind === 'tokens' || ledger.kind === 'cost');
  assert.equal(settledProviderLedgers.length, 4);
  for (const ledger of settledProviderLedgers) {
    assert.equal(ledger.consumed, ledger.kind === 'cost' ? outcome.observedUsage.costUsd : outcome.observedUsage.billableTokens);
    assert.equal(ledger.reservations.length, 0);
  }
  assert.equal(afterFirst.find((ledger) => ledger.scope === 'task' && ledger.kind === 'repair')?.consumed, 0);
  assert.deepEqual(afterFirstSnapshot.outcomes, [{
    receiptId: outcome.receiptId,
    claimId: flow.claim.claimId,
    attemptId: flow.attempt.attemptId,
    outcome: 'observed',
    receiptDigest: outcome.receiptDigest,
  }]);
  assert.equal(afterFirstSnapshot.attempts.find((item) => item.attemptId === flow.attempt.attemptId)?.status, 'settled');

  const replay = await flow.port.recordOutcome(outcome);
  assert.deepEqual(replay, { outcome: 'already-recorded', receiptId: outcome.receiptId });
  assert.deepEqual(flow.port.getLedgers(), afterFirst);
  assert.deepEqual(await flow.port.loadTask(flow.context.taskId), afterFirstTask);
  assert.deepEqual(flow.port.getJournalSnapshot(), afterFirstSnapshot);

  const alteredSameId = {
    ...outcome,
    evidenceRefs: [{ reference: 'different-outcome-evidence', digest: computeCanonicalSha256('different-outcome-evidence') }],
    receiptDigest: '',
  } as unknown as Record<string, unknown>;
  alteredSameId['receiptDigest'] = computeAttemptOutcomeDigest(alteredSameId);
  assert.equal(isNeutralOutcomeRecordResultV02(await flow.port.recordOutcome(alteredSameId as unknown as AttemptOutcomeReceiptV02)), true);
  assert.deepEqual(flow.port.getLedgers(), afterFirst);
  assert.deepEqual(await flow.port.loadTask(flow.context.taskId), afterFirstTask);
  assert.deepEqual(flow.port.getJournalSnapshot(), afterFirstSnapshot);

  const conflicting = createTestProviderOutcomeReceiptV02(flow.claim, flow.attempt, flow.context, { receiptId: 'prov-out-conflict' });
  const denied = await flow.port.recordOutcome(conflicting);
  assert.equal(isNeutralOutcomeRecordResultV02(denied), true);
  assert.deepEqual(flow.port.getLedgers(), afterFirst);
  assert.deepEqual(await flow.port.loadTask(flow.context.taskId), afterFirstTask);
  assert.deepEqual(flow.port.getJournalSnapshot(), afterFirstSnapshot);
});

test('Journal regressions: outcome subject mismatch and invalid successor deny without settlement', async () => {
  const flow = await beginRepositoryAttempt();
  const valid = createTestRepositoryOutcomeReceiptV02(flow.claim, flow.attempt, flow.context);
  const beforeSnapshot = flow.port.getJournalSnapshot();
  const foreign = {
    ...valid,
    actionDigest: `sha256:${'e'.repeat(64)}`,
    receiptDigest: '',
  } as unknown as Record<string, unknown>;
  foreign['receiptDigest'] = computeAttemptOutcomeDigest(foreign);
  const foreignResult = await flow.port.recordOutcome(foreign as unknown as AttemptOutcomeReceiptV02);
  assert.equal(isNeutralOutcomeRecordResultV02(foreignResult), true);
  assert.equal((await flow.port.loadTask(flow.context.taskId))?.node, 'Patch');

  const invalidEffects = structuredClone(valid.proposedEffects);
  if (invalidEffects.taskTransition.kind !== 'transition') assert.fail('patch fixture must propose its authorized transition');
  const invalid = {
    ...valid,
    proposedEffects: {
      ...invalidEffects,
      taskTransition: { ...invalidEffects.taskTransition, toNode: 'Complete' },
    },
    receiptDigest: '',
  } as unknown as Record<string, unknown>;
  invalid['receiptDigest'] = computeAttemptOutcomeDigest(invalid);
  const beforeLedgers = flow.port.getLedgers();
  const beforeTask = await flow.port.loadTask(flow.context.taskId);
  const badDigest = { ...valid, receiptDigest: `sha256:${'0'.repeat(64)}` };
  assert.equal(isNeutralOutcomeRecordResultV02(await flow.port.recordOutcome(badDigest)), true);
  const invalidResult = await flow.port.recordOutcome(invalid as unknown as AttemptOutcomeReceiptV02);
  assert.equal(isNeutralOutcomeRecordResultV02(invalidResult), true);
  assert.deepEqual(await flow.port.loadTask(flow.context.taskId), beforeTask);
  assert.deepEqual(flow.port.getLedgers(), beforeLedgers);
  assert.deepEqual(flow.port.getJournalSnapshot(), beforeSnapshot);
});

test('Journal regressions: reconciliation binds the exact predecessor and refuses conflicting ID replay', async () => {
  const flow = await beginProviderAttempt();
  const outcome = createTestProviderOutcomeReceiptV02(flow.claim, flow.attempt, flow.context, { outcome: 'uncertain' });
  assert.deepEqual(await flow.port.recordOutcome(outcome), { outcome: 'uncertain', receiptId: outcome.receiptId });
  const uncertainLedgers = flow.port.getLedgers().filter((ledger) => ledger.kind === 'tokens' || ledger.kind === 'cost');
  assert.equal(uncertainLedgers.length, 4);
  assert.ok(uncertainLedgers.every((ledger) => ledger.consumed === 0 && ledger.reservations.length === 1));
  const effectEvidenceRef = { reference: 'evidence-reconciled-effect', digest: computeCanonicalSha256('evidence-reconciled-effect') };
  const accountingEvidenceRefs = [{ reference: 'evidence-reconciled-accounting', digest: computeCanonicalSha256('evidence-reconciled-accounting') }];
  const observedUsage = { inputTokens: 100, outputTokens: 20, billableTokens: 120, costUsd: 0.003 };
  await flow.port.publishRecoveryEvidence({ predecessorReceiptId: outcome.receiptId, effectEvidenceRef, accountingEvidenceRefs, observedUsage });
  assert.equal(await flow.port.setTaskControl(flow.context.taskId, 'paused', 'pause-provider-recovery-idempotency-001'), true);
  assert.ok(await flow.port.fenceAttemptRecipient(flow.claim.claimId, flow.executor));
  const reconciliation = createTestUncertainReconciliationReceiptV02(outcome, flow.claim, flow.attempt, flow.context, {
    disposition: 'observed-and-accounted', effectEvidenceRef, accountingEvidenceRefs,
    evidenceRefs: [effectEvidenceRef, ...accountingEvidenceRefs], observedUsage,
    expectedCurrentControlVersion: flow.port.getJournalSnapshot().controlVersion,
  });
  const first = await flow.port.reconcileUncertain(reconciliation);
  assert.equal(first.outcome, 'settled');
  const afterFirst = flow.port.getLedgers();
  const afterFirstTask = await flow.port.loadTask(flow.context.taskId);
  const afterFirstSnapshot = flow.port.getJournalSnapshot();
  assert.deepEqual(afterFirstSnapshot.reconciliations, [{
    reconciliationId: reconciliation.reconciliationId,
    claimId: flow.claim.claimId,
    attemptId: flow.attempt.attemptId,
    predecessorReceiptId: outcome.receiptId,
    receiptDigest: reconciliation.reconciliationDigest,
  }]);

  const altered = {
    ...reconciliation,
    predecessorReceiptDigest: `sha256:${'d'.repeat(64)}`,
    reconciliationDigest: '',
  } as unknown as Record<string, unknown>;
  altered['reconciliationDigest'] = computeReconciliationDigest(altered);
  const replay = await flow.port.reconcileUncertain(altered as unknown as AttemptReconciliationReceiptV02);
  assert.equal(replay.outcome, 'conflict');
  assert.deepEqual(flow.port.getLedgers(), afterFirst);
  assert.deepEqual(await flow.port.loadTask(flow.context.taskId), afterFirstTask);
  assert.deepEqual(flow.port.getJournalSnapshot(), afterFirstSnapshot);
});

test('Journal regressions: uncertain reconciliation refuses foreign claim and forged fence identity', async () => {
  const provider = await beginProviderAttempt();
  const providerOutcome = createTestProviderOutcomeReceiptV02(provider.claim, provider.attempt, provider.context, { outcome: 'uncertain' });
  assert.equal((await provider.port.recordOutcome(providerOutcome)).outcome, 'uncertain');
  const foreign = createTestUncertainReconciliationReceiptV02(providerOutcome, provider.claim, provider.attempt, provider.context, {
    claimId: 'claim-foreign-001',
  });
  const providerBeforeTask = await provider.port.loadTask(provider.context.taskId);
  const providerBeforeLedgers = provider.port.getLedgers();
  const providerBeforeSnapshot = provider.port.getJournalSnapshot();
  const foreignResult = await provider.port.reconcileUncertain(foreign);
  assert.equal(foreignResult.outcome, 'conflict');
  assert.deepEqual(await provider.port.loadTask(provider.context.taskId), providerBeforeTask);
  assert.deepEqual(provider.port.getLedgers(), providerBeforeLedgers);
  assert.deepEqual(provider.port.getJournalSnapshot(), providerBeforeSnapshot);

  const repository = await beginRepositoryAttempt();
  const outcome = createTestRepositoryOutcomeReceiptV02(repository.claim, repository.attempt, repository.context, { outcome: 'uncertain' });
  assert.equal((await repository.port.recordOutcome(outcome)).outcome, 'uncertain');
  assert.equal(await repository.port.setTaskControl(repository.context.taskId, 'paused', 'pause-for-forged-fence-001'), true);
  const fence = await repository.port.fenceAttemptRecipient(repository.claim.claimId, repository.executor);
  assert.ok(fence);
  const valid = createTestUncertainReconciliationReceiptV02(outcome, repository.claim, repository.attempt, repository.context, {
    disposition: 'proven-not-dispatched',
    adapterEvidenceRefs: fence.adapterEvidenceRefs,
    fencedRecipientIdentity: fence.recipientIdentity,
    fencingGeneration: fence.fencingGeneration,
    fencingProof: fence.proofRef,
    evidenceRefs: [...fence.adapterEvidenceRefs, fence.proofRef],
    expectedCurrentControlVersion: repository.port.getJournalSnapshot().controlVersion,
  });
  const forged = {
    ...valid,
    fencedRecipientIdentity: { ...fence.recipientIdentity, processIncarnation: 'proc-forged-001' },
    reconciliationDigest: '',
  } as unknown as Record<string, unknown>;
  forged['reconciliationDigest'] = computeReconciliationDigest(forged);
  const repositoryBeforeTask = await repository.port.loadTask(repository.context.taskId);
  const repositoryBeforeLedgers = repository.port.getLedgers();
  const repositoryBeforeSnapshot = repository.port.getJournalSnapshot();
  const forgedResult = await repository.port.reconcileUncertain(forged as unknown as AttemptReconciliationReceiptV02);
  assert.equal(forgedResult.outcome, 'conflict');
  assert.deepEqual(await repository.port.loadTask(repository.context.taskId), repositoryBeforeTask);
  assert.deepEqual(repository.port.getLedgers(), repositoryBeforeLedgers);
  assert.deepEqual(repository.port.getJournalSnapshot(), repositoryBeforeSnapshot);
});

test('Journal regressions: observed reconciliation refuses stale expected task versions without overwriting state', async () => {
  const flow = await beginRepositoryAttempt();
  const task = await flow.port.loadTask(flow.context.taskId);
  assert.ok(task);
  flow.port.getUnderlying().internalSetTask({ ...task, node: 'Repair' });
  const outcome = createTestRepositoryOutcomeReceiptV02(flow.claim, flow.attempt, flow.context);
  assert.equal((await flow.port.recordOutcome(outcome)).outcome, 'recorded-unsettled');
  const invalid = createTestObservedReconciliationReceiptV02(outcome, flow.claim, flow.attempt, flow.context, {
    expectedCurrentTaskStateVersion: 999,
  });
  const beforeTask = await flow.port.loadTask(flow.context.taskId);
  if (!beforeTask) throw new Error('Expected the observed-unsettled task to remain present');
  const beforeLedgers = flow.port.getLedgers();
  const beforeSnapshot = flow.port.getJournalSnapshot();

  const result = await flow.port.reconcileObservedOutcome(invalid);

  assert.equal(result.outcome, 'conflict');
  assert.deepEqual(await flow.port.loadTask(flow.context.taskId), beforeTask);
  assert.deepEqual(flow.port.getLedgers(), beforeLedgers);
  assert.deepEqual(flow.port.getJournalSnapshot(), beforeSnapshot);

  const staleControl = createTestObservedReconciliationReceiptV02(outcome, flow.claim, flow.attempt, flow.context, {
    reconciliationId: 'recon-stale-control-001',
    expectedCurrentTaskStateVersion: beforeTask.stateVersion,
    expectedCurrentControlVersion: beforeSnapshot.controlVersion - 1,
  });
  const staleControlResult = await flow.port.reconcileObservedOutcome(staleControl);
  assert.equal(staleControlResult.outcome, 'conflict');
  assert.deepEqual(await flow.port.loadTask(flow.context.taskId), beforeTask);
  assert.deepEqual(flow.port.getLedgers(), beforeLedgers);
  assert.deepEqual(flow.port.getJournalSnapshot(), beforeSnapshot);
});

test('Journal regressions: closure requires a recorded hold and fence proof', async () => {
  const flow = await claimRepositoryFlow();
  const closure = createTestClaimClosureReceiptV02(flow.claim, createTestExecutorIdentityV02({ payloadDigest: flow.context.actionDigest }));
  const beforeTask = await flow.port.loadTask(flow.context.taskId);
  const beforeLedgers = flow.port.getLedgers();
  const beforeSnapshot = flow.port.getJournalSnapshot();

  const result = await flow.port.closeUnattemptedClaim(closure);

  assert.equal(result.closed, false);
  assert.deepEqual(await flow.port.loadTask(flow.context.taskId), beforeTask);
  assert.deepEqual(flow.port.getLedgers(), beforeLedgers);
  assert.deepEqual(flow.port.getJournalSnapshot(), beforeSnapshot);
});

test('Journal regressions: authority publication winning before beginAttempt leaves the old claim held and denied', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const claim = await port.claim(context);
  assert.equal(isNeutralClaimReceiptV02(claim), false);
  const before = port.getJournalSnapshot();
  const beforeTask = await port.loadTask(context.taskId);
  const beforeLedgers = port.getLedgers();
  const replacement = { ...context.policyAuthorityRef, decisionAuthorityGeneration: context.policyAuthorityRef.decisionAuthorityGeneration + 1 };

  const [publication, attempt] = await Promise.all([
    port.publishAuthority({ authorityRef: replacement }),
    port.beginAttempt(claim.claimId, createTestExecutorIdentityV02({ payloadDigest: context.actionDigest })),
  ]);

  assert.equal(publication.status, 'published');
  assert.equal(publication.generation, replacement.decisionAuthorityGeneration);
  assert.equal(isNeutralAttemptReceiptV02(attempt), true);
  assert.equal(port.getJournalSnapshot().controlVersion, before.controlVersion + 1);
  assert.deepEqual(port.getJournalSnapshot().activeAuthorityRef, replacement);
  assert.deepEqual(await port.loadTask(context.taskId), beforeTask);
  assert.deepEqual(port.getLedgers(), beforeLedgers);
  assert.equal(port.getJournalSnapshot().claims.find((item) => item.claimId === claim.claimId)?.status, 'claimed');
});

test('Journal regressions: beginAttempt winning before publication remains one admitted in-flight attempt', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const claim = await port.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const replacement = { ...context.policyAuthorityRef, decisionAuthorityGeneration: context.policyAuthorityRef.decisionAuthorityGeneration + 1 };
  const beforePublication = port.getJournalSnapshot();

  const [attempt, publication] = await Promise.all([
    port.beginAttempt(claim.claimId, actor),
    port.publishAuthority({ authorityRef: replacement }),
  ]);
  assert.equal(isNeutralAttemptReceiptV02(attempt), false);

  assert.equal(publication.status, 'published');
  assert.equal(port.getJournalSnapshot().controlVersion, beforePublication.controlVersion + 2);
  assert.deepEqual(port.getJournalSnapshot().activeAuthorityRef, replacement);
  assert.equal(port.getJournalSnapshot().claims.find((item) => item.claimId === claim.claimId)?.status, 'attempting');
  assert.equal(isNeutralAttemptReceiptV02(await port.beginAttempt(claim.claimId, actor)), true);
  const task = await port.loadTask(context.taskId);
  assert.ok(task);
  assert.equal(task.node, 'Patch');
  const repair = port.getLedgers().find((ledger) => ledger.scope === 'task' && ledger.kind === 'repair');
  assert.ok(repair);
  assert.equal(repair.consumed, 1);
});

test('Journal regressions: pause denies begin and fenced no-attempt closure releases only live reservations', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const claim = await port.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const beforeTask = await port.loadTask(context.taskId);
  const beforeLedgers = port.getLedgers();

  const [paused, attempt] = await Promise.all([
    port.setTaskControl(context.taskId, 'paused', 'pause-event-001'),
    port.beginAttempt(claim.claimId, actor),
  ]);
  assert.equal(paused, true);
  assert.equal(isNeutralAttemptReceiptV02(attempt), true);
  assert.deepEqual(await port.loadTask(context.taskId), beforeTask);
  assert.deepEqual(port.getLedgers(), beforeLedgers);
  const heldSnapshot = port.getJournalSnapshot();
  assert.equal(port.getJournalSnapshot().mode, 'paused');
  assert.equal(port.getJournalSnapshot().controlVersion, heldSnapshot.controlVersion);

  const fence = await port.fenceClaimRecipient(claim.claimId, actor);
  assert.ok(fence);
  assert.equal(fence.recipientIdentity.processIncarnation, actor.processIncarnation);
  assert.equal(fence.fencedExecutorIdentity.fencingGeneration, actor.fencingGeneration + 1);
  const closure = createTestClaimClosureReceiptV02(claim, fence.fencedExecutorIdentity, { reason: fence.holdRef });
  const closed = await port.closeUnattemptedClaim(closure);
  assert.deepEqual(closed, { closed: true, receiptId: closure.receiptId });
  assert.equal(port.getJournalSnapshot().mode, 'paused');
  assert.equal(port.getJournalSnapshot().claims.find((item) => item.claimId === claim.claimId)?.status, 'closed');
  assert.ok(port.getJournalSnapshot().fencedIncarnations.length > 0);
  const repair = port.getLedgers().find((ledger) => ledger.scope === 'task' && ledger.kind === 'repair');
  assert.ok(repair);
  assert.equal(repair.consumed, 0);
  assert.equal(repair.reservations.length, 0);
  assert.deepEqual(await port.closeUnattemptedClaim(closure), closed);

  const conflictingClosure = createTestClaimClosureReceiptV02(claim, fence.fencedExecutorIdentity, { reason: 'conflicting replay' });
  assert.equal((await port.closeUnattemptedClaim(conflictingClosure)).closed, false);
  assert.equal(port.getJournalSnapshot().mode, 'paused');
  assert.equal(port.getJournalSnapshot().claims.find((item) => item.claimId === claim.claimId)?.status, 'closed');
});

test('Journal regressions: begin winning a queued pause admits once and prevents no-attempt closure', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const claim = await port.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const [attempt, paused] = await Promise.all([
    port.beginAttempt(claim.claimId, actor),
    port.setTaskControl(context.taskId, 'paused', 'pause-after-begin-001'),
  ]);

  assert.equal(paused, true);
  assert.equal(isNeutralAttemptReceiptV02(attempt), false);
  assert.equal(port.getJournalSnapshot().mode, 'paused');
  assert.equal(port.getJournalSnapshot().claims.find((item) => item.claimId === claim.claimId)?.status, 'attempting');
  const task = await port.loadTask(context.taskId);
  assert.ok(task);
  assert.equal(task.node, 'Patch');
  assert.equal(task.stateVersion, context.expectedTaskStateVersion + 1);
  const repair = port.getLedgers().find((ledger) => ledger.scope === 'task' && ledger.kind === 'repair');
  assert.ok(repair);
  assert.equal(repair.consumed, 1);
  assert.equal(repair.reservations.length, 0);

  const closure = createTestClaimClosureReceiptV02(claim, actor);
  const beforeTask = await port.loadTask(context.taskId);
  const beforeLedgers = port.getLedgers();
  const beforeSnapshot = port.getJournalSnapshot();
  assert.equal((await port.closeUnattemptedClaim(closure)).closed, false);
  assert.deepEqual(await port.loadTask(context.taskId), beforeTask);
  assert.deepEqual(port.getLedgers(), beforeLedgers);
  assert.deepEqual(port.getJournalSnapshot(), beforeSnapshot);
});

test('Journal regressions: concurrent task transitions serialize with beginAttempt compare-and-swap', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const claim = await port.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const before = await port.loadTask(context.taskId);
  assert.ok(before);
  const next = { ...before, node: 'Incomplete' as const, outcome: 'INCOMPLETE' as const, stateVersion: before.stateVersion + 1, budgetLedgers: [...port.getLedgers()] };
  type TransitionResult = { readonly committed: true } | { readonly committed: false; readonly error: unknown };
  const beginResult = port.beginAttempt(claim.claimId, actor);
  const transitionResult = port.transition(next, before.stateVersion).then<TransitionResult, TransitionResult>(
    () => ({ committed: true }),
    (error: unknown) => ({ committed: false, error }),
  );

  const [attempt, transition] = await Promise.all([beginResult, transitionResult]);

  assert.equal(isNeutralAttemptReceiptV02(attempt), false);
  if (transition.committed) throw new Error('serialized transition must lose its stale stateVersion');
  assert.ok(transition.error instanceof Error);
  assert.match(transition.error.message, /CAS conflict/u);
  const after = await port.loadTask(context.taskId);
  assert.ok(after);
  assert.equal(after.node, 'Patch');
  assert.equal(after.stateVersion, before.stateVersion + 1);
  const repair = port.getLedgers().find((ledger) => ledger.scope === 'task' && ledger.kind === 'repair');
  assert.ok(repair);
  assert.equal(repair.consumed, 1);
  assert.equal(port.getJournalSnapshot().claims.find((item) => item.claimId === claim.claimId)?.status, 'attempting');
});

function makeTestLedger(scope: 'task' | 'run', kind: string, limit: number, consumed = 0): BudgetLedger {
  return {
    scope,
    kind,
    limit,
    consumed,
    reservations: [],
    unit: 'count',
    configurationId: 'config-uc03-v1',
    version: 1,
  };
}

test('Journal R2: snapshot persists the canonical digest of the complete active hold event', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  assert.equal(await port.setTaskControl(context.taskId, 'paused', 'pause-event-r2-digest'), true);

  const snapshot = port.getJournalSnapshot() as unknown as { holdRef: string | null; holdEventDigest: string | null; controlVersion: number; epoch: number };
  assert.equal(snapshot.holdRef, 'pause-event-r2-digest');
  assert.equal(snapshot.holdEventDigest, computeCanonicalSha256({
    schemaVersion: 'uc04-control-event/0.2-draft',
    taskId: context.taskId,
    runId: context.runId,
    taskStateVersion: context.expectedTaskStateVersion,
    eventKind: 'pause',
    mode: 'paused',
    eventRef: snapshot.holdRef,
    controlVersion: snapshot.controlVersion,
    epoch: snapshot.epoch,
  }));

  assert.equal(await port.setTaskControl(context.taskId, 'paused', 'pause-event-r2-digest'), true);
  const afterRetry = port.getJournalSnapshot() as unknown as typeof snapshot;
  assert.equal(afterRetry.controlVersion, snapshot.controlVersion, 'an exact hold-event retry does not advance the control version');
  assert.equal(afterRetry.holdEventDigest, snapshot.holdEventDigest, 'an exact hold-event retry retains its persisted digest');
});

test('Journal R2: reviewer iteration reservations bind task and configured run ledgers and consume once at beginAttempt', async () => {
  const requestId = 'req-review-iteration-r2';
  const runRef = `run-iteration-${requestId}`;
  const base = createTestProviderAdmissionContextV02({
    providerRequest: createTestProviderRequest({ role: 'reviewer', providerRequestId: requestId }),
  });
  const context = { ...base, budgetRefs: [...base.budgetRefs, runRef] } as ProviderAdmissionContextV02;
  const initial = createTestAdmissionTaskStateV02(context);
  const runIteration = makeTestLedger('run', 'iteration', 2, 1);
  const state: TaskState = { ...initial, budgetLedgers: [...(initial.budgetLedgers ?? []), runIteration] };
  const port = createPort(context, { initialTaskState: state });
  const taskBefore = port.getLedgers().find((ledger) => ledger.scope === 'task' && ledger.kind === 'iteration');
  const runBefore = port.getLedgers().find((ledger) => ledger.scope === 'run' && ledger.kind === 'iteration');
  assert.ok(taskBefore && runBefore);

  const claim = await port.claim(context);
  assert.equal(isNeutralClaimReceiptV02(claim), false);
  const afterClaim = port.getLedgers();
  const taskReserved = afterClaim.find((ledger) => ledger.scope === 'task' && ledger.kind === 'iteration');
  const runReserved = afterClaim.find((ledger) => ledger.scope === 'run' && ledger.kind === 'iteration');
  assert.ok(taskReserved && runReserved);
  assert.equal(taskReserved.consumed, taskBefore.consumed);
  assert.deepEqual(taskReserved.reservations, [{ reservationId: context.budgetRefs[4], keyedId: requestId, amount: 1 }]);
  assert.equal(runReserved.consumed, runBefore.consumed);
  assert.deepEqual(runReserved.reservations, [{ reservationId: runRef, keyedId: requestId, amount: 1 }]);
  assert.deepEqual(claim.reservationRefs.slice(-2), [context.budgetRefs[4], runRef]);

  const actor = createTestExecutorIdentityV02({ payloadDigest: context.requestContentDigest });
  assert.equal(isNeutralAttemptReceiptV02(await port.beginAttempt(claim.claimId, actor)), false);
  const afterBegin = port.getLedgers();
  const taskCharged = afterBegin.find((ledger) => ledger.scope === 'task' && ledger.kind === 'iteration');
  const runCharged = afterBegin.find((ledger) => ledger.scope === 'run' && ledger.kind === 'iteration');
  assert.ok(taskCharged && runCharged);
  assert.equal(taskCharged.consumed, taskBefore.consumed + 1);
  assert.deepEqual(taskCharged.reservations, []);
  assert.equal(runCharged.consumed, runBefore.consumed + 1);
  assert.deepEqual(runCharged.reservations, []);
});

test('Journal R2: missing or exhausted reviewer iteration rows refuse atomically', async () => {
  const missingContext = createTestProviderAdmissionContextV02({
    providerRequest: createTestProviderRequest({ role: 'reviewer', providerRequestId: 'req-review-iteration-missing-r2' }),
  });
  const missingInitial = createTestAdmissionTaskStateV02(missingContext);
  const missingState: TaskState = {
    ...missingInitial,
    budgetLedgers: missingInitial.budgetLedgers?.filter((ledger) => !(ledger.scope === 'task' && ledger.kind === 'iteration')),
  };
  const missingPort = createPort(missingContext, { initialTaskState: missingState });
  const missingBefore = {
    task: await missingPort.loadTask(missingContext.taskId),
    ledgers: missingPort.getLedgers(),
    snapshot: missingPort.getJournalSnapshot(),
  };
  assert.equal(isNeutralClaimReceiptV02(await missingPort.claim(missingContext)), true);
  assert.deepEqual(await missingPort.loadTask(missingContext.taskId), missingBefore.task);
  assert.deepEqual(missingPort.getLedgers(), missingBefore.ledgers);
  assert.deepEqual(missingPort.getJournalSnapshot(), missingBefore.snapshot);

  const exhaustedId = 'req-review-iteration-exhausted-r2';
  const runRef = `run-iteration-${exhaustedId}`;
  const base = createTestProviderAdmissionContextV02({
    providerRequest: createTestProviderRequest({ role: 'reviewer', providerRequestId: exhaustedId }),
  });
  const context = { ...base, budgetRefs: [...base.budgetRefs, runRef] } as ProviderAdmissionContextV02;
  const initial = createTestAdmissionTaskStateV02(context);
  const exhaustedState: TaskState = {
    ...initial,
    budgetLedgers: [
      ...(initial.budgetLedgers ?? []).map((ledger) => ledger.scope === 'task' && ledger.kind === 'iteration'
        ? { ...ledger, consumed: ledger.limit }
        : ledger),
      makeTestLedger('run', 'iteration', 2),
    ],
  };
  const exhaustedPort = createPort(context, { initialTaskState: exhaustedState });
  const exhaustedBefore = {
    task: await exhaustedPort.loadTask(context.taskId),
    ledgers: exhaustedPort.getLedgers(),
    snapshot: exhaustedPort.getJournalSnapshot(),
  };
  assert.equal(isNeutralClaimReceiptV02(await exhaustedPort.claim(context)), true);
  assert.deepEqual(await exhaustedPort.loadTask(context.taskId), exhaustedBefore.task);
  assert.deepEqual(exhaustedPort.getLedgers(), exhaustedBefore.ledgers);
  assert.deepEqual(exhaustedPort.getJournalSnapshot(), exhaustedBefore.snapshot);

  const runExhaustedState: TaskState = {
    ...initial,
    budgetLedgers: [...(initial.budgetLedgers ?? []), makeTestLedger('run', 'iteration', 2, 2)],
  };
  const runExhaustedPort = createPort(context, { initialTaskState: runExhaustedState });
  const runExhaustedBefore = {
    task: await runExhaustedPort.loadTask(context.taskId),
    ledgers: runExhaustedPort.getLedgers(),
    snapshot: runExhaustedPort.getJournalSnapshot(),
  };
  assert.equal(isNeutralClaimReceiptV02(await runExhaustedPort.claim(context)), true);
  assert.deepEqual(await runExhaustedPort.loadTask(context.taskId), runExhaustedBefore.task);
  assert.deepEqual(runExhaustedPort.getLedgers(), runExhaustedBefore.ledgers);
  assert.deepEqual(runExhaustedPort.getJournalSnapshot(), runExhaustedBefore.snapshot);
});

test('Journal R2: fenced pre-attempt reviewer closure releases exact task and run iteration reservations', async () => {
  const requestId = 'req-review-iteration-release-r2';
  const runRef = `run-iteration-${requestId}`;
  const base = createTestProviderAdmissionContextV02({
    providerRequest: createTestProviderRequest({ role: 'reviewer', providerRequestId: requestId }),
  });
  const context = { ...base, budgetRefs: [...base.budgetRefs, runRef] } as ProviderAdmissionContextV02;
  const initial = createTestAdmissionTaskStateV02(context);
  const state: TaskState = { ...initial, budgetLedgers: [...(initial.budgetLedgers ?? []), makeTestLedger('run', 'iteration', 3)] };
  const port = createPort(context, { initialTaskState: state });
  const claim = await port.claim(context);
  assert.equal(isNeutralClaimReceiptV02(claim), false);
  assert.equal(await port.setTaskControl(context.taskId, 'paused', 'pause-review-iteration-release-r2'), true);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.requestContentDigest });
  const fence = await port.fenceClaimRecipient(claim.claimId, actor);
  assert.ok(fence);
  const closure = createTestClaimClosureReceiptV02(claim, fence.fencedExecutorIdentity, { reason: fence.holdRef });

  assert.deepEqual(await port.closeUnattemptedClaim(closure), { closed: true, receiptId: closure.receiptId });
  const after = port.getLedgers();
  const taskIteration = after.find((ledger) => ledger.scope === 'task' && ledger.kind === 'iteration');
  const runIteration = after.find((ledger) => ledger.scope === 'run' && ledger.kind === 'iteration');
  assert.ok(taskIteration && runIteration);
  assert.equal(taskIteration.consumed, 0);
  assert.deepEqual(taskIteration.reservations, []);
  assert.equal(runIteration.consumed, 0);
  assert.deepEqual(runIteration.reservations, []);
  assert.ok(after.filter((ledger) => ledger.kind === 'tokens' || ledger.kind === 'cost').every((ledger) => ledger.consumed === 0 && ledger.reservations.length === 0));
  assert.equal(port.getJournalSnapshot().claims.find((item) => item.claimId === claim.claimId)?.status, 'closed');
});

test('Journal R2: repository command reserves and settles only configured execution-resource ledgers', async () => {
  const context = createTestRepositoryCommandAdmissionContextV02({
    reservationRefs: ['res-task-cpu-r2', 'res-run-output-r2'],
  });
  const initial = createTestAdmissionTaskStateV02(context);
  const state: TaskState = {
    ...initial,
    budgetLedgers: [
      ...(initial.budgetLedgers ?? []),
      makeTestLedger('task', 'maxCpuSeconds', 10),
      makeTestLedger('run', 'maxOutputBytes', 65_536),
    ],
  };
  const port = createPort(context, { initialTaskState: state });
  const tokenCostBefore = port.getLedgers().filter((ledger) => ledger.kind === 'tokens' || ledger.kind === 'cost');
  const claim = await port.claim(context);
  assert.equal(isNeutralClaimReceiptV02(claim), false);
  const commandReservations = port.getLedgers().flatMap((ledger) => ledger.reservations.map((reservation) => ({ scope: ledger.scope, kind: ledger.kind, ...reservation })));
  assert.deepEqual(commandReservations, [
    { scope: 'task', kind: 'maxCpuSeconds', reservationId: context.reservationRefs[0], keyedId: context.action.actionId, amount: 10 },
    { scope: 'run', kind: 'maxOutputBytes', reservationId: context.reservationRefs[1], keyedId: context.action.actionId, amount: 65_536 },
  ]);
  assert.deepEqual(port.getLedgers().filter((ledger) => ledger.kind === 'tokens' || ledger.kind === 'cost'), tokenCostBefore);

  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await port.beginAttempt(claim.claimId, actor);
  assert.equal(isNeutralAttemptReceiptV02(attempt), false);
  const outcome = createTestRepositoryOutcomeReceiptV02(claim, attempt, context);
  assert.equal((await port.recordOutcome(outcome)).outcome, 'settled');
  const after = port.getLedgers();
  assert.equal(after.find((ledger) => ledger.scope === 'task' && ledger.kind === 'maxCpuSeconds')?.consumed, 10);
  assert.equal(after.find((ledger) => ledger.scope === 'run' && ledger.kind === 'maxOutputBytes')?.consumed, 65_536);
  assert.deepEqual(after.find((ledger) => ledger.scope === 'task' && ledger.kind === 'maxCpuSeconds')?.reservations, []);
  assert.deepEqual(after.find((ledger) => ledger.scope === 'run' && ledger.kind === 'maxOutputBytes')?.reservations, []);
  assert.deepEqual(after.filter((ledger) => ledger.kind === 'tokens' || ledger.kind === 'cost'), tokenCostBefore);
});

test('Journal R2: observed command recovery settles same-version drift without charging twice', async () => {
  const context = createTestRepositoryCommandAdmissionContextV02({
    reservationRefs: ['res-task-cpu-drift-r2', 'res-run-output-drift-r2'],
  });
  const initial = createTestAdmissionTaskStateV02(context);
  const state: TaskState = {
    ...initial,
    budgetLedgers: [
      ...(initial.budgetLedgers ?? []),
      makeTestLedger('task', 'maxCpuSeconds', 10),
      makeTestLedger('run', 'maxOutputBytes', 65_536),
    ],
  };
  const port = createPort(context, { initialTaskState: state });
  const snapshot = async () => ({
    task: await port.loadTask(context.taskId),
    journal: port.getJournalSnapshot(),
    ledgers: port.getLedgers(),
  });
  const providerLedgersBefore = port.getLedgers().filter((ledger) => ledger.kind === 'tokens' || ledger.kind === 'cost');
  const claim = await port.claim(context);
  assert.equal(isNeutralClaimReceiptV02(claim), false);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await port.beginAttempt(claim.claimId, actor);
  assert.equal(isNeutralAttemptReceiptV02(attempt), false);
  const afterAttempt = await port.loadTask(context.taskId);
  assert.ok(afterAttempt);

  const driftNode: TaskState['node'] = context.runnableNode === 'Repair' ? 'Investigate' : 'Repair';
  port.getUnderlying().internalSetTask({ ...afterAttempt, node: driftNode });
  const beforeRecord = await port.loadTask(context.taskId);
  assert.ok(beforeRecord);
  assert.equal(beforeRecord.stateVersion, attempt.postBeginTaskStateVersion);
  assert.notEqual(beforeRecord.node, context.runnableNode);

  const outcome = createTestRepositoryOutcomeReceiptV02(claim, attempt, context);
  assert.equal((await port.recordOutcome(outcome)).outcome, 'recorded-unsettled');
  const afterRecord = await snapshot();
  assert.ok(afterRecord.task);
  assert.equal(afterRecord.task.stateVersion, attempt.postBeginTaskStateVersion);
  assert.equal(afterRecord.task.node, driftNode);
  assert.equal(afterRecord.journal.claims.find((item) => item.claimId === claim.claimId)?.status, 'observed-unsettled');
  assert.equal(afterRecord.journal.attempts.find((item) => item.attemptId === attempt.attemptId)?.status, 'observed-unsettled');
  assert.equal(afterRecord.journal.activeClaimId, claim.claimId);
  assert.equal(afterRecord.journal.outcomes.some((item) => item.receiptId === outcome.receiptId && item.outcome === 'observed'), true);
  assert.deepEqual(afterRecord.ledgers.filter((ledger) => ledger.kind === 'maxCpuSeconds' || ledger.kind === 'maxOutputBytes').map(({ scope, kind, consumed, reservations }) => ({ scope, kind, consumed, reservations })), [
    { scope: 'task', kind: 'maxCpuSeconds', consumed: 10, reservations: [] },
    { scope: 'run', kind: 'maxOutputBytes', consumed: 65_536, reservations: [] },
  ]);
  assert.deepEqual(afterRecord.ledgers.filter((ledger) => ledger.kind === 'tokens' || ledger.kind === 'cost'), providerLedgersBefore);

  assert.deepEqual(await port.recordOutcome(outcome), { outcome: 'already-recorded', receiptId: outcome.receiptId });
  assert.deepEqual(await snapshot(), afterRecord, 'outcome replay reports status without changing persisted state');

  const incompatibleRecovery = createTestObservedReconciliationReceiptV02(outcome, claim, attempt, context, {
    reconciliationId: 'recon-command-incompatible-current-r2',
    expectedCurrentTaskStateVersion: beforeRecord.stateVersion,
    expectedCurrentControlVersion: afterRecord.journal.controlVersion,
  });
  const beforeIncompatibleRecovery = await snapshot();
  assert.equal((await port.reconcileObservedOutcome(incompatibleRecovery)).outcome, 'conflict');
  assert.deepEqual(await snapshot(), beforeIncompatibleRecovery, 'incompatible current task state refuses without effects');

  port.getUnderlying().internalSetTask({ ...beforeRecord, node: afterAttempt.node });
  assert.equal(await port.setTaskControl(context.taskId, 'paused', 'pause-command-recovery-r2'), true);
  const compatibleRecovery = createTestObservedReconciliationReceiptV02(outcome, claim, attempt, context, {
    reconciliationId: 'recon-command-compatible-r2',
    expectedCurrentTaskStateVersion: attempt.postBeginTaskStateVersion,
    expectedCurrentControlVersion: port.getJournalSnapshot().controlVersion,
  });

  const invalidPredecessorBase = {
    ...compatibleRecovery,
    reconciliationId: 'recon-command-invalid-predecessor-r2',
    predecessorReceiptId: 'outcome-command-unrecorded-r2',
    reconciliationDigest: '',
  };
  const invalidPredecessor = {
    ...invalidPredecessorBase,
    reconciliationDigest: computeReconciliationDigest(invalidPredecessorBase),
  } as AttemptReconciliationReceiptV02;
  const beforeInvalidPredecessor = await snapshot();
  assert.equal((await port.reconcileObservedOutcome(invalidPredecessor)).outcome, 'conflict');
  assert.deepEqual(await snapshot(), beforeInvalidPredecessor, 'unknown predecessor refuses without effects');

  const invalidAccountingBase = {
    ...compatibleRecovery,
    reconciliationId: 'recon-command-invalid-accounting-r2',
    accountingIdentityDigest: computeCanonicalSha256('wrong-command-accounting-identity'),
    reconciliationDigest: '',
  };
  const invalidAccounting = {
    ...invalidAccountingBase,
    reconciliationDigest: computeReconciliationDigest(invalidAccountingBase),
  } as AttemptReconciliationReceiptV02;
  const beforeInvalidAccounting = await snapshot();
  assert.equal((await port.reconcileObservedOutcome(invalidAccounting)).outcome, 'conflict');
  assert.deepEqual(await snapshot(), beforeInvalidAccounting, 'untrusted accounting identity refuses without effects');

  const beforeRecovery = await snapshot();
  const recoveryResult = await port.reconcileObservedOutcome(compatibleRecovery);
  assert.equal(recoveryResult.outcome, 'settled');
  const afterRecovery = await snapshot();
  assert.ok(afterRecovery.task);
  assert.equal(afterRecovery.task.stateVersion, attempt.postBeginTaskStateVersion);
  assert.equal(afterRecovery.task.node, afterAttempt.node);
  assert.equal(afterRecovery.journal.claims.find((item) => item.claimId === claim.claimId)?.status, 'settled');
  assert.equal(afterRecovery.journal.attempts.find((item) => item.attemptId === attempt.attemptId)?.status, 'settled');
  assert.equal(afterRecovery.journal.activeClaimId, null);
  assert.equal(afterRecovery.journal.reconciliations.filter((item) => item.reconciliationId === compatibleRecovery.reconciliationId).length, 1);
  assert.equal(afterRecovery.journal.mode, 'paused');
  assert.equal(afterRecovery.journal.holdRef, 'pause-command-recovery-r2');
  assert.deepEqual(afterRecovery.ledgers, beforeRecovery.ledgers, 'recovery closes the claim without settling command resources again');
  assert.deepEqual(afterRecovery.ledgers.filter((ledger) => ledger.kind === 'tokens' || ledger.kind === 'cost'), providerLedgersBefore);

  assert.deepEqual(await port.reconcileObservedOutcome(compatibleRecovery), { outcome: 'settled', receiptId: compatibleRecovery.reconciliationId });
  assert.deepEqual(await snapshot(), afterRecovery, 'exact reconciliation replay is status-only');
});

test('Journal R2: command resource reservation mismatch refuses without partial ledger changes', async () => {
  const context = createTestRepositoryCommandAdmissionContextV02({ reservationRefs: ['res-task-cpu-mismatch-r2'] });
  const initial = createTestAdmissionTaskStateV02(context);
  const state: TaskState = {
    ...initial,
    budgetLedgers: [
      ...(initial.budgetLedgers ?? []),
      makeTestLedger('task', 'maxCpuSeconds', 10),
      makeTestLedger('run', 'maxOutputBytes', 65_536),
    ],
  };
  const port = createPort(context, { initialTaskState: state });
  const before = { task: await port.loadTask(context.taskId), ledgers: port.getLedgers(), snapshot: port.getJournalSnapshot() };

  assert.equal(isNeutralClaimReceiptV02(await port.claim(context)), true);
  assert.deepEqual(await port.loadTask(context.taskId), before.task);
  assert.deepEqual(port.getLedgers(), before.ledgers);
  assert.deepEqual(port.getJournalSnapshot(), before.snapshot);
});

test('Journal R2: observed patch settlement atomically invalidates only proposed evidence and stale review authority', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const initial = createTestAdmissionTaskStateV02(context);
  const state: TaskState = {
    ...initial,
    evidenceRefs: ['baseline-admission-v02', 'evidence-prior-baseline', 'evidence-retained-r2'],
    approvalDecisionRefs: ['historic-decision-r2'],
    activeDecisionId: 'dec-plan-001',
    reviewRefs: ['review-stale-r2'],
    latestReviewRef: 'review-stale-r2',
  };
  const port = createPort(context, { initialTaskState: state });
  const claim = await port.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await port.beginAttempt(claim.claimId, actor);
  const outcome = createTestRepositoryOutcomeReceiptV02(claim, attempt, context);
  assert.equal((await port.recordOutcome(outcome)).outcome, 'settled');
  const settledTask = await port.loadTask(context.taskId);
  assert.ok(settledTask);
  const settledLedgers = port.getLedgers();
  const settledSnapshot = port.getJournalSnapshot();
  assert.deepEqual(settledTask.evidenceRefs, ['baseline-admission-v02', 'evidence-retained-r2']);
  assert.equal(settledTask.activeDecisionId, undefined);
  assert.deepEqual(settledTask.reviewRefs, []);
  assert.equal(settledTask.latestReviewRef, undefined);
  assert.deepEqual(settledTask.approvalDecisionRefs, ['historic-decision-r2']);

  assert.deepEqual(await port.recordOutcome(outcome), { outcome: 'already-recorded', receiptId: outcome.receiptId });
  assert.deepEqual(await port.loadTask(context.taskId), settledTask);
  assert.deepEqual(port.getLedgers(), settledLedgers);
  assert.deepEqual(port.getJournalSnapshot(), settledSnapshot);
});

test('Journal R2: observed-unsettled patch recovery applies the same exact invalidations once', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const initial = createTestAdmissionTaskStateV02(context);
  const state: TaskState = {
    ...initial,
    evidenceRefs: ['baseline-admission-v02', 'evidence-prior-baseline', 'evidence-retained-recovery-r2'],
    approvalDecisionRefs: ['historic-decision-recovery-r2'],
    activeDecisionId: 'dec-plan-001',
    reviewRefs: ['review-stale-recovery-r2'],
    latestReviewRef: 'review-stale-recovery-r2',
  };
  const port = createPort(context, { initialTaskState: state });
  const claim = await port.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await port.beginAttempt(claim.claimId, actor);
  const afterAttempt = await port.loadTask(context.taskId);
  assert.ok(afterAttempt);
  port.getUnderlying().internalSetTask({ ...afterAttempt, node: 'Repair' });
  const outcome = createTestRepositoryOutcomeReceiptV02(claim, attempt, context);
  assert.equal((await port.recordOutcome(outcome)).outcome, 'recorded-unsettled');
  assert.equal(outcome.subjectKind, 'repository-action');
  if (outcome.subjectKind !== 'repository-action' || !outcome.observedResultRevisionDigest) throw new Error('patch outcome requires an observed revision');
  port.getUnderlying().internalSetTask({ ...afterAttempt, repositoryRevisionDigest: outcome.observedResultRevisionDigest });
  const current = await port.loadTask(context.taskId);
  assert.ok(current);
  const reconciliation = createTestObservedReconciliationReceiptV02(outcome, claim, attempt, context, {
    expectedCurrentTaskStateVersion: current.stateVersion,
    expectedCurrentControlVersion: port.getJournalSnapshot().controlVersion,
  });

  assert.equal((await port.reconcileObservedOutcome(reconciliation)).outcome, 'settled');
  const settledTask = await port.loadTask(context.taskId);
  assert.ok(settledTask);
  const settledSnapshot = port.getJournalSnapshot();
  const settledLedgers = port.getLedgers();
  assert.deepEqual(settledTask.evidenceRefs, ['baseline-admission-v02', 'evidence-retained-recovery-r2']);
  assert.equal(settledTask.activeDecisionId, undefined);
  assert.deepEqual(settledTask.reviewRefs, []);
  assert.equal(settledTask.latestReviewRef, undefined);
  assert.deepEqual(settledTask.approvalDecisionRefs, ['historic-decision-recovery-r2']);
  assert.deepEqual(await port.reconcileObservedOutcome(reconciliation), { outcome: 'settled', receiptId: reconciliation.reconciliationId });
  assert.deepEqual(await port.loadTask(context.taskId), settledTask);
  assert.deepEqual(port.getLedgers(), settledLedgers);
  assert.deepEqual(port.getJournalSnapshot(), settledSnapshot);
});

test('Journal R2: uncertain repair recovery requires a persisted fence and evidence-backed revision', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const initial = createTestAdmissionTaskStateV02(context);
  const state: TaskState = {
    ...initial,
    evidenceRefs: ['baseline-admission-v02', 'evidence-prior-baseline', 'evidence-retained-uncertain-r2'],
    approvalDecisionRefs: ['historic-decision-uncertain-r2'],
    activeDecisionId: 'dec-plan-001',
    reviewRefs: ['review-stale-uncertain-r2'],
    latestReviewRef: 'review-stale-uncertain-r2',
  };
  const port = createPort(context, { initialTaskState: state });
  const claim = await port.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await port.beginAttempt(claim.claimId, actor);
  const uncertain = createTestRepositoryOutcomeReceiptV02(claim, attempt, context, { outcome: 'uncertain' });
  assert.equal((await port.recordOutcome(uncertain)).outcome, 'uncertain');

  const accountingEvidenceRefs = [{ reference: 'evidence-accounted-revision-r2', digest: computeCanonicalSha256('accounted-revision-r2') }];
  const observedRevisionDigest = computeCanonicalSha256('observed-revision-r2');
  const invalidatedEvidence = [{ reference: 'evidence-prior-baseline', digest: computeCanonicalSha256('evidence-prior-baseline') }];
  const effectEvidenceRef = {
    reference: 'evidence-observed-revision-r2',
    digest: computeCanonicalSha256({
      schemaVersion: 'uc03-observed-patch-recovery/0.2-draft',
      predecessorReceiptId: uncertain.receiptId,
      observedRevisionDigest,
      invalidatedEvidence,
      accountingEvidenceRefs,
    }),
  };
  assert.equal(await port.publishRecoveryEvidence({
    predecessorReceiptId: uncertain.receiptId,
    effectEvidenceRef,
    accountingEvidenceRefs,
  }), false, 'a repair revision cannot be recovered without persisted revision evidence');
  const validEvidence = { predecessorReceiptId: uncertain.receiptId, effectEvidenceRef, accountingEvidenceRefs, observedRevisionDigest, invalidatedEvidence };
  assert.equal(await port.publishRecoveryEvidence(validEvidence), true);
  const beforeFence = {
    task: await port.loadTask(context.taskId),
    ledgers: port.getLedgers(),
    snapshot: port.getJournalSnapshot(),
  };
  const unfencedReceipt = createTestUncertainReconciliationReceiptV02(uncertain, claim, attempt, context, {
    reconciliationId: 'recon-repair-unfenced-r2',
    disposition: 'observed-and-accounted',
    effectEvidenceRef,
    accountingEvidenceRefs,
    evidenceRefs: [effectEvidenceRef, ...accountingEvidenceRefs],
    expectedCurrentControlVersion: port.getJournalSnapshot().controlVersion,
  });
  assert.equal((await port.reconcileUncertain(unfencedReceipt)).outcome, 'conflict');
  assert.deepEqual(await port.loadTask(context.taskId), beforeFence.task);
  assert.deepEqual(port.getLedgers(), beforeFence.ledgers);
  assert.deepEqual(port.getJournalSnapshot(), beforeFence.snapshot);

  assert.equal(await port.setTaskControl(context.taskId, 'paused', 'pause-uncertain-repair-r2'), true);
  const fence = await port.fenceAttemptRecipient(claim.claimId, actor);
  assert.ok(fence);
  const recovery = createTestUncertainReconciliationReceiptV02(uncertain, claim, attempt, context, {
    reconciliationId: 'recon-repair-fenced-r2',
    disposition: 'observed-and-accounted',
    effectEvidenceRef,
    accountingEvidenceRefs,
    evidenceRefs: [effectEvidenceRef, ...accountingEvidenceRefs],
    expectedCurrentControlVersion: port.getJournalSnapshot().controlVersion,
  });
  assert.equal((await port.reconcileUncertain(recovery)).outcome, 'settled');
  const settledTask = await port.loadTask(context.taskId);
  assert.ok(settledTask);
  const settledSnapshot = port.getJournalSnapshot();
  const settledLedgers = port.getLedgers();
  assert.equal(settledTask.node, 'Verify');
  assert.equal(settledTask.repositoryRevisionDigest, observedRevisionDigest);
  assert.deepEqual(settledTask.evidenceRefs, ['baseline-admission-v02', 'evidence-retained-uncertain-r2']);
  assert.equal(settledTask.activeDecisionId, undefined);
  assert.deepEqual(settledTask.reviewRefs, []);
  assert.equal(settledTask.latestReviewRef, undefined);
  assert.deepEqual(settledTask.approvalDecisionRefs, ['historic-decision-uncertain-r2']);
  assert.equal(settledSnapshot.mode, 'paused');
  assert.equal(settledSnapshot.holdRef, 'pause-uncertain-repair-r2');
  assert.ok(settledSnapshot.fenceProofs.some((proof) => proof.claimId === claim.claimId));
  assert.equal(settledSnapshot.claims.find((row) => row.claimId === claim.claimId)?.status, 'settled');
  assert.deepEqual(await port.reconcileUncertain(recovery), { outcome: 'settled', receiptId: recovery.reconciliationId });
  assert.deepEqual(await port.loadTask(context.taskId), settledTask);
  assert.deepEqual(port.getLedgers(), settledLedgers);
  assert.deepEqual(port.getJournalSnapshot(), settledSnapshot);
});

test('Journal R2: refusal and lost closure response preserve the safety fence and exact retry proof', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const port = createPort(context);
  const claim = await port.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  assert.equal(await port.setTaskControl(context.taskId, 'paused', 'pause-fence-retry-r2'), true);
  const fence = await port.fenceClaimRecipient(claim.claimId, actor);
  assert.ok(fence);
  const fenced = port.getJournalSnapshot();
  const wrongActor = { ...actor, processIncarnation: 'proc-different-r2' };
  assert.equal(await port.fenceClaimRecipient(claim.claimId, wrongActor), null);
  assert.deepEqual(port.getJournalSnapshot(), fenced);

  const validClosure = createTestClaimClosureReceiptV02(claim, fence.fencedExecutorIdentity, { reason: fence.holdRef });
  const refusedClosure = { ...validClosure, reason: 'wrong-hold-r2' };
  const beforeRefusal = { task: await port.loadTask(context.taskId), ledgers: port.getLedgers(), snapshot: port.getJournalSnapshot() };
  assert.equal((await port.closeUnattemptedClaim(refusedClosure)).closed, false);
  assert.deepEqual(await port.loadTask(context.taskId), beforeRefusal.task);
  assert.deepEqual(port.getLedgers(), beforeRefusal.ledgers);
  assert.deepEqual(port.getJournalSnapshot(), beforeRefusal.snapshot);

  assert.deepEqual(await port.fenceClaimRecipient(claim.claimId, actor), fence);
  assert.deepEqual(port.getJournalSnapshot(), beforeRefusal.snapshot, 'retry returns the persisted proof without undoing or reapplying the fence');
  const closed = await port.closeUnattemptedClaim(validClosure);
  assert.deepEqual(closed, { closed: true, receiptId: validClosure.receiptId });
  const afterClose = { task: await port.loadTask(context.taskId), ledgers: port.getLedgers(), snapshot: port.getJournalSnapshot() };
  assert.deepEqual(await port.closeUnattemptedClaim(validClosure), closed, 'a lost committed close response is recoverable by exact retry');
  assert.deepEqual(await port.loadTask(context.taskId), afterClose.task);
  assert.deepEqual(port.getLedgers(), afterClose.ledgers);
  assert.deepEqual(port.getJournalSnapshot(), afterClose.snapshot);
  assert.ok(afterClose.snapshot.fencedIncarnations.includes(`${actor.adapterIdentity}\u0000${actor.processIncarnation}`));
});

test('Journal R2: attempt snapshot rows retain claimId for exact claim-scoped closure checks', async () => {
  const flow = await beginRepositoryAttempt();
  const snapshot = flow.port.getJournalSnapshot() as unknown as { attempts: readonly { attemptId: string; claimId: string }[] };
  assert.deepEqual(snapshot.attempts, [{ attemptId: flow.attempt.attemptId, claimId: flow.claim.claimId, status: 'attempting', outcomeReceiptId: null }]);
});
