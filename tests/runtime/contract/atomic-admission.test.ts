/**
 * UC-03 v0.2.0 Atomic Admission Contract Tests (T037 / T038).
 *
 * Feature: specs/001-verified-code-repair
 * Amendment: contracts/atomic-admission-amendment.md
 *
 * T037: Runnable v0.2 admission-validator RED scaffolding.
 *       Positive repository and provider vectors must FAIL BEHAVIORALLY
 *       against neutral fail-closed SUT; malformed/cross-branch inputs deny.
 * T038: Turn positive assertions GREEN with exact canonical digests,
 *       command view bounds, provider identity, and cross-branch rejection.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeActionDigest,
  computeCanonicalSha256,
  type RunCommandAction,
  type ApplyPatchAction,
  type ProviderRequest,
} from '../../../src/contracts/foundation/uc03.ts';
import {
  computeRequestContentDigest,
  computeAdmissionDigest,
  validateRepositoryAdmissionV02,
  validateProviderAdmissionV02,
  validateAdmissionV02,
} from '../../../src/contracts/foundation/uc03/admission-v02.ts';
import type {
  RepositoryAdmissionContextV02,
  ProviderAdmissionContextV02,
} from '../../../src/contracts/foundation/uc03/ports-v02.ts';

function createValidPatchAction(): ApplyPatchAction {
  const patchContent = [
    '--- a/src/calculator.py',
    '+++ b/src/calculator.py',
    '@@ -2,2 +2,4 @@',
    '     def divide(self, a, b):',
    '+        if b == 0:',
    '+            raise ValueError("divisor cannot be zero")',
    '         return a / b',
    '',
  ].join('\n');

  return {
    actionId: 'act-patch-001',
    kind: 'apply_patch',
    patchContent,
    targetPaths: ['src/calculator.py'],
    baseRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
}

function createValidCommandAction(): RunCommandAction {
  return {
    actionId: 'act-cmd-001',
    kind: 'run_command',
    executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py'],
    workingDirectory: 'tests',
    purpose: 'reproduction',
  };
}

function createValidDiagnosticPatchAction(): ApplyPatchAction {
  const patchContent = [
    '--- a/tests/test_calculator.py',
    '+++ b/tests/test_calculator.py',
    '@@ -10,0 +10,4 @@',
    '+def test_divide_by_zero():',
    '+    calc = Calculator()',
    '+    pytest.raises(ValueError, calc.divide, 10, 0)',
    '',
  ].join('\n');

  return {
    actionId: 'act-patch-diag-001',
    kind: 'apply_patch',
    patchContent,
    targetPaths: ['tests/test_calculator.py'],
    baseRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
}

function createValidRepositoryApprovedPlanContext(
  overrides?: Partial<Record<string, unknown>>
): RepositoryAdmissionContextV02 {
  const action = createValidPatchAction();
  const actionDigest = computeActionDigest(action);
  const context: Record<string, unknown> = {
    schemaVersion: '0.2.0',
    subjectKind: 'repository-action',
    planApplicability: 'approved-plan',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: 1,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: 2,
    expectedEpoch: 1,
    taskId: 'task-calc-001',
    runId: 'run-001',
    workspaceId: 'workspace-001',
    repositoryId: 'repo-001',
    runnableNode: 'Repair',
    canonicalRevision: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    executionProfileId: 'profile-docker-isolated',
    action,
    actionDigest,
    policyAuthorityRef: {
      policyId: 'policy-default',
      policyVersion: '1.0.0',
      configId: 'config-default',
      configVersion: '1.0.0',
      issuerKeyRef: 'key-authority-001',
      decisionAuthorityGeneration: 3,
    },
    policyEvaluationReceipt: {
      receiptId: 'pe-receipt-001',
      receiptDigest: 'sha256:pereceiptdigest00000000000000000000000000000000000000000000000000',
      actionDigest,
      freshnessContextDigest: 'sha256:freshness00000000000000000000000000000000000000000000000000',
      policyId: 'policy-default',
      policyVersion: '1.0.0',
      configId: 'config-default',
      configVersion: '1.0.0',
      decisionAuthorityGeneration: 3,
      result: 'ALLOWED',
    },
    planBindingDigest: 'sha256:planbindingdigest00000000000000000000000000000000000000000000000',
    planDecisionRef: 'dec-plan-001',
    baseRevision: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    targetPaths: ['src/calculator.py'],
    patchDigest: computeCanonicalSha256(action.patchContent),
    finiteBounds: {
      maxPatchBytes: 4096,
      maxChangedPaths: 5,
    },
    reservationRefs: ['res-repair-slot-001'],
    ...overrides,
  };

  return context as unknown as RepositoryAdmissionContextV02;
}

function createValidRepositoryPrePlanDiagnosticContext(
  overrides?: Partial<Record<string, unknown>>
): RepositoryAdmissionContextV02 {
  const action = createValidCommandAction();
  const actionDigest = computeActionDigest(action);
  const context: Record<string, unknown> = {
    schemaVersion: '0.2.0',
    subjectKind: 'repository-action',
    planApplicability: 'pre-plan-diagnostic',
    diagnosticPurpose: 'reproduction',
    taskCriteriaDigest: 'sha256:criteria00000000000000000000000000000000000000000000000000000000',
    checkSetDigest: 'sha256:checkset00000000000000000000000000000000000000000000000000000000',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: 0,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: 0,
    expectedEpoch: 1,
    taskId: 'task-calc-001',
    runId: 'run-001',
    workspaceId: 'workspace-001',
    repositoryId: 'repo-001',
    runnableNode: 'Investigate',
    canonicalRevision: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    executionProfileId: 'profile-docker-isolated',
    action,
    actionDigest,
    policyAuthorityRef: {
      policyId: 'policy-default',
      policyVersion: '1.0.0',
      configId: 'config-default',
      configVersion: '1.0.0',
      issuerKeyRef: 'key-authority-001',
      decisionAuthorityGeneration: 1,
    },
    policyEvaluationReceipt: {
      receiptId: 'pe-receipt-diag-001',
      receiptDigest: 'sha256:pediagreceipt0000000000000000000000000000000000000000000000000000',
      actionDigest,
      freshnessContextDigest: 'sha256:freshnessdiag0000000000000000000000000000000000000000000000',
      policyId: 'policy-default',
      policyVersion: '1.0.0',
      configId: 'config-default',
      configVersion: '1.0.0',
      decisionAuthorityGeneration: 1,
      result: 'ALLOWED',
    },
    commandView: {
      viewId: 'view-cmd-001',
      viewDigest: 'sha256:viewdigest0000000000000000000000000000000000000000000000000000000',
      taskId: 'task-calc-001',
      workspaceId: 'workspace-001',
      canonicalRevision: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      admittedFiles: [
        {
          path: 'tests/test_calculator.py',
          digest: 'sha256:filetest0000000000000000000000000000000000000000000000000000000',
        },
      ],
      exclusionsPolicyVersion: '1.0.0',
      scratchIdentity: 'scratch-vol-001',
      mountedReadOnly: true,
      isolationProfileRef: 'profile-read-only-mount',
    },
    finiteBounds: {
      timeoutMs: 30000,
      maxOutputBytes: 65536,
      maxCpuSeconds: 10,
      maxMemoryBytes: 536870912,
      maxProcessCount: 5,
      isolationProfileRef: 'profile-read-only-mount',
    },
    reservationRefs: ['res-command-001'],
    ...overrides,
  };

  return context as unknown as RepositoryAdmissionContextV02;
}

function createValidProviderRequest(overrides?: Partial<ProviderRequest>): ProviderRequest {
  return {
    providerRequestId: 'req-prov-001',
    taskId: 'task-calc-001',
    runId: 'run-001',
    role: 'coder',
    purpose: 'generate_repair',
    providerId: 'provider-test',
    modelId: 'model-test-01',
    configId: 'config-coder-v1',
    pricingPolicyId: 'pricing-standard-v1',
    contextDigest: 'sha256:ctxdigest000000000000000000000000000000000000000000000000000000000',
    timeoutMs: 60000,
    maxInputTokens: 8000,
    maxOutputTokens: 2000,
    maxBillableTokens: 10000,
    maxCostUsd: 0.5,
    reservationRef: 'res-req-prov-001',
    dispatchState: 'reserved',
    ...overrides,
  };
}

function createValidProviderApprovedPlanContext(
  overrides?: Partial<Record<string, unknown>>
): ProviderAdmissionContextV02 {
  const providerRequest = createValidProviderRequest();
  const requestContentDigest = computeRequestContentDigest(providerRequest);
  const context: Record<string, unknown> = {
    schemaVersion: '0.2.0',
    subjectKind: 'provider-request',
    planApplicability: 'approved-plan',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: 1,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: 1,
    expectedEpoch: 1,
    taskId: 'task-calc-001',
    runId: 'run-001',
    providerRequest,
    providerRequestId: providerRequest.providerRequestId,
    role: 'coder',
    requestContentDigest,
    providerIdentity: {
      providerId: 'provider-test',
      modelId: 'model-test-01',
      configId: 'config-coder-v1',
      configVersion: '1.0.0',
      pricingPolicyId: 'pricing-standard-v1',
      pricingPolicyVersion: '1.0.0',
      issuerKeyRef: 'key-prov-001',
      decisionAuthorityGeneration: 2,
    },
    providerAdmissionReceipt: {
      receiptId: 'prov-rec-001',
      receiptDigest: 'sha256:provrecdigest000000000000000000000000000000000000000000000000000',
      providerRequestId: providerRequest.providerRequestId,
      role: 'coder',
      requestContentDigest,
      providerId: 'provider-test',
      modelId: 'model-test-01',
      configId: 'config-coder-v1',
      configVersion: '1.0.0',
      decisionAuthorityGeneration: 2,
    },
    planBindingDigest: 'sha256:planbindingdigest00000000000000000000000000000000000000000000000',
    planDecisionRef: 'dec-plan-001',
    requestReservationReceipt: 'res-req-prov-001',
    budgetRefs: ['budget-token-001', 'budget-cost-001'],
    finiteBounds: {
      maxInputTokens: 8000,
      maxOutputTokens: 2000,
      maxCostUsd: 0.5,
    },
    ...overrides,
  };

  return context as unknown as ProviderAdmissionContextV02;
}

function createValidProviderPrePlanDiagnosticContext(
  overrides?: Partial<Record<string, unknown>>
): ProviderAdmissionContextV02 {
  const providerRequest = createValidProviderRequest({
    providerRequestId: 'req-prov-rev-001',
    role: 'reviewer',
    purpose: 'investigate_diagnostic',
  });
  const requestContentDigest = computeRequestContentDigest(providerRequest);
  const context: Record<string, unknown> = {
    schemaVersion: '0.2.0',
    subjectKind: 'provider-request',
    planApplicability: 'pre-plan-diagnostic',
    diagnosticPurpose: 'investigation',
    taskCriteriaDigest: 'sha256:criteria00000000000000000000000000000000000000000000000000000000',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: 0,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: 0,
    expectedEpoch: 1,
    taskId: 'task-calc-001',
    runId: 'run-001',
    providerRequest,
    providerRequestId: providerRequest.providerRequestId,
    role: 'reviewer',
    requestContentDigest,
    providerIdentity: {
      providerId: 'provider-test',
      modelId: 'model-test-01',
      configId: 'config-coder-v1',
      configVersion: '1.0.0',
      pricingPolicyId: 'pricing-standard-v1',
      pricingPolicyVersion: '1.0.0',
      issuerKeyRef: 'key-prov-001',
      decisionAuthorityGeneration: 1,
    },
    providerAdmissionReceipt: {
      receiptId: 'prov-rec-diag-001',
      receiptDigest: 'sha256:provrecdiagdigest00000000000000000000000000000000000000000000000',
      providerRequestId: providerRequest.providerRequestId,
      role: 'reviewer',
      requestContentDigest,
      providerId: 'provider-test',
      modelId: 'model-test-01',
      configId: 'config-coder-v1',
      configVersion: '1.0.0',
      decisionAuthorityGeneration: 1,
    },
    requestReservationReceipt: 'res-req-prov-rev-001',
    budgetRefs: ['budget-token-001', 'budget-cost-001', 'budget-reviewer-iter-001'],
    finiteBounds: {
      maxInputTokens: 8000,
      maxOutputTokens: 2000,
      maxCostUsd: 0.5,
      maxReviewerIterations: 2,
    },
    ...overrides,
  };

  return context as unknown as ProviderAdmissionContextV02;
}

/* ------------------------------------------------------------------
 * Positive Vectors (Behavioral RED under T037 -> GREEN under T038)
 * ------------------------------------------------------------------ */

test('Positive vector: valid repository admission in approved-plan mode (RED in T037, GREEN in T038)', () => {
  const context = createValidRepositoryApprovedPlanContext();
  const res = validateRepositoryAdmissionV02(context);
  assert.equal(
    res.ok,
    true,
    'Valid approved-plan repository context must be accepted by SUT validator'
  );
  if (res.ok) {
    assert.equal(res.value.subjectKind, 'repository-action');
    assert.equal(res.value.planApplicability, 'approved-plan');
  }
});

test('Positive vector: valid repository admission in pre-plan-diagnostic mode (RED in T037, GREEN in T038)', () => {
  const context = createValidRepositoryPrePlanDiagnosticContext();
  const res = validateRepositoryAdmissionV02(context);
  assert.equal(
    res.ok,
    true,
    'Valid pre-plan-diagnostic repository context must be accepted by SUT validator'
  );
  if (res.ok) {
    assert.equal(res.value.subjectKind, 'repository-action');
    assert.equal(res.value.planApplicability, 'pre-plan-diagnostic');
  }
});

test('Positive vector: valid repository pre-plan-diagnostic test-only patch (RED in T037, GREEN in T038)', () => {
  const patchAction = createValidDiagnosticPatchAction();
  const actionDigest = computeActionDigest(patchAction);
  const context = createValidRepositoryPrePlanDiagnosticContext({
    action: patchAction,
    actionDigest,
    baseRevision: patchAction.baseRevisionDigest,
    targetPaths: patchAction.targetPaths,
    patchDigest: computeCanonicalSha256(patchAction.patchContent),
    commandView: undefined,
    finiteBounds: {
      maxPatchBytes: 4096,
      maxChangedPaths: 1,
    },
    reservationRefs: ['res-test-patch-001'],
  });
  const res = validateRepositoryAdmissionV02(context);
  assert.equal(
    res.ok,
    true,
    'Valid pre-plan-diagnostic test-only patch context must be accepted by SUT validator'
  );
  if (res.ok) {
    assert.equal(res.value.planApplicability, 'pre-plan-diagnostic');
    assert.equal(res.value.action.kind, 'apply_patch');
  }
});

test('Positive vector: valid provider admission for coder in approved-plan mode (RED in T037, GREEN in T038)', () => {
  const context = createValidProviderApprovedPlanContext();
  const res = validateProviderAdmissionV02(context);
  assert.equal(
    res.ok,
    true,
    'Valid approved-plan provider context for coder must be accepted by SUT validator'
  );
  if (res.ok) {
    assert.equal(res.value.subjectKind, 'provider-request');
    assert.equal(res.value.role, 'coder');
  }
});

test('Positive vector: valid provider admission for reviewer in pre-plan-diagnostic mode (RED in T037, GREEN in T038)', () => {
  const context = createValidProviderPrePlanDiagnosticContext();
  const res = validateProviderAdmissionV02(context);
  assert.equal(
    res.ok,
    true,
    'Valid pre-plan-diagnostic provider context for reviewer must be accepted by SUT validator'
  );
  if (res.ok) {
    assert.equal(res.value.subjectKind, 'provider-request');
    assert.equal(res.value.role, 'reviewer');
  }
});

test('Tagged union admission validator validates both repository and provider contexts (RED in T037, GREEN in T038)', () => {
  const repoContext = createValidRepositoryApprovedPlanContext();
  const provContext = createValidProviderApprovedPlanContext();

  const repoRes = validateAdmissionV02(repoContext);
  assert.equal(repoRes.ok, true, 'validateAdmissionV02 must accept valid repository context');

  const provRes = validateAdmissionV02(provContext);
  assert.equal(provRes.ok, true, 'validateAdmissionV02 must accept valid provider context');
});

test('Digest computation helpers: computeAdmissionDigest produces stable sha256', () => {
  const context = createValidRepositoryApprovedPlanContext();
  const digest1 = computeAdmissionDigest(context);
  const digest2 = computeAdmissionDigest(context);
  assert.equal(digest1, digest2);
  assert.ok(digest1.startsWith('sha256:'), 'Admission digest must have sha256 prefix');
});

/* ------------------------------------------------------------------
 * Negative Vectors (Fail-Closed Denials: must pass even in T037)
 * ------------------------------------------------------------------ */

test('Malformed input: non-object or null denies immediately', () => {
  assert.equal(validateRepositoryAdmissionV02(null).ok, false);
  assert.equal(validateRepositoryAdmissionV02('not-an-object').ok, false);
  assert.equal(validateRepositoryAdmissionV02(42).ok, false);
  assert.equal(validateRepositoryAdmissionV02([]).ok, false);

  assert.equal(validateProviderAdmissionV02(null).ok, false);
  assert.equal(validateProviderAdmissionV02(undefined).ok, false);
  assert.equal(validateProviderAdmissionV02(true).ok, false);

  assert.equal(validateAdmissionV02(null).ok, false);
  assert.equal(validateAdmissionV02({ subjectKind: 'invalid-kind' }).ok, false);
});

test('Cross-branch rejection: provider fields on repository context deny', () => {
  const context = createValidRepositoryApprovedPlanContext({
    providerRequestId: 'req-prov-leak-001',
  });
  const res = validateRepositoryAdmissionV02(context);
  assert.equal(res.ok, false, 'Provider field on repository context must be rejected');
  assert.ok(
    res.errors.some((e) => e.code === 'CROSS_BRANCH_FIELDS_FORBIDDEN'),
    'Expected CROSS_BRANCH_FIELDS_FORBIDDEN error code'
  );
});

test('Cross-branch rejection: repository action fields on provider context deny', () => {
  const context = createValidProviderApprovedPlanContext({
    action: createValidPatchAction(),
  });
  const res = validateProviderAdmissionV02(context);
  assert.equal(res.ok, false, 'Repository action field on provider context must be rejected');
  assert.ok(
    res.errors.some((e) => e.code === 'CROSS_BRANCH_FIELDS_FORBIDDEN'),
    'Expected CROSS_BRANCH_FIELDS_FORBIDDEN error code'
  );
});

test('Plan applicability rejection: pre-plan-diagnostic with planBindingDigest denies', () => {
  const repoContext = createValidRepositoryPrePlanDiagnosticContext({
    planBindingDigest: 'sha256:unexpectedplanbinding000000000000000000000000000000000000',
  });
  const res = validateRepositoryAdmissionV02(repoContext);
  assert.equal(res.ok, false, 'pre-plan-diagnostic with planBindingDigest must deny');
});

test('Plan applicability rejection: approved-plan missing planBindingDigest denies', () => {
  const repoContext = createValidRepositoryApprovedPlanContext({
    planBindingDigest: undefined,
  });
  const res = validateRepositoryAdmissionV02(repoContext);
  assert.equal(res.ok, false, 'approved-plan missing planBindingDigest must deny');
});

test('Pre-plan diagnostic test-only patch: cannot edit production paths', () => {
  const prodPatchAction = createValidPatchAction(); // targets src/calculator.py
  const repoContext = createValidRepositoryPrePlanDiagnosticContext({
    action: prodPatchAction,
    actionDigest: computeActionDigest(prodPatchAction),
    baseRevision: prodPatchAction.baseRevisionDigest,
    targetPaths: prodPatchAction.targetPaths,
    patchDigest: computeCanonicalSha256(prodPatchAction.patchContent),
    finiteBounds: {
      maxPatchBytes: 4096,
      maxChangedPaths: 1,
    },
  });
  const res = validateRepositoryAdmissionV02(repoContext);
  assert.equal(
    res.ok,
    false,
    'Pre-plan diagnostic patch editing production path must be denied'
  );
});

test('Digest mismatch: tampered action payload fails validation', () => {
  const action = createValidPatchAction();
  const tamperedAction: ApplyPatchAction = {
    ...action,
    patchContent: action.patchContent + '\n# malicious tampering',
  };
  const context = createValidRepositoryApprovedPlanContext({
    action: tamperedAction,
    actionDigest: computeActionDigest(action), // does not match tampered action
  });
  const res = validateRepositoryAdmissionV02(context);
  assert.equal(res.ok, false, 'Action digest mismatch must be rejected');
});

test('Digest mismatch: tampered provider request fails validation', () => {
  const request = createValidProviderRequest();
  const tamperedRequest: ProviderRequest = {
    ...request,
    maxCostUsd: 999.0, // tampered cost ceiling
  };
  const context = createValidProviderApprovedPlanContext({
    providerRequest: tamperedRequest,
    requestContentDigest: computeRequestContentDigest(request), // original digest
  });
  const res = validateProviderAdmissionV02(context);
  assert.equal(res.ok, false, 'Provider request content digest mismatch must be rejected');
});

test('Finite bounds: unbounded, NaN, negative, or missing limits deny', () => {
  const context = createValidRepositoryPrePlanDiagnosticContext({
    finiteBounds: {
      timeoutMs: -1, // invalid negative timeout
      maxOutputBytes: 1000,
      isolationProfileRef: 'profile-01',
    },
  });
  const res = validateRepositoryAdmissionV02(context);
  assert.equal(res.ok, false, 'Invalid negative timeout must deny');
});

test('Command view: read-only fact mountedReadOnly !== true denies', () => {
  const context = createValidRepositoryPrePlanDiagnosticContext({
    commandView: {
      viewId: 'view-01',
      viewDigest: 'sha256:view01',
      taskId: 'task-calc-001',
      workspaceId: 'workspace-001',
      canonicalRevision: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      admittedFiles: [{ path: 'tests/test_calculator.py', digest: 'sha256:file01' }],
      exclusionsPolicyVersion: '1.0.0',
      scratchIdentity: 'scratch-01',
      mountedReadOnly: false, // INVALID!
      isolationProfileRef: 'profile-01',
    },
  });
  const res = validateRepositoryAdmissionV02(context);
  assert.equal(res.ok, false, 'mountedReadOnly: false must deny');
});

test('Command view: protected paths in admittedFiles deny', () => {
  const context = createValidRepositoryPrePlanDiagnosticContext({
    commandView: {
      viewId: 'view-01',
      viewDigest: 'sha256:view01',
      taskId: 'task-calc-001',
      workspaceId: 'workspace-001',
      canonicalRevision: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      admittedFiles: [{ path: '.env', digest: 'sha256:secretfile01' }],
      exclusionsPolicyVersion: '1.0.0',
      scratchIdentity: 'scratch-01',
      mountedReadOnly: true,
      isolationProfileRef: 'profile-01',
    },
  });
  const res = validateRepositoryAdmissionV02(context);
  assert.equal(res.ok, false, 'Admitted .env file must deny');
});

test('Authority generation and policy: FORBIDDEN policy evaluation result denies', () => {
  const context = createValidRepositoryApprovedPlanContext({
    policyEvaluationReceipt: {
      receiptId: 'pe-receipt-001',
      receiptDigest: 'sha256:pereceiptdigest00000000000000000000000000000000000000000000000000',
      actionDigest: computeActionDigest(createValidPatchAction()),
      freshnessContextDigest: 'sha256:freshness00000000000000000000000000000000000000000000000000',
      policyId: 'policy-default',
      policyVersion: '1.0.0',
      configId: 'config-default',
      configVersion: '1.0.0',
      decisionAuthorityGeneration: 3,
      result: 'FORBIDDEN',
    },
  });
  const res = validateRepositoryAdmissionV02(context);
  assert.equal(res.ok, false, 'FORBIDDEN policy result must deny');
});

test('Authority generation mismatch: receipt generation != authority ref generation denies', () => {
  const context = createValidRepositoryApprovedPlanContext({
    policyEvaluationReceipt: {
      receiptId: 'pe-receipt-001',
      receiptDigest: 'sha256:pereceiptdigest00000000000000000000000000000000000000000000000000',
      actionDigest: computeActionDigest(createValidPatchAction()),
      freshnessContextDigest: 'sha256:freshness00000000000000000000000000000000000000000000000000',
      policyId: 'policy-default',
      policyVersion: '1.0.0',
      configId: 'config-default',
      configVersion: '1.0.0',
      decisionAuthorityGeneration: 99, // MISMATCH
      result: 'ALLOWED',
    },
  });
  const res = validateRepositoryAdmissionV02(context);
  assert.equal(res.ok, false, 'Decision authority generation mismatch must deny');
});

test('No optional legacy context fallback: version 2 requires context', () => {
  assert.equal(validateRepositoryAdmissionV02(undefined).ok, false);
  assert.equal(validateProviderAdmissionV02(undefined).ok, false);
  assert.equal(validateAdmissionV02(undefined).ok, false);
});
