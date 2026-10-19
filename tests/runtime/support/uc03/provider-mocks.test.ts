import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAdmittedForProduction,
  validateReviewAdmission,
  validateModelProposal,
  validateModelResult,
  computeCanonicalSha256,
  type ApplyPatchAction,
  type RunCommandAction,
  type ModelPortResult,
  type ReviewResult,
  type TrustedDiffLines,
} from '../../../../src/contracts/foundation/uc03.ts';
import { ScriptedModelPort } from './scripted-model.ts';
import { ScriptedReviewerPort } from './scripted-reviewer.ts';
import { FakeRepositoryPort } from './fake-repository.ts';
import {
  createFixtureBugTask,
  createFixtureTaskState,
  createFixtureProviderRequest,
  createFixtureReviewerRequest,
  createFixtureSourceEvidence,
  createFixtureAdmissionContext,
  createFixtureCheckDefinition,
  type BuildAdmissionContextOptions,
} from './port-fixtures.ts';

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

  // Attempting patch on protected paths fails closed
  const maliciousPatch: ApplyPatchAction = {
    actionId: 'act-malicious',
    kind: 'apply_patch',
    patchContent: 'MALICIOUS_SECRET=1\n',
    targetPaths: ['.env'],
    baseRevisionDigest: repo.currentRevision,
  };
  await assert.rejects(async () => repo.applyPatch(maliciousPatch), /PROTECTED_PATH/);
});

test('FakeRepositoryPort: runCommand acts strictly as spy and returns scripted diagnostics', async () => {
  const repo = new FakeRepositoryPort();
  const command: RunCommandAction = {
    actionId: 'act-cmd-1',
    kind: 'run_command',
    executable: 'pytest',
    argv: ['-v', 'tests/test_calculator.py'],
    workingDirectory: 'tests',
  };

  await assert.rejects(repo.runCommand(command), /SCRIPT_EXHAUSTED/);
  assert.equal(repo.commands.length, 1);

  // Explicit default output
  repo.setCommandResult('default', {
    exitCode: 0,
    stdout: '[FakeRepositoryPort] scripted command output',
    stderr: '',
  });
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
