import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AdmittedSpanV1,
  QuestionBudgetProfileV1,
  QuestionIndexedChunkV1,
  QuestionIndexGenerationV1,
  QuestionModelDecisionV1,
  QuestionRuntimeBudgetV1,
  SourceSnapshotV1,
} from '../../../src/contracts/questions/contracts.ts';
import { computeFileDigest as digest } from '../../../src/foundation/docker-workspace-policy.ts';
import { computeSourceManifestDigest } from '../../../src/foundation/question-repository-primitives.ts';
import { createQuestionBudgetLedger } from '../../../src/questions/budget.ts';
import { createControlledQuestionEmbedding } from '../../../src/questions/embedding.ts';
import { createQuestionInvestigation } from '../../../src/questions/graph.ts';
import type { QuestionCompiledRequestV1 } from '../../../src/questions/model.ts';
import type { QuestionIndexRow } from '../../../src/questions/index.ts';
import type { QuestionRepositoryPort } from '../../../src/questions/repository.ts';
import { guardedRetrievalRepository } from '../support/questions/retrieval-guarded-fixture.ts';

const control = () => ({ signal: new AbortController().signal, deadlineEpochMs: Date.now() + 20000 });
interface VisibleContext {
  readonly evidence: { readonly spans: readonly AdmittedSpanV1[] };
  readonly observations: { readonly items: readonly string[] };
}
type Step = (context: VisibleContext) => unknown;

function fixture(
  steps: readonly Step[],
  texts = new Map([
    ['entry.py', 'def start():\n    return process()'],
    ['process.py', 'def process():\n    return recover()'],
    ['recover.py', 'def recover():\n    return "safe"'],
  ]),
  chunks: readonly { path: string; startLine: number; endLine: number; symbol: string; definitionEnd?: number }[] = [{ path: 'entry.py', startLine: 1, endLine: 2, symbol: 'start' }],
  runtimeOverrides: Partial<QuestionRuntimeBudgetV1> = {},
) {
  const binding = { repositoryId: 'repo', workspaceId: 'workspace', revisionDigest: digest('revision'), policyDigest: digest('policy') };
  const identity = { sessionId: 'session', taskId: 'task', runId: 'run', questionId: 'question', binding, configDigest: digest('config') };
  const manifest = [...texts].map(([path, text]) => ({ path, originalByteDigest: digest(text) })).sort((a, b) => (a.path < b.path ? -1 : 1));
  const snapshot: SourceSnapshotV1 = {
    snapshotId: 'snapshot',
    binding,
    manifestDigest: computeSourceManifestDigest(manifest),
    acquisitionId: 'acquired',
    admissionLimits: { maxFiles: 20, maxBytes: 100000, maxElapsedMs: 1000 },
    manifest,
  };
  const profile: QuestionBudgetProfileV1 = {
    schemaVersion: 'question-budget/1',
    runtime: {
      maxToolCalls: 100,
      maxModelCalls: 20,
      maxScannedFiles: 10000,
      maxScannedBytes: 10000000,
      maxReturnedBytes: 1000000,
      maxInputTokensPerCall: 30000,
      maxOutputTokensPerCall: 1000,
      maxBillableTokensTask: 1000000,
      maxCostMicrosTask: 1000000,
      maxElapsedMsTask: 120000,
      maxClarificationRounds: 2,
      maxConversationBytes: 15000,
      maxFinalBytes: 10000,
      ...runtimeOverrides,
    },
    repository: { maxFileBytes: 20000, maxSpanBytes: 4096, maxSpanLines: 60, maxPageEntries: 100, maxSearchHits: 20, maxQueryBytes: 1000, maxPathBytes: 500 },
    retrieval: {
      maxFiles: 20,
      maxChunks: 100,
      maxVectorDimensions: 2,
      maxBatchSize: 8,
      maxConcurrentIndexWriters: 1,
      maxConcurrentRetrievalWorkers: 1,
      maxIndexDiskBytes: 1000000,
      maxSqliteCacheBytes: 64000,
      maxWorkerMemoryBytes: 64000000,
      maxExactScanVectors: 100,
      maxIndexDeadlineMs: 20000,
      maxRetrievalDeadlineMs: 10000,
    },
  };
  const budget = createQuestionBudgetLedger(profile, { pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 } });
  assert.ok(budget.ok, JSON.stringify(budget));
  const generation: QuestionIndexGenerationV1 = {
    schemaVersion: 'question-retrieval/1',
    generationId: 'generation',
    binding,
    snapshotId: snapshot.snapshotId,
    manifestDigest: snapshot.manifestDigest,
    configDigest: identity.configDigest,
    embeddingDigest: digest('embedding'),
    coverage: 'partial',
  };
  const rows: QuestionIndexRow[] = chunks.map((chunk, i) => {
    const text = texts.get(chunk.path) ?? '';
    const excerpt = text
      .split('\n')
      .slice(chunk.startLine - 1, chunk.endLine)
      .join('\n');
    const metadata: QuestionIndexedChunkV1 = {
      schemaVersion: 'question-retrieval/1',
      chunkId: 'chunk-' + i,
      path: chunk.path,
      fileType: 'python-source',
      kind: 'definition',
      symbolName: chunk.symbol,
      qualifiedSymbolName: chunk.symbol,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      originalByteDigest: digest(text),
      excerptDigest: digest(excerpt),
      normalizedByteLength: Buffer.byteLength(excerpt),
      vectorId: digest(JSON.stringify(['chunk-' + i, 'controlled/1'])),
      definition: { definitionId: 'definition-' + chunk.symbol, qualifiedName: chunk.symbol, startLine: 1, endLine: chunk.definitionEnd ?? chunk.endLine, partOrder: i },
    };
    return { metadata, vector: [1, 0], embeddingInputTokens: 2 };
  });
  let scans = 0,
    modelCalls = 0,
    bindingChecks = 0,
    current = true;
  const embedding = createControlledQuestionEmbedding(
    { id: 'controlled/1', dimension: 2, maxTokens: 512 },
    () => [1, 2],
    () => [1, 0],
  );
  const index = {
    async read() {
      scans++;
      return {
        status: 'ok' as const,
        generation,
        chunks: rows,
        files: manifest.map(file => ({ ...file, fileType: 'python-source' as const, coverage: 'partial' as const, omissionReasons: ['partial-scan' as const] })),
      };
    },
    async validateCurrent() {
      bindingChecks++;
      return current ? { status: 'ok' as const } : { status: 'stale' as const, reasonCode: 'binding-mismatch' as const };
    },
  };
  const denyRepository: QuestionRepositoryPort = {
    async checkBinding() {
      return { status: 'unavailable', reasonCode: 'unsupported-adapter' };
    },
    async readSpan() {
      return { status: 'unavailable', reasonCode: 'unsupported-adapter' };
    },
    async listDirectory() {
      return { status: 'unavailable', reasonCode: 'unsupported-adapter' };
    },
    async searchLiteral() {
      return { status: 'unavailable', reasonCode: 'unsupported-adapter' };
    },
  };
  const guarded = guardedRetrievalRepository(
    {
      identity,
      snapshot,
      generationId: generation.generationId,
      embeddingDigest: generation.embeddingDigest,
      limits: profile.retrieval,
      repositoryLimits: profile.repository,
      budget: budget.value,
      repository: denyRepository,
      index,
      embedding,
    },
    texts,
  );
  const requests: QuestionCompiledRequestV1[] = [];
  const options = {
    identity,
    snapshot,
    profile,
    budget: budget.value,
    repository: guarded.repository,
    index,
    embedding,
    generationId: generation.generationId,
    embeddingDigest: generation.embeddingDigest,
    model: {
      providerId: 'controlled',
      modelId: 'scripted',
      counter: { kind: 'controlled' as const, countRequest: (serialized: string) => Buffer.byteLength(serialized) },
      transport: {
        kind: 'controlled' as const,
        enforcesOutputTokenCap: true as const,
        async send(request: QuestionCompiledRequestV1): Promise<unknown> {
          requests.push(request);
          const step = steps[modelCalls++];
          assert.ok(step, 'script must cover every admitted model call');
          return { decision: step(JSON.parse(request.serialized) as VisibleContext), usage: { status: 'complete', inputTokens: request.inputTokens, outputTokens: 10 } };
        },
      },
    },
  };
  return {
    options,
    profile,
    budget: budget.value,
    texts,
    rows,
    requests,
    guarded,
    counts: () => ({ modelCalls, scans }),
    bindingChecks: () => bindingChecks,
    stale() {
      current = false;
    },
  };
}

function answer(context: VisibleContext, paths: readonly string[]): QuestionModelDecisionV1 {
  return {
    kind: 'answer',
    claims: paths.map((path, index) => {
      const span = context.evidence.spans.find(span => span.path === path);
      assert.ok(span, 'claim must use model-visible guarded source');
      return {
        claimId: 'claim-' + index,
        text: path === 'entry.py' ? 'The entry delegates processing.' : path === 'recover.py' ? 'Recovery returns a safe value.' : 'Processing delegates recovery.',
        kind: 'observation',
        evidence: [{ evidenceId: span.evidenceId, range: span.range }],
      };
    }),
    limitations: [],
  };
}

test('investigation delivers guarded ranked evidence with final citations through the actual graph', async () => {
  const f = fixture([context => answer(context, ['entry.py'])]);
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const run = await graph.value.run('What does start do?', control());
  assert.equal(run.result.kind, 'answered', JSON.stringify(run));
  if (run.result.kind !== 'answered') return;
  assert.equal(run.result.citations[0]?.path, 'entry.py');
  assert.deepEqual(run.result.citations[0]?.range, { startLine: 1, endLine: 2 });
  assert.equal(run.retrieval?.status, 'complete');
  assert.deepEqual(f.counts(), { modelCalls: 1, scans: 1 });
  assert.ok(f.guarded.guarded.length >= 2);
  assert.equal(f.budget.snapshot().consumed.modelCalls, 1);
});

test('navigation and literal search reach late cross-file evidence and cite it together with ranked evidence', async () => {
  const texts = new Map([
    ['entry.py', 'def start():\n    return process()'],
    ['process.py', [...Array.from({ length: 100 }, (_, i) => '# setup ' + i), 'def process():', '    return recover()'].join('\n')],
    ['recover.py', 'def recover():\n    return "safe"'],
  ]);
  const f = fixture(
    [
      () => ({ kind: 'list', path: '.' }),
      context => {
        assert.match(context.observations.items.join('\n'), /process\.py/);
        return { kind: 'search', query: 'def process' };
      },
      context => {
        assert.ok(context.evidence.spans.some(span => span.path === 'process.py' && span.range.startLine >= 100));
        return { kind: 'read', path: 'recover.py', startLine: 1, endLine: 2 };
      },
      context => answer(context, ['entry.py', 'process.py', 'recover.py']),
    ],
    texts,
  );
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const run = await graph.value.run('How does the processing flow recover?', control());
  assert.equal(run.result.kind, 'answered', JSON.stringify(run));
  if (run.result.kind !== 'answered') return;
  assert.deepEqual(
    run.result.citations.map(citation => citation.path),
    ['entry.py', 'process.py', 'recover.py'],
  );
  assert.ok((run.result.citations.find(citation => citation.path === 'process.py')?.range.startLine ?? 0) >= 100);
  assert.equal(run.retrieval?.status, 'complete');
  if (run.retrieval?.status === 'complete')
    assert.deepEqual(
      run.retrieval.ranked.map(hit => [hit.path, hit.startLine, hit.endLine]),
      [['entry.py', 1, 2]],
    );
  assert.deepEqual(f.counts(), { modelCalls: 4, scans: 1 });
  assert.ok(f.budget.snapshot().consumed.toolCalls >= 7);
});

test('linked long definitions expand in guarded pages without enlarging the frozen ranking', async () => {
  const body = ['def calculate():', ...Array.from({ length: 123 }, (_, i) => '    value_' + i + ' = ' + i), '    return value_122'].join('\n');
  function next(context: VisibleContext): unknown {
    const hints = context.observations.items.map(item => JSON.parse(item) as { kind: string; nextRead?: unknown }).filter(item => item.kind === 'definition-continuation');
    const hint = hints.at(-1);
    assert.ok(hint?.nextRead, 'original-definition metadata supplies the next bounded range');
    return hint.nextRead;
  }
  const f = fixture(
    [
      next,
      context => {
        assert.ok(context.evidence.spans.some(span => span.range.startLine === 61 && span.range.endLine === 120));
        return next(context);
      },
      context => {
        const tail = context.evidence.spans.find(span => span.range.startLine === 121);
        assert.ok(tail);
        assert.equal(tail.range.endLine, 125);
        assert.match(tail.excerpt, /return value_122/);
        return {
          kind: 'answer',
          claims: [{ claimId: 'tail', text: 'The definition returns the retained value.', kind: 'observation', evidence: [{ evidenceId: tail.evidenceId, range: { startLine: 125, endLine: 125 } }] }],
          limitations: [],
        };
      },
    ],
    new Map([['long.py', body]]),
    [{ path: 'long.py', startLine: 1, endLine: 60, symbol: 'calculate', definitionEnd: 125 }],
  );
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const run = await graph.value.run('Explain calculate.', control());
  assert.equal(run.result.kind, 'answered', JSON.stringify(run));
  if (run.result.kind !== 'answered') return;
  assert.deepEqual(run.result.citations[0]?.range, { startLine: 125, endLine: 125 });
  assert.ok(run.retrieval?.status === 'complete');
  assert.deepEqual(
    run.retrieval.ranked.map(hit => [hit.startLine, hit.endLine]),
    [[1, 60]],
  );
  assert.equal(f.counts().scans, 1);
  const visible = JSON.parse(f.requests.at(-1)?.serialized ?? '{}') as VisibleContext;
  assert.deepEqual(
    visible.evidence.spans.map(span => [span.range.startLine, span.range.endLine]),
    [
      [1, 60],
      [61, 120],
      [121, 125],
    ],
  );
});

test('final generation drift refuses all gathered claims without a model retry', async () => {
  const f = fixture([
    context => {
      f.stale();
      return answer(context, ['entry.py']);
    },
  ]);
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const run = await graph.value.run('Explain start.', control());
  assert.equal(run.result.kind, 'stale-repository');
  assert.ok(!('claims' in run.result));
  assert.ok(!('citations' in run.result));
  assert.equal(f.counts().modelCalls, 1);
});

test('binding admission refuses an already stale generation before querying or reading source', async () => {
  const f = fixture([]);
  f.stale();
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const run = await graph.value.run('Explain start.', control());
  assert.equal(run.result.kind, 'stale-repository');
  assert.deepEqual(f.counts(), { modelCalls: 0, scans: 0 });
  assert.equal(f.guarded.reads.length, 0);
});

test('unknown execution proposals fail validation without repository mutation or execution', async () => {
  const f = fixture([() => ({ kind: 'execute', command: 'python recover.py' })]);
  const before = [...f.texts];
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const run = await graph.value.run('Explain start.', control());
  assert.equal(run.result.kind, 'failed');
  if (run.result.kind === 'failed') assert.equal(run.result.reasonCode, 'invalid-decision');
  assert.deepEqual([...f.texts], before);
  assert.equal(f.counts().modelCalls, 1);
  assert.equal(f.budget.snapshot().consumed.toolCalls, 2);
});

test('repeated navigation terminates at the task model limit rather than graph recursion', async () => {
  const f = fixture(Array.from({ length: 20 }, () => () => ({ kind: 'list', path: '.' })));
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const run = await graph.value.run('Explain the repository.', control());
  assert.equal(run.result.kind, 'budget-exhausted');
  if (run.result.kind === 'budget-exhausted') assert.equal(run.result.reasonCode, 'model-limit');
  assert.equal(f.counts().modelCalls, 20);
  assert.equal(f.budget.snapshot().consumed.modelCalls, 20);
  assert.ok(!('claims' in run.result));
});

test('a remembered evidence ID omitted by the latest compiler cannot support a new claim', async () => {
  let remembered: AdmittedSpanV1 | undefined;
  let readsAtFinalProposal = 0;
  const f = fixture([
    () => ({ kind: 'read', path: 'process.py', startLine: 1, endLine: 2 }),
    context => {
      remembered = context.evidence.spans.find(span => span.path === 'process.py');
      assert.ok(remembered);
      return { kind: 'read', path: 'recover.py', startLine: 1, endLine: 2 };
    },
    context => {
      assert.ok(!context.evidence.spans.some(span => span.path === 'process.py'));
      assert.ok(remembered);
      readsAtFinalProposal = f.guarded.reads.length;
      return {
        kind: 'answer',
        claims: [{ claimId: 'remembered', text: 'Processing delegates recovery.', kind: 'observation', evidence: [{ evidenceId: remembered.evidenceId, range: remembered.range }] }],
        limitations: [],
      };
    },
  ]);
  const count = f.options.model.counter.countRequest;
  f.options.model.counter.countRequest = serialized => {
    const context = JSON.parse(serialized) as VisibleContext;
    return f.counts().modelCalls >= 2 && context.evidence.spans.some(span => span.path === 'process.py') ? 30001 : count(serialized);
  };
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const run = await graph.value.run('Explain the processing flow.', control());
  assert.equal(run.result.kind, 'failed');
  if (run.result.kind === 'failed') assert.equal(run.result.reasonCode, 'invalid-citation');
  assert.equal(f.guarded.reads.length, readsAtFinalProposal);
  assert.equal(f.counts().modelCalls, 3);
});

test('material ambiguity returns a task-charged clarification and waits without background activity', async () => {
  const f = fixture([() => ({ kind: 'clarify', question: 'Which recovery mechanism?', explanation: 'The referent is unresolved.', unresolvedReferents: ['task recovery', 'process recovery'] })]);
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const run = await graph.value.run('Explain recovery.', control());
  assert.equal(run.result.kind, 'awaiting-clarification');
  if (run.result.kind !== 'awaiting-clarification') return;
  assert.equal(run.result.clarification.round, 1);
  assert.deepEqual(run.result.clarification.unresolvedReferents, ['task recovery', 'process recovery']);
  assert.equal(f.budget.snapshot().consumed.clarificationRounds, 1);
  const waiting = { ...f.counts(), reads: f.guarded.reads.length };
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual({ ...f.counts(), reads: f.guarded.reads.length }, waiting);
});

test('clarification cap returns honest insufficient evidence without charging a new round or doing final IO', async () => {
  const f = fixture([() => ({ kind: 'clarify', question: 'Which recovery?', explanation: 'The referent remains unresolved.', unresolvedReferents: ['task', 'process'] })]);
  for (let i = 0; i < f.profile.runtime.maxClarificationRounds; i++) {
    const reservation = f.budget.reserveClarification();
    assert.ok(reservation.ok);
    await reservation.value.execute(
      async () => undefined,
      () => ({ kind: 'work', work: { clarificationRounds: 1 } }),
    );
  }
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const run = await graph.value.run('Explain recovery.', control());
  assert.equal(run.result.kind, 'insufficient-evidence');
  if (run.result.kind !== 'insufficient-evidence') return;
  assert.deepEqual(run.result.claims, []);
  assert.deepEqual(run.result.citations, []);
  assert.equal(f.budget.snapshot().consumed.clarificationRounds, 2);
  assert.equal(f.budget.snapshot().status, 'open');
  assert.equal(f.counts().modelCalls, 1);
  assert.equal(f.budget.snapshot().consumed.toolCalls, 2);
});

test('a partial search miss remains insufficient evidence rather than confirmed absence', async () => {
  const f = fixture([
    () => ({ kind: 'search', query: 'undocumented-author-intent' }),
    context => {
      assert.match(context.observations.items.join('\n'), /"kind":"search"/);
      assert.match(context.observations.items.join('\n'), /"coverage":"partial"/);
      return { kind: 'insufficient', explanation: 'The inspected source cannot establish the author intent; search coverage does not prove absence.' };
    },
  ]);
  const search = f.options.repository.searchLiteral;
  f.options.repository = {
    ...f.options.repository,
    async searchLiteral(request, bounded) {
      const page = await search(request, bounded);
      return page.status === 'ok' ? { ...page, coverage: 'partial', omissionReasons: ['protected'] } : page;
    },
  };
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const run = await graph.value.run('Why did the author choose recovery?', control());
  assert.equal(run.result.kind, 'insufficient-evidence');
  if (run.result.kind !== 'insufficient-evidence') return;
  assert.deepEqual(run.result.claims, []);
  assert.deepEqual(run.result.citations, []);
  assert.match(run.result.explanation, /cannot establish/);
  assert.equal(f.counts().modelCalls, 2);
});

test('insufficient evidence can retain supported claims only after admitted final binding validation', async () => {
  const f = fixture([
    context => {
      const proposal = answer(context, ['entry.py']);
      assert.equal(proposal.kind, 'answer');
      return { kind: 'insufficient', explanation: 'Delegation is visible; author intent remains unknown.', claims: proposal.kind === 'answer' ? proposal.claims : [] };
    },
  ]);
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const run = await graph.value.run('What happens and why?', control());
  assert.equal(run.result.kind, 'insufficient-evidence');
  if (run.result.kind !== 'insufficient-evidence') return;
  assert.equal(run.result.citations[0]?.path, 'entry.py');
  assert.equal(run.result.claims.length, 1);
  assert.equal(f.budget.snapshot().consumed.toolCalls, 3);
  assert.ok(!('text' in run.result));
});

test('an earlier caller deadline fences an uncooperative model and retains its uncertain reservation', async t => {
  const f = fixture([]);
  let sends = 0;
  f.options.model.transport.send = async () => {
    sends++;
    return await new Promise<never>(() => undefined);
  };
  t.after(() => f.budget.cancel());
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const pending = graph.value.run('Explain start.', { ...control(), deadlineEpochMs: Date.now() + 1200 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    pending,
    new Promise<'unbounded'>(resolve => {
      timer = setTimeout(() => resolve('unbounded'), 1700);
    }),
  ]);
  clearTimeout(timer);
  assert.notEqual(result, 'unbounded', 'the caller deadline must bound the whole run independently of task elapsed room');
  if (result === 'unbounded') return;
  assert.equal(result.result.kind, 'budget-exhausted');
  if (result.result.kind === 'budget-exhausted') assert.equal(result.result.reasonCode, 'elapsed-deadline');
  assert.ok(!('claims' in result.result) && !('citations' in result.result));
  assert.equal(sends, 1);
  assert.ok(f.budget.snapshot().reserved.billableTokens > 0);
  const reads = f.guarded.reads.length;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.guarded.reads.length, reads);
});

test('the exact last tool call suppresses final binding IO and preserves the tool-limit reason', async () => {
  let finalChecks = 0;
  let checksAtProposal = 0;
  const f = fixture(
    [
      context => {
        checksAtProposal = finalChecks;
        return answer(context, ['entry.py']);
      },
    ],
    undefined,
    undefined,
    { maxToolCalls: 2 },
  );
  const check = f.options.index.validateCurrent;
  f.options.index.validateCurrent = async () => {
    finalChecks++;
    return await check();
  };
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const run = await graph.value.run('Explain start.', control());
  assert.equal(run.result.kind, 'budget-exhausted');
  if (run.result.kind === 'budget-exhausted') assert.equal(run.result.reasonCode, 'tool-limit');
  assert.ok(!('claims' in run.result) && !('citations' in run.result));
  assert.equal(finalChecks, checksAtProposal);
  assert.equal(f.budget.snapshot().consumed.toolCalls, 2);
  assert.equal(f.counts().modelCalls, 1);
});

test('unknown usage blocks clarification and keeps the reservation with zero later source or provider effects', async () => {
  const f = fixture([]);
  let sends = 0;
  let closedChecks = 0;
  f.options.model.transport.send = async () => {
    sends++;
    closedChecks = f.bindingChecks();
    return { decision: { kind: 'clarify', question: 'Which flow?', explanation: 'Ambiguous.', unresolvedReferents: ['one', 'two'] }, usage: { status: 'missing' } };
  };
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const run = await graph.value.run('Explain recovery.', control());
  assert.equal(run.result.kind, 'blocked');
  if (run.result.kind === 'blocked') assert.equal(run.result.reasonCode, 'accounting-unknown');
  assert.ok(!('claims' in run.result) && !('citations' in run.result) && !('clarification' in run.result));
  assert.equal(sends, 1);
  assert.equal(f.bindingChecks(), closedChecks);
  assert.equal(f.budget.snapshot().status, 'blocked');
  assert.ok(f.budget.snapshot().reserved.billableTokens > 0);
});

test('cancellation during a model decision suppresses its late answer and all final source checks', async () => {
  const cancellation = new AbortController();
  let atCancellation = 0;
  const f = fixture([
    context => {
      atCancellation = f.bindingChecks();
      cancellation.abort();
      return answer(context, ['entry.py']);
    },
  ]);
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const run = await graph.value.run('Explain start.', { ...control(), signal: cancellation.signal });
  assert.equal(run.result.kind, 'cancelled');
  assert.ok(!('claims' in run.result) && !('citations' in run.result));
  assert.equal(f.bindingChecks(), atCancellation);
  assert.equal(f.counts().modelCalls, 1);
  assert.equal(f.budget.snapshot().status, 'cancelled');
});

test('mandatory model context overflow returns a claim-free context-limit without provider dispatch or final IO', async () => {
  const f = fixture([]);
  let checksAtCompilation = 0;
  f.options.model.counter.countRequest = () => {
    checksAtCompilation = f.bindingChecks();
    return 30001;
  };
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const run = await graph.value.run('Explain start.', control());
  assert.equal(run.result.kind, 'blocked');
  if (run.result.kind === 'blocked') assert.equal(run.result.reasonCode, 'context-limit');
  assert.ok(!('claims' in run.result) && !('citations' in run.result));
  assert.equal(f.counts().modelCalls, 0);
  assert.equal(f.bindingChecks(), checksAtCompilation);
  assert.equal(f.budget.snapshot().consumed.modelCalls, 0);
});

test('a denied protected read stops without model retry or protected bytes', async () => {
  const f = fixture([() => ({ kind: 'read', path: '.env', startLine: 1, endLine: 1 })]);
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const run = await graph.value.run('Explain recovery.', control());
  assert.equal(run.result.kind, 'blocked');
  if (run.result.kind === 'blocked') assert.equal(run.result.reasonCode, 'owner-denied');
  assert.equal(f.counts().modelCalls, 1);
  assert.ok(!f.guarded.reads.includes('.env'));
  assert.ok(!('claims' in run.result) && !('citations' in run.result));
});

test('pre-cancelled and expired runs start no index, source or provider operations', async () => {
  for (const kind of ['cancelled', 'budget-exhausted'] as const) {
    const f = fixture([]);
    const cancellation = new AbortController();
    if (kind === 'cancelled') cancellation.abort();
    const graph = createQuestionInvestigation(f.options);
    assert.ok(graph.ok);
    const run = await graph.value.run('Explain start.', { signal: cancellation.signal, deadlineEpochMs: Date.now() + (kind === 'cancelled' ? 20000 : -1) });
    assert.equal(run.result.kind, kind);
    assert.deepEqual(f.counts(), { modelCalls: 0, scans: 0 });
    assert.equal(f.bindingChecks(), 0);
    assert.equal(f.guarded.reads.length, 0);
    assert.ok(!('claims' in run.result) && !('citations' in run.result));
  }
});

test('protected conversational text is never displayed and small final caps refuse bounded output', async () => {
  const protectedText = 'api_key = "controlled_secret_token"';
  const vectors = [
    { decision: { kind: 'clarify', question: 'Which flow?', explanation: protectedText, unresolvedReferents: ['one', 'two'] }, maxFinalBytes: 10000, reason: 'protected-content' },
    { decision: { kind: 'insufficient', explanation: protectedText }, maxFinalBytes: 10000, reason: 'protected-content' },
    { decision: { kind: 'insufficient', explanation: 'The evidence cannot establish the author intent.' }, maxFinalBytes: 10, reason: 'render-limit' },
  ];
  for (const vector of vectors) {
    const f = fixture([() => vector.decision], undefined, undefined, { maxFinalBytes: vector.maxFinalBytes });
    const graph = createQuestionInvestigation(f.options);
    assert.ok(graph.ok);
    const run = await graph.value.run('Explain recovery.', control());
    assert.equal(run.result.kind, 'failed');
    if (run.result.kind === 'failed') assert.equal(run.result.reasonCode, vector.reason);
    assert.ok(!JSON.stringify(run.result).includes('controlled_secret_token'));
    assert.equal(f.budget.snapshot().consumed.clarificationRounds, 0);
    assert.equal(f.budget.snapshot().consumed.toolCalls, 2);
    assert.equal(f.counts().modelCalls, 1);
  }
});

test('safe conversational whitespace is normalized and claim-free result arrays are immutable', async () => {
  const f = fixture([() => ({ kind: 'insufficient', explanation: 'Cannot\n establish\t intent.' })]);
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const run = await graph.value.run('Explain recovery.', control());
  assert.equal(run.result.kind, 'insufficient-evidence');
  if (run.result.kind !== 'insufficient-evidence') return;
  assert.equal(run.result.explanation, 'Cannot establish intent.');
  assert.ok(Object.isFrozen(run.result.claims) && Object.isFrozen(run.result.citations) && Object.isFrozen(run.result.limitations));
});

test('exact outer file, scanned-byte and returned-byte boundaries suppress all final binding IO', async () => {
  for (const exhausted of ['scannedFiles', 'scannedBytes', 'returnedBytes'] as const) {
    const available = { scannedFiles: 10000, scannedBytes: 10000000, returnedBytes: 1000000 };
    let closedChecks = 0;
    const f = fixture([
      context => {
        closedChecks = f.bindingChecks();
        available[exhausted] = 0;
        return answer(context, ['entry.py']);
      },
    ]);
    const graph = createQuestionInvestigation(f.options);
    assert.ok(graph.ok);
    const run = await graph.value.run('Explain start.', {
      ...control(),
      work: {
        remaining: key => available[key],
        charge(work) {
          for (const key of ['scannedFiles', 'scannedBytes', 'returnedBytes'] as const) {
            if ((work[key] ?? 0) > available[key]) return false;
          }
          for (const key of ['scannedFiles', 'scannedBytes', 'returnedBytes'] as const) available[key] -= work[key] ?? 0;
          return true;
        },
      },
    });
    assert.equal(run.result.kind, 'budget-exhausted');
    if (run.result.kind === 'budget-exhausted') assert.equal(run.result.reasonCode, exhausted === 'returnedBytes' ? 'output-limit' : 'scan-limit');
    assert.equal(f.bindingChecks(), closedChecks, 'no final generation or repository scan may start after the outer limit');
    assert.equal(f.counts().modelCalls, 1);
    assert.ok(!('claims' in run.result) && !('citations' in run.result));
  }
});

test('synchronous request counting crossing the immutable caller deadline prevents provider dispatch', async () => {
  const realNow = Date.now;
  let closedChecks = 0;
  const f = fixture([context => answer(context, ['entry.py'])]);
  f.options.model.counter.countRequest = () => {
    closedChecks = f.bindingChecks();
    Date.now = () => realNow() + 40000;
    return 100;
  };
  const graph = createQuestionInvestigation(f.options);
  assert.ok(graph.ok);
  const caller = Object.freeze(control());
  let run;
  try {
    run = await graph.value.run('Explain start.', caller);
  } finally {
    Date.now = realNow;
  }
  assert.equal(run.result.kind, 'budget-exhausted');
  if (run.result.kind === 'budget-exhausted') assert.equal(run.result.reasonCode, 'elapsed-deadline');
  assert.equal(f.counts().modelCalls, 0, 'deadline crossing during synchronous compilation must close transport admission');
  assert.equal(f.bindingChecks(), closedChecks);
  assert.equal(f.guarded.reads.length, 2);
  assert.ok(!('claims' in run.result) && !('citations' in run.result));
  assert.equal(f.budget.snapshot().consumed.modelCalls, 0);
  assert.equal(f.budget.snapshot().reserved.billableTokens, 0);
});
