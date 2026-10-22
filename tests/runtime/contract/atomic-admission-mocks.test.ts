/**
 * UC-03 v0.2.0 Atomic Admission Mock Journal Tests (T041 / T042).
 *
 * Feature: specs/001-verified-code-repair
 * Amendment: contracts/atomic-admission-amendment.md
 *
 * T041: Runnable test-only StatePortV02 journal RED scaffolding in
 *       tests/runtime/support/uc03/memory-state.ts and
 *       tests/runtime/contract/atomic-admission-mocks.test.ts.
 *       Positive journal vectors fail ASSERTION ONLY after awaiting real method
 *       outcome; no throw, import, type, or collection failures.
 * T042: Turn positive assertions GREEN in tests/runtime/support/uc03/memory-state.ts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAdmittedForProduction,
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
  createTestTaskState,
  createTestExecutorIdentityV02,
  createTestRepositoryAdmissionContextV02,
  createTestProviderAdmissionContextV02,
  createTestClaimReceiptV02,
  createTestAttemptReceiptV02,
  createTestClaimClosureReceiptV02,
  createTestRepositoryOutcomeReceiptV02,
  createTestProviderOutcomeReceiptV02,
  createTestUncertainReconciliationReceiptV02,
  createTestObservedReconciliationReceiptV02,
} from '../support/uc03/state-fixtures.ts';

// ----------------------------------------------------------------------------
// Scaffolding and Invariant Tests (GREEN at T041)
// ----------------------------------------------------------------------------

test('Scaffolding: MemoryStatePortV02 implements StatePortV02 and rejects production admission by mock provenance', () => {
  const port = new MemoryStatePortV02();
  assert.equal(port.provenance, 'mock');
  assert.equal(isAdmittedForProduction([port]), false);
});

test('Scaffolding: neutral methods capture zero effects on task state and ledgers', async () => {
  const initialTaskState = createTestTaskState();
  const port = new MemoryStatePortV02({ initialTaskState });
  const before = await port.loadTask(initialTaskState.taskId);
  const beforeLedgers = port.getLedgers();

  const repoContext = createTestRepositoryAdmissionContextV02();
  const claim = await port.claim(repoContext);
  assert.equal(claim.claimId, '');

  const executor = createTestExecutorIdentityV02();
  const attempt = await port.beginAttempt('claim-any', executor);
  assert.equal(attempt.attemptId, '');

  const outcome = await port.recordOutcome(createTestRepositoryOutcomeReceiptV02());
  assert.equal(outcome.outcome, 'uncertain');

  const after = await port.loadTask(initialTaskState.taskId);
  const afterLedgers = port.getLedgers();
  assert.deepEqual(after, before);
  assert.deepEqual(afterLedgers, beforeLedgers);
});

test('Scaffolding: neutral placeholders are distinguishable from canonical valid receipts', () => {
  assert.equal(isNeutralClaimReceiptV02(NEUTRAL_CLAIM_RECEIPT_V02), true);
  assert.equal(isNeutralAttemptReceiptV02(NEUTRAL_ATTEMPT_RECEIPT_V02), true);
  assert.equal(isNeutralOutcomeRecordResultV02(NEUTRAL_OUTCOME_RECORD_RESULT_V02), true);
  assert.equal(isNeutralReconciliationResultV02(NEUTRAL_RECONCILIATION_RESULT_V02), true);
  assert.equal(isNeutralClaimClosureResultV02(NEUTRAL_CLAIM_CLOSURE_RESULT_V02), true);

  const canonicalClaim = createTestClaimReceiptV02();
  assert.equal(isNeutralClaimReceiptV02(canonicalClaim), false);
  const canonicalAttempt = createTestAttemptReceiptV02();
  assert.equal(isNeutralAttemptReceiptV02(canonicalAttempt), false);
  assert.equal(isNeutralOutcomeRecordResultV02({ outcome: 'settled', receiptId: 'rec-1' }), false);
  assert.equal(isNeutralReconciliationResultV02({ outcome: 'settled', receiptId: 'rec-1' }), false);
  assert.equal(isNeutralClaimClosureResultV02({ closed: true, receiptId: 'rec-1' }), false);
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
  const initialTaskState = createTestTaskState();
  const port = new MemoryStatePortV02({ initialTaskState });
  const loaded = await port.loadTask(initialTaskState.taskId);
  assert.ok(loaded);
  assert.equal(loaded.taskId, initialTaskState.taskId);
  await port.checkpoint(loaded);
  const recovered = await port.recover(initialTaskState.taskId);
  assert.equal(recovered.taskId, initialTaskState.taskId);
});

// ----------------------------------------------------------------------------
// Positive Vectors (Behavioral Assertion RED in T041; GREEN in T042)
// ----------------------------------------------------------------------------

test('Positive vector: valid claim CAS on repository admission context (RED in T041, GREEN in T042)', async () => {
  const port = new MemoryStatePortV02();
  const context = createTestRepositoryAdmissionContextV02();
  const receipt = await port.claim(context);

  assert.equal(receipt.claimId, 'claim-repo-001');
  assert.equal(receipt.taskId, context.taskId);
  assert.equal(receipt.runId, context.runId);
  assert.equal(receipt.status, 'claimed');
  assert.equal(receipt.subjectKind, 'repository-action');
  assert.equal(receipt.planApplicability, context.planApplicability);
});

test('Positive vector: valid claim CAS on provider admission context (RED in T041, GREEN in T042)', async () => {
  const port = new MemoryStatePortV02();
  const context = createTestProviderAdmissionContextV02();
  const receipt = await port.claim(context);

  assert.equal(receipt.claimId, 'claim-prov-001');
  assert.equal(receipt.taskId, context.taskId);
  assert.equal(receipt.runId, context.runId);
  assert.equal(receipt.status, 'claimed');
  assert.equal(receipt.subjectKind, 'provider-request');
  assert.equal(receipt.planApplicability, context.planApplicability);
});

test('Positive vector: single-use beginAttempt returns valid attempt receipt (RED in T041, GREEN in T042)', async () => {
  const port = new MemoryStatePortV02();
  const executor = createTestExecutorIdentityV02();
  const receipt = await port.beginAttempt('claim-repo-001', executor);

  assert.equal(receipt.attemptId, 'att-001');
  assert.equal(receipt.claimId, 'claim-repo-001');
  assert.equal(receipt.status, 'attempting');
  assert.equal(receipt.executorIdentity.adapterIdentity, executor.adapterIdentity);
});

test('Positive vector: recordOutcome for observed repository action (RED in T041, GREEN in T042)', async () => {
  const port = new MemoryStatePortV02();
  const outcomeReceipt = createTestRepositoryOutcomeReceiptV02();
  const result = await port.recordOutcome(outcomeReceipt);

  assert.equal(result.outcome, 'settled');
  assert.equal(result.receiptId, outcomeReceipt.receiptId);
});

test('Positive vector: recordOutcome for observed provider request (RED in T041, GREEN in T042)', async () => {
  const port = new MemoryStatePortV02();
  const outcomeReceipt = createTestProviderOutcomeReceiptV02();
  const result = await port.recordOutcome(outcomeReceipt);

  assert.equal(result.outcome, 'settled');
  assert.equal(result.receiptId, outcomeReceipt.receiptId);
});

test('Positive vector: reconcileObservedOutcome with exact predecessor (RED in T041, GREEN in T042)', async () => {
  const port = new MemoryStatePortV02();
  const reconReceipt = createTestObservedReconciliationReceiptV02();
  const result = await port.reconcileObservedOutcome(reconReceipt);

  assert.equal(result.outcome, 'settled');
  assert.equal(result.receiptId, reconReceipt.reconciliationId);
});

test('Positive vector: closeUnattemptedClaim closes unattempted claim (RED in T041, GREEN in T042)', async () => {
  const port = new MemoryStatePortV02();
  const closureReceipt = createTestClaimClosureReceiptV02();
  const result = await port.closeUnattemptedClaim(closureReceipt);

  assert.equal(result.closed, true);
  assert.equal(result.receiptId, closureReceipt.receiptId);
});

test('Positive vector: predecessor-bound reconcileUncertain (RED in T041, GREEN in T042)', async () => {
  const port = new MemoryStatePortV02();
  const reconReceipt = createTestUncertainReconciliationReceiptV02();
  const result = await port.reconcileUncertain(reconReceipt);

  assert.equal(result.outcome, 'settled');
  assert.equal(result.receiptId, reconReceipt.reconciliationId);
});
