/**
 * T033 — retained initial repository content. The source measures a caller-prepared retention
 * directory; these checks prove the manifest/content lookups, every refusal, and that a
 * continuation reads bytes from retention rather than from process memory.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { computeFileDigest } from '../../../src/foundation/docker-workspace-policy.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import {
  createRepositoryBaselineSource,
  type RepositoryBaselineBinding,
  type RepositoryBaselineManifestEntry,
  type RepositoryBaselineSourceOptions,
} from '../../../src/runtime/repository-baseline-source.ts';

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
  readonly entries: readonly RepositoryBaselineManifestEntry[];
  readonly knownRevision: string;
}

async function makeFixture(): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), 'uc03-baseline-source-'));
  const retained = join(base, 'retained');
  for (const [path, content] of Object.entries(INITIAL)) {
    mkdirSync(dirname(join(retained, path)), { recursive: true });
    writeFileSync(join(retained, path), content);
  }
  const filesystem = new WorkspaceFilesystemPort({ root: retained });
  const entries = await Promise.all(
    Object.entries(INITIAL).map(async ([path, content]) => ({
      path,
      digest: computeFileDigest(content),
      sizeBytes: Buffer.byteLength(content, 'utf8'),
    })),
  );
  const knownRevision = await filesystem.getCurrentRevisionDigest();
  return { base, retained, entries, knownRevision };
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

function source(fixture: Fixture, overrides: Partial<RepositoryBaselineSourceOptions> = {}) {
  return createRepositoryBaselineSource({
    root: fixture.retained,
    taskId: TASK_ID,
    workspaceId: WORKSPACE_ID,
    repositoryId: REPOSITORY_ID,
    baseRevision: fixture.knownRevision,
    manifest: fixture.entries,
    maxFileBytes: 4096,
    ...overrides,
  });
}

function binding(overrides: Partial<RepositoryBaselineBinding> = {}): RepositoryBaselineBinding {
  return { taskId: TASK_ID, workspaceId: WORKSPACE_ID, repositoryId: REPOSITORY_ID, baseRevision: '', ...overrides };
}

test(
  'repository baseline: the manifest and bounded lookup return retained bytes',
  withFixture(async fixture => {
    const retained = source(fixture);
    const manifest = await retained.loadManifest({ ...binding(), baseRevision: fixture.knownRevision });

    assert.equal(manifest.baseRevision, fixture.knownRevision);
    assert.deepEqual(
      manifest.entries.map(entry => entry.path),
      ['README.md', 'src/app.py', 'tests/test_app.py'],
      'manifest entries are canonical and sorted',
    );
    assert.match(manifest.manifestDigest, /^sha256:[a-f0-9]{64}$/);

    const file = await retained.readBaselineFile({ ...binding(), baseRevision: fixture.knownRevision }, 'src/app.py');
    assert.equal(file.content, INITIAL['src/app.py']);
    assert.equal(file.digest, computeFileDigest(INITIAL['src/app.py'] ?? ''));
    assert.equal(file.sizeBytes, Buffer.byteLength(INITIAL['src/app.py'] ?? '', 'utf8'));
  }),
);

test(
  'repository baseline: changed, deleted and added current files are measured against retained bytes',
  withFixture(async fixture => {
    const retained = source(fixture);
    const lookup = { ...binding(), baseRevision: fixture.knownRevision };
    const manifest = await retained.loadManifest(lookup);

    const currentRoot = join(fixture.base, 'current');
    mkdirSync(join(currentRoot, 'src'), { recursive: true });
    mkdirSync(join(currentRoot, 'tests'), { recursive: true });
    writeFileSync(join(currentRoot, 'src', 'app.py'), 'def add(a, b):\n    return a + b\n');
    writeFileSync(join(currentRoot, 'tests', 'test_app.py'), INITIAL['tests/test_app.py'] ?? '');
    writeFileSync(join(currentRoot, 'src', 'extra.py'), 'NEW = True\n');
    const current = new WorkspaceFilesystemPort({ root: currentRoot });

    const changed = await retained.readBaselineFile(lookup, 'src/app.py');
    assert.equal(changed.content, INITIAL['src/app.py'], 'baseline keeps the initial bytes after the current tree changed');
    assert.notEqual(await current.readTextFile('src/app.py'), changed.content);
    await assert.rejects(async () => current.readTextFile('README.md'), 'the file is deleted in the current tree');
    assert.deepEqual(await current.readTextFile('src/extra.py'), 'NEW = True\n');
    await assert.rejects(async () => retained.readBaselineFile(lookup, 'src/extra.py'), /INVALID_REQUEST/, 'an added file is not in the retained manifest');
    assert.equal(manifest.entries.length, Object.keys(INITIAL).length);
  }),
);

test(
  'repository baseline: a tree file outside the manifest or a manifest path absent from the tree refuses',
  withFixture(async (fixture, t) => {
    const retained = source(fixture);
    const lookup = { ...binding(), baseRevision: fixture.knownRevision };

    writeFileSync(join(fixture.retained, 'unlisted.py'), 'EXTRA = True\n');
    t.after(() => rmSync(join(fixture.retained, 'unlisted.py'), { force: true }));
    await assert.rejects(async () => retained.loadManifest(lookup), /INVALID_CONFIGURATION/, 'a retained file omitted from the manifest is refused');

    rmSync(join(fixture.retained, 'unlisted.py'));
    rmSync(join(fixture.retained, 'README.md'));
    await assert.rejects(async () => retained.loadManifest(lookup), /INVALID_CONFIGURATION/, 'a manifest path absent from the tree is refused');
  }),
);

test(
  'repository baseline: a changed retained byte is source drift',
  withFixture(async fixture => {
    const retained = source(fixture);
    const lookup = { ...binding(), baseRevision: fixture.knownRevision };
    writeFileSync(join(fixture.retained, 'src', 'app.py'), 'def add(a, b):\n    return a * b\n');

    await assert.rejects(async () => retained.loadManifest(lookup), /REVISION_MISMATCH/, 'the retained tree revision no longer matches');
    await assert.rejects(async () => retained.readBaselineFile(lookup, 'src/app.py'), /REVISION_MISMATCH/, 'the individual file digest no longer matches');
  }),
);

test(
  'repository baseline: wrong task, workspace, repository or base revision refuses',
  withFixture(async fixture => {
    const retained = source(fixture);
    for (const wrong of [{ taskId: 'task-2' }, { workspaceId: 'ws-2' }, { repositoryId: 'repo-2' }, { baseRevision: `sha256:${'0'.repeat(64)}` }]) {
      await assert.rejects(async () => retained.loadManifest({ ...binding(), baseRevision: fixture.knownRevision, ...wrong }), /IDENTITY_MISMATCH|REVISION_MISMATCH/);
      await assert.rejects(async () => retained.readBaselineFile({ ...binding(), baseRevision: fixture.knownRevision, ...wrong }, 'README.md'), /IDENTITY_MISMATCH|REVISION_MISMATCH/);
    }
  }),
);

test(
  'repository baseline: a missing retention directory is unavailable, not an empty baseline',
  withFixture(async fixture => {
    const lookup = { ...binding(), baseRevision: fixture.knownRevision };
    rmSync(fixture.retained, { recursive: true, force: true });
    const retained = source(fixture);
    await assert.rejects(async () => retained.loadManifest(lookup), /MISSING_FILE/);
    await assert.rejects(async () => retained.readBaselineFile(lookup, 'README.md'), /MISSING_FILE/);
  }),
);

test(
  'repository baseline: protected paths, protected content and oversized files refuse',
  withFixture(async fixture => {
    const lookup = { ...binding(), baseRevision: fixture.knownRevision };
    assert.throws(
      () => source(fixture, { manifest: [...fixture.entries, { path: '.env', digest: computeFileDigest('A=1\n'), sizeBytes: 4 }] }),
      /INVALID_CONFIGURATION/,
      'a protected manifest path is refused at configuration time',
    );

    const retained = source(fixture);
    await assert.rejects(async () => retained.readBaselineFile(lookup, '.env'), /PROTECTED_CONTENT/);
    await assert.rejects(async () => retained.readBaselineFile(lookup, '../outside.py'), /INVALID_REQUEST/);
    await assert.rejects(async () => retained.readBaselineFile(lookup, 'src/unknown.py'), /INVALID_REQUEST/);

    const secret = 'key = "-----BEGIN RSA PRIVATE KEY-----\n"\n';
    writeFileSync(join(fixture.retained, 'README.md'), secret);
    const secretSource = source(fixture, {
      manifest: fixture.entries.map(entry => (entry.path === 'README.md' ? { ...entry, digest: computeFileDigest(secret), sizeBytes: Buffer.byteLength(secret) } : entry)),
    });
    await assert.rejects(async () => secretSource.readBaselineFile(lookup, 'README.md'), /PROTECTED_CONTENT/);
  }),
);

test(
  'repository baseline: an oversized or binary retained file refuses rather than truncating',
  withFixture(async fixture => {
    const lookup = { ...binding(), baseRevision: fixture.knownRevision };
    const big = 'x'.repeat(5000);
    writeFileSync(join(fixture.retained, 'README.md'), big);
    assert.throws(
      () => source(fixture, { manifest: fixture.entries.map(entry => (entry.path === 'README.md' ? { ...entry, sizeBytes: 5000 } : entry)) }),
      /INVALID_CONFIGURATION/,
      'a manifest size above the bound is refused at configuration time',
    );
    await assert.rejects(async () => source(fixture).readBaselineFile(lookup, 'README.md'), /OVERSIZED_FILE/);

    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    writeFileSync(join(fixture.retained, 'README.md'), binary);
    const binarySource = source(fixture, {
      manifest: fixture.entries.map(entry => (entry.path === 'README.md' ? { ...entry, digest: computeFileDigest(binary), sizeBytes: binary.length } : entry)),
    });
    await assert.rejects(async () => binarySource.readBaselineFile(lookup, 'README.md'), /UNREADABLE_FILE/);
  }),
);

test(
  'repository baseline: a link out of retention is an escape, not a retained file',
  withFixture(async (fixture, t) => {
    const outside = mkdtempSync(join(tmpdir(), 'uc03-baseline-source-outside-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    mkdirSync(join(outside, 'src'));
    writeFileSync(join(outside, 'src', 'app.py'), INITIAL['src/app.py'] ?? '');
    rmSync(join(fixture.retained, 'src'), { recursive: true });
    if (process.platform === 'win32') {
      // A junction needs no elevation; a file symlink may.
      try {
        symlinkSync(join(outside, 'src'), join(fixture.retained, 'src'), 'junction');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip(`cannot create a link without elevation: ${String(error)}`);
        throw error;
      }
    } else {
      symlinkSync(join(outside, 'src'), join(fixture.retained, 'src'), 'dir');
    }
    const retained = source(fixture);
    const lookup = { ...binding(), baseRevision: fixture.knownRevision };
    await assert.rejects(async () => retained.loadManifest(lookup), /LINKED_ESCAPE/);
    await assert.rejects(async () => retained.readBaselineFile(lookup, 'src/app.py'), /LINKED_ESCAPE/);
  }),
);

test(
  'repository baseline: continuation reloads the same bytes from retention; writable retention is refused',
  withFixture(async fixture => {
    const lookup = { ...binding(), baseRevision: fixture.knownRevision };
    const first = source(fixture);
    const before = await first.readBaselineFile(lookup, 'tests/test_app.py');

    // A new process would build a new source; only the retention directory carries the bytes.
    const continuation = source(fixture);
    const after = await continuation.readBaselineFile(lookup, 'tests/test_app.py');
    assert.deepEqual(after, before);

    assert.throws(() => source(fixture, { taskWorkspaceRoot: fixture.base }), /INVALID_CONFIGURATION/, 'retention inside writable task authority is refused');
    assert.doesNotThrow(() => source(fixture, { taskWorkspaceRoot: join(fixture.base, 'elsewhere') }), 'an unrelated writable root is allowed');
  }),
);
