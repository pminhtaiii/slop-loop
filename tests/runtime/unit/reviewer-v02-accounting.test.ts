import assert from 'node:assert/strict';
import { HostModelPortV02 } from '../../../src/foundation/model-v02.ts';
import { createDeepSeekTransport } from '../../../src/foundation/deepseek-transport.ts';
import { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import test from 'node:test';
import { type ProviderAdmissionContextV02, type ReviewResult } from '../../../src/contracts/foundation/uc03.ts';
import { computeContextDigest, type HostModelTransport } from '../../../src/foundation/model.ts';
import { buildReviewerSnapshot, createRuntimeReviewer, usesCanonicalReviewerIngress } from '../../../src/foundation/reviewer.ts';
import { createFixtureBugTask, createFixtureSourceEvidence } from '../support/uc03/port-fixtures.ts';
import { createTestAdmissionTaskStateV02, createTestProviderAdmissionContextV02, createTestProviderRequest } from '../support/uc03/state-fixtures.ts';

const REPO_DIGEST = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DIFF = [
  '--- a/src/calculator.py',
  '+++ b/src/calculator.py',
  '@@ -1,2 +1,4 @@',
  ' def divide(a, b):',
  '-    return a / b',
  '+    if b == 0:',
  '+        return None',
  '+    return a / b',
  '',
].join('\n');
const USAGE = { inputTokens: 100, outputTokens: 20, costUsd: 0.001, billableTokens: 120 };
const ACCEPTED = { proposal: { proposalId: 'msg-1', content: JSON.stringify({ status: 'accepted', findings: [] }) }, observedUsage: USAGE };
const TASK_ID = 'task-calc-001';
const RUN_ID = 'run-001';

// The v0.2 ingress refuses to re-consume an attempt keyed by task, attempt and actor, so every
// logical request in this file gets its own provider request id and actor incarnation.
let sequence = 0;
const nextRequestId = (role: string): string => `req-${role}-${++sequence}`;
const nextActor = (tag: string) => ({ adapterIdentity: `adapter-${tag}-${sequence}`, processIncarnation: `proc-${tag}-${sequence}`, fencingGeneration: 1 });

function authorityFor(context: ProviderAdmissionContextV02) {
  const identity = context.providerIdentity;
  return {
    policyId: identity.pricingPolicyId,
    policyVersion: identity.pricingPolicyVersion,
    configId: identity.configId,
    configVersion: identity.configVersion,
    issuerKeyRef: identity.issuerKeyRef,
    decisionAuthorityGeneration: identity.decisionAuthorityGeneration,
  };
}

function reviewerSnapshot() {
  const task = createFixtureBugTask();
  const evidence = [createFixtureSourceEvidence({ revisionDigest: REPO_DIGEST })];
  const snapshot = buildReviewerSnapshot(task, DIFF, evidence, REPO_DIGEST, { runId: RUN_ID, expectedTaskStateVersion: 1 });
  return { task, evidence, snapshot };
}

/** Reviewer admission bound to the journal's current control version and epoch. */
function buildReviewerAdmission(controlVersion = 2, epoch = 1): ProviderAdmissionContextV02 {
  const { snapshot } = reviewerSnapshot();
  const providerRequestId = nextRequestId('reviewer');
  const providerRequest = createTestProviderRequest({
    providerRequestId,
    taskId: TASK_ID,
    runId: RUN_ID,
    role: 'reviewer',
    purpose: 'final-review',
    contextDigest: computeContextDigest(snapshot.state, snapshot.evidence),
    reservationRef: `res-${providerRequestId}`,
  });
  return createTestProviderAdmissionContextV02({
    providerRequest,
    taskId: TASK_ID,
    runId: RUN_ID,
    expectedControlVersion: controlVersion,
    expectedEpoch: epoch,
  });
}

function createStatePort(admission: ProviderAdmissionContextV02): MemoryStatePortV02 {
  return new MemoryStatePortV02({
    initialTaskState: createTestAdmissionTaskStateV02(admission),
    initialControlVersion: admission.expectedControlVersion,
    initialEpoch: admission.expectedEpoch,
    initialAuthorityRef: authorityFor(admission),
  });
}

function runReview(reviewer: ReturnType<typeof createRuntimeReviewer>, admission: ProviderAdmissionContextV02): Promise<ReviewResult> {
  const { task, evidence } = reviewerSnapshot();
  return reviewer.review(task, DIFF, evidence, admission.providerRequest, admission);
}

/** A real durable owner journal plus a counting fake transport; the transport is the only dispatch. */
function createDouble(admission: ProviderAdmissionContextV02, respond: () => unknown = () => ACCEPTED) {
  const dispatches: string[] = [];
  const actor = nextActor('reviewer');
  const fence = { generation: actor.fencingGeneration };
  const transport: HostModelTransport = {
    async execute(payload) {
      dispatches.push(`${payload.request.role}:${payload.request.providerRequestId}`);
      return respond();
    },
  };
  const statePort = createStatePort(admission);
  const model = new HostModelPortV02({ statePort, transport, executorIdentity: actor, currentExecutorIdentity: () => ({ ...actor, fencingGeneration: fence.generation }) });
  const reviewer = createRuntimeReviewer({ model, resolveRepoDigest: () => REPO_DIGEST });
  return { statePort, model, reviewer, dispatches, fence };
}

test('one logical reviewer request drives exactly one claim, attempt and outcome', async () => {
  const admission = buildReviewerAdmission();
  const double = createDouble(admission);
  const result = await runReview(double.reviewer, admission);

  assert.equal(result.status, 'accepted');
  assert.equal(double.dispatches.length, 1);

  const journal = double.statePort.getJournalSnapshot();
  assert.equal(journal.claims.length, 1);
  assert.equal(journal.attempts.length, 1);
  assert.equal(journal.outcomes.length, 1);
  assert.equal(journal.claims[0]?.claimId, `claim-${admission.providerRequestId}`);
  assert.equal(journal.outcomes[0]?.claimId, journal.claims[0]?.claimId);
  assert.equal(journal.outcomes[0]?.attemptId, journal.attempts[0]?.attemptId);
  assert.equal(journal.outcomes[0]?.outcome, 'observed');
  assert.equal(journal.claims[0]?.status, 'settled');
  assert.equal(journal.attempts[0]?.status, 'settled');
});

test('coder and reviewer turns share the task but keep distinct journal chains', async () => {
  const coderRequestId = nextRequestId('coder');
  const coderDraft = createTestProviderRequest({
    providerRequestId: coderRequestId,
    taskId: TASK_ID,
    runId: RUN_ID,
    role: 'coder',
    purpose: 'investigate-and-propose',
    reservationRef: `res-${coderRequestId}`,
  });
  const coderSeed = createTestProviderAdmissionContextV02({
    providerRequest: coderDraft,
    taskId: TASK_ID,
    runId: RUN_ID,
    expectedControlVersion: 2,
    expectedEpoch: 1,
  });
  const coderState = createTestAdmissionTaskStateV02(coderSeed);
  const coderEvidence = [createFixtureSourceEvidence({ revisionDigest: coderState.repositoryRevisionDigest })];
  const coderRequest = createTestProviderRequest({ ...coderSeed.providerRequest, contextDigest: computeContextDigest(coderState, coderEvidence) });
  const coderAdmission = createTestProviderAdmissionContextV02({
    providerRequest: coderRequest,
    taskId: TASK_ID,
    runId: RUN_ID,
    expectedControlVersion: 2,
    expectedEpoch: 1,
  });

  const dispatches: string[] = [];
  const actor = nextActor('coder');
  const statePort = createStatePort(coderAdmission);
  const model = new HostModelPortV02({
    statePort,
    transport: {
      async execute(payload) {
        dispatches.push(`${payload.request.role}:${payload.request.providerRequestId}`);
        return ACCEPTED;
      },
    },
    executorIdentity: actor,
    currentExecutorIdentity: () => actor,
  });

  const coderResult = await model.propose(coderState, coderEvidence, coderRequest, coderAdmission);
  assert.equal(coderResult.outcome, 'observed');

  const afterCoder = statePort.getJournalSnapshot();
  assert.equal(afterCoder.claims.length, 1);
  assert.equal(afterCoder.outcomes[0]?.outcome, 'observed');

  const reviewerAdmission = buildReviewerAdmission(afterCoder.controlVersion, afterCoder.epoch);
  const reviewer = createRuntimeReviewer({ model, resolveRepoDigest: () => REPO_DIGEST });
  const reviewResult = await runReview(reviewer, reviewerAdmission);
  assert.equal(reviewResult.status, 'accepted');

  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[0]?.startsWith('coder:'), true);
  assert.equal(dispatches[1]?.startsWith('reviewer:'), true);
  assert.notEqual(coderRequest.providerRequestId, reviewerAdmission.providerRequestId);
  assert.equal(coderAdmission.taskId, reviewerAdmission.taskId);
  assert.equal(reviewerAdmission.taskId, TASK_ID);

  const journal = statePort.getJournalSnapshot();
  assert.equal(journal.claims.length, 2);
  assert.equal(journal.attempts.length, 2);
  assert.equal(journal.outcomes.length, 2);
  assert.equal(new Set(journal.claims.map(claim => claim.claimId)).size, 2);
  assert.deepEqual(journal.claims.map(claim => claim.claimId).sort(), [`claim-${coderRequestId}`, `claim-${reviewerAdmission.providerRequestId}`].sort());
  assert.deepEqual(journal.outcomes.map(outcome => [outcome.claimId, outcome.attemptId]).sort(), journal.attempts.map(attempt => [attempt.claimId, attempt.attemptId]).sort());
  assert.ok(journal.claims.every(claim => claim.status === 'settled'));
  assert.equal(journal.activeClaimId, null);
});

test('wrong-role, stale, fenced and mismatched admissions dispatch nothing and leave the ledger unchanged', async () => {
  const admission = buildReviewerAdmission();
  const double = createDouble(admission);
  const { snapshot } = reviewerSnapshot();

  const denied = async (label: string, context: ProviderAdmissionContextV02, expectedReason: RegExp): Promise<void> => {
    const before = double.statePort.getJournalSnapshot();
    const result = await double.model.propose(snapshot.state, snapshot.evidence, admission.providerRequest, context);
    assert.notEqual(result.outcome, 'observed', label);
    assert.match(result.reason ?? '', expectedReason, label);
    assert.equal(double.dispatches.length, 0, label);
    assert.deepEqual(double.statePort.getJournalSnapshot(), before, label);
  };

  await denied('coder admission presented for the reviewer role', { ...admission, role: 'coder' }, /^ROLE_MISMATCH/);
  await denied('stale expectedControlVersion', { ...admission, expectedControlVersion: admission.expectedControlVersion + 7 }, /^CLAIM_DENIED/);
  await denied('stale expectedEpoch', { ...admission, expectedEpoch: admission.expectedEpoch + 7 }, /^CLAIM_DENIED/);
  await denied('admission providerRequestId does not match the request', { ...admission, providerRequestId: 'req-not-this-one' }, /^REQUEST_ID_MISMATCH/);
  double.fence.generation = 2;
  await denied('fenced executor', admission, /^FENCED_EXECUTOR/);
});

test('fence drift after the claim is re-checked before dispatch and reaches no transport', async () => {
  const admission = buildReviewerAdmission();
  const double = createDouble(admission);
  const { snapshot } = reviewerSnapshot();

  // The fence advances between the claim and the attempt: the ingress must re-check before any effect.
  const claim = double.statePort.claim.bind(double.statePort);
  double.statePort.claim = async (...args: Parameters<typeof claim>) => {
    const receipt = await claim(...args);
    double.fence.generation = 2;
    return receipt;
  };

  const result = await double.model.propose(snapshot.state, snapshot.evidence, admission.providerRequest, admission);
  assert.equal(result.outcome, 'denied');
  assert.match(result.reason ?? '', /^FENCED_EXECUTOR/);
  assert.equal(double.dispatches.length, 0);

  // The claim was taken before the drift and stands; no attempt or outcome was charged after it.
  const after = double.statePort.getJournalSnapshot();
  assert.equal(after.claims.length, 1);
  assert.equal(after.attempts.length, 0);
  assert.equal(after.outcomes.length, 0);
});

test('an uncertain dispatch is charged exactly once and never auto-retried', async () => {
  const admission = buildReviewerAdmission();
  const double = createDouble(admission, () => ({ outcome: 'uncertain', reason: 'upstream said: MODEL_OVERLOADED sk-leak' }));

  const recordOutcome = double.statePort.recordOutcome.bind(double.statePort);
  const receipts: Parameters<typeof recordOutcome>[0][] = [];
  double.statePort.recordOutcome = async (...args: Parameters<typeof recordOutcome>) => {
    receipts.push(args[0]);
    return recordOutcome(...args);
  };

  const result = await runReview(double.reviewer, admission);

  assert.equal(result.status, 'invalid');
  assert.match(double.reviewer.lastFailureReason ?? '', /^PROVIDER_UNCERTAIN/);
  assert.equal(JSON.stringify(result).includes('MODEL_OVERLOADED'), false);
  assert.equal(JSON.stringify(result).includes('sk-leak'), false);
  assert.equal(double.reviewer.lastFailureReason?.includes('MODEL_OVERLOADED'), false);
  assert.equal(double.reviewer.lastFailureReason?.includes('sk-leak'), false);
  assert.equal(receipts.length, 1);
  assert.equal(JSON.stringify(receipts).includes('MODEL_OVERLOADED'), false);
  assert.equal(JSON.stringify(receipts).includes('sk-leak'), false);
  assert.equal(double.dispatches.length, 1);

  const afterFirst = double.statePort.getJournalSnapshot();
  assert.equal(afterFirst.claims.length, 1);
  assert.equal(afterFirst.attempts.length, 1);
  assert.equal(afterFirst.outcomes.length, 1);
  assert.equal(afterFirst.outcomes[0]?.outcome, 'uncertain');
  assert.equal(afterFirst.claims[0]?.status, 'uncertain');
  assert.equal(afterFirst.attempts[0]?.status, 'uncertain');

  // Same provider request and admission: the ingress replays its cached uncertain result.
  const { snapshot } = reviewerSnapshot();
  const replay = await double.model.propose(snapshot.state, snapshot.evidence, admission.providerRequest, admission);
  assert.equal(replay.outcome, 'uncertain');
  assert.equal(double.dispatches.length, 1);
  assert.deepEqual(double.statePort.getJournalSnapshot(), afterFirst);
});

test('malformed reviewer content is refused after exactly one accounted provider call', async () => {
  const cases: readonly { readonly respond: () => unknown; readonly reason: string }[] = [
    { respond: () => ({ proposal: { proposalId: 'msg-1', content: 'not json' }, observedUsage: USAGE }), reason: 'REVIEW_CONTENT_INVALID' },
    {
      respond: () => ({
        proposal: {
          proposalId: 'msg-1',
          content: JSON.stringify({ status: 'findings', findings: [{ file: 'src/calculator.py', line: 1, side: 'new', severity: 'error', message: 'unchanged line' }] }),
        },
        observedUsage: USAGE,
      }),
      reason: 'REVIEW_REJECTED:LINE_NOT_IN_TRUSTED_DIFF',
    },
  ];
  for (const { respond, reason } of cases) {
    const admission = buildReviewerAdmission();
    const double = createDouble(admission, respond);
    const result = await runReview(double.reviewer, admission);
    assert.equal(result.status, 'invalid', reason);
    assert.deepEqual(result.findings, []);
    assert.equal(double.reviewer.lastFailureReason, reason);
    assert.equal(double.dispatches.length, 1, reason);
    const journal = double.statePort.getJournalSnapshot();
    assert.equal(journal.claims.length, 1, reason);
    assert.equal(journal.attempts.length, 1, reason);
    assert.equal(journal.outcomes.length, 1, reason);
    assert.equal(journal.outcomes[0]?.outcome, 'observed', reason);
  }
});

test('the reviewer holds no write authority and returns only canonical review fields', async () => {
  const admission = buildReviewerAdmission();
  const double = createDouble(admission);
  const { task, evidence } = reviewerSnapshot();
  const before = JSON.stringify({ task, evidence, request: admission.providerRequest, admission });
  const result = await double.reviewer.review(task, DIFF, evidence, admission.providerRequest, admission);

  assert.deepEqual(Object.keys(result).sort(), ['checkSetDigest', 'diffDigest', 'findings', 'iterationReservationRef', 'repoDigest', 'reviewId', 'reviewerRoleConfigId', 'status']);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(JSON.stringify({ task, evidence, request: admission.providerRequest, admission }), before);
});

test('production reviewer admission binds the canonical accounting ingress and review implementation', () => {
  const statePort = new MemoryStatePortV02();
  const model = new HostModelPortV02({
    statePort,
    transport: createDeepSeekTransport({
      endpoint: 'https://api.deepseek.com/anthropic/v1/messages',
      apiKey: 'synthetic-test-key',
      pricing: { inputRate: 1, outputRate: 1, cacheRate: 1, overheadRate: 0, denominator: 1000000 },
      fetch: async () => {
        throw new Error('Admission must not dispatch');
      },
    }),
  });
  const reviewer = createRuntimeReviewer({ model, resolveRepoDigest: () => REPO_DIGEST });
  assert.equal(usesCanonicalReviewerIngress(reviewer), true);
  assert.equal(usesCanonicalReviewerIngress({ ...reviewer }), false);
  const nonCanonicalModel = {
    provenance: 'real' as const,
    async propose() {
      return { outcome: 'denied' as const };
    },
  };
  assert.equal(usesCanonicalReviewerIngress(createRuntimeReviewer({ model: nonCanonicalModel, resolveRepoDigest: () => REPO_DIGEST })), false);
  const originalReview = reviewer.review;
  reviewer.review = async () => {
    throw new Error('Unaccounted review');
  };
  assert.equal(usesCanonicalReviewerIngress(reviewer), false);
  reviewer.review = originalReview;
  model.propose = async () => ({ outcome: 'denied' });
  assert.equal(usesCanonicalReviewerIngress(reviewer), false);
});
