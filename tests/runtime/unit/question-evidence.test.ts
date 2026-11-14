import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdmittedSpanV1, QuestionBudgetProfileV1, RepositoryBindingV1, SourceManifestEntryV1, SourceSnapshotV1 } from '../../../src/contracts/questions/contracts.ts';
import { QuestionRepositoryReader } from '../../../src/foundation/question-repository-read.ts';
import type { QuestionRepositoryBindingPort, TrustedQuestionRepositorySnapshotPort } from '../../../src/foundation/repository-types.ts';
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

function makeFixture(maxToolCalls = 5, spanOverrides: Partial<AdmittedSpanV1> = {}, staleAfterChecks?: number, now?: () => number, finalBinding = binding) {
  let bindingChecks = 0;
  let reads = 0;
  const deadlines: number[] = [];
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
        throw new Error('Unexpected legacy binding check');
      },
      async checkBindingBounded(_binding, operationControl) {
        deadlines.push(operationControl.deadlineEpochMs);
        bindingChecks += 1;
        return staleAfterChecks !== undefined && bindingChecks > staleAfterChecks ? { status: 'stale' } : { status: 'ok', binding };
      },
    },
  });
  const budgetResult = createQuestionBudgetLedger(profile(maxToolCalls), {
    pricing: { inputMicrosPerMillionTokens: 100_000, outputMicrosPerMillionTokens: 200_000 },
    ...(now === undefined ? {} : { now }),
  });
  assert.equal(budgetResult.ok, true);
  if (!budgetResult.ok) throw new Error('valid fixture budget was rejected');
  const registryResult = createQuestionEvidenceRegistry({
    identity,
    snapshot,
    repository: {
      ...repository,
      async checkBinding(operationControl) {
        const outcome = await repository.checkBinding(operationControl);
        return outcome.status === 'ok' && bindingChecks > 1 ? { status: 'ok', binding: finalBinding } : outcome;
      },
    },
    budget: budgetResult.value,
    repositoryLimits: profile().repository,
  });
  assert.equal(registryResult.ok, true);
  if (!registryResult.ok) throw new Error('valid fixture evidence context was rejected');
  return { bindingChecks: () => bindingChecks, reads: () => reads, deadlines, repository, budget: budgetResult.value, registry: registryResult.value };
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

test('read and final validation convert ledger time to bounded transport deadlines', async () => {
  const fixture = makeFixture(5, {}, undefined, () => 0);
  const before = Date.now();
  const callerControl = { ...control(), deadlineEpochMs: before + 10_000 };
  const read = await fixture.registry.readSpan({ path: SOURCE_PATH, startLine: 2, endLine: 3 }, callerControl);
  assert.equal(read.status, 'ok');
  if (read.status !== 'ok') return;
  const result = await presentQuestionAnswer(
    fixture.registry,
    {
      claims: [{ claimId: 'claim-1', text: 'A supported fact.', kind: 'observation', evidence: [{ evidenceId: read.span.evidenceId, range: { startLine: 2, endLine: 3 } }] }],
      limitations: [],
    },
    callerControl,
  );
  assert.equal(result.kind, 'delivered');
  const after = Date.now();
  assert.equal(fixture.deadlines.length, 2);
  for (const deadline of fixture.deadlines) {
    assert.ok(deadline >= before + 5_000 && deadline <= after + 5_000, `unexpected transport deadline: ${deadline}`);
  }
});

test('an issued span supports canonical single-line coordinates', async () => {
  const fixture = makeFixture(5, { range: { startLine: 2, endLine: 2 }, excerpt: 'two', excerptDigest: computeFileDigest(Buffer.from('two')) });
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

test('read responses for a different path or range never issue evidence', async () => {
  const requests = [
    { path: 'src/other.py', startLine: 2, endLine: 3 },
    { path: SOURCE_PATH, startLine: 1, endLine: 3 },
    { path: SOURCE_PATH, startLine: 2, endLine: 2 },
  ];
  for (const request of requests) {
    const fixture = makeFixture();
    assert.deepEqual(await fixture.registry.readSpan(request, control()), { status: 'unavailable', reasonCode: 'unsupported-adapter' });
    const presentation = await presentQuestionAnswer(
      fixture.registry,
      { claims: [{ claimId: 'claim-1', text: 'A supported fact.', kind: 'observation', evidence: [{ evidenceId: 'evidence-1', range: { startLine: 2, endLine: 2 } }] }], limitations: [] },
      control(),
    );
    assert.deepEqual(presentation, { kind: 'failed', reasonCode: 'invalid-citation' });
    assert.equal(fixture.reads(), 1);
    assert.equal(fixture.bindingChecks(), 1);
  }
});

test('reads admit an EOF-clamped range or a truncated prefix of the requested lines', async () => {
  const eof = await makeFixture().registry.readSpan({ path: SOURCE_PATH, startLine: 2, endLine: 10 }, control());
  assert.equal(eof.status, 'ok');
  if (eof.status === 'ok') assert.deepEqual(eof.span.range, { startLine: 2, endLine: 3 });

  const truncated = makeFixture(5, {
    range: { startLine: 2, endLine: 2 },
    excerpt: 'two',
    excerptDigest: computeFileDigest(Buffer.from('two')),
    truncation: { kind: 'truncated', nextLine: 3 },
  });
  const result = await truncated.registry.readSpan({ path: SOURCE_PATH, startLine: 2, endLine: 3 }, control());
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') assert.deepEqual(result.span.range, { startLine: 2, endLine: 2 });
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

test('a valid different final binding cannot deliver evidence issued for this run', async () => {
  const current = makeFixture(5, {}, undefined, undefined, { ...binding, workspaceId: 'workspace-2' });
  const read = await current.registry.readSpan({ path: SOURCE_PATH, startLine: 2, endLine: 3 }, control());
  assert.equal(read.status, 'ok');
  const result = await presentQuestionAnswer(
    current.registry,
    {
      claims: [{ claimId: 'claim-1', text: 'A supported fact.', kind: 'observation', evidence: [{ evidenceId: read.span.evidenceId, range: read.span.range }] }],
      limitations: [],
    },
    control(),
  );
  assert.deepEqual(result, { kind: 'stale-repository', reasonCode: 'binding-mismatch' });
});

function makeComposedFixture(maxScannedBytes: number, finalDigestBytes = 0) {
  const effects = { snapshots: 0, opens: 0, digestScans: 0, acquisitionBytes: 0 };
  let finalCheck = false;
  const bindingPort: QuestionRepositoryBindingPort = {
    async checkBinding() {
      throw new Error('Unexpected legacy binding check');
    },
    async checkBindingBounded(expected, operationControl) {
      if (finalCheck) {
        if (!operationControl.work.charge({ scannedFiles: 1, scannedBytes: finalDigestBytes })) return { status: 'exhausted', reasonCode: 'scan-limit' };
        effects.digestScans += 1;
      }
      return { status: 'ok', binding: expected };
    },
  };
  const snapshotPort: TrustedQuestionRepositorySnapshotPort = {
    async acquireSnapshot() {
      throw new Error('Unexpected legacy acquisition');
    },
    async acquireSnapshotBounded({ admissionLimits, control: operationControl }) {
      effects.acquisitionBytes = admissionLimits.maxBytes;
      const acquisition = { scannedFiles: 1, scannedBytes: source.length };
      if (acquisition.scannedBytes > admissionLimits.maxBytes || !operationControl.work.charge(acquisition)) {
        return { status: 'exhausted', reasonCode: 'scan-limit' };
      }
      effects.snapshots += 1;
      return {
        snapshot: { ...snapshot, admissionLimits },
        async readFile(_path: string, maxBytes: number) {
          effects.opens += 1;
          return source.length > maxBytes ? { status: 'oversized', scannedBytes: maxBytes + 1 } : { status: 'ok', bytes: source, scannedBytes: source.length };
        },
      };
    },
  };
  const reader = new QuestionRepositoryReader({
    identity,
    limits: {
      ...profile().repository,
      maxScannedFiles: 100,
      maxScannedBytes: 10_000,
      maxReturnedBytes: 1_000,
      maxCursors: 1,
      contextLinesBefore: 1,
      contextLinesAfter: 1,
    },
    guardCapability: {
      provenance: 'mock',
      capabilityId: 'guard-1',
      workspaceId: binding.workspaceId,
      taskId: identity.taskId,
      async mediateRead(operation) {
        return await operation.execute();
      },
    },
    bindingPort,
    snapshotPort,
    checkReadHold() {
      return undefined;
    },
    async checkPathContainment(path) {
      return { resolvedPath: path };
    },
  });
  const repository = createQuestionRepositoryPort({ binding, bindingPort, reader });
  const options = profile();
  const budget = createQuestionBudgetLedger(
    { ...options, runtime: { ...options.runtime, maxScannedBytes } },
    { pricing: { inputMicrosPerMillionTokens: 100_000, outputMicrosPerMillionTokens: 200_000 } },
  );
  assert.ok(budget.ok);
  const registry = createQuestionEvidenceRegistry({ identity, snapshot, repository, budget: budget.value, repositoryLimits: options.repository });
  assert.ok(registry.ok);
  return {
    registry: registry.value,
    budget: budget.value,
    effects,
    enableFinalDigest: () => {
      finalCheck = true;
    },
  };
}

test('a cold composed reader caps snapshot admission at the ledger scan budget', async () => {
  const { registry, budget, effects } = makeComposedFixture(5);
  assert.deepEqual(await registry.readSpan({ path: SOURCE_PATH, startLine: 2, endLine: 3 }, control()), { status: 'budget-exhausted', reasonCode: 'scan-limit' });
  assert.deepEqual(effects, { snapshots: 0, opens: 0, digestScans: 0, acquisitionBytes: 5 });
  assert.equal(budget.snapshot().consumed.scannedBytes, 0);
});

test('final validation cannot start a composed binding digest beyond the remaining scan budget', async () => {
  const fixture = makeComposedFixture(250, 100);
  const read = await fixture.registry.readSpan({ path: SOURCE_PATH, startLine: 2, endLine: 3 }, control());
  assert.equal(read.status, 'ok');
  assert.equal(fixture.effects.opens, 1);
  const sourceReadBytes = source.length * 3 + Buffer.byteLength(SOURCE_PATH, 'utf8') * 3 + sourceDigest.length;
  assert.equal(fixture.budget.snapshot().consumed.scannedFiles, 3);
  assert.equal(fixture.budget.snapshot().consumed.scannedBytes, sourceReadBytes);
  assert.equal(fixture.budget.snapshot().consumed.returnedBytes, Buffer.byteLength('two\nthree') + Buffer.byteLength(SOURCE_PATH) + 128);
  fixture.enableFinalDigest();
  const result = await presentQuestionAnswer(
    fixture.registry,
    {
      claims: [{ claimId: 'claim-1', text: 'A supported fact.', kind: 'observation', evidence: [{ evidenceId: read.span.evidenceId, range: read.span.range }] }],
      limitations: [],
    },
    control(),
  );
  assert.deepEqual(result, { kind: 'budget-exhausted', reasonCode: 'scan-limit' });
  assert.equal(fixture.budget.snapshot().status, 'exhausted');
  assert.equal(fixture.effects.digestScans, 0);
  assert.equal(fixture.budget.snapshot().consumed.scannedBytes, sourceReadBytes);
});
