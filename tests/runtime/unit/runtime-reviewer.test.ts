import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  validateTaskState,
  type ClaimReceiptV02,
  type ModelPortV02,
  type ProviderAdmissionContextV02,
  type ProviderRequest,
  type ReviewResult,
  type SourceEvidence,
  type TaskState,
} from '../../../src/contracts/foundation/uc03.ts';
import { buildTransportPayload, computeContextDigest, executeTransport, validateBaseModelInputs } from '../../../src/foundation/model.ts';
import { buildReviewerSnapshot, createRuntimeReviewer, parseUnifiedDiff } from '../../../src/foundation/reviewer.ts';
import {
  createFixtureBugTask,
  createFixtureClaimReceiptV02,
  createFixtureProviderAdmissionContextV02,
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

function response(content: string, observedUsage: unknown = USAGE): unknown {
  return { proposal: { proposalId: 'msg-1', content }, observedUsage };
}

function verdict(status: 'accepted' | 'findings', findings: readonly unknown[] = [], observedUsage: unknown = USAGE): unknown {
  return response(JSON.stringify({ status, findings }), observedUsage);
}

interface ModelCall {
  readonly state: TaskState;
  readonly evidence: readonly SourceEvidence[];
  readonly request: ProviderRequest;
  readonly context: ProviderAdmissionContextV02;
}

/** Fake v0.2 boundary: records the forwarded snapshot and maps the raw reply like the host ingress. */
function fakeModel(respond: () => unknown = () => verdict('accepted')): ModelPortV02 & { readonly calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  return {
    provenance: 'mock',
    calls,
    async propose(state, evidence, request, context) {
      calls.push({ state, evidence, request, context });
      return executeTransport({ execute: async () => respond() }, buildTransportPayload(state, evidence, request), request);
    },
  };
}

function claimFor(admission: ProviderAdmissionContextV02): ClaimReceiptV02 {
  return createFixtureClaimReceiptV02({
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
}

/** The owner mints the request from the same projection the ingress recomputes. */
function reviewerContextDigest(task: ReturnType<typeof createFixtureBugTask>, diff: string, evidence: readonly SourceEvidence[]): string {
  const snapshot = buildReviewerSnapshot(task, diff, evidence, REPO_DIGEST, { runId: 'run-001', expectedTaskStateVersion: 1 });
  return computeContextDigest(snapshot.state, snapshot.evidence);
}

function setup(respond?: () => unknown) {
  const task = createFixtureBugTask();
  const diff = DIFF;
  // Caller evidence is read at the projected (post-patch) revision, as the ingress requires.
  const evidence = [createFixtureSourceEvidence({ revisionDigest: REPO_DIGEST })];
  const request = createFixtureReviewerRequest({ purpose: 'final-review', contextDigest: reviewerContextDigest(task, diff, evidence) });
  const admission = createFixtureProviderAdmissionContextV02({ providerRequest: request, role: 'reviewer', runnableNode: 'Review' });
  const claim = claimFor(admission);
  const model = fakeModel(respond);
  const reviewer = createRuntimeReviewer({ model, resolveRepoDigest: () => REPO_DIGEST });
  return { task, diff, evidence, request, admission, claim, model, reviewer };
}

async function run(context: ReturnType<typeof setup>): Promise<ReviewResult> {
  return context.reviewer.review(context.task, context.diff, context.evidence, context.request, context.admission, context.claim);
}

test('refuses a coder-role request without dispatching', async () => {
  const context = setup();
  const coder = createFixtureReviewerRequest({ role: 'coder', purpose: 'investigate-and-propose', contextDigest: computeCanonicalSha256(DIFF) });
  const result = await context.reviewer.review(context.task, context.diff, context.evidence, coder, context.admission, context.claim);
  assert.equal(result.status, 'invalid');
  assert.equal(context.model.calls.length, 0);
  assert.equal(context.reviewer.lastFailureReason, 'ROLE_NOT_REVIEWER');
});

test('refuses admission, reservation and bounds mismatches before any dispatch', async () => {
  const coderAdmissionContext = createFixtureProviderAdmissionContextV02({ role: 'coder' });
  const cases: readonly { readonly run: (context: ReturnType<typeof setup>) => Promise<ReviewResult>; readonly reason: string }[] = [
    {
      run: async context => context.reviewer.review(context.task, context.diff, context.evidence, context.request, coderAdmissionContext, claimFor(coderAdmissionContext)),
      reason: 'ADMISSION_NOT_REVIEWER',
    },
    {
      run: async context =>
        context.reviewer.review(
          context.task,
          context.diff,
          context.evidence,
          context.request,
          { ...context.admission, providerIdentity: { ...context.admission.providerIdentity, configId: ' ' } },
          context.claim,
        ),
      reason: 'ADMISSION_NOT_REVIEWER',
    },
    {
      run: async context => context.reviewer.review(context.task, context.diff, context.evidence, context.request, { ...context.admission, requestReservationReceipt: 'bundle-other' }, context.claim),
      reason: 'RESERVATION_MISMATCH',
    },
    {
      run: async context =>
        context.reviewer.review(
          context.task,
          context.diff,
          context.evidence,
          context.request,
          { ...context.admission, finiteBounds: { ...context.admission.finiteBounds, maxCostUsd: 0.000001 } },
          context.claim,
        ),
      reason: 'REQUEST_EXCEEDS_ADMITTED_BOUNDS',
    },
  ];
  for (const { run: attempt, reason } of cases) {
    const context = setup();
    const result = await attempt(context);
    assert.equal(result.status, 'invalid', reason);
    assert.equal(context.reviewer.lastFailureReason, reason);
    assert.equal(context.model.calls.length, 0, reason);
  }
});

test('refuses empty and non-unified diffs before dispatch', async () => {
  for (const diff of ['', 'not a diff\n', '--- a/x\n+++ b/x\n@@ -1 +1 @@\n??\n']) {
    const context = setup();
    // The diff is rejected before any snapshot or request check, so the digest value is irrelevant here.
    const request = createFixtureReviewerRequest({ purpose: 'final-review', contextDigest: computeCanonicalSha256(diff) });
    const admission = createFixtureProviderAdmissionContextV02({ providerRequest: request, role: 'reviewer' });
    const result = await context.reviewer.review(context.task, diff, context.evidence, request, admission, claimFor(admission));
    assert.equal(result.status, 'invalid');
    assert.equal(result.findings.length, 0);
    assert.equal(context.reviewer.lastFailureReason, 'DIFF_NOT_UNIFIED');
    assert.equal(context.model.calls.length, 0);
  }
});

test('dispatches exactly one read-only reviewer request and accepts a clean diff', async () => {
  const context = setup();
  const result = await run(context);

  assert.equal(context.model.calls.length, 1);
  const call = context.model.calls[0];
  assert.ok(call);
  assert.equal(call.request.role, 'reviewer');
  assert.equal(call.request.purpose, 'final-review');
  assert.equal(call.state.node, 'Review');
  assert.equal(call.state.taskId, 'task-calc-001');
  assert.deepEqual([...call.state.changedPaths], ['src/calculator.py']);
  assert.equal(call.evidence.length, 2);
  assert.equal(call.evidence.find(item => item.path === 'review/diff.patch')?.boundedExcerpt, DIFF);
  assert.equal(call.context.providerRequestId, context.request.providerRequestId);
  assert.deepEqual(call.request, context.request);

  assert.deepEqual(
    { ...result },
    {
      reviewId: 'review-req-reviewer-001',
      reviewerRoleConfigId: 'config-reviewer-v1',
      repoDigest: REPO_DIGEST,
      diffDigest: computeCanonicalSha256(DIFF),
      checkSetDigest: computeCheckSetDigest(context.task.requiredChecks),
      status: 'accepted',
      findings: [],
      iterationReservationRef: 'bundle-reviewer-001',
    },
  );
  assert.deepEqual({ ...context.reviewer.lastObservedUsage }, USAGE);
  assert.equal(context.reviewer.lastFailureReason, undefined);
});

test('forwards a projection the production task-state validator accepts', async () => {
  const context = setup();
  await run(context);
  const validation = validateTaskState(context.model.calls[0]?.state);
  assert.deepEqual(validation.ok ? [] : validation.errors, []);
});

test('the real model ingress accepts the reviewer snapshot and dispatches once', async () => {
  const context = setup();
  const complaints: string[] = [];
  let dispatches = 0;
  // Mirrors HostModelPort.propose: a failing base validation returns invalid and never dispatches.
  const ingressModel: ModelPortV02 = {
    provenance: 'mock',
    async propose(state, evidence, request) {
      const validation = validateBaseModelInputs(state, evidence, request);
      if (!validation.ok) {
        complaints.push(...validation.errors.map(error => `${error.path}:${error.code}`));
        return { outcome: validation.outcome, errors: validation.errors };
      }
      dispatches += 1;
      return executeTransport({ execute: async () => verdict('accepted') }, buildTransportPayload(state, evidence, request), request);
    },
  };
  const reviewer = createRuntimeReviewer({ model: ingressModel, resolveRepoDigest: () => REPO_DIGEST });
  const result = await reviewer.review(context.task, context.diff, context.evidence, context.request, context.admission, context.claim);

  assert.deepEqual(complaints, []);
  assert.equal(dispatches, 1);
  assert.equal(result.status, 'accepted');
  assert.equal(reviewer.lastFailureReason, undefined);
});

test('still refuses a request whose contextDigest does not match the projection, before dispatch', async () => {
  const context = setup();
  const wrong = createFixtureReviewerRequest({ purpose: 'final-review', contextDigest: computeCanonicalSha256(context.diff) });
  const admission = createFixtureProviderAdmissionContextV02({ providerRequest: wrong, role: 'reviewer', runnableNode: 'Review' });
  const result = await context.reviewer.review(context.task, context.diff, context.evidence, wrong, admission, claimFor(admission));
  assert.equal(result.status, 'invalid');
  assert.equal(context.reviewer.lastFailureReason, 'REQUEST_REJECTED:REQUEST_IDENTITY_MISMATCH');
  assert.equal(context.model.calls.length, 0);
});

test('keeps actionable findings that land on real old and new changed lines', async () => {
  const context = setup(() =>
    verdict('findings', [
      { file: 'src/calculator.py', line: 2, side: 'old', severity: 'warning', message: 'removed the divide call' },
      { file: 'src/calculator.py', line: 3, side: 'new', severity: 'error', message: 'returns None instead of raising' },
      { file: 'src/calculator.py', line: 2, side: 'new', severity: 'info', message: 'context line note' },
    ]),
  );
  const result = await run(context);
  assert.equal(result.status, 'findings');
  assert.equal(result.findings.length, 3);
  assert.equal(result.findings[0]?.side, 'old');
});

test('rejects findings off the diff or contradictory to their status', async () => {
  const cases: readonly { readonly respond: () => unknown; readonly reason: string }[] = [
    {
      respond: () => verdict('findings', [{ file: 'src/calculator.py', line: 99, side: 'new', severity: 'error', message: 'out of range' }]),
      reason: 'REVIEW_REJECTED:LINE_NOT_IN_TRUSTED_DIFF',
    },
    {
      respond: () => verdict('findings', [{ file: 'src/other.py', line: 1, side: 'old', severity: 'error', message: 'unknown file' }]),
      reason: 'REVIEW_REJECTED:FILE_NOT_IN_TRUSTED_DIFF',
    },
    {
      respond: () => verdict('findings', [{ file: 'src/calculator.py', line: 1, side: 'new', severity: 'error', message: 'not a changed line' }]),
      reason: 'REVIEW_REJECTED:LINE_NOT_IN_TRUSTED_DIFF',
    },
    {
      respond: () => verdict('accepted', [{ file: 'src/calculator.py', line: 3, side: 'new', severity: 'error', message: 'contradiction' }]),
      reason: 'REVIEW_REJECTED:ACTIONABLE_FINDINGS_IN_ACCEPTED_REVIEW',
    },
    { respond: () => verdict('findings'), reason: 'REVIEW_REJECTED:NO_ACTIONABLE_FINDINGS' },
  ];
  for (const { respond, reason } of cases) {
    const context = setup(() => respond());
    const result = await run(context);
    assert.equal(result.status, 'invalid');
    assert.equal(result.findings.length, 0);
    assert.equal(context.reviewer.lastFailureReason, reason);
    assert.equal(context.model.calls.length, 1);
  }
});

test('never accepts malformed, denied, uncertain, failed or over-cap provider outcomes', async () => {
  const cases: readonly { readonly respond: () => unknown; readonly reason: RegExp }[] = [
    { respond: () => response('not json'), reason: /^PROVIDER_ERROR|^REVIEW_CONTENT_INVALID$/ },
    { respond: () => response('[]'), reason: /REVIEW_CONTENT_INVALID/ },
    { respond: () => response('{"status":"accepted","findings":[],"extra":1}'), reason: /REVIEW_CONTENT_INVALID/ },
    { respond: () => response('{"status":"approved","findings":[]}'), reason: /REVIEW_CONTENT_INVALID/ },
    { respond: () => ({ outcome: 'uncertain', reason: 'PROVIDER_TIMEOUT: after dispatch' }), reason: /^PROVIDER_UNCERTAIN/ },
    { respond: () => ({ outcome: 'denied', reason: 'COST_BOUND_UNSUPPORTED: before dispatch' }), reason: /^PROVIDER_DENIED/ },
    { respond: () => verdict('accepted', [], { ...USAGE, inputTokens: 5000, billableTokens: 5020 }), reason: /^PROVIDER_INVALID:USAGE_EXCEEDS_CAPS/ },
  ];
  for (const { respond, reason } of cases) {
    const context = setup(() => respond());
    const result = await run(context);
    assert.equal(result.status, 'invalid');
    assert.match(context.reviewer.lastFailureReason ?? '', reason);
    assert.equal(
      result.findings.some(finding => finding.severity === 'error' || finding.severity === 'warning'),
      false,
    );
  }
  const throwing = setup(() => Promise.reject(new DOMException('timed out', 'TimeoutError')));
  assert.equal((await run(throwing)).status, 'invalid');
  assert.match(throwing.reviewer.lastFailureReason ?? '', /^PROVIDER_UNCERTAIN:PROVIDER_ERROR/);
});

test('keeps observed usage of a rejected over-cap response', async () => {
  const context = setup(() => verdict('accepted', [], { ...USAGE, billableTokens: 9000 }));
  const result = await run(context);
  assert.equal(result.status, 'invalid');
  assert.deepEqual({ ...context.reviewer.lastObservedUsage }, { ...USAGE, billableTokens: 9000 });
});

test('leaves the supplied task, diff, evidence, request, admission and claim untouched', async () => {
  const context = setup();
  const before = JSON.stringify({ task: context.task, diff: context.diff, evidence: context.evidence, request: context.request, admission: context.admission, claim: context.claim });
  await run(context);
  assert.equal(JSON.stringify({ task: context.task, diff: context.diff, evidence: context.evidence, request: context.request, admission: context.admission, claim: context.claim }), before);
  assert.equal(Object.isFrozen(context.request), false);
  assert.equal(Object.isFrozen(context.evidence[0]), false);
});

test('takes provenance from the model port', () => {
  assert.equal(setup().reviewer.provenance, 'mock');
  const real = createRuntimeReviewer({
    model: { ...fakeModel(), provenance: 'real' },
    resolveRepoDigest: () => REPO_DIGEST,
  });
  assert.equal(real.provenance, 'real');
  // The ingress shape must include propose; a bare provenance value is not enough.
  assert.throws(() => createRuntimeReviewer({ model: { provenance: 'mock' } as unknown as ModelPortV02, resolveRepoDigest: () => REPO_DIGEST }), /^Error: INVALID_MODEL/);
});

test('parses unified diffs into changed old and new lines only', () => {
  assert.deepEqual(parseUnifiedDiff(DIFF), { 'src/calculator.py': { oldLines: [2], newLines: [2, 3, 4] } });

  const added = ['--- /dev/null', '+++ b/src/new.py', '@@ -0,0 +1,2 @@', '+first', '+second', '\\ No newline at end of file', ''].join('\n');
  assert.deepEqual(parseUnifiedDiff(added), { 'src/new.py': { oldLines: [], newLines: [1, 2] } });

  const twoHunks = ['--- a/app.py', '+++ b/app.py', '@@ -1 +1 @@', '-old', '+new', '@@ -10,2 +10,2 @@', ' keep', '-gone', '+added', ''].join('\n');
  assert.deepEqual(parseUnifiedDiff(twoHunks), { 'app.py': { oldLines: [1, 11], newLines: [1, 11] } });

  assert.equal(parseUnifiedDiff(''), null);
  assert.equal(parseUnifiedDiff('hello\n'), null);
  assert.equal(parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n'), null);
  assert.equal(parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n*unexpected\n'), null);
  assert.equal(parseUnifiedDiff('+++ b/x\n@@ -1 +1 @@\n-a\n+b'), null);
  assert.equal(parseUnifiedDiff('--- a/../x\n+++ b/../x\n@@ -1 +1 @@\n-a\n+b'), null);
});
