/** Regression tests for CodeRabbit PR #219 findings (CR-4653752270, CR-4653752302, CR-4653752292, CR-4653752273, CR-4653752312). */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { computeCanonicalSha256, type BugTask, type TaskState } from '../../../src/contracts/foundation/uc03.ts';
import type { PolicyFactsV02 } from '../../../src/approvals/policy.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { DEFAULT_POLICY_PROFILE } from '../../../src/persistence/adapters/approval-types.ts';
import { StatePortStore } from '../../../src/persistence/adapters/state-port-v02-storage.ts';
import { stageClaimReservations } from '../../../src/persistence/adapters/state-port-v02-ledgers.ts';
import { bindIssuedDecision } from '../../../src/persistence/adapters/state-port-v02-verification-records.ts';
import { approvedPlanCoderAdmission } from '../../../src/runtime/real-tier-coder-admission.ts';
import { realTierReviewerAdmission } from '../../../src/runtime/real-tier-reviewer-admission.ts';
import { DEFAULT_CHECK_WORKING_DIRECTORY, verifyCheckAdmission } from '../../../src/runtime/real-tier-verify-admission.ts';
import { createRealTierOwners, observedSyntheticPlan } from '../../../src/runtime/real-tier-owners.ts';
import { fitTokenReservation } from '../../../src/runtime/real-tier-admission-budgets.ts';
import { seedLedgers } from '../../../src/runtime/real-tier-task-seed.ts';
import {
  CHECK_SET_DIGEST,
  OPERATOR,
  POLICY,
  REVISION,
  TASK,
  TEST_DIFF,
  WORKSPACE_ID,
  createFixture,
  iterationLedgersWith,
  makeAssembly,
  makeBinding,
  makeTaskState,
  tokenLedgersWith,
} from '../support/uc03/real-tier-admission-fixture.ts';

// ---------------------------------------------------------------------------
// 1. (4653752270) Coder admission: token fitting to remaining room
// ---------------------------------------------------------------------------
test('CR-4653752270: coder admission sizes token reservation from remaining room split between input and output and refuses when no positive split fits', async () => {
  const split = fitTokenReservation(1500, 1000, 1000);
  assert.ok(split);
  assert.equal(split.maxBillableTokens, 1500);
  assert.equal(split.maxInputTokens, 750);
  assert.equal(split.maxOutputTokens, 750);
  assert.equal(fitTokenReservation(1, 1000, 1000), undefined);
  assert.equal(fitTokenReservation(0, 1000, 1000), undefined);

  const state = makeTaskState('Patch', tokenLedgersWith(1500));
  const f = await createFixture(state);
  const assembly = makeAssembly({ input: 1000, output: 1000 });

  const admission = await approvedPlanCoderAdmission(assembly, TASK, f.port, {
    task: TASK,
    state,
    purpose: 'propose-patch',
    evidence: [],
  });

  assert.ok(admission, 'Coder admission must be granted when request fits remaining room');
  assert.equal(admission.request.maxBillableTokens, 1500);
  assert.equal(admission.request.maxInputTokens, 750);
  assert.equal(admission.request.maxOutputTokens, 750);

  const staged = stageClaimReservations(admission.context, state.budgetLedgers ?? [], 'reserve');
  assert.ok(staged, 'Durable owner atomic reservation check must succeed for sized 1500 tokens');

  const exhaustedState = makeTaskState('Patch', tokenLedgersWith(1));
  await f.stateStore.writeTask(TASK.taskId, exhaustedState);
  const refused = await approvedPlanCoderAdmission(assembly, TASK, f.port, {
    task: TASK,
    state: exhaustedState,
    purpose: 'propose-patch',
    evidence: [],
  });
  assert.equal(refused, undefined, 'Coder admission must refuse when no positive token split fits');
});

// ---------------------------------------------------------------------------
// 2. (4653752302) Reviewer admission: token fitting to remaining room
// ---------------------------------------------------------------------------
test('CR-4653752302: reviewer admission sizes token reservation from remaining room split between input and output and refuses when no positive split fits', async () => {
  const state = makeTaskState('Review', tokenLedgersWith(1500));
  const f = await createFixture(state);
  const assembly = makeAssembly({ input: 1000, output: 1000 });
  const diff = TEST_DIFF;

  const admission = await realTierReviewerAdmission(assembly, TASK, f.port, {
    task: TASK,
    state,
    diff,
    evidence: [],
  });

  assert.ok(admission, 'Reviewer admission must be granted when request fits remaining room');
  assert.equal(admission.request.maxBillableTokens, 1500);
  assert.equal(admission.request.maxInputTokens, 750);
  assert.equal(admission.request.maxOutputTokens, 750);

  const staged = stageClaimReservations(admission.context, state.budgetLedgers ?? [], 'reserve');
  assert.ok(staged, 'Durable owner atomic reservation check must succeed for sized 1500 tokens');

  const exhaustedState = makeTaskState('Review', tokenLedgersWith(0));
  await f.stateStore.writeTask(TASK.taskId, exhaustedState);
  const refused = await realTierReviewerAdmission(assembly, TASK, f.port, {
    task: TASK,
    state: exhaustedState,
    diff,
    evidence: [],
  });
  assert.equal(refused, undefined, 'Reviewer admission must refuse when remaining token room is 0');
});

// ---------------------------------------------------------------------------
// 3. (4653752292) Reviewer admission: cumulative iteration cap in receipt
// ---------------------------------------------------------------------------
test('CR-4653752292: reviewer admission sets cumulative cap in receipt and admits 2nd review while refusing 3rd when cap is 2', async () => {
  const state = makeTaskState('Review', iterationLedgersWith(1));
  const f = await createFixture(state);
  const assembly = makeAssembly();
  const diff = TEST_DIFF;

  const admission = await realTierReviewerAdmission(assembly, TASK, f.port, {
    task: TASK,
    state,
    diff,
    evidence: [],
  });

  assert.ok(admission, 'Reviewer admission must be granted for 2nd review when 1 is consumed of 2 cap');
  assert.equal(admission.context.finiteBounds.maxReviewerIterations, 2, 'maxReviewerIterations in receipt must be the cumulative cap of 2, not remaining room 1');

  const staged = stageClaimReservations(admission.context, state.budgetLedgers ?? [], 'reserve');
  assert.ok(staged, 'Durable owner reservation must admit 2nd review under cumulative cap of 2');

  const state2 = makeTaskState('Review', iterationLedgersWith(2));
  await f.stateStore.writeTask(TASK.taskId, state2);
  const refused3rd = await realTierReviewerAdmission(assembly, TASK, f.port, {
    task: TASK,
    state: state2,
    diff,
    evidence: [],
  });
  assert.equal(refused3rd, undefined, 'Reviewer admission must refuse 3rd review when 2 iterations are consumed');
});

// ---------------------------------------------------------------------------
// 4. (4653752273) real-tier-owners: pass verified policy identity into observedSyntheticPlan
// ---------------------------------------------------------------------------
test('CR-4653752273: real-tier-owners passes verified policy identity (policyId, policyVersion) into observedSyntheticPlan for facts and freshness', async () => {
  const base = mkdtempSync(join(tmpdir(), 'reg-owners-'));
  const store = new DurableStore(join(base, 'store'));
  const owners = createRealTierOwners({
    stateRoot: base,
    revision: REVISION,
    approvalProfileVersion: '1.0.0',
    operator: OPERATOR,
  });

  const taskState = makeTaskState('Verify', seedLedgers(TASK));
  await new StatePortStore(store).writeTask(TASK.taskId, taskState);

  const distinctPolicy = {
    policyId: 'repair-policy',
    policyVersion: '2.0.0',
    configId: 'repair-config',
    configVersion: '1.0.0',
  };

  interface SyntheticContext {
    readonly facts: { readonly policyIdentity: { readonly policyId: string; readonly policyVersion: string; readonly configId: string; readonly configVersion: string } };
    readonly freshness: { readonly currentPolicyId: string; readonly currentPolicyVersion: string };
  }

  const bound = owners.taskOwners({
    taskId: TASK.taskId,
    workspaceId: WORKSPACE_ID,
    repositoryId: TASK.repositoryId,
    policyIdentity: distinctPolicy,
  });

  const decisionId = 'dec-verify-test-1234';
  const synthetic = (await observedSyntheticPlan(TASK.taskId, decisionId, bound.statePort, distinctPolicy)) as SyntheticContext;

  assert.ok(synthetic, 'observedSyntheticPlan must produce synthetic context for dec-verify-*');
  assert.equal(synthetic.facts.policyIdentity.policyId, 'repair-policy');
  assert.equal(synthetic.facts.policyIdentity.policyVersion, '2.0.0');
  assert.equal(synthetic.facts.policyIdentity.configId, 'repair-config');
  assert.equal(synthetic.freshness.currentPolicyId, 'repair-policy');
  assert.equal(synthetic.freshness.currentPolicyVersion, '2.0.0');

  const equalTask: BugTask = { ...TASK, taskId: 'task-equal-1' };
  const equalPolicy = { policyId: 'common-policy', policyVersion: '1.0.0', configId: 'common-policy', configVersion: '1.0.0' };
  const equalState = makeTaskState('Verify', seedLedgers(equalTask), equalTask);
  await new StatePortStore(store).writeTask('task-equal-1', equalState);

  const equalBound = owners.taskOwners({
    taskId: 'task-equal-1',
    workspaceId: WORKSPACE_ID,
    repositoryId: TASK.repositoryId,
    policyIdentity: equalPolicy,
  });

  const equalSynthetic = (await observedSyntheticPlan('task-equal-1', 'dec-verify-equal', equalBound.statePort, equalPolicy)) as SyntheticContext;
  assert.equal(equalSynthetic.facts.policyIdentity.policyId, 'common-policy');
  assert.equal(equalSynthetic.freshness.currentPolicyId, 'common-policy');
});

// ---------------------------------------------------------------------------
// 5. (4653752312) Verify admission: default working directory comparison
// ---------------------------------------------------------------------------
test('CR-4653752312: verify admission compares pinned check without workingDirectory against tests default', async () => {
  assert.equal(DEFAULT_CHECK_WORKING_DIRECTORY, 'tests');

  const pinnedCheckWithoutWd = {
    checkId: 'check-1',
    executable: 'pytest',
    argv: ['tests/test_calc.py'],
    purpose: 'reproduction' as const,
    timeoutMs: 1000,
    maxOutputBytes: 4096,
  };
  const taskWithoutWd: BugTask = { ...TASK, requiredChecks: [pinnedCheckWithoutWd] };
  const state = makeTaskState('Verify', seedLedgers(taskWithoutWd), taskWithoutWd);
  const f = await createFixture(state);
  const assembly = makeAssembly();

  const actionWithTestsWd = {
    actionId: 'action-verify-check-1',
    kind: 'run_command' as const,
    executable: 'pytest',
    argv: ['tests/test_calc.py'],
    purpose: 'reproduction' as const,
    workingDirectory: 'tests',
  };

  const policyFor = (facts: PolicyFactsV02) => ({
    ...DEFAULT_POLICY_PROFILE,
    profileVersion: '1',
    policyIdentity: facts.policyIdentity,
    commandRules: [{ ruleId: 'check-1', executableRef: 'pytest', argvPrefix: ['tests/test_calc.py'], workingDirectoryRef: 'repository-root', timeoutMs: 1000, maxOutputBytes: 4096 }],
  });

  const checkAdmission = (t: BugTask, ch: typeof pinnedCheckWithoutWd, act: typeof actionWithTestsWd, s: TaskState) =>
    verifyCheckAdmission(t, policyFor, assembly, f.port, { check: ch, action: act, currentState: s });

  assert.ok(await checkAdmission(taskWithoutWd, pinnedCheckWithoutWd, actionWithTestsWd, state));
  assert.equal(await checkAdmission(taskWithoutWd, pinnedCheckWithoutWd, { ...actionWithTestsWd, workingDirectory: '.' }, state), undefined);

  const pinnedWithExplicitWd = { ...pinnedCheckWithoutWd, workingDirectory: 'custom/dir' };
  const taskWithExplicitWd: BugTask = { ...TASK, requiredChecks: [pinnedWithExplicitWd] };
  const explicitState = makeTaskState('Verify', seedLedgers(taskWithExplicitWd), taskWithExplicitWd);
  await f.stateStore.writeTask(TASK.taskId, explicitState);

  const explicitDecisionRef = explicitState.plan?.decisionRef ?? 'dec-plan-001';
  const explicitBound = makeBinding('approved', explicitState.plan?.checkSetDigest ?? CHECK_SET_DIGEST, explicitDecisionRef);
  await bindIssuedDecision(f.stateStore, TASK.taskId, {
    decisionId: explicitDecisionRef,
    issuerKeyRef: POLICY.issuerKeyRef,
    decisionAuthorityGeneration: POLICY.decisionAuthorityGeneration,
    bindingDigest: computeCanonicalSha256(explicitBound),
  });

  assert.ok(await checkAdmission(taskWithExplicitWd, pinnedWithExplicitWd, { ...actionWithTestsWd, workingDirectory: 'custom/dir' }, explicitState));
  assert.equal(await checkAdmission(taskWithExplicitWd, pinnedWithExplicitWd, actionWithTestsWd, explicitState), undefined);
});
