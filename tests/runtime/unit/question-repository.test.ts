import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ControlledRepositoryTools,
  type ControlledRepositoryToolsOptions,
  type ExecutionGuardReadCapability,
  type GuardedReadOperation,
  type QuestionRepositoryReadLimits,
  type TrustedFilesystemPort,
} from '../../../src/foundation/repository-tools.ts';
import { computeFileDigest } from '../../../src/foundation/docker-workspace-policy.ts';
import { computeSourceManifestDigest } from '../../../src/foundation/question-repository-read.ts';
import type { RepositoryBindingV1, SourceManifestEntryV1, SourceSnapshotV1 } from '../../../src/contracts/questions/contracts.ts';
import { createQuestionRepositoryPort, type QuestionRepositoryReadPort } from '../../../src/questions/repository.ts';

const DIGEST = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const binding = Object.freeze({ repositoryId: 'repo-1', workspaceId: 'ws-test', revisionDigest: DIGEST, policyDigest: DIGEST });
const identity = Object.freeze({ sessionId: 'session-1', taskId: 'task-1', runId: 'run-1', questionId: 'question-1', binding, configDigest: DIGEST });
const fileBytes = Buffer.from('one\r\ntwo\r\nthree\r\n');

class ReadGuard implements ExecutionGuardReadCapability {
  readonly provenance = 'mock' as const;
  readonly capabilityId = 'read-capability-1';
  readonly workspaceId = binding.workspaceId;
  readonly taskId = identity.taskId;
  readonly calls: string[] = [];
  allow = true;
  beforeExecute?: (() => Promise<void> | void) | undefined;
  async mediateRead<T>(operation: GuardedReadOperation<T>): Promise<T> {
    this.calls.push(operation.kind);
    if (!this.allow) throw new Error('GUARD_DENIED: fixture refusal');
    await this.beforeExecute?.();
    return await operation.execute();
  }
}

class NoLiveFilesystem implements TrustedFilesystemPort {
  readonly provenance = 'mock' as const;
  private readonly filePaths: readonly string[];
  constructor(filePaths: readonly string[]) { this.filePaths = filePaths; }
  async stat(path: string) { return path === '' || path === '.' ? { isFile: false, isDirectory: true, isSymbolicLink: false, size: 0 } : { isFile: true, isDirectory: false, isSymbolicLink: false, size: fileBytes.byteLength }; }
  async lstat(path: string) { return path === '' || path === '.' || this.filePaths.some(file => file.startsWith(`${path}/`)) ? { isFile: false, isDirectory: true, isSymbolicLink: false, size: 0 } : { isFile: true, isDirectory: false, isSymbolicLink: false, size: fileBytes.byteLength }; }
  async realpath(path: string) { return path; }
  async readDir(): Promise<never> { throw new Error('live filesystem must not be used'); }
  async readTextFile(): Promise<never> { throw new Error('live filesystem must not be used'); }
  async getCurrentRevisionDigest(): Promise<never> { throw new Error('live filesystem must not be used'); }
}

const questionLimits = Object.freeze({
  maxFileBytes: 128, maxSpanBytes: 64, maxSpanLines: 3, maxPageEntries: 2, maxSearchHits: 2,
  maxQueryBytes: 32, maxPathBytes: 128, maxScannedFiles: 20, maxScannedBytes: 2_048,
  maxReturnedBytes: 1_024, maxCursors: 4, contextLinesBefore: 1, contextLinesAfter: 1,
});

function questionTools(tools: ControlledRepositoryTools): QuestionRepositoryReadPort {
  return tools as unknown as QuestionRepositoryReadPort;
}

function control(): { readonly signal: AbortSignal; readonly deadlineEpochMs: number } {
  return { signal: new AbortController().signal, deadlineEpochMs: Date.now() + 5_000 };
}

interface ToolFixtureOptions {
  readonly files?: ReadonlyMap<string, Uint8Array>;
  readonly manifest?: readonly SourceManifestEntryV1[];
  readonly limits?: Partial<QuestionRepositoryReadLimits>;
  readonly snapshot?: unknown;
  readonly omitSnapshotPort?: boolean;
  readonly bindingPort?: unknown;
  readonly acquireSnapshot?: () => Promise<unknown>;
}

function makeTools(options: ToolFixtureOptions = {}): { readonly tools: ControlledRepositoryTools; readonly guard: ReadGuard; readonly reads: string[]; readonly readCaps: number[]; readonly files: ReadonlyMap<string, Uint8Array> } {
  const guard = new ReadGuard();
  const files = options.files ?? new Map([['src/example.py', fileBytes]]);
  const manifest = options.manifest ?? [...files].map(([path, bytes]) => ({ path, originalByteDigest: computeFileDigest(bytes) }));
  const readLimits = { ...questionLimits, ...options.limits };
  const snapshot: SourceSnapshotV1 = options.snapshot as SourceSnapshotV1 ?? {
    snapshotId: 'snapshot-1', binding, manifestDigest: computeSourceManifestDigest(manifest), acquisitionId: 'acquisition-1',
    admissionLimits: { maxFiles: readLimits.maxScannedFiles, maxBytes: Math.min(1_024, readLimits.maxScannedBytes), maxElapsedMs: 1_000 }, manifest,
  };
  const reads: string[] = [];
  const readCaps: number[] = [];
  const snapshotPort = options.omitSnapshotPort ? undefined : {
    acquireSnapshot: options.acquireSnapshot ?? (async () => ({
      snapshot,
      readFile: async (path: string, maxBytes: number) => {
        reads.push(path);
        readCaps.push(maxBytes);
        const bytes = files.get(path);
        if (bytes !== undefined && bytes.byteLength > maxBytes) return { status: 'oversized', scannedBytes: maxBytes + 1 };
        return bytes === undefined ? { status: 'unreadable', scannedBytes: 0 } : { status: 'ok', bytes: Buffer.from(bytes), scannedBytes: bytes.byteLength };
      },
    })),
  };
  const toolOptions = {
    guardCapability: guard,
    fsPort: new NoLiveFilesystem([...files.keys()]),
    limits: { maxExcerptBytes: 128, maxResultCount: 10 },
    questionIdentity: identity,
    questionLimits: readLimits,
    questionBindingPort: options.bindingPort ?? { checkBinding: async () => ({ status: 'ok', binding }) },
    ...(snapshotPort === undefined ? {} : { questionSnapshotPort: snapshotPort }),
  } as unknown as ControlledRepositoryToolsOptions;
  return { tools: new ControlledRepositoryTools(toolOptions), guard, reads, readCaps, files };
}

test('readSpan returns normalized whole lines from the trusted snapshot and clamps end-of-file', async () => {
  const { tools } = makeTools();
  const result = await questionTools(tools).readSpan(
    { path: 'src/example.py', startLine: 2, endLine: 8 },
    control(),
  );

  assert.equal(typeof result, 'object');
  const spanResult = result as { readonly status: string; readonly span?: Record<string, unknown> };
  assert.equal(spanResult.status, 'ok');
  assert.ok(spanResult.span);
  assert.deepEqual(spanResult.span['range'], { startLine: 2, endLine: 3 });
  assert.equal(spanResult.span['excerpt'], 'two\nthree');
  assert.equal(spanResult.span['excerptDigest'], computeFileDigest(Buffer.from('two\nthree', 'utf8')));
  assert.equal(spanResult.span['originalByteDigest'], computeFileDigest(fileBytes));
  assert.deepEqual(spanResult.span['truncation'], { kind: 'none' });
  assert.deepEqual(spanResult.span['identity'], identity);
  assert.ok(typeof spanResult.span['evidenceId'] === 'string');
});

test('repository tool inputs and deadlines are detached before the guarded await', async () => {
  const fixture = makeTools();
  const request = { path: 'src/example.py', startLine: 2, endLine: 2 };
  const operationControl = { signal: new AbortController().signal, deadlineEpochMs: Date.now() + 5_000 };
  fixture.guard.beforeExecute = () => {
    request.path = '../outside.py';
    operationControl.deadlineEpochMs = Date.now() - 1;
  };
  const result = await questionTools(fixture.tools).readSpan(request, operationControl) as {
    readonly status: string; readonly span?: { readonly path: string; readonly excerpt: string };
  };
  assert.equal(result.status, 'ok');
  assert.equal(result.span?.path, 'src/example.py');
  assert.equal(result.span?.excerpt, 'two');
  assert.deepEqual(fixture.reads, ['src/example.py']);
});

test('searchLiteral is case-sensitive, returns one first-match hit per line, and centers context on the match', async () => {
  const content = Buffer.from('header\r\nalpha = target + target\r\nfooter\r\n', 'utf8');
  const { tools, reads } = makeTools({ files: new Map([['src/search.py', content]]) });
  const result = await questionTools(tools).searchLiteral({ query: 'target', pathPrefix: 'src' }, control()) as {
    readonly status: string;
    readonly hits?: readonly { readonly line: number; readonly column: number; readonly matchLength: number; readonly span: { readonly excerpt: string; readonly range: { readonly startLine: number; readonly endLine: number } } }[];
    readonly coverage?: string;
  };

  assert.equal(result.status, 'ok');
  assert.equal(result.hits?.length, 1);
  assert.equal(result.hits?.[0]?.line, 2);
  assert.equal(result.hits?.[0]?.column, 9);
  assert.equal(result.hits?.[0]?.matchLength, 6);
  assert.equal(result.hits?.[0]?.span.excerpt, 'header\nalpha = target + target\nfooter');
  assert.deepEqual(result.hits?.[0]?.span.range, { startLine: 1, endLine: 3 });
  assert.equal(result.coverage, 'complete');
  assert.deepEqual(reads, ['src/search.py']);

  const mismatch = await questionTools(tools).searchLiteral({ query: 'Target' }, control()) as { readonly status: string; readonly hits?: readonly unknown[] };
  assert.equal(mismatch.status, 'ok');
  assert.deepEqual(mismatch.hits, []);
});

test('searchLiteral pages cached file lines without reopening the immutable source', async () => {
  const content = Buffer.from('target one\ntarget two\ntarget three\n', 'utf8');
  const { tools, reads } = makeTools({ files: new Map([['src/many.py', content]]) });
  const first = await questionTools(tools).searchLiteral({ query: 'target' }, control()) as {
    readonly status: string; readonly hits?: readonly { readonly line: number }[]; readonly nextCursor?: string;
  };
  assert.equal(first.status, 'ok');
  assert.deepEqual(first.hits?.map(hit => hit.line), [1, 2]);
  assert.ok(first.nextCursor);
  const second = await questionTools(tools).searchLiteral({ query: 'target', cursor: first.nextCursor }, control()) as {
    readonly status: string; readonly hits?: readonly { readonly line: number }[];
  };
  assert.equal(second.status, 'ok');
  assert.deepEqual(second.hits?.map(hit => hit.line), [3]);
  assert.deepEqual(reads, ['src/many.py']);
});

test('listDirectory returns lexically sorted bounded pages and consumes opaque cursors once', async () => {
  const files = new Map<string, Uint8Array>([
    ['a.py', Buffer.from('a')],
    ['b.py', Buffer.from('b')],
    ['dir/c.py', Buffer.from('c')],
  ]);
  const { tools } = makeTools({ files });
  const first = await questionTools(tools).listDirectory({ path: '.' }, control()) as {
    readonly status: string; readonly entries?: readonly unknown[]; readonly coverage?: string; readonly nextCursor?: string;
  };

  assert.equal(first.status, 'ok');
  assert.deepEqual(first.entries, [{ path: 'a.py', kind: 'file' }, { path: 'b.py', kind: 'file' }]);
  assert.equal(first.coverage, 'partial');
  assert.ok(first.nextCursor);

  const second = await questionTools(tools).listDirectory({ path: '.', cursor: first.nextCursor }, control()) as {
    readonly status: string; readonly entries?: readonly unknown[]; readonly coverage?: string;
  };
  assert.equal(second.status, 'ok');
  assert.deepEqual(second.entries, [{ path: 'dir', kind: 'directory' }]);
  assert.equal(second.coverage, 'complete');

  const replay = await questionTools(tools).listDirectory({ path: '.', cursor: first.nextCursor }, control()) as { readonly status: string; readonly reasonCode?: string };
  assert.deepEqual(replay, { status: 'invalid', reasonCode: 'invalid-cursor' });
});

test('corrupt manifests and unknown capabilities are refused before opening snapshot bytes', async () => {
  const files = new Map([['src/example.py', fileBytes]]);
  const badSnapshot = {
    snapshotId: 'snapshot-1', binding, manifestDigest: DIGEST, acquisitionId: 'acquisition-1',
    admissionLimits: { maxFiles: 20, maxBytes: 1_024, maxElapsedMs: 1_000 },
    manifest: [{ path: 'src/example.py', originalByteDigest: computeFileDigest(fileBytes) }],
  };
  const corrupt = makeTools({ files, snapshot: badSnapshot });
  const corruptResult = await questionTools(corrupt.tools).readSpan({ path: 'src/example.py', startLine: 1, endLine: 1 }, control()) as { readonly status: string; readonly reasonCode?: string };
  assert.deepEqual(corruptResult, { status: 'unavailable', reasonCode: 'unsupported-adapter' });
  assert.deepEqual(corrupt.reads, []);

  const unsupported = makeTools({ omitSnapshotPort: true });
  const unsupportedResult = await questionTools(unsupported.tools).readSpan({ path: 'src/example.py', startLine: 1, endLine: 1 }, control()) as { readonly status: string; readonly reasonCode?: string };
  assert.deepEqual(unsupportedResult, { status: 'unavailable', reasonCode: 'unsupported-adapter' });
  assert.deepEqual(unsupported.guard.calls, []);

  const missingReadCapability = makeTools({ acquireSnapshot: async () => ({ snapshot: badSnapshot, readFile: undefined }) });
  const missingRead = await questionTools(missingReadCapability.tools).readSpan({ path: 'src/example.py', startLine: 1, endLine: 1 }, control()) as { readonly status: string; readonly reasonCode?: string };
  assert.deepEqual(missingRead, { status: 'unavailable', reasonCode: 'unsupported-adapter' });
  assert.deepEqual(missingReadCapability.reads, []);
});

test('snapshot bytes must match the trusted manifest even when a mutable source changes A to B and back to A', async () => {
  const original = Buffer.from('source A\n');
  const changed = Buffer.from('source B\n');
  let mutableSource = Buffer.from(original);
  let readCount = 0;
  const files = new Map([['src/example.py', original]]);
  const fixture = makeTools({
    files,
    acquireSnapshot: async () => {
      const pinned = Buffer.from(original);
      return {
        snapshot: {
          snapshotId: 'snapshot-1', binding, manifestDigest: computeSourceManifestDigest([{ path: 'src/example.py', originalByteDigest: computeFileDigest(original) }]),
          acquisitionId: 'acquisition-1', admissionLimits: { maxFiles: 20, maxBytes: 1_024, maxElapsedMs: 1_000 },
          manifest: [{ path: 'src/example.py', originalByteDigest: computeFileDigest(original) }],
        },
        readFile: async () => {
          readCount += 1;
          mutableSource = Buffer.from(changed);
          await Promise.resolve();
          mutableSource = Buffer.from(original);
          return { status: 'ok', bytes: pinned, scannedBytes: pinned.byteLength };
        },
      };
    },
  });
  const result = await questionTools(fixture.tools).readSpan({ path: 'src/example.py', startLine: 1, endLine: 1 }, control()) as {
    readonly status: string; readonly span?: { readonly excerpt: string };
  };
  assert.equal(result.status, 'ok');
  assert.equal(result.span?.excerpt, 'source A');
  assert.equal(readCount, 1);
  assert.equal(mutableSource.toString('utf8'), 'source A\n');
});

test('snapshot acquisition that cannot prove stable source bytes is denied without retry or file reads', async () => {
  let acquisitions = 0;
  let mutableSource = Buffer.from('source A\n');
  const fixture = makeTools({
    acquireSnapshot: async () => {
      acquisitions += 1;
      mutableSource = Buffer.from('source B\n');
      await Promise.resolve();
      mutableSource = Buffer.from('source A\n');
      return undefined;
    },
  });
  const result = await questionTools(fixture.tools).readSpan({ path: 'src/example.py', startLine: 1, endLine: 1 }, control()) as {
    readonly status: string; readonly reasonCode?: string;
  };
  assert.deepEqual(result, { status: 'unavailable', reasonCode: 'unsupported-adapter' });
  const repeated = await questionTools(fixture.tools).readSpan({ path: 'src/example.py', startLine: 1, endLine: 1 }, control()) as { readonly status: string; readonly reasonCode?: string };
  assert.deepEqual(repeated, result);
  assert.equal(acquisitions, 1, 'a failed acquisition is not retried later in the run');
  assert.equal(mutableSource.toString('utf8'), 'source A\n');
  assert.deepEqual(fixture.reads, []);
});

test('byte mutation after admission is stale and never issues an excerpt', async () => {
  const original = Buffer.from('trusted A\n');
  const changed = Buffer.from('mutable B\n');
  const fixture = makeTools({
    files: new Map([['src/example.py', original]]),
    acquireSnapshot: async () => ({
      snapshot: {
        snapshotId: 'snapshot-1', binding,
        manifestDigest: computeSourceManifestDigest([{ path: 'src/example.py', originalByteDigest: computeFileDigest(original) }]),
        acquisitionId: 'acquisition-1', admissionLimits: { maxFiles: 20, maxBytes: 1_024, maxElapsedMs: 1_000 },
        manifest: [{ path: 'src/example.py', originalByteDigest: computeFileDigest(original) }],
      },
      readFile: async () => ({ status: 'ok', bytes: changed, scannedBytes: changed.byteLength }),
    }),
  });
  const result = await questionTools(fixture.tools).readSpan({ path: 'src/example.py', startLine: 1, endLine: 1 }, control()) as {
    readonly status: string; readonly reasonCode?: string; readonly span?: unknown;
  };
  assert.deepEqual(result, { status: 'stale', reasonCode: 'source-mismatch' });
  assert.deepEqual(fixture.reads, []);
});

test('protected content outside the requested span excludes the whole file', async () => {
  const secret = Buffer.from('ordinary source\npassword="abcdefghijk"\n', 'utf8');
  const { tools } = makeTools({ files: new Map([['src/example.py', secret]]) });
  const result = await questionTools(tools).readSpan({ path: 'src/example.py', startLine: 1, endLine: 1 }, control()) as {
    readonly status: string; readonly reasonCode?: string;
  };
  assert.deepEqual(result, { status: 'denied', reasonCode: 'protected' });
});

test('span reads budget the overflow probe', async () => {
  const path = 'src/example.py';
  const manifestBytes = Buffer.byteLength(path) + Buffer.byteLength(DIGEST);
  const request = { path, startLine: 1, endLine: 1 };
  const exhausted = { status: 'exhausted', reasonCode: 'scan-limit' };
  const maxScannedBytes = manifestBytes + 5;
  for (const [limits, caps, result] of [
    [{ maxScannedBytes: manifestBytes }, [], exhausted],
    [{ maxScannedFiles: 1 }, [], exhausted],
    [{ maxScannedBytes }, [4], exhausted],
    [{ maxScannedBytes, maxFileBytes: 4 }, [4], { status: 'unavailable', reasonCode: 'oversized' }],
  ] as const) {
    const { tools, readCaps } = makeTools({ limits });
    assert.deepEqual(await tools.readSpan(request, control()), result);
    assert.deepEqual(readCaps, caps);
  }
});

test('cancellation and expired deadlines stop before snapshot admission', async () => {
  let acquisitions = 0;
  const fixture = makeTools({ acquireSnapshot: async () => { acquisitions += 1; return undefined; } });
  const controller = new AbortController();
  controller.abort();
  const cancelled = await questionTools(fixture.tools).listDirectory({ path: '.' }, { signal: controller.signal, deadlineEpochMs: Date.now() + 5_000 }) as { readonly status: string; readonly reasonCode?: string };
  assert.deepEqual(cancelled, { status: 'cancelled', reasonCode: 'cancelled' });
  const expired = await questionTools(fixture.tools).listDirectory({ path: '.' }, { signal: new AbortController().signal, deadlineEpochMs: Date.now() - 1 }) as { readonly status: string; readonly reasonCode?: string };
  assert.deepEqual(expired, { status: 'exhausted', reasonCode: 'deadline' });
  assert.equal(acquisitions, 0);
});

test('question repository exposes only four read and binding operations with an immutable captured binding', async () => {
  const suppliedBinding: { repositoryId: string; workspaceId: string; revisionDigest: string; policyDigest: string } = { ...binding };
  const checkedBindings: RepositoryBindingV1[] = [];
  const bindingPort = {
    checkBinding: async (expected: RepositoryBindingV1) => {
      checkedBindings.push(expected);
      return { status: 'ok', binding: expected };
    },
  };
  const { tools } = makeTools({ bindingPort });
  const port = createQuestionRepositoryPort({
    binding: suppliedBinding,
    reader: questionTools(tools),
    bindingPort,
  });

  suppliedBinding.revisionDigest = 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  assert.deepEqual(Reflect.ownKeys(port).sort(), ['checkBinding', 'listDirectory', 'readSpan', 'searchLiteral']);
  assert.equal(Object.isFrozen(port), true);

  const result = await port.checkBinding(control());
  assert.deepEqual(result, { status: 'ok', binding });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.binding), true);
  assert.equal(checkedBindings[0]?.revisionDigest, DIGEST);
  assert.equal(Object.isFrozen(checkedBindings[0]), true);
});

test('question repository refuses forged cursors and returns stale when the bound revision changes', async () => {
  const files = new Map<string, Uint8Array>([
    ['a.py', Buffer.from('a')],
    ['b.py', Buffer.from('b')],
  ]);
  let currentBinding: RepositoryBindingV1 = binding;
  const bindingPort = {
    checkBinding: async () => ({ status: 'ok', binding: currentBinding }),
  };
  const fixture = makeTools({ files, limits: { maxPageEntries: 1 }, bindingPort });
  const port = createQuestionRepositoryPort({ binding, reader: questionTools(fixture.tools), bindingPort });

  const forged = await port.listDirectory({ path: '.', cursor: 'forged-cursor-123456' }, control());
  assert.deepEqual(forged, { status: 'invalid', reasonCode: 'invalid-cursor' });

  const first = await port.listDirectory({ path: '.' }, control());
  assert.equal(first.status, 'ok');
  if (first.status !== 'ok' || first.nextCursor === undefined) assert.fail('expected a resumable first page');

  currentBinding = { ...binding, revisionDigest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' };
  const stale = await port.listDirectory({ path: '.', cursor: first.nextCursor }, control());
  assert.deepEqual(stale, { status: 'stale', reasonCode: 'binding-mismatch' });
});

test('question repository keeps root selection host-owned and exposes no mutation or execution operations', async () => {
  const { tools, reads } = makeTools();
  const bindingPort = { checkBinding: async () => ({ status: 'ok', binding }) };
  const port = createQuestionRepositoryPort({ binding, reader: questionTools(tools), bindingPort });

  assert.equal('applyPatch' in port, false);
  assert.equal('executeCommand' in port, false);
  assert.deepEqual(await port.readSpan({ path: '../../outside.py', startLine: 1, endLine: 1 }, control()), {
    status: 'invalid', reasonCode: 'invalid-request',
  });
  assert.deepEqual(await port.readSpan({ path: '.git/config', startLine: 1, endLine: 1 }, control()), {
    status: 'denied', reasonCode: 'protected',
  });
  assert.deepEqual(reads, []);
});
