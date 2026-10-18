import assert from 'node:assert/strict';
import test from 'node:test';
import { IssueAssessor, type AssessmentPorts } from '../../../src/uc01/assess.ts';
import { fixtureLimits, validateOutcome, type Proposal, type TrustedContext, type Usage } from '../../../src/uc01/contracts.ts';
import { UC01_PUBLIC_CASES, publicEvidenceForCase, trustedCatalogForCase } from '../support/uc01/fixtures.ts';
import { operationContextDigest, ScriptedUc01Ports, UC01_FIXTURE_PROFILE, type OperationContext, type ModelRequest } from '../support/uc01/ports.ts';

function scenario(caseId = 'UC-01:C02:all-users-locked-out') {
  const selected = UC01_PUBLIC_CASES.find(entry => entry.caseId === caseId);
  assert.ok(selected);
  const invocation = selected.input.invocation;
  const context: TrustedContext = { taskId: invocation.taskId, runId: invocation.runId, repositoryId: invocation.repositoryId,
    workspaceId: 'workspace', repositorySnapshotDigest: selected.input.repositorySnapshotDigest,
    configId: 'uc01-fixture-v1', configVersion: '1', policyId: selected.prerequisites.policyId, policyVersion: '1',
    catalog: trustedCatalogForCase(caseId), limits: fixtureLimits, accountingRef: 'account',
    evidenceRegistry: publicEvidenceForCase(caseId).filter(entry => entry.kind === 'reporter'), continuation: undefined };
  return { invocation, context };
}
function proposal(context: TrustedContext, classification = 'defect', severity: Proposal['severity']['value'] = 'P0'): Proposal {
  const id = context.evidenceRegistry[0]?.id;
  assert.ok(id);
  const dimension = (summary: string) => ({ summary, known: severity !== 'undetermined', evidenceIds: severity === 'undetermined' ? [] : [id] });
  return { classification: { value: classification, assertionIds: ['reported'] },
    severity: { value: severity, functionality: dimension('Reported affected function'), affectedUsers: dimension('Reported affected users'),
      workaround: dimension('Reported workaround viability'), assertionIds: ['reported'] },
    destination: { value: 'undetermined', assertionIds: ['route'] },
    assertions: [{ id: 'reported', text: 'Reporter claims the behavior in the supplied report.', basis: 'fact', evidenceIds: [id] },
      { id: 'route', text: 'Destination evaluation is unavailable in this initial assessment slice.', basis: 'unknown', evidenceIds: [] }],
    uncertainties: ['Reporter-only claims; no reproduction or diagnosis performed.'], evidenceIds: [id], questions: [] };
}
const usage: Usage = { inputTokens: 20, outputTokens: 10, totalTokens: 30, costUnits: 30, state: 'settled', reservationRef: 'reservation' };
function harness(value = scenario(), answer: unknown = { kind: 'assessment', proposal: proposal(value.context), usage }) {
  const calls: string[] = []; const requests: ModelRequest[] = []; const settlements: Usage[] = []; const bindings: OperationContext[] = [];
  const ports = {
    provenance: 'mock' as const,
    async guard(context: OperationContext): Promise<unknown> { calls.push('guard'); return { kind: 'admitted', admissionRef: `admission:${context.requestId}`, requestId: context.requestId, contextDigest: operationContextDigest(context) }; },
    async reserve(context: OperationContext): Promise<unknown> { calls.push('reserve'); return { kind: 'reserved', reservationRef: 'reservation', requestId: context.requestId }; },
    async settle(_context: OperationContext, _ref: string, observed: Usage): Promise<unknown> { calls.push('settle'); settlements.push(observed); return { kind: 'settled', accountingRef: 'account' }; },
    async proposeAssessment(_context: OperationContext, _admission: unknown, request: ModelRequest): Promise<unknown> { calls.push('model'); requests.push(request); return answer; },
    async readEvidence(): Promise<unknown> { calls.push('read'); return {}; },
    async searchEvidence(): Promise<unknown> { calls.push('search'); return {}; },
    async bindContinuation(context: OperationContext): Promise<unknown> { bindings.push(context); calls.push('bind'); return { kind: 'bound', continuationRef: 'continuation' }; },
    async emitSafeEvent(): Promise<unknown> { calls.push('event'); return { eventRef: 'safe-event' }; },
  };
  const options = { ports, now: () => 100, profileId: 'uc01-fixture-v1' as const, ceiling: { inputTokens: 500, outputTokens: 250, totalTokens: 750, costUnits: 750, pricingId: 'uc01-fixture-token-units-v1' },
    excerpts: { resolveExcerpt: (entry: { sourceRef: string }) => entry.sourceRef === value.invocation.issue.id ? value.invocation.issue.originalReport
      : value.invocation.suppliedEvidence.find(item => item.sourceRef === entry.sourceRef)?.content } };
  return { value, calls, requests, settlements, bindings, ports, options };
}

test('C02 preserves original issue and returns reporter-backed P0 after guarded reserved assessment', async () => {
  const h = harness();
  const result = await new IssueAssessor(h.options).assessIssue(h.value.invocation, h.value.context);
  assert.equal(result.status, 'assessed');
  if (result.status === 'assessed') {
    assert.equal(result.assessment.classification.value, 'defect');
    assert.equal(result.assessment.severity.value, 'P0');
    assert.equal(result.assessment.reportDigest, h.value.invocation.issue.reportDigest);
  }
  assert.deepEqual(h.requests[0]?.invocation, h.value.invocation);
  assert.deepEqual(h.calls, ['guard', 'reserve', 'model', 'settle', 'event']);
  assert.deepEqual(h.settlements, [usage]);
});

test('C14 forged citations reject assessment while settling actual billable usage', async () => {
  const value = scenario(); const candidate = proposal(value.context);
  const h = harness(value, { kind: 'assessment', proposal: { ...candidate, evidenceIds: ['invented'] }, usage });
  const result = await new IssueAssessor(h.options).assessIssue(value.invocation, value.context);
  assert.equal(result.status, 'error');
  assert.deepEqual(h.settlements, [usage]);
});

test('C06 material impact unknowns require trusted continuation before needs-info', async () => {
  const value = scenario('UC-01:C06:all-broken-development');
  const candidate = { ...proposal(value.context, 'undetermined', 'undetermined'), questions: [
    { id: 'impact', text: 'Which workflow and users are affected, and is a workaround available?', affects: ['scope' as const, 'severity' as const], reason: 'These missing facts change the severity threshold.' },
  ] };
  const h = harness(value, { kind: 'assessment', proposal: candidate, usage });
  const result = await new IssueAssessor(h.options).assessIssue(value.invocation, value.context);
  assert.equal(result.status, 'needs-info');
  if (result.status === 'needs-info') assert.equal(result.continuationRef, 'continuation');
  assert.deepEqual(h.calls, ['guard', 'reserve', 'model', 'settle', 'bind', 'event']);
});

test('C01 actual guarded read registers verified repository evidence without promoting reporter content', async () => {
  const h = harness(); const excerpt = 'All account requests are rejected by the sign-in handler.';
  const location = { repositoryId: h.value.context.repositoryId, snapshotDigest: h.value.context.repositorySnapshotDigest,
    path: 'src/auth.ts', fileDigest: 'b'.repeat(64), startLine: 2, endLine: 2 };
  h.options.excerpts.resolveExcerpt = entry => 'safeExcerptRef' in entry && entry.safeExcerptRef === 'source-excerpt' ? excerpt : h.value.invocation.issue.originalReport;
  h.ports.readEvidence = async () => { h.calls.push('read'); return { kind: 'read', finding: { source: { path: 'src/auth.ts',
    revisionDigest: h.value.context.repositorySnapshotDigest, boundedExcerpt: excerpt, resultCount: 1, truncated: false },
    location, safeExcerptRef: 'source-excerpt', provenance: 'mock' } }; };
  h.ports.proposeAssessment = async (_ctx, _admission, request) => {
    h.calls.push('model'); h.requests.push(request);
    if (h.requests.length === 1) return { kind: 'tool-request', request: { kind: 'read', path: 'src/auth.ts' }, usage };
    const finding = request.evidence.find(entry => entry.evidence.kind === 'repository'); assert.ok(finding);
    const candidate = proposal(h.value.context);
    return { kind: 'assessment', proposal: { ...candidate, assertions: [...candidate.assertions,
      { id: 'inspected', text: 'Inspected source rejects account requests.', basis: 'fact', evidenceIds: [finding.evidence.id] }],
      evidenceIds: [...candidate.evidenceIds, finding.evidence.id] }, usage };
  };
  const result = await new IssueAssessor(h.options).assessIssue(h.value.invocation, h.value.context);
  assert.equal(result.status, 'assessed');
  const retrieved = h.requests[1]?.evidence.find(entry => entry.evidence.kind === 'repository');
  assert.deepEqual(retrieved?.evidence.repository, location);
  assert.equal(retrieved?.boundedExcerpt, excerpt);
  assert.equal(h.requests[1]?.evidence[0]?.evidence.kind, 'reporter');
  assert.deepEqual(h.calls, ['guard', 'reserve', 'model', 'settle', 'guard', 'read', 'guard', 'reserve', 'model', 'settle', 'event']);
});


for (const [caseId, classification, severity] of [
  ['UC-01:C01:clear-defect', 'defect', 'P0'], ['UC-01:C03:team-export-blocked', 'defect', 'P1'],
  ['UC-01:C04:conversion-workaround', 'defect', 'P2'], ['UC-01:C05:cosmetic-spacing', 'defect', 'P3'],
  ['UC-01:C07:feature-request', 'feature-request', 'undetermined'], ['UC-01:C08:irrelevant', 'undetermined', 'undetermined'],
  ['UC-01:C08:reporter-only-limited-impairment', 'defect', 'P2'], ['UC-01:C15:malicious', 'undetermined', 'undetermined'],
] as const) {
  test(`${caseId} validates controlled classification/severity and reporter provenance`, async () => {
    const value = scenario(caseId); const h = harness(value, { kind: 'assessment', proposal: proposal(value.context, classification, severity), usage });
    const result = await new IssueAssessor(h.options).assessIssue(value.invocation, value.context);
    assert.equal(result.status, 'assessed');
    if (result.status === 'assessed') {
      assert.equal(result.assessment.classification.value, classification); assert.equal(result.assessment.severity.value, severity);
      assert.equal(result.assessment.provenance, 'mock'); assert.equal(result.assessment.destination.value, 'undetermined');
      assert.ok(result.assessment.uncertainties.includes('Reporter-only claims; no reproduction or diagnosis performed.'));
    }
    assert.equal(h.requests.length, 1); assert.equal(h.requests[0]?.evidence[0]?.evidence.kind, 'reporter');
    assert.equal(h.calls.includes('read'), false); assert.equal(h.calls.includes('search'), false);
  });
}

test('C13/C15/C22 malformed, protected, foreign and oversized intake makes zero constrained calls', async () => {
  for (const change of [
    (v: ReturnType<typeof scenario>) => ({ input: { ...v.invocation, repositoryId: 'foreign' }, context: v.context }),
    (v: ReturnType<typeof scenario>) => ({ input: { ...v.invocation, issues: [v.invocation.issue] }, context: v.context }),
    (v: ReturnType<typeof scenario>) => ({ input: { ...v.invocation, issue: { ...v.invocation.issue, originalReport: 'x'.repeat(20000) } }, context: v.context }),
    (v: ReturnType<typeof scenario>) => ({ input: v.invocation, context: { ...v.context, limits: { ...fixtureLimits, modelCalls: Infinity } } }),
    (v: ReturnType<typeof scenario>) => ({ input: v.invocation, context: { ...v.context, catalog: { ...v.context.catalog, destinations: [
      { id: 'resume', responsibility: 'UC04 recovery', acceptsClassificationIds: ['defect'] },
    ] } } }),
  ]) {
    const h = harness(); const altered = change(h.value);
    const result = await new IssueAssessor(h.options).assessIssue(altered.input, altered.context);
    assert.equal(result.status, 'invalid-input'); assert.deepEqual(h.calls, ['event']);
  }
});

for (const status of ['denied', 'pending-approval', 'conflict', 'exhausted'] as const) {
  test(`C19 ${status} guard authorizes no provider or tool call`, async () => {
    const h = harness(); h.ports.guard = async () => { h.calls.push('guard'); return { kind: 'failure', status, reasonCode: 'policy-blocked', eventRef: 'policy-event' }; };
    const result = await new IssueAssessor(h.options).assessIssue(h.value.invocation, h.value.context);
    assert.equal(result.status, status); assert.deepEqual(h.calls, ['guard', 'event']);
  });
}

test('C17 missing, wrong-bound, over-ceiling, inconsistent and uncertain usage retains full ceiling without retry', async () => {
  for (const observed of [undefined, { ...usage, reservationRef: 'foreign' }, { ...usage, inputTokens: 501, totalTokens: 511, costUnits: 511 },
    { ...usage, totalTokens: 31 }, { ...usage, state: 'uncertain' }]) {
    const value = scenario(); const h = harness(value, { kind: 'assessment', proposal: proposal(value.context), ...(observed ? { usage: observed } : {}) });
    const result = await new IssueAssessor(h.options).assessIssue(value.invocation, value.context);
    assert.equal(result.status, 'uncertain'); assert.equal(h.requests.length, 1);
    assert.deepEqual(h.settlements, [{ inputTokens: 500, outputTokens: 250, totalTokens: 750, costUnits: 750, state: 'uncertain', reservationRef: 'reservation' }]);
  }
});

test('C14 unknown tools, forged facts, unknown enums and extra model fields are rejected after settlement', async () => {
  const value = scenario(); const candidate = proposal(value.context);
  for (const answer of [
    { kind: 'tool-request', request: { kind: 'execute', command: 'whoami' }, usage },
    { kind: 'assessment', proposal: { ...candidate, rewrittenReport: 'rewritten' }, usage },
    { kind: 'assessment', proposal: { ...candidate, classification: { ...candidate.classification, value: 'foreign' } }, usage },
    { kind: 'assessment', proposal: { ...candidate, assertions: [{ id: 'reported', text: 'Invented observation', basis: 'fact', evidenceIds: ['forged'] }] }, usage },
  ]) {
    const h = harness(value, answer); const result = await new IssueAssessor(h.options).assessIssue(value.invocation, value.context);
    assert.equal(result.status, 'error'); assert.deepEqual(h.settlements, [usage]); assert.equal(h.calls.includes('read'), false);
  }
});

test('C16 tool-request turns stop at the finite model-call ceiling', async () => {
  const h = harness(undefined, { kind: 'tool-request', request: { kind: 'search', query: 'workflow' }, usage });
  h.ports.searchEvidence = async () => { h.calls.push('search'); return { kind: 'search', findings: [], truncated: false }; };
  const result = await new IssueAssessor(h.options).assessIssue(h.value.invocation, h.value.context);
  assert.equal(result.status, 'exhausted'); assert.equal(h.requests.length, 4); assert.equal(h.calls.filter(call => call === 'search').length, 4);
});

test('C16 model-visible catalog and admitted evidence count toward aggregate input bytes before guard', async () => {
  const h = harness(); const context = { ...h.value.context, catalog: { ...h.value.context.catalog,
    classifications: [{ id: 'defect', definition: 'A'.repeat(16300), impairmentAssessment: true }], destinations: [] } };
  const result = await new IssueAssessor(h.options).assessIssue(h.value.invocation, context);
  assert.equal(result.status, 'exhausted'); assert.deepEqual(h.calls, ['event']);
});

test('C15 resolver digest mismatch and protected excerpt are rejected before model use', async () => {
  for (const excerpt of ['unbound source bytes', 'api_key="sk-protected-0123456789"']) {
    const h = harness(); h.options.excerpts.resolveExcerpt = () => excerpt;
    const result = await new IssueAssessor(h.options).assessIssue(h.value.invocation, h.value.context);
    assert.equal(result.status, 'invalid-input'); assert.deepEqual(h.calls, ['event']);
  }
});

test('C16 expired admission makes no reserve or provider call', async () => {
  const h = harness(); let time = 100;
  h.options.now = () => time;
  h.ports.guard = async context => { h.calls.push('guard'); time = context.deadlineEpochMs; return { kind: 'admitted', admissionRef: 'stale', requestId: context.requestId, contextDigest: operationContextDigest(context) }; };
  const result = await new IssueAssessor(h.options).assessIssue(h.value.invocation, h.value.context);
  assert.equal(result.status, 'timeout'); assert.deepEqual(h.calls, ['guard', 'event']);
});

test('C08 empty or truncated search remains explicit uncertainty rather than proof of absence', async () => {
  const h = harness();
  h.ports.searchEvidence = async () => { h.calls.push('search'); return { kind: 'search', findings: [], truncated: true }; };
  h.ports.proposeAssessment = async (_ctx, _admission, request) => {
    h.calls.push('model'); h.requests.push(request);
    return h.requests.length === 1 ? { kind: 'tool-request', request: { kind: 'search', query: 'exports' }, usage }
      : { kind: 'assessment', proposal: proposal(h.value.context), usage };
  };
  const result = await new IssueAssessor(h.options).assessIssue(h.value.invocation, h.value.context);
  assert.equal(result.status, 'assessed');
  if (result.status === 'assessed') assert.ok(result.assessment.uncertainties.includes('Search was empty or truncated; it cannot establish absence.'));
});

test('C01 approved ScriptedUc01Ports consumer remains structurally and behaviorally compatible', async () => {
  const h = harness(); let shared: ScriptedUc01Ports;
  const ports: AssessmentPorts = {
    provenance: 'mock',
    async guard(context, action) {
      shared = new ScriptedUc01Ports({ taskId: context.taskId, profile: UC01_FIXTURE_PROFILE, now: h.options.now,
        responses: { guard: [{ kind: 'admitted', admissionRef: 'receipt', requestId: context.requestId, contextDigest: operationContextDigest(context) }],
          reserve: [{ kind: 'reserved', reservationRef: 'reservation', requestId: context.requestId }],
          model: [{ kind: 'assessment', proposal: proposal(h.value.context), usage }], settle: [{ kind: 'settled', accountingRef: 'account' }] } });
      return shared.guard(context, action);
    },
    reserve: (context, admission, ceiling) => shared.reserve(context, admission, ceiling),
    settle: (context, ref, observed) => shared.settle(context, ref, observed),
    proposeAssessment: (context, admission, request) => shared.proposeAssessment(context, admission, request),
    readEvidence: (context, admission, path) => shared.readEvidence(context, admission, path),
    searchEvidence: (context, admission, query) => shared.searchEvidence(context, admission, query),
    bindContinuation: (context, assessment) => shared.bindContinuation(context, assessment),
    emitSafeEvent: event => shared.emitSafeEvent(event),
  };
  const result = await new IssueAssessor({ ...h.options, ports }).assessIssue(h.value.invocation, h.value.context);
  assert.equal(result.status, 'assessed');
  const snapshot = () => shared.calls.snapshot();
  assert.deepEqual(snapshot().dispatches, { model: 1, read: 0, search: 0 });
  assert.equal(snapshot().taskUsage.totalTokens, 30);
});

test('C17 hanging shared operations terminate and provider dispatch uncertainty retains the reservation', async () => {
  await Promise.all(['guard', 'model', 'settle', 'bind', 'event'].map(async stage => {
    const value = scenario(); const candidate = { ...proposal(value.context), questions: stage === 'bind' ? [
      { id: 'scope', text: 'Which workflow is affected?', affects: ['scope' as const], reason: 'The affected workflow is material.' },
    ] : [] };
    const h = harness(value, { kind: 'assessment', proposal: candidate, usage });
    const hang = (): Promise<unknown> => new Promise(() => undefined);
    if (stage === 'guard') h.ports.guard = hang;
    if (stage === 'model') h.ports.proposeAssessment = hang;
    if (stage === 'settle') h.ports.settle = hang;
    if (stage === 'bind') h.ports.bindContinuation = hang;
    if (stage === 'event') h.ports.emitSafeEvent = hang;
    const result = await new IssueAssessor(h.options).assessIssue(value.invocation, value.context);
    assert.equal(result.status, stage === 'model' || stage === 'settle' ? 'uncertain' : stage === 'event' ? 'error' : 'timeout', stage);
    if (stage === 'model') assert.deepEqual(h.settlements, [{ inputTokens: 500, outputTokens: 250, totalTokens: 750,
      costUnits: 750, state: 'uncertain', reservationRef: 'reservation' }]);
    assert.ok(h.requests.length <= 1);
  }));
});

test('C14 all shared receipts are runtime checked before the next affected call', async () => {
  for (const stage of ['guard', 'reserve', 'settle', 'event'] as const) {
    const h = harness();
    if (stage === 'guard') h.ports.guard = async () => ({ kind: 'admitted', admissionRef: 'receipt', requestId: 'foreign', contextDigest: 'a'.repeat(64) });
    if (stage === 'reserve') h.ports.reserve = async () => ({ kind: 'reserved', reservationRef: 'reservation', requestId: 'foreign' });
    if (stage === 'settle') h.ports.settle = async () => ({ kind: 'settled', accountingRef: 'foreign' });
    if (stage === 'event') h.ports.emitSafeEvent = async () => ({ eventRef: 'event', source: 'must-not-leak' });
    const result = await new IssueAssessor(h.options).assessIssue(h.value.invocation, h.value.context);
    assert.ok(['conflict', 'uncertain', 'error'].includes(result.status));
    if (stage === 'guard' || stage === 'reserve') assert.equal(h.requests.length, 0);
  }
});

test('C06 continuation bind failure and excessive questions never produce an assessed result', async () => {
  for (const excessive of [false, true]) {
    const h = harness(); const candidate = { ...proposal(h.value.context), questions: Array.from({ length: excessive ? 5 : 1 }, (_, index) => ({
      id: `question-${index}`, text: 'Which users are affected?', affects: ['scope' as const], reason: 'Affected scope changes severity.',
    })) };
    h.ports.proposeAssessment = async () => ({ kind: 'assessment', proposal: candidate, usage });
    h.ports.bindContinuation = async () => { h.calls.push('bind'); return {}; };
    const result = await new IssueAssessor(h.options).assessIssue(h.value.invocation, h.value.context);
    assert.equal(result.status, 'error'); assert.equal(h.calls.includes('bind'), !excessive);
  }
});

test('C15 source resolution checks exact excerpt and independently bound locator before next model', async () => {
  const h = harness(undefined, { kind: 'tool-request', request: { kind: 'read', path: 'src/safe.ts' }, usage });
  h.ports.readEvidence = async () => ({ kind: 'read', finding: { source: { path: 'src/safe.ts', revisionDigest: h.value.context.repositorySnapshotDigest,
    boundedExcerpt: 'safe', resultCount: 1, truncated: false }, location: { repositoryId: h.value.context.repositoryId,
    snapshotDigest: h.value.context.repositorySnapshotDigest, path: 'src/forged.ts', fileDigest: 'b'.repeat(64), startLine: 1, endLine: 1 },
    safeExcerptRef: 'forged', provenance: 'mock' } });
  const result = await new IssueAssessor(h.options).assessIssue(h.value.invocation, h.value.context);
  assert.equal(result.status, 'conflict'); assert.equal(h.requests.length, 1);
});

test('C14 explicitly unknown impact forbids a determined severity and feature urgency never permits P0', async () => {
  for (const candidate of [
    { ...proposal(scenario().context), severity: { ...proposal(scenario().context).severity,
      workaround: { summary: 'Workaround viability is unknown.', known: false, evidenceIds: [] } } },
    proposal(scenario().context, 'feature-request', 'P0'),
  ]) {
    const h = harness(undefined, { kind: 'assessment', proposal: candidate, usage });
    const result = await new IssueAssessor(h.options).assessIssue(h.value.invocation, h.value.context);
    assert.equal(result.status, 'error'); assert.deepEqual(h.settlements, [usage]);
  }
});

test('C17 malformed settlement acknowledgment remains accounting uncertainty', async () => {
  const h = harness(); h.ports.settle = async () => ({ kind: 'settled', accountingRef: 'account', extra: true });
  const result = await new IssueAssessor(h.options).assessIssue(h.value.invocation, h.value.context);
  assert.equal(result.status, 'uncertain'); assert.equal(h.requests.length, 1);
});

test('C22 final telemetry reference cannot overflow the accepted outcome bound', async () => {
  for (const length of [5000, 5500, 6000, 6500]) {
    const h = harness(); h.ports.proposeAssessment = async () => ({ kind: 'assessment',
      proposal: { ...proposal(h.value.context), uncertainties: ['x'.repeat(length)] }, usage });
    h.ports.emitSafeEvent = async () => ({ eventRef: 'e'.repeat(512) });
    const result = await new IssueAssessor(h.options).assessIssue(h.value.invocation, h.value.context);
    assert.equal(validateOutcome(result, h.value.invocation, h.value.context).ok, true);
  }
});

test('C14 non-string shared failure status is rejected without invoking coercion', async () => {
  const h = harness(); let coerced = false;
  h.ports.guard = async () => ({ kind: 'failure', status: { toString() { coerced = true; return 'denied'; } }, reasonCode: 'denied', eventRef: 'event' });
  const result = await new IssueAssessor(h.options).assessIssue(h.value.invocation, h.value.context);
  assert.equal(result.status, 'error'); assert.equal(coerced, false); assert.equal(h.requests.length, 0);
});

test('C06 continuation binding receives a fresh call deadline within the remaining invocation allowance', async () => {
  const value = scenario(); const candidate = { ...proposal(value.context), questions: [
    { id: 'users', text: 'Which users are affected?', affects: ['scope' as const], reason: 'Affected users can change severity.' },
  ] };
  const h = harness(value, { kind: 'assessment', proposal: candidate, usage }); let time = 100;
  h.options.now = () => time;
  h.ports.settle = async () => { h.calls.push('settle'); time = 1200; return { kind: 'settled', accountingRef: 'account' }; };
  const result = await new IssueAssessor(h.options).assessIssue(value.invocation, value.context);
  assert.equal(result.status, 'needs-info'); assert.equal(h.bindings[0]?.deadlineEpochMs, 2200);
});

test('C15 model-proposed protected path metadata never enters caller output', async () => {
  const value = scenario(); const candidate = proposal(value.context);
  const h = harness(value, { kind: 'assessment', proposal: { ...candidate, uncertainties: ['.env'] }, usage });
  const result = await new IssueAssessor(h.options).assessIssue(value.invocation, value.context);
  assert.equal(result.status, 'error'); assert.deepEqual(h.settlements, [usage]);
});

for (const completedAt of [10100, 10101]) {
  test(`C16 settled assessment at invocation deadline ${completedAt} returns timeout without losing usage`, async () => {
    const h = harness(); let time = 100; h.options.now = () => time;
    h.ports.settle = async (_context, _ref, observed) => { h.calls.push('settle'); h.settlements.push(observed); time = completedAt;
      return { kind: 'settled', accountingRef: 'account' }; };
    const result = await new IssueAssessor(h.options).assessIssue(h.value.invocation, h.value.context);
    assert.equal(result.status, 'timeout'); assert.deepEqual(h.settlements, [usage]);
    assert.equal(h.requests.length, 1); assert.equal(h.bindings.length, 0);
  });
}

test('C16 telemetry crossing the invocation deadline cannot publish assessed or needs-info success', async () => {
  for (const needsInfo of [false, true]) {
    const value = scenario(); const candidate = { ...proposal(value.context), questions: needsInfo ? [
      { id: 'users', text: 'Which users are affected?', affects: ['scope' as const], reason: 'Affected users can change severity.' },
    ] : [] };
    const h = harness(value, { kind: 'assessment', proposal: candidate, usage }); let time = 100;
    h.options.now = () => time;
    h.ports.emitSafeEvent = async () => { time = 10101; return { eventRef: 'safe-event' }; };
    const result = await new IssueAssessor(h.options).assessIssue(value.invocation, value.context);
    assert.equal(result.status, 'timeout'); assert.deepEqual(h.settlements, [usage]); assert.equal(h.requests.length, 1);
  }
});

test('C16 binding reaching the invocation deadline returns timeout after actual usage is settled', async () => {
  const value = scenario(); const candidate = { ...proposal(value.context), questions: [
    { id: 'users', text: 'Which users are affected?', affects: ['scope' as const], reason: 'Affected users can change severity.' },
  ] };
  const h = harness(value, { kind: 'assessment', proposal: candidate, usage }); let time = 100;
  h.options.now = () => time;
  h.ports.bindContinuation = async () => { time = 10100; return { kind: 'bound', continuationRef: 'continuation' }; };
  const result = await new IssueAssessor(h.options).assessIssue(value.invocation, value.context);
  assert.equal(result.status, 'timeout'); assert.deepEqual(h.settlements, [usage]);
});

test('C17 usage or accounting uncertainty remains authoritative after invocation expiry', async () => {
  for (const uncertainUsage of [false, true]) {
    const value = scenario(); const h = harness(value, { kind: 'assessment', proposal: proposal(value.context),
      usage: uncertainUsage ? { ...usage, state: 'uncertain' } : usage }); let time = 100;
    h.options.now = () => time;
    h.ports.settle = async (_context, _ref, observed) => { h.settlements.push(observed); time = 10101;
      return uncertainUsage ? { kind: 'settled', accountingRef: 'account' } : { kind: 'settled', accountingRef: 'foreign' }; };
    const result = await new IssueAssessor(h.options).assessIssue(value.invocation, value.context);
    assert.equal(result.status, 'uncertain'); assert.equal(h.requests.length, 1);
    assert.equal(h.settlements[0]?.totalTokens, uncertainUsage ? 750 : 30);
  }
});

test('C16 known settlement just inside the invocation allowance remains eligible for assessment', async () => {
  const h = harness(); let time = 100; h.options.now = () => time;
  h.ports.settle = async () => { time = 10099; return { kind: 'settled', accountingRef: 'account' }; };
  const result = await new IssueAssessor(h.options).assessIssue(h.value.invocation, h.value.context);
  assert.equal(result.status, 'assessed'); assert.equal(h.requests.length, 1);
});
