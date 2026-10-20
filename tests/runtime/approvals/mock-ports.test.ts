import assert from 'node:assert/strict';
import test from 'node:test';
import { createMockActivityControl } from '../support/uc05/mock-context.ts';
import { createMockApprovalStore, UC05_MOCK_PROVENANCE } from '../support/uc05/mock-store.ts';
import { getUc05CaseFixture } from '../support/uc05/fixtures.ts';

const profile = {
  schemaVersion: 'uc05-approval/0.1-draft',
  profileId: 'uc05-local-v1',
  profileVersion: '1.0.0',
  policyIdentity: { policyId: 'policy-1', policyVersion: '1.0.0', configId: 'config-1', configVersion: '1.0.0' },
  supportedActionKinds: ['run_command', 'apply_patch', 'approve_fix_plan'],
  commandRules: [{ ruleId: 'pytest-focused', executableRef: 'pytest', argvPrefix: ['-q', 'tests/'], workingDirectoryRef: 'repository-root', timeoutMs: 2000, maxOutputBytes: 8192 }],
  sensitivePaths: ['.github/workflows/ci.yml'],
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
} as const;

const initialControl = {
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
} as const;

const actionDigest = `sha256:${'a'.repeat(64)}`;
const request = {
  schemaVersion: 'uc05-approval/0.1-draft',
  decisionId: 'decision-1',
  binding: {
    decisionId: 'decision-1',
    actionKind: 'action',
    normalizedActionDigest: actionDigest,
    taskId: 'task-1',
    workspaceId: 'workspace-1',
    repositoryRevisionDigest: `sha256:${'b'.repeat(64)}`,
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
  presentationDigest: `sha256:${'c'.repeat(64)}`,
  createdAt: '2026-10-19T10:00:00.000Z',
  submissionKey: 'submission-1',
} as const;

const requestEvent = {
  schemaVersion: 'uc05-approval/0.1-draft',
  eventId: 'event-request-1',
  taskId: 'task-1',
  runId: 'run-1',
  decisionId: 'decision-1',
  directionId: null,
  claimId: null,
  type: 'approval-request-created',
  outcome: 'pending',
  policyRef: profile.policyIdentity,
  safeReasonCode: 'pending-request-created',
  timestamp: '2026-10-19T10:00:00.000Z',
} as const;

const trustedOperator = { actorId: 'developer-local', channelRef: 'channel-local', provenance: 'real' } as const;
const resolution = {
  schemaVersion: 'uc05-approval/0.1-draft',
  decisionId: 'decision-1',
  responseKey: 'response-1',
  expectedRequestVersion: 1,
  operatorChannelRef: 'channel-local',
  decision: 'approved',
  safeReasonCode: 'developer-approved',
  decidedAt: '2026-10-19T10:05:00.000Z',
  eventId: 'event-resolution-1',
} as const;

const resolutionEvent = {
  schemaVersion: 'uc05-approval/0.1-draft',
  eventId: 'event-resolution-1',
  taskId: 'task-1',
  runId: 'run-1',
  decisionId: 'decision-1',
  directionId: null,
  claimId: null,
  type: 'human-resolution-recorded',
  outcome: 'ok',
  policyRef: profile.policyIdentity,
  safeReasonCode: 'human-resolution-recorded',
  timestamp: '2026-10-19T10:05:00.000Z',
} as const;

const claim = {
  schemaVersion: 'uc05-approval/0.1-draft',
  claimId: 'claim-1',
  actionId: 'action-1',
  taskId: 'task-1',
  expectedControlVersion: 1,
  expectedEpoch: 1,
  repositoryStateDigest: `sha256:${'d'.repeat(64)}`,
  policyIdentity: profile.policyIdentity,
  decisionRefs: ['decision-1'],
  reservationRefs: ['reservation-1'],
  phase: 'claimed',
  resultRef: null,
} as const;

const claimEvent = {
  schemaVersion: 'uc05-approval/0.1-draft',
  eventId: 'event-claim-1',
  taskId: 'task-1',
  runId: 'run-1',
  decisionId: null,
  directionId: null,
  claimId: 'claim-1',
  type: 'dispatch-claim-created',
  outcome: 'ok',
  policyRef: profile.policyIdentity,
  safeReasonCode: 'dispatch-claim-recorded',
  timestamp: '2026-10-19T10:10:00.000Z',
} as const;

/** Create a fresh mock store and assert that the shared request fixture pauses its task. */
function createPendingStore() {
  const store = createMockApprovalStore({ profile, initialControls: [initialControl] });
  const created = store.createPendingAndPause({ expectedControlVersion: 1, submissionKey: 'submission-1', request, event: requestEvent });
  assert.equal(created.safe.outcome, 'pending');
  return store;
}

const trustedContextDigest = `sha256:${'e'.repeat(64)}`;

/** Build a stale replacement request with override points for identity and idempotency regressions. */
function staleReplacementInput(replacementOverrides: Record<string, unknown> = {}) {
  const replacement = {
    ...request,
    decisionId: 'decision-2',
    binding: { ...request.binding, decisionId: 'decision-2' },
    requestVersion: 2,
    ...replacementOverrides,
  };
  return {
    expectedControlVersion: 2,
    expectedRequestVersion: 1,
    trustedContextDigest,
    assessment: {
      schemaVersion: 'uc05-approval/0.1-draft',
      assessmentId: 'assessment-stale-1',
      decisionId: 'decision-1',
      checkedTaskVersion: 2,
      checkedEpoch: 2,
      trustedContextDigest,
      status: 'stale',
      reasonCodes: ['repository-state-changed'],
      checkedAt: '2026-10-19T10:11:00.000Z',
    },
    replacement,
    events: [
      {
        ...requestEvent,
        eventId: 'event-binding-stale-1',
        type: 'binding-assessed',
        outcome: 'ok',
        safeReasonCode: 'binding-stale',
      },
      { ...requestEvent, eventId: 'event-request-2', decisionId: 'decision-2' },
    ],
  };
}

/** Create an audit event for the specified claim identity. */
function claimEventFor(claimId: string, eventId: string) {
  return { ...claimEvent, claimId, eventId };
}

/** Create an observed or uncertain event for a claim outcome transition. */
function claimOutcomeEvent(claimId: string, eventId: string, phase: 'observed' | 'uncertain') {
  return {
    ...claimEvent,
    eventId,
    claimId,
    type: phase === 'observed' ? 'dispatch-effect-observed' : 'dispatch-uncertain',
    outcome: phase === 'observed' ? 'ok' : 'uncertain',
    safeReasonCode: phase === 'observed' ? 'effect-observed' : 'claim-outcome-uncertain',
  };
}

/** Set up two outstanding dispatch claims and pause their task for recovery tests. */
function createTwoClaimPausedStore() {
  const store = createMockApprovalStore({ profile, initialControls: [initialControl] });
  assert.equal(store.claimDispatch({ claim, event: claimEvent }).safe.outcome, 'ok');
  const secondClaim = {
    ...claim,
    claimId: 'claim-2',
    actionId: 'action-2',
    expectedControlVersion: 2,
    reservationRefs: ['reservation-2'],
  };
  assert.equal(store.claimDispatch({ claim: secondClaim, event: claimEventFor('claim-2', 'event-claim-2') }).safe.outcome, 'ok');
  assert.equal(store.createPendingAndPause({
    expectedControlVersion: 3,
    submissionKey: 'submission-1',
    request,
    event: requestEvent,
  }).safe.outcome, 'pending');
  return store;
}

/** Approve the current pending request while requiring claim reconciliation to retain the hold. */
function approveWithOutstandingClaims(store: ReturnType<typeof createMockApprovalStore>, expectedControlVersion: number) {
  const result = store.resolvePending({
    expectedControlVersion,
    expectedRequestVersion: 1,
    trustedOperator,
    trustedResponse: resolution,
    event: resolutionEvent,
  });
  assert.equal(result.safe.outcome, 'uncertain');
  assert.equal(store.loadTaskControl('task-1').value?.mode, 'recovery-blocked');
}

test('UC05 mock ports load with explicit mock provenance and empty observable history', () => {
  const store = createMockApprovalStore({ profile, initialControls: [initialControl] });
  const activity = createMockActivityControl(profile);

  assert.equal(store.provenance, UC05_MOCK_PROVENANCE);
  assert.equal(activity.provenance, UC05_MOCK_PROVENANCE);
  assert.equal(store.loadTaskControl('task-1').safe.outcome, 'ok');
  assert.deepEqual(activity.readEffectLog(), []);
  assert.equal(getUc05CaseFixture('C20')?.evidence.localEvidenceSatisfiesRequiredLevel, false);
  assert.throws(() => createMockActivityControl({ ...profile, profileId: 'production-default' }), /finite test profile/u);
});

test('createPendingAndPause atomically saves the request and fences the task by version and epoch', () => {
  const store = createMockApprovalStore({ profile, initialControls: [initialControl] });
  const result = store.createPendingAndPause({
    expectedControlVersion: 1,
    submissionKey: 'submission-1',
    request,
    event: requestEvent,
  });

  assert.equal(result.safe.outcome, 'pending');
  assert.equal(result.value?.decisionId, 'decision-1');
  assert.deepEqual(store.loadTaskControl('task-1').value, {
    ...initialControl,
    version: 2,
    epoch: 2,
    mode: 'waiting',
    pendingDecisionId: 'decision-1',
    continuationRef: 'continuation-1',
    reasonCode: 'approval-pending',
  });
  assert.equal(store.readRequest('decision-1').value?.submissionKey, 'submission-1');
  assert.deepEqual(store.readEvents('task-1').value?.map((entry) => entry.eventId), ['event-request-1']);
});

test('replaceStalePending rejects repository or workspace identity changes without writing', () => {
  for (const replacementOverrides of [
    { repositoryId: 'repo-2' },
    {
      workspaceId: 'workspace-2',
      binding: { ...request.binding, decisionId: 'decision-2', workspaceId: 'workspace-2' },
    },
  ]) {
    const store = createPendingStore();
    const before = store.loadTaskControl('task-1').value;

    const result = store.replaceStalePending(staleReplacementInput(replacementOverrides));

    assert.equal(result.safe.outcome, 'invalid');
    assert.equal(result.safe.safeReasonCode, 'request-task-identity-mismatch');
    assert.deepEqual(store.loadTaskControl('task-1').value, before);
    assert.equal(store.readRequest('decision-2').safe.outcome, 'invalid');
    assert.deepEqual(store.readEvents('task-1').value?.map((event) => event.eventId), ['event-request-1']);
    assert.equal(store.readHistory('task-1').value?.assessments.length, 0);
  }
});

test('replaceStalePending rejects a reused task submission key without overwriting its retry identity', () => {
  const store = createPendingStore();
  const before = store.loadTaskControl('task-1').value;

  const result = store.replaceStalePending(staleReplacementInput({ submissionKey: 'submission-1' }));

  assert.equal(result.safe.outcome, 'conflict');
  assert.deepEqual(store.loadTaskControl('task-1').value, before);
  assert.equal(store.readRequest('decision-2').safe.outcome, 'invalid');
  assert.equal(store.readRequest('decision-1').value?.decisionId, 'decision-1');
  assert.deepEqual(store.readEvents('task-1').value?.map((event) => event.eventId), ['event-request-1']);
  assert.equal(store.readHistory('task-1').value?.assessments.length, 0);
});

test('replaceStalePending accepts a fresh request with matching task identity and a new submission key', () => {
  const store = createPendingStore();

  const result = store.replaceStalePending(staleReplacementInput({ submissionKey: 'submission-2' }));

  assert.equal(result.safe.outcome, 'pending');
  assert.equal(result.value?.decisionId, 'decision-2');
  assert.equal(store.loadTaskControl('task-1').value?.pendingDecisionId, 'decision-2');
  assert.equal(store.readRequest('decision-1').value?.decisionId, 'decision-1');
  assert.equal(store.readRequest('decision-2').value?.submissionKey, 'submission-2');
  assert.deepEqual(store.readEvents('task-1').value?.map((event) => event.eventId), [
    'event-request-1', 'event-binding-stale-1', 'event-request-2',
  ]);
  assert.equal(store.readHistory('task-1').value?.assessments.length, 1);
});

test('failed pending storage leaves no request, event, pause, or epoch change; retries are idempotent', () => {
  const store = createMockApprovalStore({ profile, initialControls: [initialControl] });
  store.failNext('createPendingAndPause');
  const input = { expectedControlVersion: 1, submissionKey: 'submission-1', request, event: requestEvent };

  const failed = store.createPendingAndPause(input);
  assert.equal(failed.safe.outcome, 'unavailable');
  assert.deepEqual(store.loadTaskControl('task-1').value, initialControl);
  assert.equal(store.readRequest('decision-1').safe.outcome, 'invalid');
  assert.deepEqual(store.readEvents('task-1').value, []);

  assert.equal(store.createPendingAndPause(input).safe.outcome, 'pending');
  assert.equal(store.createPendingAndPause(input).safe.outcome, 'pending');
  assert.equal(store.readEvents('task-1').value?.length, 1);

  const changedRetry = store.createPendingAndPause({
    expectedControlVersion: 1,
    submissionKey: 'submission-1',
    request: { ...request, decisionId: 'decision-2', binding: { ...request.binding, decisionId: 'decision-2' } },
    event: { ...requestEvent, eventId: 'event-request-2', decisionId: 'decision-2' },
  });
  assert.equal(changedRetry.safe.outcome, 'conflict');
  assert.equal(store.readEvents('task-1').value?.length, 1);
});

test('decision storage failure and mock operator provenance cannot release a waiting task', () => {
  const store = createPendingStore();
  store.failNext('resolvePending');
  const validInput = {
    expectedControlVersion: 2,
    expectedRequestVersion: 1,
    trustedOperator,
    trustedResponse: resolution,
    event: resolutionEvent,
  };

  const failed = store.resolvePending(validInput);
  assert.equal(failed.safe.outcome, 'unavailable');
  assert.equal(store.loadTaskControl('task-1').value?.mode, 'waiting');
  assert.equal(store.readHistory('task-1').value?.resolutions.length, 0);
  assert.equal(store.resolvePending({
    ...validInput,
    trustedOperator: { ...trustedOperator, provenance: 'mock' },
  }).safe.outcome, 'invalid');
  assert.equal(store.loadTaskControl('task-1').value?.mode, 'waiting');
  assert.equal(store.readHistory('task-1').value?.resolutions.length, 0);
});

test('resolvePending validates explicit operator input, deduplicates the same response, and keeps terminal history immutable', () => {
  const store = createPendingStore();
  const input = {
    expectedControlVersion: 2,
    expectedRequestVersion: 1,
    trustedOperator,
    trustedResponse: resolution,
    event: resolutionEvent,
  };
  const first = store.resolvePending(input);
  assert.equal(first.safe.outcome, 'ok');
  assert.equal(first.value?.decision, 'approved');
  assert.deepEqual(store.loadTaskControl('task-1').value, {
    ...initialControl,
    version: 3,
    epoch: 3,
    mode: 'runnable',
    reasonCode: 'developer-approved',
  });

  const retry = store.resolvePending(input);
  assert.equal(retry.safe.outcome, 'ok');
  assert.equal(retry.value?.eventId, 'event-resolution-1');
  const history = store.readHistory('task-1').value;
  assert.equal(history?.resolutions.length, 1);
  const terminalRecord = history?.resolutions[0];
  assert.ok(terminalRecord);
  assert.throws(() => Object.assign(terminalRecord, { decision: 'rejected' }), TypeError);
  assert.equal(store.readHistory('task-1').value?.resolutions[0]?.decision, 'approved');
  assert.equal(store.readEvents('task-1').value?.filter((entry) => entry.type === 'human-resolution-recorded').length, 1);

  const conflicting = store.resolvePending({
    ...input,
    trustedResponse: { ...resolution, responseKey: 'response-2', decision: 'rejected', safeReasonCode: 'developer-rejected', eventId: 'event-resolution-2' },
    event: { ...resolutionEvent, eventId: 'event-resolution-2', outcome: 'paused', safeReasonCode: 'human-resolution-rejected' },
  });
  assert.equal(conflicting.safe.outcome, 'conflict');
  assert.equal(store.readHistory('task-1').value?.resolutions[0]?.decision, 'approved');
});

test('a rejection stays held until an explicit direction, which preserves the terminal decision', () => {
  const store = createPendingStore();
  const rejected = store.resolvePending({
    expectedControlVersion: 2,
    expectedRequestVersion: 1,
    trustedOperator,
    trustedResponse: { ...resolution, responseKey: 'response-reject-1', decision: 'rejected', safeReasonCode: 'developer-rejected' },
    event: { ...resolutionEvent, eventId: 'event-rejected-1', outcome: 'paused', safeReasonCode: 'human-resolution-rejected' },
  });
  assert.equal(rejected.safe.outcome, 'paused');
  assert.equal(store.loadTaskControl('task-1').value?.mode, 'rejected');

  const direction = {
    schemaVersion: 'uc05-approval/0.1-draft',
    directionId: 'direction-1',
    taskId: 'task-1',
    expectedVersion: 3,
    expectedEpoch: 3,
    direction: 'revise',
    safeScopeRef: 'revision-scope-1',
    responseKey: 'direction-response-1',
    createdAt: '2026-10-19T10:06:00.000Z',
  } as const;
  const directionEvent = {
    schemaVersion: 'uc05-approval/0.1-draft',
    eventId: 'event-direction-1',
    taskId: 'task-1',
    runId: 'run-1',
    decisionId: null,
    directionId: 'direction-1',
    claimId: null,
    type: 'developer-direction-recorded',
    outcome: 'ok',
    policyRef: profile.policyIdentity,
    safeReasonCode: 'developer-direction-recorded',
    timestamp: '2026-10-19T10:06:00.000Z',
  } as const;
  const resumed = store.recordDirection({
    expectedControlVersion: 3,
    trustedOperator,
    direction,
    event: directionEvent,
  });

  assert.equal(resumed.safe.outcome, 'ok');
  assert.equal(store.loadTaskControl('task-1').value?.epoch, 4);
  assert.equal(store.loadTaskControl('task-1').value?.mode, 'runnable');
  assert.equal(store.readHistory('task-1').value?.resolutions[0]?.decision, 'rejected');
  assert.equal(store.readHistory('task-1').value?.directions[0]?.direction, 'revise');
  const accepted = { expectedControlVersion: 3, trustedOperator, direction, event: directionEvent };
  assert.equal(store.recordDirection(accepted).safe.outcome, 'ok');
  assert.equal(store.createPendingAndPause({ expectedControlVersion: 4, submissionKey: 'submission-2', request: { ...request, decisionId: 'decision-2', submissionKey: 'submission-2', binding: { ...request.binding, decisionId: 'decision-2' } }, event: { ...requestEvent, eventId: 'event-request-2', decisionId: 'decision-2' } }).safe.outcome, 'pending');
  assert.equal(store.recordDirection(accepted).safe.outcome, 'ok');
  assert.equal(store.loadTaskControl('task-1').value?.mode, 'waiting');
  assert.equal(store.readHistory('task-1').value?.directions.length, 1);
  assert.equal(store.readEvents('task-1').value?.filter(event => event.type === 'developer-direction-recorded').length, 1);
  for (const change of [{ direction: 'end' }, { expectedVersion: 5 }, { expectedEpoch: 5 }, { safeScopeRef: 'changed' }]) assert.equal(store.recordDirection({ ...accepted, direction: { ...direction, ...change } }).safe.outcome, 'conflict');
  assert.equal(store.recordDirection({ ...accepted, trustedOperator: { ...trustedOperator, channelRef: 'foreign-channel' } }).safe.outcome, 'conflict');
});

test('a pause that wins the claim race fences activity admission and leaves the effect log empty', () => {
  const store = createPendingStore();
  const activity = createMockActivityControl(profile);
  const claimResult = store.claimDispatch({ claim, event: claimEvent });
  assert.equal(claimResult.safe.outcome, 'paused');

  const admission = activity.admitAttempt({
    attemptId: 'attempt-1',
    control: store.loadTaskControl('task-1').value,
    claim,
  });
  assert.equal(admission.outcome, 'paused');
  assert.deepEqual(activity.inspectOutstanding('task-1'), []);
  assert.deepEqual(activity.readEffectLog(), []);
});

test('a claim admitted before pause remains cancellable and uncertain instead of being rolled back', () => {
  const store = createMockApprovalStore({ profile, initialControls: [initialControl] });
  const activity = createMockActivityControl(profile);
  const admittedClaim = store.claimDispatch({ claim, event: claimEvent });
  assert.equal(admittedClaim.safe.outcome, 'ok');
  const admittedAttempt = activity.admitAttempt({ attemptId: 'attempt-1', control: initialControl, claim });
  assert.equal(admittedAttempt.outcome, 'ok');

  const paused = store.createPendingAndPause({
    expectedControlVersion: 2,
    submissionKey: 'submission-1',
    request,
    event: requestEvent,
  });
  assert.equal(paused.safe.outcome, 'pending');
  assert.deepEqual(store.loadTaskControl('task-1').value?.outstandingClaimRefs, ['claim-1']);
  assert.equal(activity.fenceTask({ taskId: 'task-1', epoch: 2 }).outcome, 'paused');
  assert.equal(activity.requestCancellation('task-1').outcome, 'ok');
  assert.equal(activity.inspectOutstanding('task-1')[0]?.cancellationRequested, true);

  const effectAttempt = activity.recordEffectAttempt('attempt-1', 'mutation');
  assert.equal(effectAttempt.outcome, 'uncertain');
  assert.equal(effectAttempt.value?.observation, 'uncertain');
  assert.equal(activity.readEffectLog()[0]?.claimId, 'claim-1');
  assert.equal(activity.inspectOutstanding('task-1')[0]?.state, 'outstanding');
  assert.equal(activity.recordOutcome('attempt-1', 'cancelled').outcome, 'conflict');
  assert.equal(activity.recordOutcome('attempt-1', 'uncertain').outcome, 'uncertain');
  assert.equal(activity.inspectOutstanding('task-1')[0]?.state, 'uncertain');
  assert.equal(store.loadTaskControl('task-1').value?.mode, 'waiting');

  const uncertainEvent = {
    ...claimEvent,
    eventId: 'event-claim-uncertain-1',
    type: 'dispatch-uncertain',
    outcome: 'uncertain',
    safeReasonCode: 'claim-outcome-uncertain',
  } as const;
  const recorded = store.recordOutcome({
    claimId: 'claim-1',
    expectedControlVersion: 3,
    phase: 'uncertain',
    resultRef: 'effect-uncertain-1',
    event: uncertainEvent,
  });
  assert.equal(recorded.safe.outcome, 'uncertain');
  assert.deepEqual(store.loadTaskControl('task-1').value?.outstandingClaimRefs, ['claim-1']);
  assert.equal(store.readHistory('task-1').value?.claims[0]?.phase, 'uncertain');
});

test('observed claims keep recovery blocked until the final outstanding claim is observed', () => {
  const store = createTwoClaimPausedStore();
  approveWithOutstandingClaims(store, 4);

  const first = store.recordOutcome({
    claimId: 'claim-1',
    expectedControlVersion: 5,
    phase: 'observed',
    resultRef: 'effect-claim-1',
    event: claimOutcomeEvent('claim-1', 'event-observed-1', 'observed'),
  });
  assert.equal(first.safe.outcome, 'ok');
  assert.equal(store.loadTaskControl('task-1').value?.mode, 'recovery-blocked');
  assert.deepEqual(store.loadTaskControl('task-1').value?.outstandingClaimRefs, ['claim-2']);

  const last = store.recordOutcome({
    claimId: 'claim-2',
    expectedControlVersion: 6,
    phase: 'observed',
    resultRef: 'effect-claim-2',
    event: claimOutcomeEvent('claim-2', 'event-observed-2', 'observed'),
  });
  assert.equal(last.safe.outcome, 'ok');
  assert.equal(store.loadTaskControl('task-1').value?.mode, 'runnable');
  assert.deepEqual(store.loadTaskControl('task-1').value?.outstandingClaimRefs, []);
  assert.equal(store.loadTaskControl('task-1').value?.reasonCode, 'claim-observed');
});

test('reconciliation keeps recovery blocked until every outstanding claim is reconciled', () => {
  const store = createTwoClaimPausedStore();
  assert.equal(store.recordOutcome({
    claimId: 'claim-1',
    expectedControlVersion: 4,
    phase: 'uncertain',
    resultRef: 'uncertain-claim-1',
    event: claimOutcomeEvent('claim-1', 'event-uncertain-1', 'uncertain'),
  }).safe.outcome, 'uncertain');
  assert.equal(store.recordOutcome({
    claimId: 'claim-2',
    expectedControlVersion: 5,
    phase: 'uncertain',
    resultRef: 'uncertain-claim-2',
    event: claimOutcomeEvent('claim-2', 'event-uncertain-2', 'uncertain'),
  }).safe.outcome, 'uncertain');
  approveWithOutstandingClaims(store, 6);

  const first = store.reconcile({
    claimId: 'claim-1',
    expectedControlVersion: 7,
    resultRef: 'reconciled-claim-1',
    event: { ...claimEventFor('claim-1', 'event-reconciled-1'), type: 'claim-reconciled', safeReasonCode: 'claim-reconciled' },
  });
  assert.equal(first.safe.outcome, 'ok');
  assert.equal(store.loadTaskControl('task-1').value?.mode, 'recovery-blocked');
  assert.deepEqual(store.loadTaskControl('task-1').value?.outstandingClaimRefs, ['claim-2']);

  const last = store.reconcile({
    claimId: 'claim-2',
    expectedControlVersion: 8,
    resultRef: 'reconciled-claim-2',
    event: { ...claimEventFor('claim-2', 'event-reconciled-2'), type: 'claim-reconciled', safeReasonCode: 'claim-reconciled' },
  });
  assert.equal(last.safe.outcome, 'ok');
  assert.equal(store.loadTaskControl('task-1').value?.mode, 'runnable');
  assert.deepEqual(store.loadTaskControl('task-1').value?.outstandingClaimRefs, []);
});
