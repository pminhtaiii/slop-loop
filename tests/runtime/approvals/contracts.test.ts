import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type BindingAssessmentValidationContext,
  type DeveloperDirectionValidationContext,
  type HumanResolutionValidationContext,
  validateApprovalRequestRecord,
  validateApprovalTaskControl,
  validateBindingAssessment,
  validateDeveloperDirection,
  validateDispatchClaim,
  validateHumanResolution,
  validatePolicyProfile,
  validateSafePresentation,
  validateDecisionEvent,
  validateSafeResult,
  UC05_APPROVAL_SCHEMA_VERSION_V02,
  computePolicyEvaluationReceiptDigest,
  computeActionDecisionReceiptDigest,
  computeProviderAdmissionReceiptDigest,
  computeClaimClosureReceiptDigest,
  computeDispatchClaimDigestV02,
  validatePolicyEvaluationReceipt,
  validateActionDecisionReceipt,
  validateProviderAdmissionReceipt,
  validateClaimClosureReceipt,
  validateDispatchClaimV02,
} from '../../../src/contracts/approvals/contracts.ts';

const validTaskControl = {
  schemaVersion: 'uc05-approval/0.1-draft',
  taskId: 'task-1',
  repositoryId: 'repo-1',
  workspaceId: 'workspace-1',
  version: 1,
  epoch: 1,
  mode: 'runnable',
  pendingDecisionId: null,
  continuationRef: null,
  reasonCode: 'task-runnable',
  outstandingClaimRefs: [],
};

const actionDigest = `sha256:${'a'.repeat(64)}`;
const presentationDigest = `sha256:${'b'.repeat(64)}`;
const validRequest = {
  schemaVersion: 'uc05-approval/0.1-draft',
  decisionId: 'decision-1',
  binding: {
    decisionId: 'decision-1',
    actionKind: 'action',
    normalizedActionDigest: actionDigest,
    taskId: 'task-1',
    workspaceId: 'workspace-1',
    repositoryRevisionDigest: `sha256:${'c'.repeat(64)}`,
    policyId: 'policy-1',
    policyVersion: '1.0.0',
    status: 'pending',
  },
  taskId: 'task-1',
  repositoryId: 'repo-1',
  workspaceId: 'workspace-1',
  createdRunId: 'run-1',
  continuationRef: 'continuation-1',
  requestVersion: 1,
  policyId: 'policy-1',
  policyVersion: '1.0.0',
  configId: 'config-1',
  configVersion: '1.0.0',
  actionRef: 'action-1',
  actionDigest,
  presentationDigest,
  createdAt: '2026-10-19T10:00:00.000Z',
  submissionKey: 'submission-1',
};

const validResolution = {
  schemaVersion: 'uc05-approval/0.1-draft',
  decisionId: 'decision-1',
  responseKey: 'response-1',
  expectedRequestVersion: 1,
  operatorChannelRef: 'channel-local',
  decision: 'approved',
  safeReasonCode: 'developer-approved',
  decidedAt: '2026-10-19T10:05:00.000Z',
  eventId: 'event-resolution-1',
};
const trustedOperator = { actorId: 'developer-local', channelRef: 'channel-local', provenance: 'real' };
const resolutionContext = {
  expectedDecisionId: 'decision-1',
  expectedRequestVersion: 1,
  trustedOperator,
};
const trustedContextDigest = `sha256:${'e'.repeat(64)}`;
const validAssessment = {
  schemaVersion: 'uc05-approval/0.1-draft',
  assessmentId: 'assessment-1',
  decisionId: 'decision-1',
  checkedTaskVersion: 3,
  checkedEpoch: 2,
  trustedContextDigest,
  status: 'valid',
  reasonCodes: [],
  checkedAt: '2026-10-19T10:10:00.000Z',
};
const assessmentContext = {
  expectedDecisionId: 'decision-1',
  expectedTaskVersion: 3,
  expectedEpoch: 2,
  trustedContextDigest,
};
const validDirection = {
  schemaVersion: 'uc05-approval/0.1-draft',
  directionId: 'direction-1',
  taskId: 'task-1',
  expectedVersion: 4,
  expectedEpoch: 3,
  direction: 'revise',
  safeScopeRef: 'scope-revision-1',
  responseKey: 'direction-response-1',
  createdAt: '2026-10-19T10:15:00.000Z',
};
const directionContext = {
  expectedTaskId: 'task-1',
  expectedVersion: 4,
  expectedEpoch: 3,
  trustedOperator,
};
const policyIdentity = { policyId: 'policy-1', policyVersion: '1.0.0', configId: 'config-1', configVersion: '1.0.0' };
const validClaim = {
  schemaVersion: 'uc05-approval/0.1-draft',
  claimId: 'claim-1',
  actionId: 'action-1',
  taskId: 'task-1',
  expectedControlVersion: 5,
  expectedEpoch: 4,
  repositoryStateDigest: `sha256:${'1'.repeat(64)}`,
  policyIdentity,
  decisionRefs: ['decision-1'],
  reservationRefs: ['reservation-1'],
  phase: 'claimed',
  resultRef: null,
};
const validPolicyProfile = {
  schemaVersion: 'uc05-approval/0.1-draft',
  profileId: 'uc05-local-v1',
  profileVersion: '1.0.0',
  policyIdentity,
  supportedActionKinds: ['run_command', 'apply_patch', 'approve_fix_plan'],
  commandRules: [{
    ruleId: 'pytest-focused',
    executableRef: 'pytest',
    argvPrefix: ['-q', 'tests/'],
    workingDirectoryRef: 'repository-root',
    timeoutMs: 2000,
    maxOutputBytes: 8192,
  }],
  sensitivePaths: ['.github/workflows/ci.yml', 'pyproject.toml'],
  patchBreadth: { maxFiles: 8, maxAddedDeletedLines: 400 },
  maxActionBytes: 65536,
  maxArgvEntries: 32,
  maxArgvEntryBytes: 4096,
  maxPresentationPageBytes: 8192,
  maxPresentationPages: 3,
  maxPresentationTotalBytes: 24576,
  maxEventBytes: 1024,
  operationDeadlineMs: 2000,
  maxMutationAttempts: 1,
  diagnosticRules: { maxBytes: 1024, redactSecrets: true, allowRawArtifacts: false, retainUnresolvedDecisions: true },
};
const validPresentation = {
  schemaVersion: 'uc05-approval/0.1-draft',
  decisionId: 'decision-1',
  requestVersion: 1,
  bindingFingerprint: `sha256:${'2'.repeat(64)}`,
  elements: {
    action: 'Run focused tests',
    necessity: 'Check the proposed fix',
    targets: ['src/example.ts'],
    consequences: 'Starts one bounded test command',
    verificationStatus: 'No checks run yet',
  },
  inspectionRef: 'inspection-1',
  presentationDigest: `sha256:${'3'.repeat(64)}`,
  page: { pageNumber: 1, pageCount: 1, pageBytes: 512, totalBytes: 512, truncated: false },
};
const validEvent = {
  schemaVersion: 'uc05-approval/0.1-draft',
  eventId: 'event-1',
  taskId: 'task-1',
  runId: null,
  decisionId: 'decision-1',
  directionId: null,
  claimId: null,
  type: 'human-resolution-recorded',
  outcome: 'ok',
  policyRef: policyIdentity,
  safeReasonCode: 'decision-recorded',
  timestamp: '2026-10-19T10:20:00.000Z',
};
const validSafeResult = {
  schemaVersion: 'uc05-approval/0.1-draft',
  outcome: 'ok',
  safeReasonCode: 'decision-recorded',
  taskId: 'task-1',
  decisionId: 'decision-1',
  controlVersion: 5,
  requestVersion: 1,
  eventRef: 'event-1',
  safeNextAction: 'inspect',
};

test('ApprovalTaskControl validator accepts a complete current-version record', () => {
  assert.equal(validateApprovalTaskControl(validTaskControl).ok, true);
  assert.equal(validateApprovalTaskControl({
    ...validTaskControl,
    mode: 'recovery-blocked',
    pendingDecisionId: 'decision-1',
    continuationRef: 'continuation-1',
  }).ok, true);
});

test('ApprovalTaskControl validator fails closed on unknown keys, incompatible versions, malformed bounds, or impossible states', () => {
  const sparseClaimRefs: unknown[] = [];
  sparseClaimRefs.length = 1;
  const cases: readonly unknown[] = [
    { ...validTaskControl, allowExecution: true },
    { ...validTaskControl, schemaVersion: 'uc05-approval/9.9' },
    { ...validTaskControl, epoch: Number.POSITIVE_INFINITY },
    { ...validTaskControl, taskId: 'bad task id' },
    { ...validTaskControl, mode: 'waiting', pendingDecisionId: null, continuationRef: null },
    { ...validTaskControl, mode: 'runnable', pendingDecisionId: 'decision-1' },
    { ...validTaskControl, outstandingClaimRefs: sparseClaimRefs },
  ];
  for (const candidate of cases) assert.equal(validateApprovalTaskControl(candidate).ok, false);
});

test('ApprovalRequestRecord validator accepts only a matching pending canonical binding', () => {
  assert.equal(validateApprovalRequestRecord(validRequest).ok, true);
  const invalid: readonly unknown[] = [
    { ...validRequest, binding: { ...validRequest.binding, status: 'approved' } },
    { ...validRequest, binding: { ...validRequest.binding, reason: 'terminal' } },
    { ...validRequest, actionDigest: `sha256:${'d'.repeat(64)}` },
    { ...validRequest, binding: { ...validRequest.binding, workspaceId: 'other-workspace' } },
    { ...validRequest, presentationDigest: 'sha256:short' },
    { ...validRequest, unknownExecutionFlag: true },
    { ...validRequest, createdAt: 'not-a-timestamp' },
  ];
  for (const candidate of invalid) assert.equal(validateApprovalRequestRecord(candidate).ok, false);
});

test('HumanResolution validator binds complete trusted channel identity and preserves terminal conflicts', () => {
  assert.equal(validateHumanResolution(validResolution, resolutionContext).ok, true);
  assert.equal(validateHumanResolution(validResolution, { ...resolutionContext, existingTerminalResolution: validResolution }).ok, true);

  const conflictingResolution = { ...validResolution, decision: 'rejected', safeReasonCode: 'developer-rejected' };
  const invalid: readonly [unknown, unknown][] = [
    [validResolution, undefined],
    [{ ...validResolution, decisionId: 'foreign-decision' }, resolutionContext],
    [{ ...validResolution, expectedRequestVersion: 2 }, resolutionContext],
    [validResolution, { ...resolutionContext, expectedRequestVersion: Number.NaN }],
    [validResolution, { ...resolutionContext, trustedOperator: { ...trustedOperator, provenance: 'mock' } }],
    [validResolution, { ...resolutionContext, trustedOperator: { actorId: '', channelRef: 'channel-local', provenance: 'real' } }],
    [{ ...validResolution, actorId: 'forged-actor' }, resolutionContext],
    [validResolution, { ...resolutionContext, existingTerminalResolution: conflictingResolution }],
    [validResolution, { ...resolutionContext, fakeHostCapability: true }],
    [{ ...validResolution, decidedAt: 'invalid' }, resolutionContext],
  ];
  for (const [record, context] of invalid) assert.equal(validateHumanResolution(record, context as HumanResolutionValidationContext | undefined).ok, false);
});

test('BindingAssessment validator requires complete matching task, epoch, and trusted digest context', () => {
  assert.equal(validateBindingAssessment(validAssessment, assessmentContext).ok, true);
  const invalid: readonly [unknown, unknown][] = [
    [validAssessment, undefined],
    [{ ...validAssessment, decisionId: 'foreign-decision' }, assessmentContext],
    [{ ...validAssessment, checkedTaskVersion: 4 }, assessmentContext],
    [{ ...validAssessment, trustedContextDigest: `sha256:${'f'.repeat(64)}` }, assessmentContext],
    [{ ...validAssessment, status: 'stale', reasonCodes: [] }, assessmentContext],
    [{ ...validAssessment, reasonCodes: ['repo-changed'], status: 'stale' }, { ...assessmentContext, expectedEpoch: 3 }],
    [{ ...validAssessment, extraAuthority: true }, assessmentContext],
    [validAssessment, { ...assessmentContext, extraAuthority: true }],
  ];
  for (const [record, context] of invalid) assert.equal(validateBindingAssessment(record, context as BindingAssessmentValidationContext | undefined).ok, false);
});

test('DeveloperDirection validator requires a trusted CLI identity and current task version/epoch', () => {
  assert.equal(validateDeveloperDirection(validDirection, directionContext).ok, true);
  const invalid: readonly [unknown, unknown][] = [
    [validDirection, undefined],
    [{ ...validDirection, direction: 'approve' }, directionContext],
    [{ ...validDirection, taskId: 'other-task' }, directionContext],
    [{ ...validDirection, expectedVersion: 5 }, directionContext],
    [validDirection, { ...directionContext, expectedEpoch: Number.POSITIVE_INFINITY }],
    [validDirection, { ...directionContext, trustedOperator: { ...trustedOperator, provenance: 'mock' } }],
    [{ ...validDirection, operatorId: 'forged' }, directionContext],
    [validDirection, { ...directionContext, mockCapability: true }],
  ];
  for (const [record, context] of invalid) assert.equal(validateDeveloperDirection(record, context as DeveloperDirectionValidationContext | undefined).ok, false);
});

test('DispatchClaim validator keeps finite phases, exact policy identity, references, and result state', () => {
  assert.equal(validateDispatchClaim(validClaim).ok, true);
  assert.equal(validateDispatchClaim({ ...validClaim, phase: 'uncertain', resultRef: 'effect-uncertain-1' }).ok, true);
  const invalid: readonly unknown[] = [
    { ...validClaim, phase: 'approved' },
    { ...validClaim, phase: 'observed', resultRef: null },
    { ...validClaim, expectedEpoch: Number.NaN },
    { ...validClaim, repositoryStateDigest: 'git-head-only' },
    { ...validClaim, policyIdentity: { ...policyIdentity, extra: true } },
    { ...validClaim, decisionRefs: ['decision-1', 'decision-1'] },
    { ...validClaim, reservationRefs: [] },
    { ...validClaim, canDispatch: true },
  ];
  for (const candidate of invalid) assert.equal(validateDispatchClaim(candidate).ok, false);
});

test('PolicyProfile validator admits only explicit finite test bounds and rejects permissive or unknown settings', () => {
  const sparseActionKinds: unknown[] = [];
  sparseActionKinds.length = 1;
  assert.equal(validatePolicyProfile(validPolicyProfile).ok, true);
  const invalid: readonly unknown[] = [
    { ...validPolicyProfile, maxActionBytes: 0 },
    { ...validPolicyProfile, maxArgvEntryBytes: -1 },
    { ...validPolicyProfile, maxEventBytes: Number.NaN },
    { ...validPolicyProfile, operationDeadlineMs: Number.POSITIVE_INFINITY },
    { ...validPolicyProfile, maxMutationAttempts: 2 },
    { ...validPolicyProfile, maxActionBytes: undefined },
    { ...validPolicyProfile, maxUnknownFutureBytes: 100 },
    { ...validPolicyProfile, profileId: 'production-default' },
    { ...validPolicyProfile, commandRules: [] },
    { ...validPolicyProfile, commandRules: [{ ...validPolicyProfile.commandRules[0], executableRef: 'node -e' }] },
    { ...validPolicyProfile, supportedActionKinds: ['run_command', 'run_command'] },
    { ...validPolicyProfile, supportedActionKinds: sparseActionKinds },
    { ...validPolicyProfile, diagnosticRules: { ...validPolicyProfile.diagnosticRules, allowRawArtifacts: true } },
  ];
  for (const candidate of invalid) assert.equal(validatePolicyProfile(candidate).ok, false);
});

test('SafePresentation validator enforces the five elements, digest identity, and profile byte/page bounds', () => {
  assert.equal(validateSafePresentation(validPresentation, validPolicyProfile).ok, true);
  const invalid: readonly [unknown, unknown][] = [
    [validPresentation, undefined],
    [{ ...validPresentation, presentationDigest: 'unhashed' }, validPolicyProfile],
    [{ ...validPresentation, elements: { ...validPresentation.elements, targets: [] } }, validPolicyProfile],
    [{ ...validPresentation, elements: { ...validPresentation.elements, action: '\u001b[31mapprove\u001b[0m' } }, validPolicyProfile],
    [{ ...validPresentation, page: { ...validPresentation.page, pageNumber: 4, pageCount: 4 } }, validPolicyProfile],
    [{ ...validPresentation, page: { ...validPresentation.page, pageBytes: 8193 } }, validPolicyProfile],
    [{ ...validPresentation, page: { ...validPresentation.page, totalBytes: 24577 } }, validPolicyProfile],
    [{ ...validPresentation, elements: { ...validPresentation.elements, actorId: 'forged' } }, validPolicyProfile],
  ];
  for (const [record, profile] of invalid) assert.equal(validateSafePresentation(record, profile).ok, false);
});

test('DecisionEvent validator uses finite safe outcomes, matching reference kinds, and the event-byte cap', () => {
  assert.equal(validateDecisionEvent(validEvent, validPolicyProfile).ok, true);
  const invalid: readonly [unknown, unknown][] = [
    [validEvent, undefined],
    [{ ...validEvent, outcome: 'approved' }, validPolicyProfile],
    [{ ...validEvent, decisionId: null }, validPolicyProfile],
    [{ ...validEvent, type: 'developer-direction-recorded', directionId: null, decisionId: null }, validPolicyProfile],
    [{ ...validEvent, actorId: 'forged' }, validPolicyProfile],
    [{ ...validEvent, policyRef: { ...policyIdentity, extra: true } }, validPolicyProfile],
    [validEvent, { ...validPolicyProfile, maxEventBytes: 128, diagnosticRules: { ...validPolicyProfile.diagnosticRules, maxBytes: 128 } }],
  ];
  for (const [record, profile] of invalid) assert.equal(validateDecisionEvent(record, profile).ok, false);
});

test('SafeResult envelope cannot encode authority, unbounded versions, or raw diagnostic text', () => {
  assert.equal(validateSafeResult(validSafeResult).ok, true);
  const invalid: readonly unknown[] = [
    { ...validSafeResult, outcome: 'approved' },
    { ...validSafeResult, safeNextAction: 'execute' },
    { ...validSafeResult, controlVersion: Number.POSITIVE_INFINITY },
    { ...validSafeResult, taskId: 'bad task id' },
    { ...validSafeResult, message: 'raw tool output' },
    { ...validSafeResult, decisionId: null, requestVersion: 1 },
  ];
  for (const candidate of invalid) assert.equal(validateSafeResult(candidate).ok, false);
});

/* =========================================================================
 * UC-05 v0.2.0 Receipt Tests (T043 RED / T044 GREEN)
 * ========================================================================= */

function redigestRecord(
  value: object,
  digestProperty: string,
  computeDigest: (receipt: unknown) => string,
): Record<string, unknown> {
  const candidate: Record<string, unknown> = { ...value };
  candidate[digestProperty] = computeDigest(candidate);
  return candidate;
}

function omitAndRedigestRecord(
  value: object,
  omittedProperty: string,
  digestProperty: string,
  computeDigest: (receipt: unknown) => string,
): Record<string, unknown> {
  const source: Record<string, unknown> = { ...value };
  const { [omittedProperty]: omitted, ...candidate } = source;
  void omitted;
  candidate[digestProperty] = computeDigest(candidate);
  return candidate;
}

const peBase = {
  schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
  receiptId: 'pe-receipt-1',
  actionDigest: `sha256:${'1'.repeat(64)}`,
  freshnessContextDigest: `sha256:${'2'.repeat(64)}`,
  policyId: 'policy-1',
  policyVersion: '1.0.0',
  configId: 'config-1',
  configVersion: '1.0.0',
  decisionAuthorityGeneration: 1,
  result: 'ALLOWED',
};
const validPolicyEvaluationReceipt = {
  ...peBase,
  receiptDigest: computePolicyEvaluationReceiptDigest(peBase),
};

const adBase = {
  schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
  decisionId: 'decision-ad-1',
  actionDigest: `sha256:${'1'.repeat(64)}`,
  evaluationReceiptRef: 'pe-receipt-1',
  decisionAuthorityGeneration: 1,
  status: 'approved',
  reason: 'Approved by security policy',
};
const validActionDecisionReceipt = {
  ...adBase,
  decisionDigest: computeActionDecisionReceiptDigest(adBase),
};

const provCoderCommon = {
  schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
  receiptId: 'prov-rec-coder-1',
  providerRequestId: 'req-coder-1',
  role: 'coder',
  requestContentDigest: `sha256:${'3'.repeat(64)}`,
  providerId: 'provider-test',
  modelId: 'model-test-01',
  policyId: 'policy-1',
  policyVersion: '1.0.0',
  configId: 'config-coder-v1',
  configVersion: '1.0.0',
  decisionAuthorityGeneration: 1,
};
const provCoderBase = {
  ...provCoderCommon,
  planApplicability: 'approved-plan',
  planBindingDigest: `sha256:${'4'.repeat(64)}`,
  planDecisionRef: 'dec-plan-001',
};
const validProviderAdmissionReceiptCoder = {
  ...provCoderBase,
  receiptDigest: computeProviderAdmissionReceiptDigest(provCoderBase),
};

const provReviewerCommon = {
  schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
  receiptId: 'prov-rec-rev-1',
  providerRequestId: 'req-rev-1',
  role: 'reviewer',
  requestContentDigest: `sha256:${'5'.repeat(64)}`,
  providerId: 'provider-test',
  modelId: 'model-test-01',
  policyId: 'policy-1',
  policyVersion: '1.0.0',
  configId: 'config-rev-v1',
  configVersion: '1.0.0',
  decisionAuthorityGeneration: 1,
};
const provReviewerBase = {
  ...provReviewerCommon,
  planApplicability: 'pre-plan-diagnostic',
  diagnosticPurpose: 'investigate_diagnostic',
  taskCriteriaDigest: `sha256:${'6'.repeat(64)}`,
};
const validProviderAdmissionReceiptReviewer = {
  ...provReviewerBase,
  receiptDigest: computeProviderAdmissionReceiptDigest(provReviewerBase),
};

const validProviderAdmissionReceiptCoderPrePlan = redigestRecord({
  ...provCoderCommon,
  planApplicability: 'pre-plan-diagnostic',
  diagnosticPurpose: 'baseline_investigation',
  taskCriteriaDigest: `sha256:${'6'.repeat(64)}`,
}, 'receiptDigest', computeProviderAdmissionReceiptDigest);
const validProviderAdmissionReceiptReviewerApprovedPlan = redigestRecord({
  ...provReviewerCommon,
  planApplicability: 'approved-plan',
  planBindingDigest: `sha256:${'4'.repeat(64)}`,
  planDecisionRef: 'dec-plan-001',
}, 'receiptDigest', computeProviderAdmissionReceiptDigest);

const closureBase = {
  schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
  receiptId: 'closure-rec-1',
  claimDigest: `sha256:${'8'.repeat(64)}`,
  claimId: 'claim-1',
  taskId: 'task-1',
  runId: 'run-1',
  taskStateSchemaVersion: 'uc03-task-state/0.1',
  expectedTaskStateVersion: 7,
  controlSchemaVersion: 'uc04-task-control/0.1',
  expectedControlVersion: 11,
  expectedEpoch: 3,
  reason: 'Pause before attempt invocation',
  pauseOrDenialEvent: {
    eventKind: 'pause',
    eventRef: 'pause-event-1',
    eventDigest: `sha256:${'9'.repeat(64)}`,
  },
  fencedExecutorIdentity: {
    adapterIdentity: 'docker-workspace-1',
    processIncarnation: 'inc-001',
    fencingGeneration: 1,
    payloadDigest: `sha256:${'7'.repeat(64)}`,
  },
  noAttemptProof: {
    journalRef: 'claim-journal-1',
    journalDigest: `sha256:${'a'.repeat(64)}`,
    claimPhase: 'claimed',
  },
  reservationDispositions: [
    { reservationRef: 'res-repair-1', disposition: 'released' },
    { reservationRef: 'res-token-1', disposition: 'released' },
  ],
};
const validClaimClosureReceipt = {
  ...closureBase,
  receiptDigest: computeClaimClosureReceiptDigest(closureBase),
};

const claimV02RepoBase = {
  schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
  claimId: 'claim-v02-repo-1',
  taskId: 'task-1',
  runId: 'run-1',
  subjectKind: 'repository-action',
  planApplicability: 'approved-plan',
  taskStateSchemaVersion: 'uc03-task-state/0.1',
  controlSchemaVersion: 'uc04-task-control/0.1',
  expectedControlVersion: 1,
  expectedEpoch: 1,
  expectedTaskStateVersion: 1,
  policyIdentity,
  decisionRefs: ['decision-1'],
  reservationRefs: ['reservation-1'],
  phase: 'claimed',
  resultRef: null,
  actionId: 'action-1',
  actionDigest: `sha256:${'8'.repeat(64)}`,
  repositoryStateDigest: `sha256:${'9'.repeat(64)}`,
  planBindingDigest: `sha256:${'a'.repeat(64)}`,
  planDecisionRef: 'decision-1',
};
const validDispatchClaimV02Repo = {
  ...claimV02RepoBase,
  claimDigest: computeDispatchClaimDigestV02(claimV02RepoBase),
};

const claimV02ProvBase = {
  schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
  claimId: 'claim-v02-prov-1',
  taskId: 'task-1',
  runId: 'run-1',
  subjectKind: 'provider-request',
  planApplicability: 'pre-plan-diagnostic',
  taskStateSchemaVersion: 'uc03-task-state/0.1',
  controlSchemaVersion: 'uc04-task-control/0.1',
  expectedControlVersion: 1,
  expectedEpoch: 1,
  expectedTaskStateVersion: 0,
  policyIdentity,
  decisionRefs: ['decision-1'],
  reservationRefs: ['reservation-1'],
  phase: 'claimed',
  resultRef: null,
  providerRequestId: 'req-prov-1',
  requestContentDigest: `sha256:${'b'.repeat(64)}`,
  role: 'coder',
  diagnosticPurpose: 'baseline_investigation',
  taskCriteriaDigest: `sha256:${'c'.repeat(64)}`,
};
const validDispatchClaimV02Provider = {
  ...claimV02ProvBase,
  claimDigest: computeDispatchClaimDigestV02(claimV02ProvBase),
};

function omitAndRedigestClaim(value: object, omittedProperty: string): Record<string, unknown> {
  const source: Record<string, unknown> = { ...value };
  const { [omittedProperty]: omitted, ...candidate } = source;
  void omitted;
  candidate['claimDigest'] = computeDispatchClaimDigestV02(candidate);
  return candidate;
}

function omitRecordField(value: object, omittedProperty: string): Record<string, unknown> {
  const source: Record<string, unknown> = { ...value };
  const { [omittedProperty]: omitted, ...candidate } = source;
  void omitted;
  return candidate;
}

test('v0.2 PolicyEvaluationReceipt validator accepts valid record', () => {
  const result = validatePolicyEvaluationReceipt(validPolicyEvaluationReceipt);
  assert.equal(result.ok, true);
});

test('v0.2 receipt validators require their explicit schema version even with a recomputed digest', () => {
  assert.equal(validatePolicyEvaluationReceipt(omitAndRedigestRecord(
    validPolicyEvaluationReceipt, 'schemaVersion', 'receiptDigest', computePolicyEvaluationReceiptDigest,
  )).ok, false);
  assert.equal(validateActionDecisionReceipt(omitAndRedigestRecord(
    validActionDecisionReceipt, 'schemaVersion', 'decisionDigest', computeActionDecisionReceiptDigest,
  )).ok, false);
  assert.equal(validateProviderAdmissionReceipt(omitAndRedigestRecord(
    validProviderAdmissionReceiptCoder, 'schemaVersion', 'receiptDigest', computeProviderAdmissionReceiptDigest,
  )).ok, false);
  assert.equal(validateClaimClosureReceipt(omitAndRedigestRecord(
    validClaimClosureReceipt, 'schemaVersion', 'receiptDigest', computeClaimClosureReceiptDigest,
  )).ok, false);
});

test('v0.2 PolicyEvaluationReceipt validator rejects unknown keys, cross-branch fields, and digest mismatch', () => {
  const invalid: readonly unknown[] = [
    { ...validPolicyEvaluationReceipt, extraKey: 'forbidden' },
    { ...validPolicyEvaluationReceipt, providerRequestId: 'req-1' },
    { ...validPolicyEvaluationReceipt, role: 'coder' },
    { ...validPolicyEvaluationReceipt, planBindingDigest: `sha256:${'0'.repeat(64)}` },
    { ...validPolicyEvaluationReceipt, receiptDigest: `sha256:${'f'.repeat(64)}` },
    { ...validPolicyEvaluationReceipt, result: 'UNAUTHORIZED' },
    { ...validPolicyEvaluationReceipt, schemaVersion: 'uc05-approval/0.1-draft' },
  ];
  for (const candidate of invalid) {
    assert.equal(validatePolicyEvaluationReceipt(candidate).ok, false);
  }
});

test('v0.2 ActionDecisionReceipt validator accepts valid record', () => {
  const result = validateActionDecisionReceipt(validActionDecisionReceipt);
  assert.equal(result.ok, true);
});

test('v0.2 ActionDecisionReceipt validator rejects non-approved status, cross-branch fields, and digest mismatch', () => {
  const invalid: readonly unknown[] = [
    { ...validActionDecisionReceipt, status: 'rejected' },
    { ...validActionDecisionReceipt, providerRequestId: 'req-1' },
    { ...validActionDecisionReceipt, decisionDigest: `sha256:${'f'.repeat(64)}` },
    { ...validActionDecisionReceipt, extraProp: true },
    { ...validActionDecisionReceipt, schemaVersion: 'uc05-approval/0.1-draft' },
    redigestRecord({ ...validActionDecisionReceipt, reason: undefined }, 'decisionDigest', computeActionDecisionReceiptDigest),
  ];
  for (const candidate of invalid) {
    assert.equal(validateActionDecisionReceipt(candidate).ok, false);
  }
});

test('v0.2 ProviderAdmissionReceipt accepts both roles on both explicit plan branches', () => {
  assert.equal(validateProviderAdmissionReceipt(validProviderAdmissionReceiptCoder).ok, true);
  assert.equal(validateProviderAdmissionReceipt(validProviderAdmissionReceiptReviewer).ok, true);
  assert.equal(validateProviderAdmissionReceipt(validProviderAdmissionReceiptCoderPrePlan).ok, true);
  assert.equal(validateProviderAdmissionReceipt(validProviderAdmissionReceiptReviewerApprovedPlan).ok, true);
});

test('v0.2 ProviderAdmissionReceipt requires and digest-binds policy identity on both branches', () => {
  const receipts = [
    validProviderAdmissionReceiptCoder,
    validProviderAdmissionReceiptReviewer,
    validProviderAdmissionReceiptCoderPrePlan,
    validProviderAdmissionReceiptReviewerApprovedPlan,
  ];
  for (const receipt of receipts) {
    for (const field of ['policyId', 'policyVersion'] as const) {
      assert.equal(validateProviderAdmissionReceipt(omitAndRedigestRecord(
        receipt, field, 'receiptDigest', computeProviderAdmissionReceiptDigest,
      )).ok, false, `${field} is required`);
      const malformed = field === 'policyId'
        ? { ...receipt, policyId: '' }
        : { ...receipt, policyVersion: '' };
      assert.equal(validateProviderAdmissionReceipt(redigestRecord(
        malformed, 'receiptDigest', computeProviderAdmissionReceiptDigest,
      )).ok, false, `${field} must be a valid identifier`);
      const changed = field === 'policyId'
        ? { ...receipt, policyId: 'policy-2' }
        : { ...receipt, policyVersion: '2.0.0' };
      assert.equal(validateProviderAdmissionReceipt(changed).ok, false, `${field} is digest-bound`);
      assert.equal(validateProviderAdmissionReceipt(redigestRecord(
        changed, 'receiptDigest', computeProviderAdmissionReceiptDigest,
      )).ok, true, `${field} changes are valid when their digest is recomputed`);
    }
  }
});

test('v0.2 ProviderAdmissionReceipt rejects missing branch and diagnostic bindings with a recomputed digest', () => {
  const invalid: readonly Record<string, unknown>[] = [
    omitAndRedigestRecord(validProviderAdmissionReceiptCoder, 'planApplicability', 'receiptDigest', computeProviderAdmissionReceiptDigest),
    omitAndRedigestRecord(validProviderAdmissionReceiptReviewer, 'diagnosticPurpose', 'receiptDigest', computeProviderAdmissionReceiptDigest),
    omitAndRedigestRecord(validProviderAdmissionReceiptReviewer, 'taskCriteriaDigest', 'receiptDigest', computeProviderAdmissionReceiptDigest),
    redigestRecord({ ...validProviderAdmissionReceiptReviewer, diagnosticPurpose: { unsafe: true } }, 'receiptDigest', computeProviderAdmissionReceiptDigest),
    redigestRecord({ ...validProviderAdmissionReceiptReviewer, taskCriteriaDigest: 42 }, 'receiptDigest', computeProviderAdmissionReceiptDigest),
    redigestRecord({ ...validProviderAdmissionReceiptReviewer, planBindingDigest: undefined }, 'receiptDigest', computeProviderAdmissionReceiptDigest),
    redigestRecord({ ...validProviderAdmissionReceiptCoder, diagnosticPurpose: undefined }, 'receiptDigest', computeProviderAdmissionReceiptDigest),
    omitAndRedigestRecord(validProviderAdmissionReceiptCoder, 'planBindingDigest', 'receiptDigest', computeProviderAdmissionReceiptDigest),
    omitAndRedigestRecord(validProviderAdmissionReceiptCoder, 'planDecisionRef', 'receiptDigest', computeProviderAdmissionReceiptDigest),
  ];
  for (const candidate of invalid) assert.equal(validateProviderAdmissionReceipt(candidate).ok, false);
});

test('v0.2 ProviderAdmissionReceipt validator rejects repository fields, invalid roles, and plan field violations', () => {
  const invalid: readonly unknown[] = [
    { ...validProviderAdmissionReceiptCoder, actionDigest: `sha256:${'0'.repeat(64)}` },
    { ...validProviderAdmissionReceiptCoder, commandView: 'view-1' },
    { ...validProviderAdmissionReceiptCoder, role: 'operator' },
    { ...validProviderAdmissionReceiptReviewer, planBindingDigest: `sha256:${'0'.repeat(64)}` },
    { ...validProviderAdmissionReceiptCoder, planBindingDigest: undefined, receiptDigest: 'sha256:invalid' },
    { ...validProviderAdmissionReceiptCoder, schemaVersion: 'uc05-approval/0.1-draft' },
  ];
  for (const candidate of invalid) {
    assert.equal(validateProviderAdmissionReceipt(candidate).ok, false);
  }
});

test('v0.2 ClaimClosureReceipt validator accepts valid fenced closure record', () => {
  const result = validateClaimClosureReceipt(validClaimClosureReceipt);
  assert.equal(result.ok, true);
});

test('v0.2 ClaimClosureReceipt binds claim versions, current pause evidence, no-attempt proof, fencing, and each reservation', () => {
  const invalid = [
    omitAndRedigestRecord(validClaimClosureReceipt, 'claimDigest', 'receiptDigest', computeClaimClosureReceiptDigest),
    omitAndRedigestRecord(validClaimClosureReceipt, 'runId', 'receiptDigest', computeClaimClosureReceiptDigest),
    omitAndRedigestRecord(validClaimClosureReceipt, 'taskStateSchemaVersion', 'receiptDigest', computeClaimClosureReceiptDigest),
    omitAndRedigestRecord(validClaimClosureReceipt, 'expectedTaskStateVersion', 'receiptDigest', computeClaimClosureReceiptDigest),
    omitAndRedigestRecord(validClaimClosureReceipt, 'controlSchemaVersion', 'receiptDigest', computeClaimClosureReceiptDigest),
    omitAndRedigestRecord(validClaimClosureReceipt, 'expectedControlVersion', 'receiptDigest', computeClaimClosureReceiptDigest),
    omitAndRedigestRecord(validClaimClosureReceipt, 'expectedEpoch', 'receiptDigest', computeClaimClosureReceiptDigest),
    omitAndRedigestRecord(validClaimClosureReceipt, 'pauseOrDenialEvent', 'receiptDigest', computeClaimClosureReceiptDigest),
    omitAndRedigestRecord(validClaimClosureReceipt, 'noAttemptProof', 'receiptDigest', computeClaimClosureReceiptDigest),
    omitAndRedigestRecord(validClaimClosureReceipt, 'reservationDispositions', 'receiptDigest', computeClaimClosureReceiptDigest),
    redigestRecord({ ...validClaimClosureReceipt, pauseOrDenialEvent: { eventKind: 'pause', eventDigest: closureBase.pauseOrDenialEvent.eventDigest } }, 'receiptDigest', computeClaimClosureReceiptDigest),
    redigestRecord({ ...validClaimClosureReceipt, pauseOrDenialEvent: { eventKind: 'pause', eventRef: closureBase.pauseOrDenialEvent.eventRef } }, 'receiptDigest', computeClaimClosureReceiptDigest),
    redigestRecord({ ...validClaimClosureReceipt, noAttemptProof: { journalRef: closureBase.noAttemptProof.journalRef, claimPhase: 'claimed' } }, 'receiptDigest', computeClaimClosureReceiptDigest),
    redigestRecord({ ...validClaimClosureReceipt, noAttemptProof: { journalDigest: closureBase.noAttemptProof.journalDigest, claimPhase: 'claimed' } }, 'receiptDigest', computeClaimClosureReceiptDigest),
    redigestRecord({ ...validClaimClosureReceipt, reservationDispositions: [{ disposition: 'released' }] }, 'receiptDigest', computeClaimClosureReceiptDigest),
    redigestRecord({ ...validClaimClosureReceipt, reservationDispositions: [{ reservationRef: 'res-repair-1' }] }, 'receiptDigest', computeClaimClosureReceiptDigest),
    redigestRecord({ ...validClaimClosureReceipt, reservationDispositions: [{ reservationRef: 'res-repair-1', disposition: 'retained' }] }, 'receiptDigest', computeClaimClosureReceiptDigest),
    redigestRecord({ ...validClaimClosureReceipt, reservationDispositions: [] }, 'receiptDigest', computeClaimClosureReceiptDigest),
    redigestRecord({ ...validClaimClosureReceipt, noAttemptProof: { ...closureBase.noAttemptProof, claimPhase: 'attempting' } }, 'receiptDigest', computeClaimClosureReceiptDigest),
    redigestRecord({ ...validClaimClosureReceipt, reservationDispositions: [{ reservationRef: 'res-repair-1', disposition: 'consumed' }] }, 'receiptDigest', computeClaimClosureReceiptDigest),
  ];
  for (const candidate of invalid) assert.equal(validateClaimClosureReceipt(candidate).ok, false);
});

test('v0.2 ClaimClosureReceipt validator rejects attemptId, cross-branch fields, and malformed executor identity', () => {
  const invalid: readonly unknown[] = [
    { ...validClaimClosureReceipt, attemptId: 'att-1' },
    { ...validClaimClosureReceipt, actionDigest: `sha256:${'0'.repeat(64)}` },
    { ...validClaimClosureReceipt, providerRequestId: 'req-1' },
    { ...validClaimClosureReceipt, outcome: 'observed' },
    { ...validClaimClosureReceipt, fencedExecutorIdentity: { ...validClaimClosureReceipt.fencedExecutorIdentity, fencingGeneration: 0 } },
    { ...validClaimClosureReceipt, receiptDigest: `sha256:${'0'.repeat(64)}` },
    { ...validClaimClosureReceipt, schemaVersion: 'uc05-approval/0.1-draft' },
  ];
  for (const candidate of invalid) {
    assert.equal(validateClaimClosureReceipt(candidate).ok, false);
  }
});

test('v0.2 DispatchClaimV02 validator accepts repository and provider claims', () => {
  assert.equal(validateDispatchClaimV02(validDispatchClaimV02Repo).ok, true);
  assert.equal(validateDispatchClaimV02(validDispatchClaimV02Provider).ok, true);
});

test('v0.2 DispatchClaimV02 requires explicit branch, versions, digest, and attempt identity', () => {
  const invalid = [
    omitAndRedigestClaim(validDispatchClaimV02Repo, 'schemaVersion'),
    omitAndRedigestClaim(validDispatchClaimV02Repo, 'subjectKind'),
    omitAndRedigestClaim(validDispatchClaimV02Repo, 'planApplicability'),
    omitRecordField(validDispatchClaimV02Repo, 'claimDigest'),
    omitAndRedigestClaim(validDispatchClaimV02Repo, 'runId'),
    omitAndRedigestClaim(validDispatchClaimV02Repo, 'taskStateSchemaVersion'),
    omitAndRedigestClaim(validDispatchClaimV02Repo, 'expectedTaskStateVersion'),
    omitAndRedigestClaim(validDispatchClaimV02Repo, 'controlSchemaVersion'),
    omitAndRedigestClaim(validDispatchClaimV02Repo, 'expectedControlVersion'),
    omitAndRedigestClaim(validDispatchClaimV02Repo, 'expectedEpoch'),
    omitAndRedigestClaim(validDispatchClaimV02Repo, 'actionDigest'),
    redigestRecord({ ...validDispatchClaimV02Repo, phase: 'attempting' }, 'claimDigest', computeDispatchClaimDigestV02),
    omitAndRedigestClaim(validDispatchClaimV02Provider, 'diagnosticPurpose'),
    omitAndRedigestClaim(validDispatchClaimV02Provider, 'taskCriteriaDigest'),
    redigestRecord({ ...validDispatchClaimV02Provider, attemptId: undefined }, 'claimDigest', computeDispatchClaimDigestV02),
    redigestRecord({ ...validDispatchClaimV02Provider, planBindingDigest: undefined }, 'claimDigest', computeDispatchClaimDigestV02),
  ];
  for (const candidate of invalid) assert.equal(validateDispatchClaimV02(candidate).ok, false);
});

test('v0.2 DispatchClaimV02 validator rejects v0.1 claims, cross-branch fields, and plan applicability violations', () => {
  // v0.1 claim is rejected by v0.2 validator
  assert.equal(validateDispatchClaimV02(validClaim).ok, false);
  // but valid under v0.1 validator
  assert.equal(validateDispatchClaim(validClaim).ok, true);
  // v0.2 claim is rejected by v0.1 validator
  assert.equal(validateDispatchClaim(validDispatchClaimV02Repo).ok, false);

  const invalid: readonly unknown[] = [
    { ...validDispatchClaimV02Repo, providerRequestId: 'req-1' },
    { ...validDispatchClaimV02Repo, role: 'coder' },
    { ...validDispatchClaimV02Provider, actionId: 'act-1' },
    { ...validDispatchClaimV02Provider, repositoryStateDigest: `sha256:${'0'.repeat(64)}` },
    { ...validDispatchClaimV02Provider, planBindingDigest: `sha256:${'0'.repeat(64)}` },
    { ...validDispatchClaimV02Repo, planBindingDigest: undefined },
    { ...validDispatchClaimV02Repo, phase: 'attempting', attemptId: null },
    { ...validDispatchClaimV02Repo, phase: 'claimed', attemptId: 'attempt-not-allowed-yet' },
  ];
  for (const candidate of invalid) {
    assert.equal(validateDispatchClaimV02(candidate).ok, false);
  }
});
