import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAdmittedForProduction,
  computeCanonicalSha256,
  validateReservationBundle,
  validateDispatchAdmission,
  validateTaskState,
  validateStateTransition,
  BudgetExhaustionError,
  BudgetConflictError,
  type ProviderRequest,
  type DispatchAdmissionContext,
  type ApprovalBindingContext,
} from '../../../src/contracts/foundation/uc03.ts';
import {
  MemoryStatePort,
  StateConflictError,
} from '../support/uc03/memory-state.ts';
import { ScriptedApprovalPort } from '../support/uc03/scripted-approval.ts';
import {
  createTestTaskState,
  createTestLedgers,
  createTestAction,
  createTestApprovalBinding,
  createTestProviderUsage,
} from '../support/uc03/state-fixtures.ts';

/* ------------------------------------------------------------------
 * 1. Port Provenance & Production Guard Rejection
 * ------------------------------------------------------------------ */

test('Port provenance: MemoryStatePort and ScriptedApprovalPort declare mock provenance', (): void => {
  const memoryState = new MemoryStatePort();
  const scriptedApproval = new ScriptedApprovalPort();

  assert.equal(memoryState.provenance, 'mock');
  assert.equal(scriptedApproval.provenance, 'mock');
});

test('Production guard: rejects mock ports without permissive fallback', (): void => {
  const memoryState = new MemoryStatePort();
  const scriptedApproval = new ScriptedApprovalPort();

  assert.equal(isAdmittedForProduction([memoryState]), false);
  assert.equal(isAdmittedForProduction([scriptedApproval]), false);
  assert.equal(isAdmittedForProduction([memoryState, scriptedApproval]), false);
});

/* ------------------------------------------------------------------
 * 2. MemoryStatePort Cloned Snapshots & CAS Versioning
 * ------------------------------------------------------------------ */

test('MemoryStatePort: loads cloned snapshots preventing external mutation leaks', async (): Promise<void> => {
  const initial = createTestTaskState();
  const statePort = new MemoryStatePort({ initialTaskState: initial });

  const loaded1 = await statePort.loadTask(initial.taskId);
  assert.ok(loaded1);
  assert.equal(loaded1.taskId, initial.taskId);

  // External mutation of loaded state must not corrupt internal store
  (loaded1 as { taskId: string }).taskId = 'corrupted-external-id';
  const loaded2 = await statePort.loadTask(initial.taskId);
  assert.ok(loaded2);
  assert.equal(loaded2.taskId, initial.taskId);
});

test('MemoryStatePort CAS: successful sequential state transition', async (): Promise<void> => {
  const initial = createTestTaskState();
  const statePort = new MemoryStatePort({ initialTaskState: initial });

  const nextState = {
    ...initial,
    stateVersion: 2,
    node: 'Investigate' as const,
    nextAction: 'Proceed to investigation',
  };

  const transitioned = await statePort.transition(nextState, 1);
  assert.equal(transitioned.stateVersion, 2);
  assert.equal(transitioned.node, 'Investigate');
  assert.equal(transitioned.nextAction, 'Proceed to investigation');

  const current = await statePort.loadTask(initial.taskId);
  assert.ok(current);
  assert.equal(current.stateVersion, 2);
  assert.equal(current.node, 'Investigate');
});

test('MemoryStatePort CAS conflict: rejects stale expectedVersion with StateConflictError', async (): Promise<void> => {
  const initial = createTestTaskState();
  const statePort = new MemoryStatePort({ initialTaskState: initial });

  const nextState = {
    ...initial,
    stateVersion: 2,
    node: 'Investigate' as const,
    nextAction: 'Proceed to investigation',
  };

  // Expected version is 0 instead of current 1
  await assert.rejects(
    async () => statePort.transition(nextState, 0),
    (err: unknown) => {
      assert.ok(err instanceof StateConflictError);
      assert.equal(err.code, 'CAS_CONFLICT');
      return true;
    }
  );
});

test('MemoryStatePort CAS conflict: rejects non-sequential next stateVersion', async (): Promise<void> => {
  const initial = createTestTaskState();
  const statePort = new MemoryStatePort({ initialTaskState: initial });

  const invalidVersionState = {
    ...initial,
    stateVersion: 3, // Skipped version 2
    node: 'Investigate' as const,
  };

  await assert.rejects(
    async () => statePort.transition(invalidVersionState, 1),
    (err: unknown) => {
      assert.ok(err instanceof StateConflictError);
      assert.equal(err.code, 'CAS_CONFLICT');
      return true;
    }
  );
});

/* ------------------------------------------------------------------
 * 3. Single Budget Reservation (reserve)
 * ------------------------------------------------------------------ */

test('MemoryStatePort reserve: grants reservation within limits', async (): Promise<void> => {
  const ledgers = createTestLedgers();
  const statePort = new MemoryStatePort({ initialLedgers: ledgers });

  const resId = await statePort.reserve('task', 'tokens', 10000, 'act-tok-01');
  assert.ok(resId);
  assert.ok(typeof resId === 'string');

  // Check that capacity was reduced
  const resId2 = await statePort.reserve('task', 'tokens', 85000, 'act-tok-02');
  assert.ok(resId2);

  // Exceeding remaining budget throws BudgetExhaustionError
  await assert.rejects(
    async () => statePort.reserve('task', 'tokens', 10000, 'act-tok-03'),
    (err: unknown) => {
      assert.ok(err instanceof BudgetExhaustionError);
      assert.equal(err.code, 'BUDGET_EXHAUSTED');
      return true;
    }
  );
});

test('MemoryStatePort reserve: idempotent exact request reservation reuse', async (): Promise<void> => {
  const ledgers = createTestLedgers();
  const statePort = new MemoryStatePort({ initialLedgers: ledgers });

  const resId1 = await statePort.reserve('task', 'tokens', 5000, 'act-idem-01');
  const resId2 = await statePort.reserve('task', 'tokens', 5000, 'act-idem-01');
  assert.equal(resId1, resId2);

  // Different requested amount for same actionId throws BudgetConflictError
  await assert.rejects(
    async () => statePort.reserve('task', 'tokens', 6000, 'act-idem-01'),
    (err: unknown) => {
      assert.ok(err instanceof BudgetConflictError);
      assert.equal(err.code, 'BUDGET_CONFLICT');
      return true;
    }
  );
});

/* ------------------------------------------------------------------
 * 4. Multi-Budget Atomic reserveMany (ALL or NONE)
 * ------------------------------------------------------------------ */

test('MemoryStatePort reserveMany: atomic ALL or NONE on partial exhaustion', async (): Promise<void> => {
  const ledgers = createTestLedgers();
  const statePort = new MemoryStatePort({
    initialLedgers: ledgers,
    currentTaskId: 'task-uc03-test-001',
    currentRunId: 'run-mock-001',
  });

  // Request where run cost exhausts (limit is 2.0, requested is 3.5)
  const items = [
    { scope: 'task' as const, kind: 'tokens', amount: 5000 },
    { scope: 'task' as const, kind: 'cost', amount: 0.1 },
    { scope: 'run' as const, kind: 'tokens', amount: 5000 },
    { scope: 'run' as const, kind: 'cost', amount: 3.5 }, // Exceeds 2.0
  ];

  await assert.rejects(
    async () => statePort.reserveMany(items, 'req-exhausted-01'),
    (err: unknown) => {
      assert.ok(err instanceof BudgetExhaustionError);
      assert.equal(err.code, 'BUDGET_EXHAUSTED');
      return true;
    }
  );

  // Verify NONE of the ledgers were mutated
  const taskTokenRes = await statePort.reserve('task', 'tokens', 100000, 'verify-untouched');
  assert.ok(taskTokenRes);
});

test('MemoryStatePort reserveMany: successful bundle creation conforming to validator and dispatch admission', async (): Promise<void> => {
  const ledgers = createTestLedgers();
  const taskId = 'task-uc03-test-001';
  const runId = 'run-mock-001';
  const statePort = new MemoryStatePort({
    initialLedgers: ledgers,
    currentTaskId: taskId,
    currentRunId: runId,
  });

  const items = [
    { scope: 'task' as const, kind: 'tokens', amount: 15000 },
    { scope: 'task' as const, kind: 'cost', amount: 0.25 },
    { scope: 'run' as const, kind: 'tokens', amount: 15000 },
    { scope: 'run' as const, kind: 'cost', amount: 0.25 },
  ];

  const bundle = await statePort.reserveMany(items, 'req-prov-001', 'tx-test-atomic-001');
  const bundleValidation = validateReservationBundle(bundle);
  assert.equal(bundleValidation.ok, true);

  // Idempotent reuse of exact reservation bundle
  const bundleReuse = await statePort.reserveMany(items, 'req-prov-001', 'tx-test-atomic-001');
  assert.equal(bundleReuse.bundleId, bundle.bundleId);
  assert.equal(bundleReuse.transactionRef, bundle.transactionRef);

  // Conflicting reservation under same requestId throws BudgetConflictError
  await assert.rejects(
    async () => statePort.reserveMany(
      [{ scope: 'task' as const, kind: 'tokens', amount: 20000 }],
      'req-prov-001'
    ),
    (err: unknown) => {
      assert.ok(err instanceof BudgetConflictError);
      assert.equal(err.code, 'BUDGET_CONFLICT');
      return true;
    }
  );

  // Validate dispatch admission with the created bundle
  const provReq: ProviderRequest = {
    providerRequestId: 'req-prov-001',
    taskId,
    runId,
    role: 'coder',
    purpose: 'Generate patch proposal',
    providerId: 'provider-test',
    modelId: 'model-test',
    configId: 'config-uc03-v1',
    pricingPolicyId: 'pricing-v1',
    contextDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    timeoutMs: 30000,
    maxInputTokens: 10000,
    maxOutputTokens: 5000,
    maxBillableTokens: 15000,
    maxCostUsd: 0.25,
    reservationRef: bundle.bundleId,
    dispatchState: 'reserved',
  };

  const dispatchContext: DispatchAdmissionContext = {
    expectedRequest: provReq,
    storedRequests: [provReq],
    taskAccountingStatus: 'healthy',
    transactionRef: bundle.transactionRef,
    ledgerIdentities: statePort.getLedgerIdentities(),
    requireRunReviewIteration: false,
    reservationIds: statePort.getReservationIds(),
    ledgers: statePort.getLedgers(),
    reservationBundle: bundle,
  };

  const dispatchRes = validateDispatchAdmission(provReq, dispatchContext);
  assert.equal(dispatchRes.ok, true);
});

/* ------------------------------------------------------------------
 * 5. Settlement & Malformed Provider Usage Handling
 * ------------------------------------------------------------------ */

test('MemoryStatePort settle: settles reservation against observed provider usage', async (): Promise<void> => {
  const ledgers = createTestLedgers();
  const statePort = new MemoryStatePort({ initialLedgers: ledgers });

  await statePort.reserve('task', 'tokens', 10000, 'act-settle-01');
  await statePort.reserve('task', 'cost', 0.20, 'act-settle-01');

  const observed = createTestProviderUsage({
    inputTokens: 3000,
    outputTokens: 1000,
    costUsd: 0.08,
    billableTokens: 4000,
  });

  await statePort.settle('act-settle-01', observed);

  // Verify reservations were released and consumed was incremented
  const currentLedgers = statePort.getLedgers();
  const tokenLedger = currentLedgers.find((l) => l.scope === 'task' && l.kind === 'tokens');
  const costLedger = currentLedgers.find((l) => l.scope === 'task' && l.kind === 'cost');

  assert.ok(tokenLedger);
  assert.ok(costLedger);
  assert.equal(tokenLedger.consumed, 4000);
  assert.equal(costLedger.consumed, 0.08);
  assert.equal(tokenLedger.reservations.length, 0);
  assert.equal(costLedger.reservations.length, 0);
});

test('MemoryStatePort settle: settles observed usage from malformed provider response', async (): Promise<void> => {
  const ledgers = createTestLedgers();
  const statePort = new MemoryStatePort({ initialLedgers: ledgers });

  await statePort.reserve('task', 'tokens', 5000, 'act-malformed-01');
  await statePort.reserve('task', 'cost', 0.10, 'act-malformed-01');

  // Even when provider returns an unparsable response, usage was consumed and must be settled
  const malformedUsage = createTestProviderUsage({
    inputTokens: 4800,
    outputTokens: 50,
    costUsd: 0.09,
    billableTokens: 4850,
  });

  await statePort.settle('act-malformed-01', malformedUsage);

  const currentLedgers = statePort.getLedgers();
  const tokenLedger = currentLedgers.find((l) => l.scope === 'task' && l.kind === 'tokens');
  assert.ok(tokenLedger);
  assert.equal(tokenLedger.consumed, 4850);
});

/* ------------------------------------------------------------------
 * 6. Uncertain Requests & Explicit Reconciliation
 * ------------------------------------------------------------------ */

test('MemoryStatePort reconcileUncertain: retains conservative charge without blind release', async (): Promise<void> => {
  const ledgers = createTestLedgers();
  const statePort = new MemoryStatePort({ initialLedgers: ledgers, reconciliationUsage: {'req-uncertain-01': createTestProviderUsage({inputTokens:7500, outputTokens:200,costUsd:0.14,billableTokens:7700})} });

  await statePort.reserve('task', 'tokens', 8000, 'req-uncertain-01');
  await statePort.reserve('task', 'cost', 0.15, 'req-uncertain-01');

  // Reconcile without observed usage evidence must NOT blindly release the reservation
  await statePort.reconcileUncertain('req-uncertain-01', {
    reason: 'Connection timed out prior to response',
  });

  const currentLedgers = statePort.getLedgers();
  const tokenLedger = currentLedgers.find((l) => l.scope === 'task' && l.kind === 'tokens');
  assert.ok(tokenLedger);
  // Reservation charge remains retained
  assert.equal(tokenLedger.reservations.some((r) => r.keyedId === 'req-uncertain-01'), true);

  // Now reconcile with explicit verified observed usage evidence
  const verifiedUsage = createTestProviderUsage({
    inputTokens: 7500,
    outputTokens: 200,
    costUsd: 0.14,
    billableTokens: 7700,
  });

  await statePort.reconcileUncertain('req-uncertain-01', {
    observedUsage: verifiedUsage,
    reason: 'Retrieved usage from provider audit log',
  });

  const settledLedgers = statePort.getLedgers();
  const settledTokenLedger = settledLedgers.find((l) => l.scope === 'task' && l.kind === 'tokens');
  assert.ok(settledTokenLedger);
  assert.equal(settledTokenLedger.consumed, 7700);
  assert.equal(settledTokenLedger.reservations.some((r) => r.keyedId === 'req-uncertain-01'), false);
});

/* ------------------------------------------------------------------
 * 7. Checkpoint and Recovery (Spent / Outstanding Preserved)
 * ------------------------------------------------------------------ */

test('MemoryStatePort checkpoint & recover: preserves task context, version, and accounting across runs', async (): Promise<void> => {
  const initial = createTestTaskState();
  const statePort = new MemoryStatePort({ initialTaskState: initial });

  await statePort.reserve('task', 'tokens', 12000, 'act-checkpoint-res');
  const ledgers = statePort.getLedgers();

  const checkpointState = {
    ...initial,
    stateVersion: 2,
    node: 'Investigate' as const,
    nextAction: 'Investigation completed, awaiting plan',
    budgetLedgers: ledgers,
  };

  await statePort.checkpoint(checkpointState);

  const recovered = await statePort.recover(initial.taskId);
  const valRes = validateTaskState(recovered);
  assert.equal(valRes.ok, true);
  assert.equal(recovered.stateVersion, 2);
  assert.equal(recovered.node, 'Investigate');
  assert.equal(recovered.nextAction, 'Investigation completed, awaiting plan');
  assert.ok(recovered.budgetLedgers);

  const tokenLedger = recovered.budgetLedgers.find((l) => l.scope === 'task' && l.kind === 'tokens');
  assert.ok(tokenLedger);
  assert.equal(tokenLedger.reservations.some((r) => r.keyedId === 'act-checkpoint-res'), true);
});

test('MemoryStatePort checkpoint & recover: rejects tasks without a checkpoint', async (): Promise<void> => {
  const initial = createTestTaskState();
  const statePort = new MemoryStatePort();
  await statePort.transition(initial, 0);
  await assert.rejects(statePort.recover(initial.taskId), /No checkpoint found/);
});

test('MemoryStatePort checkpoint & recover: restores the checkpoint version with current accounting', async (): Promise<void> => {
  const initial = createTestTaskState();
  const statePort = new MemoryStatePort({ initialTaskState: initial });
  await statePort.checkpoint(initial);
  await statePort.transition({
    ...initial,
    stateVersion: 2,
    node: 'Investigate',
    nextAction: 'Uncheckpointed investigation',
  }, 1);
  await statePort.reserve('task', 'tokens', 1000, 'after-checkpoint');

  const current = await statePort.loadTask(initial.taskId);
  assert.equal(current?.stateVersion, 2);
  const recovered = await statePort.recover(initial.taskId);
  assert.equal(recovered.stateVersion, 1);
  assert.equal(recovered.node, 'Validate');
  assert.equal(recovered.nextAction, initial.nextAction);
  const tokenLedger = recovered.budgetLedgers?.find((l) => l.scope === 'task' && l.kind === 'tokens');
  assert.ok(tokenLedger);
  assert.equal(tokenLedger.reservations.some((r) => r.keyedId === 'after-checkpoint' && r.amount === 1000), true);
});

/* ------------------------------------------------------------------
 * 8. ScriptedApprovalPort Classification & Action Recording
 * ------------------------------------------------------------------ */

test('ScriptedApprovalPort classify: returns explicit scripted permission and records actions without autoapprove', async (): Promise<void> => {
  const approvalPort = new ScriptedApprovalPort({
    classifications: {
      'pytest -q tests/test_calculator.py': 'ALLOWED',
      'rm -rf /': 'FORBIDDEN',
    },
  });

  const allowedAction = createTestAction({ argv: ['-q', 'tests/test_calculator.py'] });
  assert.equal(await approvalPort.classify(allowedAction), 'ALLOWED');

  const forbiddenAction = createTestAction({ executable: 'rm', argv: ['-rf', '/'] });
  assert.equal(await approvalPort.classify(forbiddenAction), 'FORBIDDEN');

  // Unscripted action must NOT autoapprove; returns APPROVAL_REQUIRED
  const unscriptedAction = createTestAction({ actionId: 'act-unknown', argv: ['-q', 'tests/test_unknown.py'] });
  assert.equal(await approvalPort.classify(unscriptedAction), 'APPROVAL_REQUIRED');

  // Recorded attempted actions
  const attempted = approvalPort.getAttemptedActions();
  assert.equal(attempted.length, 3);
  assert.equal(attempted[0]?.actionId, allowedAction.actionId);
  assert.equal(attempted[1]?.actionId, forbiddenAction.actionId);
  assert.equal(attempted[2]?.actionId, unscriptedAction.actionId);
});

/* ------------------------------------------------------------------
 * 9. ScriptedApprovalPort Decisions & Stale Context Validation
 * ------------------------------------------------------------------ */

test('ScriptedApprovalPort requestDecision & validateBinding: enforces trusted current context', async (): Promise<void> => {
  const binding = createTestApprovalBinding({ status: 'approved' });
  const approvalPort = new ScriptedApprovalPort({
    decisions: [binding],
  });

  const requested = await approvalPort.requestDecision(binding);
  assert.equal(requested.status, 'approved');

  const validContext: ApprovalBindingContext = {
    currentTaskId: binding.taskId,
    currentWorkspaceId: binding.workspaceId,
    currentRepositoryRevisionDigest: binding.repositoryRevisionDigest,
    currentPolicyId: binding.policyId,
    currentPolicyVersion: binding.policyVersion,
    currentNormalizedActionDigest: binding.normalizedActionDigest,
  };

  // Valid binding with matching context
  assert.equal(await approvalPort.validateBinding(binding, validContext), true);

  // Stale repo revision digest
  const staleRepoContext: ApprovalBindingContext = {
    ...validContext,
    currentRepositoryRevisionDigest: 'sha256:different-repo-revision',
  };
  assert.equal(await approvalPort.validateBinding(binding, staleRepoContext), false);

  // Stale action digest
  const staleActionContext: ApprovalBindingContext = {
    ...validContext,
    currentNormalizedActionDigest: 'sha256:different-action-digest',
  };
  assert.equal(await approvalPort.validateBinding(binding, staleActionContext), false);
});

test('ScriptedApprovalPort rejection: cannot become approval without scripted human/test input', async (): Promise<void> => {
  const rejectedBinding = createTestApprovalBinding({ status: 'rejected', reason: 'Unsafe command' });
  const approvalPort = new ScriptedApprovalPort({
    decisions: [rejectedBinding],
  });

  const res = await approvalPort.requestDecision(rejectedBinding);
  assert.equal(res.status, 'rejected');

  const validContext: ApprovalBindingContext = {
    currentTaskId: rejectedBinding.taskId,
    currentWorkspaceId: rejectedBinding.workspaceId,
    currentRepositoryRevisionDigest: rejectedBinding.repositoryRevisionDigest,
    currentPolicyId: rejectedBinding.policyId,
    currentPolicyVersion: rejectedBinding.policyVersion,
    currentNormalizedActionDigest: rejectedBinding.normalizedActionDigest,
  };

  // Rejection cannot validate as approved
  assert.equal(await approvalPort.validateBinding(res, validContext), false);

  // Attempting to validate a mutated binding with 'approved' status fails because decisionId was rejected
  const fakeApproved = { ...res, status: 'approved' as const };
  assert.equal(await approvalPort.validateBinding(fakeApproved, validContext), false);

  // Explicit scripted human/test input allows override
  approvalPort.scriptDecision(fakeApproved);
  assert.equal(await approvalPort.validateBinding(fakeApproved, validContext), true);
});

test('ScriptedApprovalPort resolve: resolves queued decisions by decisionId', async (): Promise<void> => {
  const pendingBinding = createTestApprovalBinding({
    decisionId: 'dec-queue-001',
    status: 'pending',
  });
  const approvedBinding = {
    ...pendingBinding,
    status: 'approved' as const,
    reason: 'Approved after manual review',
  };

  const approvalPort = new ScriptedApprovalPort({
    decisions: [pendingBinding],
  });

  const pending = await approvalPort.requestDecision(pendingBinding);
  assert.equal(pending.status, 'pending');

  approvalPort.scriptDecision(approvedBinding);
  const resolved = await approvalPort.resolve('dec-queue-001');
  assert.equal(resolved.status, 'approved');
  assert.equal(resolved.reason, 'Approved after manual review');
});


test('repair: reserveMany validation and collisions are atomic', async () => {
 const port = new MemoryStatePort({currentTaskId:'task-uc03-test-001',currentRunId:'run-mock-001',initialLedgers:createTestLedgers()});
 await port.reserve('task','cost',0.1,'r');
 const before = [port.getLedgers(),port.getReservationIds()];
 await assert.rejects(port.reserveMany([{scope:'task',kind:'tokens',amount:1},{scope:'task',kind:'cost',amount:0.1}], 'r'));
 assert.deepEqual([port.getLedgers(),port.getReservationIds()],before);
 await assert.rejects(port.reserveMany([{scope:'task',kind:'tokens',amount:1}], 'new',''));
 assert.deepEqual([port.getLedgers(),port.getReservationIds()],before);
});
test('repair: stale checkpoints cannot erase current accounting', async () => {
 const initial=createTestTaskState(); const port=new MemoryStatePort({initialTaskState:initial});
 await port.reserve('task','tokens',100,'a');
 assert.deepEqual((await port.loadTask(initial.taskId))?.budgetLedgers,port.getLedgers());
 await assert.rejects(port.checkpoint(initial));
 await port.settle('a',createTestProviderUsage());
 await assert.rejects(port.checkpoint(initial));
 await assert.rejects(port.reserve('task','tokens',100,'a'));
});
test('repair: freeform uncertainty never authorizes release', async () => {
 const port=new MemoryStatePort({currentTaskId:'task-uc03-test-001',currentRunId:'run-mock-001',initialLedgers:createTestLedgers()});
 await port.reserve('task','tokens',100,'a'); const before=port.getLedgers();
 await port.reconcileUncertain('a',{reason:'verified-non-dispatch'});
 assert.deepEqual(port.getLedgers(),before);
 await assert.rejects(port.reserve('task','tokens',100,'a'));
});
test('repair: approvals require configured complete identity', async () => {
 const binding=createTestApprovalBinding({status:'approved'}); const port=new ScriptedApprovalPort();
 await assert.rejects(port.requestDecision(binding));
 assert.equal(await port.validateBinding(binding),false);
 const scripted=new ScriptedApprovalPort({decisions:[binding]});
 await assert.rejects(scripted.requestDecision({...binding,taskId:'other'}));
});
test('repair: initial CAS and duplicate restore reject', async () => {
 await assert.rejects(new MemoryStatePort().transition(createTestTaskState({stateVersion:9}),0));
 const ledger=createTestLedgers()[0]; assert.ok(ledger);
 assert.throws(()=>new MemoryStatePort({initialLedgers:[ledger,ledger]}));
});

test('repair: bundle retries reject changed transaction, duplicates and terminal reuse', async () => {
 const port=new MemoryStatePort({currentTaskId:'task-uc03-test-001',currentRunId:'run-mock-001',initialLedgers:createTestLedgers()});
 const items=[{scope:'task' as const,kind:'tokens',amount:100},{scope:'task' as const,kind:'cost',amount:0.1}];
 await port.reserveMany(items,'a','tx'); const before=[port.getLedgers(),port.getReservationIds()];
 const first=items[0]; assert.ok(first);
 await assert.rejects(port.reserveMany([first,first],'a','tx'));
 await assert.rejects(port.reserveMany(items,'a','different'));
 await assert.rejects(port.reserveMany(items,'other','tx'));
 assert.deepEqual([port.getLedgers(),port.getReservationIds()],before);
 const usage=createTestProviderUsage(); await port.settle('a',usage);
 const settled=port.getLedgers(); await port.settle('a',usage); assert.deepEqual(port.getLedgers(),settled);
 await assert.rejects(port.reserveMany(items,'a','tx'));
 await assert.rejects(port.settle('a',createTestProviderUsage({costUsd:0.04})));
});
test('repair: late settlement validation failure is atomic', async () => {
 const ledgers=createTestLedgers().map(l=>l.scope==='task' && l.kind==='cost'?{...l,limit:Number.MAX_VALUE,consumed:Number.MAX_VALUE/2}:l);
 const port=new MemoryStatePort({initialLedgers:ledgers});
 await port.reserve('task','tokens',100,'a'); await port.reserve('task','cost',0.1,'a');
 const before=[port.getLedgers(),port.getReservationIds()];
 await assert.rejects(port.settle('a',createTestProviderUsage({costUsd:Number.MAX_VALUE})));
 assert.deepEqual([port.getLedgers(),port.getReservationIds()],before);
});
test('repair: unconfigured observed uncertainty cannot settle', async () => {
 const port=new MemoryStatePort({currentTaskId:'task-uc03-test-001',currentRunId:'run-mock-001',initialLedgers:createTestLedgers()}); await port.reserve('task','tokens',100,'a');
 const before=port.getLedgers();
 await assert.rejects(port.reconcileUncertain('a',{reason:'audit',observedUsage:createTestProviderUsage()}));
 assert.deepEqual(port.getLedgers(),before);
});
test('repair: trusted approval context cloned and freshness required', async () => {
 const binding=createTestApprovalBinding({status:'approved'});
 const context: ApprovalBindingContext={currentTaskId:binding.taskId,currentWorkspaceId:binding.workspaceId,currentRepositoryRevisionDigest:binding.repositoryRevisionDigest,currentPolicyId:binding.policyId,currentPolicyVersion:binding.policyVersion,currentNormalizedActionDigest:binding.normalizedActionDigest};
 const port=new ScriptedApprovalPort({decisions:[binding],currentContext:context});
 (context as {currentTaskId:string}).currentTaskId='mutated';
 assert.equal(await port.validateBinding(binding),true);
 const clean={...context,currentTaskId:binding.taskId};
 for (const key of Object.keys(clean)) assert.equal(await port.validateBinding(binding,{...clean,[key]:'stale'}),false);
 assert.equal(await new ScriptedApprovalPort({decisions:[binding]}).validateBinding(binding),false);
 const forbidden=new ScriptedApprovalPort({decisions:[binding],classifications:{run_command:'FORBIDDEN'}});
 await forbidden.classify(createTestAction());
 assert.equal(await forbidden.validateBinding(binding,clean),false);
 await assert.rejects(forbidden.requestDecision(binding));
});

test('repair: restored bundle retains canonical fresh receipt and rejects duplicates', async () => {
 const original=new MemoryStatePort({currentTaskId:'task-uc03-test-001',currentRunId:'run-mock-001',initialLedgers:createTestLedgers()});
 const items=[{scope:'task' as const,kind:'tokens',amount:100}];
 const bundle=await original.reserveMany(items,'a','tx');
 const restored=new MemoryStatePort({currentTaskId:'task-uc03-test-001',currentRunId:'run-mock-001',initialLedgers:original.getLedgers(),initialBundles:{a:bundle}});
 assert.deepEqual(await restored.reserveMany(items,'a','tx'),bundle);
 assert.deepEqual(restored.getReservationIds(),original.getReservationIds());
 assert.throws(()=>new MemoryStatePort({currentTaskId:'task-uc03-test-001',currentRunId:'run-mock-001',initialLedgers:original.getLedgers(),initialBundles:{a:bundle,b:bundle}}));
});
test('repair: run changes and stale duplicate checkpoints cannot reset accounting', async () => {
 const initial=createTestTaskState(); const port=new MemoryStatePort({initialTaskState:initial});
 await port.reserve('task','tokens',10,'a');
 await assert.rejects(port.transition({...initial,stateVersion:2,node:'Investigate',runId:'new'},1));
 const next={...initial,stateVersion:2,node:'Investigate' as const,budgetLedgers:port.getLedgers()};
 await port.checkpoint(next); await port.checkpoint(next);
 await assert.rejects(port.checkpoint({...next,nextAction:'different'}));
 assert.throws(()=>new MemoryStatePort({initialTaskState:next,currentRunId:'new'}));
});

test('repair: fix-plan freshness compares every trusted vector', async () => {
 const binding=createTestApprovalBinding({status:'approved',actionKind:'fix_plan',planVersion:1,strategyDigest:'sha256:strategy',baselineRef:'baseline',evidenceRefs:['evidence'],criteriaDigest:'sha256:criteria',checkSetDigest:'sha256:checks'});
 const context: ApprovalBindingContext={currentTaskId:binding.taskId,currentWorkspaceId:binding.workspaceId,currentRepositoryRevisionDigest:binding.repositoryRevisionDigest,currentPolicyId:binding.policyId,currentPolicyVersion:binding.policyVersion,currentNormalizedActionDigest:binding.normalizedActionDigest,currentPlanVersion:1,currentStrategyDigest:binding.strategyDigest,currentBaselineRef:binding.baselineRef,currentEvidenceRefs:binding.evidenceRefs,currentCriteriaDigest:binding.criteriaDigest,currentCheckSetDigest:binding.checkSetDigest};
 const port=new ScriptedApprovalPort({decisions:[binding]});
 assert.equal(await port.validateBinding(binding,context),true);
 for (const key of ['currentPlanVersion','currentStrategyDigest','currentBaselineRef','currentEvidenceRefs','currentCriteriaDigest','currentCheckSetDigest']) {
   const stale=key==='currentPlanVersion'?2:key==='currentEvidenceRefs'?['other']:'stale';
   assert.equal(await port.validateBinding(binding,{...context,[key]:stale}),false);
 }
});

test('repair: missing bundle identity rejects atomically', async () => {
 const port=new MemoryStatePort({initialLedgers:createTestLedgers()}); const before=port.getLedgers();
 await assert.rejects(port.reserveMany([{scope:'task',kind:'tokens',amount:1}],'a'));
 assert.deepEqual(port.getLedgers(),before);
});

test('repair: exact current state can checkpoint without transition', async () => {
 const initial=createTestTaskState(); const port=new MemoryStatePort({initialTaskState:initial});
 await port.reserve('task','tokens',10,'a');
 const loaded=await port.loadTask(initial.taskId); assert.ok(loaded);
 await port.checkpoint(loaded);
 assert.deepEqual(await port.recover(initial.taskId),loaded);
 await port.transition({...loaded,stateVersion:2,node:'Investigate'},1);
 const transitioned=await port.loadTask(initial.taskId); assert.ok(transitioned);
 await port.checkpoint(transitioned);
 assert.deepEqual(await port.recover(initial.taskId),transitioned);
});

test('repair: finite trusted transition context admits only fresh approved plan', async () => {
 const plan={planVersion:1,diagnosis:'cause',suspectedCauseLocations:['src/a.ts'],evidenceRefs:['baseline'],strategy:'repair',scopedChanges:['src/a.ts'],checkSetDigest:'sha256:checks',baselineRef:'baseline',strategyDigest:'sha256:strategy',decisionRef:'dec-mock-001'};
 const initial=createTestTaskState({node:'AwaitPlan',plan});
 const next={...initial,stateVersion:2,node:'Patch' as const,activeDecisionId:'dec-mock-001'};
 const binding=createTestApprovalBinding({status:'approved',actionKind:'fix_plan',planVersion:1,strategyDigest:plan.strategyDigest,baselineRef:plan.baselineRef,evidenceRefs:plan.evidenceRefs,criteriaDigest:computeCanonicalSha256(initial.acceptanceCriteria),checkSetDigest:plan.checkSetDigest});
 const freshness: ApprovalBindingContext={currentTaskId:binding.taskId,currentWorkspaceId:binding.workspaceId,currentRepositoryRevisionDigest:binding.repositoryRevisionDigest,currentPolicyId:binding.policyId,currentPolicyVersion:binding.policyVersion,currentNormalizedActionDigest:binding.normalizedActionDigest,currentPlanVersion:binding.planVersion,currentStrategyDigest:binding.strategyDigest,currentBaselineRef:binding.baselineRef,currentEvidenceRefs:binding.evidenceRefs,currentCriteriaDigest:binding.criteriaDigest,currentCheckSetDigest:binding.checkSetDigest};
 const scripts={2:{approval:{binding,freshness}}};
 const fresh=new MemoryStatePort({initialTaskState:initial,transitionContexts:scripts});
 (freshness as {currentTaskId:string}).currentTaskId='caller-mutated';
 assert.equal((await fresh.transition(next,1)).node,'Patch');
 await assert.rejects(new MemoryStatePort({initialTaskState:initial}).transition(next,1));
 await assert.rejects(new MemoryStatePort({initialTaskState:initial,transitionContexts:scripts}).transition(next,1));
 assert.throws(()=>new MemoryStatePort({transitionContexts:{1.5:{}}}));
});

test('repair: settled restored upper bound permits transition at actual usage', async () => {
 const original=new MemoryStatePort({initialTaskState:createTestTaskState()});
 await original.reserve('task','tokens',100,'a');
 const snapshot=await original.loadTask('task-uc03-test-001'); assert.ok(snapshot);
 const restored=new MemoryStatePort({initialTaskState:snapshot});
 await restored.settle('a',createTestProviderUsage({inputTokens:1,outputTokens:0,billableTokens:1}));
 const loaded=await restored.loadTask(snapshot.taskId); assert.ok(loaded);
 assert.equal(loaded.budgetLedgers?.find(l=>l.scope==='task'&&l.kind==='tokens')?.consumed,1);
 const next=await restored.transition({...loaded,stateVersion:2,node:'Investigate'},1);
 await restored.checkpoint(next);
 assert.equal((await restored.recover(snapshot.taskId)).budgetLedgers?.find(l=>l.scope==='task'&&l.kind==='tokens')?.consumed,1);
});
test('repair: snapshot saved by transition does not retain settled upper bound', async () => {
 const port=new MemoryStatePort({initialTaskState:createTestTaskState()});
 await port.reserve('task','tokens',100,'a');
 const reserved=await port.loadTask('task-uc03-test-001'); assert.ok(reserved);
 await port.transition({...reserved,stateVersion:2,node:'Investigate'},1);
 await port.settle('a',createTestProviderUsage({inputTokens:1,outputTokens:0,billableTokens:1}));
 const loaded=await port.loadTask(reserved.taskId); assert.ok(loaded);
 const plan={planVersion:1,diagnosis:'cause',suspectedCauseLocations:['src/a.ts'],evidenceRefs:['baseline'],strategy:'repair',scopedChanges:['src/a.ts'],checkSetDigest:'sha256:checks',baselineRef:'baseline',strategyDigest:'sha256:strategy',decisionRef:'dec-mock-001'};
 const next={...loaded,stateVersion:3,node:'AwaitPlan' as const,plan};
 await port.checkpoint(next);
 assert.equal((await port.recover(reserved.taskId)).budgetLedgers?.find(l=>l.scope==='task'&&l.kind==='tokens')?.consumed,1);
 const current=await port.loadTask(reserved.taskId); assert.ok(current);
 await assert.rejects(port.transition({...current,stateVersion:4,node:'AwaitFeedback',budgetLedgers:createTestLedgers()},3));
});

test('repair: fresh reserved replan remains a next-state admission delta', async () => {
 const initial=createTestTaskState();
 const reservation={proposalId:'proposal',taskId:initial.taskId,configurationId:initial.taskContext?.configId ?? 'missing',priorCount:0,nextCount:1,reservationId:'res-task-replan-proposal'};
 const trusted={replanReservation:reservation};
 const port=new MemoryStatePort({initialTaskState:initial,transitionContexts:{2:trusted,3:{replanReservation:{...reservation,priorCount:1,nextCount:2}}}});
 await port.reserve('task','replan',1,'proposal');
 const loaded=await port.loadTask(initial.taskId); assert.ok(loaded);
 const next={...loaded,stateVersion:2,node:'Investigate' as const,replanCount:1,planVersion:initial.planVersion+1};
 assert.equal(validateStateTransition(initial,next,{trusted}).ok,true);
 assert.equal((await port.transition(next,1)).replanCount,1);
 await assert.rejects(port.transition(next,1));
 const plan={planVersion:3,diagnosis:'cause',suspectedCauseLocations:['src/a.ts'],evidenceRefs:['baseline'],strategy:'repair',scopedChanges:['src/a.ts'],checkSetDigest:'sha256:checks',baselineRef:'baseline',strategyDigest:'sha256:strategy',decisionRef:'dec-mock-001'};
 await assert.rejects(port.transition({...next,stateVersion:3,node:'AwaitPlan',replanCount:2,planVersion:3,plan},2));
 const absent=new MemoryStatePort({initialTaskState:initial});
 await absent.reserve('task','replan',1,'proposal');
 await assert.rejects(absent.transition(next,1));
 const mismatched=new MemoryStatePort({initialTaskState:initial,transitionContexts:{2:{replanReservation:{...reservation,reservationId:'wrong'}}}});
 await mismatched.reserve('task','replan',1,'proposal');
 await assert.rejects(mismatched.transition(next,1));
 const stale=new MemoryStatePort({initialTaskState:initial,transitionContexts:{2:{replanReservation:{...reservation,priorCount:1}}}});
 await stale.reserve('task','replan',1,'proposal');
 await assert.rejects(stale.transition(next,1));
 const missing=new MemoryStatePort({initialTaskState:initial,transitionContexts:{2:trusted}});
 await assert.rejects(missing.transition({...next,budgetLedgers:createTestLedgers()},1));
});

test('repair: settlement absent from saved task cannot be reset by transition', async () => {
 const initial=createTestTaskState(); const port=new MemoryStatePort({initialTaskState:initial});
 await port.reserve('task','tokens',100,'new');
 await port.settle('new',createTestProviderUsage({inputTokens:1,outputTokens:0,billableTokens:1}));
 await assert.rejects(port.transition({...initial,stateVersion:2,node:'Investigate'},1));
 const current=await port.loadTask(initial.taskId); assert.ok(current);
 assert.equal((await port.transition({...current,stateVersion:2,node:'Investigate'},1)).budgetLedgers?.find(l=>l.scope==='task'&&l.kind==='tokens')?.consumed,1);
});
