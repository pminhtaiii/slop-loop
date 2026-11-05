import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeCanonicalSha256,
  type ClaimReceiptV02,
  type ModelPortV02,
  type ProviderAdmissionContextV02,
  type ProviderRequest,
  type ReviewResult,
  type SourceEvidence,
  type TaskState,
} from '../../../src/contracts/foundation/uc03.ts';
import { buildTransportPayload, executeTransport, type HostModelTransport } from '../../../src/foundation/model.ts';
import { createRuntimeReviewer } from '../../../src/foundation/reviewer.ts';
import {
  createFixtureBugTask,
  createFixtureClaimReceiptV02,
  createFixtureProviderAdmissionContextV02,
  createFixtureProviderRequest,
  createFixtureReviewerRequest,
  createFixtureSourceEvidence,
} from '../support/uc03/port-fixtures.ts';

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

interface ProposalCall {
  readonly state: TaskState;
  readonly evidence: readonly SourceEvidence[];
  readonly request: ProviderRequest;
  readonly context: ProviderAdmissionContextV02;
}

/** Counting transport plus a spy v0.2 model boundary; only the transport dispatch is counted. */
function spyModel(respond: () => unknown = () => ({ proposal: { proposalId: 'msg-1', content: JSON.stringify({ status: 'accepted', findings: [] }) }, observedUsage: USAGE })) {
  let transportCalls = 0;
  const transport: HostModelTransport = {
    async execute() {
      transportCalls++;
      return respond();
    },
  };
  const calls: ProposalCall[] = [];
  const model: ModelPortV02 & { readonly calls: ProposalCall[]; readonly transportCalls: () => number } = {
    provenance: 'mock',
    calls,
    transportCalls: () => transportCalls,
    async propose(state, evidence, request, context) {
      calls.push({ state, evidence, request, context });
      return executeTransport(transport, buildTransportPayload(state, evidence, request), request);
    },
  };
  return model;
}

function reviewerSetup(respond?: () => unknown) {
  const task = createFixtureBugTask();
  const evidence = [createFixtureSourceEvidence()];
  const request = createFixtureReviewerRequest({ purpose: 'final-review', contextDigest: computeCanonicalSha256(DIFF) });
  const admission = createFixtureProviderAdmissionContextV02({ providerRequest: request, role: 'reviewer', runnableNode: 'Review' });
  const claim: ClaimReceiptV02 = createFixtureClaimReceiptV02({
    taskId: admission.taskId,
    runId: admission.runId,
    subjectKind: 'provider-request',
    planApplicability: 'approved-plan',
    preClaimTaskStateVersion: admission.expectedTaskStateVersion,
    preClaimControlVersion: admission.expectedControlVersion,
    postClaimControlVersion: admission.expectedControlVersion + 1,
    epoch: admission.expectedEpoch,
    reservationRefs: [admission.requestReservationReceipt, ...admission.budgetRefs],
  });
  const model = spyModel(respond);
  const reviewer = createRuntimeReviewer({ model, resolveRepoDigest: () => REPO_DIGEST });
  return { task, evidence, request, admission, claim, model, reviewer };
}

function review(context: ReturnType<typeof reviewerSetup>): Promise<ReviewResult> {
  return context.reviewer.review(context.task, DIFF, context.evidence, context.request, context.admission, context.claim);
}

test('the transport executes exactly once per review and the reviewer never calls it itself', async () => {
  const context = reviewerSetup();
  const result = await review(context);

  assert.equal(result.status, 'accepted');
  assert.equal(context.model.transportCalls(), 1);
  assert.equal(context.model.calls.length, 1);
  // The reviewer is a plain consumer of the port: the port captured every forwarded snapshot.
  assert.equal(context.model.calls[0]?.state.node, 'Review');
  assert.equal(context.model.calls[0]?.request.role, 'reviewer');
});

test('same task, coder then reviewer: two separate dispatches with distinct roles and exact snapshots', async () => {
  const context = reviewerSetup();

  const coderState: TaskState = {
    schemaVersion: '0.1.0',
    stateVersion: 1,
    taskId: context.task.taskId,
    runId: 'run-001',
    workspaceId: 'workspace-001',
    repositoryId: context.task.repositoryId,
    repositoryRevisionDigest: context.task.initialRevisionDigest,
    goal: context.task.goal,
    observedBehavior: context.task.observedBehavior,
    expectedBehavior: context.task.expectedBehavior,
    reproduction: context.task.reproduction,
    acceptanceCriteria: context.task.acceptanceCriteria,
    constraints: context.task.constraints,
    requiredCheckIds: context.task.requiredChecks.map(check => check.checkId),
    node: 'Investigate',
    planVersion: 0,
    replanCount: 0,
    changedPaths: [],
    evidenceRefs: [],
    risks: [],
    nextAction: 'propose-fix-plan',
  };
  const coderEvidence = [createFixtureSourceEvidence({ revisionDigest: context.task.initialRevisionDigest })];
  const coderRequest = createFixtureProviderRequest({ purpose: 'investigate-and-propose', contextDigest: computeCanonicalSha256(coderEvidence) });
  const coderAdmission = createFixtureProviderAdmissionContextV02({ providerRequest: coderRequest, role: 'coder', runnableNode: 'Investigate' });

  const coderResult = await context.model.propose(coderState, coderEvidence, coderRequest, coderAdmission);
  assert.equal(coderResult.outcome, 'observed');

  const reviewerResult = await review(context);
  assert.equal(reviewerResult.status, 'accepted');

  const [coderCall, reviewerCall] = context.model.calls;
  assert.equal(context.model.transportCalls(), 2);
  assert.equal(coderCall?.request.role, 'coder');
  assert.equal(reviewerCall?.request.role, 'reviewer');
  assert.deepEqual(reviewerCall?.request, context.request);
  assert.deepEqual(reviewerCall?.context, context.admission);
  assert.equal(reviewerCall?.state.taskId, context.task.taskId);
  assert.equal(reviewerCall?.state.repositoryRevisionDigest, REPO_DIGEST);
  assert.deepEqual(
    reviewerCall?.evidence.map(item => item.path),
    ['src/calculator.py', 'review/diff.patch'],
  );
  assert.equal(reviewerCall?.evidence[1]?.boundedExcerpt, DIFF);
});

test('malformed reviewer content is refused after exactly one provider call', async () => {
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
    const context = reviewerSetup(respond);
    const result = await review(context);
    assert.equal(result.status, 'invalid', reason);
    assert.deepEqual(result.findings, []);
    assert.equal(context.reviewer.lastFailureReason, reason);
    assert.equal(context.model.transportCalls(), 1, reason);
  }
});

test('an uncertain outcome is invalid with a safe reason, one dispatch and no provider text', async () => {
  const providerText = 'upstream said: MODEL_OVERLOADED sk-leak';
  const context = reviewerSetup(() => ({ outcome: 'uncertain', reason: providerText }));
  const result = await review(context);

  assert.equal(result.status, 'invalid');
  assert.match(context.reviewer.lastFailureReason ?? '', /^PROVIDER_UNCERTAIN/);
  assert.equal(context.model.transportCalls(), 1);
  assert.equal(JSON.stringify(result).includes('MODEL_OVERLOADED'), false);
  assert.equal(JSON.stringify(result).includes('sk-leak'), false);
});

test('the reviewer holds no write authority and returns only canonical review fields', async () => {
  const context = reviewerSetup();
  const before = JSON.stringify({ task: context.task, evidence: context.evidence, request: context.request, admission: context.admission });
  const result = await review(context);

  assert.deepEqual(Object.keys(result).sort(), ['checkSetDigest', 'diffDigest', 'findings', 'iterationReservationRef', 'repoDigest', 'reviewId', 'reviewerRoleConfigId', 'status']);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(JSON.stringify({ task: context.task, evidence: context.evidence, request: context.request, admission: context.admission }), before);
});
