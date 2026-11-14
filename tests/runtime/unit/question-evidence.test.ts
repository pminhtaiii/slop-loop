import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdmittedSpanV1, QuestionBudgetProfileV1, RepositoryBindingV1, SourceManifestEntryV1, SourceSnapshotV1 } from '../../../src/contracts/questions/contracts.ts';
import { computeFileDigest } from '../../../src/foundation/docker-workspace-policy.ts';
import { computeSourceManifestDigest } from '../../../src/foundation/question-repository-primitives.ts';
import { createQuestionBudgetLedger } from '../../../src/questions/budget.ts';
import { createQuestionRepositoryPort, type QuestionRepositoryReadPort } from '../../../src/questions/repository.ts';
import { createQuestionEvidenceRegistry } from '../../../src/questions/evidence.ts';
import { presentQuestionAnswer } from '../../../src/questions/presentation.ts';

const DIGEST = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SOURCE_PATH = 'src/[main](draft).py';
const binding: RepositoryBindingV1 = Object.freeze({ repositoryId: 'repo-1', workspaceId: 'workspace-1', revisionDigest: DIGEST, policyDigest: DIGEST });
const identity = Object.freeze({ sessionId: 'session-1', taskId: 'task-1', runId: 'run-1', questionId: 'question-1', binding, configDigest: DIGEST });
const source = Buffer.from('one\ntwo\nthree\n', 'utf8');
const sourceDigest = computeFileDigest(source);
const manifest: readonly SourceManifestEntryV1[] = Object.freeze([{ path: SOURCE_PATH, originalByteDigest: sourceDigest }]);
const snapshot: SourceSnapshotV1 = Object.freeze({
  snapshotId: 'snapshot-1',
  binding,
  manifestDigest: computeSourceManifestDigest(manifest),
  acquisitionId: 'admission-1',
  admissionLimits: Object.freeze({ maxFiles: 1, maxBytes: 128, maxElapsedMs: 1_000 }),
  manifest,
});

function profile(maxToolCalls = 5): QuestionBudgetProfileV1 {
  return {
    schemaVersion: 'question-budget/1',
    runtime: {
      maxToolCalls,
      maxModelCalls: 2,
      maxScannedFiles: 10,
      maxScannedBytes: 1_000,
      maxReturnedBytes: 1_024,
      maxInputTokensPerCall: 2_000,
      maxOutputTokensPerCall: 500,
      maxBillableTokensTask: 7_500,
      maxCostMicrosTask: 100_000,
      maxElapsedMsTask: 5_000,
      maxClarificationRounds: 2,
      maxConversationBytes: 2_000,
      maxFinalBytes: 512,
    },
    repository: {
      maxFileBytes: 128,
      maxSpanBytes: 64,
      maxSpanLines: 8,
      maxPageEntries: 10,
      maxSearchHits: 5,
      maxQueryBytes: 64,
      maxPathBytes: 128,
    },
    retrieval: {
      maxFiles: 5,
      maxChunks: 20,
      maxVectorDimensions: 8,
      maxBatchSize: 2,
      maxConcurrentIndexWriters: 1,
      maxConcurrentRetrievalWorkers: 1,
      maxIndexDiskBytes: 1_000,
      maxSqliteCacheBytes: 512,
      maxWorkerMemoryBytes: 2_000,
      maxExactScanVectors: 10,
      maxIndexDeadlineMs: 1_000,
      maxRetrievalDeadlineMs: 1_000,
    },
  };
}

function makeFixture(maxToolCalls = 5, spanOverrides: Partial<AdmittedSpanV1> = {}, staleAfterChecks?: number) {
  let bindingChecks = 0;
  let reads = 0;
  const span: AdmittedSpanV1 = Object.freeze({
    identity,
    evidenceId: 'evidence-1',
    snapshotId: snapshot.snapshotId,
    manifestDigest: snapshot.manifestDigest,
    path: SOURCE_PATH,
    range: Object.freeze({ startLine: 2, endLine: 3 }),
    excerpt: 'two\nthree',
    excerptDigest: computeFileDigest(Buffer.from('two\nthree', 'utf8')),
    originalByteDigest: sourceDigest,
    truncation: Object.freeze({ kind: 'none' }),
    ...spanOverrides,
  });
  const reader: QuestionRepositoryReadPort = {
    async listDirectory() {
      return { status: 'ok', path: '.', entries: [], coverage: 'complete', omissionReasons: [] };
    },
    async searchLiteral() {
      return { status: 'ok', hits: [], coverage: 'complete', omissionReasons: [] };
    },
    async readSpan() {
      reads += 1;
      return { status: 'ok', span };
    },
  };
  const repository = createQuestionRepositoryPort({
    binding,
    reader,
    bindingPort: {
      async checkBinding() {
        bindingChecks += 1;
        return staleAfterChecks !== undefined && bindingChecks > staleAfterChecks ? { status: 'stale' } : { status: 'ok', binding };
      },
    },
  });
  const budgetResult = createQuestionBudgetLedger(profile(maxToolCalls), {
    pricing: { inputMicrosPerMillionTokens: 100_000, outputMicrosPerMillionTokens: 200_000 },
  });
  assert.equal(budgetResult.ok, true);
  if (!budgetResult.ok) throw new Error('valid fixture budget was rejected');
  const registryResult = createQuestionEvidenceRegistry({
    identity,
    snapshot,
    repository,
    budget: budgetResult.value,
    repositoryLimits: profile().repository,
  });
  assert.equal(registryResult.ok, true);
  if (!registryResult.ok) throw new Error('valid fixture evidence context was rejected');
  return { bindingChecks: () => bindingChecks, reads: () => reads, repository, budget: budgetResult.value, registry: registryResult.value };
}

function control(): { readonly signal: AbortSignal; readonly deadlineEpochMs: number } {
  return { signal: new AbortController().signal, deadlineEpochMs: Date.now() + 2_000 };
}

test('only a guarded issued span can support a canonical source citation', async () => {
  const fixture = makeFixture();
  const read = await fixture.registry.readSpan({ path: SOURCE_PATH, startLine: 2, endLine: 3 }, control());
  assert.equal(read.status, 'ok');
  if (read.status !== 'ok') return;

  const delivered = await presentQuestionAnswer(
    fixture.registry,
    {
      claims: [
        {
          claimId: 'claim-1',
          text: 'The function returns the second and third values.',
          kind: 'observation',
          evidence: [{ evidenceId: read.span.evidenceId, range: { startLine: 2, endLine: 3 } }],
        },
      ],
      limitations: [],
    },
    control(),
  );

  assert.equal(delivered.kind, 'delivered');
  if (delivered.kind !== 'delivered') return;
  assert.ok(delivered.text.includes('`' + SOURCE_PATH + ':L2-L3`'));
  assert.equal(fixture.reads(), 1);
  assert.equal(fixture.bindingChecks(), 2);
  assert.equal(fixture.budget.snapshot().consumed.toolCalls, 2);
});

test('an issued span supports canonical single-line coordinates', async () => {
  const fixture = makeFixture();
  const read = await fixture.registry.readSpan({ path: SOURCE_PATH, startLine: 2, endLine: 2 }, control());
  assert.equal(read.status, 'ok');
  if (read.status !== 'ok') return;
  const result = await presentQuestionAnswer(
    fixture.registry,
    {
      claims: [{ claimId: 'claim-1', text: 'The second line contains this value.', kind: 'observation', evidence: [{ evidenceId: read.span.evidenceId, range: { startLine: 2, endLine: 2 } }] }],
      limitations: [],
    },
    control(),
  );
  assert.equal(result.kind, 'delivered', JSON.stringify(result));
  if (result.kind !== 'delivered') return;
  assert.ok(result.text.includes('`' + SOURCE_PATH + ':L2-L2`'));
  assert.equal(fixture.budget.snapshot().consumed.toolCalls, 2);
});

test('unread, copied, and partially covered citations fail before final validation', async () => {
  const sourceFixture = makeFixture();
  const sourceRead = await sourceFixture.registry.readSpan({ path: SOURCE_PATH, startLine: 2, endLine: 3 }, control());
  assert.equal(sourceRead.status, 'ok');
  if (sourceRead.status !== 'ok') return;

  const cases = [
    { evidenceId: 'forged-evidence', range: { startLine: 2, endLine: 2 } },
    { evidenceId: sourceRead.span.evidenceId, range: { startLine: 1, endLine: 3 } },
  ];
  for (const evidence of cases) {
    const fixture = makeFixture();
    const result = await presentQuestionAnswer(
      fixture.registry,
      {
        claims: [{ claimId: 'claim-1', text: 'A supported fact.', kind: 'observation', evidence: [evidence] }],
        limitations: [],
      },
      control(),
    );
    assert.deepEqual(result, { kind: 'failed', reasonCode: 'invalid-citation' });
    assert.equal(fixture.bindingChecks(), 0);
    assert.equal(fixture.budget.snapshot().consumed.toolCalls, 0);
  }
});

test('wrong task, revision, snapshot bytes, or excerpt digest cannot issue evidence', async () => {
  const wrongTask = Object.freeze({ ...identity, taskId: 'other-task' });
  const wrongRevision = Object.freeze({ ...identity, binding: Object.freeze({ ...binding, revisionDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }) });
  const cases: readonly Partial<AdmittedSpanV1>[] = [
    { identity: wrongTask },
    { identity: wrongRevision },
    { snapshotId: 'snapshot-other' },
    { originalByteDigest: computeFileDigest(Buffer.from('different source', 'utf8')) },
    { excerptDigest: DIGEST },
  ];
  for (const override of cases) {
    const fixture = makeFixture(5, override);
    const result = await fixture.registry.readSpan({ path: SOURCE_PATH, startLine: 2, endLine: 3 }, control());
    assert.notEqual(result.status, 'ok');
    assert.equal(fixture.budget.snapshot().consumed.toolCalls, 1);
  }
});

test('final binding recheck is separately reserved and exhaustion returns no claims without IO', async () => {
  const exhausted = makeFixture(1);
  const read = await exhausted.registry.readSpan({ path: SOURCE_PATH, startLine: 2, endLine: 3 }, control());
  assert.equal(read.status, 'ok');
  if (read.status !== 'ok') return;
  const citation = { evidenceId: read.span.evidenceId, range: { startLine: 2, endLine: 3 } };
  const result = await presentQuestionAnswer(
    exhausted.registry,
    {
      claims: [{ claimId: 'claim-1', text: 'A supported fact.', kind: 'observation', evidence: [citation] }],
      limitations: [],
    },
    control(),
  );
  assert.deepEqual(result, { kind: 'budget-exhausted', reasonCode: 'tool-limit' });
  assert.equal(exhausted.bindingChecks(), 1);
  assert.equal(exhausted.budget.snapshot().consumed.toolCalls, 1);

  const stale = makeFixture(5, {}, 1);
  const staleRead = await stale.registry.readSpan({ path: SOURCE_PATH, startLine: 2, endLine: 3 }, control());
  assert.equal(staleRead.status, 'ok');
  if (staleRead.status !== 'ok') return;
  const staleResult = await presentQuestionAnswer(
    stale.registry,
    {
      claims: [{ claimId: 'claim-1', text: 'A supported fact.', kind: 'observation', evidence: [{ evidenceId: staleRead.span.evidenceId, range: { startLine: 2, endLine: 3 } }] }],
      limitations: [],
    },
    control(),
  );
  assert.deepEqual(staleResult, { kind: 'stale-repository', reasonCode: 'binding-mismatch' });
  assert.equal(stale.bindingChecks(), 2);
});

test('presentation sanitizes model prose and excludes unrecognized trace metadata', async () => {
  const fixture = makeFixture();
  const read = await fixture.registry.readSpan({ path: SOURCE_PATH, startLine: 2, endLine: 3 }, control());
  assert.equal(read.status, 'ok');
  if (read.status !== 'ok') return;
  const result = await presentQuestionAnswer(
    fixture.registry,
    {
      claims: [
        {
          claimId: 'claim-1',
          text: 'First line\nsecond [line]',
          kind: 'observation',
          evidence: [{ evidenceId: read.span.evidenceId, range: { startLine: 2, endLine: 3 } }],
        },
      ],
      limitations: [],
      traceBody: 'RAW TRACE BODY MUST NOT LEAK',
    },
    control(),
  );
  assert.equal(result.kind, 'delivered');
  if (result.kind !== 'delivered') return;
  assert.equal(result.text.includes('First line second \\[line\\]'), true);
  assert.ok(result.text.includes('`' + SOURCE_PATH + ':L2-L3`'));
  assert.equal(result.text.includes('RAW TRACE BODY MUST NOT LEAK'), false);
});

test('protected final prose is withheld before any final binding check', async () => {
  const fixture = makeFixture();
  const read = await fixture.registry.readSpan({ path: SOURCE_PATH, startLine: 2, endLine: 3 }, control());
  assert.equal(read.status, 'ok');
  if (read.status !== 'ok') return;
  const result = await presentQuestionAnswer(
    fixture.registry,
    {
      claims: [{ claimId: 'claim-1', text: 'MARKER_SECRET hidden-value', kind: 'observation', evidence: [{ evidenceId: read.span.evidenceId, range: { startLine: 2, endLine: 3 } }] }],
      limitations: [],
    },
    control(),
  );
  assert.deepEqual(result, { kind: 'failed', reasonCode: 'protected-content' });
  assert.equal(fixture.bindingChecks(), 1);
});

test('oversized rendered output is refused without final repository IO', async () => {
  const fixture = makeFixture();
  const read = await fixture.registry.readSpan({ path: SOURCE_PATH, startLine: 2, endLine: 3 }, control());
  assert.equal(read.status, 'ok');
  if (read.status !== 'ok') return;
  const result = await presentQuestionAnswer(
    fixture.registry,
    {
      claims: [
        {
          claimId: 'claim-1',
          text: 'x'.repeat(600),
          kind: 'observation',
          evidence: [{ evidenceId: read.span.evidenceId, range: { startLine: 2, endLine: 3 } }],
        },
      ],
      limitations: [],
    },
    control(),
  );
  assert.deepEqual(result, { kind: 'failed', reasonCode: 'render-limit' });
  assert.equal(fixture.bindingChecks(), 1);
  assert.equal(fixture.budget.snapshot().consumed.toolCalls, 1);
  assert.equal(fixture.budget.snapshot().reserved.finalBytes, 0);
});
