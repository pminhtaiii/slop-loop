import assert from 'node:assert/strict';
import test from 'node:test';
import { createQuestionModelPort } from '../../../src/questions/model.ts';
import type { QuestionCompiledRequestV1, QuestionModelTransportV1, QuestionRequestTokenCounterV1 } from '../../../src/questions/model.ts';
import type { QuestionRuntimeBudgetV1 } from '../../../src/contracts/questions/contracts.ts';
import { createQuestionBudgetLedger } from '../../../src/questions/budget.ts';
import { QUESTION_CONTRACT_VERSIONS } from '../../../src/contracts/questions/contracts.ts';
import {
  validateQuestionBudgetProfile,
  validateAdmittedSpan,
  validateDirectoryPage,
  validateQuestionResult,
  validateSearchPage,
  validateSourceSnapshot,
  validateSpanResult,
  validateQuestionDecision,
  validateQuestionAbsenceReceipt,
  validateQuestionIdentity,
  validateQuestionIndexGeneration,
  validateQuestionIndexedChunk,
  validateQuestionIndexedFile,
  validateQuestionModelResponse,
  validateQuestionRetrievalRequest,
  validateQuestionRetrievalResult,
  validateQuestionUsage,
} from '../../../src/contracts/questions/validation.ts';

const identity = {
  sessionId: 'session-001',
  taskId: 'task-001',
  runId: 'run-001',
  questionId: 'question-001',
  binding: {
    repositoryId: 'repo-001',
    workspaceId: 'workspace-001',
    revisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    policyDigest: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  },
  configDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
};

const budgetProfile = {
  schemaVersion: 'question-budget/1',
  runtime: {
    maxToolCalls: 32,
    maxModelCalls: 20,
    maxScannedFiles: 500,
    maxScannedBytes: 2_000_000,
    maxReturnedBytes: 500_000,
    maxInputTokensPerCall: 20_000,
    maxOutputTokensPerCall: 2_048,
    maxBillableTokensTask: 100_000,
    maxCostMicrosTask: 2_000_000,
    maxElapsedMsTask: 120_000,
    maxClarificationRounds: 3,
    maxConversationBytes: 16_000,
    maxFinalBytes: 16_000,
  },
  repository: {
    maxFileBytes: 1_000_000,
    maxSpanBytes: 32_768,
    maxSpanLines: 200,
    maxPageEntries: 100,
    maxSearchHits: 100,
    maxQueryBytes: 2_048,
    maxPathBytes: 1_024,
  },
  retrieval: {
    maxFiles: 2_000,
    maxChunks: 20_000,
    maxVectorDimensions: 384,
    maxBatchSize: 32,
    maxConcurrentIndexWriters: 1,
    maxConcurrentRetrievalWorkers: 1,
    maxIndexDiskBytes: 536_870_912,
    maxSqliteCacheBytes: 33_554_432,
    maxWorkerMemoryBytes: 1_073_741_824,
    maxExactScanVectors: 20_000,
    maxIndexDeadlineMs: 120_000,
    maxRetrievalDeadlineMs: 10_000,
  },
};

test('question contract versions identify runtime and retrieval schemas', () => {
  assert.deepEqual(QUESTION_CONTRACT_VERSIONS, {
    question: 'repository-question/1',
    repository: 'question-repository/1',
    retrieval: 'question-retrieval/1',
    budget: 'question-budget/1',
  });
});

test('question identity validation accepts safe IDs and copies/freezes its binding', () => {
  const result = validateQuestionIdentity(identity);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, identity);
  assert.notEqual(result.value, identity);
  assert.notEqual(result.value.binding, identity.binding);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.binding), true);
});

test('question identity validation rejects malformed IDs and noncanonical digests', () => {
  const malformedId = validateQuestionIdentity({ ...identity, taskId: '' });
  const malformedDigest = validateQuestionIdentity({
    ...identity,
    binding: { ...identity.binding, revisionDigest: 'not-a-sha256-digest' },
  });

  assert.equal(malformedId.ok, false);
  assert.equal(malformedDigest.ok, false);
});

test('question budget profile requires finite positive limits for runtime, repository, and retrieval', () => {
  const result = validateQuestionBudgetProfile(budgetProfile);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, budgetProfile);
  assert.notEqual(result.value, budgetProfile);
  assert.notEqual(result.value.retrieval, budgetProfile.retrieval);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.runtime), true);
  assert.equal(Object.isFrozen(result.value.repository), true);
  assert.equal(Object.isFrozen(result.value.retrieval), true);
});

test('question budget profile rejects zero, fractional, infinite, and missing retrieval limits', () => {
  const zero = validateQuestionBudgetProfile({
    ...budgetProfile,
    runtime: { ...budgetProfile.runtime, maxToolCalls: 0 },
  });
  const fractional = validateQuestionBudgetProfile({
    ...budgetProfile,
    repository: { ...budgetProfile.repository, maxSpanLines: 1.5 },
  });
  const infinite = validateQuestionBudgetProfile({
    ...budgetProfile,
    retrieval: { ...budgetProfile.retrieval, maxWorkerMemoryBytes: Number.POSITIVE_INFINITY },
  });
  const missingRetrievalLimit = validateQuestionBudgetProfile({
    ...budgetProfile,
    retrieval: Object.fromEntries(Object.entries(budgetProfile.retrieval).filter(([key]) => key !== 'maxFiles')),
  });

  assert.equal(zero.ok, false);
  assert.equal(fractional.ok, false);
  assert.equal(infinite.ok, false);
  assert.equal(missingRetrievalLimit.ok, false);
});
const validAnswer = {
  kind: 'answer',
  claims: [
    {
      claimId: 'claim-001',
      text: 'The handler checks the request before dispatch.',
      kind: 'observation',
      evidence: [{ evidenceId: 'evidence-001', range: { startLine: 12, endLine: 17 } }],
    },
  ],
  limitations: ['Only the inspected route is covered.'],
};

test('question decision validation accepts each bounded tool and terminal decision', () => {
  const decisions = [
    { kind: 'list', path: '.' },
    { kind: 'search', query: 'dispatch', pathPrefix: 'src', cursor: 'opaque/cursor+=' },
    { kind: 'read', path: 'src/handler.py', startLine: 12, endLine: 17 },
    validAnswer,
    {
      kind: 'clarify',
      question: 'Which recovery path do you mean?',
      explanation: 'Two paths use the same term.',
      unresolvedReferents: ['database recovery', 'request recovery'],
    },
    { kind: 'insufficient', explanation: 'The available source does not establish this.' },
  ];

  for (const decision of decisions) assert.equal(validateQuestionDecision(decision).ok, true);
});

test('question decision validation rejects malformed ranges, unsafe paths, and uncited answer claims', () => {
  const reversedRange = validateQuestionDecision({
    kind: 'read',
    path: 'src/handler.py',
    startLine: 17,
    endLine: 12,
  });
  const unsafePath = validateQuestionDecision({ kind: 'list', path: '../secrets' });
  const uncitedClaim = validateQuestionDecision({
    kind: 'answer',
    claims: [{ claimId: 'claim-001', text: 'Unsupported.', kind: 'observation', evidence: [] }],
    limitations: [],
  });
  const unknownDecision = validateQuestionDecision({ kind: 'execute', command: 'pytest' });

  assert.equal(reversedRange.ok, false);
  assert.equal(unsafePath.ok, false);
  assert.equal(uncitedClaim.ok, false);
  assert.equal(unknownDecision.ok, false);
});

test('question usage accepts complete, missing, and unknown accounting states', () => {
  assert.equal(validateQuestionUsage({ status: 'complete', inputTokens: 12, outputTokens: 4 }).ok, true);
  assert.equal(validateQuestionUsage({ status: 'missing' }).ok, true);
  assert.equal(validateQuestionUsage({ status: 'unknown', reasonCode: 'timeout' }).ok, true);
});

test('question usage rejects malformed counters and response validation rejects malformed decisions', () => {
  const badCounters = [
    { status: 'complete', inputTokens: -1, outputTokens: 4 },
    { status: 'complete', inputTokens: 1.5, outputTokens: 4 },
    { status: 'complete', inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
    { status: 'complete', inputTokens: 1, outputTokens: Number.POSITIVE_INFINITY },
    { status: 'complete', inputTokens: 1, outputTokens: 2, raw: 'untrusted provider payload' },
  ];
  for (const usage of badCounters) assert.equal(validateQuestionUsage(usage).ok, false);

  const goodResponse = validateQuestionModelResponse({
    decision: validAnswer,
    usage: { status: 'complete', inputTokens: 12, outputTokens: 4 },
  });
  const badResponse = validateQuestionModelResponse({
    decision: { kind: 'read', path: 'src/handler.py', startLine: 0, endLine: 12 },
    usage: { status: 'complete', inputTokens: 12, outputTokens: 4 },
  });

  assert.equal(goodResponse.ok, true);
  assert.equal(badResponse.ok, false);
});

const indexedChunk = {
  schemaVersion: 'question-retrieval/1',
  chunkId: 'chunk-001',
  path: 'src/handlers.py',
  fileType: 'python-source',
  kind: 'definition',
  symbolName: 'handle',
  qualifiedSymbolName: 'handlers.handle',
  startLine: 10,
  endLine: 20,
  originalByteDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  excerptDigest: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  normalizedByteLength: 512,
  vectorId: 'vector-001',
  definition: {
    definitionId: 'definition-001',
    qualifiedName: 'handlers.handle',
    startLine: 9,
    endLine: 31,
    partOrder: 0,
  },
};

test('retrieval chunk validation preserves definition linkage and bounded source coordinates', () => {
  const result = validateQuestionIndexedChunk(indexedChunk);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, indexedChunk);
  assert.notEqual(result.value, indexedChunk);
  assert.notEqual(result.value.definition, indexedChunk.definition);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.definition), true);
});

test('retrieval chunk validation rejects overlong chunks and broken definition ranges', () => {
  const overlongChunk = validateQuestionIndexedChunk({
    ...indexedChunk,
    endLine: indexedChunk.startLine + 60,
    definition: { ...indexedChunk.definition, endLine: indexedChunk.startLine + 60 },
  });
  const brokenDefinition = validateQuestionIndexedChunk({
    ...indexedChunk,
    definition: { ...indexedChunk.definition, startLine: indexedChunk.endLine + 1 },
  });

  assert.equal(overlongChunk.ok, false);
  assert.equal(brokenDefinition.ok, false);
});

const generation = {
  schemaVersion: 'question-retrieval/1',
  generationId: 'generation-001',
  binding: identity.binding,
  snapshotId: 'snapshot-001',
  manifestDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  configDigest: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  embeddingDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  coverage: 'complete',
};

const indexedFile = {
  path: 'src/handlers.py',
  originalByteDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  fileType: 'python-source',
  coverage: 'complete',
  omissionReasons: [],
};

const retrievalRequest = {
  schemaVersion: 'question-retrieval/1',
  identity,
  generationId: 'generation-001',
  queryText: 'Where does the request reach the handler?',
  limits: budgetProfile.retrieval,
};

const rankedChunk = {
  chunkId: 'chunk-001',
  lane: 'exact-qualified',
  rank: 1,
  score: 0.93,
  path: 'src/handlers.py',
  revisionDigest: identity.binding.revisionDigest,
  originalByteDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  excerptDigest: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  startLine: 10,
  endLine: 20,
  normalizedByteLength: 512,
  embeddingInputTokens: 92,
};

const retrievalResult = {
  schemaVersion: 'question-retrieval/1',
  status: 'complete',
  binding: identity.binding,
  generationId: 'generation-001',
  manifestDigest: generation.manifestDigest,
  configDigest: generation.configDigest,
  embeddingDigest: generation.embeddingDigest,
  ranked: [
    rankedChunk,
    {
      ...rankedChunk,
      chunkId: 'chunk-002',
      lane: 'semantic',
      rank: 2,
      score: 0.87,
      startLine: 30,
      endLine: 38,
    },
  ],
};

const absenceReceipt = {
  schemaVersion: 'question-retrieval/1',
  binding: identity.binding,
  snapshotId: 'snapshot-001',
  generationId: 'generation-001',
  manifestDigest: generation.manifestDigest,
  normalizedQueryDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  scope: ['.'],
  exactDefinitionScan: 'complete',
  guardedLiteralScan: 'complete',
  exactDefinitionMatchCount: 0,
  guardedLiteralMatchCount: 0,
  omissionReasons: [],
};

test('retrieval generation and indexed-file metadata validate their binding and coverage', () => {
  const validGeneration = validateQuestionIndexGeneration(generation);
  const validFile = validateQuestionIndexedFile(indexedFile);
  const missingDigest = validateQuestionIndexGeneration({ ...generation, manifestDigest: 'bad' });
  const incompleteWithoutReason = validateQuestionIndexedFile({
    ...indexedFile,
    coverage: 'partial',
  });

  assert.equal(validGeneration.ok, true);
  assert.equal(validFile.ok, true);
  assert.equal(missingDigest.ok, false);
  assert.equal(incompleteWithoutReason.ok, false);
});

test('retrieval request validates identity and finite resource limits before querying', () => {
  const validRequest = validateQuestionRetrievalRequest(retrievalRequest);
  const invalidRequest = validateQuestionRetrievalRequest({
    ...retrievalRequest,
    generationId: '',
    limits: { ...retrievalRequest.limits, maxExactScanVectors: 0 },
  });

  assert.equal(validRequest.ok, true);
  assert.equal(invalidRequest.ok, false);
  if (!validRequest.ok) return;
  assert.notEqual(validRequest.value.identity, identity);
  assert.notEqual(validRequest.value.limits, budgetProfile.retrieval);
  assert.equal(Object.isFrozen(validRequest.value.limits), true);
});

test('retrieval results distinguish complete, empty, and failed rankings', () => {
  const complete = validateQuestionRetrievalResult(retrievalResult);
  const empty = validateQuestionRetrievalResult({
    ...retrievalResult,
    status: 'empty',
    ranked: [],
  });
  const exhausted = validateQuestionRetrievalResult({
    schemaVersion: 'question-retrieval/1',
    status: 'exhausted',
    reasonCode: 'scan-limit',
  });
  const unstable = validateQuestionRetrievalResult({
    ...retrievalResult,
    ranked: [rankedChunk, { ...rankedChunk, rank: 3, chunkId: 'chunk-003' }],
  });
  const overFive = validateQuestionRetrievalResult({
    ...retrievalResult,
    ranked: Array.from({ length: 6 }, (_, index) => ({
      ...rankedChunk,
      chunkId: 'chunk-' + String(index + 1).padStart(3, '0'),
      rank: index + 1,
    })),
  });

  assert.equal(complete.ok, true);
  assert.equal(empty.ok, true);
  assert.equal(exhausted.ok, true);
  assert.equal(unstable.ok, false);
  assert.equal(overFive.ok, false);
});

test('scoped absence receipt requires complete zero-match lanes and a canonical scope', () => {
  const validReceipt = validateQuestionAbsenceReceipt(absenceReceipt);
  const partialReceipt = validateQuestionAbsenceReceipt({
    ...absenceReceipt,
    omissionReasons: ['unreadable'],
  });
  const nonzeroReceipt = validateQuestionAbsenceReceipt({
    ...absenceReceipt,
    guardedLiteralMatchCount: 1,
  });

  assert.equal(validReceipt.ok, true);
  assert.equal(partialReceipt.ok, false);
  assert.equal(nonzeroReceipt.ok, false);
});

test('literal search arguments use a canonical path prefix and reject newline queries', () => {
  const validPrefix = validateQuestionDecision({ kind: 'search', query: 'dispatch', pathPrefix: 'src' });
  const oldPathField = validateQuestionDecision({ kind: 'search', query: 'dispatch', path: 'src' });
  const newlineQuery = validateQuestionDecision({ kind: 'search', query: 'first line' + String.fromCharCode(10) + 'second line' });

  assert.equal(validPrefix.ok, true);
  assert.equal(oldPathField.ok, false);
  assert.equal(newlineQuery.ok, false);
});

test('retrieval resource profile rejects limits above the pinned fixture ceilings', () => {
  const overFileCeiling = validateQuestionBudgetProfile({
    ...budgetProfile,
    retrieval: { ...budgetProfile.retrieval, maxFiles: 2_001 },
  });
  const multipleWriters = validateQuestionBudgetProfile({
    ...budgetProfile,
    retrieval: { ...budgetProfile.retrieval, maxConcurrentIndexWriters: 2 },
  });
  const smallerProfile = validateQuestionBudgetProfile({
    ...budgetProfile,
    retrieval: { ...budgetProfile.retrieval, maxFiles: 1_000, maxChunks: 10_000 },
  });

  assert.equal(overFileCeiling.ok, false);
  assert.equal(multipleWriters.ok, false);
  assert.equal(smallerProfile.ok, true);
});

test('question tool decisions reject drive-qualified paths and reserve the directory root for directory operations', () => {
  for (const path of ['C:/src', 'D:src']) {
    assert.equal(validateQuestionDecision({ kind: 'list', path }).ok, false);
    assert.equal(validateQuestionDecision({ kind: 'search', query: 'dispatch', pathPrefix: path }).ok, false);
    assert.equal(validateQuestionDecision({ kind: 'read', path, startLine: 1, endLine: 1 }).ok, false);
  }
  assert.equal(validateQuestionDecision({ kind: 'search', query: 'dispatch', pathPrefix: '.' }).ok, true);
  assert.equal(validateQuestionDecision({ kind: 'read', path: '.', startLine: 1, endLine: 1 }).ok, false);
});

const repositoryLimits = budgetProfile.repository;
const span = {
  identity,
  evidenceId: 'evidence-001',
  snapshotId: 'snapshot-001',
  manifestDigest: identity.configDigest,
  path: 'src/handler.py',
  range: { startLine: 12, endLine: 12 },
  excerpt: 'dispatch()',
  excerptDigest: identity.configDigest,
  originalByteDigest: identity.binding.revisionDigest,
  truncation: { kind: 'none' },
};

test('source snapshot validates a bounded canonical manifest and detaches its entries', () => {
  const manifestEntry = { path: span.path, originalByteDigest: span.originalByteDigest };
  const snapshot = {
    snapshotId: span.snapshotId,
    binding: identity.binding,
    manifestDigest: span.manifestDigest,
    acquisitionId: 'lease-001',
    admissionLimits: { maxFiles: 2, maxBytes: 1_000, maxElapsedMs: 100 },
    manifest: [manifestEntry],
  };
  const result = validateSourceSnapshot(snapshot);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(Object.isFrozen(result.value.manifest[0]), true);
  manifestEntry.path = 'changed.py';
  assert.equal(result.value.manifest[0]?.path, span.path);
  assert.equal(validateSourceSnapshot({ ...snapshot, manifest: [{ ...manifestEntry, path: 'C:repo.py' }] }).ok, false);
  assert.equal(validateSourceSnapshot({ ...snapshot, manifest: [...snapshot.manifest, ...snapshot.manifest] }).ok, false);
});

test('repository tool results enforce bounded evidence and distinguish partial coverage and failures', () => {
  const page = { status: 'ok', path: '.', entries: [{ path: 'src', kind: 'directory' }], coverage: 'complete', omissionReasons: [] };
  const hit = { span, line: 12, column: 1, matchLength: 8 };
  const search = { status: 'ok', hits: [hit], coverage: 'partial', omissionReasons: ['scan-limit'] };
  assert.equal(validateDirectoryPage(page, repositoryLimits).ok, true);
  assert.equal(validateDirectoryPage({ ...page, nextCursor: 'cursor-001' }, repositoryLimits).ok, false);
  assert.equal(validateSearchPage({ ...search, coverage: 'complete', omissionReasons: [], nextCursor: 'cursor-001' }, repositoryLimits).ok, false);
  assert.equal(validateDirectoryPage({ ...page, entries: [{ path: 'C:src', kind: 'directory' }] }, repositoryLimits).ok, false);
  assert.equal(validateSpanResult({ status: 'ok', span }, repositoryLimits).ok, true);
  assert.equal(validateSpanResult({ status: 'invalid', reasonCode: 'out-of-range' }, repositoryLimits).ok, true);
  assert.equal(validateSpanResult({ status: 'stale', reasonCode: 'binding-mismatch', span }, repositoryLimits).ok, false);
  assert.equal(validateSearchPage(search, repositoryLimits).ok, true);
  assert.equal(validateSearchPage({ ...search, nextCursor: 'cursor-001' }, repositoryLimits).ok, false);
  assert.equal(validateSearchPage({ ...search, hits: [{ ...hit, column: 5 }] }, repositoryLimits).ok, false);
  assert.equal(validateAdmittedSpan({ ...span, path: '.' }, repositoryLimits).ok, false);
  assert.equal(validateAdmittedSpan({ ...span, range: { startLine: 12, endLine: 13 } }, repositoryLimits).ok, false);
  assert.equal(validateAdmittedSpan(span, { ...repositoryLimits, maxSpanBytes: 9 }).ok, false);
});

test('terminal question results accept evidence or clarification and forbid claims after activity closes', () => {
  const base = { schemaVersion: 'repository-question/1', identity, usage: { status: 'missing' } };
  const citation = {
    evidenceId: 'evidence-001',
    range: { startLine: 12, endLine: 17 },
    path: span.path,
    originalByteDigest: span.originalByteDigest,
    excerptDigest: span.excerptDigest,
  };
  const answer = { ...base, kind: 'answered', claims: validAnswer.claims, citations: [citation], limitations: validAnswer.limitations };
  const clarification = {
    clarificationId: 'turn-001',
    round: 1,
    question: 'Which recovery path do you mean?',
    explanation: 'Two paths use the same term.',
    unresolvedReferents: ['database recovery', 'request recovery'],
  };
  const closed = { ...base, kind: 'budget-exhausted', reasonCode: 'tool-limit' };
  assert.equal(validateQuestionResult(answer).ok, true);
  assert.equal(validateQuestionResult({ ...answer, citations: [] }).ok, false);
  assert.equal(validateQuestionResult({ ...base, kind: 'awaiting-clarification', clarification }).ok, true);
  assert.equal(validateQuestionResult(closed).ok, true);
  assert.equal(validateQuestionResult({ ...closed, claims: validAnswer.claims }).ok, false);
  assert.equal(validateQuestionResult({ ...closed, reasonCode: 'raw provider error text' }).ok, false);
});

test('question model compiles the complete bounded request and settles trusted transport usage', async () => {
  const ledger = createQuestionBudgetLedger(budgetProfile, { pricing: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 } });
  assert.equal(ledger.ok, true);
  if (!ledger.ok) return;
  let calls = 0;
  const model = createQuestionModelPort({
    identity,
    profile: budgetProfile,
    budget: ledger.value,
    providerId: 'controlled-provider',
    modelId: 'controlled-model',
    counter: {
      kind: 'controlled',
      countRequest: request => {
        assert.match(request, /"system":/);
        assert.match(request, /"tools":/);
        assert.match(request, /"maxOutputTokens":2048/);
        assert.match(request, /How is dispatch selected/);
        return 123;
      },
    },
    transport: {
      kind: 'controlled',
      enforcesOutputTokenCap: true,
      send: async (request, control) => {
        calls += 1;
        assert.equal(request.maxOutputTokens, 2_048);
        assert.equal(control.signal.aborted, false);
        assert.equal(control.admission.identity.taskId, identity.taskId);
        assert.match(control.admission.reservationId, /^qb-/);
        assert.ok(Number.isFinite(control.deadlineAt));
        assert.equal(ledger.value.snapshot().reserved.billableTokens, 2_171);
        return { decision: { kind: 'search', query: 'dispatch' }, usage: { status: 'complete', inputTokens: 123, outputTokens: 7 } };
      },
    },
  });
  assert.equal(model.ok, true);
  if (!model.ok) return;
  const result = await model.value.decide({ question: 'How is dispatch selected?' }, new AbortController().signal);
  assert.equal(result.status, 'ok');
  assert.equal(calls, 1);
  assert.equal(ledger.value.snapshot().consumed.billableTokens, 130);
  assert.equal(ledger.value.snapshot().consumed.costMicros, 137);
  assert.equal(ledger.value.snapshot().reserved.billableTokens, 0);
});

function questionModelFixture(
  options: { runtime?: Partial<QuestionRuntimeBudgetV1>; counter?: QuestionRequestTokenCounterV1; send?: QuestionModelTransportV1['send']; cap?: boolean; now?: () => number } = {},
) {
  const profile = { ...budgetProfile, runtime: { ...budgetProfile.runtime, ...options.runtime } };
  const ledger = createQuestionBudgetLedger(profile, { pricing: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 1_000_000 }, ...(options.now ? { now: options.now } : {}) });
  assert.equal(ledger.ok, true);
  if (!ledger.ok) throw new Error('Controlled fixture configuration invalid');
  const requests: QuestionCompiledRequestV1[] = [];
  const model = createQuestionModelPort({
    identity,
    profile,
    budget: ledger.value,
    providerId: 'controlled-provider',
    modelId: 'controlled-model',
    counter: options.counter ?? { kind: 'controlled', countRequest: () => 123 },
    transport: {
      kind: 'controlled',
      enforcesOutputTokenCap: (options.cap ?? true) as true,
      send: async (request, control) => {
        requests.push(request);
        return options.send ? options.send(request, control) : { decision: { kind: 'list', path: '.' }, usage: { status: 'complete', inputTokens: request.inputTokens, outputTokens: 4 } };
      },
    },
  });
  return { model, budget: ledger.value, requests };
}

test('question model charges compiler task time before transport even with a later caller deadline', async () => {
  let clock = 0;
  let counts = 0;
  const fixture = questionModelFixture({
    runtime: { maxElapsedMsTask: 10 },
    now: () => clock,
    counter: {
      kind: 'controlled',
      countRequest: () => {
        counts += 1;
        clock += 11;
        return 123;
      },
    },
  });
  assert.equal(fixture.model.ok, true);
  if (!fixture.model.ok) return;
  const signal = new AbortController().signal;
  const expected = { status: 'stopped', reasonCode: 'elapsed-deadline', usage: { status: 'missing' } };
  assert.deepEqual(await fixture.model.value.decide({ question: 'Explain dispatch.' }, signal, Date.now() + 10_000), expected);
  assert.deepEqual(await fixture.model.value.decide({ question: 'Try again.' }, signal), expected);
  assert.equal(counts, 1);
  assert.equal(fixture.requests.length, 0);
  const state = fixture.budget.snapshot();
  assert.equal(state.status, 'exhausted');
  assert.equal(state.consumed.elapsedMs, 10);
  assert.equal(state.remainingElapsedMs, 0);
  assert.equal(state.consumed.modelCalls, 0);
  assert.equal(state.consumed.billableTokens, 0);
  assert.equal(state.reserved.billableTokens, 0);
  assert.equal(fixture.budget.reserveRepositoryOperation('read').ok, false);
});

test('question model accumulates fitting compilation time across calls without charging human waiting', async () => {
  let clock = 0;
  const fixture = questionModelFixture({
    runtime: { maxElapsedMsTask: 10 },
    now: () => clock,
    counter: {
      kind: 'controlled',
      countRequest: () => {
        clock += 4;
        return 123;
      },
    },
  });
  assert.equal(fixture.model.ok, true);
  if (!fixture.model.ok) return;
  const signal = new AbortController().signal;
  assert.equal((await fixture.model.value.decide({ question: 'Explain dispatch.' }, signal)).status, 'ok');
  assert.equal(fixture.budget.snapshot().consumed.elapsedMs, 4);
  clock += 1_000;
  assert.equal((await fixture.model.value.decide({ question: 'Explain again.' }, signal)).status, 'ok');
  assert.equal(fixture.budget.snapshot().consumed.elapsedMs, 8);
  assert.deepEqual(await fixture.model.value.decide({ question: 'Explain once more.' }, signal), { status: 'stopped', reasonCode: 'elapsed-deadline', usage: { status: 'missing' } });
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.budget.snapshot().consumed.elapsedMs, 10);
  assert.equal(fixture.budget.snapshot().consumed.modelCalls, 2);
  assert.equal(fixture.budget.snapshot().consumed.billableTokens, 254);
  assert.equal(fixture.budget.snapshot().reserved.billableTokens, 0);
});

test('question model charges overflow and compiler errors without provider billing and cannot renew elapsed time', async () => {
  for (const failure of ['overflow', 'throw'] as const) {
    let clock = 0;
    const fixture = questionModelFixture({
      runtime: { maxElapsedMsTask: 10 },
      now: () => clock,
      counter: {
        kind: 'controlled',
        countRequest: () => {
          clock += 6;
          if (failure === 'throw') throw new Error('MARKER_SECRET_COUNT_FAILURE');
          return 100_000;
        },
      },
    });
    assert.equal(fixture.model.ok, true);
    if (!fixture.model.ok) continue;
    const signal = new AbortController().signal;
    assert.deepEqual(await fixture.model.value.decide({ question: 'Explain dispatch.' }, signal), {
      status: 'stopped',
      reasonCode: failure === 'overflow' ? 'context-limit' : 'owner-unavailable',
      usage: { status: 'missing' },
    });
    assert.equal(fixture.budget.snapshot().consumed.elapsedMs, 6);
    assert.deepEqual(await fixture.model.value.decide({ question: 'Try again.' }, signal), { status: 'stopped', reasonCode: 'elapsed-deadline', usage: { status: 'missing' } });
    const state = fixture.budget.snapshot();
    assert.equal(state.status, 'exhausted');
    assert.equal(state.consumed.elapsedMs, 10);
    assert.equal(state.consumed.modelCalls, 0);
    assert.equal(state.consumed.billableTokens, 0);
    assert.equal(state.consumed.costMicros, 0);
    assert.equal(state.reserved.billableTokens, 0);
    assert.equal(fixture.requests.length, 0);
  }
});

test('question model charges cancelled compilation and prevents subsequent provider or repository dispatch', async () => {
  let clock = 0;
  const controller = new AbortController();
  const fixture = questionModelFixture({
    runtime: { maxElapsedMsTask: 10 },
    now: () => clock,
    counter: {
      kind: 'controlled',
      countRequest: () => {
        clock += 4;
        controller.abort();
        return 123;
      },
    },
  });
  assert.equal(fixture.model.ok, true);
  if (!fixture.model.ok) return;
  assert.deepEqual(await fixture.model.value.decide({ question: 'Explain dispatch.' }, controller.signal), { status: 'stopped', reasonCode: 'cancelled', usage: { status: 'missing' } });
  assert.equal(fixture.budget.snapshot().status, 'cancelled');
  assert.equal(fixture.budget.snapshot().consumed.elapsedMs, 4);
  assert.equal(fixture.budget.snapshot().consumed.modelCalls, 0);
  assert.equal(fixture.budget.snapshot().consumed.billableTokens, 0);
  assert.equal(fixture.budget.snapshot().reserved.billableTokens, 0);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.budget.reserveRepositoryOperation('read').ok, false);
});

test('question model mandatory context overflow makes zero provider calls and no billable reservation', async () => {
  const fixture = questionModelFixture({ now: () => 0, runtime: { maxInputTokensPerCall: 100 }, counter: { kind: 'controlled', countRequest: request => Buffer.byteLength(request) } });
  assert.equal(fixture.model.ok, true);
  if (!fixture.model.ok) return;
  const before = fixture.budget.snapshot();
  const result = await fixture.model.value.decide(
    { question: 'Explain the dispatch path.', constraints: ['Do not omit this constraint.'], pendingClarification: 'Focus on the synchronous route.' },
    new AbortController().signal,
  );
  assert.deepEqual(result, { status: 'stopped', reasonCode: 'context-limit', usage: { status: 'missing' } });
  assert.equal(fixture.requests.length, 0);
  assert.deepEqual(fixture.budget.snapshot(), before);
});

test('question model projects accumulated evidence deterministically without omitting mandatory intent', async () => {
  const fixture = questionModelFixture({ runtime: { maxInputTokensPerCall: 6_000 }, counter: { kind: 'controlled', countRequest: request => Buffer.byteLength(request) } });
  assert.equal(fixture.model.ok, true);
  if (!fixture.model.ok) return;
  const evidence = [1, 2, 3].map(index => ({ ...span, evidenceId: 'evidence-' + index, excerpt: 'x'.repeat(1_500) }));
  const result = await fixture.model.value.decide({ question: 'Explain dispatch.', constraints: ['Keep current intent.'], evidence }, new AbortController().signal);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.ok(result.visibleEvidenceIds.length > 0);
  assert.ok(result.visibleEvidenceIds.length < evidence.length);
  assert.equal(result.visibleEvidenceIds[0], 'evidence-1');
  const request = fixture.requests[0];
  assert.ok(request);
  assert.ok(request.inputTokens <= 6_000);
  assert.match(request.serialized, /Keep current intent/);
  assert.match(request.serialized, /untrusted-source/);
  assert.doesNotMatch(request.serialized, /evidence-3/);
  const next = await fixture.model.value.decide({ question: 'Explain dispatch.', constraints: ['Keep current intent.'], evidence }, new AbortController().signal);
  assert.equal(next.status, 'ok');
  if (next.status === 'ok') assert.deepEqual(next.visibleEvidenceIds, result.visibleEvidenceIds);
});

test('question model denies a transport without enforced output cap before counting or dispatch', () => {
  let counted = 0;
  const fixture = questionModelFixture({
    cap: false,
    counter: {
      kind: 'controlled',
      countRequest: () => {
        counted += 1;
        return 123;
      },
    },
  });
  assert.deepEqual(fixture.model, { ok: false, reasonCode: 'invalid-config' });
  assert.equal(counted, 0);
  assert.equal(fixture.requests.length, 0);
});

test('question model cancellation during token counting closes the task without provider effects', async () => {
  const controller = new AbortController();
  const fixture = questionModelFixture({
    counter: {
      kind: 'controlled',
      countRequest: () => {
        controller.abort();
        return 123;
      },
    },
  });
  assert.equal(fixture.model.ok, true);
  if (!fixture.model.ok) return;
  const result = await fixture.model.value.decide({ question: 'Explain dispatch.' }, controller.signal);
  assert.deepEqual(result, { status: 'stopped', reasonCode: 'cancelled', usage: { status: 'missing' } });
  assert.equal(fixture.budget.snapshot().status, 'cancelled');
  assert.equal(fixture.requests.length, 0);
});

test('question model preserves missing and unknown usage, holds accounting and blocks subsequent dispatch', async () => {
  for (const usage of [{ status: 'missing' }, { status: 'unknown', reasonCode: 'timeout' }, { status: 'complete', inputTokens: -1, outputTokens: 1 }]) {
    let counts = 0;
    const fixture = questionModelFixture({
      counter: {
        kind: 'controlled',
        countRequest: () => {
          counts += 1;
          return 123;
        },
      },
      send: async () => ({ decision: { kind: 'list', path: '.' }, usage }),
    });
    assert.equal(fixture.model.ok, true);
    if (!fixture.model.ok) continue;
    const result = await fixture.model.value.decide({ question: 'Explain dispatch.' }, new AbortController().signal);
    assert.equal(result.status, 'stopped');
    if (result.status !== 'stopped') continue;
    assert.equal(result.reasonCode, 'accounting-unknown');
    assert.deepEqual(result.usage, usage.status === 'complete' ? { status: 'unknown', reasonCode: 'invalid-metadata' } : usage);
    assert.equal(fixture.budget.snapshot().status, 'blocked');
    assert.equal(fixture.budget.snapshot().reserved.billableTokens, 2_171);
    const next = await fixture.model.value.decide({ question: 'Try again.' }, new AbortController().signal);
    assert.equal(next.status, 'stopped');
    assert.equal(fixture.requests.length, 1);
    assert.equal(counts, 1);
  }
});

test('question model rejects unknown execution decisions while settling known usage without retry', async () => {
  const fixture = questionModelFixture({ send: async () => ({ decision: { kind: 'execute', command: 'python malicious.py' }, usage: { status: 'complete', inputTokens: 123, outputTokens: 4 } }) });
  assert.equal(fixture.model.ok, true);
  if (!fixture.model.ok) return;
  const result = await fixture.model.value.decide({ question: 'Explain dispatch.' }, new AbortController().signal);
  assert.deepEqual(result, { status: 'stopped', reasonCode: 'invalid-decision', usage: { status: 'complete', inputTokens: 123, outputTokens: 4 } });
  assert.equal(fixture.budget.snapshot().consumed.modelCalls, 1);
  assert.equal(fixture.budget.snapshot().reserved.billableTokens, 0);
  assert.equal(fixture.requests.length, 1);
});

test('question model over-cap usage is held and never admitted as a decision', async () => {
  const fixture = questionModelFixture({ send: async () => ({ decision: { kind: 'list', path: '.' }, usage: { status: 'complete', inputTokens: 123, outputTokens: 2_049 } }) });
  assert.equal(fixture.model.ok, true);
  if (!fixture.model.ok) return;
  const result = await fixture.model.value.decide({ question: 'Explain dispatch.' }, new AbortController().signal);
  assert.deepEqual(result, { status: 'stopped', reasonCode: 'over-reservation', usage: { status: 'unknown', reasonCode: 'over-reservation' } });
  assert.equal(fixture.budget.snapshot().status, 'blocked');
  assert.equal(fixture.budget.snapshot().reserved.billableTokens, 2_171);
  assert.equal(fixture.requests.length, 1);
});

test('question model refuses exhausted task admission without an additional transport call', async () => {
  const fixture = questionModelFixture({ runtime: { maxModelCalls: 1 } });
  assert.equal(fixture.model.ok, true);
  if (!fixture.model.ok) return;
  const signal = new AbortController().signal;
  assert.equal((await fixture.model.value.decide({ question: 'Explain dispatch.' }, signal)).status, 'ok');
  assert.deepEqual(await fixture.model.value.decide({ question: 'Explain again.' }, signal), { status: 'stopped', reasonCode: 'model-limit', usage: { status: 'missing' } });
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.budget.snapshot().consumed.modelCalls, 1);
});

test('question model rejects protected context and model-selected authority before any counting or dispatch', async () => {
  let counts = 0;
  const fixture = questionModelFixture({
    counter: {
      kind: 'controlled',
      countRequest: () => {
        counts += 1;
        return 123;
      },
    },
  });
  assert.equal(fixture.model.ok, true);
  if (!fixture.model.ok) return;
  assert.deepEqual(await fixture.model.value.decide({ question: 'MARKER_SECRET_MODEL_CANARY' }, new AbortController().signal), {
    status: 'stopped',
    reasonCode: 'protected-content',
    usage: { status: 'missing' },
  });
  assert.deepEqual(await fixture.model.value.decide({ question: 'Explain dispatch.', providerId: 'model-selected-provider' }, new AbortController().signal), {
    status: 'stopped',
    reasonCode: 'invalid-context',
    usage: { status: 'missing' },
  });
  assert.equal(counts, 0);
  assert.equal(fixture.requests.length, 0);
});

test('question model transport exceptions expose fixed metadata and retain uncertain reservations', async () => {
  const fixture = questionModelFixture({
    send: async () => {
      throw new Error('MARKER_SECRET_PROVIDER_FAILURE');
    },
  });
  assert.equal(fixture.model.ok, true);
  if (!fixture.model.ok) return;
  const result = await fixture.model.value.decide({ question: 'Explain dispatch.' }, new AbortController().signal);
  assert.deepEqual(result, { status: 'stopped', reasonCode: 'accounting-unknown', usage: { status: 'unknown', reasonCode: 'provider-error' } });
  assert.doesNotMatch(JSON.stringify(result), /MARKER_SECRET/);
  assert.equal(fixture.budget.snapshot().status, 'blocked');
  assert.equal(fixture.budget.snapshot().reserved.billableTokens, 2_171);
  assert.equal(fixture.requests.length, 1);
});

test('question model ignores cancelled late responses and preserves the cumulative hold', async () => {
  const controller = new AbortController();
  const fixture = questionModelFixture({
    send: async () => {
      controller.abort();
      return { decision: validAnswer, usage: { status: 'complete', inputTokens: 123, outputTokens: 4 } };
    },
  });
  assert.equal(fixture.model.ok, true);
  if (!fixture.model.ok) return;
  const result = await fixture.model.value.decide({ question: 'Explain dispatch.' }, controller.signal);
  assert.equal(result.status, 'stopped');
  if (result.status === 'stopped') assert.equal(result.reasonCode, 'cancelled');
  assert.equal('decision' in result, false);
  assert.equal(fixture.budget.snapshot().status, 'cancelled');
  assert.equal(fixture.budget.snapshot().reserved.billableTokens, 2_171);
});

test('question model deadline prevents a late answer and leaves no retry path', async () => {
  const pending = Promise.withResolvers<unknown>();
  const fixture = questionModelFixture({ runtime: { maxElapsedMsTask: 20 }, send: async () => pending.promise });
  assert.equal(fixture.model.ok, true);
  if (!fixture.model.ok) return;
  const result = await fixture.model.value.decide({ question: 'Explain dispatch.' }, new AbortController().signal);
  assert.equal(result.status, 'stopped');
  if (result.status === 'stopped') assert.equal(result.reasonCode, 'elapsed-deadline');
  pending.resolve({ decision: validAnswer, usage: { status: 'complete', inputTokens: 123, outputTokens: 4 } });
  const next = await fixture.model.value.decide({ question: 'Try again.' }, new AbortController().signal);
  assert.equal(next.status, 'stopped');
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.budget.snapshot().status, 'exhausted');
  assert.equal('decision' in result, false);
});

test('question model requires an actual host token guarantee for a host transport', () => {
  const ledger = createQuestionBudgetLedger(budgetProfile, { pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 } });
  assert.equal(ledger.ok, true);
  if (!ledger.ok) return;
  const common = {
    identity,
    profile: budgetProfile,
    budget: ledger.value,
    providerId: 'provider',
    modelId: 'model',
    transport: {
      kind: 'host' as const,
      enforcesOutputTokenCap: true as const,
      send: async () => {
        throw new Error('Must not dispatch');
      },
    },
  };
  assert.equal(createQuestionModelPort({ ...common, counter: { kind: 'controlled', countRequest: () => 100 } }).ok, false);
  assert.equal(createQuestionModelPort({ ...common, counter: { kind: 'exact-provider', providerId: 'wrong-provider', modelId: 'model', countRequest: () => 100 } }).ok, false);
  assert.equal(createQuestionModelPort({ ...common, counter: { kind: 'certified-upper-bound', providerId: 'provider', modelId: 'model', countRequest: () => 100 } }).ok, false);
  const unmeteredBudget = new Proxy(ledger.value, { get: (target, key, receiver) => (key === 'runModelCompilation' ? undefined : Reflect.get(target, key, receiver)) });
  assert.equal(createQuestionModelPort({ ...common, budget: unmeteredBudget, counter: { kind: 'exact-provider', providerId: 'provider', modelId: 'model', countRequest: () => 100 } }).ok, false);
});

test('question model rejects a transport cap inconsistent with the ledger reservation', async () => {
  const ledger = createQuestionBudgetLedger(budgetProfile, { pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 } });
  assert.equal(ledger.ok, true);
  if (!ledger.ok) return;
  let calls = 0;
  const model = createQuestionModelPort({
    identity,
    profile: { ...budgetProfile, runtime: { ...budgetProfile.runtime, maxOutputTokensPerCall: 4_096 } },
    budget: ledger.value,
    providerId: 'controlled-provider',
    modelId: 'controlled-model',
    counter: { kind: 'controlled', countRequest: () => 123 },
    transport: {
      kind: 'controlled',
      enforcesOutputTokenCap: true,
      send: async () => {
        calls += 1;
        return { decision: { kind: 'list', path: '.' }, usage: { status: 'complete', inputTokens: 123, outputTokens: 4 } };
      },
    },
  });
  assert.equal(model.ok, true);
  if (!model.ok) return;
  assert.deepEqual(await model.value.decide({ question: 'Explain dispatch.' }, new AbortController().signal), { status: 'stopped', reasonCode: 'owner-unavailable', usage: { status: 'missing' } });
  assert.equal(calls, 0);
  assert.equal(ledger.value.snapshot().reserved.billableTokens, 0);
});

test('question model preserves known usage when the response envelope is malformed', async () => {
  const usage = { status: 'complete', inputTokens: 123, outputTokens: 4 };
  const fixture = questionModelFixture({ send: async () => ({ decision: { kind: 'list', path: '.' }, usage, authority: 'model-selected' }) });
  assert.equal(fixture.model.ok, true);
  if (!fixture.model.ok) return;
  assert.deepEqual(await fixture.model.value.decide({ question: 'Explain dispatch.' }, new AbortController().signal), { status: 'stopped', reasonCode: 'invalid-decision', usage });
});
