import assert from 'node:assert/strict';
import test from 'node:test';
import { computeCanonicalSha256, computeCheckSetDigest, type ClaimReceiptV02, type ProviderAdmissionContextV02, type ReviewResult } from '../../../src/contracts/foundation/uc03.ts';
import type { HostModelTransportPayload } from '../../../src/foundation/model.ts';
import { createRuntimeReviewer, parseUnifiedDiff } from '../../../src/foundation/reviewer.ts';
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

function fakeTransport(respond: (payload: HostModelTransportPayload) => unknown = () => verdict('accepted')) {
  const calls: HostModelTransportPayload[] = [];
  return {
    calls,
    async execute(payload: HostModelTransportPayload): Promise<unknown> {
      calls.push(payload);
      return respond(payload);
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

function setup(respond?: (payload: HostModelTransportPayload) => unknown) {
  const task = createFixtureBugTask();
  const diff = DIFF;
  const evidence = [createFixtureSourceEvidence()];
  const request = createFixtureReviewerRequest({ purpose: 'final-review', contextDigest: computeCanonicalSha256(diff) });
  const admission = createFixtureProviderAdmissionContextV02({ providerRequest: request, role: 'reviewer', runnableNode: 'Review' });
  const claim = claimFor(admission);
  const transport = fakeTransport(respond);
  const reviewer = createRuntimeReviewer({ transport, resolveRepoDigest: () => REPO_DIGEST });
  return { task, diff, evidence, request, admission, claim, transport, reviewer };
}

async function run(context: ReturnType<typeof setup>): Promise<ReviewResult> {
  return context.reviewer.review(context.task, context.diff, context.evidence, context.request, context.admission, context.claim);
}

test('refuses a coder-role request without dispatching', async () => {
  const context = setup();
  const coder = createFixtureReviewerRequest({ role: 'coder', purpose: 'investigate-and-propose', contextDigest: computeCanonicalSha256(DIFF) });
  const result = await context.reviewer.review(context.task, context.diff, context.evidence, coder, context.admission, context.claim);
  assert.equal(result.status, 'invalid');
  assert.equal(context.transport.calls.length, 0);
  assert.equal(context.reviewer.lastFailureReason, 'ROLE_NOT_REVIEWER');
});

test('refuses admission, reservation and claim mismatches before any dispatch', async () => {
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
      run: async context => context.reviewer.review(context.task, context.diff, context.evidence, context.request, context.admission, createFixtureClaimReceiptV02()),
      reason: 'CLAIM_REFUSED',
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
    assert.equal(context.transport.calls.length, 0, reason);
  }
});

test('refuses empty and non-unified diffs before dispatch', async () => {
  for (const diff of ['', 'not a diff\n', '--- a/x\n+++ b/x\n@@ -1 +1 @@\n??\n']) {
    const context = setup();
    const request = createFixtureReviewerRequest({ purpose: 'final-review', contextDigest: computeCanonicalSha256(diff) });
    const admission = createFixtureProviderAdmissionContextV02({ providerRequest: request, role: 'reviewer' });
    const result = await context.reviewer.review(context.task, diff, context.evidence, request, admission, claimFor(admission));
    assert.equal(result.status, 'invalid');
    assert.equal(result.findings.length, 0);
    assert.equal(context.reviewer.lastFailureReason, 'DIFF_NOT_UNIFIED');
    assert.equal(context.transport.calls.length, 0);
  }
});

test('dispatches exactly one read-only reviewer request and accepts a clean diff', async () => {
  const context = setup();
  const result = await run(context);

  assert.equal(context.transport.calls.length, 1);
  const payload = context.transport.calls[0];
  assert.ok(payload);
  assert.equal(payload.request.role, 'reviewer');
  assert.equal(payload.request.purpose, 'final-review');
  assert.equal(payload.state.node, 'Review');
  assert.equal(payload.state.taskId, 'task-calc-001');
  assert.deepEqual([...payload.state.changedPaths], ['src/calculator.py']);
  assert.equal(payload.evidence.length, 2);
  const diffItem = payload.untrustedContext.evidenceItems.find(item => item.path === 'review/diff.patch');
  assert.equal(diffItem?.content, DIFF);
  assert.equal(diffItem?.isUntrustedRepositoryContent, true);
  assert.equal('tools' in payload, false);

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
    assert.equal(context.transport.calls.length, 1);
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
