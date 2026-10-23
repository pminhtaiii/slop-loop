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
  type NormalizedAction,
  type ProviderRequest,
  type ProviderUsage,
  computeClaimClosureDigest,
  computeAttemptOutcomeDigest,
  computeReconciliationDigest,
  validateProtocolVersionProgressionV02,
  validateAttemptReceiptV02,
  validateClaimClosureReceiptV02,
  validateRepositoryActionOutcomeReceiptV02,
  validateProviderRequestOutcomeReceiptV02,
  validateAttemptOutcomeReceiptV02,
  validateUncertainAttemptReconciliationReceiptV02,
  validateObservedOutcomeReconciliationReceiptV02,
  validateAttemptReconciliationReceiptV02,
  type AttemptReceiptV02,
  type AttemptOutcomeValidationContextV02,
  type AttemptOutcomeReceiptV02,
  type AttemptReconciliationValidationContextV02,
  type ClaimReceiptV02,
  type ClaimClosureReceiptV02,
  type ExecutorIdentityV02,
  type RepositoryActionOutcomeReceiptV02,
  type ProviderRequestOutcomeReceiptV02,
  type UncertainAttemptReconciliationReceiptV02,
  type ObservedOutcomeReconciliationReceiptV02,
} from '../../../src/contracts/foundation/uc03.ts';
import {
  computeRequestContentDigest,
  computeAdmissionDigest,
  validateRepositoryAdmissionV02 as validateRepositoryAdmissionBoundaryV02,
  validateProviderAdmissionV02 as validateProviderAdmissionBoundaryV02,
  validateAdmissionV02 as validateAdmissionBoundaryV02,
} from '../../../src/contracts/foundation/uc03/admission-v02.ts';
import type {
  RepositoryAdmissionContextV02,
  ProviderAdmissionContextV02,
} from '../../../src/contracts/foundation/uc03/ports-v02.ts';

function createPolicyEvaluationReceipt(fields: Record<string, unknown>): Record<string, unknown> {
  const digestInput = { ...fields, receiptDigest: undefined };
  return { ...digestInput, receiptDigest: computeCanonicalSha256(digestInput) };
}

function trustedRepositoryFixture(prePlan = false, context?: RepositoryAdmissionContextV02): Record<string, unknown> {
  const diagnosticReceipt = createPolicyEvaluationReceipt({
    receiptId: 'pe-receipt-diag-001',
    actionDigest: computeActionDigest(createValidCommandAction()),
    freshnessContextDigest: 'sha256:freshnessdiag0000000000000000000000000000000000000000000000',
    policyId: 'policy-default', policyVersion: '1.0.0', configId: 'config-default', configVersion: '1.0.0',
    decisionAuthorityGeneration: 1, result: 'ALLOWED',
  });
  const overrides: Record<string, unknown> = prePlan ? {
    taskStateSchemaVersion: '0.2.0', expectedTaskStateVersion: 0, controlSchemaVersion: '0.2.0',
    expectedControlVersion: 0, expectedEpoch: 1, runnableNode: 'Investigate',
    planApplicability: 'pre-plan-diagnostic', planBindingDigest: undefined, planDecisionRef: undefined,
    policyAuthorityRef: { policyId: 'policy-default', policyVersion: '1.0.0', configId: 'config-default', configVersion: '1.0.0', issuerKeyRef: 'key-authority-001', decisionAuthorityGeneration: 1 },
    policyEvaluationReceiptRef: diagnosticReceipt['receiptId'],
    policyEvaluationReceiptDigest: diagnosticReceipt['receiptDigest'],
    freshnessContextDigest: diagnosticReceipt['freshnessContextDigest'],
  } : {};
  if (context) {
    const receipt = context.policyEvaluationReceipt as unknown as Record<string, unknown>;
    overrides['policyEvaluationReceiptRef'] = receipt['receiptId'];
    overrides['policyEvaluationReceiptDigest'] = receipt['receiptDigest'];
    overrides['freshnessContextDigest'] = receipt['freshnessContextDigest'];
    if (context.actionDecisionReceipt) {
      overrides['actionDecisionReceiptRef'] = context.actionDecisionReceipt.decisionId;
      overrides['actionDecisionReceiptDigest'] = context.actionDecisionReceipt.decisionDigest;
    }
  }
  return createTrustedRepositoryFacts(overrides);
}

function validateRepositoryAdmissionV02(input: unknown, trust: unknown = trustedRepositoryFixture()) {
  return validateRepositoryAdmissionBoundaryV02(input, trust as never);
}

function trustedProviderFixture(reviewer = false, requestOverrides: Partial<ProviderRequest> = {}): Record<string, unknown> {
  const request = reviewer
    ? createValidProviderRequest({ providerRequestId: 'req-prov-rev-001', role: 'reviewer', purpose: 'investigate_diagnostic', reservationRef: 'res-req-prov-rev-001', ...requestOverrides })
    : createValidProviderRequest(requestOverrides);
  const role = reviewer ? 'reviewer' : 'coder';
  return {
    subjectKind: 'provider-request',
    taskStateSchemaVersion: '0.2.0', expectedTaskStateVersion: reviewer ? 0 : 1,
    controlSchemaVersion: '0.2.0', expectedControlVersion: reviewer ? 0 : 1, expectedEpoch: 1,
    taskId: 'task-calc-001', runId: 'run-001', runnableNode: reviewer ? 'Investigate' : 'Repair', role,
    planApplicability: reviewer ? 'pre-plan-diagnostic' : 'approved-plan',
    planBindingDigest: reviewer ? undefined : 'sha256:planbindingdigest00000000000000000000000000000000000000000000000',
    planDecisionRef: reviewer ? undefined : 'dec-plan-001',
    diagnosticPurpose: reviewer ? 'investigation' : undefined,
    taskCriteriaDigest: reviewer ? 'sha256:criteria00000000000000000000000000000000000000000000000000000000' : undefined,
    providerRequestId: request.providerRequestId, requestContentDigest: computeRequestContentDigest(request),
    providerAdmissionReceiptRef: reviewer ? 'prov-rec-diag-001' : 'prov-rec-001',
    providerAdmissionReceiptDigest: reviewer
      ? 'sha256:provrecdiagdigest00000000000000000000000000000000000000000000000'
      : 'sha256:provrecdigest000000000000000000000000000000000000000000000000000',
    requestReservationReceipt: request.reservationRef,
    budgetRefs: reviewer ? ['budget-token-001', 'budget-cost-001', 'budget-reviewer-iter-001'] : ['budget-token-001', 'budget-cost-001'],
    providerIdentity: {
      providerId: 'provider-test', modelId: 'model-test-01', configId: 'config-coder-v1', configVersion: '1.0.0',
      pricingPolicyId: 'pricing-standard-v1', pricingPolicyVersion: '1.0.0', issuerKeyRef: 'key-prov-001', decisionAuthorityGeneration: reviewer ? 1 : 2,
    },
    requestLimits: {
      timeoutMs: 60000, maxInputTokens: 8000, maxOutputTokens: 2000, maxBillableTokens: 10000,
      maxCostUsd: 0.5, ...(reviewer ? { maxReviewerIterations: 3 } : {}),
    },
  };
}

function validateProviderAdmissionV02(input: unknown, trust: unknown = trustedProviderFixture()) {
  return validateProviderAdmissionBoundaryV02(input, trust as never);
}

function validateAdmissionV02(input: unknown, trust?: unknown) {
  const subject = typeof input === 'object' && input !== null ? (input as Record<string, unknown>)['subjectKind'] : undefined;
  const trusted = trust ?? (subject === 'provider-request'
    ? trustedProviderFixture()
    : trustedRepositoryFixture());
  return validateAdmissionBoundaryV02(input, trusted as never);
}

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
    policyEvaluationReceipt: createPolicyEvaluationReceipt({
      receiptId: 'pe-receipt-001',
      actionDigest,
      freshnessContextDigest: 'sha256:freshness00000000000000000000000000000000000000000000000000',
      policyId: 'policy-default',
      policyVersion: '1.0.0',
      configId: 'config-default',
      configVersion: '1.0.0',
      decisionAuthorityGeneration: 3,
      result: 'ALLOWED',
    }),
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

function createApprovalRequiredRepositoryAdmission(decisionId = 'decision-action-required-001'): RepositoryAdmissionContextV02 {
  const base = createValidRepositoryApprovedPlanContext();
  const decision = {
    decisionId, decisionDigest: computeCanonicalSha256(decisionId), actionDigest: base.actionDigest,
    evaluationReceiptRef: base.policyEvaluationReceipt.receiptId,
    decisionAuthorityGeneration: base.policyAuthorityRef.decisionAuthorityGeneration, status: 'approved',
  };
  const context = {
    ...base,
    policyEvaluationReceipt: createPolicyEvaluationReceipt({
      ...(base.policyEvaluationReceipt as unknown as Record<string, unknown>),
      result: 'APPROVAL_REQUIRED',
    }),
    actionDecisionReceipt: decision,
  } as unknown as RepositoryAdmissionContextV02;
  const result = validateRepositoryAdmissionV02(context, trustedRepositoryFixture(false, context));
  if (!result.ok) throw new Error(`Approval-required admission fixture is invalid: ${result.errors.map(({ code }) => code).join(',')}`);
  return result.value;
}

function createPatchContextWithTargets(
  actionTargets: readonly string[],
  declaredTargets: readonly unknown[],
  maxChangedPaths = 5,
): RepositoryAdmissionContextV02 {
  const base = createValidRepositoryApprovedPlanContext();
  const action = { ...base.action, targetPaths: [...actionTargets] } as ApplyPatchAction;
  const actionDigest = computeActionDigest(action);
  return {
    ...base,
    action,
    actionDigest,
    policyEvaluationReceipt: createPolicyEvaluationReceipt({
      ...(base.policyEvaluationReceipt as unknown as Record<string, unknown>),
      actionDigest,
    }),
    targetPaths: declaredTargets as readonly string[],
    finiteBounds: { maxPatchBytes: 4096, maxChangedPaths },
  } as unknown as RepositoryAdmissionContextV02;
}

function createValidRepositoryPrePlanDiagnosticContext(
  overrides?: Partial<Record<string, unknown>>
): RepositoryAdmissionContextV02 {
  const action = (overrides?.action as NormalizedAction | undefined) ?? createValidCommandAction();
  const actionDigest = (overrides?.actionDigest as string | undefined) ?? computeActionDigest(action);
  const context: Record<string, unknown> = {
    schemaVersion: '0.2.0',
    subjectKind: 'repository-action',
    planApplicability: 'pre-plan-diagnostic',
    ...(action.kind === 'run_command' ? { checkId: 'check-pytest-repro', testPath: 'tests/test_calculator.py' } : {}),
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
    policyEvaluationReceipt: createPolicyEvaluationReceipt({
      receiptId: 'pe-receipt-diag-001',
      actionDigest,
      freshnessContextDigest: 'sha256:freshnessdiag0000000000000000000000000000000000000000000000',
      policyId: 'policy-default',
      policyVersion: '1.0.0',
      configId: 'config-default',
      configVersion: '1.0.0',
      decisionAuthorityGeneration: 1,
      result: 'ALLOWED',
    }),
    ...(action.kind === 'run_command'
      ? {
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
        }
      : {}),
    reservationRefs: ['res-command-001'],
    ...overrides,
  };

  if (action.kind === 'run_command' && overrides?.commandView === undefined) {
    const commandView = { ...(context['commandView'] as Record<string, unknown>) };
    delete commandView['viewDigest'];
    context['commandView'] = { ...commandView, viewDigest: computeCanonicalSha256(commandView) };
  }

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
    runnableNode: 'Repair',
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
      maxBillableTokens: 10000,
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
    reservationRef: 'res-req-prov-rev-001',
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
    runnableNode: 'Investigate',
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
      maxBillableTokens: 10000,
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
  const res = validateRepositoryAdmissionV02(context, trustedRepositoryFixture(true, context));
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
    testPath: 'tests/test_calculator.py',
    commandView: undefined,
    finiteBounds: {
      maxPatchBytes: 4096,
      maxChangedPaths: 1,
    },
    reservationRefs: ['res-test-patch-001'],
  });
  const res = validateRepositoryAdmissionV02(context, trustedRepositoryFixture(true, context));
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
  const res = validateProviderAdmissionV02(context, trustedProviderFixture(true));
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
  const res = validateRepositoryAdmissionV02(repoContext, trustedRepositoryFixture(true));
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
  const res = validateRepositoryAdmissionV02(repoContext, trustedRepositoryFixture(true));
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
  const res = validateRepositoryAdmissionV02(context, trustedRepositoryFixture(true));
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
  const res = validateRepositoryAdmissionV02(context, trustedRepositoryFixture(true));
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
  const res = validateRepositoryAdmissionV02(context, trustedRepositoryFixture(true));
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


// ============================================================================
// UC-03 v0.2.0 Attempt, Outcome, and Reconciliation Tests (T039 / T040)
// ============================================================================

function createValidExecutor(): ExecutorIdentityV02 {
  return {
    adapterIdentity: 'adapter-worker-01',
    processIncarnation: 'proc-100',
    fencingGeneration: 1,
    payloadDigest: 'sha256:payload00000000000000000000000000000000000000000000000000000000',
  };
}

function createValidAttemptReceipt(): AttemptReceiptV02 {
  return {
    attemptId: 'att-001',
    claimId: 'claim-001',
    taskId: 'task-001',
    executorIdentity: createValidExecutor(),
    preAttemptTaskStateVersion: 0,
    postBeginTaskStateVersion: 0,
    preAttemptControlVersion: 1,
    postBeginControlVersion: 2,
    epoch: 0,
    status: 'attempting',
  };
}

function createValidClaimClosureReceipt(): ClaimClosureReceiptV02 {
  const raw = {
    receiptId: 'closure-001',
    receiptDigest: 'sha256:placeholder',
    claimId: 'claim-001',
    taskId: 'task-001',
    reason: 'worker cancelled before attempt dispatch',
    fencedExecutorIdentity: createValidExecutor(),
    unconsumedReservations: ['res-1'],
  };
  return {
    ...raw,
    receiptDigest: computeClaimClosureDigest(raw),
  };
}

function createValidClaimClosureContext(reservationRefs: readonly string[] = ['res-1']) {
  return {
    expectedTaskId: 'task-001',
    expectedClaimId: 'claim-001',
    claim: {
      claimId: 'claim-001',
      claimDigest: 'sha256:claim-001',
      taskId: 'task-001',
      status: 'claimed',
      hasCommittedAttempt: false,
      reservationRefs: [...reservationRefs],
    },
    hasCommittedAttempt: false,
    expectedAdapterIdentity: 'adapter-worker-01',
    expectedMinFencingGeneration: 1,
    expectedFencedExecutorIdentity: createValidExecutor(),
  };
}

function createTrustedOutcomeContext(
  subject: 'repository-action' | 'provider-request',
  planApplicability: 'approved-plan' | 'pre-plan-diagnostic',
  admissionOverride?: RepositoryAdmissionContextV02 | ProviderAdmissionContextV02,
): AttemptOutcomeValidationContextV02 {
  const admission = admissionOverride ?? (subject === 'repository-action'
    ? planApplicability === 'approved-plan' ? createValidRepositoryApprovedPlanContext() : createValidRepositoryPrePlanDiagnosticContext()
    : planApplicability === 'approved-plan' ? createValidProviderApprovedPlanContext() : createValidProviderPrePlanDiagnosticContext());
  const admissionReservations = admission.subjectKind === 'repository-action' ? admission.reservationRefs : [admission.requestReservationReceipt, ...admission.budgetRefs];
  const claim: ClaimReceiptV02 = {
    claimId: 'claim-001',
    claimDigest: computeCanonicalSha256('trusted-claim-001'),
    taskId: admission.taskId,
    runId: admission.runId,
    subjectKind: admission.subjectKind,
    planApplicability: admission.planApplicability,
    preClaimTaskStateVersion: admission.expectedTaskStateVersion,
    preClaimControlVersion: admission.expectedControlVersion,
    postClaimControlVersion: admission.expectedControlVersion + 1,
    epoch: admission.expectedEpoch,
    status: 'claimed',
    reservationRefs: [...admissionReservations],
  };
  const patchAttempt = admission.subjectKind === 'repository-action' && admission.action.kind === 'apply_patch';
  const attempt = {
    attemptId: 'att-001',
    claimId: claim.claimId,
    taskId: claim.taskId,
    executorIdentity: createValidExecutor(),
    preAttemptTaskStateVersion: claim.preClaimTaskStateVersion,
    postBeginTaskStateVersion: claim.preClaimTaskStateVersion + (patchAttempt ? 1 : 0),
    preAttemptControlVersion: claim.postClaimControlVersion,
    postBeginControlVersion: claim.postClaimControlVersion + 1,
    epoch: claim.epoch,
  };
  return {
    trustedAdmission: admission,
    trustedClaim: claim,
    trustedAttempt: attempt,
    currentClaimStatus: 'attempting',
    currentTaskStateVersion: attempt.postBeginTaskStateVersion,
    currentControlVersion: attempt.postBeginControlVersion,
    currentEpoch: attempt.epoch,
  };
}

function createOutcomeEffects(admission: RepositoryAdmissionContextV02 | ProviderAdmissionContextV02, outcome: 'observed' | 'proven-not-dispatched' | 'uncertain', isPatch = false, resultRevisionDigest?: string, observedUsage?: ProviderUsage) {
  const references = admission.subjectKind === 'repository-action' ? admission.reservationRefs : [admission.requestReservationReceipt, ...admission.budgetRefs];
  return {
    taskTransition: outcome === 'observed' && isPatch
      ? { kind: 'transition' as const, fromNode: admission.runnableNode === 'Repair' ? 'Patch' : admission.runnableNode, toNode: 'Verify' }
      : { kind: 'none' as const },
    revision: outcome === 'observed' && isPatch && resultRevisionDigest
      ? { kind: 'advance' as const, revisionDigest: resultRevisionDigest }
      : admission.subjectKind === 'provider-request' ? { kind: 'not-applicable' as const } : { kind: 'preserve' as const },
    invalidatedEvidence: outcome === 'observed' && isPatch
      ? [{ reference: 'evidence-previous-baseline', digest: computeCanonicalSha256('previous-baseline') }]
      : [],
    accounting: {
      disposition: outcome === 'observed' ? 'settle' as const : outcome === 'uncertain' ? 'hold' as const : 'release-unused' as const,
      reservationRefs: [...references],
      ...(observedUsage ? { observedUsage } : {}),
    },
  };
}

function createValidRepoOutcomeReceipt(
  planApplicability: 'approved-plan' | 'pre-plan-diagnostic' = 'approved-plan',
  contextOverride?: AttemptOutcomeValidationContextV02,
): RepositoryActionOutcomeReceiptV02 {
  const context = contextOverride ?? createTrustedOutcomeContext('repository-action', planApplicability);
  const admission = context.trustedAdmission as RepositoryAdmissionContextV02;
  const isPatch = admission.action.kind === 'apply_patch';
  const revision = computeCanonicalSha256('observed-result-revision');
  const raw: Record<string, unknown> = {
    receiptId: 'repo-out-001', receiptDigest: 'sha256:placeholder', claimId: context.trustedClaim.claimId,
    claimDigest: context.trustedClaim.claimDigest, attemptId: context.trustedAttempt.attemptId,
    executorIdentity: context.trustedAttempt.executorIdentity, admissionDigest: computeAdmissionDigest(admission),
    versions: {
      taskStateSchemaVersion: admission.taskStateSchemaVersion, controlSchemaVersion: admission.controlSchemaVersion,
      preClaimTaskStateVersion: context.trustedClaim.preClaimTaskStateVersion,
      postClaimTaskStateVersion: context.trustedClaim.preClaimTaskStateVersion,
      postAttemptTaskStateVersion: context.trustedAttempt.postBeginTaskStateVersion,
      preClaimControlVersion: context.trustedClaim.preClaimControlVersion,
      postClaimControlVersion: context.trustedClaim.postClaimControlVersion,
      postAttemptControlVersion: context.trustedAttempt.postBeginControlVersion, epoch: admission.expectedEpoch,
    },
    resultRef: { reference: 'effect-repo-result', digest: computeCanonicalSha256('repo-result') },
    evidenceRefs: [{ reference: 'evidence-repo-observation', digest: computeCanonicalSha256('repo-observation') }],
    proposedEffects: createOutcomeEffects(admission, 'observed', isPatch, revision),
    subjectKind: 'repository-action', planApplicability, actionDigest: admission.actionDigest,
    repositoryOperation: isPatch ? 'apply-patch' : 'run-command', outcome: 'observed',
    policyAuthorityRef: admission.policyAuthorityRef,
    policyEvaluationReceiptRef: admission.policyEvaluationReceipt.receiptId,
    policyEvaluationReceiptDigest: admission.policyEvaluationReceipt.receiptDigest,
    freshnessContextDigest: admission.policyEvaluationReceipt.freshnessContextDigest,
    ...(isPatch ? { observedResultRevisionDigest: revision } : {}),
    ...(admission.actionDecisionReceipt ? {
      actionDecisionReceiptRef: admission.actionDecisionReceipt.decisionId,
      actionDecisionReceiptDigest: admission.actionDecisionReceipt.decisionDigest,
    } : {}),
  };
  if (planApplicability === 'approved-plan') {
    raw.planBindingDigest = admission.planBindingDigest;
    raw.planDecisionRef = admission.planDecisionRef;
    if (admission.diagnosticPurpose !== undefined) raw.diagnosticPurpose = admission.diagnosticPurpose;
    if (admission.taskCriteriaDigest !== undefined) raw.taskCriteriaDigest = admission.taskCriteriaDigest;
    if (admission.checkSetDigest !== undefined) raw.checkSetDigest = admission.checkSetDigest;
  } else {
    raw.diagnosticPurpose = admission.diagnosticPurpose;
    raw.taskCriteriaDigest = admission.taskCriteriaDigest;
    raw.checkSetDigest = admission.checkSetDigest;
  }
  return { ...raw, receiptDigest: computeAttemptOutcomeDigest(raw) } as unknown as RepositoryActionOutcomeReceiptV02;
}

function createValidProviderOutcomeReceipt(
  planApplicability: 'approved-plan' | 'pre-plan-diagnostic' = 'approved-plan',
  role: 'coder' | 'reviewer' = 'coder',
  contextOverride?: AttemptOutcomeValidationContextV02,
): ProviderRequestOutcomeReceiptV02 {
  const context = contextOverride ?? createTrustedOutcomeContext('provider-request', planApplicability);
  const admission = context.trustedAdmission as ProviderAdmissionContextV02;
  assert.equal(admission.role, role);
  const usage: ProviderUsage = { inputTokens: 1000, outputTokens: 200, billableTokens: 1200, costUsd: 0.02 };
  const raw: Record<string, unknown> = {
    receiptId: 'prov-out-001', receiptDigest: 'sha256:placeholder', claimId: context.trustedClaim.claimId,
    claimDigest: context.trustedClaim.claimDigest, attemptId: context.trustedAttempt.attemptId,
    executorIdentity: context.trustedAttempt.executorIdentity, admissionDigest: computeAdmissionDigest(admission),
    versions: {
      taskStateSchemaVersion: admission.taskStateSchemaVersion, controlSchemaVersion: admission.controlSchemaVersion,
      preClaimTaskStateVersion: context.trustedClaim.preClaimTaskStateVersion,
      postClaimTaskStateVersion: context.trustedClaim.preClaimTaskStateVersion,
      postAttemptTaskStateVersion: context.trustedAttempt.postBeginTaskStateVersion,
      preClaimControlVersion: context.trustedClaim.preClaimControlVersion,
      postClaimControlVersion: context.trustedClaim.postClaimControlVersion,
      postAttemptControlVersion: context.trustedAttempt.postBeginControlVersion, epoch: admission.expectedEpoch,
    },
    resultRef: { reference: 'effect-provider-result', digest: computeCanonicalSha256('provider-result') },
    evidenceRefs: [{ reference: 'evidence-provider-response', digest: computeCanonicalSha256('provider-response') }],
    proposedEffects: createOutcomeEffects(admission, 'observed', false, undefined, usage),
    subjectKind: 'provider-request', planApplicability, providerRequestId: admission.providerRequestId,
    requestContentDigest: admission.requestContentDigest, role: admission.role, outcome: 'observed',
    providerAdmissionReceiptRef: admission.providerAdmissionReceipt.receiptId,
    providerAdmissionReceiptDigest: admission.providerAdmissionReceipt.receiptDigest,
    requestReservationReceiptRef: admission.requestReservationReceipt,
    providerIdentity: admission.providerIdentity, budgetRefs: admission.budgetRefs, observedUsage: usage,
  };
  if (planApplicability === 'approved-plan') {
    raw.planBindingDigest = admission.planBindingDigest;
    raw.planDecisionRef = admission.planDecisionRef;
    if (admission.diagnosticPurpose !== undefined) raw.diagnosticPurpose = admission.diagnosticPurpose;
    if (admission.taskCriteriaDigest !== undefined) raw.taskCriteriaDigest = admission.taskCriteriaDigest;
  } else {
    raw.diagnosticPurpose = admission.diagnosticPurpose;
    raw.taskCriteriaDigest = admission.taskCriteriaDigest;
  }
  return { ...raw, receiptDigest: computeAttemptOutcomeDigest(raw) } as unknown as ProviderRequestOutcomeReceiptV02;
}

function redigestOutcome(receipt: Record<string, unknown>): Record<string, unknown> {
  const body = { ...receipt };
  delete body['receiptDigest'];
  return { ...body, receiptDigest: computeAttemptOutcomeDigest(body) };
}

function redigestReconciliation(receipt: Record<string, unknown>): Record<string, unknown> {
  const body = { ...receipt };
  delete body['reconciliationDigest'];
  return { ...body, reconciliationDigest: computeReconciliationDigest(body) };
}

function createValidPredecessorOutcome(
  outcome: 'observed' | 'uncertain',
  subject: 'repository-action' | 'provider-request' = 'repository-action',
  planApplicability: 'approved-plan' | 'pre-plan-diagnostic' = 'approved-plan',
  role: 'coder' | 'reviewer' = 'coder',
  admissionOverride?: RepositoryAdmissionContextV02 | ProviderAdmissionContextV02,
): AttemptOutcomeReceiptV02 {
  const context = createTrustedOutcomeContext(subject, planApplicability, admissionOverride);
  const base = subject === 'repository-action'
    ? createValidRepoOutcomeReceipt(planApplicability, context)
    : createValidProviderOutcomeReceipt(planApplicability, role, context);
  const raw = {
    ...base,
    outcome,
    proposedEffects: {
      ...base.proposedEffects,
      taskTransition: { kind: 'none' },
      revision: subject === 'repository-action' ? { kind: 'preserve' } : { kind: 'not-applicable' },
      accounting: { ...base.proposedEffects.accounting, disposition: outcome === 'uncertain' ? 'hold' : 'settle' },
    },
    receiptDigest: 'sha256:placeholder',
  };
  return { ...raw, receiptDigest: computeAttemptOutcomeDigest(raw) } as unknown as AttemptOutcomeReceiptV02;
}

function createReconciliationBase(
  predecessor: AttemptOutcomeReceiptV02,
  reconciliationKind: 'uncertain-attempt' | 'observed-unsettled',
  evidenceRefs: readonly { reference: string; digest: string }[],
  admissionOverride?: RepositoryAdmissionContextV02 | ProviderAdmissionContextV02,
): Record<string, unknown> {
  const context = createTrustedOutcomeContext(predecessor.subjectKind, predecessor.planApplicability, admissionOverride);
  const admission = context.trustedAdmission;
  const raw: Record<string, unknown> = {
    reconciliationId: reconciliationKind === 'uncertain-attempt' ? 'recon-001' : 'recon-002',
    reconciliationDigest: 'sha256:placeholder', reconciliationKind,
    predecessorReceiptId: predecessor.receiptId, predecessorReceiptDigest: predecessor.receiptDigest,
    admissionDigest: computeAdmissionDigest(admission), claimId: context.trustedClaim.claimId,
    claimDigest: context.trustedClaim.claimDigest, attemptId: context.trustedAttempt.attemptId,
    executorIdentity: context.trustedAttempt.executorIdentity, versions: predecessor.versions,
    evidenceRefs: [...evidenceRefs], expectedCurrentTaskStateVersion: context.currentTaskStateVersion,
    expectedCurrentControlVersion: context.currentControlVersion, expectedCurrentEpoch: context.currentEpoch,
    accountingIdentityDigest: computeCanonicalSha256('trusted-accounting-identity'),
    subjectKind: admission.subjectKind, planApplicability: admission.planApplicability,
  };
  if (admission.subjectKind === 'repository-action') Object.assign(raw, {
    actionDigest: admission.actionDigest,
    policyAuthorityRef: admission.policyAuthorityRef,
    policyEvaluationReceiptRef: admission.policyEvaluationReceipt.receiptId,
    policyEvaluationReceiptDigest: admission.policyEvaluationReceipt.receiptDigest,
    freshnessContextDigest: admission.policyEvaluationReceipt.freshnessContextDigest,
    ...(admission.actionDecisionReceipt ? {
      actionDecisionReceiptRef: admission.actionDecisionReceipt.decisionId,
      actionDecisionReceiptDigest: admission.actionDecisionReceipt.decisionDigest,
    } : {}),
  });
  else Object.assign(raw, {
    providerRequestId: admission.providerRequestId,
    requestContentDigest: admission.requestContentDigest,
    role: admission.role,
    providerAdmissionReceiptRef: admission.providerAdmissionReceipt.receiptId,
    providerAdmissionReceiptDigest: admission.providerAdmissionReceipt.receiptDigest,
    requestReservationReceiptRef: admission.requestReservationReceipt,
    budgetRefs: admission.budgetRefs,
    providerIdentity: admission.providerIdentity,
  });
  if (admission.planApplicability === 'approved-plan') Object.assign(raw, {
    planBindingDigest: admission.planBindingDigest,
    planDecisionRef: admission.planDecisionRef,
    ...(admission.diagnosticPurpose !== undefined ? { diagnosticPurpose: admission.diagnosticPurpose } : {}),
    ...(admission.taskCriteriaDigest !== undefined ? { taskCriteriaDigest: admission.taskCriteriaDigest } : {}),
    ...(admission.subjectKind === 'repository-action' && admission.checkSetDigest !== undefined ? { checkSetDigest: admission.checkSetDigest } : {}),
  });
  else Object.assign(raw, {
    diagnosticPurpose: admission.diagnosticPurpose,
    taskCriteriaDigest: admission.taskCriteriaDigest,
    ...(admission.subjectKind === 'repository-action' ? { checkSetDigest: admission.checkSetDigest } : {}),
  });
  return raw;
}

function createValidUncertainReconciliationReceipt(
  disposition: 'observed-and-accounted' | 'proven-not-dispatched' = 'observed-and-accounted',
  subject: 'repository-action' | 'provider-request' = 'repository-action',
  planApplicability: 'approved-plan' | 'pre-plan-diagnostic' = 'approved-plan',
  role: 'coder' | 'reviewer' = 'coder',
  admissionOverride?: RepositoryAdmissionContextV02 | ProviderAdmissionContextV02,
): UncertainAttemptReconciliationReceiptV02 {
  const predecessor = createValidPredecessorOutcome('uncertain', subject, planApplicability, role, admissionOverride);
  const context = createTrustedOutcomeContext(subject, planApplicability, admissionOverride);
  const effectEvidenceRef = { reference: 'effect-evidence-uncertain', digest: computeCanonicalSha256('effect-evidence-uncertain') };
  const accountingEvidenceRefs = [{ reference: 'accounting-evidence-uncertain', digest: computeCanonicalSha256('accounting-evidence-uncertain') }];
  const adapterEvidenceRefs = [{ reference: 'adapter-evidence-nondispatch', digest: computeCanonicalSha256('adapter-evidence-nondispatch') }];
  const fencingProof = { reference: 'fencing-proof-worker', digest: computeCanonicalSha256('fencing-proof-worker') };
  const raw: Record<string, unknown> = {
    ...createReconciliationBase(predecessor, 'uncertain-attempt', disposition === 'observed-and-accounted' ? [effectEvidenceRef, ...accountingEvidenceRefs] : [...adapterEvidenceRefs, fencingProof], admissionOverride),
    disposition,
    ...(disposition === 'observed-and-accounted'
      ? { effectEvidenceRef, accountingEvidenceRefs, ...(subject === 'provider-request' && predecessor.subjectKind === 'provider-request' ? { observedUsage: predecessor.observedUsage } : {}) }
      : { adapterEvidenceRefs, fencedRecipientIdentity: context.trustedAttempt.executorIdentity, fencingGeneration: context.trustedAttempt.executorIdentity.fencingGeneration + 1, fencingProof }),
  };
  return {
    ...raw,
    reconciliationDigest: computeReconciliationDigest(raw),
  } as unknown as UncertainAttemptReconciliationReceiptV02;
}

function createValidObservedReconciliationReceipt(
  subject: 'repository-action' | 'provider-request' = 'repository-action',
  planApplicability: 'approved-plan' | 'pre-plan-diagnostic' = 'approved-plan',
  role: 'coder' | 'reviewer' = 'coder',
  admissionOverride?: RepositoryAdmissionContextV02 | ProviderAdmissionContextV02,
): ObservedOutcomeReconciliationReceiptV02 {
  const predecessor = createValidPredecessorOutcome('observed', subject, planApplicability, role, admissionOverride);
  const evidenceRefs = [{ reference: 'evidence-observed-unsettled', digest: computeCanonicalSha256('evidence-observed-unsettled') }];
  const raw = createReconciliationBase(predecessor, 'observed-unsettled', evidenceRefs, admissionOverride);
  return {
    ...raw,
    reconciliationDigest: computeReconciliationDigest(raw),
  } as unknown as ObservedOutcomeReconciliationReceiptV02;
}

function createTrustedReconciliationContext(
  receipt: UncertainAttemptReconciliationReceiptV02 | ObservedOutcomeReconciliationReceiptV02,
  outcome: 'uncertain' | 'observed',
  admissionOverride?: RepositoryAdmissionContextV02 | ProviderAdmissionContextV02,
): AttemptReconciliationValidationContextV02 {
  const role = receipt.subjectKind === 'provider-request' ? receipt.role : 'coder';
  const predecessor = createValidPredecessorOutcome(outcome, receipt.subjectKind, receipt.planApplicability, role, admissionOverride);
  assert.equal(receipt.predecessorReceiptId, predecessor.receiptId);
  assert.equal(receipt.predecessorReceiptDigest, predecessor.receiptDigest);
  const base = createTrustedOutcomeContext(receipt.subjectKind, receipt.planApplicability, admissionOverride);
  const raw = receipt as unknown as Record<string, unknown>;
  const disposition = raw['disposition'];
  const proof = disposition === 'proven-not-dispatched' ? {
    fencedRecipientIdentity: raw['fencedRecipientIdentity'] as ExecutorIdentityV02,
    fencingGeneration: raw['fencingGeneration'] as number,
    proofRef: raw['fencingProof'] as { reference: string; digest: string },
  } : undefined;
  return {
    ...base,
    currentClaimStatus: outcome === 'uncertain' ? 'uncertain' : 'observed-unsettled',
    predecessorJournalStatus: outcome === 'uncertain' ? 'uncertain' : 'observed-unsettled',
    trustedPredecessor: predecessor,
    predecessorReceiptDigest: predecessor.receiptDigest,
    trustedEvidenceRefs: disposition === 'observed-and-accounted'
      ? raw['evidenceRefs'] as { reference: string; digest: string }[]
      : disposition === 'proven-not-dispatched'
        ? raw['adapterEvidenceRefs'] as { reference: string; digest: string }[]
        : raw['evidenceRefs'] as { reference: string; digest: string }[],
    ...(disposition === 'observed-and-accounted' ? {
      trustedObservedEffectRef: raw['effectEvidenceRef'] as { reference: string; digest: string },
      trustedAccountingEvidenceRefs: raw['accountingEvidenceRefs'] as { reference: string; digest: string }[],
      ...(raw['observedUsage'] !== undefined ? { trustedObservedUsage: raw['observedUsage'] as ProviderUsage } : {}),
    } : {}),
    trustedAccountingIdentityDigest: raw['accountingIdentityDigest'] as string,
    ...(proof ? { trustedFencingProof: proof } : {}),
  };
}

// ----------------------------------------------------------------------------
// Version Progression Tests
// ----------------------------------------------------------------------------

test('Positive: protocol version progression claim (S0/C0/E0 -> S0/C1/E0)', () => {
  const res = validateProtocolVersionProgressionV02({
    kind: 'claim',
    pre: { taskStateVersion: 0, controlVersion: 0, epoch: 0 },
    post: { taskStateVersion: 0, controlVersion: 1, epoch: 0 },
  });
  assert.equal(res.ok, true, 'Valid claim progression must pass');
});

test('Positive: protocol version progression non-repair begin-attempt (S0/C1/E0 -> S0/C2/E0)', () => {
  const res = validateProtocolVersionProgressionV02({
    kind: 'begin-attempt',
    pre: { taskStateVersion: 0, controlVersion: 1, epoch: 0 },
    post: { taskStateVersion: 0, controlVersion: 2, epoch: 0 },
    isRepairPatch: false,
  });
  assert.equal(res.ok, true, 'Valid non-repair begin-attempt progression must pass');
});

test('Positive: protocol version progression repair begin-attempt (S0/C1/E0 -> S1/C2/E0)', () => {
  const res = validateProtocolVersionProgressionV02({
    kind: 'begin-attempt',
    pre: { taskStateVersion: 0, controlVersion: 1, epoch: 0 },
    post: { taskStateVersion: 1, controlVersion: 2, epoch: 0 },
    isRepairPatch: true,
  });
  assert.equal(res.ok, true, 'Valid repair begin-attempt progression must pass');
});

test('Negative: progression rejects epoch drift (E0 -> E1)', () => {
  const res = validateProtocolVersionProgressionV02({
    kind: 'claim',
    pre: { taskStateVersion: 0, controlVersion: 0, epoch: 0 },
    post: { taskStateVersion: 0, controlVersion: 1, epoch: 1 },
  });
  assert.equal(res.ok, false);
});

test('Negative: progression rejects control version skip (C0 -> C2)', () => {
  const res = validateProtocolVersionProgressionV02({
    kind: 'claim',
    pre: { taskStateVersion: 0, controlVersion: 0, epoch: 0 },
    post: { taskStateVersion: 0, controlVersion: 2, epoch: 0 },
  });
  assert.equal(res.ok, false);
});

test('Negative: progression rejects task version mutation on claim (S0 -> S1)', () => {
  const res = validateProtocolVersionProgressionV02({
    kind: 'claim',
    pre: { taskStateVersion: 0, controlVersion: 0, epoch: 0 },
    post: { taskStateVersion: 1, controlVersion: 1, epoch: 0 },
  });
  assert.equal(res.ok, false);
});

test('Negative: progression rejects task version mutation on non-repair begin-attempt', () => {
  const res = validateProtocolVersionProgressionV02({
    kind: 'begin-attempt',
    pre: { taskStateVersion: 0, controlVersion: 1, epoch: 0 },
    post: { taskStateVersion: 1, controlVersion: 2, epoch: 0 },
    isRepairPatch: false,
  });
  assert.equal(res.ok, false);
});

test('Negative: progression rejects task version stagnation on repair begin-attempt', () => {
  const res = validateProtocolVersionProgressionV02({
    kind: 'begin-attempt',
    pre: { taskStateVersion: 0, controlVersion: 1, epoch: 0 },
    post: { taskStateVersion: 0, controlVersion: 2, epoch: 0 },
    isRepairPatch: true,
  });
  assert.equal(res.ok, false);
});

// ----------------------------------------------------------------------------
// Attempt Receipt Tests
// ----------------------------------------------------------------------------

test('Positive: valid AttemptReceiptV02 passes with matching context', () => {
  const receipt = createValidAttemptReceipt();
  const res = validateAttemptReceiptV02(receipt, {
    expectedTaskId: 'task-001',
    expectedClaimId: 'claim-001',
    expectedAttemptId: 'att-001',
    expectedEpoch: 0,
    isRepairPatch: false,
  });
  assert.equal(res.ok, true, 'Valid attempt receipt must pass');
});

test('Negative: attempt receipt rejects invalid status', () => {
  const receipt = { ...createValidAttemptReceipt(), status: 'completed' };
  const res = validateAttemptReceiptV02(receipt);
  assert.equal(res.ok, false);
});

test('Negative: attempt receipt rejects control version non-advancement', () => {
  const receipt = { ...createValidAttemptReceipt(), postBeginControlVersion: 1 };
  const res = validateAttemptReceiptV02(receipt);
  assert.equal(res.ok, false);
});

test('Negative: attempt receipt rejects context attemptId mismatch', () => {
  const receipt = createValidAttemptReceipt();
  const res = validateAttemptReceiptV02(receipt, { expectedAttemptId: 'att-mismatch' });
  assert.equal(res.ok, false);
});

// ----------------------------------------------------------------------------
// Claim Closure Receipt Tests
// ----------------------------------------------------------------------------

test('Positive: valid ClaimClosureReceiptV02 passes with proof of no attempt', () => {
  const closure = createValidClaimClosureReceipt();
  const res = validateClaimClosureReceiptV02(closure, createValidClaimClosureContext());
  assert.equal(res.ok, true, 'Valid claim closure receipt must pass');
});

test('Negative: claim closure rejects a receipt whose content changed without a new digest', () => {
  const closure = { ...createValidClaimClosureReceipt(), reason: 'changed after signing' };
  const res = validateClaimClosureReceiptV02(closure, createValidClaimClosureContext());
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.errors.some(({ code }) => code === 'RECEIPT_DIGEST_MISMATCH'));
});

test('Negative: claim closure reservations must exactly match the trusted claim', () => {
  const closure = createValidClaimClosureReceipt();
  const res = validateClaimClosureReceiptV02(closure, createValidClaimClosureContext(['res-foreign']));
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.errors.some(({ code }) => code === 'RESERVATION_REFS_MISMATCH'));
});

test('Claim closure digest omits an undefined receiptDigest field', () => {
  const closure = createValidClaimClosureReceipt();
  const withUndefined = { ...closure, receiptDigest: undefined };
  const withoutDigest = { ...closure } as Record<string, unknown>;
  delete withoutDigest['receiptDigest'];
  assert.equal(computeClaimClosureDigest(withUndefined), computeClaimClosureDigest(withoutDigest));
});

test('Negative: claim closure strictly forbids attemptId', () => {
  const closure = { ...createValidClaimClosureReceipt(), attemptId: 'att-forbidden' };
  const res = validateClaimClosureReceiptV02(closure);
  assert.equal(res.ok, false, 'Claim closure must forbid attemptId');
});

test('Negative: claim closure rejects cross-branch fields', () => {
  const closure = { ...createValidClaimClosureReceipt(), actionDigest: 'sha256:act00000000000000000000000000000000000000000000000000000000000000' };
  const res = validateClaimClosureReceiptV02(closure);
  assert.equal(res.ok, false, 'Claim closure must forbid cross-branch fields');
});

test('Negative: claim closure rejects if attempt already committed in context', () => {
  const closure = createValidClaimClosureReceipt();
  const res = validateClaimClosureReceiptV02(closure, {
    hasCommittedAttempt: true,
  });
  assert.equal(res.ok, false, 'Proof of no attempt violated');
});

test('Negative: claim closure rejects fencing generation below minimum', () => {
  const closure = createValidClaimClosureReceipt();
  const res = validateClaimClosureReceiptV02(closure, {
    expectedMinFencingGeneration: 5,
  });
  assert.equal(res.ok, false, 'Fencing generation too low must deny');
});

// ----------------------------------------------------------------------------
// Attempt Outcome Receipt Tests
// ----------------------------------------------------------------------------

test('Positive: valid RepositoryActionOutcomeReceiptV02 (approved-plan) passes', () => {
  const receipt = createValidRepoOutcomeReceipt('approved-plan');
  const res = validateRepositoryActionOutcomeReceiptV02(receipt, createTrustedOutcomeContext('repository-action', 'approved-plan'));
  assert.equal(res.ok, true, 'Valid repo outcome (approved-plan) must pass');
});

test('Positive: valid RepositoryActionOutcomeReceiptV02 (pre-plan-diagnostic) passes', () => {
  const receipt = createValidRepoOutcomeReceipt('pre-plan-diagnostic');
  const res = validateRepositoryActionOutcomeReceiptV02(receipt, createTrustedOutcomeContext('repository-action', 'pre-plan-diagnostic'));
  assert.equal(res.ok, true, 'Valid repo outcome (pre-plan) must pass');
});

test('Positive: valid ProviderRequestOutcomeReceiptV02 (approved-plan coder) passes', () => {
  const receipt = createValidProviderOutcomeReceipt('approved-plan', 'coder');
  const res = validateProviderRequestOutcomeReceiptV02(receipt, createTrustedOutcomeContext('provider-request', 'approved-plan'));
  assert.equal(res.ok, true, 'Valid provider outcome must pass');
});

test('Positive: valid ProviderRequestOutcomeReceiptV02 (pre-plan reviewer) passes', () => {
  const receipt = createValidProviderOutcomeReceipt('pre-plan-diagnostic', 'reviewer');
  const res = validateProviderRequestOutcomeReceiptV02(receipt, createTrustedOutcomeContext('provider-request', 'pre-plan-diagnostic'));
  assert.equal(res.ok, true, 'Valid provider pre-plan reviewer outcome must pass');
});

test('SPEC-P2-12: approval-required repository outcomes bind their separate action-decision receipt', () => {
  const admission = createApprovalRequiredRepositoryAdmission();
  const context = createTrustedOutcomeContext('repository-action', 'approved-plan', admission);
  const receipt = createValidRepoOutcomeReceipt('approved-plan', context);
  assert.equal(validateRepositoryActionOutcomeReceiptV02(receipt, context).ok, true, 'Approved action-decision reference and digest must pass');

  const foreignAdmission = createApprovalRequiredRepositoryAdmission('decision-action-foreign-001');
  const invalidRecords: Record<string, unknown>[] = [];
  const missing = { ...receipt } as unknown as Record<string, unknown>;
  delete missing['actionDecisionReceiptRef'];
  delete missing['actionDecisionReceiptDigest'];
  invalidRecords.push(missing);
  const missingRef = { ...receipt } as unknown as Record<string, unknown>;
  delete missingRef['actionDecisionReceiptRef'];
  invalidRecords.push(missingRef);
  const missingDigest = { ...receipt } as unknown as Record<string, unknown>;
  delete missingDigest['actionDecisionReceiptDigest'];
  invalidRecords.push(missingDigest);
  invalidRecords.push({ ...receipt, actionDecisionReceiptRef: 'decision-action-wrong-001' });
  invalidRecords.push({ ...receipt, actionDecisionReceiptDigest: computeCanonicalSha256('wrong-action-decision') });
  invalidRecords.push({ ...receipt, actionDecisionReceiptRef: 'decision-action-stale-001', actionDecisionReceiptDigest: computeCanonicalSha256('stale-action-decision') });
  invalidRecords.push({ ...receipt, actionDecisionReceiptRef: foreignAdmission.actionDecisionReceipt?.decisionId, actionDecisionReceiptDigest: foreignAdmission.actionDecisionReceipt?.decisionDigest });
  for (const record of invalidRecords) assert.equal(validateRepositoryActionOutcomeReceiptV02(redigestOutcome(record), context).ok, false);

  const allowedContext = createTrustedOutcomeContext('repository-action', 'approved-plan');
  assert.equal(validateRepositoryActionOutcomeReceiptV02(createValidRepoOutcomeReceipt(), allowedContext).ok, true, 'ALLOWED action outcome keeps decision fields absent');
  assert.equal(validateRepositoryActionOutcomeReceiptV02(createValidRepoOutcomeReceipt('pre-plan-diagnostic'), createTrustedOutcomeContext('repository-action', 'pre-plan-diagnostic')).ok, true, 'Pre-plan ALLOWED action outcome keeps decision fields absent');
  assert.equal(validateProviderRequestOutcomeReceiptV02(createValidProviderOutcomeReceipt(), createTrustedOutcomeContext('provider-request', 'approved-plan')).ok, true, 'Provider outcomes keep action-decision fields absent');
});

test('Positive: validateAttemptOutcomeReceiptV02 tagged union dispatch', () => {
  const repoRes = validateAttemptOutcomeReceiptV02(createValidRepoOutcomeReceipt(), createTrustedOutcomeContext('repository-action', 'approved-plan'));
  const provRes = validateAttemptOutcomeReceiptV02(createValidProviderOutcomeReceipt(), createTrustedOutcomeContext('provider-request', 'approved-plan'));
  assert.equal(repoRes.ok, true);
  assert.equal(provRes.ok, true);
});

test('SPEC-P1-11: outcomes reject task drift while preserving newer control holds', () => {
  for (const subject of ['repository-action', 'provider-request'] as const) {
    const receipt = subject === 'repository-action' ? createValidRepoOutcomeReceipt() : createValidProviderOutcomeReceipt();
    const validContext = createTrustedOutcomeContext(subject, 'approved-plan');
    const validate = subject === 'repository-action' ? validateRepositoryActionOutcomeReceiptV02 : validateProviderRequestOutcomeReceiptV02;
    for (const drift of [1, 10]) {
      const staleContext = { ...validContext, currentTaskStateVersion: validContext.trustedAttempt.postBeginTaskStateVersion + drift };
      assert.equal(validate(receipt, staleContext).ok, false, `${subject} outcome must reject task drift of +${drift}`);
    }
    const heldContext = { ...validContext, currentControlVersion: validContext.currentControlVersion + 1 };
    assert.equal(validate(receipt, heldContext).ok, true, `${subject} outcome must preserve a newer control hold`);
  }
});

test('Negative: repository outcome rejects provider cross-branch fields', () => {
  const receipt = { ...createValidRepoOutcomeReceipt(), providerRequestId: 'req-cross-branch' };
  const res = validateRepositoryActionOutcomeReceiptV02(receipt);
  assert.equal(res.ok, false, 'Provider field forbidden on repository outcome');
});

test('Negative: pre-plan repository outcome rejects fabricated plan fields', () => {
  const receipt = {
    ...createValidRepoOutcomeReceipt('pre-plan-diagnostic'),
    planBindingDigest: 'sha256:fabricated0000000000000000000000000000000000000000000000000000',
  };
  const res = validateRepositoryActionOutcomeReceiptV02(receipt);
  assert.equal(res.ok, false, 'Pre-plan outcome must reject fabricated plan fields');
});

test('Negative: provider outcome rejects repository cross-branch fields', () => {
  const receipt = { ...createValidProviderOutcomeReceipt(), actionDigest: 'sha256:act00000000000000000000000000000000000000000000000000000000000000' };
  const res = validateProviderRequestOutcomeReceiptV02(receipt);
  assert.equal(res.ok, false, 'Repository field forbidden on provider outcome');
});

test('Negative: provider outcome rejects invalid role', () => {
  const receipt = { ...createValidProviderOutcomeReceipt(), role: 'invalid-role' };
  const res = validateProviderRequestOutcomeReceiptV02(receipt);
  assert.equal(res.ok, false, 'Invalid role must deny');
});

test('Negative: provider outcome rejects missing admission ref', () => {
  const receipt: Record<string, unknown> = { ...createValidProviderOutcomeReceipt() };
  delete receipt['providerAdmissionReceiptRef'];
  delete receipt['admissionRef'];
  const res = validateProviderRequestOutcomeReceiptV02(receipt);
  assert.equal(res.ok, false, 'Missing admission ref must deny');
});

test('Outcome receipt requires the approved branch-complete admission, authority, effects, and snapshot bindings', () => {
  const receipt = createValidRepoOutcomeReceipt('approved-plan');
  const result = validateAttemptOutcomeReceiptV02(receipt);
  assert.equal(result.ok, false, 'A self-digested legacy receipt cannot stand in for trusted admission and settlement facts');
});

test('SPEC-P1-10: provider outcomes cannot propose repository transition, revision, or evidence effects', () => {
  const receipt = createValidProviderOutcomeReceipt();
  const context = createTrustedOutcomeContext('provider-request', 'approved-plan');
  const changes: readonly [string, Record<string, unknown>][] = [
    ['task transition', { taskTransition: { kind: 'transition', fromNode: context.trustedAdmission.runnableNode, toNode: 'Verify' } }],
    ['revision advance', { revision: { kind: 'advance', revisionDigest: computeCanonicalSha256('foreign-provider-revision') } }],
    ['evidence invalidation', { invalidatedEvidence: [{ reference: 'provider-invalidated-repo-evidence', digest: computeCanonicalSha256('provider-invalidated-repo-evidence') }] }],
  ];
  for (const [effectName, effect] of changes) {
    const candidate = redigestOutcome({ ...receipt, proposedEffects: { ...receipt.proposedEffects, ...effect } });
    assert.equal(validateProviderRequestOutcomeReceiptV02(candidate, context).ok, false, `Provider ${effectName} must be rejected`);
  }

  const repositoryContext = createTrustedOutcomeContext('repository-action', 'approved-plan');
  const repositoryAdmission = repositoryContext.trustedAdmission as RepositoryAdmissionContextV02;
  const patchReceipt = createValidRepoOutcomeReceipt();
  assert.equal(repositoryAdmission.action.kind, 'apply_patch');
  assert.equal(validateRepositoryActionOutcomeReceiptV02(patchReceipt, repositoryContext).ok, true, 'Observed repository patch settlement remains valid');
});

test('S04: outcome validation checks persisted and receipt executor identities before matching', () => {
  const receipt = createValidRepoOutcomeReceipt();
  const context = createTrustedOutcomeContext('repository-action', 'approved-plan');
  assert.equal(validateRepositoryActionOutcomeReceiptV02(receipt, context).ok, true, 'Valid matching executor identity passes');

  const valid = createValidExecutor();
  const malformedPrototype = Object.assign(Object.create({}), valid);
  const invalidExecutors: readonly [string, unknown][] = [
    ['null', null],
    ['numeric adapter identity', { ...valid, adapterIdentity: 123 }],
    ['string fencing generation', { ...valid, fencingGeneration: '1' }],
    ['numeric payload digest', { ...valid, payloadDigest: 123 }],
  ];
  for (const [name, executor] of invalidExecutors) {
    const badContext = { ...context, trustedAttempt: { ...context.trustedAttempt, executorIdentity: executor as ExecutorIdentityV02 } };
    const badReceipt = redigestOutcome({ ...receipt, executorIdentity: executor });
    assert.equal(validateRepositoryActionOutcomeReceiptV02(badReceipt, badContext).ok, false, `Matching malformed ${name} must deny`);
    assert.equal(validateRepositoryActionOutcomeReceiptV02(receipt, badContext).ok, false, `Malformed persisted ${name} must deny independently`);
    assert.equal(validateRepositoryActionOutcomeReceiptV02(badReceipt, context).ok, false, `Malformed receipt ${name} must deny independently`);
  }
  const malformedContext = { ...context, trustedAttempt: { ...context.trustedAttempt, executorIdentity: malformedPrototype as ExecutorIdentityV02 } };
  assert.equal(validateRepositoryActionOutcomeReceiptV02(receipt, malformedContext).ok, false, 'Malformed persisted executor prototype must deny');
  assert.equal(validateRepositoryActionOutcomeReceiptV02({ ...receipt, executorIdentity: malformedPrototype }, context).ok, false, 'Malformed receipt executor prototype must deny');

  const foreign = { ...valid, adapterIdentity: 'adapter-foreign-02', processIncarnation: 'proc-foreign-02' };
  assert.equal(validateRepositoryActionOutcomeReceiptV02(redigestOutcome({ ...receipt, executorIdentity: foreign }), context).ok, false, 'A structurally valid foreign executor must deny');
});

test('Outcome validators bind patch result, versions, authority, provider request, and settlement to trusted records', () => {
  const repo = createValidRepoOutcomeReceipt();
  const repoContext = createTrustedOutcomeContext('repository-action', 'approved-plan');
  const withoutRevision = { ...repo } as unknown as Record<string, unknown>;
  delete withoutRevision['observedResultRevisionDigest'];
  const foreignPlan = redigestOutcome({ ...repo, planDecisionRef: 'decision-foreign' });
  const staleVersion = redigestOutcome({ ...repo, versions: { ...repo.versions, postAttemptControlVersion: 999 } });
  const bogusDigest = { ...repo, receiptDigest: computeCanonicalSha256('bogus-outcome-digest') };
  assert.equal(validateRepositoryActionOutcomeReceiptV02(repo, repoContext).ok, true);
  assert.equal(validateRepositoryActionOutcomeReceiptV02(redigestOutcome(withoutRevision), repoContext).ok, false);
  assert.equal(validateRepositoryActionOutcomeReceiptV02(foreignPlan, repoContext).ok, false);
  assert.equal(validateRepositoryActionOutcomeReceiptV02(staleVersion, repoContext).ok, false);
  assert.equal(validateRepositoryActionOutcomeReceiptV02(bogusDigest, repoContext).ok, false);

  const provider = createValidProviderOutcomeReceipt();
  const providerContext = createTrustedOutcomeContext('provider-request', 'approved-plan');
  assert.equal(validateProviderRequestOutcomeReceiptV02(provider, providerContext).ok, true);
  const missingObservedUsage = { ...provider } as unknown as Record<string, unknown>;
  delete missingObservedUsage['observedUsage'];
  assert.equal(validateProviderRequestOutcomeReceiptV02(redigestOutcome(missingObservedUsage), providerContext).ok, false, 'Observed provider outcome requires its usage record');
  assert.equal(validateProviderRequestOutcomeReceiptV02(redigestOutcome({ ...provider, requestContentDigest: 'sha256:foreign-content' }), providerContext).ok, false);
  assert.equal(validateProviderRequestOutcomeReceiptV02(redigestOutcome({ ...provider, providerAdmissionReceiptRef: 'receipt-foreign' }), providerContext).ok, false);
  assert.equal(validateProviderRequestOutcomeReceiptV02(redigestOutcome({ ...provider, role: 'reviewer' }), providerContext).ok, false);
  assert.equal(validateProviderRequestOutcomeReceiptV02(redigestOutcome({ ...provider, budgetRefs: ['budget-foreign'] }), providerContext).ok, false);
  assert.equal(validateProviderRequestOutcomeReceiptV02(redigestOutcome({
    ...provider,
    proposedEffects: { ...provider.proposedEffects, accounting: { ...provider.proposedEffects.accounting, reservationRefs: ['budget-foreign'] } },
  }), providerContext).ok, false);
});

// ----------------------------------------------------------------------------
// Attempt Reconciliation Receipt Tests
// ----------------------------------------------------------------------------

test('Positive: valid UncertainAttemptReconciliationReceiptV02 passes', () => {
  const receipt = createValidUncertainReconciliationReceipt();
  const context = createTrustedReconciliationContext(receipt, 'uncertain');
  const missingAccounting = { ...receipt } as unknown as Record<string, unknown>;
  delete missingAccounting['accountingEvidenceRefs'];
  const foreignAccounting = redigestReconciliation({ ...receipt, accountingIdentityDigest: computeCanonicalSha256('foreign-accounting') });
  const res = validateUncertainAttemptReconciliationReceiptV02(receipt, context);
  assert.equal(res.ok, true, 'Valid uncertain reconciliation must pass');
  assert.equal(validateUncertainAttemptReconciliationReceiptV02(redigestReconciliation(missingAccounting), context).ok, false, 'Missing accounting evidence must deny');
  assert.equal(validateUncertainAttemptReconciliationReceiptV02(foreignAccounting, context).ok, false, 'Foreign accounting identity must deny');
});

test('Positive: valid ObservedOutcomeReconciliationReceiptV02 passes', () => {
  const receipt = createValidObservedReconciliationReceipt();
  const res = validateObservedOutcomeReconciliationReceiptV02(receipt, {
    ...createTrustedReconciliationContext(receipt, 'observed'),
  });
  assert.equal(res.ok, true, 'Valid observed reconciliation must pass');
});

test('SPEC-P2-12: repository reconciliations bind required action-decision refs to trusted admission', () => {
  const admission = createApprovalRequiredRepositoryAdmission();
  const observed = createValidObservedReconciliationReceipt('repository-action', 'approved-plan', 'coder', admission);
  const observedContext = createTrustedReconciliationContext(observed, 'observed', admission);
  assert.equal(validateObservedOutcomeReconciliationReceiptV02(observed, observedContext).ok, true, 'Observed-unsettled reconciliation binds the approved action decision');

  const foreignAdmission = createApprovalRequiredRepositoryAdmission('decision-action-foreign-reconcile-001');
  const invalidRecords: Record<string, unknown>[] = [];
  const missing = { ...observed } as unknown as Record<string, unknown>;
  delete missing['actionDecisionReceiptRef'];
  delete missing['actionDecisionReceiptDigest'];
  invalidRecords.push(missing);
  const missingRef = { ...observed } as unknown as Record<string, unknown>;
  delete missingRef['actionDecisionReceiptRef'];
  invalidRecords.push(missingRef);
  const missingDigest = { ...observed } as unknown as Record<string, unknown>;
  delete missingDigest['actionDecisionReceiptDigest'];
  invalidRecords.push(missingDigest);
  invalidRecords.push({ ...observed, actionDecisionReceiptRef: 'decision-action-wrong-001' });
  invalidRecords.push({ ...observed, actionDecisionReceiptDigest: computeCanonicalSha256('wrong-action-decision') });
  invalidRecords.push({ ...observed, actionDecisionReceiptRef: 'decision-action-stale-001', actionDecisionReceiptDigest: computeCanonicalSha256('stale-action-decision') });
  invalidRecords.push({ ...observed, actionDecisionReceiptRef: foreignAdmission.actionDecisionReceipt?.decisionId, actionDecisionReceiptDigest: foreignAdmission.actionDecisionReceipt?.decisionDigest });
  for (const record of invalidRecords) assert.equal(validateObservedOutcomeReconciliationReceiptV02(redigestReconciliation(record), observedContext).ok, false);

  const uncertain = createValidUncertainReconciliationReceipt('observed-and-accounted', 'repository-action', 'approved-plan', 'coder', admission);
  const uncertainContext = createTrustedReconciliationContext(uncertain, 'uncertain', admission);
  assert.equal(validateUncertainAttemptReconciliationReceiptV02(uncertain, uncertainContext).ok, true, 'Uncertain-attempt reconciliation binds the same decision branch');

  const allowedReceipt = createValidObservedReconciliationReceipt();
  assert.equal(validateObservedOutcomeReconciliationReceiptV02(allowedReceipt, createTrustedReconciliationContext(allowedReceipt, 'observed')).ok, true, 'ALLOWED reconciliation keeps decision fields absent');
  const providerReceipt = createValidObservedReconciliationReceipt('provider-request', 'pre-plan-diagnostic', 'reviewer');
  assert.equal(validateObservedOutcomeReconciliationReceiptV02(providerReceipt, createTrustedReconciliationContext(providerReceipt, 'observed')).ok, true, 'Provider reconciliation keeps action-decision fields absent');
});

test('Uncertain non-dispatch reconciliation requires independent fencing and safe evidence proofs', () => {
  const receipt = createValidUncertainReconciliationReceipt('proven-not-dispatched');
  if (receipt.disposition !== 'proven-not-dispatched') throw new Error('Fixture must be the proven-not-dispatched branch');
  const context = createTrustedReconciliationContext(receipt, 'uncertain');
  const withoutProof = { ...receipt } as unknown as Record<string, unknown>;
  delete withoutProof['fencingProof'];
  const fabricatedProof = redigestReconciliation({ ...receipt, fencingProof: { reference: 'fencing-proof-foreign', digest: computeCanonicalSha256('foreign') } });
  const staleSnapshot = redigestReconciliation({ ...receipt, expectedCurrentControlVersion: receipt.expectedCurrentControlVersion + 1 });
  const crossBranch = redigestReconciliation({ ...receipt, providerRequestId: 'provider-foreign' });
  assert.equal(validateUncertainAttemptReconciliationReceiptV02(receipt, context).ok, true, 'Current fenced recipient proof must pass');
  assert.equal(
    validateUncertainAttemptReconciliationReceiptV02(redigestReconciliation(withoutProof), context).ok,
    false,
    'Missing trusted fencing proof must deny'
  );
  assert.equal(validateUncertainAttemptReconciliationReceiptV02(fabricatedProof, context).ok, false, 'Fabricated fencing proof must deny');
  assert.equal(validateUncertainAttemptReconciliationReceiptV02(staleSnapshot, context).ok, false, 'Stale current control version must deny');
  assert.equal(validateUncertainAttemptReconciliationReceiptV02(crossBranch, context).ok, false, 'Cross-branch provider identity must deny');
  const emptyAdapterEvidence = redigestReconciliation({ ...receipt, adapterEvidenceRefs: [], evidenceRefs: [receipt.fencingProof] });
  assert.equal(validateUncertainAttemptReconciliationReceiptV02(emptyAdapterEvidence, { ...context, trustedEvidenceRefs: [] }).ok, false, 'Non-dispatch requires adapter evidence in addition to a fencing proof');
});

test('Observed reconciliation requires the exact trusted observed-unsettled journal predecessor', () => {
  const receipt = createValidObservedReconciliationReceipt();
  const context = createTrustedReconciliationContext(receipt, 'observed');
  const wrongStatus = { ...context, predecessorJournalStatus: 'uncertain' as const };
  const staleTask = redigestReconciliation({ ...receipt, expectedCurrentTaskStateVersion: receipt.expectedCurrentTaskStateVersion + 1 });
  const foreignEvidence = redigestReconciliation({
    ...receipt,
    evidenceRefs: [{ reference: 'evidence-foreign', digest: computeCanonicalSha256('foreign') }],
  });
  assert.equal(
    validateObservedOutcomeReconciliationReceiptV02(receipt, context).ok,
    true,
    'Exact observed-unsettled predecessor, accounting identity, evidence and snapshot must pass'
  );
  assert.equal(validateObservedOutcomeReconciliationReceiptV02(receipt, wrongStatus).ok, false, 'Wrong journal predecessor status must deny');
  assert.equal(validateObservedOutcomeReconciliationReceiptV02(staleTask, context).ok, false, 'Stale current task version must deny');
  assert.equal(validateObservedOutcomeReconciliationReceiptV02(foreignEvidence, context).ok, false, 'Cross-branch evidence must deny');
  const noEvidence = redigestReconciliation({ ...receipt, evidenceRefs: [] });
  assert.equal(validateObservedOutcomeReconciliationReceiptV02(noEvidence, { ...context, trustedEvidenceRefs: [] }).ok, false, 'Observed-unsettled recovery requires trusted evidence refs');
});

test('SPEC-P1-11: observed reconciliation rejects task drift but preserves newer control holds', () => {
  for (const subject of ['repository-action', 'provider-request'] as const) {
    const receipt = createValidObservedReconciliationReceipt(subject);
    const validContext = createTrustedReconciliationContext(receipt, 'observed');
    for (const drift of [1, 10]) {
      const currentTaskStateVersion = validContext.trustedAttempt.postBeginTaskStateVersion + drift;
      const staleContext = { ...validContext, currentTaskStateVersion };
      const staleReceipt = redigestReconciliation({ ...receipt, expectedCurrentTaskStateVersion: currentTaskStateVersion });
      assert.equal(validateObservedOutcomeReconciliationReceiptV02(staleReceipt, staleContext).ok, false, `${subject} reconciliation must reject task drift of +${drift}`);
    }
    const currentControlVersion = validContext.currentControlVersion + 1;
    const heldContext = { ...validContext, currentControlVersion };
    const heldReceipt = redigestReconciliation({ ...receipt, expectedCurrentControlVersion: currentControlVersion });
    assert.equal(validateObservedOutcomeReconciliationReceiptV02(heldReceipt, heldContext).ok, true, `${subject} reconciliation must preserve a newer control hold`);
  }
});

test('Provider reconciliation binds pre-plan usage and approved request identity to the exact predecessor', () => {
  const uncertain = createValidUncertainReconciliationReceipt('observed-and-accounted', 'provider-request', 'pre-plan-diagnostic', 'reviewer');
  const uncertainContext = createTrustedReconciliationContext(uncertain, 'uncertain');
  const uncertainResult = validateUncertainAttemptReconciliationReceiptV02(uncertain, uncertainContext);
  assert.equal(uncertainResult.ok, true, JSON.stringify(uncertainResult));
  assert.equal(validateUncertainAttemptReconciliationReceiptV02(redigestReconciliation({ ...uncertain, observedUsage: undefined }), uncertainContext).ok, false);

  const observed = createValidObservedReconciliationReceipt('provider-request', 'approved-plan', 'coder');
  const observedContext = createTrustedReconciliationContext(observed, 'observed');
  assert.equal(validateObservedOutcomeReconciliationReceiptV02(observed, observedContext).ok, true);
  assert.equal(validateObservedOutcomeReconciliationReceiptV02(redigestReconciliation({ ...observed, requestContentDigest: 'sha256:foreign-request' }), observedContext).ok, false);
});

test('Positive: validateAttemptReconciliationReceiptV02 union dispatch', () => {
  const uncRes = validateAttemptReconciliationReceiptV02(createValidUncertainReconciliationReceipt(), {
    ...createTrustedReconciliationContext(createValidUncertainReconciliationReceipt(), 'uncertain'),
  });
  const obsRes = validateAttemptReconciliationReceiptV02(createValidObservedReconciliationReceipt(), {
    ...createTrustedReconciliationContext(createValidObservedReconciliationReceipt(), 'observed'),
  });
  assert.equal(uncRes.ok, true);
  assert.equal(obsRes.ok, true);
});

test('Negative: uncertain reconciliation rejects predecessor with non-uncertain outcome', () => {
  const receipt = createValidUncertainReconciliationReceipt();
  const validContext = createTrustedReconciliationContext(receipt, 'uncertain');
  const observedPredecessor = redigestOutcome({ ...validContext.trustedPredecessor, outcome: 'observed' });
  const res = validateUncertainAttemptReconciliationReceiptV02(receipt, {
    ...validContext,
    currentClaimStatus: 'observed-unsettled',
    predecessorJournalStatus: 'observed-unsettled',
    trustedPredecessor: observedPredecessor as unknown as AttemptOutcomeReceiptV02,
    predecessorReceiptDigest: observedPredecessor['receiptDigest'] as string,
  });
  assert.equal(res.ok, false, 'Predecessor not uncertain must deny');
});

test('Negative: observed reconciliation rejects predecessor with non-observed outcome', () => {
  const receipt = createValidObservedReconciliationReceipt();
  const validContext = createTrustedReconciliationContext(receipt, 'observed');
  const uncertainPredecessor = redigestOutcome({ ...validContext.trustedPredecessor, outcome: 'uncertain' });
  const res = validateObservedOutcomeReconciliationReceiptV02(receipt, {
    ...validContext,
    currentClaimStatus: 'uncertain',
    predecessorJournalStatus: 'uncertain',
    trustedPredecessor: uncertainPredecessor as unknown as AttemptOutcomeReceiptV02,
    predecessorReceiptDigest: uncertainPredecessor['receiptDigest'] as string,
  });
  assert.equal(res.ok, false, 'Predecessor not observed must deny');
});

test('Negative: observed reconciliation forbids outcome rewrite or disposition', () => {
  const receipt = { ...createValidObservedReconciliationReceipt(), disposition: 'observed-and-accounted' };
  const res = validateObservedOutcomeReconciliationReceiptV02(receipt);
  assert.equal(res.ok, false, 'Observed reconciliation must forbid outcome rewrite');
});

test('Negative: reconciliation rejects predecessor receipt ID mismatch', () => {
  const receipt = createValidUncertainReconciliationReceipt();
  const wrongPredecessor = redigestReconciliation({ ...receipt, predecessorReceiptId: 'receipt-mismatch' });
  const context = createTrustedReconciliationContext(receipt, 'uncertain');
  const res = validateUncertainAttemptReconciliationReceiptV02(wrongPredecessor, context);
  assert.equal(res.ok, false, 'Predecessor ID mismatch must deny');
});

// ----------------------------------------------------------------------------
// Canonical Digest Helpers Tests
// ----------------------------------------------------------------------------

test('Canonical digest helpers strip their digest field and produce deterministic sha256', () => {
  const closure = createValidClaimClosureReceipt();
  const d1 = computeClaimClosureDigest(closure);
  const d2 = computeClaimClosureDigest({ ...closure, receiptDigest: 'sha256:different' });
  assert.equal(d1, d2, 'computeClaimClosureDigest strips receiptDigest');
  assert.match(d1, /^sha256:[0-9a-f]{64}$/);

  const outcome = createValidRepoOutcomeReceipt();
  const od1 = computeAttemptOutcomeDigest(outcome);
  const od2 = computeAttemptOutcomeDigest({ ...outcome, receiptDigest: 'sha256:different' });
  assert.equal(od1, od2, 'computeAttemptOutcomeDigest strips receiptDigest');
  assert.match(od1, /^sha256:[0-9a-f]{64}$/);

  const recon = createValidUncertainReconciliationReceipt();
  const rd1 = computeReconciliationDigest(recon);
  const rd2 = computeReconciliationDigest({ ...recon, reconciliationDigest: 'sha256:different' });
  assert.equal(rd1, rd2, 'computeReconciliationDigest strips reconciliationDigest');
  assert.match(rd1, /^sha256:[0-9a-f]{64}$/);
});

interface TrustedBoundaryValidationResult {
  readonly ok: boolean;
  readonly errors?: readonly { readonly code: string }[];
}

function callWithTrustedContext(
  validator: unknown,
  input: unknown,
  trustedContext: unknown
): TrustedBoundaryValidationResult {
  return (validator as (input: unknown, trustedContext: unknown) => TrustedBoundaryValidationResult)(
    input,
    trustedContext
  );
}

function createTrustedRepositoryFacts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const defaultReceipt = createPolicyEvaluationReceipt({
    receiptId: 'pe-receipt-001',
    actionDigest: computeActionDigest(createValidPatchAction()),
    freshnessContextDigest: 'sha256:freshness00000000000000000000000000000000000000000000000000',
    policyId: 'policy-default', policyVersion: '1.0.0', configId: 'config-default', configVersion: '1.0.0',
    decisionAuthorityGeneration: 3, result: 'ALLOWED',
  });
  return {
    subjectKind: 'repository-action',
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
    policyAuthorityRef: {
      policyId: 'policy-default',
      policyVersion: '1.0.0',
      configId: 'config-default',
      configVersion: '1.0.0',
      issuerKeyRef: 'key-authority-001',
      decisionAuthorityGeneration: 3,
    },
    policyEvaluationReceiptRef: 'pe-receipt-001',
    policyEvaluationReceiptDigest: defaultReceipt['receiptDigest'],
    freshnessContextDigest: 'sha256:freshness00000000000000000000000000000000000000000000000000',
    planApplicability: 'approved-plan',
    planBindingDigest: 'sha256:planbindingdigest00000000000000000000000000000000000000000000000',
    planDecisionRef: 'dec-plan-001',
    executionProfile: {
      isolationProfileRef: 'profile-read-only-mount',
      exclusionsPolicyVersion: '1.0.0',
      scratchIdentity: 'scratch-vol-001',
      commandBounds: {
        timeoutMs: 30000,
        maxOutputBytes: 65536,
        maxCpuSeconds: 10,
        maxMemoryBytes: 536870912,
        maxProcessCount: 5,
      },
      patchBounds: { maxPatchBytes: 4096, maxChangedPaths: 5 },
    },
    commandViewDigest: computeCanonicalSha256({
      viewId: 'view-cmd-001',
      taskId: 'task-calc-001',
      workspaceId: 'workspace-001',
      canonicalRevision: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      admittedFiles: [{ path: 'tests/test_calculator.py', digest: 'sha256:filetest0000000000000000000000000000000000000000000000000000000' }],
      exclusionsPolicyVersion: '1.0.0',
      scratchIdentity: 'scratch-vol-001',
      mountedReadOnly: true,
      isolationProfileRef: 'profile-read-only-mount',
    }),
    allowedDiagnosticChecks: [
      {
        checkId: 'check-pytest-repro',
        testPath: 'tests/test_calculator.py',
        diagnosticPurpose: 'reproduction',
        taskCriteriaDigest: 'sha256:criteria00000000000000000000000000000000000000000000000000000000',
        checkSetDigest: 'sha256:checkset00000000000000000000000000000000000000000000000000000000',
        action: createValidCommandAction(),
      },
    ],
    allowedDiagnosticTestPaths: ['tests/test_calculator.py'],
    ...overrides,
  };
}

function withCanonicalCommandViewDigest(
  context: RepositoryAdmissionContextV02
): RepositoryAdmissionContextV02 {
  const raw = context as unknown as Record<string, unknown>;
  const view = { ...(raw['commandView'] as Record<string, unknown>) };
  delete view['viewDigest'];
  return {
    ...raw,
    commandView: { ...view, viewDigest: computeCanonicalSha256(view) },
  } as unknown as RepositoryAdmissionContextV02;
}

test('Repository admission binds approval decisions and freshness to trusted facts', () => {
  const action = createValidPatchAction();
  const context = createValidRepositoryApprovedPlanContext({
    policyEvaluationReceipt: createPolicyEvaluationReceipt({
      receiptId: 'pe-receipt-001',
      actionDigest: computeActionDigest(action),
      freshnessContextDigest: 'sha256:freshness00000000000000000000000000000000000000000000000000',
      policyId: 'policy-default',
      policyVersion: '1.0.0',
      configId: 'config-default',
      configVersion: '1.0.0',
      decisionAuthorityGeneration: 3,
      result: 'APPROVAL_REQUIRED',
    }),
    actionDecisionReceipt: {
      decisionId: 'decision-001',
      decisionDigest: 'sha256:decisiondigest00000000000000000000000000000000000000000000000',
      actionDigest: computeActionDigest(action),
      evaluationReceiptRef: 'foreign-evaluation',
      decisionAuthorityGeneration: 3,
      status: 'approved',
    },
  });
  const result = callWithTrustedContext(
    validateRepositoryAdmissionV02,
    context,
    trustedRepositoryFixture(false, context)
  );
  const staleFreshness = createValidRepositoryApprovedPlanContext({
    policyEvaluationReceipt: createPolicyEvaluationReceipt({
      ...context.policyEvaluationReceipt,
      freshnessContextDigest: 'sha256:foreign-freshness',
    }),
  });
  const staleResult = callWithTrustedContext(validateRepositoryAdmissionV02, staleFreshness, trustedRepositoryFixture(false, context));

  assert.equal(result.ok, false, 'Foreign evaluation reference must not authorize an approved action');
  assert.equal(staleResult.ok, false, 'Stale freshness must not authorize an approved action');
});

test('Policy evaluation receipt digest binds its result and omits an undefined digest field', () => {
  const base = createValidRepositoryApprovedPlanContext();
  const receipt = base.policyEvaluationReceipt as unknown as Record<string, unknown>;
  const withUndefined = { ...receipt, receiptDigest: undefined };
  const withoutDigest = { ...receipt };
  delete withoutDigest['receiptDigest'];
  assert.equal(computeCanonicalSha256(withUndefined), computeCanonicalSha256(withoutDigest));
  assert.equal(receipt['receiptDigest'], computeCanonicalSha256(withoutDigest));

  const decision = {
    decisionId: 'decision-result-binding-001',
    decisionDigest: computeCanonicalSha256('decision-result-binding-001'),
    actionDigest: base.actionDigest,
    evaluationReceiptRef: base.policyEvaluationReceipt.receiptId,
    decisionAuthorityGeneration: base.policyAuthorityRef.decisionAuthorityGeneration,
    status: 'approved',
  };
  const changedResult = {
    ...base,
    policyEvaluationReceipt: { ...base.policyEvaluationReceipt, result: 'APPROVAL_REQUIRED' },
    actionDecisionReceipt: decision,
  } as unknown as RepositoryAdmissionContextV02;
  const trusted = {
    ...trustedRepositoryFixture(false, base),
    actionDecisionReceiptRef: decision.decisionId,
    actionDecisionReceiptDigest: decision.decisionDigest,
  };
  const result = validateRepositoryAdmissionV02(changedResult, trusted);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.some(({ code }) => code === 'EVALUATION_RECEIPT_DIGEST_MISMATCH'));
});

test('Approval-required admission binds decision ID, digest, and evaluation receipt to trusted facts', () => {
  const valid = createApprovalRequiredRepositoryAdmission();
  const trusted = trustedRepositoryFixture(false, valid);
  assert.equal(validateRepositoryAdmissionV02(valid, trusted).ok, true);

  const decision = valid.actionDecisionReceipt;
  assert.ok(decision);
  for (const actionDecisionReceipt of [
    { ...decision, decisionId: 'decision-foreign' },
    { ...decision, decisionDigest: 'sha256:foreign-decision-digest' },
    { ...decision, evaluationReceiptRef: 'pe-foreign' },
  ]) {
    const candidate = { ...valid, actionDecisionReceipt } as RepositoryAdmissionContextV02;
    assert.equal(validateRepositoryAdmissionV02(candidate, trusted).ok, false);
  }
});

test('Approval-required admission rejects trusted context without decision receipt bindings', () => {
  const valid = createApprovalRequiredRepositoryAdmission();
  const trusted = trustedRepositoryFixture(false, valid);
  delete trusted['actionDecisionReceiptRef'];
  delete trusted['actionDecisionReceiptDigest'];
  const result = validateRepositoryAdmissionV02(valid, trusted);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.some(({ code }) => code === 'ACTION_DECISION_BINDING_REQUIRED'));
});

test('Repository command admission binds a recomputed view and complete profile bounds', () => {
  const base = withCanonicalCommandViewDigest(createValidRepositoryPrePlanDiagnosticContext());
  const trusted = createTrustedRepositoryFacts({
    expectedTaskStateVersion: 0,
    expectedControlVersion: 0,
    runnableNode: 'Investigate',
    planApplicability: 'pre-plan-diagnostic',
    planBindingDigest: undefined,
    planDecisionRef: undefined,
    policyAuthorityRef: {
      policyId: 'policy-default',
      policyVersion: '1.0.0',
      configId: 'config-default',
      configVersion: '1.0.0',
      issuerKeyRef: 'key-authority-001',
      decisionAuthorityGeneration: 1,
    },
    policyEvaluationReceiptRef: 'pe-receipt-diag-001',
    policyEvaluationReceiptDigest: base.policyEvaluationReceipt.receiptDigest,
    freshnessContextDigest: 'sha256:freshnessdiag0000000000000000000000000000000000000000000000',
  });
  const view = base.commandView as unknown as Record<string, unknown>;
  const bounds = base.finiteBounds as unknown as Record<string, unknown>;
  const missingResourceBounds = { ...bounds };
  delete missingResourceBounds['maxCpuSeconds'];
  delete missingResourceBounds['maxMemoryBytes'];
  delete missingResourceBounds['maxProcessCount'];
  const cases: readonly RepositoryAdmissionContextV02[] = [
    withCanonicalCommandViewDigest({ ...base, commandView: { ...view, taskId: 'task-foreign' } } as RepositoryAdmissionContextV02),
    withCanonicalCommandViewDigest({ ...base, commandView: { ...view, workspaceId: 'workspace-foreign' } } as RepositoryAdmissionContextV02),
    withCanonicalCommandViewDigest({ ...base, commandView: { ...view, exclusionsPolicyVersion: 'policy-foreign' } } as RepositoryAdmissionContextV02),
    withCanonicalCommandViewDigest({ ...base, commandView: { ...view, scratchIdentity: 'scratch-foreign' } } as RepositoryAdmissionContextV02),
    withCanonicalCommandViewDigest({ ...base, commandView: { ...view, canonicalRevision: 'sha256:foreign' } } as RepositoryAdmissionContextV02),
    { ...base, commandView: { ...view, viewDigest: 'sha256:bogus' } } as RepositoryAdmissionContextV02,
    { ...base, finiteBounds: { ...bounds, isolationProfileRef: 'profile-foreign' } } as RepositoryAdmissionContextV02,
    { ...base, finiteBounds: missingResourceBounds } as unknown as RepositoryAdmissionContextV02,
  ];

  const valid = callWithTrustedContext(validateRepositoryAdmissionV02, base, trusted);
  assert.equal(valid.ok, true, JSON.stringify(valid));
  for (const context of cases) {
    assert.equal(
      callWithTrustedContext(validateRepositoryAdmissionV02, context, trusted).ok,
      false,
      'Foreign or incomplete command-view/profile facts must deny'
    );
  }
});

test('Repository patch admission binds exact canonical targets, base revision, and UTF-8 byte ceiling', () => {
  const valid = createValidRepositoryApprovedPlanContext();
  const trusted = createTrustedRepositoryFacts();
  const raw = valid as unknown as Record<string, unknown>;
  const bytes = new TextEncoder().encode((raw['action'] as ApplyPatchAction).patchContent).length;
  const cases = [
    { ...raw, targetPaths: ['123', '../.env'] },
    { ...raw, targetPaths: ['other.py'] },
    { ...raw, baseRevision: 'sha256:foreign' },
    { ...raw, finiteBounds: { maxPatchBytes: bytes - 1, maxChangedPaths: 5 } },
  ];

  assert.equal(callWithTrustedContext(validateRepositoryAdmissionV02, valid, trusted).ok, true);
  for (const candidate of cases) {
    assert.equal(
      callWithTrustedContext(validateRepositoryAdmissionV02, candidate, trusted).ok,
      false,
      'Noncanonical, mismatched, or too-small patch admission must deny'
    );
  }
});

test('Repository patch ceiling counts UTF-8 bytes rather than string code units', () => {
  const action: ApplyPatchAction = { ...createValidPatchAction(), patchContent: '--- a/src/calculator.py\n+++ b/src/calculator.py\n+é\n' };
  const bytes = new TextEncoder().encode(action.patchContent).length;
  const base = {
    action,
    actionDigest: computeActionDigest(action),
    patchDigest: computeCanonicalSha256(action.patchContent),
    policyEvaluationReceipt: createPolicyEvaluationReceipt({
      receiptId: 'pe-receipt-001',
      actionDigest: computeActionDigest(action),
      freshnessContextDigest: 'sha256:freshness00000000000000000000000000000000000000000000000000',
      policyId: 'policy-default', policyVersion: '1.0.0', configId: 'config-default', configVersion: '1.0.0',
      decisionAuthorityGeneration: 3, result: 'ALLOWED',
    }),
  };
  const atByteCeiling = createValidRepositoryApprovedPlanContext({ ...base, finiteBounds: { maxPatchBytes: bytes, maxChangedPaths: 5 } });
  const belowByteCeiling = createValidRepositoryApprovedPlanContext({ ...base, finiteBounds: { maxPatchBytes: action.patchContent.length, maxChangedPaths: 5 } });
  const trusted = trustedRepositoryFixture(false, atByteCeiling);
  assert.equal(validateRepositoryAdmissionV02(atByteCeiling, trusted).ok, true);
  assert.equal(validateRepositoryAdmissionV02(belowByteCeiling, trusted).ok, false);
});

test('Pre-plan command admission requires an exact Investigate diagnostic check binding', () => {
  const raw = createValidRepositoryPrePlanDiagnosticContext() as unknown as Record<string, unknown>;
  const trusted = createTrustedRepositoryFacts({
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: 0,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: 0,
    expectedEpoch: 1,
    runnableNode: 'Investigate',
    planApplicability: 'pre-plan-diagnostic',
    planBindingDigest: undefined,
    planDecisionRef: undefined,
    policyAuthorityRef: {
      policyId: 'policy-default',
      policyVersion: '1.0.0',
      configId: 'config-default',
      configVersion: '1.0.0',
      issuerKeyRef: 'key-authority-001',
      decisionAuthorityGeneration: 1,
    },
    policyEvaluationReceiptRef: 'pe-receipt-diag-001',
    policyEvaluationReceiptDigest: (raw['policyEvaluationReceipt'] as Record<string, unknown>)['receiptDigest'],
    freshnessContextDigest: 'sha256:freshnessdiag0000000000000000000000000000000000000000000000',
  });
  const allowed = withCanonicalCommandViewDigest({
    ...raw,
    checkId: 'check-pytest-repro',
    testPath: 'tests/test_calculator.py',
  } as unknown as RepositoryAdmissionContextV02);
  const denied = [
    { ...allowed, checkId: undefined },
    { ...allowed, testPath: undefined },
    { ...allowed, checkId: 'check-foreign' },
    { ...allowed, runnableNode: 'Repair' },
  ];

  assert.equal(callWithTrustedContext(validateRepositoryAdmissionV02, allowed, trusted).ok, true);
  for (const candidate of denied) {
    assert.equal(callWithTrustedContext(validateRepositoryAdmissionV02, candidate, trusted).ok, false);
  }
});

test('Provider admission binds request, outer context, and admission receipt identities and role', () => {
  const valid = createValidProviderApprovedPlanContext();
  const request = valid.providerRequest;
  const trusted = trustedProviderFixture();
  const cases = [
    { ...valid, providerAdmissionReceipt: { ...valid.providerAdmissionReceipt, role: 'reviewer' } },
    { ...valid, providerRequest: { ...request, taskId: 'task-foreign' } },
    { ...valid, providerRequest: { ...request, runId: 'run-foreign' } },
    { ...valid, providerRequest: { ...request, role: 'reviewer' } },
    { ...valid, taskId: 'task-foreign' },
    { ...valid, runId: 'run-foreign' },
    { ...valid, role: 'reviewer' },
  ];

  assert.equal(callWithTrustedContext(validateProviderAdmissionV02, valid, trusted).ok, true);
  for (const candidate of cases) {
    assert.equal(callWithTrustedContext(validateProviderAdmissionV02, candidate, trusted).ok, false);
  }
});

test('Claim closure and reconciliation require complete trusted claim and predecessor proofs', () => {
  const closure = createValidClaimClosureReceipt();
  const claim = {
    claimId: 'claim-001', claimDigest: 'sha256:claim', taskId: 'task-001', status: 'claimed',
    hasCommittedAttempt: false, reservationRefs: ['res-1'],
  };
  const closureContext = {
    expectedTaskId: 'task-001', expectedClaimId: 'claim-001', claim,
    hasCommittedAttempt: false,
    expectedFencedExecutorIdentity: createValidExecutor(),
  };
  assert.equal(validateClaimClosureReceiptV02(closure).ok, false);
  assert.equal(validateClaimClosureReceiptV02(closure, closureContext).ok, true);
  assert.equal(validateClaimClosureReceiptV02(closure, { ...closureContext, expectedTaskId: 'task-foreign' }).ok, false);

  const reconciliation = createValidObservedReconciliationReceipt();
  const reconciliationContext = createTrustedReconciliationContext(reconciliation, 'observed');
  assert.equal(validateObservedOutcomeReconciliationReceiptV02(reconciliation).ok, false);
  assert.equal(validateObservedOutcomeReconciliationReceiptV02(reconciliation, reconciliationContext).ok, true);
  assert.equal(validateObservedOutcomeReconciliationReceiptV02(reconciliation, {
    ...reconciliationContext,
    predecessorReceiptDigest: computeCanonicalSha256('foreign'),
  }).ok, false);
});

test('Attempt validators reject invalid repair flags, revision digest types, and provider usage', () => {
  const repairFlag = validateProtocolVersionProgressionV02({
    kind: 'begin-attempt',
    pre: { taskStateVersion: 0, controlVersion: 1, epoch: 0 },
    post: { taskStateVersion: 1, controlVersion: 2, epoch: 0 },
    isRepairPatch: 'false',
  });
  const repairContextFlag = validateAttemptReceiptV02(createValidAttemptReceipt(), {
    isRepairPatch: 'false' as unknown as boolean,
  });
  const badRevision = validateRepositoryActionOutcomeReceiptV02({
    ...createValidRepoOutcomeReceipt(), observedResultRevisionDigest: 123,
  });
  const badUsage = validateProviderRequestOutcomeReceiptV02({
    ...createValidProviderOutcomeReceipt(), observedUsage: { inputTokens: 'invalid', outputTokens: 1, costUsd: 0.1 },
  });
  assert.equal(repairFlag.ok, false);
  assert.equal(repairContextFlag.ok, false);
  assert.equal(badRevision.ok, false);
  assert.equal(badUsage.ok, false);
});

test('Patch admission requires a non-empty exact canonical target set and counts action targets', () => {
  const rejected = [
    createPatchContextWithTargets(['src/a.py'], []),
    createPatchContextWithTargets(['src/a.py', 'src/b.py'], ['src/a.py']),
    createPatchContextWithTargets(['src/a.py'], ['src/a.py', 'src/b.py']),
    createPatchContextWithTargets(['src/a.py'], ['src/a.py', 'src/a.py']),
    createPatchContextWithTargets(['src/a.py', 'src/a.py'], ['src/a.py', 'src/a.py']),
    createPatchContextWithTargets(['src/../src/a.py'], ['src/../src/a.py']),
    createPatchContextWithTargets(['src/a.py', 'src/b.py'], ['src/a.py'], 1),
  ];
  for (const context of rejected) assert.equal(validateRepositoryAdmissionV02(context).ok, false);
  const valid = createPatchContextWithTargets(['src/a.py'], ['src/a.py']);
  assert.equal(validateRepositoryAdmissionV02(valid, trustedRepositoryFixture(false, valid)).ok, true);
});

test('Action decision reason must be safe optional text before validation narrows it', () => {
  const base = createValidRepositoryApprovedPlanContext();
  const decision = {
    decisionId: 'decision-001',
    decisionDigest: 'sha256:decisiondigest0000000000000000000000000000000000000000000000000',
    actionDigest: base.actionDigest,
    evaluationReceiptRef: base.policyEvaluationReceipt.receiptId,
    decisionAuthorityGeneration: base.policyAuthorityRef.decisionAuthorityGeneration,
    status: 'approved',
    reason: 'Reviewed against the current task policy',
  };
  const makeContext = (reason: unknown) => ({
    ...base,
    policyEvaluationReceipt: createPolicyEvaluationReceipt({
      ...(base.policyEvaluationReceipt as unknown as Record<string, unknown>),
      result: 'APPROVAL_REQUIRED',
    }),
    actionDecisionReceipt: { ...decision, reason },
  } as unknown as RepositoryAdmissionContextV02);

  for (const reason of [decision.reason, 123, 'unsafe\r\nreason']) {
    const context = makeContext(reason);
    const result = validateRepositoryAdmissionV02(context, trustedRepositoryFixture(false, context));
    assert.equal(result.ok, reason === decision.reason);
  }
});

test('S10: optional admission metadata is validated before the public boundary narrows it', () => {
  const repository = createValidRepositoryApprovedPlanContext();
  const repositoryTrust = trustedRepositoryFixture();
  const repositoryTrustBefore = structuredClone(repositoryTrust);
  const invalidRepositoryMetadata: readonly [string, unknown][] = [
    ['diagnosticPurpose', 123], ['taskCriteriaDigest', 123], ['checkSetDigest', 123], ['testPath', 123], ['checkId', 123], ['admissionDigest', 123],
    ['diagnosticPurpose', ''], ['taskCriteriaDigest', ''], ['checkSetDigest', ''], ['testPath', 'tests/../src/main.ts'], ['checkId', ''],
    ['admissionDigest', computeCanonicalSha256('foreign-admission')],
  ];
  for (const [field, value] of invalidRepositoryMetadata) {
    assert.equal(validateRepositoryAdmissionV02({ ...repository, [field]: value }, repositoryTrust).ok, false, `Invalid optional ${field} must deny`);
  }
  const validOptionalRepositoryMetadata: Record<string, string> = {
    diagnosticPurpose: 'approved-plan-followup',
    taskCriteriaDigest: 'sha256:criteria00000000000000000000000000000000000000000000000000000000',
    checkSetDigest: 'sha256:checkset00000000000000000000000000000000000000000000000000000000',
    testPath: 'tests/smoke.test.ts',
    checkId: 'check-smoke',
  };
  for (const [field, value] of Object.entries(validOptionalRepositoryMetadata)) {
    assert.equal(validateRepositoryAdmissionV02({ ...repository, [field]: value }, repositoryTrust).ok, true, `Valid optional ${field} must pass`);
  }
  assert.equal(validateRepositoryAdmissionV02(repository, repositoryTrust).ok, true, 'Absent optional repository fields remain valid');
  assert.equal(validateRepositoryAdmissionV02({ ...repository, admissionDigest: computeAdmissionDigest(repository) }, repositoryTrust).ok, true, 'Exact supplied repository admission digest is checked without self-inclusion');
  assert.deepEqual(repositoryTrust, repositoryTrustBefore, 'Validation must not mutate trusted repository facts');

  const provider = createValidProviderApprovedPlanContext();
  const providerTrust = trustedProviderFixture();
  const providerTrustBefore = structuredClone(providerTrust);
  assert.equal(validateProviderAdmissionV02({ ...provider, admissionDigest: 123 }, providerTrust).ok, false, 'Numeric provider admission digest must deny');
  assert.equal(validateProviderAdmissionV02({ ...provider, admissionDigest: computeCanonicalSha256('foreign-provider-admission') }, providerTrust).ok, false, 'Foreign provider admission digest must deny');
  assert.equal(validateProviderAdmissionV02({ ...provider, admissionDigest: computeAdmissionDigest(provider) }, providerTrust).ok, true, 'Exact supplied provider admission digest must pass');
  assert.equal(validateProviderAdmissionV02(provider, providerTrust).ok, true, 'Absent provider admission digest remains valid');
  assert.deepEqual(providerTrust, providerTrustBefore, 'Validation must not mutate trusted provider facts');
});

test('Provider admission binds trusted current state, branch authority, and every request ceiling', () => {
  const approved = createValidProviderApprovedPlanContext({ runnableNode: 'Repair' });
  const trustedApproved = trustedProviderFixture();
  assert.equal(validateProviderAdmissionV02(approved, trustedApproved).ok, true);
  const approvedPurpose = 'approved-plan-auxiliary-scope';
  const approvedCriteria = 'sha256:approvedcriteria00000000000000000000000000000000000000000000000000';
  assert.equal(validateProviderAdmissionV02(
    { ...approved, diagnosticPurpose: approvedPurpose, taskCriteriaDigest: approvedCriteria },
    { ...trustedApproved, diagnosticPurpose: approvedPurpose, taskCriteriaDigest: approvedCriteria },
  ).ok, true);

  const approvedMismatches: readonly [string, Record<string, unknown>][] = [
    ['taskStateSchemaVersion', { ...approved, taskStateSchemaVersion: '0.1.0' }],
    ['expectedTaskStateVersion', { ...approved, expectedTaskStateVersion: 999 }],
    ['controlSchemaVersion', { ...approved, controlSchemaVersion: '0.1.0' }],
    ['expectedControlVersion', { ...approved, expectedControlVersion: 999 }],
    ['expectedEpoch', { ...approved, expectedEpoch: 999 }],
    ['taskId', { ...approved, taskId: 'task-foreign' }],
    ['runId', { ...approved, runId: 'run-foreign' }],
    ['runnableNode', { ...approved, runnableNode: 'Investigate' }],
    ['role', { ...approved, role: 'reviewer' }],
    ['providerRequestId', { ...approved, providerRequestId: 'request-foreign' }],
    ['requestReservationReceipt', { ...approved, requestReservationReceipt: 'reservation-foreign' }],
    ['providerRequest.reservationRef', { ...approved, providerRequest: { ...approved.providerRequest, reservationRef: 'reservation-foreign' } }],
    ['planApplicability', { ...approved, planApplicability: 'pre-plan-diagnostic' }],
    ['diagnosticScope', { ...approved, diagnosticPurpose: 'untrusted-purpose', taskCriteriaDigest: 'sha256:untrustedcriteria00000000000000000000000000000000000000000000' }],
    ['planBindingDigest', { ...approved, planBindingDigest: 'sha256:foreign-plan' }],
    ['planDecisionRef', { ...approved, planDecisionRef: 'foreign-decision' }],
    ['providerAdmissionReceiptRef', { ...approved, providerAdmissionReceipt: { ...approved.providerAdmissionReceipt, receiptId: 'receipt-foreign' } }],
    ['providerAdmissionReceiptDigest', { ...approved, providerAdmissionReceipt: { ...approved.providerAdmissionReceipt, receiptDigest: 'sha256:foreign-receipt' } }],
    ['budgetRefs', { ...approved, budgetRefs: ['budget-foreign'] }],
    ['providerId', { ...approved, providerIdentity: { ...approved.providerIdentity, providerId: 'provider-foreign' } }],
    ['modelId', { ...approved, providerIdentity: { ...approved.providerIdentity, modelId: 'model-foreign' } }],
    ['configId', { ...approved, providerIdentity: { ...approved.providerIdentity, configId: 'config-foreign' } }],
    ['configVersion', { ...approved, providerIdentity: { ...approved.providerIdentity, configVersion: 'foreign' } }],
    ['pricingPolicyId', { ...approved, providerIdentity: { ...approved.providerIdentity, pricingPolicyId: 'pricing-foreign' } }],
    ['pricingPolicyVersion', { ...approved, providerIdentity: { ...approved.providerIdentity, pricingPolicyVersion: 'foreign' } }],
    ['issuerKeyRef', { ...approved, providerIdentity: { ...approved.providerIdentity, issuerKeyRef: 'foreign' } }],
    ['decisionAuthorityGeneration', { ...approved, providerIdentity: { ...approved.providerIdentity, decisionAuthorityGeneration: 999 } }],
  ];
  for (const [field, context] of approvedMismatches) assert.equal(validateProviderAdmissionV02(context, trustedApproved).ok, false, `${field} must match independent trust`);

  const diagnostic = createValidProviderPrePlanDiagnosticContext({ runnableNode: 'Investigate' });
  const trustedDiagnostic = trustedProviderFixture(true);
  assert.equal(validateProviderAdmissionV02(diagnostic, trustedDiagnostic).ok, true);
  for (const context of [
    { ...diagnostic, runnableNode: 'Repair' },
    { ...diagnostic, diagnosticPurpose: 'invented-purpose' },
    { ...diagnostic, taskCriteriaDigest: 'sha256:foreign-criteria' },
    { ...diagnostic, planApplicability: 'approved-plan' },
  ]) assert.equal(validateProviderAdmissionV02(context, trustedDiagnostic).ok, false);

  const tooSmallBounds = {
    ...approved,
    finiteBounds: { ...approved.finiteBounds, maxInputTokens: 1 },
  };
  assert.equal(validateProviderAdmissionV02(tooSmallBounds, trustedApproved).ok, false);

  for (const [field, value] of [
    ['timeoutMs', approved.providerRequest.timeoutMs + 1],
    ['maxInputTokens', approved.providerRequest.maxInputTokens + 1],
    ['maxOutputTokens', approved.providerRequest.maxOutputTokens + 1],
    ['maxBillableTokens', approved.providerRequest.maxBillableTokens + 1],
    ['maxCostUsd', approved.providerRequest.maxCostUsd + 0.1],
  ] as const) {
    const request = createValidProviderRequest({ [field]: value });
    const digest = computeRequestContentDigest(request);
    const finiteBounds = { ...approved.finiteBounds, ...(field === 'timeoutMs' ? {} : { [field]: value }) };
    const overCeiling = {
      ...approved,
      providerRequest: request,
      requestContentDigest: digest,
      providerAdmissionReceipt: { ...approved.providerAdmissionReceipt, requestContentDigest: digest },
      finiteBounds,
    };
    assert.equal(validateProviderAdmissionV02(overCeiling, trustedProviderFixture(false, { [field]: value })).ok, false, `${field} request ceiling must be enforced`);
  }

  const oversizedRequest = createValidProviderRequest({ maxInputTokens: 9000, maxBillableTokens: 11000 });
  const oversizedDigest = computeRequestContentDigest(oversizedRequest);
  const oversized = {
    ...approved,
    providerRequest: oversizedRequest,
    requestContentDigest: oversizedDigest,
    providerAdmissionReceipt: { ...approved.providerAdmissionReceipt, requestContentDigest: oversizedDigest },
    finiteBounds: { ...approved.finiteBounds, maxInputTokens: 9000, maxBillableTokens: 11000 },
  };
  assert.equal(validateProviderAdmissionV02(oversized, trustedProviderFixture(false, { maxInputTokens: 9000, maxBillableTokens: 11000 })).ok, false);

  const tooManyReviewerIterations = {
    ...diagnostic,
    finiteBounds: { ...diagnostic.finiteBounds, maxReviewerIterations: 4 },
  };
  assert.equal(validateProviderAdmissionV02(tooManyReviewerIterations, trustedDiagnostic).ok, false);
});

test('Provider outcome requires exact trusted admission and budget references', () => {
  const valid = createValidProviderOutcomeReceipt();
  const trusted = createTrustedOutcomeContext('provider-request', 'approved-plan');
  assert.equal(validateProviderRequestOutcomeReceiptV02(valid, trusted).ok, true);
  assert.equal(validateProviderRequestOutcomeReceiptV02(redigestOutcome({ ...valid, budgetRefs: undefined }), trusted).ok, false);
  assert.equal(validateProviderRequestOutcomeReceiptV02(redigestOutcome({ ...valid, providerAdmissionReceiptRef: 'foreign-admission' }), trusted).ok, false);
  assert.equal(validateProviderRequestOutcomeReceiptV02(redigestOutcome({ ...valid, budgetRefs: ['foreign-budget'] }), trusted).ok, false);
});

test('Public v0.2 validators contain exotic input exceptions and return detached frozen values', () => {
  const throwingGetter = Object.defineProperty({}, 'subjectKind', {
    enumerable: true,
    get() { throw new Error('PROTECTED_SENTINEL'); },
  });
  const getterResult = callWithTrustedContext(validateRepositoryAdmissionV02, throwingGetter, createTrustedRepositoryFacts());
  assert.equal(getterResult.ok, false);

  const proxy = new Proxy({}, { ownKeys() { throw new Error('PROTECTED_SENTINEL'); } });
  assert.equal(validateAttemptOutcomeReceiptV02(proxy).ok, false);
  const cycle: Record<string, unknown> = {};
  cycle['self'] = cycle;
  assert.equal(validateAttemptOutcomeReceiptV02(cycle).ok, false);

  const providerInput = createValidProviderApprovedPlanContext();
  const providerTrust = trustedProviderFixture();
  const validated = callWithTrustedContext(validateProviderAdmissionV02, providerInput, providerTrust);
  assert.equal(validated.ok, true);
  if (validated.ok) {
    const resultValue = (validated as unknown as { value: ProviderAdmissionContextV02 }).value;
    assert.notEqual(resultValue.providerIdentity, providerInput.providerIdentity);
    assert.equal(Object.isFrozen(resultValue.providerIdentity), true);
    assert.equal(Object.isFrozen(resultValue.providerRequest), true);
    (providerInput.providerIdentity as unknown as { modelId: string }).modelId = 'changed-after-validation';
    assert.equal(resultValue.providerIdentity.modelId, 'model-test-01');
  }

  const attemptInput = createValidRepoOutcomeReceipt();
  const attemptResult = validateRepositoryActionOutcomeReceiptV02(attemptInput, createTrustedOutcomeContext('repository-action', 'approved-plan'));
  assert.equal(attemptResult.ok, true);
  if (attemptResult.ok) {
    assert.notEqual(attemptResult.value, attemptInput);
    assert.equal(Object.isFrozen(attemptResult.value), true);
    (attemptInput as unknown as { receiptId: string }).receiptId = 'changed-after-validation';
    assert.equal(attemptResult.value.receiptId, 'repo-out-001');
  }
});
