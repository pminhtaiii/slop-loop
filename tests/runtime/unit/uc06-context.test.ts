import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeCanonicalSha256 as hash,
  computeCheckSetDigest,
  validateRepositoryAdmissionV02,
  validateRepositoryExecutionReceiptV02,
  type ApprovalBinding,
  type TaskState,
  type VerificationApprovalContextV02,
  type VerificationApprovalResolutionV02,
  type VerificationResult,
} from '../../../src/contracts/foundation/uc03.ts';
import { prepareReviewContext, type ReviewContextInputs } from '../../../src/uc06/context.ts';
import { createVerificationApprovalContext } from '../../../src/uc03/post-patch-verification-authority.ts';
import {
  createTestAdmissionTaskStateV02,
  createTestRepositoryAdmissionContextV02,
  createTestRepositoryAdmissionTrustedContextV02,
  createTestClaimReceiptV02,
  createTestAttemptReceiptV02,
  createTestRepositoryOutcomeReceiptV02,
} from '../support/uc03/state-fixtures.ts';

function approval(context: VerificationApprovalContextV02, decisionId: string): VerificationApprovalResolutionV02 {
  const f = context.approvalContext;
  const binding: ApprovalBinding = {
    decisionId,
    actionKind: 'fix_plan',
    normalizedActionDigest: f.currentNormalizedActionDigest,
    taskId: f.currentTaskId,
    workspaceId: f.currentWorkspaceId,
    repositoryRevisionDigest: f.currentRepositoryRevisionDigest,
    policyId: f.currentPolicyId,
    policyVersion: f.currentPolicyVersion,
    planVersion: f.currentPlanVersion,
    strategyDigest: f.currentStrategyDigest,
    baselineRef: f.currentBaselineRef,
    evidenceRefs: f.currentEvidenceRefs,
    criteriaDigest: f.currentCriteriaDigest,
    checkSetDigest: f.currentCheckSetDigest,
    status: 'approved',
  };
  return {
    outcome: 'resolved',
    decisionId,
    binding,
    issuerKeyRef: context.expectedIssuerKeyRef,
    decisionAuthorityGeneration: context.expectedDecisionAuthorityGeneration,
    contextDigest: hash(context),
  };
}

/** Explicit controlled owner-read records; neither the fixture nor the assembler claims durable authority. */
function createReviewContextFixture(options: { readonly diff?: string; readonly requiredSourcePaths?: readonly string[] } = {}): ReviewContextInputs {
  const diff = options.diff ?? '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1 +1 @@\n-old\n+new\n';
  const admissionContext = createTestRepositoryAdmissionContextV02({
    runnableNode: 'Patch',
    action: { actionId: 'act-patch-001', kind: 'apply_patch', patchContent: diff, targetPaths: ['src/calculator.py'], baseRevisionDigest: 'sha256:' + 'a'.repeat(64) },
    canonicalRevision: 'sha256:' + 'a'.repeat(64),
  });
  const originalTaskState = createTestAdmissionTaskStateV02(admissionContext);
  const task = originalTaskState.taskContext;
  assert.ok(task && originalTaskState.plan?.decisionRef && admissionContext.planApplicability === 'approved-plan');
  const claim = createTestClaimReceiptV02({ taskId: task.taskId, runId: originalTaskState.runId });
  const initialAttempt = createTestAttemptReceiptV02({ taskId: task.taskId });
  const attempt = { ...initialAttempt, executorIdentity: { ...initialAttempt.executorIdentity, payloadDigest: admissionContext.actionDigest } };
  const outcome = createTestRepositoryOutcomeReceiptV02(claim, attempt, admissionContext);
  const settlement = { outcome: 'settled' as const, receiptId: outcome.receiptId };
  const trustedAdmissionContext = createTestRepositoryAdmissionTrustedContextV02(admissionContext);
  assert.equal(validateRepositoryAdmissionV02(admissionContext, trustedAdmissionContext).ok, true, 'fixture admission is canonical');
  const receiptValidation = validateRepositoryExecutionReceiptV02({ claim, attempt, outcome, settlement }, admissionContext);
  assert.equal(receiptValidation.ok, true, JSON.stringify(receiptValidation));
  const head = outcome.observedResultRevisionDigest;
  assert.ok(head);
  const state: TaskState = {
    ...originalTaskState,
    stateVersion: 7,
    repositoryRevisionDigest: head,
    node: 'Review',
    plan: { ...originalTaskState.plan, decisionRef: 'D1' },
    activeDecisionId: 'D1',
    changedPaths: ['src/calculator.py'],
    nextAction: 'final-review',
  };
  const policyIdentity = {
    policyId: admissionContext.policyAuthorityRef.policyId,
    policyVersion: admissionContext.policyAuthorityRef.policyVersion,
    configId: admissionContext.policyAuthorityRef.configId,
    configVersion: admissionContext.policyAuthorityRef.configVersion,
    issuerKeyRef: admissionContext.policyAuthorityRef.issuerKeyRef,
  };
  const authoritySnapshot = {
    taskId: task.taskId,
    runId: state.runId,
    stateVersion: state.stateVersion,
    repositoryRevisionDigest: head,
    controlVersion: 10,
    epoch: 1,
    decisionAuthorityGeneration: 3,
    policyIdentity,
    controlMode: 'runnable',
    holdRef: null,
    activeClaimId: null,
  };
  const currentContext = createVerificationApprovalContext(task, state, policyIdentity, 3, 'D1');
  const historicalContext = createVerificationApprovalContext(task, originalTaskState, policyIdentity, 3, originalTaskState.plan.decisionRef, 'historical-patch');
  assert.ok(currentContext && historicalContext);
  const content = {
    taskId: task.taskId,
    workspaceId: state.workspaceId,
    repositoryId: task.repositoryId,
    acceptanceCriteria: task.acceptanceCriteria,
    criteriaDigest: hash(task.acceptanceCriteria),
    requiredChecks: task.requiredChecks,
    expectedPassingCheckIds: [],
    reproductionCheckId: task.requiredChecks[0]?.checkId ?? '',
    expectedTestFiles: ['tests/test_calculator.py'],
    repositorySnapshotDigest: task.initialRevisionDigest,
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    reproductionFailureSignature: 'original-failure',
    checkResults: [{ checkId: task.requiredChecks[0]?.checkId ?? '', outcome: 'fail' as const }],
    testProtectionDigest: hash('protected-tests'),
  };
  const acknowledgement = {
    evidenceId: originalTaskState.plan.baselineRef,
    taskId: task.taskId,
    workspaceId: state.workspaceId,
    repositoryId: task.repositoryId,
    contentDigest: hash(content),
    repositorySnapshotDigest: task.initialRevisionDigest,
    criteriaDigest: content.criteriaDigest,
    checkSetDigest: content.checkSetDigest,
    testProtectionDigest: content.testProtectionDigest,
    reproductionCheckId: content.reproductionCheckId,
    expectedPassingCheckIds: [],
    expectedTestFiles: content.expectedTestFiles,
    requiredCheckIds: task.requiredChecks.map(c => c.checkId),
  };
  const verificationResults: VerificationResult[] = [
    {
      evidenceId: 'check-result',
      taskId: task.taskId,
      runId: state.runId,
      actionId: 'check-action',
      phase: 'focused',
      repoDigest: head,
      diffDigest: hash(diff),
      commandIdentity: hash({ executable: task.requiredChecks[0]?.executable, argv: task.requiredChecks[0]?.argv }),
      outcome: 'pass',
      testedIds: task.requiredChecks.map(c => c.checkId),
      diagnosticRefs: [],
    },
  ];
  return {
    task,
    state,
    repository: { baseRevisionDigest: task.initialRevisionDigest, headRevisionDigest: head, diff, diffDigest: hash(diff) },
    authoritySnapshot,
    currentApproval: approval(currentContext, 'D1'),
    historicalApproval: approval(historicalContext, originalTaskState.plan.decisionRef),
    ancestry: { admissionContext, trustedAdmissionContext, claim, attempt, outcome, settlement, originalTaskState, originalAuthorityRef: admissionContext.policyAuthorityRef },
    baseline: { content, acknowledgement },
    verificationResults,
    acknowledgedChecks: structuredClone(verificationResults),
    profile: {
      profileId: 'controlled',
      profileVersion: '1',
      promptVersion: '1',
      promptDigest: hash('trusted-reviewer-template'),
      requiredConventionPaths: ['CONVENTIONS.md'],
      optionalEvidenceRefs: [],
      maxDiffBytes: 49152,
      maxContextBytes: 65536,
      maxEvidenceItems: 32,
      maxEvidenceBytes: 32768,
      maxFindings: 16,
      maxMessageBytes: 2048,
      maxOutputBytes: 16384,
      maxResponseBytes: 131072,
    },
    requiredSourcePaths: options.requiredSourcePaths ?? ['src/calculator.py'],
    evidence: [
      { evidenceRef: 'source', kind: 'source', source: { path: 'src/calculator.py', revisionDigest: head, boundedExcerpt: 'new', resultCount: 1, truncated: false } },
      { evidenceRef: 'convention', kind: 'convention', source: { path: 'CONVENTIONS.md', revisionDigest: head, boundedExcerpt: 'Keep the public API stable.', resultCount: 1, truncated: false } },
    ],
  };
}

test('accepts the existing verification producer command identity without rewriting acknowledged evidence', () => {
  const inputs = createReviewContextFixture();
  const check = inputs.task.requiredChecks[0];
  assert.ok(check);
  const verificationResults = inputs.verificationResults.map(result => ({ ...result, commandIdentity: `${check.executable} ${check.argv.join(' ')}` }));
  const producerInputs = { ...inputs, verificationResults, acknowledgedChecks: structuredClone(verificationResults) };
  const before = hash(producerInputs);
  const result = prepareReviewContext(producerInputs);
  assert.equal(result.status, 'ready', JSON.stringify(result));
  if (result.status === 'ready') assert.equal(result.context.verification.results[0]?.contentDigest, hash(verificationResults[0]));
  assert.equal(hash(producerInputs), before);

  const wrong = verificationResults.map(record => ({ ...record, commandIdentity: `${check.executable} different-check.py` }));
  assert.equal(prepareReviewContext({ ...inputs, verificationResults: wrong, acknowledgedChecks: structuredClone(wrong) }).status, 'blocked');
  assert.equal(prepareReviewContext({ ...producerInputs, acknowledgedChecks: inputs.acknowledgedChecks }).status, 'blocked');
});

test('prepares one immutable context from current measured and acknowledged owner records', () => {
  const inputs = createReviewContextFixture();
  const result = prepareReviewContext(inputs);
  assert.equal(result.status, 'ready', JSON.stringify(result));
  if (result.status === 'ready') {
    assert.equal(result.context.binding.baseRevisionDigest, inputs.task.initialRevisionDigest);
    assert.equal(result.context.binding.headRevisionDigest, inputs.repository.headRevisionDigest);
    assert.equal(result.context.binding.criteriaDigest, hash({ acceptanceCriteria: inputs.task.acceptanceCriteria, constraints: inputs.task.constraints }));
    assert.equal(Object.isFrozen(result.context.binding), true);
    assert.notEqual(result.evidence, inputs.evidence);
    assert.equal(Object.isFrozen(inputs.state), false);
  }
});

test('refuses a missing host-required source excerpt and malformed check data without throwing', () => {
  const missing = structuredClone(createReviewContextFixture());
  const withoutSource = { ...missing, evidence: missing.evidence.filter(e => e.kind !== 'source') };
  assert.equal(prepareReviewContext(withoutSource).status, 'blocked', 'host-required source cannot disappear');
  const malformed = structuredClone(createReviewContextFixture()) as unknown as { verificationResults: { testedIds: unknown }[] };
  const malformedCheck = malformed.verificationResults[0];
  assert.ok(malformedCheck);
  malformedCheck.testedIds = {};
  assert.doesNotThrow(() => assert.equal(prepareReviewContext(malformed).status, 'blocked'));
});

const refusalCases: readonly [string, (i: ReviewContextInputs) => unknown][] = [
  ['changed measured head', i => ({ ...i, repository: { ...i.repository, headRevisionDigest: hash('other') } })],
  ['changed state criteria', i => ({ ...i, state: { ...i.state, acceptanceCriteria: ['different criteria'] } })],
  ['changed state constraints', i => ({ ...i, state: { ...i.state, constraints: ['different constraints'] } })],
  ['changed diff bytes', i => ({ ...i, repository: { ...i.repository, diff: i.repository.diff.replace('+new', '+different') } })],
  ['unsupported whole-file input', i => ({ ...i, repository: { ...i.repository, diff: 'entire source file' } })],
  ['stale authority version', i => ({ ...i, authoritySnapshot: { ...i.authoritySnapshot, stateVersion: 0 } })],
  ['active execution claim', i => ({ ...i, authoritySnapshot: { ...i.authoritySnapshot, activeClaimId: 'claim-active' } })],
  ['held control', i => ({ ...i, authoritySnapshot: { ...i.authoritySnapshot, controlMode: 'held', holdRef: 'hold' } })],
  ['forged current approval', i => ({ ...i, currentApproval: { ...i.currentApproval, contextDigest: hash('forged') } })],
  ['forged historical approval', i => ({ ...i, historicalApproval: { ...i.historicalApproval, contextDigest: hash('forged') } })],
  ['original authority mismatch', i => ({ ...i, ancestry: { ...i.ancestry, originalAuthorityRef: { ...i.ancestry.originalAuthorityRef, decisionAuthorityGeneration: 4 } } })],
  ['unsettled patch', i => ({ ...i, ancestry: { ...i.ancestry, settlement: { outcome: 'uncertain', receiptId: i.ancestry.outcome.receiptId } } })],
  [
    'changed original plan',
    i => ({ ...i, ancestry: { ...i.ancestry, originalTaskState: { ...i.ancestry.originalTaskState, plan: { ...i.ancestry.originalTaskState.plan, strategy: 'unapproved strategy' } } } }),
  ],
  ['forged baseline ACK', i => ({ ...i, baseline: { ...i.baseline, acknowledgement: { ...i.baseline.acknowledgement, contentDigest: hash('forged') } } })],
  ['baseline relabeled at head', i => ({ ...i, baseline: { ...i.baseline, content: { ...i.baseline.content, repositorySnapshotDigest: i.repository.headRevisionDigest } } })],
  ['missing baseline record', i => ({ ...i, baseline: { content: null, acknowledgement: null } })],
  ['missing check', i => ({ ...i, verificationResults: [] })],
  ['failed check', i => ({ ...i, verificationResults: i.verificationResults.map(r => ({ ...r, outcome: 'fail' })) })],
  ['stale check', i => ({ ...i, verificationResults: i.verificationResults.map(r => ({ ...r, repoDigest: i.task.initialRevisionDigest })) })],
  ['wrong check command', i => ({ ...i, verificationResults: i.verificationResults.map(r => ({ ...r, commandIdentity: hash('different command') })) })],
  [
    'unsupported check evidence URI',
    i => {
      const verificationResults = i.verificationResults.map(r => ({ ...r, evidenceId: 'uc04://verification/private' }));
      return { ...i, verificationResults, acknowledgedChecks: verificationResults };
    },
  ],
  ['missing check ACK', i => ({ ...i, acknowledgedChecks: [] })],
  ['forged check ACK', i => ({ ...i, acknowledgedChecks: i.verificationResults.map(r => ({ ...r, evidenceId: 'forged' })) })],
  ['missing convention', i => ({ ...i, evidence: i.evidence.filter(e => e.kind !== 'convention') })],
  ['empty mandatory convention', i => ({ ...i, evidence: i.evidence.map(e => (e.kind === 'convention' ? { ...e, source: { ...e.source, boundedExcerpt: ' \n ' } } : e)) })],
  ['truncated excerpt', i => ({ ...i, evidence: i.evidence.map(e => ({ ...e, source: { ...e.source, truncated: true } })) })],
  ['old revision excerpt', i => ({ ...i, evidence: i.evidence.map(e => ({ ...e, source: { ...e.source, revisionDigest: i.task.initialRevisionDigest } })) })],
  ['credential excerpt', i => ({ ...i, evidence: i.evidence.map(e => ({ ...e, source: { ...e.source, boundedExcerpt: 'sk-live-super-secret-credential' } })) })],
  ['synthetic context collision', i => ({ ...i, evidence: [...i.evidence, { evidenceRef: 'collision', kind: 'source', source: { ...firstSource(i), path: 'review/context.json' } }] })],
  ['synthetic diff collision', i => ({ ...i, evidence: [...i.evidence, { evidenceRef: 'collision', kind: 'source', source: { ...firstSource(i), path: 'review/diff.patch' } }] })],
  ['unknown input field', i => ({ ...i, ownerCapability: 'not authority' })],
  ['invalid profile bound', i => ({ ...i, profile: { ...i.profile, maxContextBytes: 0 } })],
  ['missing source inventory', i => ({ ...i, requiredSourcePaths: undefined })],
  ['duplicate source inventory', i => ({ ...i, requiredSourcePaths: ['src/calculator.py', 'src/calculator.py'] })],
  ['protected source inventory', i => ({ ...i, requiredSourcePaths: ['.env'] })],
  ['context byte limit', i => ({ ...i, profile: { ...i.profile, maxContextBytes: 1 } })],
  ['excerpt byte limit', i => ({ ...i, profile: { ...i.profile, maxEvidenceBytes: 1 } })],
];

function firstSource(i: ReviewContextInputs) {
  const entry = i.evidence[0];
  assert.ok(entry);
  return entry.source;
}

for (const [name, transform] of refusalCases) {
  test(`refuses ${name}`, () => {
    const inputs = createReviewContextFixture();
    const before = hash(inputs);
    const result = prepareReviewContext(transform(inputs));
    assert.equal(result.status, 'blocked');
    assert.equal(hash(inputs), before, 'host records remain unchanged');
  });
}

test('keeps exact owner references, canonical criteria, original baseline and detached immutable output', () => {
  const i = createReviewContextFixture();
  const result = prepareReviewContext(i);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.context.verification.baselineRef, i.baseline.acknowledgement.evidenceId);
  assert.equal(i.baseline.content.repositorySnapshotDigest, i.task.initialRevisionDigest);
  assert.notEqual(i.task.initialRevisionDigest, i.repository.headRevisionDigest);
  assert.equal(i.baseline.content.criteriaDigest, hash(i.task.acceptanceCriteria));
  assert.equal(result.context.verification.results[0]?.evidenceId, i.verificationResults[0]?.evidenceId);
  assert.equal(result.context.evidence[0]?.evidenceRef, i.evidence[0]?.evidenceRef);
  const excerpt = result.evidence[0];
  assert.ok(excerpt);
  assert.equal(Object.isFrozen(excerpt), true);
  assert.throws(() => Object.assign(excerpt, { boundedExcerpt: 'mutated' }), TypeError);
  Object.assign(firstSource(i), { boundedExcerpt: 'host changed after preparation' });
  assert.equal(result.evidence[0]?.boundedExcerpt, 'new');
  assert.equal(Object.isFrozen(firstSource(i)), false);
});

test('refuses unsupported owner URI instead of silently relabeling it', () => {
  const i = createReviewContextFixture();
  const result = prepareReviewContext({ ...i, baseline: { ...i.baseline, acknowledgement: { ...i.baseline.acknowledgement, evidenceId: 'uc04://baseline/private' } } });
  assert.equal(result.status, 'blocked');
});

test('does not invoke getters or owner/model capabilities', () => {
  let calls = 0;
  const hostile = {
    get task() {
      calls++;
      throw new Error('must not invoke');
    },
  };
  assert.equal(prepareReviewContext(hostile).status, 'blocked');
  assert.equal(calls, 0);
  const i = createReviewContextFixture();
  assert.equal(
    prepareReviewContext({
      ...i,
      model: () => {
        calls++;
      },
    }).status,
    'blocked',
  );
  assert.equal(calls, 0);
});

test('requires distinct post-patch approval', () => {
  const i = createReviewContextFixture();
  const decisionId = i.ancestry.originalTaskState.plan?.decisionRef;
  assert.ok(decisionId && i.state.plan);
  const state = { ...i.state, plan: { ...i.state.plan, decisionRef: decisionId }, activeDecisionId: decisionId };
  const context = createVerificationApprovalContext(i.task, state, i.authoritySnapshot.policyIdentity, i.authoritySnapshot.decisionAuthorityGeneration, decisionId);
  assert.ok(context);
  assert.equal(prepareReviewContext({ ...i, state, currentApproval: approval(context, decisionId) }).status, 'blocked', 'D0 cannot substitute for D1');
});

test('accepts explicit empty convention policy and exact acknowledged check summaries', () => {
  const i = createReviewContextFixture();
  const result = prepareReviewContext({
    ...i,
    profile: { ...i.profile, requiredConventionPaths: [], optionalEvidenceRefs: ['optional-requirement'] },
    evidence: i.evidence.filter(e => e.kind !== 'convention'),
    acknowledgedChecks: i.task.requiredChecks.map(c => ({ checkId: c.checkId, outcome: 'pass', repositoryRevisionDigest: i.repository.headRevisionDigest, diffDigest: i.repository.diffDigest })),
  });
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.deepEqual(result.context.conventions, []);
});

test('accepts ordinary task-independent text and produces deterministic detached context', () => {
  const i = createReviewContextFixture();
  const inputs = { ...i, evidence: i.evidence.map(e => (e.kind === 'source' ? { ...e, source: { ...e.source, boundedExcerpt: 'task-independent' } } : e)) };
  const first = prepareReviewContext(inputs),
    second = prepareReviewContext(inputs);
  assert.equal(first.status, 'ready');
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
});

test('accepts deletion using the exact diff without fabricating a deleted file at head', () => {
  const i = createReviewContextFixture({ diff: '--- a/src/calculator.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n', requiredSourcePaths: [] });
  const result = prepareReviewContext({ ...i, evidence: i.evidence.filter(e => e.kind !== 'source') });
  assert.equal(result.status, 'ready', JSON.stringify(result));
  if (result.status !== 'ready') return;
  assert.equal(result.context.binding.diffDigest, hash(i.repository.diff));
  assert.equal(
    result.evidence.some(e => e.path === 'src/calculator.py'),
    false,
  );
});

test('refuses missing optional owner task snapshots and malformed source before hashing', () => {
  const i = createReviewContextFixture();
  for (const malformed of [
    { ...i, state: { ...i.state, taskContext: undefined } },
    { ...i, ancestry: { ...i.ancestry, originalTaskState: { ...i.ancestry.originalTaskState, taskContext: undefined } } },
    { ...i, evidence: i.evidence.map(e => ({ ...e, source: { ...e.source, boundedExcerpt: undefined } })) },
    { ...i, evidence: i.evidence.map(e => (e.kind === 'convention' ? { ...e, source: { ...e.source, boundedExcerpt: undefined } } : e)) },
  ])
    assert.doesNotThrow(() => assert.equal(prepareReviewContext(malformed).status, 'blocked'));
});
