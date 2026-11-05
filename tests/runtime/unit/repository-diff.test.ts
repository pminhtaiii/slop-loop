/**
 * T032 — bounded repository diff measurement for host-composition §7. Every fact is measured from
 * the retained baseline (T033) and the injected trusted filesystem port; no caller-supplied diff,
 * file content or Git process participates.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { computeCanonicalSha256 } from '../../../src/contracts/foundation/uc03.ts';
import { computeFileDigest } from '../../../src/foundation/docker-workspace-policy.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import { measureRepositoryDiff } from '../../../src/foundation/repository-diff.ts';
import type { RepositoryDiffMeasurementOptions } from '../../../src/foundation/repository-diff.ts';
import { parseUnifiedDiff } from '../../../src/foundation/reviewer.ts';
import { ControlledRepositoryTools } from '../../../src/foundation/repository-tools.ts';
import type { ExecutionGuardReadCapability, FileStat, GuardedReadOperation, TrustedFilesystemEntry, TrustedFilesystemPort } from '../../../src/foundation/repository-types.ts';
import { createRepositoryBaselineSource } from '../../../src/runtime/repository-baseline-source.ts';
import type { RepositoryBaselineBinding, RepositoryBaselineManifestEntry } from '../../../src/runtime/repository-baseline-source.ts';

const TASK_ID = 'task-1';
const WORKSPACE_ID = 'ws-1';
const REPOSITORY_ID = 'repo-1';
const INITIAL: Readonly<Record<string, string>> = {
  'README.md': '# demo\n',
  'src/app.py': 'def add(a, b):\n    return a - b\n',
  'tests/test_app.py': 'def test_add():\n    assert True\n',
};

interface Fixture {
  readonly base: string;
  readonly retained: string;
  readonly current: string;
  readonly entries: readonly RepositoryBaselineManifestEntry[];
  readonly revision: string;
}

async function makeFixture(): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), 'uc03-repository-diff-'));
  const retained = join(base, 'retained');
  const current = join(base, 'current');
  for (const [path, content] of Object.entries(INITIAL)) {
    for (const root of [retained, current]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  }
  const entries = Object.entries(INITIAL).map(([path, content]) => ({
    path,
    digest: computeFileDigest(content),
    sizeBytes: Buffer.byteLength(content, 'utf8'),
  }));
  const revision = await new WorkspaceFilesystemPort({ root: retained }).getCurrentRevisionDigest();
  return { base, retained, current, entries, revision };
}

function withFixture(run: (fixture: Fixture, t: TestContext) => Promise<void>): (t: TestContext) => Promise<void> {
  return async t => {
    const fixture = await makeFixture();
    try {
      await run(fixture, t);
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  };
}

function binding(overrides: Partial<RepositoryBaselineBinding> = {}): RepositoryBaselineBinding {
  return { taskId: TASK_ID, workspaceId: WORKSPACE_ID, repositoryId: REPOSITORY_ID, baseRevision: '', ...overrides };
}

/** Records the fence and admits every operation, like the existing pass-through test doubles. */
function passThroughGuard(): ExecutionGuardReadCapability {
  return {
    provenance: 'mock',
    capabilityId: 'cap-diff',
    workspaceId: WORKSPACE_ID,
    taskId: TASK_ID,
    mediateRead: async <T>(operation: GuardedReadOperation<T>): Promise<T> => operation.execute(),
  };
}

function refusedGuard(): ExecutionGuardReadCapability {
  return {
    provenance: 'mock',
    capabilityId: 'cap-diff',
    workspaceId: WORKSPACE_ID,
    taskId: TASK_ID,
    mediateRead: async () => {
      throw new Error('GUARD_DENIED: OPERATION_DENIED_BY_POLICY');
    },
  };
}

function baselineSource(fixture: Fixture) {
  return createRepositoryBaselineSource({
    root: fixture.retained,
    taskId: TASK_ID,
    workspaceId: WORKSPACE_ID,
    repositoryId: REPOSITORY_ID,
    baseRevision: fixture.revision,
    manifest: fixture.entries,
    maxFileBytes: 4096,
  });
}

function diffOptions(fixture: Fixture, overrides: Partial<RepositoryDiffMeasurementOptions> = {}): RepositoryDiffMeasurementOptions {
  return {
    baseline: baselineSource(fixture),
    taskId: TASK_ID,
    workspaceId: WORKSPACE_ID,
    repositoryId: REPOSITORY_ID,
    binding: binding({ baseRevision: fixture.revision }),
    filesystem: new WorkspaceFilesystemPort({ root: fixture.current }),
    guard: passThroughGuard(),
    maxFileBytes: 4096,
    maxDiffBytes: 65536,
    ...overrides,
  };
}

/** Counts workspace access so a refusal can be shown to happen before any read. */
function countingFilesystem(root: string): { readonly port: TrustedFilesystemPort; readonly calls: { count: number } } {
  const inner = new WorkspaceFilesystemPort({ root });
  const calls = { count: 0 };
  const port: TrustedFilesystemPort = {
    provenance: inner.provenance,
    stat: path => inner.stat(path),
    lstat: path => inner.lstat(path),
    realpath: path => inner.realpath(path),
    readDir: path => {
      calls.count++;
      return inner.readDir(path);
    },
    readTextFile: (path, maxBytes) => {
      calls.count++;
      return inner.readTextFile(path, maxBytes);
    },
    getCurrentRevisionDigest: () => {
      calls.count++;
      return inner.getCurrentRevisionDigest();
    },
  };
  return { port, calls };
}

/** Reports the supplied entry name from the workspace root, so hostile names can be exercised here. */
function namedEntryFilesystem(revision: string, name: string): TrustedFilesystemPort {
  const entry: TrustedFilesystemEntry = { name, isDirectory: false, isFile: true, isSymbolicLink: false };
  const file: FileStat = { isFile: true, isDirectory: false, isSymbolicLink: false, size: 5 };
  return {
    provenance: 'mock',
    stat: async () => file,
    lstat: async () => file,
    realpath: async path => path,
    readDir: async dir => (dir === '' ? [entry] : []),
    readTextFile: async () => 'evil\n',
    getCurrentRevisionDigest: async () => revision,
  };
}

test(
  'repository diff: changed, added and deleted files produce an exact canonical diff',
  withFixture(async fixture => {
    writeFileSync(join(fixture.current, 'src', 'app.py'), 'def add(a, b):\n    return a + b\n');
    writeFileSync(join(fixture.current, 'src', 'extra.py'), 'NEW = True\n');
    rmSync(join(fixture.current, 'README.md'));

    const result = await measureRepositoryDiff(diffOptions(fixture));

    assert.deepEqual(result.changedFiles, ['README.md', 'src/app.py', 'src/extra.py'], 'changed paths are the exact sorted inventory');
    assert.equal(result.diffDigest, computeCanonicalSha256(result.diff));
    assert.match(result.diffDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(
      result.diff,
      [
        '--- a/README.md',
        '+++ /dev/null',
        '@@ -1,1 +0,0 @@',
        '-# demo',
        '--- a/src/app.py',
        '+++ b/src/app.py',
        '@@ -1,2 +1,2 @@',
        '-def add(a, b):',
        '-    return a - b',
        '+def add(a, b):',
        '+    return a + b',
        '--- /dev/null',
        '+++ b/src/extra.py',
        '@@ -0,0 +1,1 @@',
        '+NEW = True',
        '',
      ].join('\n'),
    );

    const parsed = parseUnifiedDiff(result.diff);
    assert.ok(parsed, 'the measured diff is a unified diff the reviewer accepts');
    assert.deepEqual(Object.keys(parsed).sort(), [...result.changedFiles]);
    assert.deepEqual(parsed['src/app.py'], { oldLines: [1, 2], newLines: [1, 2] });
    assert.deepEqual(parsed['README.md'], { oldLines: [1], newLines: [] });
    assert.deepEqual(parsed['src/extra.py'], { oldLines: [], newLines: [1] });
  }),
);

test(
  'repository diff: an unchanged tree measures an empty diff, not a partial one',
  withFixture(async fixture => {
    const result = await measureRepositoryDiff(diffOptions(fixture));
    assert.equal(result.diff, '');
    assert.equal(result.diffDigest, computeCanonicalSha256(''));
    assert.deepEqual(result.changedFiles, []);
  }),
);

test(
  'repository diff: an absent, mutated or wrong-base baseline refuses',
  withFixture(async fixture => {
    await assert.rejects(
      () => measureRepositoryDiff(diffOptions(fixture, { binding: binding({ baseRevision: `sha256:${'0'.repeat(64)}` }) })),
      /REVISION_MISMATCH/,
      'a base revision the retention does not record is refused',
    );

    writeFileSync(join(fixture.retained, 'src', 'app.py'), 'def add(a, b):\n    return a * b\n');
    await assert.rejects(() => measureRepositoryDiff(diffOptions(fixture)), /REVISION_MISMATCH/, 'a mutated retained tree is refused');

    rmSync(fixture.retained, { recursive: true, force: true });
    await assert.rejects(() => measureRepositoryDiff(diffOptions(fixture)), /MISSING_FILE/, 'an absent retention is unavailable, not an empty baseline');
  }),
);

test(
  'repository diff: a malformed base revision refuses before any workspace read',
  withFixture(async fixture => {
    const { port, calls } = countingFilesystem(fixture.current);
    await assert.rejects(() => measureRepositoryDiff(diffOptions(fixture, { filesystem: port, binding: binding({ baseRevision: 'base-rev' }) })), /INVALID_REQUEST/);
    assert.equal(calls.count, 0, 'no workspace access happens for a malformed request');
  }),
);

test(
  'repository diff: a workspace change during measurement is revision drift',
  withFixture(async fixture => {
    const inner = new WorkspaceFilesystemPort({ root: fixture.current });
    let reads = 0;
    const drifting: TrustedFilesystemPort = {
      provenance: inner.provenance,
      stat: path => inner.stat(path),
      lstat: path => inner.lstat(path),
      realpath: path => inner.realpath(path),
      readDir: path => inner.readDir(path),
      readTextFile: async (path, maxBytes) => {
        const content = await inner.readTextFile(path, maxBytes);
        if (reads++ === 0) writeFileSync(join(fixture.current, 'src', 'late.py'), 'LATE = True\n');
        return content;
      },
      getCurrentRevisionDigest: () => inner.getCurrentRevisionDigest(),
    };

    await assert.rejects(() => measureRepositoryDiff(diffOptions(fixture, { filesystem: drifting })), /REVISION_DRIFT/);
  }),
);

test(
  'repository diff: a protected path or protected content refuses without leaking bytes',
  withFixture(async fixture => {
    const secret = 'TOKEN=super-secret-value\n';
    writeFileSync(join(fixture.current, '.env'), secret);
    await assert.rejects(
      () => measureRepositoryDiff(diffOptions(fixture)),
      (error: Error) => {
        assert.match(error.message, /PROTECTED_CONTENT/);
        assert.ok(!error.message.includes('super-secret-value'), 'the refusal must not echo protected bytes');
        return true;
      },
    );

    rmSync(join(fixture.current, '.env'));
    const key = 'key = "-----BEGIN RSA PRIVATE KEY-----"\n';
    writeFileSync(join(fixture.current, 'src', 'app.py'), key);
    await assert.rejects(
      () => measureRepositoryDiff(diffOptions(fixture)),
      (error: Error) => {
        assert.match(error.message, /PROTECTED_CONTENT/);
        assert.ok(!error.message.includes('BEGIN RSA PRIVATE KEY'), 'the refusal must not echo protected bytes');
        return true;
      },
    );
  }),
);

test(
  'repository diff: binary, per-file oversized and total-oversized output refuse',
  withFixture(async fixture => {
    writeFileSync(join(fixture.current, 'src', 'blob.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]));
    await assert.rejects(() => measureRepositoryDiff(diffOptions(fixture)), /UNREADABLE_FILE/, 'a binary file is not text to diff');
    rmSync(join(fixture.current, 'src', 'blob.bin'));

    await assert.rejects(() => measureRepositoryDiff(diffOptions(fixture, { maxFileBytes: 8 })), /OVERSIZED_FILE/, 'a file above the per-file bound is refused');

    writeFileSync(join(fixture.current, 'src', 'app.py'), 'def add(a, b):\n    return a + b\n');
    await assert.rejects(() => measureRepositoryDiff(diffOptions(fixture, { maxDiffBytes: 32 })), /OVERSIZED_FILE/, 'output above the diff bound is refused, never truncated');
  }),
);

test(
  'repository diff: a link out of the workspace is an escape, not a file',
  withFixture(async (fixture, t) => {
    const outside = mkdtempSync(join(tmpdir(), 'uc03-repository-diff-outside-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    mkdirSync(join(outside, 'src'));
    writeFileSync(join(outside, 'src', 'app.py'), 'ESCAPED = True\n');
    rmSync(join(fixture.current, 'src'), { recursive: true });
    // A junction needs no elevation; a file symlink may.
    try {
      symlinkSync(join(outside, 'src'), join(fixture.current, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip(`cannot create a link without elevation: ${String(error)}`);
      throw error;
    }
    await assert.rejects(() => measureRepositoryDiff(diffOptions(fixture)), /LINKED_ESCAPE/);
  }),
);

test(
  'repository diff: hostile path names from the current tree refuse',
  withFixture(async fixture => {
    for (const name of ['../escape.py', 'a\\b.py', '/abs.py', 'dir//file.py', 'trailing/']) {
      const filesystem = namedEntryFilesystem(fixture.revision, name);
      await assert.rejects(() => measureRepositoryDiff(diffOptions(fixture, { filesystem })), /INVALID_REQUEST/, `'${name}' must not enter the diff`);
    }
  }),
);

test(
  'repository diff: a guard denial refuses before any workspace access',
  withFixture(async fixture => {
    const { port, calls } = countingFilesystem(fixture.current);
    await assert.rejects(() => measureRepositoryDiff(diffOptions(fixture, { filesystem: port, guard: refusedGuard() })), /GUARD_DENIED/);
    assert.equal(calls.count, 0, 'a denied fence performs no workspace read');
  }),
);

test(
  'repository diff: ControlledRepositoryTools.inspectDiff measures through its own guarded ports',
  withFixture(async fixture => {
    writeFileSync(join(fixture.current, 'src', 'app.py'), 'def add(a, b):\n    return a + b\n');
    const { port, calls } = countingFilesystem(fixture.current);
    const tools = new ControlledRepositoryTools({
      guardCapability: passThroughGuard(),
      fsPort: port,
      limits: { maxExcerptBytes: 4096, maxResultCount: 100 },
      repositoryDiff: {
        baseline: baselineSource(fixture),
        taskId: TASK_ID,
        workspaceId: WORKSPACE_ID,
        repositoryId: REPOSITORY_ID,
        maxFileBytes: 4096,
        maxDiffBytes: 65536,
      },
    });

    const measured = await tools.inspectDiff(fixture.revision);
    assert.deepEqual(measured, await measureRepositoryDiff(diffOptions(fixture)));
    assert.ok(calls.count > 0, 'the measurement used the configured workspace port');
    assert.deepEqual(measured.changedFiles, ['src/app.py']);

    await assert.rejects(() => tools.inspectDiff(`sha256:${'0'.repeat(64)}`), /REVISION_MISMATCH/, 'a different base revision is refused');
  }),
);

test(
  'repository diff: inspectDiff without a configured baseline still fails closed',
  withFixture(async fixture => {
    const tools = new ControlledRepositoryTools({
      guardCapability: passThroughGuard(),
      fsPort: new WorkspaceFilesystemPort({ root: fixture.current }),
      limits: { maxExcerptBytes: 4096, maxResultCount: 100 },
    });
    await assert.rejects(() => tools.inspectDiff(fixture.revision), /NOT_IMPLEMENTED/);
  }),
);
