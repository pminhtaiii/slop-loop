import assert from 'node:assert/strict';
import test from 'node:test';
import { projectRecommendation } from '../../../src/uc01/recommend.ts';
import { fixtureLimits, type Proposal, type TrustedContext } from '../../../src/uc01/contracts.ts';
import { UC01_PUBLIC_CASES, publicEvidenceForCase, trustedCatalogForCase } from '../support/uc01/fixtures.ts';

function scenario(caseId = 'UC-01:C02:all-users-locked-out'): TrustedContext {
  const selected = UC01_PUBLIC_CASES.find(entry => entry.caseId === caseId);
  assert.ok(selected);
  const input = selected.input.invocation;
  return { taskId: input.taskId, runId: input.runId, repositoryId: input.repositoryId, workspaceId: 'workspace',
    repositorySnapshotDigest: selected.input.repositorySnapshotDigest, configId: 'uc01-fixture-v1', configVersion: '1',
    policyId: selected.prerequisites.policyId, policyVersion: '1', catalog: trustedCatalogForCase(caseId),
    limits: fixtureLimits, accountingRef: 'account', evidenceRegistry: publicEvidenceForCase(caseId).filter(entry => entry.kind === 'reporter'),
    continuation: undefined };
}
function proposal(context: TrustedContext, classification = 'defect', destination = 'repair'): Proposal {
  const evidenceId = context.evidenceRegistry[0]?.id;
  assert.ok(evidenceId);
  const unknown = { summary: 'Impact dimension has not been established.', known: false, evidenceIds: [] };
  return { classification: { value: classification, assertionIds: ['reported'] },
    severity: { value: 'undetermined', functionality: unknown, affectedUsers: unknown, workaround: unknown, assertionIds: ['impact'] },
    destination: { value: destination, assertionIds: ['route'] },
    assertions: [{ id: 'reported', text: 'Reporter describes the supplied issue.', basis: 'fact', evidenceIds: [evidenceId] },
      { id: 'impact', text: 'Affected functionality, users and workaround remain unknown.', basis: 'unknown', evidenceIds: [] },
      { id: 'route', text: 'Inference: this report fits the selected destination.', basis: 'inference', evidenceIds: [evidenceId] }],
    uncertainties: ['Impact is not established.'], evidenceIds: [evidenceId], questions: [] };
}

test('C14 rejects a compatible route with no evidence-linked inference supporting responsibility fit', () => {
  const context = scenario();
  const candidate = proposal(context);
  const withoutFit = { ...candidate, assertions: candidate.assertions.map(assertion => assertion.id === 'route'
    ? { ...assertion, basis: 'unknown', evidenceIds: [] } : assertion) };
  assert.deepEqual(projectRecommendation(withoutFit, context), {
    ok: false, status: 'error', reasonCode: 'invalid-model-output', path: '$.destination',
  });
});

for (const [caseId, classification, destination, responsibility] of [
  ['UC-01:C02:all-users-locked-out', 'defect', 'repair', 'Repair an existing product defect'],
  ['UC-01:C07:feature-request', 'feature-request', 'triage', 'Review requests and questions'],
] as const) {
  test(`${caseId} accepts an evidence-linked fit and carries its configured responsibility without constructing a task`, () => {
    const context = scenario(caseId);
    const candidate = proposal(context, classification, destination);
    const before = structuredClone(candidate);
    const result = projectRecommendation(candidate, context);
    assert.ok(result.ok);
    assert.equal(result.value.destination.value, destination);
    assert.equal(result.value.severity.value, 'undetermined');
    assert.ok(result.value.assertions.find(assertion => assertion.id === 'route')?.text.includes(responsibility));
    assert.deepEqual(candidate, before);
    assert.deepEqual(Object.keys(result.value).sort(), ['assertions', 'classification', 'destination', 'evidenceIds', 'questions', 'severity', 'uncertainties']);
  });
}

test('C12 empty catalog retains undetermined recommendation with explicit routing uncertainty', () => {
  const context = scenario('UC-01:C12:empty-catalog');
  const result = projectRecommendation(proposal(context, 'undetermined', 'undetermined'), context);
  assert.ok(result.ok);
  assert.equal(result.value.destination.value, 'undetermined');
  assert.ok(result.value.uncertainties.some(text => text.includes('No configured destination')));
});

test('C12 indistinguishable responsibilities cannot become a selected destination and require a material question', () => {
  const context = scenario('UC-01:C12:overlapping-responsibilities');
  const candidate = proposal(context);
  const result = projectRecommendation(candidate, context);
  assert.ok(result.ok);
  assert.equal(result.value.destination.value, 'undetermined');
  assert.equal(result.value.questions.length, 1);
  assert.deepEqual(result.value.questions[0]?.affects, ['destination']);
  assert.ok(result.value.uncertainties.some(text => text.includes('distinguish')));
  assert.equal(result.value.classification.value, 'defect');
});

test('C12 a distinct supported responsibility may be selected from several compatible destinations', () => {
  const base = scenario();
  const context = { ...base, catalog: { ...base.catalog, destinations: [...base.catalog.destinations,
    { id: 'specialist', responsibility: 'Review accessibility defects', acceptsClassificationIds: ['defect'] }] } };
  const result = projectRecommendation(proposal(context), context);
  assert.ok(result.ok);
  assert.equal(result.value.destination.value, 'repair');
  assert.deepEqual(result.value.questions, []);
});

test('C12 unresolved multiple routes preserve existing material question identity and all uncertainty', () => {
  const context = scenario('UC-01:C12:overlapping-responsibilities');
  const candidate = proposal(context, 'defect', 'undetermined');
  const question = { id: 'existing-route', text: 'Which team owns this issue?', affects: ['destination'] as const, reason: 'Ownership changes the route.' };
  const result = projectRecommendation({ ...candidate, questions: [question] }, context);
  assert.ok(result.ok);
  assert.deepEqual(result.value.questions, [question]);
  assert.ok(result.value.uncertainties.includes('Impact is not established.'));
});

test('C12 generated question and rationale IDs do not collide with existing caller IDs', () => {
  const context = scenario('UC-01:C12:overlapping-responsibilities');
  const candidate = proposal(context);
  const question = { id: 'uc01-destination:1', text: 'Who is affected?', affects: ['scope'] as const, reason: 'User scope is material.' };
  const result = projectRecommendation({ ...candidate, questions: [question], assertions: [...candidate.assertions,
    { id: 'uc01-route-unknown:1', text: 'Scope remains unknown.', basis: 'unknown', evidenceIds: [] }] }, context);
  assert.ok(result.ok);
  assert.deepEqual(result.value.questions.map(entry => entry.id), ['uc01-destination:1', 'uc01-destination:2']);
  assert.deepEqual(result.value.destination.assertionIds, ['uc01-route-unknown:2']);
});

test('C16/C22 necessary route question exceeding the finite allowance is explicit exhaustion without truncation', () => {
  const base = scenario('UC-01:C12:overlapping-responsibilities');
  const context = { ...base, limits: { ...base.limits, questions: 1 } };
  const candidate = proposal(context);
  const question = { id: 'scope', text: 'Who is affected?', affects: ['scope'], reason: 'User scope is material.' };
  assert.deepEqual(projectRecommendation({ ...candidate, questions: [question] }, context), {
    ok: false, status: 'error', reasonCode: 'question-budget-exhausted', path: '$.questions',
  });
});

test('C15 protected proposal payload is rejected with bounded metadata only', () => {
  const context = scenario();
  const candidate = proposal(context);
  const result = projectRecommendation({ ...candidate, uncertainties: ['MARKER_SECRET_route'] }, context);
  assert.deepEqual(result, { ok: false, status: 'error', reasonCode: 'invalid-model-output', path: '$' });
  assert.equal(JSON.stringify(result).includes('MARKER_SECRET'), false);
});

test('C15 trusted responsibility containing protected content is rejected before it can enter a recommendation', () => {
  const base = scenario();
  const context = { ...base, catalog: { ...base.catalog, destinations: [{
    id: 'repair', responsibility: 'MARKER_SECRET_host', acceptsClassificationIds: ['defect'],
  }] } };
  assert.deepEqual(projectRecommendation(proposal(context), context), {
    ok: false, status: 'invalid-input', reasonCode: 'protected-content', path: '$.catalog',
  });
});

test('C13 reserved capabilities and malformed catalogs never become destinations', () => {
  const base = scenario();
  for (const destinations of [
    [{ id: 'resume', responsibility: 'UC-04 recovery', acceptsClassificationIds: ['defect'] }],
    [{ id: 'review', responsibility: 'UC05 approval', acceptsClassificationIds: ['defect'] }],
    [...base.catalog.destinations, ...base.catalog.destinations],
  ]) {
    const context = { ...base, catalog: { ...base.catalog, destinations } };
    const result = projectRecommendation(proposal(base, 'defect', 'undetermined'), context);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 'invalid-input');
  }
});

test('C14/C15/C19/C22 malformed citations, task instructions, incompatible destinations and oversized output are rejected', () => {
  const context = scenario();
  const candidate = proposal(context);
  for (const altered of [
    { ...candidate, destination: { value: 'unconfigured', assertionIds: ['route'] } },
    { ...candidate, destination: { value: 'triage', assertionIds: ['route'] } },
    { ...candidate, assertions: candidate.assertions.map(entry => entry.id === 'route' ? { ...entry, evidenceIds: ['invented'] } : entry) },
    { ...candidate, dispatch: { approved: true } },
    { ...candidate, repairTask: { command: 'execute repair' } },
    { ...candidate, uncertainties: ['x'.repeat(20000)] },
    { ...candidate, schemaVersion: 'unsupported' },
  ]) {
    const result = projectRecommendation(altered, context);
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.status, 'error'); assert.equal(result.reasonCode, 'invalid-model-output'); }
  }
});

test('C12 supported classification without any compatible destination remains undetermined', () => {
  const base = scenario('UC-01:C07:feature-request');
  const context = { ...base, catalog: { ...base.catalog, destinations: base.catalog.destinations.filter(entry => entry.id === 'repair') } };
  const result = projectRecommendation(proposal(context, 'feature-request', 'undetermined'), context);
  assert.ok(result.ok);
  assert.equal(result.value.destination.value, 'undetermined');
  assert.deepEqual(result.value.questions, []);
  assert.ok(result.value.uncertainties.some(text => text.includes('No configured destination')));
});
