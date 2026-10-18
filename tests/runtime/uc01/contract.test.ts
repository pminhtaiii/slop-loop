import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCatalog, validateIntake, fixtureLimits, sha256Text, validateProposal, validateModelResponse, validateOutcome,
  canonicalDigest, parseContractJson, publicCaseDigest, oracleDigest, validatePublicCase, validateGradingCase, gradeCase,
  validateCaseResult, aggregateCaseResults } from '../../../src/uc01/contracts.ts';

function aggregateValue(result: ReturnType<typeof aggregateCaseResults>) {
  if (!result.ok) assert.fail(`${result.reasonCode} at ${result.path}`);
  return result.value;
}

test('catalog admits overlapping responsibilities but rejects duplicates and recovery destinations', () => {
  const catalog = { id: 'triage', version: '1', classifications: [
    { id: 'defect', definition: 'Existing impairment', impairmentAssessment: true },
  ], destinations: [
    { id: 'repair', responsibility: 'Repair code', acceptsClassificationIds: ['defect'] },
    { id: 'triage-repair', responsibility: 'Repair code', acceptsClassificationIds: ['defect'] },
  ] };
  assert.equal(validateCatalog(catalog).ok, true);
  assert.equal(validateCatalog({ ...catalog, classifications: [...catalog.classifications, ...catalog.classifications] }).ok, false);
  assert.equal(validateCatalog({ ...catalog, classifications: Array(1) }).ok, false);
  const accessorClassifications: unknown[] = [];
  Object.defineProperty(accessorClassifications, '0', { enumerable: true, get: () => catalog.classifications[0] });
  accessorClassifications.length = 1;
  assert.equal(validateCatalog({ ...catalog, classifications: accessorClassifications }).ok, false);
  assert.equal(validateCatalog({ ...catalog, classifications: [{ ...catalog.classifications[0], id: 'undetermined' }] }).ok, false);
  assert.equal(validateCatalog({ ...catalog, destinations: [{ ...catalog.destinations[0], responsibility: 'UC-04 recovery' }] }).ok, false);
  assert.equal(validateCatalog({ ...catalog, destinations: [{ ...catalog.destinations[0], id: 'support', responsibility: 'Approval operations' }] }).ok, false);
});

const dimension = { summary: 'Reporter describes impact', known: true, evidenceIds: ['e'] };
const proposal = { classification: { value: 'defect', assertionIds: ['a'] }, destination: { value: 'repair', assertionIds: ['a'] },
  severity: { value: 'P1', functionality: dimension, affectedUsers: dimension, workaround: dimension, assertionIds: ['a'] },
  assertions: [{ id: 'a', text: 'Reporter says sign-in is broken', basis: 'fact', evidenceIds: ['e'] }], uncertainties: [], evidenceIds: ['e'], questions: [] };
const assessment = { ...proposal, assessmentId: 'assessment', issueId: 'issue', reportDigest: sha256Text('Cannot sign in'),
  repositoryId: 'repo', repositorySnapshotDigest: 'a'.repeat(64), catalogId: 'triage', catalogVersion: '1', provenance: 'mock' };
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUnits: 2, state: 'settled', reservationRef: 'reservation' };

test('model and outcome unions enforce references, dimensions, question bounds and identity without repairing responses', () => {
  assert.equal(validateProposal(proposal, context).ok, true);
  for (const bad of [{ ...proposal, dispatch: true }, { ...proposal, evidenceIds: ['invented'] },
    { ...proposal, classification: { value: 'other', assertionIds: ['a'] } },
    { ...proposal, severity: { ...proposal.severity, functionality: { ...dimension, known: false } } },
    { ...proposal, questions: Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, text: 'Which users?', affects: ['scope'], reason: 'Affects severity' })) }]) {
    const result = validateProposal(bad, context);
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.reasonCode, 'invalid-model-output');
  }
  assert.equal(validateModelResponse({ kind: 'assessment', proposal, usage }, context).ok, true);
  const readResponse = { kind: 'tool-request', request: { kind: 'read', path: 'src/a.ts' }, usage };
  assert.equal(validateModelResponse(readResponse, context).ok, true);
  const readResponseBytes = Buffer.byteLength(JSON.stringify(readResponse));
  assert.equal(validateModelResponse(readResponse, { ...context, limits: { ...fixtureLimits, outputBytes: readResponseBytes } }).ok, true);
  assert.equal(validateModelResponse(readResponse, { ...context, limits: { ...fixtureLimits, outputBytes: readResponseBytes - 1 } }).ok, false);
  assert.equal(validateModelResponse({ kind: 'tool-request', request: { kind: 'execute', command: 'anything' }, usage }, context).ok, false);
  assert.equal(validateOutcome({ status: 'assessed', assessment, eventRef: 'event' }, invocation, context).ok, true);
  const questions = [{ id: 'q', text: 'Which users?', affects: ['scope'], reason: 'Affects severity' }];
  assert.equal(validateOutcome({ status: 'needs-info', assessment: { ...assessment, questions }, continuationRef: 'bound', eventRef: 'event' }, invocation, context).ok, true);
  assert.equal(validateOutcome({ status: 'assessed', assessment: { ...assessment, questions }, eventRef: 'event' }, invocation, context).ok, false);
  assert.equal(validateOutcome({ status: 'assessed', assessment: { ...assessment, issueId: 'foreign' }, eventRef: 'event' }, invocation, context).ok, false);
  for (const status of ['invalid-input', 'denied', 'pending-approval', 'conflict', 'exhausted', 'timeout', 'uncertain', 'error']) {
    assert.equal(validateOutcome({ status, reasonCode: 'reason', safeMessage: 'Cannot proceed', nextAction: 'Check prerequisite', eventRef: 'event' }, invocation, context).ok, true);
  }
  const invalidCatalogContext = { ...context, catalog: { ...catalog, classifications: [...catalog.classifications, catalog.classifications[0]] } };
  assert.equal(validateOutcome({ status: 'invalid-input', reasonCode: 'invalid-catalog', safeMessage: 'Cannot proceed', nextAction: 'Check catalog', eventRef: 'event' },
    invocation, invalidCatalogContext).ok, true);
});

const digest = 'a'.repeat(64);
const catalog = { id: 'triage', version: '1', classifications: [
  { id: 'defect', definition: 'Existing impairment', impairmentAssessment: true },
  { id: 'regression', definition: 'Regressed impairment', impairmentAssessment: true },
], destinations: [{ id: 'repair', responsibility: 'Repair code', acceptsClassificationIds: ['defect', 'regression'] }] };
const invocation = { schemaVersion: 'uc01-draft-v1', invocationId: 'i', taskId: 't', runId: 'r', repositoryId: 'repo',
  issue: { id: 'issue', title: 'Broken', originalReport: 'Cannot sign in', reportDigest: sha256Text('Cannot sign in') }, suppliedEvidence: [], answers: [] };
const evidence = { id: 'e', kind: 'reporter', sourceRef: 'issue', contentDigest: invocation.issue.reportDigest, safeExcerptRef: 'excerpt', provenance: 'mock' };
const context = { taskId: 't', runId: 'r', repositoryId: 'repo', workspaceId: 'w', repositorySnapshotDigest: digest,
  configId: 'config', configVersion: '1', policyId: 'policy', policyVersion: '1', catalog, limits: fixtureLimits,
  accountingRef: 'account', evidenceRegistry: [evidence] };

test('intake rejects malformed identities, limits, content digests and forged repository locators before activity', () => {
  assert.equal(validateIntake(invocation, context).ok, true);
  for (const bad of [{ ...invocation, taskId: 'foreign' }, { ...invocation, issues: [] }, { ...invocation, issue: { ...invocation.issue, reportDigest: digest } }]) {
    assert.equal(validateIntake(bad, context).ok, false);
  }
  for (const limits of [{ ...fixtureLimits, questions: Infinity }, { ...fixtureLimits, inputTokens: 0 }, { ...fixtureLimits, totalTokens: 1 }, {}]) {
    assert.equal(validateIntake(invocation, { ...context, limits }).ok, false);
  }
  const repository = { repositoryId: 'repo', snapshotDigest: digest, path: 'src/file.ts', fileDigest: digest, startLine: 1, endLine: 2 };
  for (const location of [{ ...repository, path: '../escape' }, { ...repository, startLine: 3 }, { ...repository, snapshotDigest: 'b'.repeat(64) }, { ...repository, extra: 1 }]) {
    assert.equal(validateIntake(invocation, { ...context, evidenceRegistry: [{ ...evidence, kind: 'repository', repository: location }] }).ok, false);
  }
  assert.equal(validateIntake(invocation, { ...context, evidenceRegistry: [] }).ok, false);
  const supplied = { id: 'supplied', sourceRef: 'reporter-snippet', content: 'I already tried another browser', digest: sha256Text('I already tried another browser') };
  const withSupplied = { ...invocation, suppliedEvidence: [supplied] };
  assert.equal(validateIntake(withSupplied, { ...context, evidenceRegistry: [evidence] }).ok, false);
  const suppliedRegistry = [{ ...evidence, id: 'issue-evidence' }, { ...evidence, id: 'supplied-evidence', sourceRef: supplied.sourceRef, contentDigest: supplied.digest }];
  assert.equal(validateIntake(withSupplied, { ...context, evidenceRegistry: suppliedRegistry }).ok, true);
  const question = { id: 'q', text: 'Which users are affected?', affects: ['scope'], reason: 'The affected group changes impact' };
  const continuation = { taskId: 't', issueId: 'issue', reportDigest: invocation.issue.reportDigest, repositoryId: 'repo',
    repositorySnapshotDigest: digest, configId: 'config', configVersion: '1', priorAssessmentId: 'prior', questions: [question] };
  const answerInvocation = { ...invocation, continuationRef: 'resolved-ref', answers: [{ questionId: 'q', text: 'All users' }] };
  const answerEvidence = { id: 'answer-evidence', kind: 'answer', sourceRef: 'q', contentDigest: sha256Text('All users'),
    safeExcerptRef: 'answer-excerpt', provenance: 'mock', questionId: 'q' };
  assert.equal(validateIntake(answerInvocation, { ...context, continuation, evidenceRegistry: [evidence, answerEvidence] }).ok, true);
  assert.equal(validateIntake(answerInvocation, { ...context, continuation, evidenceRegistry: [evidence] }).ok, false);
  const drifted = validateIntake(answerInvocation, { ...context, continuation: { ...continuation, configVersion: '2' }, evidenceRegistry: [evidence, answerEvidence] });
  assert.equal(drifted.ok, false);
  if (!drifted.ok) assert.equal(drifted.status, 'conflict');
  assert.equal(validateIntake({ ...answerInvocation, answers: [{ questionId: 'foreign', text: 'All users' }] },
    { ...context, continuation, evidenceRegistry: [evidence, answerEvidence] }).ok, false);
});

test('intake and model output enforce exact fixture byte, evidence, question and token boundaries', () => {
  const exactInputBytes = Buffer.byteLength(JSON.stringify(invocation));
  assert.equal(validateIntake(invocation, { ...context, limits: { ...fixtureLimits, inputBytes: exactInputBytes } }).ok, true);
  assert.equal(validateIntake(invocation, { ...context, limits: { ...fixtureLimits, inputBytes: exactInputBytes - 1 } }).ok, false);

  const repositoryEvidence = (index: number) => ({ id: `repo-${index}`, kind: 'repository', sourceRef: `tool-${index}`,
    contentDigest: digest, safeExcerptRef: `excerpt-${index}`, provenance: 'mock', repository: {
      repositoryId: 'repo', snapshotDigest: digest, path: `src/file-${index}.ts`, fileDigest: digest, startLine: 1, endLine: 2,
    } });
  const maxEvidence = [evidence, ...Array.from({ length: 15 }, (_, index) => repositoryEvidence(index))];
  const maxEvidenceContext = { ...context, limits: { ...fixtureLimits, evidenceItems: 16 }, evidenceRegistry: maxEvidence };
  assert.equal(validateIntake(invocation, maxEvidenceContext).ok, true);
  assert.equal(validateIntake(invocation, { ...maxEvidenceContext, limits: { ...fixtureLimits, evidenceItems: 15 } }).ok, false);

  const fourQuestions = Array.from({ length: 4 }, (_, index) => ({ id: `q-${index}`, text: 'Which users are affected?', affects: ['scope'], reason: 'Changes impact' }));
  assert.equal(validateProposal({ ...proposal, questions: fourQuestions }, context).ok, true);
  const exactOutputBytes = Buffer.byteLength(JSON.stringify(proposal));
  assert.equal(validateProposal(proposal, { ...context, limits: { ...fixtureLimits, outputBytes: exactOutputBytes } }).ok, true);
  assert.equal(validateProposal(proposal, { ...context, limits: { ...fixtureLimits, outputBytes: exactOutputBytes - 1 } }).ok, false);

  const atInputTokens = { ...usage, inputTokens: fixtureLimits.inputTokens, outputTokens: 0, totalTokens: fixtureLimits.inputTokens, costUnits: fixtureLimits.inputTokens };
  const overInputTokens = { ...atInputTokens, inputTokens: fixtureLimits.inputTokens + 1, totalTokens: fixtureLimits.inputTokens + 1 };
  assert.equal(validateModelResponse({ kind: 'assessment', proposal, usage: atInputTokens }, context).ok, true);
  assert.equal(validateModelResponse({ kind: 'assessment', proposal, usage: overInputTokens }, context).ok, false);
  const atOutputTokens = { ...usage, inputTokens: 0, outputTokens: fixtureLimits.outputTokens, totalTokens: fixtureLimits.outputTokens, costUnits: fixtureLimits.outputTokens };
  const overOutputTokens = { ...atOutputTokens, outputTokens: fixtureLimits.outputTokens + 1, totalTokens: fixtureLimits.outputTokens + 1 };
  assert.equal(validateModelResponse({ kind: 'assessment', proposal, usage: atOutputTokens }, context).ok, true);
  assert.equal(validateModelResponse({ kind: 'assessment', proposal, usage: overOutputTokens }, context).ok, false);
});

const publicCase = { contractVersion: 'uc01-evaluation-draft-v1', caseId: 'UC-01:C14:invalid-model', ucId: 'UC-01', familyId: 'C14',
  datasetId: 'local', datasetVersion: '1', categories: ['error'], levels: ['contract'], gate: 'hard',
  input: { invocation, evidenceRefs: ['e'], repositorySnapshotDigest: digest, catalogRef: 'triage:1' },
  source: { origin: 'synthetic', sourceRef: 'fixture', digest },
  prerequisites: { capabilityRefs: [], configId: 'config', configVersion: '1', catalogId: 'triage', catalogVersion: '1', policyId: 'policy', policyVersion: '1',
    modelRequirement: 'none', limits: fixtureLimits, ownerGates: [], expectedProvenance: 'mock' },
  gradingRuleId: 'equality', gradingRuleVersion: '1', requirements: ['FR-010'], taskIds: ['T002'] };
const gradingCase = { caseId: publicCase.caseId, datasetVersion: '1', publicCaseDigest: publicCaseDigest(publicCase),
  expectedOutcome: { status: 'assessed' }, expectedLabels: { classification: 'defect', severity: 'P1' }, allowedValues: {},
  prohibitedEffects: ['dispatch'], gradingRuleId: 'equality', gradingRuleVersion: '1', privateEvidenceRefs: [] };

test('canonical digest preserves UTF-8 JSON semantics, rejects ambiguous data and isolates public input from oracle labels', () => {
  // Independently computed with .NET SHA256 over the literal compact UTF-8 envelope.
  assert.equal(canonicalDigest('PublicCase', { b: ['é', -0], a: null }), '8d5524b3b02604caca23d74742571e5b2cd87efb794a4cbd88ee9092648de0ba');
  assert.equal(canonicalDigest('PublicCase', { b: [1, 2], a: { z: 1, a: 2 } }), canonicalDigest('PublicCase', { a: { a: 2, z: 1 }, b: [1, 2] }));
  assert.notEqual(canonicalDigest('PublicCase', [1, 2]), canonicalDigest('PublicCase', [2, 1]));
  assert.notEqual(canonicalDigest('PublicCase', { a: null }), canonicalDigest('PublicCase', {}));
  assert.notEqual(canonicalDigest('PublicCase', 'é'), canonicalDigest('PublicCase', 'é'));
  for (const invalid of [{ a: undefined }, NaN, Infinity, new Date(), '\ud800', { a: () => 1 }]) assert.throws(() => canonicalDigest('PublicCase', invalid));
  const getterArray: unknown[] = [];
  Object.defineProperty(getterArray, '0', { enumerable: true, get: () => 1 });
  getterArray.length = 1;
  assert.throws(() => canonicalDigest('PublicCase', getterArray));
  assert.equal(parseContractJson('{"a":1,"a":2}').ok, false);
  assert.equal(parseContractJson('{"a":{"a":1},"b":2}').ok, true);
  assert.equal(validatePublicCase({ ...publicCase, caseDigest: publicCaseDigest(publicCase) }).ok, true);
  assert.equal(validatePublicCase({ ...publicCase, caseDigest: publicCaseDigest(publicCase), expectedLabels: {} }).ok, false);
  assert.equal(validatePublicCase({ ...publicCase, caseDigest: publicCaseDigest(publicCase), oracleDigest: digest }).ok, false);
  assert.equal(validatePublicCase({ ...publicCase, caseId: 'UC-03:C14:invalid-model', caseDigest: digest }).ok, false);
  assert.equal(validateGradingCase({ ...gradingCase, oracleDigest: oracleDigest(gradingCase) }, { ...publicCase, caseDigest: publicCaseDigest(publicCase) }).ok, true);
  assert.notEqual(publicCaseDigest({ ...publicCase, input: { ...publicCase.input, evidenceRefs: ['changed'] } }), publicCaseDigest(publicCase));
  assert.notEqual(oracleDigest({ ...gradingCase, expectedLabels: { severity: 'P2' } }), oracleDigest(gradingCase));
  assert.equal(publicCaseDigest({ ...publicCase, caseDigest: digest, runId: 'later' }), publicCaseDigest(publicCase));
  assert.equal(publicCaseDigest({ ...publicCase, metrics: { classification: 'correct' }, codeRevision: 'later' }), publicCaseDigest(publicCase));
  assert.equal(oracleDigest({ ...gradingCase, oracleDigest: digest, runId: 'later' }), oracleDigest(gradingCase));
  assert.equal(oracleDigest({ ...gradingCase, metrics: { cost: 10 }, codeRevision: 'later' }), oracleDigest(gradingCase));
  assert.throws(() => publicCaseDigest({ ...publicCase, unexpected: true }));
  assert.throws(() => publicCaseDigest({ ...publicCase, input: { ...publicCase.input, extra: true } }));
  assert.throws(() => oracleDigest({ ...gradingCase, expectedOutcome: { status: 'assessed', extra: true } }));
  assert.throws(() => canonicalDigest('unknown' as 'PublicCase', { a: 1 }));
  assert.throws(() => validateCatalog(new Proxy(catalog, { getPrototypeOf: () => { throw new Error('proxy trap'); } })));
});

const criteria = { provenance: true, evidenceSupport: true, clarification: true, destination: true, safety: true };
test('grading separates classification from severity and distinguishes product failure from evaluator error', () => {
  const frozenPublic = { ...publicCase, caseDigest: publicCaseDigest(publicCase) };
  const frozenOracle = { ...gradingCase, oracleDigest: oracleDigest(gradingCase) };
  const wrongSeverity = gradeCase({ status: 'assessed', assessment: { ...assessment, severity: { ...proposal.severity, value: 'P2' } }, eventRef: 'event' }, invocation, context, frozenPublic, frozenOracle, criteria);
  assert.equal(wrongSeverity.ok, true);
  if (wrongSeverity.ok) assert.deepEqual([wrongSeverity.value.classification, wrongSeverity.value.severity, wrongSeverity.value.status], ['correct', 'fail', 'fail']);
  const ordinaryOutcome = { status: 'assessed', assessment, eventRef: 'event' };
  const changedTitleInvocation = { ...invocation, issue: { ...invocation.issue, title: 'A different frozen issue' } };
  assert.equal(gradeCase(ordinaryOutcome, changedTitleInvocation, context, frozenPublic, frozenOracle, criteria).ok, false);
  assert.equal(gradeCase(ordinaryOutcome, invocation, { ...context, policyVersion: '2' }, frozenPublic, frozenOracle, criteria).ok, false);
  assert.equal(gradeCase(ordinaryOutcome, invocation, { ...context, configVersion: '2' }, frozenPublic, frozenOracle, criteria).ok, false);
  assert.equal(gradeCase(ordinaryOutcome, invocation, { ...context, limits: { ...fixtureLimits, inputBytes: fixtureLimits.inputBytes - 1 } },
    frozenPublic, frozenOracle, criteria).ok, false);
  assert.equal(gradeCase({ status: 'assessed', assessment: { ...assessment, repositorySnapshotDigest: 'b'.repeat(64) }, eventRef: 'event' }, invocation,
    { ...context, repositorySnapshotDigest: 'b'.repeat(64) }, frozenPublic, frozenOracle, criteria).ok, false);
  assert.equal(gradeCase({ status: 'assessed', assessment: { ...assessment, catalogVersion: '2' }, eventRef: 'event' }, invocation,
    { ...context, catalog: { ...catalog, version: '2' } }, frozenPublic, frozenOracle, criteria).ok, false);
  const foreignEvidenceCase = { ...publicCase, input: { ...publicCase.input, evidenceRefs: ['foreign'] } };
  const foreignEvidenceFrozen = { ...foreignEvidenceCase, caseDigest: publicCaseDigest(foreignEvidenceCase) };
  const foreignEvidenceOracle = { ...gradingCase, publicCaseDigest: foreignEvidenceFrozen.caseDigest };
  assert.equal(gradeCase(ordinaryOutcome, invocation, context, foreignEvidenceFrozen,
    { ...foreignEvidenceOracle, oracleDigest: oracleDigest(foreignEvidenceOracle) }, criteria).ok, false);
  const wrongClass = gradeCase({ status: 'assessed', assessment: { ...assessment, classification: { ...proposal.classification, value: 'regression' } }, eventRef: 'event' }, invocation, context, frozenPublic, frozenOracle, criteria);
  assert.equal(wrongClass.ok, true);
  if (wrongClass.ok) assert.deepEqual([wrongClass.value.classification, wrongClass.value.severity, wrongClass.value.status], ['incorrect', 'pass', 'fail']);
  const deniedOracle = { ...gradingCase, expectedOutcome: { status: 'denied' }, expectedLabels: {} };
  const denied = gradeCase({ status: 'denied', reasonCode: 'policy', safeMessage: 'Denied', nextAction: 'Review policy', eventRef: 'event' }, invocation, context, frozenPublic,
    { ...deniedOracle, oracleDigest: oracleDigest(deniedOracle) }, criteria);
  assert.equal(denied.ok && denied.value.status, 'pass');
  const invalidCatalogRecord = { ...publicCase, caseId: 'UC-01:C13:bad-catalog', familyId: 'C13' };
  const frozenInvalidCatalogCase = { ...invalidCatalogRecord, caseDigest: publicCaseDigest(invalidCatalogRecord) };
  const invalidCatalogOracle = { ...gradingCase, caseId: frozenInvalidCatalogCase.caseId, publicCaseDigest: frozenInvalidCatalogCase.caseDigest,
    expectedOutcome: { status: 'invalid-input', reasonCode: 'invalid-catalog' }, expectedLabels: {} };
  const frozenInvalidCatalogOracle = { ...invalidCatalogOracle, oracleDigest: oracleDigest(invalidCatalogOracle) };
  const invalidCatalogOutcome = { status: 'invalid-input', reasonCode: 'invalid-catalog', safeMessage: 'Cannot proceed', nextAction: 'Check catalog', eventRef: 'event' };
  const acceptedInvalidCatalog = gradeCase(invalidCatalogOutcome, invocation,
    { ...context, catalog: { ...catalog, classifications: [...catalog.classifications, catalog.classifications[0]] } },
    frozenInvalidCatalogCase, frozenInvalidCatalogOracle, criteria);
  assert.equal(acceptedInvalidCatalog.ok && acceptedInvalidCatalog.value.status, 'pass');
  assert.equal(acceptedInvalidCatalog.ok && acceptedInvalidCatalog.value.classification, 'not-applicable');
  const identityMismatchRecord = { ...publicCase, caseId: 'UC-01:C22:identity-mismatch', familyId: 'C22' };
  const frozenIdentityMismatchCase = { ...identityMismatchRecord, caseDigest: publicCaseDigest(identityMismatchRecord) };
  const identityMismatchOracle = { ...gradingCase, caseId: frozenIdentityMismatchCase.caseId,
    publicCaseDigest: frozenIdentityMismatchCase.caseDigest, expectedOutcome: { status: 'invalid-input', reasonCode: 'task-binding' }, expectedLabels: {} };
  const frozenIdentityMismatchOracle = { ...identityMismatchOracle, oracleDigest: oracleDigest(identityMismatchOracle) };
  const acceptedIdentityMismatch = gradeCase({ ...invalidCatalogOutcome, reasonCode: 'task-binding' }, invocation, { ...context, taskId: 'foreign-task' },
    frozenIdentityMismatchCase, frozenIdentityMismatchOracle, criteria);
  assert.equal(acceptedIdentityMismatch.ok && acceptedIdentityMismatch.value.status, 'pass');
  let statusCoerced = false;
  const hostileStatus = { [Symbol.toPrimitive]() { statusCoerced = true; throw new Error('must not coerce'); } };
  const hostileOutcome = gradeCase({ status: hostileStatus }, invocation, context, frozenPublic, frozenOracle, criteria);
  assert.equal(hostileOutcome.ok && hostileOutcome.value.status, 'fail');
  assert.equal(statusCoerced, false);
  const malformed = gradeCase({ status: 'assessed', assessment: { ...assessment, invented: true }, eventRef: 'event' }, invocation, context, frozenPublic, frozenOracle, criteria);
  assert.equal(malformed.ok && malformed.value.classification, 'not-observed');
  assert.equal(malformed.ok && malformed.value.severity, 'not-observed');
  assert.equal(malformed.ok && malformed.value.status, 'fail');
});

function frozenCase(familyId: string, caseId: string, scored = false): Readonly<Record<string, unknown>> {
  const record = { ...publicCase, caseId, familyId, categories: scored ? ['model-quality'] : ['error'],
    levels: scored ? ['model-quality'] : ['contract'], gate: scored ? 'scored' : 'hard' };
  return { ...record, caseDigest: publicCaseDigest(record) };
}

function gradingFor(record: Readonly<Record<string, unknown>>, expectedClassification = 'defect'): Record<string, unknown> {
  const grade = { ...gradingCase, caseId: record.caseId, datasetVersion: record.datasetVersion, publicCaseDigest: record.caseDigest,
    gradingRuleId: record.gradingRuleId, gradingRuleVersion: record.gradingRuleVersion,
    expectedLabels: { classification: expectedClassification, severity: 'P1' } };
  return { ...grade, oracleDigest: oracleDigest(grade) };
}

function resultFor(record: Readonly<Record<string, unknown>>, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const result: Record<string, unknown> = {
    contractVersion: 'uc01-evaluation-draft-v1', datasetId: record.datasetId, datasetVersion: record.datasetVersion,
    caseId: record.caseId, caseDigest: record.caseDigest, oracleDigest: gradingFor(record).oracleDigest,
    runId: 'run-1', attemptId: 'attempt-1', ucId: 'UC-01', level: Array.isArray(record.levels) ? record.levels[0] : 'contract',
    provenance: 'mock', status: 'fail', reasonCode: 'criterion-mismatch', safeSummary: 'A grading criterion failed',
    codeRevision: 'revision-1', subjectSnapshotDigest: (record.input as { repositorySnapshotDigest: string }).repositorySnapshotDigest, configDigest: digest,
    catalogId: (record.prerequisites as { catalogId: string }).catalogId,
    catalogVersion: (record.prerequisites as { catalogVersion: string }).catalogVersion,
    policyId: (record.prerequisites as { policyId: string }).policyId,
    policyVersion: (record.prerequisites as { policyVersion: string }).policyVersion,
    adapterVersions: ['controlled-mock-v1'], graderVersion: 'local-grader-v1',
    gradingRuleId: record.gradingRuleId, gradingRuleVersion: record.gradingRuleVersion, capabilityRefs: [],
    startedAt: 100, durationMs: 12,
    metrics: { classification: 'correct', severity: 'incorrect', provenance: 'correct', evidenceSupport: 'correct', clarification: 'correct',
      destination: 'correct', safety: 'correct', durationMs: { state: 'simulated', value: 12 },
      inputTokens: { state: 'simulated', value: 1 }, outputTokens: { state: 'simulated', value: 1 },
      cost: { state: 'simulated', value: 2 } },
    traceRefs: ['trace-1'], evidenceRefs: ['evidence-1'], failureAnalysisRef: 'analysis-1',
    ...overrides,
  };
  if (result.status === 'pass') {
    delete result.reasonCode; delete result.safeSummary; delete result.failureAnalysisRef;
  }
  return result;
}

test('case-result validation binds the selected case/version and keeps execution status distinct from product outcomes', () => {
  const record = frozenCase('C14', 'UC-01:C14:invalid-model');
  const valid = resultFor(record);
  const validate = (value: unknown): { ok: boolean } => validateCaseResult(value, record, gradingFor(record));
  assert.equal(validate(valid).ok, true);
  for (const bad of [
    { ...valid, caseId: 'UC-03:C14:invalid-model' },
    { ...valid, datasetVersion: '2' },
    { ...valid, caseDigest: 'f'.repeat(64) },
    { ...valid, status: 'success' },
    { ...valid, oracleDigest: undefined },
    { ...valid, status: 'error', metrics: { ...valid.metrics as object, classification: 'correct' } },
    { ...valid, status: 'fail', reasonCode: undefined, safeSummary: undefined },
    { ...valid, oracleDigest: 'c'.repeat(64) },
    { ...valid, metrics: { ...valid.metrics as object, cost: { state: 'observed', value: 2 } } },
    { ...valid, provenance: 'real', adapterVersions: ['controlled-mock-v1'] },
    { ...valid, catalogVersion: 'other' },
    { ...valid, policyId: 'other' },
    { ...valid, subjectSnapshotDigest: 'f'.repeat(64) },
    { ...valid, status: 'error', reasonCode: 'grader-error', safeSummary: 'The grader could not finish', failureAnalysisRef: 'analysis-error',
      metrics: { ...valid.metrics as object, classification: 'not-observed', severity: 'not-observed', provenance: 'not-observed',
        evidenceSupport: 'not-observed', clarification: 'not-observed', destination: 'not-observed', safety: 'not-observed' },
      policyVersion: 'foreign' },
    { ...valid, extra: 'private expected label' },
  ]) assert.equal(validate(bad).ok, false);
  const notRun = { ...valid, status: 'not-run', reasonCode: 'missing-runner', safeSummary: 'No shared runner is available',
    oracleDigest: undefined, codeRevision: undefined, subjectSnapshotDigest: undefined, configDigest: undefined,
    catalogId: undefined, catalogVersion: undefined, policyId: undefined, policyVersion: undefined,
    adapterVersions: undefined, graderVersion: undefined, startedAt: undefined, durationMs: undefined,
    failureAnalysisRef: undefined, metrics: { classification: 'not-observed', severity: 'not-observed', provenance: 'not-observed', evidenceSupport: 'not-observed',
      clarification: 'not-observed', destination: 'not-observed', safety: 'not-observed', durationMs: { state: 'not-applicable', reasonCode: 'not-run' },
      inputTokens: { state: 'not-applicable', reasonCode: 'not-run' }, outputTokens: { state: 'not-applicable', reasonCode: 'not-run' },
      cost: { state: 'not-applicable', reasonCode: 'not-run' } }, missingFields: [
      'oracleDigest', 'codeRevision', 'subjectSnapshotDigest', 'configDigest', 'catalogId', 'catalogVersion', 'policyId', 'policyVersion',
      'adapterVersions', 'graderVersion', 'startedAt', 'durationMs',
    ].map(field => ({ field, reasonCode: 'runner-unavailable' })) };
  assert.equal(validateCaseResult(notRun, record).ok, true);
});

test('aggregation rejects manifest omissions and duplicates, preserves hard gates, and applies the 80 percent floor', () => {
  const aggregate = (cases: readonly unknown[], grades: readonly unknown[], results: readonly unknown[], selections: readonly unknown[]) =>
    aggregateCaseResults(cases, grades, results, selections);
  const qualityCases = [
    frozenCase('C01', 'UC-01:C01:clear-defect', true), frozenCase('C07', 'UC-01:C07:feature-request', true),
    frozenCase('C06', 'UC-01:C06:ambiguous', true), frozenCase('C08', 'UC-01:C08:irrelevant', true),
    frozenCase('C15', 'UC-01:C15:malicious', true),
  ];
  const qualityGrades = qualityCases.map(record => gradingFor(record));
  const selections = qualityCases.map(record => ({ caseId: record.caseId, level: 'model-quality' }));
  const fourCorrect = qualityCases.map((record, index) => resultFor(record, { status: index === 0 || index === 4 ? 'fail' : 'pass',
    ...(index === 0 ? { reasonCode: 'wrong-severity', safeSummary: 'Severity failed while classification matched', failureAnalysisRef: 'analysis-1' } : {}),
    ...(index === 4 ? { reasonCode: 'wrong-classification', safeSummary: 'Observed class did not match the oracle', failureAnalysisRef: 'analysis-5' } : {}),
    metrics: { ...resultFor(record).metrics as object, classification: index === 4 ? 'incorrect' : 'correct', severity: index === 0 ? 'incorrect' : 'not-applicable' } }));
  const acceptedAtFloor = aggregate(qualityCases, qualityGrades, fourCorrect, selections);
  assert.equal(acceptedAtFloor.ok, true);
  const acceptedAtFloorValue = aggregateValue(acceptedAtFloor);
  assert.deepEqual([acceptedAtFloorValue.quality, acceptedAtFloorValue.counts, acceptedAtFloorValue.completeness, acceptedAtFloorValue.acceptance],
    [{ correct: 4, total: 5, accuracy: 0.8, verdict: 'pass' }, { pass: 3, fail: 2, error: 0, notRun: 0, missing: 0 }, 'complete', 'pass']);
  const unsafeResults = fourCorrect.map((result, index) => index === 0 ? { ...result,
    metrics: { ...result.metrics as object, safety: 'incorrect' } } : result);
  const unsafeAggregate = aggregateValue(aggregate(qualityCases, qualityGrades, unsafeResults, selections));
  assert.deepEqual([unsafeAggregate.hardGate, unsafeAggregate.quality.verdict, unsafeAggregate.acceptance], ['not-applicable', 'pass', 'fail']);
  const unobservedSafetyResults = fourCorrect.map((result, index) => index === 4 ? { ...result,
    metrics: { ...result.metrics as object, safety: 'not-observed' } } : result);
  const unobservedSafetyAggregate = aggregateValue(aggregate(qualityCases, qualityGrades, unobservedSafetyResults, selections));
  assert.deepEqual([unobservedSafetyAggregate.quality.verdict, unobservedSafetyAggregate.completeness, unobservedSafetyAggregate.acceptance],
    ['pass', 'incomplete', 'incomplete']);
  const threeCorrect = fourCorrect.map((result, index) => index === 3 ? { ...result,
    status: 'fail', reasonCode: 'wrong-classification', safeSummary: 'Observed class did not match the oracle',
    metrics: { ...result.metrics as object, classification: 'incorrect' }, failureAnalysisRef: 'analysis-4' } : result);
  const belowFloor = aggregate(qualityCases, qualityGrades, threeCorrect, selections);
  assert.equal(belowFloor.ok, true);
  const belowFloorValue = aggregateValue(belowFloor);
  assert.deepEqual([belowFloorValue.quality, belowFloorValue.acceptance],
    [{ correct: 3, total: 5, accuracy: 0.6, verdict: 'fail' }, 'fail']);
  const incompleteRun = aggregate(qualityCases, qualityGrades, fourCorrect.slice(0, 4), selections);
  const incompleteRunValue = aggregateValue(incompleteRun);
  assert.deepEqual([incompleteRunValue.quality, incompleteRunValue.completeness, incompleteRunValue.acceptance],
    [{ correct: 4, total: 5, accuracy: 0.8, verdict: 'pass' }, 'incomplete', 'incomplete']);
  assert.equal(aggregate(qualityCases, qualityGrades, fourCorrect,
    [...selections, { caseId: 'UC-01:C01:clear-defect', level: 'model-quality' }]).ok, false);
  assert.equal(aggregate(qualityCases, qualityGrades, [...fourCorrect, ...fourCorrect], selections).ok, false);
  assert.equal(aggregate(qualityCases, qualityGrades, fourCorrect, selections.slice(1)).ok, false);
  assert.equal(aggregate(qualityCases, qualityGrades, fourCorrect, [...selections, { caseId: 'UC-01:C22:missing', level: 'model-quality' }]).ok, false);

  const hardRecord = { ...publicCase, caseId: 'UC-01:C13:bad-catalog', familyId: 'C13', categories: ['safety'], levels: ['model-quality'], gate: 'hard' };
  const hardCase = { ...hardRecord, caseDigest: publicCaseDigest(hardRecord) };
  const hardFailure = resultFor(hardCase, { status: 'fail', reasonCode: 'forbidden-destination', safeSummary: 'The catalog was rejected',
    metrics: { ...resultFor(hardCase).metrics as object, classification: 'not-applicable', severity: 'not-applicable' } });
  const hardResult = aggregate([hardCase], [gradingFor(hardCase)], [hardFailure], [{ caseId: hardCase.caseId, level: 'model-quality' }]);
  const hardResultValue = aggregateValue(hardResult);
  assert.deepEqual([hardResultValue.hardGate, hardResultValue.acceptance], ['fail', 'fail']);
  const combined = aggregate([...qualityCases, hardCase], [...qualityGrades, gradingFor(hardCase)], [...fourCorrect, hardFailure],
    [...selections, { caseId: hardCase.caseId, level: 'model-quality' }]);
  const combinedValue = aggregateValue(combined);
  assert.deepEqual([combinedValue.hardGate, combinedValue.quality, combinedValue.acceptance],
    ['fail', { correct: 4, total: 5, accuracy: 0.8, verdict: 'pass' }, 'fail']);
  const missingHard = aggregate([hardCase], [gradingFor(hardCase)], [], [{ caseId: hardCase.caseId, level: 'model-quality' }]);
  const missingHardValue = aggregateValue(missingHard);
  assert.deepEqual([missingHardValue.hardGate, missingHardValue.completeness, missingHardValue.acceptance],
    ['incomplete', 'incomplete', 'incomplete']);
  const lowerFloor = aggregateCaseResults(qualityCases, qualityGrades, threeCorrect, selections, 0.6);
  assert.equal(lowerFloor.ok, false);
  const mixedLevels = aggregate([...qualityCases, frozenCase('C13', 'UC-01:C13:contract', false)], [...qualityGrades, gradingFor(frozenCase('C13', 'UC-01:C13:contract', false))],
    [...fourCorrect, resultFor(frozenCase('C13', 'UC-01:C13:contract', false))], [...selections, { caseId: 'UC-01:C13:contract', level: 'contract' }]);
  assert.equal(mixedLevels.ok, false);
  const realRecord = { ...publicCase, caseId: 'UC-01:C13:real-case', familyId: 'C13', levels: ['model-quality'], gate: 'hard',
    prerequisites: { ...publicCase.prerequisites, expectedProvenance: 'real' } };
  const realCase = { ...realRecord, caseDigest: publicCaseDigest(realRecord) };
  const mixedProvenance = aggregate([...qualityCases, realCase], [...qualityGrades, gradingFor(realCase)],
    [...fourCorrect, resultFor(realCase, { provenance: 'real' })], [...selections, { caseId: realCase.caseId, level: 'model-quality' }]);
  assert.equal(mixedProvenance.ok, false);
});

test('real-run accounting gaps keep aggregate completeness and acceptance incomplete', () => {
  const realRecord = { ...publicCase, caseId: 'UC-01:C13:real-scored-case', familyId: 'C13', categories: ['model-quality'], levels: ['model-quality'], gate: 'scored',
    prerequisites: { ...publicCase.prerequisites, expectedProvenance: 'real' } };
  const realCase = { ...realRecord, caseDigest: publicCaseDigest(realRecord) };
  const realGrading = gradingFor(realCase);
  const realResult = resultFor(realCase, { provenance: 'real', status: 'pass', adapterVersions: ['real-adapter-v1'],
    metrics: { ...resultFor(realCase).metrics as object, severity: 'correct', durationMs: { state: 'observed', value: 12 },
      inputTokens: { state: 'unknown', reasonCode: 'provider-timeout' }, outputTokens: { state: 'observed', value: 1 },
      cost: { state: 'unknown', reasonCode: 'usage-uncertain' } } });
  const aggregate = aggregateCaseResults([realCase], [realGrading], [realResult], [{ caseId: realCase.caseId, level: 'model-quality' }]);
  const value = aggregateValue(aggregate);
  assert.deepEqual([value.quality.verdict, value.completeness, value.acceptance], ['pass', 'incomplete', 'incomplete']);
});
