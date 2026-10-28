import assert from 'node:assert/strict';
import test from 'node:test';
import { IssueAssessor, type OperationContext } from '../../../src/uc01/assess.ts';
import { fixtureLimits, type Proposal, type TrustedContext, type Usage } from '../../../src/uc01/contracts.ts';
import { receiveUc01Assessment } from '../../../src/uc03/input.ts';
import { UC01_PUBLIC_CASES, publicEvidenceForCase, trustedCatalogForCase } from '../support/uc01/fixtures.ts';
import { operationContextDigest } from '../support/uc01/ports.ts';
import { createFixtureBugTask } from '../support/uc03/port-fixtures.ts';

const contractVersion = 'uc01-uc03-receiver-v1';
const receiverConfig = { destinationId: 'repair', defectClassificationIds: ['defect', 'incident'] };

function scenario() {
  const selected = UC01_PUBLIC_CASES.find(entry => entry.caseId === 'UC-01:C21:missing-reproduction');
  assert.ok(selected);
  const invocation = structuredClone(selected.input.invocation);
  const context: TrustedContext = {
    taskId: invocation.taskId, runId: invocation.runId, repositoryId: invocation.repositoryId,
    workspaceId: 'receiver-workspace', repositorySnapshotDigest: selected.input.repositorySnapshotDigest,
    configId: 'uc01-fixture-v1', configVersion: '1', policyId: selected.prerequisites.policyId, policyVersion: '1',
    catalog: trustedCatalogForCase(selected.caseId), limits: fixtureLimits, accountingRef: 'account',
    evidenceRegistry: publicEvidenceForCase(selected.caseId).filter(entry => entry.kind === 'reporter'), continuation: undefined,
  };
  return { invocation, context };
}

function proposal(context: TrustedContext): Proposal {
  const evidenceId = context.evidenceRegistry[0]?.id; assert.ok(evidenceId);
  const unknown = { summary: 'The impact has not been established.', known: false, evidenceIds: [] };
  return {
    classification: { value: 'defect', assertionIds: ['report'] },
    severity: { value: 'undetermined', functionality: unknown, affectedUsers: unknown, workaround: unknown, assertionIds: ['unknown'] },
    destination: { value: 'repair', assertionIds: ['fit'] },
    assertions: [
      { id: 'report', text: 'The supplied report describes an existing failure.', basis: 'fact', evidenceIds: [evidenceId] },
      { id: 'fit', text: 'The configured destination may investigate the reported failure.', basis: 'inference', evidenceIds: [evidenceId] },
      { id: 'unknown', text: 'Impact remains unknown.', basis: 'unknown', evidenceIds: [] },
    ],
    uncertainties: ['Reporter claims have not been reproduced.'], evidenceIds: [evidenceId], questions: [],
  };
}

async function assessment(prepare?: (context: TrustedContext, value: Proposal) => { context: TrustedContext; value: Proposal }) {
  const selected = scenario();
  const modified = prepare?.(selected.context, proposal(selected.context)) ?? { context: selected.context, value: proposal(selected.context) };
  const { context, value } = modified;
  const calls: string[] = [];
  const usage: Usage = { inputTokens: 20, outputTokens: 10, totalTokens: 30, costUnits: 30, state: 'settled', reservationRef: 'reservation' };
  const ports = {
    provenance: 'mock' as const,
    async guard(operation: OperationContext): Promise<unknown> { calls.push('guard'); return { kind: 'admitted', admissionRef: 'admission', requestId: operation.requestId, contextDigest: operationContextDigest(operation) }; },
    async reserve(operation: OperationContext): Promise<unknown> { calls.push('reserve'); return { kind: 'reserved', reservationRef: 'reservation', requestId: operation.requestId }; },
    async settle(): Promise<unknown> { calls.push('settle'); return { kind: 'settled', accountingRef: 'account' }; },
    async proposeAssessment(): Promise<unknown> { calls.push('model'); return { kind: 'assessment', proposal: value, usage }; },
    async readEvidence(): Promise<never> { throw new Error('No read requested'); },
    async searchEvidence(): Promise<never> { throw new Error('No search requested'); },
    async bindContinuation(): Promise<unknown> { calls.push('bind'); return { kind: 'bound', continuationRef: 'continuation' }; },
    async resolveContinuation(): Promise<never> { throw new Error('No continuation requested'); },
    async emitSafeEvent(): Promise<unknown> { calls.push('event'); return { eventRef: 'event' }; },
    async dispatch(): Promise<never> { calls.push('dispatch'); throw new Error('No dispatch authorized'); },
    async executeRepair(): Promise<never> { calls.push('repair'); throw new Error('No repair authorized'); },
  };
  const assessor = new IssueAssessor({ ports, now: () => 100, profileId: 'uc01-fixture-v1',
    ceiling: { inputTokens: 500, outputTokens: 250, totalTokens: 750, costUnits: 750, pricingId: 'uc01-fixture-token-units-v1' },
    excerpts: { resolveExcerpt: () => selected.invocation.issue.originalReport } });
  const outcome = await assessor.assessIssue(selected.invocation, context);
  const suppliedBugTask = createFixtureBugTask({ taskId: selected.invocation.taskId, repositoryId: context.repositoryId,
    initialRevisionDigest: 'sha256:' + context.repositorySnapshotDigest, configId: context.configId, configVersion: context.configVersion });
  return { input: { contractVersion, outcome, invocation: selected.invocation, context, suppliedBugTask, receiverConfig }, calls };
}

test('C21 actual UC01 assessment reaches UC03 receiver and requests missing reproduction and criteria without dispatch', async () => {
  const h = await assessment();
  assert.equal(h.input.outcome.status, 'assessed');
  const task: Record<string, unknown> = { ...h.input.suppliedBugTask };
  delete task['reproduction']; delete task['acceptanceCriteria'];
  const input = { ...h.input, suppliedBugTask: task };
  const before = structuredClone(input);
  const calls = [...h.calls];
  const result = receiveUc01Assessment(input);
  assert.equal(result.status, 'needs-info');
  if (result.status !== 'needs-info') assert.fail('Missing caller details must remain incomplete');
  assert.ok(result.fields.includes('reproduction'));
  assert.ok(result.fields.includes('acceptanceCriteria'));
  assert.equal('task' in result, false);
  assert.deepEqual(input, before);
  assert.deepEqual(h.calls, calls);
  assert.deepEqual(h.calls, ['guard', 'reserve', 'model', 'settle', 'event']);
});

test('C21 complete explicit caller task is accepted with separate mock source metadata and no authority', async () => {
  const h = await assessment();
  assert.equal(h.input.outcome.status, 'assessed');
  const before = structuredClone(h.input);
  const calls = [...h.calls];
  const result = receiveUc01Assessment(h.input);
  assert.equal(result.status, 'accepted');
  if (result.status !== 'accepted' || h.input.outcome.status !== 'assessed') assert.fail('Expected actual assessed receiver acceptance');
  assert.deepEqual(result.task, h.input.suppliedBugTask);
  assert.deepEqual(result.source, {
    contractVersion, assessmentId: h.input.outcome.assessment.assessmentId,
    issueId: h.input.invocation.issue.id, reportDigest: h.input.invocation.issue.reportDigest,
    catalogId: h.input.context.catalog.id, catalogVersion: h.input.context.catalog.version, provenance: 'mock',
  });
  assert.deepEqual(h.input, before);
  assert.deepEqual(h.calls, calls);
  assert.equal('approval' in result, false);
  assert.equal('state' in result, false);
});

test('C21 unresolved UC01 material questions remain needs-info even with a complete supplied task', async () => {
  const h = await assessment((context, value) => ({ context, value: { ...value,
    questions: [{ id: 'confirm-intent', text: 'Confirm intended behavior before repair.', affects: ['intent'], reason: 'The intended behavior is material.' }] } }));
  assert.equal(h.input.outcome.status, 'needs-info');
  if (h.input.outcome.status !== 'needs-info') assert.fail('Actual assessor must preserve material questions');
  const before = structuredClone(h.input); const calls = [...h.calls];
  assert.deepEqual(receiveUc01Assessment(h.input), { status: 'needs-info', fields: [],
    questionIds: h.input.outcome.assessment.questions.map(question => question.id) });
  assert.deepEqual(h.input, before); assert.deepEqual(h.calls, calls);
});

for (const [field, foreign] of [['taskId', 'foreign-task'], ['repositoryId', 'foreign-repository'],
  ['initialRevisionDigest', 'sha256:' + 'a'.repeat(64)], ['configId', 'foreign-config'], ['configVersion', 'foreign-version']] as const) {
  test('C21 rejects a complete task with mismatched ' + field + ' without effects', async () => {
    const h = await assessment(); const input = { ...h.input, suppliedBugTask: { ...h.input.suppliedBugTask, [field]: foreign } };
    const before = structuredClone(input); const calls = [...h.calls]; const result = receiveUc01Assessment(input);
    assert.deepEqual(result, { status: 'conflict', reasonCode: 'task-binding-mismatch', path: field });
    assert.equal('task' in result, false); assert.deepEqual(input, before); assert.deepEqual(h.calls, calls);
  });
}

test('C21 accepts equivalent bare SHA256 without rewriting caller revision and detaches nested task data', async () => {
  const h = await assessment(); const original = h.input.suppliedBugTask;
  const input = { ...h.input, suppliedBugTask: { ...original, initialRevisionDigest: h.input.context.repositorySnapshotDigest } };
  const result = receiveUc01Assessment(input); assert.equal(result.status, 'accepted');
  if (result.status !== 'accepted') assert.fail('Equivalent explicit revision must be accepted');
  assert.equal(result.task.initialRevisionDigest, h.input.context.repositorySnapshotDigest);
  assert.notEqual(result.task.requiredChecks, original.requiredChecks);
  assert.notEqual(result.task.requiredChecks[0]?.argv, original.requiredChecks[0]?.argv);
  assert.notEqual(result.task.limits, original.limits);
  const caller = original.acceptanceCriteria as string[];
  caller.push('Later caller mutation');
  assert.deepEqual(result.task.acceptanceCriteria, ['Calculator.divide raises CalculationError on zero denominator']);
});

test('C21 configured renamed defect and destination IDs work without hardcoded fixture labels', async () => {
  const h = await assessment((context, value) => ({
    context: { ...context, catalog: { ...context.catalog, id: 'custom-catalog', version: '2',
      classifications: [{ id: 'broken-behavior', definition: 'Existing function fails', impairmentAssessment: true }],
      destinations: [{ id: 'maintenance', responsibility: 'Maintain existing product behavior', acceptsClassificationIds: ['broken-behavior'] }] } },
    value: { ...value, classification: { ...value.classification, value: 'broken-behavior' }, destination: { ...value.destination, value: 'maintenance' } },
  }));
  assert.equal(h.input.outcome.status, 'assessed');
  const result = receiveUc01Assessment({ ...h.input, receiverConfig: { destinationId: 'maintenance', defectClassificationIds: ['broken-behavior'] } });
  assert.equal(result.status, 'accepted');
  if (result.status !== 'accepted') assert.fail('Configured receiver must accept its configured classification');
  assert.equal(result.source?.catalogId, 'custom-catalog'); assert.equal(result.source?.catalogVersion, '2');
  assert.equal(result.source?.provenance, 'mock');
});

test('C21 feature, another destination and undetermined recommendations are not executable repair requests', async () => {
  for (const [classification, destination, config] of [
    ['feature-request', 'triage', receiverConfig],
    ['incident', 'repair', { destinationId: 'repair', defectClassificationIds: ['defect'] }],
    ['undetermined', 'undetermined', receiverConfig],
  ] as const) {
    const h = await assessment((context, value) => ({ context, value: { ...value,
      classification: { ...value.classification, value: classification }, destination: { ...value.destination, value: destination } } }));
    assert.equal(h.input.outcome.status, 'assessed'); const calls = [...h.calls];
    const result = receiveUc01Assessment({ ...h.input, receiverConfig: config });
    assert.equal(result.status, 'not-applicable'); assert.equal('task' in result, false); assert.deepEqual(h.calls, calls);
  }
});

test('C21 malformed version, catalog configuration, source identity and revision fail safely', async () => {
  const h = await assessment(); const outcome = h.input.outcome;
  assert.equal(outcome.status, 'assessed'); if (outcome.status !== 'assessed') assert.fail('Expected assessed input');
  const cases: readonly unknown[] = [
    { ...h.input, contractVersion: 'uc01-uc03-receiver-v999' },
    { ...h.input, receiverConfig: { ...receiverConfig, defectClassificationIds: ['defect', 'defect'] } },
    { ...h.input, receiverConfig: { ...receiverConfig, defectClassificationIds: ['feature-request'] } },
    { ...h.input, receiverConfig: { ...receiverConfig, destinationId: 'unsupported' } },
    { ...h.input, receiverConfig: { ...receiverConfig, dispatch: true } },
    { ...h.input, invocation: { ...h.input.invocation, schemaVersion: 'unsupported' } },
    { ...h.input, outcome: { ...outcome, assessment: { ...outcome.assessment, issueId: 'foreign-issue' } } },
    { ...h.input, outcome: { ...outcome, assessment: { ...outcome.assessment, reportDigest: 'a'.repeat(64) } } },
    { ...h.input, outcome: { ...outcome, assessment: { ...outcome.assessment, repositorySnapshotDigest: 'a'.repeat(64) } } },
    { ...h.input, suppliedBugTask: { ...h.input.suppliedBugTask, initialRevisionDigest: 'not-a-digest' } },
  ];
  const calls = [...h.calls];
  for (const input of cases) {
    const before = structuredClone(input); const result = receiveUc01Assessment(input);
    assert.equal(result.status, 'invalid-input'); assert.equal('task' in result, false); assert.deepEqual(input, before);
  }
  assert.deepEqual(h.calls, calls);
});

test('C21 failure outcomes are not applicable and still validate invocation and trusted context', async () => {
  const h = await assessment(); const failure = { status: 'denied', reasonCode: 'policy-denied', safeMessage: 'Denied', nextAction: 'Stop', eventRef: 'event' };
  const input = { ...h.input, outcome: failure };
  assert.equal(receiveUc01Assessment(input).status, 'not-applicable');
  assert.equal(receiveUc01Assessment({ ...input, invocation: { ...input.invocation, repositoryId: 'foreign' } }).status, 'invalid-input');
});

test('C21 assessment alone never supplies reproduction, expectations, budgets or a generated task identity', async () => {
  const h = await assessment(); const result = receiveUc01Assessment({ ...h.input, suppliedBugTask: {} });
  assert.equal(result.status, 'needs-info'); if (result.status !== 'needs-info') assert.fail('Caller fields are required');
  for (const path of ['taskId', 'repositoryId', 'reproduction', 'expectedBehavior', 'acceptanceCriteria', 'requiredChecks', 'limits', 'budgetLimits']) assert.ok(result.fields.includes(path));
  assert.equal('task' in result, false);
});


test('C21 validates malformed supplied task before unresolved UC01 questions', async () => {
  const h = await assessment((context, value) => ({ context, value: { ...value,
    questions: [{ id: 'confirm-intent', text: 'Confirm intended behavior.', affects: ['intent'], reason: 'Intent is material.' }] } }));
  assert.equal(h.input.outcome.status, 'needs-info');
  const input = { ...h.input, suppliedBugTask: { ...h.input.suppliedBugTask, expectedBehavior: 42 } };
  const before = structuredClone(input); const calls = [...h.calls];
  assert.deepEqual(receiveUc01Assessment(input), { status: 'invalid-input', reasonCode: 'invalid-task', path: 'expectedBehavior' });
  assert.deepEqual(input, before); assert.deepEqual(h.calls, calls);
});


test('C21 rejects foreign task bindings before unresolved UC01 questions', async () => {
  const h = await assessment((context, value) => ({ context, value: { ...value,
    questions: [{ id: 'confirm-intent', text: 'Confirm intended behavior.', affects: ['intent'], reason: 'Intent is material.' }] } }));
  assert.equal(h.input.outcome.status, 'needs-info');
  const input = { ...h.input, suppliedBugTask: { ...h.input.suppliedBugTask, taskId: 'foreign-task' } };
  const before = structuredClone(input); const calls = [...h.calls];
  assert.deepEqual(receiveUc01Assessment(input), { status: 'conflict', reasonCode: 'task-binding-mismatch', path: 'taskId' });
  assert.deepEqual(input, before); assert.deepEqual(h.calls, calls);
});


test('C21 partial valid task retains missing fields alongside unresolved questions', async () => {
  const h = await assessment((context, value) => ({ context, value: { ...value,
    questions: [{ id: 'confirm-intent', text: 'Confirm intended behavior.', affects: ['intent'], reason: 'Intent is material.' }] } }));
  const input = { ...h.input, suppliedBugTask: { taskId: h.input.context.taskId } };
  const before = structuredClone(input); const calls = [...h.calls];
  const result = receiveUc01Assessment(input);
  assert.equal(result.status, 'needs-info');
  if (result.status !== 'needs-info') assert.fail('Both kinds of missing information must be preserved');
  assert.ok(result.fields.includes('reproduction')); assert.ok(result.fields.includes('expectedBehavior'));
  assert.deepEqual(result.questionIds, ['confirm-intent']); assert.equal('task' in result, false);
  assert.deepEqual(input, before); assert.deepEqual(h.calls, calls);
});


for (const source of ['needs-info', 'unsupported-route', 'failure'] as const) {
  test('C21 validates supplied tasks and present bindings before ' + source, async () => {
    const h = await assessment((context, value) => ({ context, value: source === 'needs-info' ? { ...value,
      questions: [{ id: 'confirm-intent', text: 'Confirm intended behavior.', affects: ['intent'], reason: 'Intent is material.' }] }
      : source === 'unsupported-route' ? { ...value, classification: { ...value.classification, value: 'feature-request' },
        destination: { ...value.destination, value: 'triage' } } : value }));
    const outcome = source === 'failure' ? { status: 'denied', reasonCode: 'policy-denied', safeMessage: 'Denied', nextAction: 'Stop', eventRef: 'event' } : h.input.outcome;
    const input = { ...h.input, outcome }; const calls = [...h.calls];
    for (const task of [{ ...input.suppliedBugTask, expectedBehavior: 42 }, { expectedBehavior: 42 }]) {
      const candidate = { ...input, suppliedBugTask: task }; const before = structuredClone(candidate);
      assert.deepEqual(receiveUc01Assessment(candidate), { status: 'invalid-input', reasonCode: 'invalid-task', path: 'expectedBehavior' });
      assert.deepEqual(candidate, before);
    }
    for (const [path, value] of [['taskId', 'foreign-task'], ['repositoryId', 'foreign-repository'], ['configId', 'foreign-config'],
      ['configVersion', 'foreign-version'], ['initialRevisionDigest', 'sha256:' + 'a'.repeat(64)]] as const) {
      for (const task of [{ ...input.suppliedBugTask, [path]: value }, { [path]: value }]) {
        const candidate = { ...input, suppliedBugTask: task }; const before = structuredClone(candidate);
        const result = receiveUc01Assessment(candidate);
        assert.deepEqual(result, { status: 'conflict', reasonCode: 'task-binding-mismatch', path });
        assert.equal('task' in result, false); assert.deepEqual(candidate, before);
      }
    }
    const invalidDigest = receiveUc01Assessment({ ...input, suppliedBugTask: { initialRevisionDigest: 'invalid-digest' } });
    assert.deepEqual(invalidDigest, { status: 'invalid-input', reasonCode: 'invalid-revision-digest', path: 'initialRevisionDigest' });
    assert.deepEqual(h.calls, calls);
  });
}
