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
} from '../../../src/approvals/contracts.ts';

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
