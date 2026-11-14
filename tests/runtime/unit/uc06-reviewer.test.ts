import assert from 'node:assert/strict';
import test from 'node:test';
import { computeCanonicalSha256 as hash, computeCheckSetDigest } from '../../../src/contracts/foundation/uc03.ts';
import type { ReviewContextV1 } from '../../../src/contracts/review.ts';
import { buildReviewerSnapshot, reviewerContextDigest, createRuntimeReviewer } from '../../../src/foundation/reviewer.ts';
import { computeContextDigest } from '../../../src/foundation/model.ts';
import { HostModelPortV02 } from '../../../src/foundation/model-v02.ts';
import { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import { createFixtureBugTask } from '../support/uc03/port-fixtures.ts';
import { createTestAdmissionTaskStateV02, createTestProviderAdmissionContextV02, createTestProviderRequest } from '../support/uc03/state-fixtures.ts';

const repo = 'sha256:' + 'b'.repeat(64);
const diff = '--- a/src/a.py\n+++ b/src/a.py\n@@ -1 +1 @@\n-old\n+task-independent\n';
const binding = { runId: 'run-001', expectedTaskStateVersion: 1 };
const usage = { inputTokens: 100, outputTokens: 20, billableTokens: 120, costUsd: 0.001 };
let sequence = 0;
function fixture() {
  const task = createFixtureBugTask();
  const approved = createTestProviderAdmissionContextV02();
  assert.equal(approved.planApplicability, 'approved-plan');
  const source = { path: 'src/a.py', revisionDigest: repo, boundedExcerpt: 'task-independent', resultCount: 1, truncated: false };
  const evidence = [source];
  const profile = {
    profileId: 'profile',
    profileVersion: '1',
    promptVersion: '1',
    promptDigest: hash('trusted prompt'),
    requiredConventionPaths: [],
    optionalEvidenceRefs: [],
    maxDiffBytes: 49152,
    maxContextBytes: 65536,
    maxEvidenceItems: 32,
    maxEvidenceBytes: 32768,
    maxFindings: 16,
    maxMessageBytes: 2048,
    maxOutputBytes: 16384,
    maxResponseBytes: 131072,
  };
  const verification = {
    baselineRef: 'baseline',
    results: task.requiredChecks.map(check => ({
      evidenceId: `result-${check.checkId}`,
      checkId: check.checkId,
      phase: 'focused' as const,
      outcome: 'pass' as const,
      repoDigest: repo,
      diffDigest: hash(diff),
      contentDigest: hash('passed'),
    })),
  };
  const body = {
    schemaVersion: 'uc06-review-context/1' as const,
    binding: {
      taskId: task.taskId,
      runId: binding.runId,
      repositoryId: task.repositoryId,
      workspaceId: 'workspace',
      baseRevisionDigest: task.initialRevisionDigest,
      headRevisionDigest: repo,
      diffDigest: hash(diff),
      criteriaDigest: hash({ acceptanceCriteria: task.acceptanceCriteria, constraints: task.constraints }),
      checkSetDigest: computeCheckSetDigest(task.requiredChecks),
      verificationDigest: hash(verification),
      conventionsDigest: hash([]),
      evidenceDigest: hash(evidence),
      profileDigest: hash(profile),
    },
    authority: { taskStateVersion: 1, controlVersion: 2, epoch: 1, decisionAuthorityGeneration: 2, planDecisionRef: approved.planDecisionRef, planBindingDigest: approved.planBindingDigest },
    profile,
    verification,
    conventions: [],
    evidence: [{ evidenceRef: 'source', path: source.path, revisionDigest: repo, contentDigest: hash(source.boundedExcerpt), kind: 'source' as const }],
  };
  return { task, source, evidence, context: { ...body, contextDigest: hash(body) } satisfies ReviewContextV1 };
}

test('bound snapshot carries exact context bytes and reserves synthetic paths; legacy stays unchanged', () => {
  const f = fixture();
  const legacy = buildReviewerSnapshot(f.task, diff, f.evidence, repo, binding);
  const bound = buildReviewerSnapshot(f.task, diff, f.evidence, repo, binding, f.context);
  assert.equal(bound.evidence.find(e => e.path === 'review/context.json')?.boundedExcerpt, JSON.stringify(f.context));
  assert.deepEqual(
    bound.evidence.filter(e => e.path !== 'review/context.json'),
    legacy.evidence,
  );
  assert.deepEqual(bound.state, legacy.state);
  assert.equal(Object.isFrozen(bound), true);
  assert.equal(Object.isFrozen(bound.evidence[0]), true);
  assert.equal(reviewerContextDigest(f.task, diff, f.evidence, repo, binding, f.context), computeContextDigest(bound.state, bound.evidence));
  assert.notEqual(computeContextDigest(bound.state, bound.evidence), computeContextDigest(legacy.state, legacy.evidence));
  for (const path of ['review/context.json', 'review/diff.patch']) assert.throws(() => buildReviewerSnapshot(f.task, diff, [{ ...f.source, path }], repo, binding, f.context));
});

async function runBound(
  content = JSON.stringify({ status: 'accepted', findings: [] }),
  options: {
    prepared?: ReturnType<typeof fixture> | undefined;
    remint?: boolean;
    missing?: boolean;
    throws?: boolean;
    mutate?: boolean;
    proposal?: Record<string, unknown>;
    requestDigest?: string;
  } = {},
) {
  const f = fixture();
  const legacy = buildReviewerSnapshot(f.task, diff, f.evidence, repo, binding);
  // Independent remint uses exact companion bytes, so request-digest rejection cannot mask a binding defect.
  const snapshot = options.remint
    ? {
        state: legacy.state,
        evidence: [...legacy.evidence, { path: 'review/context.json', revisionDigest: repo, boundedExcerpt: JSON.stringify(options.prepared?.context ?? f.context), resultCount: 1, truncated: false }],
      }
    : buildReviewerSnapshot(f.task, diff, f.evidence, repo, binding, f.context);
  const providerRequestId = `req-uc06-${++sequence}`;
  const request = createTestProviderRequest({
    providerRequestId,
    taskId: f.task.taskId,
    runId: binding.runId,
    role: 'reviewer',
    purpose: 'final-review',
    contextDigest: options.requestDigest ?? computeContextDigest(snapshot.state, snapshot.evidence),
    reservationRef: `res-${providerRequestId}`,
  });
  const admission = createTestProviderAdmissionContextV02({ providerRequest: request, taskId: f.task.taskId, runId: binding.runId, expectedControlVersion: 2, expectedEpoch: 1 });
  const id = admission.providerIdentity;
  const statePort = new MemoryStatePortV02({
    initialTaskState: createTestAdmissionTaskStateV02(admission),
    initialControlVersion: 2,
    initialEpoch: 1,
    initialAuthorityRef: {
      policyId: id.pricingPolicyId,
      policyVersion: id.pricingPolicyVersion,
      configId: id.configId,
      configVersion: id.configVersion,
      issuerKeyRef: id.issuerKeyRef,
      decisionAuthorityGeneration: id.decisionAuthorityGeneration,
    },
  });
  let calls = 0;
  const actor = { adapterIdentity: `uc06-${sequence}`, processIncarnation: `uc06-${sequence}`, fencingGeneration: 1 };
  const model = new HostModelPortV02({
    statePort,
    executorIdentity: actor,
    currentExecutorIdentity: () => actor,
    transport: {
      async execute(payload) {
        calls++;
        assert.deepEqual(payload.evidence, snapshot.evidence);
        return { proposal: { proposalId: 'verdict', content, ...options.proposal }, observedUsage: usage };
      },
    },
  });
  const reviewer = createRuntimeReviewer({
    model,
    resolveRepoDigest: async () => {
      if (options.mutate) {
        f.source.boundedExcerpt = 'mutated after minting';
        Object.assign(f.task, { goal: 'changed after minting' });
      }
      return repo;
    },
    resolveReviewContext: async () => {
      if (options.throws) throw new Error('private resolver failure');
      return options.missing ? undefined : (options.prepared ?? fixture());
    },
  });
  const result = await reviewer.review(f.task, diff, f.evidence, request, admission);
  return { result, calls, journal: statePort.getJournalSnapshot(), reviewer };
}

test('bound reviewer dispatches exact minted snapshot through canonical charged ingress', async () => {
  const run = await runBound();
  assert.equal(run.result.status, 'accepted', run.reviewer.lastFailureReason);
  assert.equal(run.calls, 1);
  assert.equal(run.journal.claims.length, 1);
  assert.equal(run.journal.attempts.length, 1);
  assert.equal(run.journal.outcomes.length, 1);
  assert.equal(run.journal.claims[0]?.status, 'settled');
});

const finding = { file: 'src/a.py', line: 1, side: 'new', severity: 'error', message: 'The changed result violates the required calculator behavior.', evidenceRef: 'source' };
test('whole bound output rejects absent evidence and retains its charged journal', async () => {
  const unsupported: Partial<typeof finding> = { ...finding };
  delete unsupported.evidenceRef;
  const run = await runBound(JSON.stringify({ status: 'findings', findings: [unsupported] }));
  assert.equal(run.result.status, 'invalid');
  assert.equal(run.calls, 1);
  assert.deepEqual(run.result.findings, []);
  assert.deepEqual(run.reviewer.lastObservedUsage, usage);
  assert.equal(run.journal.outcomes[0]?.outcome, 'observed');
  assert.equal(run.journal.claims[0]?.status, 'settled');
});

test('bound reviewer rejects model actions even alongside accepted content', async () => {
  const run = await runBound(undefined, { proposal: { actions: [{ actionId: 'act-run-001', kind: 'run_command', executable: 'pytest', argv: ['-q'], workingDirectory: 'tests' }] } });
  assert.equal(run.result.status, 'invalid');
  assert.equal(run.calls, 1);
  assert.deepEqual(run.reviewer.lastObservedUsage, usage);
  assert.equal(run.journal.claims[0]?.status, 'settled');
});

function refresh(f: ReturnType<typeof fixture>) {
  const body: Record<string, unknown> = { ...f.context };
  delete body['contextDigest'];
  f.context.contextDigest = hash(body);
  return f;
}

test('missing, stale, tampered or differently supplied contexts dispatch nothing', async () => {
  const cases: { missing?: boolean; prepared?: ReturnType<typeof fixture>; requestDigest?: string }[] = [{ missing: true }, { requestDigest: hash('other snapshot') }];
  for (const key of ['taskId', 'runId', 'repositoryId', 'headRevisionDigest', 'diffDigest', 'criteriaDigest', 'checkSetDigest'] as const) {
    const f = fixture();
    f.context.binding[key] = key.endsWith('Digest') ? hash('changed') : 'other';
    cases.push({ prepared: refresh(f) });
  }
  for (const key of ['taskStateVersion', 'controlVersion', 'epoch', 'decisionAuthorityGeneration'] as const) {
    const f = fixture();
    f.context.authority[key]++;
    cases.push({ prepared: refresh(f) });
  }
  const changedEvidence = fixture();
  changedEvidence.source.boundedExcerpt = 'different bytes';
  cases.push({ prepared: changedEvidence });
  const profile = fixture();
  profile.context.profile.promptVersion = 'other';
  cases.push({ prepared: profile });
  const unknown = fixture();
  Object.assign(unknown.context, { extra: true });
  cases.push({ prepared: unknown });
  for (const options of cases) {
    const run = await runBound(undefined, options);
    assert.equal(run.result.status, 'invalid');
    assert.equal(run.calls, 0);
    assert.equal(run.journal.claims.length, 0);
    assert.equal(run.journal.attempts.length, 0);
    assert.equal(run.journal.outcomes.length, 0);
  }
});

test('located evidence-backed output passes; bad finding or oversized content invalidates whole output', async () => {
  const valid = await runBound(JSON.stringify({ status: 'findings', findings: [finding] }));
  assert.equal(valid.result.status, 'findings');
  assert.deepEqual(valid.result.findings, [finding]);
  const info = await runBound(JSON.stringify({ status: 'accepted', findings: [{ ...finding, severity: 'info' }] }));
  assert.equal(info.result.status, 'accepted');
  for (const content of [
    JSON.stringify({ status: 'accepted', findings: [finding] }),
    JSON.stringify({ status: 'findings', findings: [{ ...finding, severity: 'info' }] }),
    ...[{ evidenceRef: 'invented' }, { line: 2 }, { side: 'old', line: 2 }, { file: 'src/other.py' }, { message: '' }, { message: 'x'.repeat(2049) }, { revision: repo }].map(patch =>
      JSON.stringify({ status: 'findings', findings: [finding, { ...finding, ...patch }] }),
    ),
    JSON.stringify({ status: 'findings', findings: Array.from({ length: 17 }, () => finding) }),
    ' '.repeat(16385) + JSON.stringify({ status: 'accepted', findings: [] }),
    '{broken',
  ]) {
    const run = await runBound(content);
    assert.equal(run.result.status, 'invalid');
    assert.deepEqual(run.result.findings, []);
    assert.equal(run.calls, 1);
    assert.deepEqual(run.reviewer.lastObservedUsage, usage);
    assert.equal(run.journal.claims[0]?.status, 'settled');
  }
});

test('resolver failures refuse safely and borrowed input mutation cannot change minted dispatch', async () => {
  const failed = await runBound(undefined, { throws: true });
  assert.equal(failed.result.status, 'invalid');
  assert.equal(failed.calls, 0);
  assert.equal(failed.journal.claims.length, 0);
  assert.equal(failed.reviewer.lastFailureReason?.includes('private'), false);
  const mutated = await runBound(undefined, { mutate: true });
  assert.equal(mutated.result.status, 'accepted', mutated.reviewer.lastFailureReason);
  assert.equal(mutated.calls, 1);
});

for (const key of ['baseRevisionDigest', 'planDecisionRef', 'planBindingDigest'] as const) {
  test(`self-consistent reminted ${key} contradiction refuses before accounting`, async () => {
    const control = await runBound(undefined, { remint: true });
    assert.equal(control.result.status, 'accepted');
    assert.equal(control.calls, 1);
    assert.equal(control.journal.claims[0]?.status, 'settled');
    const f = fixture();
    if (key === 'baseRevisionDigest') f.context.binding.baseRevisionDigest = hash('wrong initial candidate');
    else f.context.authority[key] = key === 'planDecisionRef' ? 'wrong-current-D1' : hash('wrong current plan');
    refresh(f);
    if (key === 'baseRevisionDigest') assert.throws(() => buildReviewerSnapshot(f.task, diff, f.evidence, repo, binding, f.context), /REVIEW_CONTEXT_INVALID/u);
    const run = await runBound(undefined, { prepared: f, remint: true });
    assert.equal(run.result.status, 'invalid');
    assert.equal(run.calls, 0);
    assert.equal(run.journal.claims.length, 0);
    assert.equal(run.journal.attempts.length, 0);
    assert.equal(run.journal.outcomes.length, 0);
  });
}
