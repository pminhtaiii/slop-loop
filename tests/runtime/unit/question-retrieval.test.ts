import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QuestionIndexedChunkV1, QuestionIndexGenerationV1, SourceSnapshotV1, SpanResultV1 } from '../../../src/contracts/questions/contracts.ts';
import { computeFileDigest as digest } from '../../../src/foundation/docker-workspace-policy.ts';
import { computeSourceManifestDigest } from '../../../src/foundation/question-repository-primitives.ts';
import { createQuestionBudgetLedger } from '../../../src/questions/budget.ts';
import { createControlledQuestionEmbedding } from '../../../src/questions/embedding.ts';
import { createQuestionRetrieval } from '../../../src/questions/retrieval.ts';
import { createQuestionIndex, type QuestionIndexRow } from '../../../src/questions/index.ts';
import type { QuestionRepositoryOperationControl } from '../../../src/foundation/repository-types.ts';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const limits = {
  maxFiles: 20,
  maxChunks: 100,
  maxVectorDimensions: 2,
  maxBatchSize: 8,
  maxConcurrentIndexWriters: 1,
  maxConcurrentRetrievalWorkers: 1,
  maxIndexDiskBytes: 1_000_000,
  maxSqliteCacheBytes: 64000,
  maxWorkerMemoryBytes: 64_000_000,
  maxExactScanVectors: 100,
  maxIndexDeadlineMs: 20000,
  maxRetrievalDeadlineMs: 10000,
};
const repositoryLimits = { maxFileBytes: 20000, maxSpanBytes: 4096, maxSpanLines: 60, maxPageEntries: 100, maxSearchHits: 20, maxQueryBytes: 1000, maxPathBytes: 500 };
const control = () => ({ signal: new AbortController().signal, deadlineEpochMs: Date.now() + 10000 });
function fixture(names = ['zeta', 'eta', 'beta', 'gamma', 'delta', 'alpha', 'theta']) {
  const binding = { repositoryId: 'repo', workspaceId: 'workspace', revisionDigest: digest('revision'), policyDigest: digest('policy') };
  const identity = { sessionId: 'session', taskId: 'task', runId: 'run', questionId: 'question', binding, configDigest: digest('config') };
  const texts = new Map(names.map(name => [`${name}.py`, `def ${name}():\n    return 1`]));
  const manifest = [...texts].map(([path, text]) => ({ path, originalByteDigest: digest(text) })).sort((a, b) => (a.path < b.path ? -1 : 1));
  const snapshot: SourceSnapshotV1 = {
    snapshotId: 'snapshot',
    binding,
    manifestDigest: computeSourceManifestDigest(manifest),
    acquisitionId: 'acquired',
    admissionLimits: { maxFiles: 20, maxBytes: 100000, maxElapsedMs: 10000 },
    manifest,
  };
  const generation: QuestionIndexGenerationV1 = {
    schemaVersion: 'question-retrieval/1',
    generationId: 'generation',
    binding,
    snapshotId: snapshot.snapshotId,
    manifestDigest: snapshot.manifestDigest,
    configDigest: identity.configDigest,
    embeddingDigest: digest('embedding'),
    coverage: 'complete',
  };
  const rows: QuestionIndexRow[] = names.map((name, index) => {
    const path = `${name}.py`,
      text = texts.get(path) ?? '';
    const metadata: QuestionIndexedChunkV1 = {
      schemaVersion: 'question-retrieval/1',
      chunkId: `chunk-${index}`,
      path,
      fileType: 'python-source',
      kind: 'definition',
      symbolName: name,
      qualifiedSymbolName: name,
      startLine: 1,
      endLine: 2,
      originalByteDigest: digest(text),
      excerptDigest: digest(text),
      normalizedByteLength: Buffer.byteLength(text),
      vectorId: digest(JSON.stringify([`chunk-${index}`, 'controlled/1'])),
      definition: { definitionId: `definition-${index}`, qualifiedName: name, startLine: 1, endLine: 2, partOrder: 0 },
    };
    return { metadata, vector: [1, 0], embeddingInputTokens: 2 };
  });
  let reads = 0,
    scans = 0,
    embeds = 0,
    current = true;
  const budgetResult = createQuestionBudgetLedger(
    {
      schemaVersion: 'question-budget/1',
      runtime: {
        maxToolCalls: 100,
        maxModelCalls: 5,
        maxScannedFiles: 1000,
        maxScannedBytes: 10000000,
        maxReturnedBytes: 1000000,
        maxInputTokensPerCall: 2000,
        maxOutputTokensPerCall: 500,
        maxBillableTokensTask: 100000,
        maxCostMicrosTask: 1000000,
        maxElapsedMsTask: 120000,
        maxClarificationRounds: 2,
        maxConversationBytes: 10000,
        maxFinalBytes: 4000,
      },
      repository: repositoryLimits,
      retrieval: limits,
    },
    { pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 } },
  );
  assert.ok(budgetResult.ok);
  const repository = {
    async checkBinding() {
      return current ? { status: 'ok' as const, binding } : { status: 'stale' as const, reasonCode: 'binding-mismatch' as const };
    },
    async readSpan(request: { path: string; startLine: number; endLine: number }): Promise<SpanResultV1> {
      reads++;
      const text = texts.get(request.path) ?? '';
      if (request.startLine > text.split('\n').length) return { status: 'invalid', reasonCode: 'out-of-range' };
      const excerpt = text
        .split('\n')
        .slice(request.startLine - 1, request.endLine)
        .join('\n');
      return {
        status: 'ok' as const,
        span: {
          identity,
          evidenceId: `evidence-${reads}`,
          snapshotId: snapshot.snapshotId,
          manifestDigest: snapshot.manifestDigest,
          path: request.path,
          range: { startLine: request.startLine, endLine: request.endLine },
          excerpt,
          excerptDigest: digest(excerpt),
          originalByteDigest: digest(text),
          truncation: { kind: 'none' as const },
        },
      };
    },
    async listDirectory() {
      return { status: 'ok' as const, path: '.', entries: [], coverage: 'complete' as const, omissionReasons: [] };
    },
    async searchLiteral() {
      scans++;
      return { status: 'ok' as const, hits: [], coverage: 'complete' as const, omissionReasons: [] };
    },
  };
  const options = {
    identity,
    snapshot,
    embeddingDigest: digest('embedding'),
    generationId: generation.generationId,
    limits,
    repositoryLimits,
    budget: budgetResult.value,
    embedding: createControlledQuestionEmbedding(
      { id: 'controlled/1', dimension: 2, maxTokens: 512 },
      () => [1, 2],
      () => {
        embeds++;
        return [1, 0];
      },
    ),
    repository,
    index: {
      async read() {
        return current
          ? { status: 'ok' as const, generation, files: manifest.map(file => ({ ...file, fileType: 'python-source' as const, coverage: 'complete' as const, omissionReasons: [] })), chunks: rows }
          : { status: 'stale' as const, reasonCode: 'binding-mismatch' as const };
      },
      async validateCurrent() {
        return current ? { status: 'ok' as const } : { status: 'stale' as const, reasonCode: 'binding-mismatch' as const };
      },
    },
  };
  return {
    options,
    identity,
    snapshot,
    generation,
    rows,
    texts,
    budget: budgetResult.value,
    counts: () => ({ reads, scans, embeds }),
    stale: () => {
      current = false;
    },
  };
}

test('semantic ties rank the entire generation deterministically before top five without source reads', async () => {
  const f = fixture();
  const retrieval = createQuestionRetrieval(f.options);
  const result = await retrieval.rank({ schemaVersion: 'question-retrieval/1', identity: f.identity, generationId: 'generation', queryText: 'describe behavior', limits }, control());
  assert.equal(result.status, 'complete');
  if (result.status !== 'complete') return;
  assert.deepEqual(
    result.ranked.map(hit => hit.path),
    ['alpha.py', 'beta.py', 'delta.py', 'eta.py', 'gamma.py'],
  );
  assert.deepEqual(
    result.ranked.map(hit => hit.lane),
    Array(5).fill('semantic'),
  );
  assert.deepEqual(f.counts(), { reads: 0, scans: 0, embeds: 1 });
});

test('exact definition tiers preserve whole Unicode names and ignore unknown qualified components', async () => {
  const cases: readonly [string, readonly string[]][] = [
    ['...gamma..., alpha', ['alpha.py', 'gamma.py']],
    ['gamma alpha alpha', ['alpha.py', 'gamma.py']],
    ['alpha gamma', ['alpha.py', 'gamma.py']],
    ['Missing.gamma', ['alpha.py', 'a·b.py']],
    ['gammA', ['alpha.py', 'a·b.py']],
    ['2gamma', ['alpha.py', 'a·b.py']],
    ['·gamma', ['alpha.py', 'a·b.py']],
    ['(a·b)', ['a·b.py', 'alpha.py']],
  ];
  for (const [query, expected] of cases) {
    const f = fixture(['gamma', 'zeta', 'a·b', 'alpha', 'eta', 'theta']);
    const retrieval = createQuestionRetrieval(f.options);
    const result = await retrieval.rank({ schemaVersion: 'question-retrieval/1', identity: f.identity, generationId: 'generation', queryText: query, limits }, control());
    assert.equal(result.status, 'complete', query);
    if (result.status === 'complete')
      assert.deepEqual(
        result.ranked.slice(0, 2).map(hit => hit.path),
        expected,
        query,
      );
  }
});

test('ranked provenance is privately issued and guarded before evidence admission', async () => {
  const f = fixture(['alpha']);
  const retrieval = createQuestionRetrieval(f.options);
  const result = await retrieval.rank({ schemaVersion: 'question-retrieval/1', identity: f.identity, generationId: 'generation', queryText: 'alpha', limits }, control());
  assert.equal(result.status, 'complete');
  if (result.status !== 'complete') return;
  assert.equal((await retrieval.admit(structuredClone(result), 'chunk-0', control())).status, 'invalid');
  assert.equal(f.counts().reads, 0);
  const admitted = await retrieval.admit(result, 'chunk-0', control());
  assert.equal(admitted.status, 'ok');
  if (admitted.status === 'ok') {
    assert.equal(admitted.span.path, 'alpha.py');
    assert.equal(admitted.span.excerpt, 'def alpha():\n    return 1');
  }
  f.stale();
  assert.equal((await retrieval.admit(result, 'chunk-0', control())).status, 'stale');
  assert.equal(f.counts().reads, 1);
});

test('a ranked chunk cannot admit source changed behind its digest or truncated coordinates', async () => {
  const f = fixture(['alpha']);
  const retrieval = createQuestionRetrieval(f.options);
  const result = await retrieval.rank({ schemaVersion: 'question-retrieval/1', identity: f.identity, generationId: 'generation', queryText: 'alpha', limits }, control());
  f.texts.set('alpha.py', 'def alpha():\n    return 99');
  assert.equal((await retrieval.admit(result, 'chunk-0', control())).status, 'stale');
});

test('only complete host-selected static scope can issue a fresh absence receipt', async () => {
  const f = fixture(['alpha']);
  const retrieval = createQuestionRetrieval({ ...f.options, staticLookup: 'missing' });
  await retrieval.rank({ schemaVersion: 'question-retrieval/1', identity: f.identity, generationId: 'generation', queryText: 'is missing defined?', limits }, control());
  const absent = await retrieval.proveAbsence(control());
  assert.equal(absent.status, 'ok');
  if (absent.status !== 'ok') return;
  assert.deepEqual(absent.receipt.scope, ['alpha.py']);
  assert.equal(absent.receipt.normalizedQueryDigest, digest('is missing defined?'));
  assert.equal((await retrieval.validateAbsence(structuredClone(absent.receipt), control())).status, 'invalid');
  assert.equal((await retrieval.validateAbsence(absent.receipt, control())).status, 'ok');
  f.stale();
  assert.equal((await retrieval.validateAbsence(absent.receipt, control())).status, 'stale');
  const behavior = fixture(['alpha']);
  const behavioral = createQuestionRetrieval(behavior.options);
  assert.equal((await behavioral.proveAbsence(control())).status, 'insufficient');
  assert.equal(behavior.counts().scans, 0);
});

test('absence freshness validation preserves the bounded work meter and cumulative scan charges', async () => {
  const f = fixture(['alpha']);
  const retrieval = createQuestionRetrieval({
    ...f.options,
    staticLookup: 'missing',
    repository: {
      ...f.options.repository,
      async checkBinding(bounded: QuestionRepositoryOperationControl) {
        assert.ok(bounded.work);
        assert.ok(bounded.work.charge({ scannedFiles: 1, scannedBytes: 1 }));
        return { status: 'ok', binding: f.identity.binding };
      },
    },
  });
  await retrieval.rank({ schemaVersion: 'question-retrieval/1', identity: f.identity, generationId: 'generation', queryText: 'missing', limits }, control());
  const absent = await retrieval.proveAbsence(control());
  assert.equal(absent.status, 'ok');
  if (absent.status !== 'ok') return;
  assert.equal((await retrieval.validateAbsence(absent.receipt, control())).status, 'ok');
  assert.ok(f.budget.snapshot().consumed.scannedFiles >= 2);
});

test('qualified tier beats simple and semantic scores without promoting literal occurrences', async () => {
  const f = fixture(['alpha', 'beta', 'gamma']);
  const beta = f.rows[1];
  assert.ok(beta);
  const alpha = f.rows[0];
  assert.ok(alpha);
  f.rows[0] = { ...alpha, vector: [0, 1] };
  f.rows[1] = {
    ...beta,
    vector: [-1, 0],
    metadata: {
      ...beta.metadata,
      symbolName: 'alpha',
      qualifiedSymbolName: 'Box.alpha',
      definition: { definitionId: 'box-alpha', qualifiedName: 'Box.alpha', startLine: 1, endLine: 2, partOrder: 0 },
    },
  };
  const gamma = f.rows[2];
  assert.ok(gamma);
  f.rows[2] = { ...gamma, metadata: { ...gamma.metadata, kind: 'module-text', symbolName: null, qualifiedSymbolName: null, definition: null } };
  const retrieval = createQuestionRetrieval(f.options);
  const result = await retrieval.rank({ schemaVersion: 'question-retrieval/1', identity: f.identity, generationId: 'generation', queryText: 'Box.alpha alpha gamma', limits }, control());
  assert.equal(result.status, 'complete');
  if (result.status !== 'complete') return;
  assert.deepEqual(
    result.ranked.map(hit => [hit.path, hit.lane, hit.score]),
    [
      ['beta.py', 'exact-qualified', -1],
      ['alpha.py', 'exact-simple', 0],
      ['gamma.py', 'semantic', 1],
    ],
  );
});

test('real disk index feeds hybrid ranking and the owning registry delivers a checked citation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'question-retrieval-'));
  const target = join(directory, 'target');
  await mkdir(target);
  const f = fixture(['alpha']);
  const index = createQuestionIndex({
    databasePath: join(directory, 'index.sqlite'),
    targetRoots: [target],
    limits,
    embedding: f.options.embedding,
    budget: f.budget,
    configDigest: f.identity.configDigest,
    embeddingDigest: f.options.embeddingDigest,
    authorize: async () => true,
  });
  try {
    const sources = f.snapshot.manifest.map(file => ({
      file: { ...file, fileType: 'python-source' as const, lineCount: 2 },
      binding: f.identity.binding,
      snapshotId: f.snapshot.snapshotId,
      manifestDigest: f.snapshot.manifestDigest,
      repository: f.options.repository,
      pageLines: 60,
      maxSourceBytes: 20000,
      maxChunks: 100,
    }));
    const synced = await index.synchronize({ snapshot: f.snapshot, sources, expectedGenerationId: null }, control());
    assert.equal(synced.status, 'ok');
    if (synced.status !== 'ok') return;
    const retrieval = createQuestionRetrieval({ ...f.options, index, generationId: synced.generation.generationId });
    const result = await retrieval.rank({ schemaVersion: 'question-retrieval/1', identity: f.identity, generationId: synced.generation.generationId, queryText: 'alpha', limits }, control());
    assert.equal(result.status, 'complete');
    if (result.status !== 'complete') return;
    const hit = result.ranked[0];
    assert.ok(hit);
    const admitted = await retrieval.admit(result, hit.chunkId, control());
    assert.equal(admitted.status, 'ok');
    if (admitted.status !== 'ok') return;
    const proposal = {
      kind: 'answer',
      claims: [{ claimId: 'claim', kind: 'observation', text: 'alpha returns one', evidence: [{ evidenceId: admitted.span.evidenceId, range: { startLine: 1, endLine: 2 } }] }],
      limitations: [],
    };
    const readsBeforePresentation = f.counts().reads;
    const presented = await retrieval.present(proposal, control());
    assert.equal(presented.kind, 'delivered');
    if (presented.kind === 'delivered') assert.ok(presented.text.includes('alpha.py:L1-L2'));
    assert.deepEqual(await retrieval.present({ claims: [], limitations: [] }, control()), { kind: 'failed', reasonCode: 'invalid-citation' });
    assert.equal(f.counts().reads, readsBeforePresentation);
    retrieval.close();
    assert.equal((await retrieval.admit(result, hit.chunkId, control())).status, 'unavailable');
  } finally {
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('incomplete complete-generation scan exposes no scored list while an empty generation is distinct', async () => {
  const f = fixture();
  const retrieval = createQuestionRetrieval(f.options);
  const exhausted = await retrieval.rank(
    { schemaVersion: 'question-retrieval/1', identity: f.identity, generationId: 'generation', queryText: 'alpha', limits: { ...limits, maxExactScanVectors: 2 } },
    control(),
  );
  assert.equal(exhausted.status, 'exhausted');
  assert.ok(!('ranked' in exhausted));
  assert.equal(f.counts().embeds, 0);
  const empty = fixture([]);
  const completed = await createQuestionRetrieval(empty.options).rank(
    { schemaVersion: 'question-retrieval/1', identity: empty.identity, generationId: 'generation', queryText: 'missing', limits },
    control(),
  );
  assert.equal(completed.status, 'empty');
  if (completed.status === 'empty') assert.deepEqual(completed.ranked, []);
});

test('cancelled exhausted closed and token-overflow admission starts no index or embedding effects', async () => {
  for (const mode of ['cancelled', 'deadline', 'closed', 'overflow'] as const) {
    const f = fixture(['alpha']);
    let indexReads = 0;
    const options = {
      ...f.options,
      index: {
        ...f.options.index,
        async read() {
          indexReads++;
          return f.options.index.read();
        },
      },
      ...(mode === 'overflow'
        ? {
            embedding: createControlledQuestionEmbedding(
              { id: 'tiny', dimension: 2, maxTokens: 1 },
              () => [1, 2],
              () => {
                throw new Error('Forbidden inference');
              },
            ),
          }
        : {}),
    };
    const retrieval = createQuestionRetrieval(options);
    if (mode === 'cancelled') f.budget.cancel();
    if (mode === 'closed') retrieval.close();
    const result = await retrieval.rank(
      { schemaVersion: 'question-retrieval/1', identity: f.identity, generationId: 'generation', queryText: 'alpha', limits },
      mode === 'deadline' ? { ...control(), deadlineEpochMs: Date.now() - 1 } : control(),
    );
    assert.ok(['cancelled', 'exhausted', 'unavailable'].includes(result.status), mode);
    assert.ok(!('ranked' in result));
    assert.equal(indexReads, 0, mode);
    assert.equal(f.counts().embeds, 0, mode);
  }
});

test('partial literal scans and parse coverage gaps never become scoped absence', async () => {
  for (const mode of ['partial', 'parse'] as const) {
    const f = fixture(['alpha']);
    const options = {
      ...f.options,
      staticLookup: 'missing',
      ...(mode === 'partial'
        ? {
            repository: {
              ...f.options.repository,
              async searchLiteral() {
                return { status: 'ok' as const, coverage: 'partial' as const, omissionReasons: ['scan-limit' as const], hits: [] };
              },
            },
          }
        : {
            index: {
              ...f.options.index,
              async read() {
                const result = await f.options.index.read();
                return result.status === 'ok'
                  ? {
                      ...result,
                      generation: { ...result.generation, coverage: 'partial' as const },
                      files: result.files.map(file => ({ ...file, coverage: 'partial' as const, omissionReasons: ['parse-failure' as const] })),
                    }
                  : result;
              },
            },
          }),
    };
    const retrieval = createQuestionRetrieval(options);
    await retrieval.rank({ schemaVersion: 'question-retrieval/1', identity: f.identity, generationId: 'generation', queryText: 'missing', limits }, control());
    const absence = await retrieval.proveAbsence(control());
    assert.equal(absence.status, 'insufficient', mode);
    assert.ok(!('receipt' in absence));
  }
});

test('model request paths cannot narrow host absence scope and exact definitions prevent absence', async () => {
  const f = fixture(['alpha', 'beta']);
  const retrieval = createQuestionRetrieval({ ...f.options, staticLookup: 'alpha' });
  const forged = await retrieval.rank({ schemaVersion: 'question-retrieval/1', identity: f.identity, generationId: 'generation', queryText: 'alpha', limits, scope: ['beta.py'] }, control());
  assert.equal(forged.status, 'invalid');
  await retrieval.rank({ schemaVersion: 'question-retrieval/1', identity: f.identity, generationId: 'generation', queryText: 'alpha', limits }, control());
  const result = await retrieval.proveAbsence(control());
  assert.equal(result.status, 'insufficient');
  if (result.status === 'insufficient') assert.equal(result.reasonCode, 'matches-found');
  assert.equal(f.counts().scans, 0);
});

test('identical chunk identities deduplicate before cutoff and conflicting provenance refuses all ranking', async () => {
  const f = fixture();
  const row = f.rows[0];
  assert.ok(row);
  f.rows.push(structuredClone(row));
  const result = await createQuestionRetrieval(f.options).rank({ schemaVersion: 'question-retrieval/1', identity: f.identity, generationId: 'generation', queryText: 'behavior', limits }, control());
  assert.equal(result.status, 'complete');
  if (result.status === 'complete') assert.equal(new Set(result.ranked.map(hit => hit.chunkId)).size, 5);
  const corrupt = fixture(['alpha']);
  const first = corrupt.rows[0];
  assert.ok(first);
  corrupt.rows.push({ ...first, metadata: { ...first.metadata, excerptDigest: digest('wrong') } });
  const refused = await createQuestionRetrieval(corrupt.options).rank(
    { schemaVersion: 'question-retrieval/1', identity: corrupt.identity, generationId: 'generation', queryText: 'alpha', limits },
    control(),
  );
  assert.equal(refused.status, 'stale');
  assert.ok(!('ranked' in refused));
});

test('cancelling a held query ignores late embedding and performs no final index validation', async () => {
  const f = fixture(['alpha']);
  const started = Promise.withResolvers<undefined>(),
    gate = Promise.withResolvers<readonly number[]>();
  let validations = 0;
  const retrieval = createQuestionRetrieval({
    ...f.options,
    index: {
      ...f.options.index,
      async validateCurrent() {
        validations++;
        return f.options.index.validateCurrent();
      },
    },
    embedding: createControlledQuestionEmbedding(
      { id: 'controlled/1', dimension: 2, maxTokens: 512 },
      () => [1, 2],
      async () => {
        started.resolve(undefined);
        return gate.promise;
      },
    ),
  });
  const pending = retrieval.rank({ schemaVersion: 'question-retrieval/1', identity: f.identity, generationId: 'generation', queryText: 'alpha', limits }, control());
  await started.promise;
  f.budget.cancel();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.ok(!('ranked' in result));
  gate.resolve([1, 0]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(validations, 0);
  assert.equal(f.counts().reads, 0);
});
