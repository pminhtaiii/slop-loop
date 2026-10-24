import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAdmittedForProduction,
  validateReviewAdmission,
  validateModelProposal,
  validateModelResult,
  computeCanonicalSha256,
  computeAttemptOutcomeDigest,
  computeActionDigest,
  computeRequestContentDigest,
  validateRepositoryAdmissionV02,
  type ApplyPatchAction,
  type RunCommandAction,
  type ModelPortResult,
  type ReviewResult,
  type TrustedDiffLines,
  type ProviderAdmissionContextV02,
  type ProviderAdmissionReceiptV02,
  type PolicyAuthorityRefV02,
  type RepositoryAdmissionContextV02,
  type AdmissionContextV02,
  type StatePortV02,
  type ClaimReceiptV02,
  type AttemptReceiptV02,
  type AttemptOutcomeReceiptV02,
  type AttemptReconciliationReceiptV02,
  type ClaimClosureReceiptV02,
  type ExecutorIdentityV02,
  type OutcomeRecordResultV02,
  type ReconciliationResultV02,
  type ClaimClosureResultV02,
  type TaskState,
} from '../../../../src/contracts/foundation/uc03.ts';
import { ScriptedModelPort, ScriptedModelPortV02 } from './scripted-model.ts';
import { ScriptedReviewerPort, ScriptedReviewerPortV02 } from './scripted-reviewer.ts';
import { FakeRepositoryPort, FakeRepositoryPortV02 } from './fake-repository.ts';
import { ScriptedApprovalPort, ScriptedApprovalPortV02 } from './scripted-approval.ts';
import { createTestRepositoryAdmissionTrustedContextV02 } from './state-fixtures.ts';
import {
  createFixtureBugTask,
  createFixtureTaskState,
  createFixtureProviderRequest,
  createFixtureReviewerRequest,
  createFixtureSourceEvidence,
  createFixtureAdmissionContext,
  createFixtureCheckDefinition,
  createFixtureProviderAdmissionContextV02,
  createFixtureRepositoryAdmissionContextV02,
  createFixtureRepositoryCommandAdmissionContextV02,
  createFixturePolicyAuthorityRefV02,
  createFixturePolicyEvaluationReceiptV02,
  createFixtureActionDecisionReceiptV02,
  createFixtureProviderAdmissionReceiptV02,
  createFixtureClaimReceiptV02,
  createFixtureAttemptReceiptV02,
  type BuildAdmissionContextOptions,
} from './port-fixtures.ts';

class RecordingStatePortV02 implements StatePortV02 {
  readonly provenance = 'mock' as const;
  readonly claimCalls: AdmissionContextV02[] = [];
  readonly beginCalls: { readonly claimId: string; readonly executor: ExecutorIdentityV02 }[] = [];
  readonly recordedOutcomes: AttemptOutcomeReceiptV02[] = [];
  readonly recordedOutcomeResults: OutcomeRecordResultV02[] = [];
  readonly claimReceipt: ClaimReceiptV02;
  readonly attemptReceipt: AttemptReceiptV02;

  constructor(claimReceipt: ClaimReceiptV02, attemptReceipt: AttemptReceiptV02) {
    this.claimReceipt = claimReceipt;
    this.attemptReceipt = attemptReceipt;
  }

  async loadTask(taskId: string): Promise<TaskState | null> { void taskId; return null; }
  async transition(state: TaskState, expectedVersion: number): Promise<TaskState> { void expectedVersion; return state; }
  async claim(context: AdmissionContextV02): Promise<ClaimReceiptV02> {
    this.claimCalls.push(context);
    return this.claimReceipt;
  }
  async beginAttempt(claimId: string, executor: ExecutorIdentityV02): Promise<AttemptReceiptV02> {
    this.beginCalls.push({ claimId, executor });
    return this.attemptReceipt;
  }
  async recordOutcome(receipt: AttemptOutcomeReceiptV02): Promise<OutcomeRecordResultV02> {
    this.recordedOutcomes.push(receipt);
    const result: OutcomeRecordResultV02 = {
      outcome: receipt.outcome === 'uncertain' ? 'uncertain' : 'settled',
      receiptId: receipt.receiptId,
    };
    this.recordedOutcomeResults.push(result);
    return result;
  }
  async reconcileObservedOutcome(receipt: AttemptReconciliationReceiptV02): Promise<ReconciliationResultV02> {
    void receipt;
    return { outcome: 'blocked', receiptId: 'unused-observed-reconciliation' };
  }
  async reconcileUncertain(receipt: AttemptReconciliationReceiptV02): Promise<ReconciliationResultV02> {
    void receipt;
    return { outcome: 'blocked', receiptId: 'unused-uncertain-reconciliation' };
  }
  async closeUnattemptedClaim(receipt: ClaimClosureReceiptV02): Promise<ClaimClosureResultV02> {
    return { closed: false, receiptId: receipt.receiptId };
  }
  async checkpoint(state: TaskState): Promise<void> { void state; }
  async recover(taskId: string): Promise<TaskState> { throw new Error(`unused recovery operation: ${taskId}`); }
}

function createRecordingJournal(context: AdmissionContextV02, label: string) {
  const claimId = `claim-journal-${label}`;
  const attemptId = `attempt-journal-${label}`;
  const isRepairPatch = context.subjectKind === 'repository-action' && context.action.kind === 'apply_patch' && context.planApplicability === 'approved-plan';
  const executor: ExecutorIdentityV02 = {
    adapterIdentity: `adapter-${label}`,
    processIncarnation: `process-${label}`,
    fencingGeneration: 7,
    payloadDigest: context.subjectKind === 'provider-request' ? context.requestContentDigest : context.actionDigest,
  };
  const claim = createFixtureClaimReceiptV02({
    claimId,
    claimDigest: '',
    taskId: context.taskId,
    runId: context.runId,
    subjectKind: context.subjectKind,
    planApplicability: context.planApplicability,
    preClaimTaskStateVersion: context.expectedTaskStateVersion,
    preClaimControlVersion: context.expectedControlVersion,
    postClaimControlVersion: context.expectedControlVersion + 1,
    epoch: context.expectedEpoch,
    reservationRefs: context.subjectKind === 'repository-action'
      ? context.reservationRefs
      : [context.requestReservationReceipt, ...context.budgetRefs],
  });
  const attempt = createFixtureAttemptReceiptV02({
    attemptId,
    claimId,
    taskId: context.taskId,
    executorIdentity: executor,
    preAttemptTaskStateVersion: context.expectedTaskStateVersion,
    postBeginTaskStateVersion: context.expectedTaskStateVersion + (isRepairPatch ? 1 : 0),
    preAttemptControlVersion: context.expectedControlVersion + 1,
    postBeginControlVersion: context.expectedControlVersion + 2,
    epoch: context.expectedEpoch,
  });
  return { statePort: new RecordingStatePortV02(claim, attempt), claim, attempt, executor };
}

// ============================================================================
// ScriptedModelPort Tests
// ============================================================================

test('ScriptedModelPort: production guard rejects mock provenance', () => {
  const model = new ScriptedModelPort();
  assert.equal(model.provenance, 'mock');
  assert.equal(isAdmittedForProduction([model]), false);
});

test('ScriptedModelPort: tracks attempted calls vs actual simulated dispatch', async () => {
  const model = new ScriptedModelPort();
  const state = createFixtureTaskState();
  const evidence = [createFixtureSourceEvidence()];
  const { context, request } = createFixtureAdmissionContext();

  model.setAdmissionContext(context);
  model.queueResponse({ outcome: 'observed', result: { proposal: { proposalId: 'explicit-proposal', content: 'scripted' }, observedUsage: { inputTokens: 100, outputTokens: 50, billableTokens: 150, costUsd: 0.005 } } });
  assert.equal(model.attemptedCalls, 0);
  assert.equal(model.simulatedDispatches, 0);

  const res = await model.propose(state, evidence, request);
  assert.equal(model.attemptedCalls, 1);
  assert.equal(model.simulatedDispatches, 1);
  assert.equal(res.outcome, 'observed');
  if (res.outcome === 'observed') {
    assert.equal(res.result.observedUsage.inputTokens <= request.maxInputTokens, true);
    assert.equal(res.result.observedUsage.outputTokens <= request.maxOutputTokens, true);
  }
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0]?.admitted, true);
});

test('ScriptedModelPort: zero dispatch on missing admission context or bare reservation ref', async () => {
  const model = new ScriptedModelPort();
  const state = createFixtureTaskState();
  const evidence = [createFixtureSourceEvidence()];
  const request = createFixtureProviderRequest();

  // No admission context set (bare reservation ref)
  const res = await model.propose(state, evidence, request);
  assert.equal(model.attemptedCalls, 1);
  assert.equal(model.simulatedDispatches, 0);
  assert.equal(res.outcome, 'denied');
  if (res.outcome === 'denied') {
    assert.match(res.reason, /UNTRUSTED_DISPATCH_AUTHORIZATION/);
  }
  assert.equal(model.calls[0]?.admitted, false);
});

test('ScriptedModelPort: zero dispatch on exhausted budget', async () => {
  const model = new ScriptedModelPort();
  const state = createFixtureTaskState();
  const evidence = [createFixtureSourceEvidence()];

  // Exhausted budget (task tokens consumed equals limit)
  const { context: exhaustedContext, request } = createFixtureAdmissionContext({
    taskTokensConsumed: 100000,
    taskTokensLimit: 100000,
  });

  model.setAdmissionContext(exhaustedContext);
  const res = await model.propose(state, evidence, request);
  assert.equal(model.attemptedCalls, 1);
  assert.equal(model.simulatedDispatches, 0);
  assert.equal(res.outcome, 'denied');
  if (res.outcome === 'denied') {
    assert.match(res.reason, /BUDGET_EXHAUSTED/);
  }
});

test('ScriptedModelPort: zero dispatch on partial reservation bundle', async () => {
  const model = new ScriptedModelPort();
  const state = createFixtureTaskState();
  const evidence = [createFixtureSourceEvidence()];

  // Omit run cost reservation from bundle
  const { context: partialContext, request } = createFixtureAdmissionContext({
    omitRunCostRes: true,
  });

  model.setAdmissionContext(partialContext);
  const res = await model.propose(state, evidence, request);
  assert.equal(model.attemptedCalls, 1);
  assert.equal(model.simulatedDispatches, 0);
  assert.equal(res.outcome, 'denied');
  if (res.outcome === 'denied') {
    assert.match(res.reason, /PARTIAL_RESERVATION/);
  }
});

test('ScriptedModelPort: zero dispatch on uncertain stored request history', async () => {
  const model = new ScriptedModelPort();
  const state = createFixtureTaskState();
  const evidence = [createFixtureSourceEvidence()];

  // Stored request history includes an unresolved uncertain request
  const { context: uncertainContext, request } = createFixtureAdmissionContext({
    includeUncertainStoredRequest: true,
  });

  model.setAdmissionContext(uncertainContext);
  const res = await model.propose(state, evidence, request);
  assert.equal(model.attemptedCalls, 1);
  assert.equal(model.simulatedDispatches, 0);
  assert.equal(res.outcome, 'denied');
  if (res.outcome === 'denied') {
    assert.match(res.reason, /UNRESOLVED_ACCOUNTING/);
  }
});

test('ScriptedModelPort: zero dispatch on telemetry estimate context', async () => {
  const model = new ScriptedModelPort();
  const state = createFixtureTaskState();
  const evidence = [createFixtureSourceEvidence()];

  const { context: telemetryContext, request } = createFixtureAdmissionContext({
    isTelemetryEstimate: true,
  });

  model.setAdmissionContext(telemetryContext);
  const res = await model.propose(state, evidence, request);
  assert.equal(model.attemptedCalls, 1);
  assert.equal(model.simulatedDispatches, 0);
  assert.equal(res.outcome, 'denied');
  if (res.outcome === 'denied') {
    assert.match(res.reason, /TELEMETRY_ESTIMATE_CANNOT_AUTHORIZE/);
  }
});

test('ScriptedModelPort: scripts valid proposal, malformed output with observed usage, and uncertain outcome', async () => {
  const model = new ScriptedModelPort();
  const state = createFixtureTaskState();
  const evidence = [createFixtureSourceEvidence()];
  const { context, request } = createFixtureAdmissionContext();
  model.setAdmissionContext(context);

  // 1. Scripted valid proposal with patch action
  const validProposalResponse: ModelPortResult = {
    outcome: 'observed',
    result: {
      proposal: {
        proposalId: 'prop-valid-001',
        content: 'Fix division by zero',
        actions: [
          {
            actionId: 'act-patch-001',
            kind: 'apply_patch',
            patchContent: '--- a/src/calc.py\n+++ b/src/calc.py\n',
            targetPaths: ['src/calculator.py'],
            baseRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
        ],
      },
      observedUsage: {
        inputTokens: 500,
        outputTokens: 200,
        costUsd: 0.02,
        billableTokens: 700,
      },
    },
  };
  assert.equal(validateModelResult(validProposalResponse.result).ok, true);
  assert.equal(validateModelProposal(validProposalResponse.result.proposal).ok, true);

  // 2. Scripted malformed output with observed usage
  const malformedOutputResponse: ModelPortResult = {
    outcome: 'invalid',
    errors: [
      {
        path: 'actions[0].targetPaths',
        message: 'targetPaths targets protected path',
        code: 'PROTECTED_PATH_FORBIDDEN',
      },
    ],
    observedUsage: {
      inputTokens: 400,
      outputTokens: 150,
      costUsd: 0.015,
      billableTokens: 550,
    },
  };

  // 3. Scripted uncertain timeout
  const uncertainResponse: ModelPortResult = {
    outcome: 'uncertain',
    reason: 'Upstream simulated provider timeout after 30000ms',
    observedUsage: {
      inputTokens: 400,
      outputTokens: 0,
      costUsd: 0.008,
      billableTokens: 400,
    },
  };

  model.queueResponses([validProposalResponse, malformedOutputResponse, uncertainResponse]);

  // First call -> valid proposal
  const r1 = await model.propose(state, evidence, request);
  assert.equal(r1.outcome, 'observed');
  if (r1.outcome === 'observed') {
    assert.equal(r1.result.proposal.proposalId, 'prop-valid-001');
  }

  // Second call -> malformed output with billable observed usage
  const r2 = await model.propose(state, evidence, request);
  assert.equal(r2.outcome, 'invalid');
  if (r2.outcome === 'invalid') {
    assert.equal(r2.observedUsage?.costUsd, 0.015);
    assert.equal(r2.errors[0]?.code, 'PROTECTED_PATH_FORBIDDEN');
  }

  // Third call -> uncertain
  const r3 = await model.propose(state, evidence, request);
  assert.equal(r3.outcome, 'uncertain');
  if (r3.outcome === 'uncertain') {
    assert.match(r3.reason, /timeout/);
  }

  assert.equal(model.attemptedCalls, 3);
  assert.equal(model.simulatedDispatches, 3);
});

// ============================================================================
// ScriptedReviewerPort Tests
// ============================================================================

test('ScriptedReviewerPort: production guard rejects mock provenance', () => {
  const reviewer = new ScriptedReviewerPort();
  assert.equal(reviewer.provenance, 'mock');
  assert.equal(isAdmittedForProduction([reviewer]), false);
});

test('ScriptedReviewerPort: enforces reviewer role and iteration reservation', async () => {
  const reviewer = new ScriptedReviewerPort();
  const task = createFixtureBugTask();
  const diff = '--- a/calc.py\n+++ b/calc.py\n@@ -1,1 +1,2 @@\n+if b == 0: raise CalculationError()\n return a / b\n';
  const evidence = [createFixtureSourceEvidence()];
  const { context, request } = createFixtureAdmissionContext({
    request: createFixtureReviewerRequest(),
  });

  reviewer.setAdmissionContext(context);
  reviewer.queueResponse({ reviewId: 'explicit-review', reviewerRoleConfigId: request.configId, repoDigest: task.initialRevisionDigest, diffDigest: computeCanonicalSha256(diff), checkSetDigest: computeCanonicalSha256(task.requiredChecks.map(c => c.checkId)), status: 'accepted', findings: [], iterationReservationRef: request.reservationRef });
  const result = await reviewer.review(task, diff, evidence, request);
  assert.equal(reviewer.attemptedCalls, 1);
  assert.equal(reviewer.simulatedDispatches, 1);
  assert.equal(result.status, 'accepted');
  assert.equal(result.iterationReservationRef, request.reservationRef);
});

test('ScriptedReviewerPort: rejects non-reviewer request role with zero dispatch', async () => {
  const reviewer = new ScriptedReviewerPort();
  const task = createFixtureBugTask();
  const diff = 'some diff';
  const evidence = [createFixtureSourceEvidence()];
  const coderRequest = createFixtureProviderRequest({ role: 'coder' });
  const { context } = createFixtureAdmissionContext({ request: coderRequest });

  reviewer.setAdmissionContext(context);
  await assert.rejects(
    async () => reviewer.review(task, diff, evidence, coderRequest),
    /INVALID_ROLE/
  );
  assert.equal(reviewer.attemptedCalls, 1);
  assert.equal(reviewer.simulatedDispatches, 0);
});

test('ScriptedReviewerPort: zero dispatch when iteration reservation is missing', async () => {
  const reviewer = new ScriptedReviewerPort();
  const task = createFixtureBugTask();
  const diff = 'some diff';
  const evidence = [createFixtureSourceEvidence()];
  const { context, request } = createFixtureAdmissionContext({
    request: createFixtureReviewerRequest(),
    omitReviewerIterationRes: true,
  });

  reviewer.setAdmissionContext(context);
  await assert.rejects(
    async () => reviewer.review(task, diff, evidence, request),
    /PARTIAL_RESERVATION|DISPATCH_ADMISSION_DENIED/
  );
  assert.equal(reviewer.attemptedCalls, 1);
  assert.equal(reviewer.simulatedDispatches, 0);
});

test('ScriptedReviewerPort: zero dispatch on reviewer exhausted token or cost budget', async () => {
  const reviewer = new ScriptedReviewerPort();
  const task = createFixtureBugTask();
  const diff = 'some diff';
  const evidence = [createFixtureSourceEvidence()];
  const { context, request } = createFixtureAdmissionContext({
    request: createFixtureReviewerRequest(),
    taskCostConsumed: 5.0,
    taskCostLimit: 5.0,
  });

  reviewer.setAdmissionContext(context);
  await assert.rejects(
    async () => reviewer.review(task, diff, evidence, request),
    /BUDGET_EXHAUSTED|DISPATCH_ADMISSION_DENIED/
  );
  assert.equal(reviewer.attemptedCalls, 1);
  assert.equal(reviewer.simulatedDispatches, 0);
});

test('ScriptedReviewerPort: scripts findings and validates diff-line membership via canonical validator', async () => {
  const reviewer = new ScriptedReviewerPort();
  const task = createFixtureBugTask();
  const diff = '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -2,2 +2,3 @@\n+    if b == 0: raise CalculationError("Cannot divide by zero")\n';
  const evidence = [createFixtureSourceEvidence()];
  const { context, request } = createFixtureAdmissionContext({
    request: createFixtureReviewerRequest(),
  });
  reviewer.setAdmissionContext(context);

  const diffDigest = computeCanonicalSha256(diff);
  const checkSetDigest = computeCanonicalSha256(task.requiredChecks.map((c) => c.checkId));

  const findingsResult: ReviewResult = {
    reviewId: 'rev-findings-001',
    reviewerRoleConfigId: request.configId,
    repoDigest: task.initialRevisionDigest,
    diffDigest,
    checkSetDigest,
    status: 'findings',
    findings: [
      {
        file: 'src/calculator.py',
        line: 2,
        side: 'new',
        severity: 'warning',
        message: 'Ensure CalculationError is imported from exceptions module',
      },
    ],
    iterationReservationRef: request.reservationRef,
  };

  reviewer.queueResponse(findingsResult);
  const result = await reviewer.review(task, diff, evidence, request);
  assert.equal(result.status, 'findings');
  assert.equal(result.findings.length, 1);

  // Validate diff-line membership via validateReviewAdmission
  const trustedLines: TrustedDiffLines = {
    'src/calculator.py': {
      newLines: [2, 3],
    },
  };

  const admission = validateReviewAdmission(result, {
    expectedReviewId: 'rev-findings-001',
    expectedRepoDigest: task.initialRevisionDigest,
    expectedDiffDigest: diffDigest,
    expectedCheckSetDigest: checkSetDigest,
    expectedRoleConfigId: request.configId,
    expectedIterationReservationRef: request.reservationRef,
    trustedDiffLines: trustedLines,
  });
  assert.equal(admission.ok, true);

  // Line not in diff lines is rejected
  const untrustedLines: TrustedDiffLines = {
    'src/calculator.py': {
      newLines: [99], // line 2 is not in trusted lines
    },
  };
  const deniedAdmission = validateReviewAdmission(result, {
    expectedRepoDigest: task.initialRevisionDigest,
    expectedDiffDigest: diffDigest,
    expectedCheckSetDigest: checkSetDigest,
    expectedRoleConfigId: request.configId,
    trustedDiffLines: untrustedLines,
  });
  assert.equal(deniedAdmission.ok, false);
  if (!deniedAdmission.ok) {
    assert.equal(deniedAdmission.errors[0]?.code, 'LINE_NOT_IN_TRUSTED_DIFF');
  }
});

// ============================================================================
// FakeRepositoryPort Tests
// ============================================================================

test('FakeRepositoryPort: production guard rejects mock provenance', () => {
  const repo = new FakeRepositoryPort();
  assert.equal(repo.provenance, 'mock');
  assert.equal(isAdmittedForProduction([repo]), false);
});

test('FakeRepositoryPort: versioned snapshot reading, listing, and searching', async () => {
  const repo = new FakeRepositoryPort({
    initialFiles: {
      'src/calc.py': 'def add(a, b): return a + b\n',
      'src/utils.py': 'def log(msg): pass\n',
      'tests/test_calc.py': 'assert add(1, 2) == 3\n',
    },
  });

  // readFile
  const fileEvidence = await repo.readFile('src/calc.py');
  assert.equal(fileEvidence.path, 'src/calc.py');
  assert.equal(fileEvidence.boundedExcerpt, 'def add(a, b): return a + b\n');
  assert.equal(repo.reads.includes('src/calc.py'), true);

  // listDir
  const srcListing = await repo.listDir('src');
  assert.deepEqual(srcListing, ['calc.py', 'utils.py']);

  // searchCode
  const searchResults = await repo.searchCode('add(a, b)');
  assert.equal(searchResults.length, 1);
  assert.equal(searchResults[0]?.path, 'src/calc.py');
  assert.equal(repo.searches.includes('add(a, b)'), true);
});

test('FakeRepositoryPort: path protection rejects protected files and traversal escapes', async () => {
  const repo = new FakeRepositoryPort({
    initialFiles: {
      'src/calc.py': 'def divide(a, b): return a / b\n',
      '.env': 'SECRET_KEY=12345',
      'id_rsa': '-----BEGIN RSA PRIVATE KEY-----',
    },
  });

  // Reading protected paths fails closed
  await assert.rejects(async () => repo.readFile('.env'), /PROTECTED_PATH/);
  await assert.rejects(async () => repo.readFile('id_rsa'), /PROTECTED_PATH/);

  // Traversal and non-canonical relative paths fail closed
  await assert.rejects(async () => repo.readFile('../outside.py'), /WORKSPACE_ESCAPE/);
  await assert.rejects(async () => repo.readFile('./src/calc.py'), /WORKSPACE_ESCAPE/);
  await assert.rejects(async () => repo.readFile('/etc/passwd'), /WORKSPACE_ESCAPE/);

  // Listing protected paths fails closed
  await assert.rejects(async () => repo.listDir('.agents'), /PROTECTED_PATH/);

  // Searching excludes protected paths
  const secretsSearch = await repo.searchCode('SECRET_KEY');
  assert.equal(secretsSearch.length, 0); // protected file not searched
});

test('FakeRepositoryPort: applyPatch advances snapshot revision and rejects stale base', async () => {
  const repo = new FakeRepositoryPort();
  const currentRev = repo.currentRevision;

  const validPatch: ApplyPatchAction = {
    actionId: 'act-patch-1',
    kind: 'apply_patch',
    patchContent: '+class CalculationError(Exception): pass\n',
    targetPaths: ['src/calculator.py'],
    baseRevisionDigest: currentRev,
  };

  const patchResult = await repo.applyPatch(validPatch);
  assert.equal(patchResult.applied, true);
  assert.notEqual(patchResult.newRevisionDigest, currentRev);
  assert.equal(repo.currentRevision, patchResult.newRevisionDigest);
  assert.equal(repo.patches.length, 1);

  // Stale base revision is rejected with applied: false
  const stalePatch: ApplyPatchAction = {
    actionId: 'act-patch-2',
    kind: 'apply_patch',
    patchContent: '+more code\n',
    targetPaths: ['src/calculator.py'],
    baseRevisionDigest: 'sha256:stale-rev',
  };
  const staleResult = await repo.applyPatch(stalePatch);
  assert.equal(staleResult.applied, false);
  assert.equal(staleResult.newRevisionDigest, repo.currentRevision);
  assert.equal(repo.patches.length, 2);
});

test('FakeRepositoryPort: runCommand acts strictly as spy and returns scripted diagnostics', async () => {
  const repo = new FakeRepositoryPort();
  await assert.rejects(
    async () => repo.runCommand({
      actionId: 'act-cmd-unscripted',
      kind: 'run_command',
      executable: 'python',
      argv: ['--version'],
      workingDirectory: '.',
    }),
    /SCRIPT_EXHAUSTED/
  );
  assert.equal(repo.commands.length, 1);

  // Scripted command result
  repo.setCommandResult('python --version', {
    exitCode: 0,
    stdout: 'Python 3.11.0 (FakeRepositoryPort)',
    stderr: '',
  });

  const command: RunCommandAction = {
    actionId: 'act-cmd-1',
    kind: 'run_command',
    executable: 'python',
    argv: ['--version'],
    workingDirectory: '.',
  };
  const res1 = await repo.runCommand(command);
  assert.equal(res1.exitCode, 0);
  assert.match(res1.stdout, /FakeRepositoryPort/);
  assert.equal(repo.commands.length, 2);

  // Scripted diagnostic output
  repo.setCommandResult('pytest tests/test_calculator.py -k test_zero', {
    exitCode: 1,
    stdout: 'FAILED tests/test_calculator.py::test_zero - ZeroDivisionError',
    stderr: '',
  });

  const failureCommand: RunCommandAction = {
    actionId: 'act-cmd-2',
    kind: 'run_command',
    executable: 'pytest',
    argv: ['tests/test_calculator.py', '-k', 'test_zero'],
    workingDirectory: 'tests',
  };
  const res2 = await repo.runCommand(failureCommand);
  assert.equal(res2.exitCode, 1);
  assert.match(res2.stdout, /ZeroDivisionError/);
  assert.equal(repo.commands.length, 3);
});

test('FakeRepositoryPort: runTests returns scripted CheckResult with pass/fail/timeout diagnostics', async () => {
  const repo = new FakeRepositoryPort();
  const check = createFixtureCheckDefinition({ checkId: 'check-repro' });

  await assert.rejects(repo.runTests(check), /SCRIPT_EXHAUSTED/);
  assert.equal(repo.tests.length, 1);

  // Scripted passing check result
  repo.setTestResult('check-repro', {
    checkId: 'check-repro',
    outcome: 'pass',
    outputExcerpt: '1 passed in 0.05s (check-repro)',
    durationMs: 50,
  });
  const r1 = await repo.runTests(check);
  assert.equal(r1.checkId, 'check-repro');
  assert.equal(r1.outcome, 'pass');
  assert.equal(repo.tests.length, 2);

  // Scripted failure check result
  repo.setTestResult('check-repro', {
    checkId: 'check-repro',
    outcome: 'fail',
    outputExcerpt: 'FAILED tests/test_calculator.py::test_divide_zero - ZeroDivisionError',
    durationMs: 42,
  });

  const r2 = await repo.runTests(check);
  assert.equal(r2.outcome, 'fail');
  assert.match(r2.outputExcerpt ?? '', /ZeroDivisionError/);
  assert.equal(r2.durationMs, 42);

  // Scripted timeout check result
  repo.setTestResult('check-timeout', {
    checkId: 'check-timeout',
    outcome: 'timeout',
    outputExcerpt: 'Check exceeded 30000ms limit',
    durationMs: 30000,
  });
  const timeoutCheck = createFixtureCheckDefinition({ checkId: 'check-timeout' });
  const r3 = await repo.runTests(timeoutCheck);
  assert.equal(r3.outcome, 'timeout');
});

test('FakeRepositoryPort: runTests rejects invalid scripted check results', async () => {
  const check = createFixtureCheckDefinition();
  const repo = new FakeRepositoryPort({
    testResults: {
      default: { checkId: check.checkId, outcome: 'pass', durationMs: -1 },
    },
  });

  await assert.rejects(repo.runTests(check), /INVALID_CHECK_RESULT/);
  assert.equal(repo.tests.length, 1);
});

test('FakeRepositoryPort: inspectDiff computes or returns versioned diffs', async () => {
  const repo = new FakeRepositoryPort({
    initialFiles: {
      'src/calculator.py': 'class Calculator:\n    def divide(self, a, b): return a / b\n',
    },
  });
  const baseRev = repo.currentRevision;

  // Apply a patch
  await repo.applyPatch({
    actionId: 'patch-diff-test',
    kind: 'apply_patch',
    patchContent: '        if b == 0: raise CalculationError()\n',
    targetPaths: ['src/calculator.py'],
    baseRevisionDigest: baseRev,
  });

  const diffResult = await repo.inspectDiff(baseRev);
  assert.equal(diffResult.changedFiles.includes('src/calculator.py'), true);
  assert.match(diffResult.diff, /CalculationError/);
  assert.equal(diffResult.diffDigest.startsWith('sha256:'), true);
});

for (const role of ['coder', 'reviewer'] as const) {
  for (const size of [0, 1]) {
    test(`${role}: finite script of ${size} responses fails closed on exhaustion`, async () => {
      const { context, request } = createFixtureAdmissionContext({
        request: role === 'coder' ? createFixtureProviderRequest() : createFixtureReviewerRequest(),
      });
      const modelResponse: ModelPortResult = { outcome: 'uncertain', reason: 'scripted timeout' };
      const reviewResponse: ReviewResult = {
        reviewId: 'finite-review', reviewerRoleConfigId: request.configId,
        repoDigest: createFixtureBugTask().initialRevisionDigest,
        diffDigest: computeCanonicalSha256('diff'), checkSetDigest: computeCanonicalSha256([]),
        status: 'accepted', findings: [], iterationReservationRef: request.reservationRef,
      };
      if (role === 'coder') {
        const port = new ScriptedModelPort({ admissionContext: context, responses: Array.from({ length: size }, () => modelResponse) });
        if (size) assert.deepEqual(await port.propose(createFixtureTaskState(), [], request), modelResponse);
        const result = await port.propose(createFixtureTaskState(), [], request);
        assert.equal(result.outcome, 'denied');
        if (result.outcome === 'denied') assert.match(result.reason, /SCRIPT_EXHAUSTED/);
        assert.equal(port.attemptedCalls, size + 1);
        assert.equal(port.simulatedDispatches, size);
        assert.equal(port.calls.at(-1)?.admitted, false);
      } else {
        const port = new ScriptedReviewerPort({ admissionContext: context, responses: Array.from({ length: size }, () => reviewResponse) });
        if (size) assert.deepEqual(await port.review(createFixtureBugTask(), 'diff', [], request), reviewResponse);
        await assert.rejects(port.review(createFixtureBugTask(), 'diff', [], request), /SCRIPT_EXHAUSTED/);
        assert.equal(port.attemptedCalls, size + 1);
        assert.equal(port.simulatedDispatches, size);
        assert.equal(port.calls.at(-1)?.admitted, false);
      }
    });
  }
}

const deniedProfiles: readonly [string, BuildAdmissionContextOptions][] = [
  ['missing task tokens', { omitTaskTokenRes: true }],
  ['missing task cost', { omitTaskCostRes: true }],
  ['missing run tokens', { omitRunTokenRes: true }],
  ['missing run cost', { omitRunCostRes: true }],
  ['exhausted task tokens', { taskTokensConsumed: 100000 }],
  ['exhausted task cost', { taskCostConsumed: 5 }],
  ['exhausted run tokens', { runTokensConsumed: 50000 }],
  ['exhausted run cost', { runCostConsumed: 2 }],
  ['partial token and cost bundle', { omitTaskTokenRes: true, omitRunCostRes: true }],
  ['unresolved history', { includeUncertainStoredRequest: true }],
  ['unknown accounting', { taskAccountingStatus: 'unknown' }],
];
for (const role of ['coder', 'reviewer'] as const) {
  const profiles: readonly (readonly [string, BuildAdmissionContextOptions | undefined])[] = [
    ['missing context', undefined], ...deniedProfiles,
    ...(role === 'reviewer' ? [
      ['missing task iteration', { omitReviewerIterationRes: true }],
      ['exhausted task iteration', { reviewerIterationConsumed: 5 }],
      ['missing required run iteration', { requireRunReviewIteration: true }],
      ['exhausted required run iteration', { requireRunReviewIteration: true, runReviewerIterationConsumed: 5 }],
    ] as const : []),
  ];
  for (const [name, options] of profiles) {
    test(`${role}: independently denies ${name} before dispatch`, async () => {
      const { context, request } = createFixtureAdmissionContext({ ...options,
        request: role === 'coder' ? createFixtureProviderRequest() : createFixtureReviewerRequest(),
      });
      // A factory would succeed if dispatch were incorrectly admitted.
      if (role === 'coder') {
        const port = new ScriptedModelPort({ admissionContext: options ? context : undefined,
          responseFactory: () => ({ outcome: 'uncertain', reason: 'must not dispatch' }) });
        assert.equal((await port.propose(createFixtureTaskState(), [], request)).outcome, 'denied');
        assert.equal(port.attemptedCalls, 1);
        assert.equal(port.simulatedDispatches, 0);
        assert.equal(port.calls[0]?.admitted, false);
      } else {
        const port = new ScriptedReviewerPort({ admissionContext: options ? context : undefined,
          responseFactory: () => { throw new Error('factory must not run'); } });
        await assert.rejects(port.review(createFixtureBugTask(), 'diff', [], request), /UNTRUSTED_DISPATCH_AUTHORIZATION|DISPATCH_ADMISSION_DENIED/);
        assert.equal(port.attemptedCalls, 1);
        assert.equal(port.simulatedDispatches, 0);
        assert.equal(port.calls[0]?.admitted, false);
      }
    });
  }
}

// ============================================================================
// v0.2 Fixture Forwarding Acceptance Tests (T053 / T054)
// ============================================================================

test('ScriptedModelPort (v0.2): preserves exact attempt identity and outcome on positive forwarding', async () => {
  const model = new ScriptedModelPortV02(new ScriptedModelPort());
  const context = createFixtureProviderAdmissionContextV02();
  const state = createFixtureTaskState();
  const evidence = [createFixtureSourceEvidence()];
  const request = createFixtureProviderRequest();

  const response: ModelPortResult = {
    outcome: 'observed',
    result: {
      proposal: { proposalId: 'prop-v02-001', content: 'scripted v0.2 fix' },
      observedUsage: { inputTokens: 100, outputTokens: 50, billableTokens: 150, costUsd: 0.005 },
    },
  };
  model.queueResponse(response);

  const res = await model.propose(state, evidence, request, context);
  assert.strictEqual(res, response);
  assert.equal(model.simulatedDispatches, 1);
  assert.equal(model.v02Calls.length, 1);
  assert.strictEqual(model.v02Calls[0]?.context, context);
  assert.strictEqual(model.v02Calls[0]?.outcome, response);
});

test('ScriptedModelPort (v0.2): missing or stale context causes zero simulated dispatches and zero transport effects', async () => {
  const model = new ScriptedModelPortV02(new ScriptedModelPort());
  const staleContext = createFixtureProviderAdmissionContextV02({
    providerRequestId: 'different-req-id',
  });
  const state = createFixtureTaskState();
  const evidence = [createFixtureSourceEvidence()];
  const request = createFixtureProviderRequest();

  // Missing context
  const missingRes = await model.propose(state, evidence, request, undefined as unknown as ProviderAdmissionContextV02);
  assert.equal(missingRes.outcome, 'denied');
  assert.equal(model.simulatedDispatches, 0);

  // Stale/mismatched context
  const staleRes = await model.propose(state, evidence, request, staleContext);
  assert.equal(staleRes.outcome, 'denied');
  assert.equal(model.simulatedDispatches, 0);
});

test('ScriptedReviewerPort (v0.2): preserves exact attempt identity and outcome on positive forwarding', async () => {
  const reviewer = new ScriptedReviewerPortV02(new ScriptedReviewerPort());
  const request = createFixtureReviewerRequest();
  const context = createFixtureProviderAdmissionContextV02({
    providerRequest: request,
    role: 'reviewer',
  });
  const task = createFixtureBugTask();
  const diff = '--- a/calc.py\n+++ b/calc.py\n@@ -1,1 +1,2 @@\n+if b == 0: raise CalculationError()\n return a / b\n';
  const evidence = [createFixtureSourceEvidence()];

  const response: ReviewResult = {
    reviewId: 'review-v02-001',
    reviewerRoleConfigId: request.configId,
    repoDigest: task.initialRevisionDigest,
    diffDigest: computeCanonicalSha256(diff),
    checkSetDigest: computeCanonicalSha256(task.requiredChecks.map((c) => c.checkId)),
    status: 'accepted',
    findings: [],
    iterationReservationRef: request.reservationRef,
  };
  reviewer.queueResponse(response);

  const res = await reviewer.review(task, diff, evidence, request, context);
  assert.strictEqual(res, response);
  assert.equal(reviewer.simulatedDispatches, 1);
  assert.equal(reviewer.v02Calls.length, 1);
  assert.strictEqual(reviewer.v02Calls[0]?.context, context);
  assert.strictEqual(reviewer.v02Calls[0]?.outcome, response);
});

test('ScriptedReviewerPort (v0.2): missing or stale context causes zero simulated dispatches and zero accounting changes', async () => {
  const reviewer = new ScriptedReviewerPortV02(new ScriptedReviewerPort());
  const staleContext = createFixtureProviderAdmissionContextV02({
    providerRequest: createFixtureReviewerRequest({ providerRequestId: 'other-request-id' }),
    role: 'reviewer',
  });
  const task = createFixtureBugTask();
  const diff = 'some diff';
  const evidence = [createFixtureSourceEvidence()];
  const request = createFixtureReviewerRequest();

  // Missing context
  await assert.rejects(
    async () => reviewer.review(task, diff, evidence, request, undefined as unknown as ProviderAdmissionContextV02),
    /MISSING_ADMISSION_CONTEXT/
  );
  assert.equal(reviewer.simulatedDispatches, 0);

  // Stale/mismatched context
  await assert.rejects(
    async () => reviewer.review(task, diff, evidence, request, staleContext),
    /CONTEXT_IDENTITY_MISMATCH/
  );
  assert.equal(reviewer.simulatedDispatches, 0);
});

test('FakeRepositoryPortV02 forwards branch-matched patch, command, and test outcomes', async () => {
  const underlying = new FakeRepositoryPort();
  const repo = new FakeRepositoryPortV02(underlying);
  const initialRevision = repo.currentRevision;

  // 1. applyPatch
  const patchAction: ApplyPatchAction = {
    actionId: 'act-patch-v02-001',
    kind: 'apply_patch',
    patchContent: '+class Fix(Exception): pass\n',
    targetPaths: ['src/calculator.py'],
    baseRevisionDigest: initialRevision,
  };
  const patchContext = createFixtureRepositoryAdmissionContextV02({
    action: patchAction,
    canonicalRevision: initialRevision,
  });
  const patchRes = await repo.applyPatch(patchAction, patchContext);
  assert.equal(patchRes.applied, true);
  assert.notEqual(patchRes.newRevisionDigest, initialRevision);
  assert.equal(repo.currentRevision, patchRes.newRevisionDigest);

  // 2. runCommand
  underlying.setCommandResult('default', { exitCode: 0, stdout: 'cmd ok', stderr: '' });
  const commandAction: RunCommandAction = {
    actionId: 'act-cmd-v02-001',
    kind: 'run_command',
    executable: 'pytest',
    argv: ['-v'],
    workingDirectory: 'tests',
  };
  const commandContext = createFixtureRepositoryCommandAdmissionContextV02({
    action: commandAction,
    canonicalRevision: repo.currentRevision,
  });
  const cmdRes = await repo.runCommand(commandAction, commandContext);
  assert.equal(cmdRes.exitCode, 0);
  assert.equal(cmdRes.stdout, 'cmd ok');

  // 3. runTests
  const check = createFixtureCheckDefinition();
  underlying.setTestResult(check.checkId, {
    checkId: check.checkId,
    outcome: 'pass',
    durationMs: 30,
  });
  const testContext = createFixtureRepositoryCommandAdmissionContextV02({
    action: {
      actionId: check.checkId,
      kind: 'run_command',
      executable: check.executable,
      argv: check.argv,
      workingDirectory: check.workingDirectory ?? '',
      ...(check.purpose !== undefined ? { purpose: check.purpose } : {}),
    },
    canonicalRevision: repo.currentRevision,
    checkId: check.checkId,
  });
  const testRes = await repo.runTests(check, testContext);
  assert.equal(testRes.outcome, 'pass');
});

test('FakeRepositoryPort (v0.2): missing or stale context causes zero mock effects and zero snapshot mutations', async () => {
  const initialRevision = new FakeRepositoryPort().currentRevision;
  const patchAction: ApplyPatchAction = {
    actionId: 'act-patch-stale',
    kind: 'apply_patch',
    patchContent: '+should not apply\n',
    targetPaths: ['src/calculator.py'],
    baseRevisionDigest: initialRevision,
  };
  const staleContext = createFixtureRepositoryAdmissionContextV02({
    action: patchAction,
    canonicalRevision: 'sha256:stale-canonical-rev',
    baseRevision: initialRevision,
  });
  const validation = validateRepositoryAdmissionV02(staleContext, {
    ...createTestRepositoryAdmissionTrustedContextV02(staleContext),
    canonicalRevision: initialRevision,
  });
  assert.equal(staleContext.actionDigest, computeActionDigest(patchAction));
  assert.equal(staleContext.baseRevision, patchAction.baseRevisionDigest);
  assert.equal(validation.ok, false);
  if (!validation.ok) assert.deepEqual(validation.errors.map(({ code }) => code), ['REVISION_MISMATCH']);
  const journal = createRecordingJournal(staleContext, 'stale-repository-context');
  const underlying = new FakeRepositoryPort({ statePort: journal.statePort, executorIdentity: journal.executor });
  const repo = new FakeRepositoryPortV02(underlying);
  assert.equal(repo.currentRevision, initialRevision);

  // Missing context (malformed/empty)
  const missingRes = await repo.applyPatch(patchAction, undefined as unknown as RepositoryAdmissionContextV02);
  assert.equal(missingRes.applied, false);
  assert.equal(repo.currentRevision, initialRevision);

  // Stale context
  const staleRes = await repo.applyPatch(patchAction, staleContext);
  assert.equal(staleRes.applied, false);
  assert.equal(repo.currentRevision, initialRevision);
  assert.deepEqual(underlying.patches, []);
  assert.deepEqual(repo.v02Calls, []);
  assert.deepEqual(journal.statePort.claimCalls, []);
  assert.deepEqual(journal.statePort.beginCalls, []);
  assert.deepEqual(journal.statePort.recordedOutcomes, []);
});

test('ScriptedApprovalPort (v0.2): preserves exact evaluation and decision receipts on positive forwarding', async () => {
  const action = {
    actionId: 'act-eval-001', kind: 'run_command' as const,
    executable: 'pytest', argv: [], workingDirectory: 'tests',
  };
  const auth = createFixturePolicyAuthorityRefV02();
  const context = createFixtureRepositoryAdmissionContextV02({ action, policyAuthorityRef: auth });
  const expectedEvaluation = createCurrentPolicyEvaluation(action, context, auth, 'APPROVAL_REQUIRED');
  const expectedDecision = createCurrentDecision(expectedEvaluation);
  const approval = new ScriptedApprovalPortV02(new ScriptedApprovalPort({
    v02AuthorityRef: auth,
    v02Evaluations: [expectedEvaluation],
    v02Decisions: [expectedDecision],
  }));

  const evalRes = await approval.evaluatePolicyV02(action, context);
  assert.strictEqual(evalRes, expectedEvaluation);
  assert.equal(evalRes.result, 'APPROVAL_REQUIRED');
  assert.equal(evalRes.policyId, auth.policyId);

  const decRes = await approval.requestDecisionV02(evalRes);
  assert.strictEqual(decRes, expectedDecision);
  assert.equal(decRes.status, 'approved');
  assert.equal(decRes.evaluationReceiptRef, evalRes.receiptId);

  const isValid = await approval.validateBindingV02(decRes, auth);
  assert.equal(isValid, true);
});

test('ScriptedApprovalPort (v0.2): stale authority generation rejects binding validation', async () => {
  const auth = createFixturePolicyAuthorityRefV02();
  const action = { actionId: 'stale-eval', kind: 'run_command' as const, executable: 'pytest', argv: [], workingDirectory: 'tests' };
  const context = createFixtureRepositoryAdmissionContextV02({ action, policyAuthorityRef: auth });
  const evaluation = createCurrentPolicyEvaluation(action, context, auth, 'ALLOWED');
  const staleAuth = createFixturePolicyAuthorityRefV02({ decisionAuthorityGeneration: 999 });
  const approval = new ScriptedApprovalPortV02(new ScriptedApprovalPort({ v02AuthorityRef: auth, v02Evaluations: [evaluation] }));

  const valid = await approval.validateBindingV02(evaluation, staleAuth);
  assert.equal(valid, false);
});

test('ScriptedModelPortV02 refuses a changed request before consuming its scripted success', async () => {
  const underlying = new ScriptedModelPort();
  const port = new ScriptedModelPortV02(underlying);
  const request = createFixtureProviderRequest({ providerRequestId: 'req-bound-model-001' });
  const context = createFixtureProviderAdmissionContextV02({ providerRequest: request });
  const response: ModelPortResult = {
    outcome: 'observed',
    result: { proposal: { proposalId: 'bound-model', content: 'same request only' }, observedUsage: { inputTokens: 1, outputTokens: 1, billableTokens: 2, costUsd: 0.001 } },
  };
  port.queueResponse(response);

  const changed = await port.propose(createFixtureTaskState(), [], { ...request, contextDigest: 'sha256:changed-payload' }, context);
  assert.equal(changed.outcome, 'denied');
  assert.equal(port.simulatedDispatches, 0);

  const accepted = await port.propose(createFixtureTaskState(), [], request, context);
  assert.strictEqual(accepted, response);
  assert.equal(port.simulatedDispatches, 1);
});

test('ScriptedReviewerPortV02 refuses a changed request before consuming its scripted success', async () => {
  const underlying = new ScriptedReviewerPort();
  const port = new ScriptedReviewerPortV02(underlying);
  const request = createFixtureReviewerRequest({ providerRequestId: 'req-bound-reviewer-001' });
  const context = createFixtureProviderAdmissionContextV02({ providerRequest: request, role: 'reviewer' });
  const task = createFixtureBugTask();
  const response: ReviewResult = {
    reviewId: 'bound-reviewer', reviewerRoleConfigId: request.configId,
    repoDigest: task.initialRevisionDigest, diffDigest: computeCanonicalSha256('bound diff'),
    checkSetDigest: computeCanonicalSha256([]), status: 'accepted', findings: [],
    iterationReservationRef: request.reservationRef,
  };
  port.queueResponse(response);

  await assert.rejects(
    port.review(task, 'bound diff', [], { ...request, contextDigest: 'sha256:changed-payload' }, context),
    /CONTEXT|ADMISSION|REQUEST/,
  );
  assert.equal(port.simulatedDispatches, 0);

  const accepted = await port.review(task, 'bound diff', [], request, context);
  assert.strictEqual(accepted, response);
  assert.equal(port.simulatedDispatches, 1);
});

test('FakeRepositoryPortV02 requires context before forwarding any repository effect', async () => {
  const underlying = new FakeRepositoryPort({
    commandResults: { default: { exitCode: 0, stdout: 'command ran', stderr: '' } },
    testResults: { default: { checkId: 'check-missing-context', outcome: 'pass', durationMs: 1 } },
  });
  const port = new FakeRepositoryPortV02(underlying);
  const revision = port.currentRevision;
  const patch: ApplyPatchAction = {
    actionId: 'patch-missing-context', kind: 'apply_patch', patchContent: '+must not apply',
    targetPaths: ['src/calculator.py'], baseRevisionDigest: revision,
  };
  const command: RunCommandAction = {
    actionId: 'command-missing-context', kind: 'run_command', executable: 'pytest', argv: [], workingDirectory: 'tests',
  };
  const check = { ...createFixtureCheckDefinition(), checkId: 'check-missing-context' };
  const missing = undefined as unknown as RepositoryAdmissionContextV02;

  assert.equal((await port.applyPatch(patch, missing)).applied, false);
  assert.notEqual((await port.runCommand(command, missing)).exitCode, 0);
  assert.notEqual((await port.runTests(check, missing)).outcome, 'pass');
  assert.equal(port.currentRevision, revision);
  assert.deepEqual(underlying.patches, []);
  assert.deepEqual(underlying.commands, []);
  assert.deepEqual(underlying.tests, []);
});

test('FakeRepositoryPortV02 refuses changed payload and stale revision before effects', async () => {
  const underlying = new FakeRepositoryPort();
  const port = new FakeRepositoryPortV02(underlying);
  const revision = port.currentRevision;
  const admittedPatch: ApplyPatchAction = {
    actionId: 'patch-admitted-payload', kind: 'apply_patch', patchContent: '+admitted',
    targetPaths: ['src/calculator.py'], baseRevisionDigest: revision,
  };
  const changedPatch = { ...admittedPatch, patchContent: '+changed after admission' };
  const context = createFixtureRepositoryAdmissionContextV02({ action: admittedPatch, canonicalRevision: revision });

  const refused = await port.applyPatch(changedPatch, context);
  assert.equal(refused.applied, false);
  assert.equal(port.currentRevision, revision);
  assert.deepEqual(underlying.patches, []);
});

test('FakeRepositoryPortV02 binds command and test payloads before forwarding', async () => {
  const commandUnderlying = new FakeRepositoryPort({ commandResults: { default: { exitCode: 0, stdout: 'only admitted command', stderr: '' } } });
  const commandPort = new FakeRepositoryPortV02(commandUnderlying);
  const command: RunCommandAction = {
    actionId: 'command-bound-101', kind: 'run_command', executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py'], workingDirectory: 'tests', purpose: 'reproduction',
  };
  const commandContext = createFixtureRepositoryCommandAdmissionContextV02({ action: command, canonicalRevision: commandPort.currentRevision });
  const changedCommand = { ...command, argv: ['-q', 'tests/test_other.py'] };
  const refusedCommand = await commandPort.runCommand(changedCommand, commandContext);
  assert.notEqual(refusedCommand.exitCode, 0);
  assert.deepEqual(commandUnderlying.commands, []);
  const staleCommandContext = createFixtureRepositoryCommandAdmissionContextV02({
    action: command,
    canonicalRevision: 'sha256:stale-command-revision',
  });
  assert.notEqual((await commandPort.runCommand(command, staleCommandContext)).exitCode, 0);
  assert.deepEqual(commandUnderlying.commands, []);
  const admittedCommand = await commandPort.runCommand(command, commandContext);
  assert.equal(admittedCommand.stdout, 'only admitted command');
  assert.deepEqual(commandUnderlying.commands, [command]);

  const testUnderlying = new FakeRepositoryPort();
  const testPort = new FakeRepositoryPortV02(testUnderlying);
  const check = createFixtureCheckDefinition({ checkId: 'check-bound-102' });
  testUnderlying.setTestResult(check.checkId, { checkId: check.checkId, outcome: 'pass', durationMs: 1 });
  const checkAction: RunCommandAction = {
    actionId: check.checkId, kind: 'run_command', executable: check.executable,
    argv: check.argv, workingDirectory: check.workingDirectory ?? '', purpose: check.purpose,
  };
  const checkContext = createFixtureRepositoryCommandAdmissionContextV02({
    action: checkAction,
    canonicalRevision: testPort.currentRevision,
    checkId: check.checkId,
  });
  const changedCheck = { ...check, argv: ['-q', 'tests/other.py'] };
  assert.equal((await testPort.runTests(changedCheck, checkContext)).outcome, 'fail');
  assert.deepEqual(testUnderlying.tests, []);
  const staleCheckContext = createFixtureRepositoryCommandAdmissionContextV02({
    action: checkAction,
    canonicalRevision: 'sha256:stale-test-revision',
    checkId: check.checkId,
  });
  assert.equal((await testPort.runTests(check, staleCheckContext)).outcome, 'fail');
  assert.deepEqual(testUnderlying.tests, []);
  assert.equal((await testPort.runTests(check, checkContext)).outcome, 'pass');
  assert.deepEqual(testUnderlying.tests, [check]);
});

test('v0.2 wrappers forward journal receipts and scripted outcomes exactly once', async () => {
  const modelRequest = createFixtureProviderRequest({ providerRequestId: 'req-journal-model-091' });
  const modelContext = createFixtureProviderAdmissionContextV02({ providerRequest: modelRequest });
  const modelJournal = createRecordingJournal(modelContext, 'model-091');
  const modelUnderlying = new ScriptedModelPort({
    statePort: modelJournal.statePort,
    executorIdentity: modelJournal.executor,
  });
  const model = new ScriptedModelPortV02(modelUnderlying);
  const modelOutcome: ModelPortResult = {
    outcome: 'observed',
    result: { proposal: { proposalId: 'journal-model', content: 'forwarded' }, observedUsage: { inputTokens: 1, outputTokens: 2, billableTokens: 3, costUsd: 0.001 } },
  };
  model.queueResponse(modelOutcome);
  const modelResult = await model.propose(createFixtureTaskState(), [], modelRequest, modelContext);
  const modelCall = model.v02Calls[0];
  assert.ok(modelCall);
  assert.strictEqual(modelResult, modelOutcome);
  const modelReceipt = modelCall.outcomeReceipt;
  if (!modelReceipt || modelReceipt.subjectKind !== 'provider-request') assert.fail('expected provider outcome receipt');
  assert.deepEqual(modelReceipt.observedUsage, modelOutcome.result.observedUsage);
  assert.deepEqual(modelReceipt.proposedEffects.accounting.observedUsage, modelOutcome.result.observedUsage);
  assert.strictEqual(modelCall.context, modelContext);
  assert.strictEqual(modelCall.claim, modelJournal.claim);
  assert.strictEqual(modelCall.attempt, modelJournal.attempt);
  assert.strictEqual(modelCall.outcome, modelOutcome);
  assert.strictEqual(modelCall.outcomeReceipt, modelJournal.statePort.recordedOutcomes[0]);
  assert.equal(modelCall.claimId, 'claim-journal-model-091');
  assert.equal(modelCall.attemptId, 'attempt-journal-model-091');
  assert.strictEqual(modelJournal.statePort.claimCalls[0], modelContext);
  assert.equal(modelJournal.statePort.beginCalls[0]?.claimId, modelCall.claimId);
  assert.strictEqual(modelJournal.statePort.beginCalls[0]?.executor, modelJournal.executor);
  assert.equal(modelCall.outcomeReceipt?.receiptDigest, computeAttemptOutcomeDigest(modelCall.outcomeReceipt));
  assert.deepEqual(modelCall.outcomeReceipt?.versions, {
    taskStateSchemaVersion: modelContext.taskStateSchemaVersion,
    controlSchemaVersion: modelContext.controlSchemaVersion,
    preClaimTaskStateVersion: 1,
    postClaimTaskStateVersion: 1,
    postAttemptTaskStateVersion: 1,
    preClaimControlVersion: 2,
    postClaimControlVersion: 3,
    postAttemptControlVersion: 4,
    epoch: 1,
  });
  assert.equal(modelJournal.statePort.claimCalls.length, 1);
  assert.equal(modelJournal.statePort.beginCalls.length, 1);
  assert.equal(modelJournal.statePort.recordedOutcomes.length, 1);

  const reviewerRequest = createFixtureReviewerRequest({ providerRequestId: 'req-journal-reviewer-092' });
  const reviewerContext = createFixtureProviderAdmissionContextV02({ providerRequest: reviewerRequest, role: 'reviewer' });
  const reviewerJournal = createRecordingJournal(reviewerContext, 'reviewer-092');
  const reviewerUnderlying = new ScriptedReviewerPort({
    statePort: reviewerJournal.statePort,
    executorIdentity: reviewerJournal.executor,
  });
  const reviewer = new ScriptedReviewerPortV02(reviewerUnderlying);
  const task = createFixtureBugTask();
  const reviewerOutcome: ReviewResult = {
    reviewId: 'journal-reviewer', reviewerRoleConfigId: reviewerRequest.configId,
    repoDigest: task.initialRevisionDigest, diffDigest: computeCanonicalSha256('journal diff'),
    checkSetDigest: computeCanonicalSha256([]), status: 'accepted', findings: [],
    iterationReservationRef: reviewerRequest.reservationRef,
  };
  reviewer.queueResponse(reviewerOutcome);
  const reviewerResult = await reviewer.review(task, 'journal diff', [], reviewerRequest, reviewerContext);
  const reviewerCall = reviewer.v02Calls[0];
  assert.ok(reviewerCall);
  assert.strictEqual(reviewerResult, reviewerOutcome);
  const reviewerReceipt = reviewerCall.outcomeReceipt;
  if (!reviewerReceipt || reviewerReceipt.subjectKind !== 'provider-request') assert.fail('expected provider outcome receipt');
  assert.equal(reviewerReceipt.outcome, 'uncertain');
  assert.equal(reviewerReceipt.observedUsage, undefined);
  assert.equal(reviewerReceipt.proposedEffects.accounting.observedUsage, undefined);
  assert.equal(reviewerReceipt.proposedEffects.accounting.disposition, 'hold');
  assert.deepEqual(reviewerReceipt.proposedEffects.accounting.reservationRefs, [reviewerContext.requestReservationReceipt, ...reviewerContext.budgetRefs]);
  assert.strictEqual(reviewerCall.context, reviewerContext);
  assert.strictEqual(reviewerCall.claim, reviewerJournal.claim);
  assert.strictEqual(reviewerCall.attempt, reviewerJournal.attempt);
  assert.strictEqual(reviewerCall.outcome, reviewerOutcome);
  assert.strictEqual(reviewerCall.outcomeReceipt, reviewerJournal.statePort.recordedOutcomes[0]);
  assert.equal(reviewerCall.claimId, 'claim-journal-reviewer-092');
  assert.equal(reviewerCall.attemptId, 'attempt-journal-reviewer-092');
  assert.strictEqual(reviewerJournal.statePort.claimCalls[0], reviewerContext);
  assert.equal(reviewerJournal.statePort.beginCalls[0]?.claimId, reviewerCall.claimId);
  assert.strictEqual(reviewerJournal.statePort.beginCalls[0]?.executor, reviewerJournal.executor);
  assert.equal(reviewerCall.outcomeReceipt?.receiptDigest, computeAttemptOutcomeDigest(reviewerCall.outcomeReceipt));
  assert.deepEqual(reviewerCall.outcomeReceipt?.versions, {
    taskStateSchemaVersion: reviewerContext.taskStateSchemaVersion,
    controlSchemaVersion: reviewerContext.controlSchemaVersion,
    preClaimTaskStateVersion: 1,
    postClaimTaskStateVersion: 1,
    postAttemptTaskStateVersion: 1,
    preClaimControlVersion: 2,
    postClaimControlVersion: 3,
    postAttemptControlVersion: 4,
    epoch: 1,
  });
  assert.equal(reviewerJournal.statePort.claimCalls.length, 1);
  assert.equal(reviewerJournal.statePort.beginCalls.length, 1);
  assert.equal(reviewerJournal.statePort.recordedOutcomes.length, 1);
  assert.equal(reviewerJournal.statePort.recordedOutcomeResults[0]?.outcome, 'uncertain');

  const revision = new FakeRepositoryPort().currentRevision;
  const patch: ApplyPatchAction = {
    actionId: 'patch-journal-repository-093', kind: 'apply_patch', patchContent: '+journal result',
    targetPaths: ['src/calculator.py'], baseRevisionDigest: revision,
  };
  const repositoryContext = createFixtureRepositoryAdmissionContextV02({ action: patch, canonicalRevision: revision });
  const repositoryJournal = createRecordingJournal(repositoryContext, 'repository-093');
  const repositoryWithJournal = new FakeRepositoryPortV02(new FakeRepositoryPort({
    statePort: repositoryJournal.statePort,
    executorIdentity: repositoryJournal.executor,
  }));
  const repositoryOutcome = await repositoryWithJournal.applyPatch(patch, repositoryContext);
  const repositoryCall = repositoryWithJournal.v02Calls[0];
  assert.ok(repositoryCall);
  assert.equal(repositoryOutcome.applied, true);
  assert.strictEqual(repositoryCall.context, repositoryContext);
  assert.strictEqual(repositoryCall.claim, repositoryJournal.claim);
  assert.strictEqual(repositoryCall.attempt, repositoryJournal.attempt);
  assert.equal(repositoryCall.claimId, 'claim-journal-repository-093');
  assert.equal(repositoryCall.attemptId, 'attempt-journal-repository-093');
  assert.strictEqual(repositoryCall.outcome, repositoryOutcome);
  assert.strictEqual(repositoryCall.outcomeReceipt, repositoryJournal.statePort.recordedOutcomes[0]);
  assert.strictEqual(repositoryJournal.statePort.claimCalls[0], repositoryContext);
  assert.equal(repositoryJournal.statePort.beginCalls[0]?.claimId, repositoryCall.claimId);
  assert.strictEqual(repositoryJournal.statePort.beginCalls[0]?.executor, repositoryJournal.executor);
  assert.equal(repositoryCall.outcomeReceipt?.receiptDigest, computeAttemptOutcomeDigest(repositoryCall.outcomeReceipt));
  assert.deepEqual(repositoryCall.outcomeReceipt?.versions, {
    taskStateSchemaVersion: repositoryContext.taskStateSchemaVersion,
    controlSchemaVersion: repositoryContext.controlSchemaVersion,
    preClaimTaskStateVersion: 1,
    postClaimTaskStateVersion: 1,
    postAttemptTaskStateVersion: 2,
    preClaimControlVersion: 2,
    postClaimControlVersion: 3,
    postAttemptControlVersion: 4,
    epoch: 1,
  });
  if (repositoryCall.outcomeReceipt?.subjectKind === 'repository-action') {
    assert.equal(repositoryCall.outcomeReceipt.observedResultRevisionDigest, repositoryOutcome.newRevisionDigest);
    assert.deepEqual(repositoryCall.outcomeReceipt.proposedEffects.revision, {
      kind: 'advance',
      revisionDigest: repositoryOutcome.newRevisionDigest,
    });
  } else {
    assert.fail('repository wrapper must forward a repository action outcome receipt');
  }
  assert.equal(repositoryJournal.statePort.claimCalls.length, 1);
  assert.equal(repositoryJournal.statePort.beginCalls.length, 1);
  assert.equal(repositoryJournal.statePort.recordedOutcomes.length, 1);
});

test('ScriptedApprovalPortV02 requires scripted current authority and never invents approval', async () => {
  const action = { actionId: 'approval-v02-forbidden', kind: 'run_command' as const, executable: 'pytest', argv: [], workingDirectory: 'tests' };
  const authority = createFixturePolicyAuthorityRefV02();
  const missing = new ScriptedApprovalPortV02(new ScriptedApprovalPort());
  await assert.rejects(missing.evaluatePolicyV02(action), /AUTHORITY|SCRIPT|UNCONFIGURED/);

  const context = createFixtureRepositoryAdmissionContextV02({ action, policyAuthorityRef: authority });
  const evaluation = createCurrentPolicyEvaluation(action, context, authority, 'FORBIDDEN');
  const forbidden = new ScriptedApprovalPortV02(new ScriptedApprovalPort({
    v02AuthorityRef: authority,
    v02Evaluations: [evaluation],
    v02Decisions: [createCurrentDecision(evaluation)],
  }));
  const returnedEvaluation = await forbidden.evaluatePolicyV02(action, context);
  assert.strictEqual(returnedEvaluation, evaluation);
  assert.equal(evaluation.result, 'FORBIDDEN');
  await assert.rejects(forbidden.requestDecisionV02(evaluation), /FORBIDDEN|SCRIPT|DECISION/);
});

test('ScriptedApprovalPortV02 rejects same-generation authority with different policy identity', async () => {
  const configured = createFixturePolicyAuthorityRefV02();
  const action = { actionId: 'same-generation-policy', kind: 'run_command' as const, executable: 'pytest', argv: [], workingDirectory: 'tests' };
  const context = createFixtureRepositoryAdmissionContextV02({ action, policyAuthorityRef: configured });
  const evaluation = createCurrentPolicyEvaluation(action, context, configured, 'ALLOWED');
  const port = new ScriptedApprovalPortV02(new ScriptedApprovalPort({ v02AuthorityRef: configured, v02Evaluations: [evaluation] }));
  const forged = createFixturePolicyAuthorityRefV02({ policyId: 'different-policy', decisionAuthorityGeneration: configured.decisionAuthorityGeneration });

  assert.equal(await port.validateBindingV02(evaluation, forged), false);
});

test('ScriptedApprovalPortV02 rejects malformed, cross-identity and stale authority receipts', async () => {
  const authority = createFixturePolicyAuthorityRefV02();
  const action = { actionId: 'malformed-policy-receipt', kind: 'run_command' as const, executable: 'pytest', argv: [], workingDirectory: 'tests' };
  const context = createFixtureRepositoryAdmissionContextV02({ action, policyAuthorityRef: authority });
  const evaluation = createCurrentPolicyEvaluation(action, context, authority, 'APPROVAL_REQUIRED');
  const port = new ScriptedApprovalPortV02(new ScriptedApprovalPort({ v02AuthorityRef: authority, v02Evaluations: [evaluation] }));
  const malformed = { ...evaluation, receiptDigest: 'sha256:malformed' };
  const stale = createFixturePolicyAuthorityRefV02({ decisionAuthorityGeneration: authority.decisionAuthorityGeneration + 1 });
  const crossIdentity = createFixturePolicyAuthorityRefV02({ issuerKeyRef: 'different-issuer' });

  assert.equal(await port.validateBindingV02(malformed, authority), false);
  assert.equal(await port.validateBindingV02(evaluation, stale), false);
  assert.equal(await port.validateBindingV02(evaluation, crossIdentity), false);
  assert.throws(() => new ScriptedApprovalPort({ v02AuthorityRef: authority, v02Evaluations: [malformed] }), /Invalid scripted/);
});

test('ScriptedApprovalPortV02 does not accept caller authority without configured current authority', async () => {
  const request = createFixtureProviderRequest({ providerRequestId: 'req-provider-authority-unconfigured-095' });
  const authority = createFixturePolicyAuthorityRefV02({ configId: request.configId });
  const action: RunCommandAction = {
    actionId: 'approval-authority-unconfigured', kind: 'run_command', executable: 'pytest', argv: [], workingDirectory: 'tests',
  };
  const context = createFixtureRepositoryAdmissionContextV02({ action, policyAuthorityRef: authority });
  const evaluation = createCurrentPolicyEvaluation(action, context, authority, 'APPROVAL_REQUIRED');
  const decision = createCurrentDecision(evaluation);
  const port = new ScriptedApprovalPortV02(new ScriptedApprovalPort({
    v02Evaluations: [evaluation],
    v02Decisions: [decision],
  }));

  await assert.rejects(port.issueProviderAdmissionReceiptV02(request, authority), /MISSING_CURRENT_AUTHORITY/);
  assert.equal(await port.validateBindingV02(evaluation, authority), false);
  assert.equal(await port.validateBindingV02(decision, authority), false);
});

test('ScriptedApprovalPortV02 refuses caller authority that differs from configured current authority', async () => {
  const request = createFixtureProviderRequest({ providerRequestId: 'req-provider-authority-conflict-096' });
  const authority = createFixturePolicyAuthorityRefV02({ configId: request.configId });
  const suppliedAuthorities: readonly PolicyAuthorityRefV02[] = [
    { ...authority, decisionAuthorityGeneration: authority.decisionAuthorityGeneration + 1 },
    { ...authority, configId: 'forged-config-id' },
    { ...authority, configVersion: 'forged-config-version' },
    { ...authority, issuerKeyRef: 'forged-issuer' },
    { ...authority, policyId: 'forged-policy' },
  ];
  const port = new ScriptedApprovalPortV02(new ScriptedApprovalPort({ v02AuthorityRef: authority }));

  for (const supplied of suppliedAuthorities) {
    await assert.rejects(port.issueProviderAdmissionReceiptV02(request, supplied), /CURRENT_AUTHORITY_MISMATCH/);
  }
});

test('ScriptedApprovalPortV02 validates complete provider requests before receipt lookup', async () => {
  const request = createFixtureProviderRequest({ providerRequestId: 'req-provider-authority-malformed-097' });
  const authority = createFixturePolicyAuthorityRefV02({ configId: request.configId });
  const port = new ScriptedApprovalPortV02(new ScriptedApprovalPort({ v02AuthorityRef: authority }));
  const malformed = { ...request, timeoutMs: 0 };

  await assert.rejects(port.issueProviderAdmissionReceiptV02(malformed, authority), /INVALID_PROVIDER_REQUEST/);
});

test('ScriptedApprovalPortV02 does not synthesize an unscripted provider admission receipt', async () => {
  const request = createFixtureProviderRequest({ providerRequestId: 'req-provider-receipt-unscripted-098' });
  const authority = createFixturePolicyAuthorityRefV02({ configId: request.configId });
  const port = new ScriptedApprovalPortV02(new ScriptedApprovalPort({ v02AuthorityRef: authority }));

  await assert.rejects(port.issueProviderAdmissionReceiptV02(request), /UNSCRIPTED_PROVIDER_ADMISSION_RECEIPT/);
});

test('ScriptedApprovalPortV02 forwards an explicit provider receipt unchanged after refusals', async () => {
  const request = createFixtureProviderRequest({ providerRequestId: 'req-provider-receipt-explicit-099' });
  const authority = createFixturePolicyAuthorityRefV02({ configId: request.configId, configVersion: 'provider-config-current' });
  const receipt = createFixtureProviderAdmissionReceiptV02({
    receiptId: 'explicit-provider-admission-099',
    providerRequestId: request.providerRequestId,
    role: request.role,
    requestContentDigest: computeRequestContentDigest(request),
    providerId: request.providerId,
    modelId: request.modelId,
    configId: request.configId,
    configVersion: authority.configVersion,
    decisionAuthorityGeneration: authority.decisionAuthorityGeneration,
  });
  const options: {
    readonly v02AuthorityRef: PolicyAuthorityRefV02;
    readonly v02ProviderAdmissionReceipts: readonly ProviderAdmissionReceiptV02[];
  } = { v02AuthorityRef: authority, v02ProviderAdmissionReceipts: [receipt] };
  const port = new ScriptedApprovalPortV02(new ScriptedApprovalPort(options));
  const suppliedAuthorities: readonly PolicyAuthorityRefV02[] = [
    { ...authority, decisionAuthorityGeneration: authority.decisionAuthorityGeneration + 1 },
    { ...authority, configVersion: 'forged-config-version' },
    { ...authority, issuerKeyRef: 'forged-issuer' },
    { ...authority, policyId: 'forged-policy' },
    { ...authority, policyVersion: 'forged-policy-version' },
  ];

  for (const supplied of suppliedAuthorities) {
    await assert.rejects(port.issueProviderAdmissionReceiptV02(request, supplied), /CURRENT_AUTHORITY_MISMATCH/);
  }
  await assert.rejects(port.issueProviderAdmissionReceiptV02({ ...request, timeoutMs: 0 }, authority), /INVALID_PROVIDER_REQUEST/);
  await assert.rejects(port.issueProviderAdmissionReceiptV02({ ...request, configId: '' }, authority), /INVALID_PROVIDER_REQUEST/);
  await assert.rejects(port.issueProviderAdmissionReceiptV02({ ...request, contextDigest: 'sha256:different' }, authority), /UNSCRIPTED_PROVIDER_ADMISSION_RECEIPT/);
  await assert.rejects(port.issueProviderAdmissionReceiptV02({ ...request, providerId: 'different-provider' }, authority), /UNSCRIPTED_PROVIDER_ADMISSION_RECEIPT/);

  assert.strictEqual(await port.issueProviderAdmissionReceiptV02(request, authority), receipt);
  await assert.rejects(port.issueProviderAdmissionReceiptV02(request, authority), /UNSCRIPTED_PROVIDER_ADMISSION_RECEIPT/);
});

function createCurrentPolicyEvaluation(
  action: RunCommandAction,
  context: RepositoryAdmissionContextV02,
  authority: ReturnType<typeof createFixturePolicyAuthorityRefV02>,
  result: 'ALLOWED' | 'APPROVAL_REQUIRED' | 'FORBIDDEN',
) {
  const actionDigest = computeActionDigest(action);
  return createFixturePolicyEvaluationReceiptV02({
    receiptId: `pe-${action.actionId}`,
    actionDigest,
    freshnessContextDigest: computeCanonicalSha256({ actionDigest, canonicalRevision: context.canonicalRevision, policyAuthorityRef: authority }),
    policyId: authority.policyId,
    policyVersion: authority.policyVersion,
    configId: authority.configId,
    configVersion: authority.configVersion,
    decisionAuthorityGeneration: authority.decisionAuthorityGeneration,
    result,
  });
}

function createCurrentDecision(evaluation: ReturnType<typeof createFixturePolicyEvaluationReceiptV02>) {
  return createFixtureActionDecisionReceiptV02({
    decisionId: `decision-${evaluation.receiptId}`,
    actionDigest: evaluation.actionDigest,
    evaluationReceiptRef: evaluation.receiptId,
    decisionAuthorityGeneration: evaluation.decisionAuthorityGeneration,
  });
}

test('v0.2 model uncertainty holds reservations without fabricated usage', async () => {
  const request = createFixtureProviderRequest({ providerRequestId: 'req-model-uncertain-094' });
  const context = createFixtureProviderAdmissionContextV02({ providerRequest: request });
  const journal = createRecordingJournal(context, 'model-uncertain-094');
  const underlying = new ScriptedModelPort({ statePort: journal.statePort, executorIdentity: journal.executor });
  const model = new ScriptedModelPortV02(underlying);
  const outcome: ModelPortResult = { outcome: 'uncertain', reason: 'scripted timeout' };
  model.queueResponse(outcome);

  const returned = await model.propose(createFixtureTaskState(), [], request, context);
  const receipt = model.v02Calls[0]?.outcomeReceipt;
  assert.strictEqual(returned, outcome);
  if (!receipt || receipt.subjectKind !== 'provider-request') assert.fail('expected provider outcome receipt');
  assert.equal(receipt.outcome, 'uncertain');
  assert.equal(receipt.observedUsage, undefined);
  assert.equal(receipt.proposedEffects.accounting.observedUsage, undefined);
  assert.equal(receipt.proposedEffects.accounting.disposition, 'hold');
  assert.deepEqual(receipt.proposedEffects.accounting.reservationRefs, [context.requestReservationReceipt, ...context.budgetRefs]);
  assert.equal(journal.statePort.recordedOutcomes.length, 1);
  assert.equal(journal.statePort.recordedOutcomeResults[0]?.outcome, 'uncertain');
});
