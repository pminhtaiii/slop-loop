import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SpanResultV1 } from '../../../src/contracts/questions/contracts.ts';
import { validateQuestionIndexedChunk } from '../../../src/contracts/questions/validation.ts';
import { computeFileDigest } from '../../../src/foundation/docker-workspace-policy.ts';
import { buildQuestionChunks } from '../../../src/questions/chunks.ts';
import { createControlledQuestionEmbedding } from '../../../src/questions/embedding.ts';

const control = () => ({ signal: new AbortController().signal, deadlineEpochMs: Date.now() + 10_000 });
const binding = {
  repositoryId: 'repo',
  workspaceId: 'workspace',
  revisionDigest: computeFileDigest('revision'),
  policyDigest: computeFileDigest('policy'),
};
const manifestDigest = computeFileDigest('manifest');
function fixture(source: string) {
  const originalByteDigest = computeFileDigest(source.replaceAll('\n', '\r\n'));
  const file = { path: 'src/example.py', fileType: 'python-source' as const, lineCount: source.split('\n').length, originalByteDigest };
  const repository = {
    async checkBinding() {
      return { status: 'ok' as const, binding };
    },
    async readSpan({ startLine, endLine }: { startLine: number; endLine: number }): Promise<SpanResultV1> {
      const excerpt = source
        .split('\n')
        .slice(startLine - 1, endLine)
        .join('\n');
      return {
        status: 'ok',
        span: {
          path: file.path,
          range: { startLine, endLine },
          excerpt,
          evidenceId: 'evidence',
          snapshotId: 'snapshot',
          manifestDigest,
          originalByteDigest,
          excerptDigest: computeFileDigest(excerpt),
          truncation: { kind: 'none' },
          identity: {
            binding,
            taskId: 'task',
            sessionId: 'session',
            runId: 'run',
            questionId: 'question',
            configDigest: computeFileDigest('config'),
          },
        },
      };
    },
  };
  return { file, repository, binding, snapshotId: 'snapshot', manifestDigest, pageLines: 25, maxSourceBytes: 12000, maxChunks: 200 };
}

test('decorators and nested definitions retain original definition linkage across logical splits', async () => {
  const longMethod = [
    '@decorate',
    'class Outer:',
    '    @staticmethod',
    '    def method():',
    ...Array.from({ length: 56 }, (_, i) => `        v${i} = ${i}`),
    '        def inner():',
    '            return "học"',
    '        return inner()',
  ].join('\n');
  const embedding = createControlledQuestionEmbedding(
    { id: 'fixture/1', dimension: 1, maxTokens: 4096 },
    text => [...text].map(() => 1),
    () => [1],
  );
  const result = await buildQuestionChunks(fixture(longMethod), embedding, control());
  assert.equal(result.file.coverage, 'complete');
  assert.ok(result.chunks.every(chunk => validateQuestionIndexedChunk(chunk.metadata).ok));
  const methods = result.chunks.filter(chunk => chunk.metadata.qualifiedSymbolName === 'Outer.method');
  assert.deepEqual(
    methods.map(chunk => [chunk.metadata.startLine, chunk.metadata.endLine]),
    [
      [3, 62],
      [63, 63],
    ],
  );
  assert.deepEqual(
    methods.map(chunk => chunk.metadata.definition?.partOrder),
    [0, 1],
  );
  assert.equal(methods[0]?.metadata.definition?.definitionId, methods[1]?.metadata.definition?.definitionId);
  assert.equal(methods[0]?.metadata.definition?.endLine, 63);
  assert.ok(result.chunks.some(chunk => chunk.metadata.qualifiedSymbolName === 'Outer.method.inner' && chunk.metadata.startLine === 61));
  assert.equal(result.chunks.find(chunk => chunk.metadata.symbolName === 'Outer')?.metadata.definition?.startLine, 1);
});

test('an oversized compound statement splits at complete child statements before whole lines', async () => {
  const statement = (name: string) => [`        ${name} = [`, ...Array.from({ length: 30 }, () => '            1,'), '        ]'];
  const source = ['def main():', '    if True:', ...statement('first'), ...statement('second')].join('\n');
  const embedding = createControlledQuestionEmbedding(
    { id: 'fixture/1', dimension: 1, maxTokens: 4096 },
    text => [...text].map(() => 1),
    () => [1],
  );
  const result = await buildQuestionChunks(fixture(source), embedding, control());
  assert.equal(result.file.coverage, 'complete');
  assert.deepEqual(
    result.chunks.map(({ metadata }) => [metadata.startLine, metadata.endLine]),
    [
      [1, 34],
      [35, 66],
    ],
  );
});

test('protected files never reach the tokenizer and an indivisible line is omitted whole', async () => {
  const args = fixture('def broken(\n' + 'é'.repeat(2049) + '\nnext_line = 1');
  const seen: string[] = [];
  const embedding = createControlledQuestionEmbedding(
    { id: 'fixture/1', dimension: 1, maxTokens: 4096 },
    text => {
      seen.push(text);
      return [1];
    },
    () => [1],
  );
  const denied = await buildQuestionChunks(
    {
      ...args,
      repository: {
        ...args.repository,
        async readSpan() {
          return { status: 'denied', reasonCode: 'protected' };
        },
      },
    },
    embedding,
    control(),
  );
  assert.deepEqual(denied.file.omissionReasons, ['protected']);
  assert.equal(seen.length, 0);
  const result = await buildQuestionChunks(args, embedding, control());
  assert.deepEqual(result.file.omissionReasons, ['parse-failure', 'oversized']);
  assert.deepEqual(
    result.chunks.map(chunk => chunk.metadata.startLine),
    [1, 3],
  );
  assert.ok(seen.every(text => !text.includes('é')));
});
