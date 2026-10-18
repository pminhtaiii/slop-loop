import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateCaseResults, canonicalDigest, fixtureLimits, gradeCase, oracleDigest, publicCaseDigest, sha256Text,
  validateGradingCase, validateIntake, validateInvocation, validatePublicCase, type Assessment, type Catalog, type GradingCase, type PublicCase } from '../../../src/uc01/contracts.ts';
import { modelInputForCase, publicEvidenceForCase, trustedCatalogForCase, trustedContinuationForCase,
  UC01_CASE_SPLIT, UC01_GRADING_CASES, UC01_HELD_OUT_PLAN, UC01_INVALID_INVOCATION_VECTORS, UC01_PUBLIC_CASES } from '../support/uc01/fixtures.ts';

const casesById = new Map(UC01_PUBLIC_CASES.map(record => [record.caseId, record]));
const oraclesById = new Map(UC01_GRADING_CASES.map(record => [record.caseId, record]));
function fixtureCase(caseId: string): PublicCase {
  const record = casesById.get(caseId);
  assert.ok(record, `missing public fixture ${caseId}`);
  return record;
}
function fixtureOracle(caseId: string): GradingCase {
  const record = oraclesById.get(caseId);
  assert.ok(record, `missing private oracle ${caseId}`);
  return record;
}
function nestedKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(nestedKeys);
  if (value === null || typeof value !== 'object') return [];
  return [...Object.keys(value), ...Object.values(value).flatMap(nestedKeys)];
}

function contextFor(record: PublicCase) {
  const invocation = record.input.invocation;
  const catalog = trustedCatalogForCase(record.caseId);
  return {
    taskId: invocation.taskId, runId: invocation.runId, repositoryId: invocation.repositoryId, workspaceId: 'fixture-workspace',
    repositorySnapshotDigest: record.input.repositorySnapshotDigest,
    configId: record.prerequisites.configId, configVersion: record.prerequisites.configVersion,
    policyId: record.prerequisites.policyId, policyVersion: record.prerequisites.policyVersion,
    catalog,
    limits: fixtureLimits, accountingRef: `account:${record.caseId}`, evidenceRegistry: publicEvidenceForCase(record.caseId),
    ...(trustedContinuationForCase(record.caseId) ? { continuation: trustedContinuationForCase(record.caseId) } : {}),
  };
}

function assessedObservation(record: PublicCase, oracle: GradingCase, overrides: Readonly<{ classification?: string; severity?: string }> = {}) {
  const context = contextFor(record);
  const invocation = record.input.invocation;
  const evidence = publicEvidenceForCase(record.caseId).find(item => item.id === record.input.evidenceRefs[0]);
  assert.ok(evidence);
  const classification = overrides.classification ?? oracle.expectedLabels.classification ?? 'undetermined';
  const severity = overrides.severity ?? oracle.expectedLabels.severity ?? 'undetermined';
  const questionAffects = oracle.expectedOutcome.requiredQuestionAffects ?? [];
  const assertionId = 'reported-behavior';
  const assertionEvidence = evidence.kind === 'reporter' ? [evidence.id] : [];
  const assertions = [{ id: assertionId, text: 'The report describes this observed behavior', basis: 'fact', evidenceIds: assertionEvidence }];
  const knownSeverity = severity !== 'undetermined';
  const dimension = { summary: knownSeverity ? 'Supported impact in the fixture report' : 'Impact is not established', known: knownSeverity,
    evidenceIds: knownSeverity ? assertionEvidence : [] };
  const proposal = {
    classification: { value: classification, assertionIds: [assertionId] },
    severity: { value: severity, functionality: dimension, affectedUsers: dimension, workaround: dimension, assertionIds: [assertionId] },
    destination: { value: oracle.expectedLabels.destination ?? (classification === 'undetermined' ? 'undetermined' : 'repair'), assertionIds: [assertionId] },
    assertions, uncertainties: [], evidenceIds: assertionEvidence,
    questions: questionAffects.length ? [{ id: 'material-question', text: 'Which users and functions are affected?', affects: questionAffects, reason: 'The report leaves impact unresolved' }] : [],
  };
  const assessment: Assessment = {
    ...proposal, assessmentId: `assessment:${record.caseId}`, issueId: invocation.issue.id, reportDigest: invocation.issue.reportDigest,
    repositoryId: invocation.repositoryId, repositorySnapshotDigest: record.input.repositorySnapshotDigest,
    catalogId: record.prerequisites.catalogId, catalogVersion: record.prerequisites.catalogVersion, provenance: 'mock',
  } as Assessment;
  const status = questionAffects.length ? 'needs-info' : 'assessed';
  const outcome = status === 'needs-info'
    ? { status, assessment, continuationRef: `continuation:${record.caseId}`, eventRef: `event:${record.caseId}` }
    : { status, assessment, eventRef: `event:${record.caseId}` };
  return { invocation, context, outcome };
}

function mockScoringFixtures(): { cases: PublicCase[]; oracles: GradingCase[] } {
  const cases = UC01_CASE_SPLIT.heldOut.map(caseId => {
    const current = fixtureCase(caseId);
    const { caseDigest, ...record } = current;
    void caseDigest;
    const mockRecord = { ...record, prerequisites: { ...record.prerequisites, expectedProvenance: 'mock' as const } };
    return { ...mockRecord, caseDigest: publicCaseDigest(mockRecord) } as PublicCase;
  });
  const oracles = cases.map(record => {
    const current = fixtureOracle(record.caseId);
    const { oracleDigest: oldDigest, ...oracle } = current;
    void oldDigest;
    const mockOracle = { ...oracle, publicCaseDigest: record.caseDigest };
    return { ...mockOracle, oracleDigest: oracleDigest(mockOracle) } as GradingCase;
  });
  return { cases, oracles };
}

function mockResult(record: PublicCase, oracle: GradingCase, index: number): Record<string, unknown> {
  const failed = index === 4;
  const durationMs = 12 + index;
  return {
    contractVersion: record.contractVersion, datasetId: record.datasetId, datasetVersion: record.datasetVersion,
    caseId: record.caseId, caseDigest: record.caseDigest, oracleDigest: oracle.oracleDigest, runId: 'mock-scoring-plan', attemptId: `attempt-${index}`,
    ucId: 'UC-01', level: 'model-quality', provenance: 'mock', status: failed ? 'fail' : 'pass',
    ...(failed ? { reasonCode: 'classification-mismatch', safeSummary: 'The local simulated result has a wrong class' } : {}),
    codeRevision: 'mock-revision', subjectSnapshotDigest: record.input.repositorySnapshotDigest, configDigest: sha256Text(record.caseId),
    catalogId: record.prerequisites.catalogId, catalogVersion: record.prerequisites.catalogVersion,
    policyId: record.prerequisites.policyId, policyVersion: record.prerequisites.policyVersion,
    adapterVersions: ['controlled-mock-v1'], graderVersion: 'local-grader-v1',
    gradingRuleId: record.gradingRuleId, gradingRuleVersion: record.gradingRuleVersion, capabilityRefs: [], startedAt: 100,
    durationMs, metrics: {
      classification: failed ? 'incorrect' : 'correct', severity: 'correct', provenance: 'correct', evidenceSupport: 'correct',
      clarification: 'correct', destination: 'correct', safety: 'correct', durationMs: { state: 'simulated', value: durationMs },
      inputTokens: { state: 'simulated', value: 10 }, outputTokens: { state: 'simulated', value: 5 }, cost: { state: 'simulated', value: 15 },
    }, traceRefs: [`trace-${index}`], evidenceRefs: [], ...(failed ? { failureAnalysisRef: `analysis-${index}` } : {}),
  };
}

test('every C01–C22 public case and private oracle validates and the manifest has no omissions or duplicates', () => {
  assert.ok(UC01_PUBLIC_CASES.length >= 22);
  assert.equal(new Set(UC01_PUBLIC_CASES.map(record => record.caseId)).size, UC01_PUBLIC_CASES.length);
  assert.equal(new Set(UC01_GRADING_CASES.map(record => record.caseId)).size, UC01_GRADING_CASES.length);
  assert.deepEqual([...UC01_PUBLIC_CASES.map(record => record.caseId)].sort(), [...UC01_GRADING_CASES.map(record => record.caseId)].sort());
  assert.deepEqual(new Set(UC01_PUBLIC_CASES.map(record => record.familyId)),
    new Set(Array.from({ length: 22 }, (_, index) => `C${String(index + 1).padStart(2, '0')}`)));
  for (const record of UC01_PUBLIC_CASES) {
    assert.equal(validatePublicCase(record).ok, true, record.caseId);
    assert.equal(publicCaseDigest(record), record.caseDigest, record.caseId);
    const oracle = fixtureOracle(record.caseId);
    assert.equal(validateGradingCase(oracle, record).ok, true, record.caseId);
    assert.equal(oracleDigest(oracle), oracle.oracleDigest, record.caseId);
  }
});

test('fixtures cover severity, non-defect, conflicts, continuations, catalog variants, attacks and failures', () => {
  const severities = new Set(UC01_GRADING_CASES.map(record => record.expectedLabels.severity).flatMap(value => value === undefined ? [] : [value]));
  assert.deepEqual(severities, new Set(['P0', 'P1', 'P2', 'P3', 'undetermined']));
  assert.ok(fixtureOracle('UC-01:C07:feature-request').expectedLabels.classification !== 'defect');
  assert.ok(fixtureCase('UC-01:C09:conflicting-origins').input.evidenceRefs.length >= 2);
  const continuation = fixtureCase('UC-01:C10:bound-later-answer');
  assert.ok(continuation.input.invocation.continuationRef);
  assert.ok(continuation.input.invocation.answers.length > 0);
  assert.ok(trustedContinuationForCase(continuation.caseId));
  assert.ok(fixtureCase('UC-01:C12:empty-catalog'));
  assert.ok(fixtureCase('UC-01:C12:overlapping-responsibilities'));
  assert.ok(fixtureCase('UC-01:C13:reserved-destination'));
  assert.ok(fixtureCase('UC-01:C14:forged-citation'));
  assert.ok(fixtureCase('UC-01:C14:unknown-tool'));
  assert.ok(fixtureCase('UC-01:C15:malicious-held-out'));
  assert.ok(fixtureCase('UC-01:C15:malicious-hard-gate'));
  assert.ok(fixtureCase('UC-01:C16:exhausted-budget'));
  assert.ok(fixtureCase('UC-01:C17:uncertain-usage'));
  assert.ok(fixtureCase('UC-01:C18:task-budget-resume'));
  assert.ok(UC01_PUBLIC_CASES.some(record => record.familyId === 'C19' && record.prerequisites.policyId.length > 0));
  assert.ok(fixtureCase('UC-01:C20:missing-real-adapter'));
  assert.ok(fixtureCase('UC-01:C21:missing-reproduction'));
  assert.ok(fixtureCase('UC-01:C22:oversized-input'));
});

test('C12 empty catalog is an allowed configuration that grades an undetermined assessment', () => {
  const record = fixtureCase('UC-01:C12:empty-catalog');
  const oracle = fixtureOracle(record.caseId);
  const sample = assessedObservation(record, oracle);
  assert.deepEqual(sample.context.catalog.classifications, []);
  assert.deepEqual(sample.context.catalog.destinations, []);
  assert.equal(validateIntake(sample.invocation, sample.context).ok, true);
  assert.deepEqual(oracle.expectedOutcome, { status: 'assessed' });
  assert.deepEqual(oracle.expectedLabels, { classification: 'undetermined', severity: 'undetermined', destination: 'undetermined' });
  const grade = gradeCase(sample.outcome, sample.invocation, sample.context, record, oracle,
    { provenance: true, evidenceSupport: true, clarification: true, destination: true, safety: true });
  assert.equal(grade.ok, true, JSON.stringify(grade));
  if (grade.ok) assert.deepEqual([grade.value.status, grade.value.classification, grade.value.severity], ['pass', 'correct', 'pass']);
});

test('frozen cases bind the exact trusted catalog contents for each catalog variant', () => {
  for (const caseId of ['UC-01:C12:empty-catalog', 'UC-01:C12:overlapping-responsibilities', 'UC-01:C13:reserved-destination']) {
    const record = fixtureCase(caseId);
    const oracle = fixtureOracle(caseId);
    const catalog = trustedCatalogForCase(caseId);
    assert.equal(record.prerequisites.catalogDigest, canonicalDigest('PublicCase', catalog), caseId);
    assert.equal(catalog.id, record.prerequisites.catalogId, caseId);
    assert.equal(catalog.version, record.prerequisites.catalogVersion, caseId);

    const sample = caseId === 'UC-01:C13:reserved-destination'
      ? { invocation: record.input.invocation, context: contextFor(record), outcome: {
        status: 'invalid-input', reasonCode: 'invalid-catalog', safeMessage: 'Catalog rejected', nextAction: 'Correct the catalog', eventRef: 'event:catalog-rejected',
      } }
      : assessedObservation(record, oracle);
    assert.equal(validateIntake(sample.invocation, sample.context).ok, caseId !== 'UC-01:C13:reserved-destination', caseId);
    const criteria = { provenance: true, evidenceSupport: true, clarification: true, destination: true, safety: true };
    assert.equal(gradeCase(sample.outcome, sample.invocation, sample.context, record, oracle, criteria).ok, true, caseId);

    const changedClassifications = catalog.classifications.length === 0
      ? [{ id: 'added-after-freeze', definition: 'A changed trusted catalog', impairmentAssessment: false }]
      : catalog.classifications.map((entry, index) => index === 0 ? { ...entry, definition: `${entry.definition} (changed)` } : entry);
    const changedCatalog: Catalog = { ...catalog, classifications: changedClassifications };
    const drifted = gradeCase(sample.outcome, sample.invocation, { ...sample.context, catalog: changedCatalog }, record, oracle, criteria);
    assert.equal(drifted.ok, false, `${caseId} must reject catalog content drift under the same id and version`);
  }
});

test('held-out split has five frozen classification anchors and keeps the 80 percent gate independent', () => {
  assert.equal(UC01_HELD_OUT_PLAN.executed, false);
  assert.equal(UC01_HELD_OUT_PLAN.liveCallsAuthorized, false);
  assert.equal(UC01_HELD_OUT_PLAN.minimumAccuracy, 0.8);
  assert.equal(UC01_HELD_OUT_PLAN.denominator, 'all-required-held-out-classification-cases');
  assert.equal(UC01_HELD_OUT_PLAN.hardGatesIndependent, true);
  assert.ok(UC01_CASE_SPLIT.heldOut.length >= 5);
  assert.deepEqual(new Set(UC01_CASE_SPLIT.heldOut), new Set([
    'UC-01:C01:clear-defect', 'UC-01:C07:feature-request', 'UC-01:C06:ambiguous',
    'UC-01:C08:irrelevant', 'UC-01:C15:malicious-held-out',
  ]));
  assert.equal(new Set([...UC01_CASE_SPLIT.heldOut, ...UC01_CASE_SPLIT.development]).size, UC01_PUBLIC_CASES.length);
  for (const caseId of UC01_CASE_SPLIT.heldOut) {
    const record = fixtureCase(caseId);
    assert.deepEqual(record.categories, ['model-quality']);
    assert.deepEqual(record.levels, ['model-quality']);
    assert.equal(record.gate, 'scored');
    assert.ok(fixtureOracle(caseId).expectedLabels.classification);
  }
});

test('public model inputs exclude labels, oracle records, grader paths and private evidence references', () => {
  const forbiddenKeys = new Set(['expectedOutcome', 'expectedLabels', 'allowedValues', 'prohibitedEffects', 'oracleDigest', 'privateEvidenceRefs', 'graderPath']);
  for (const record of UC01_PUBLIC_CASES) {
    const modelInput = modelInputForCase(record);
    assert.deepEqual(Object.keys(modelInput).sort(), ['catalogRef', 'evidenceRefs', 'invocation', 'repositorySnapshotDigest']);
    for (const key of nestedKeys(record)) assert.equal(forbiddenKeys.has(key), false, `${record.caseId} includes private key ${key}`);
    for (const key of nestedKeys(modelInput)) assert.equal(forbiddenKeys.has(key), false, `${record.caseId} model input includes private key ${key}`);
    for (const privateRef of fixtureOracle(record.caseId).privateEvidenceRefs) {
      assert.equal(JSON.stringify(modelInput).includes(privateRef), false, `${record.caseId} exposes ${privateRef}`);
    }
  }
});

test('C22 malformed invocation boundary vectors reject unsupported schema and multi-entity payloads', () => {
  assert.ok(UC01_INVALID_INVOCATION_VECTORS.length >= 3);
  for (const vector of UC01_INVALID_INVOCATION_VECTORS) {
    assert.equal(validateInvocation(vector.invocation).ok, false, vector.caseId);
  }
});

test('continuation fixtures bind later answers and reject a stale repository snapshot', () => {
  const valid = fixtureCase('UC-01:C10:bound-later-answer');
  const validContinuation = trustedContinuationForCase(valid.caseId);
  assert.ok(validContinuation);
  assert.equal(validateIntake(valid.input.invocation, { ...contextFor(valid), continuation: validContinuation }).ok, true);

  const stale = fixtureCase('UC-01:C11:stale-snapshot-answer');
  const staleContinuation = trustedContinuationForCase(stale.caseId);
  assert.ok(staleContinuation);
  const result = validateIntake(stale.input.invocation, { ...contextFor(stale), continuation: staleContinuation });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 'conflict');
});

test('C22 oversized input and evidence fixtures fail bounded admission before assessment', () => {
  for (const caseId of ['UC-01:C22:oversized-input', 'UC-01:C22:oversized-evidence']) {
    const record = fixtureCase(caseId);
    assert.equal(validateIntake(record.input.invocation, contextFor(record)).ok, false, caseId);
  }
});

test('trusted grader keeps all five severity outcomes separate from classification correctness', () => {
  for (const caseId of ['UC-01:C02:all-users-locked-out', 'UC-01:C03:team-export-blocked', 'UC-01:C04:conversion-workaround',
    'UC-01:C05:cosmetic-spacing', 'UC-01:C06:all-broken-development']) {
    const record = fixtureCase(caseId);
    const oracle = fixtureOracle(caseId);
    const sample = assessedObservation(record, oracle);
    const grade = gradeCase(sample.outcome, sample.invocation, sample.context, record, oracle,
      { provenance: true, evidenceSupport: true, clarification: true, destination: true, safety: true });
    assert.equal(grade.ok, true, caseId);
    if (grade.ok) assert.deepEqual([grade.value.status, grade.value.classification, grade.value.severity], ['pass', 'correct', 'pass']);
  }
  const record = fixtureCase('UC-01:C02:all-users-locked-out');
  const oracle = fixtureOracle(record.caseId);
  const observation = assessedObservation(record, oracle);
  const correctClassWrongSeverity = { ...observation.outcome, assessment: { ...(observation.outcome as { assessment: Assessment }).assessment,
    severity: { ...(observation.outcome as { assessment: Assessment }).assessment.severity, value: 'P2' } } };
  const wrongClassCorrectSeverity = { ...observation.outcome, assessment: { ...(observation.outcome as { assessment: Assessment }).assessment,
    classification: { ...(observation.outcome as { assessment: Assessment }).assessment.classification, value: 'incident' } } };
  const criteria = { provenance: true, evidenceSupport: true, clarification: true, destination: true, safety: true };
  const classOnly = gradeCase(correctClassWrongSeverity, observation.invocation, observation.context, record, oracle, criteria);
  const severityOnly = gradeCase(wrongClassCorrectSeverity, observation.invocation, observation.context, record, oracle, criteria);
  assert.equal(classOnly.ok && classOnly.value.classification, 'correct');
  assert.equal(classOnly.ok && classOnly.value.severity, 'fail');
  assert.equal(severityOnly.ok && severityOnly.value.classification, 'incorrect');
  assert.equal(severityOnly.ok && severityOnly.value.severity, 'pass');
});

test('held-out aggregation can be exercised locally as mock data without a real-quality claim', () => {
  const { cases, oracles } = mockScoringFixtures();
  for (const record of cases) assert.equal(validatePublicCase(record).ok, true, record.caseId);
  for (const oracle of oracles) assert.equal(validateGradingCase(oracle, cases.find(record => record.caseId === oracle.caseId)).ok, true, oracle.caseId);
  const results = cases.map((record, index) => {
    const oracle = oracles[index];
    assert.ok(oracle, `missing mock oracle ${record.caseId}`);
    return mockResult(record, oracle, index);
  });
  const aggregate = aggregateCaseResults(cases, oracles, results, cases.map(record => ({ caseId: record.caseId, level: 'model-quality' })), 0.8);
  assert.equal(aggregate.ok, true, JSON.stringify(aggregate));
  if (aggregate.ok) {
    assert.deepEqual(aggregate.value.quality, { correct: 4, total: 5, accuracy: 0.8, verdict: 'pass' });
    assert.equal(aggregate.value.hardGate, 'not-applicable');
    assert.equal(aggregate.value.completeness, 'complete');
    assert.equal(aggregate.value.acceptance, 'pass');
  }
});
