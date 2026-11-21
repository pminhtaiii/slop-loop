/**
 * WorkspaceFilesystemPort: the real TrustedFilesystemPort the guard-backed reader needs.
 * The overflow probe is the contract that keeps an oversized file from ever being loaded.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkspaceFilesystemPort, readProbe } from '../../../src/foundation/host-filesystem-port.ts';

function withWorkspace(run: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc03-fs-port-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'a.py'), 'x = 1\n');
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  'workspace filesystem port: stats, lists and resolves inside the workspace',
  withWorkspace(async root => {
    const port = new WorkspaceFilesystemPort({ root });
    assert.equal(port.provenance, 'real');

    const file = await port.stat('src/a.py');
    assert.deepEqual(
      { isFile: file.isFile, isDirectory: file.isDirectory, isSymbolicLink: file.isSymbolicLink, size: file.size },
      { isFile: true, isDirectory: false, isSymbolicLink: false, size: 6 },
    );
    assert.equal((await port.stat('src')).isDirectory, true);

    const entries = await port.readDir('src');
    assert.deepEqual(
      entries.map(entry => entry.name),
      ['a.py'],
    );
    assert.equal(await port.realpath(''), '', 'the workspace root resolves to the empty canonical path');
    assert.equal(await port.realpath('src/a.py'), 'src/a.py');
    assert.equal(await port.readTextFile('src/a.py'), 'x = 1\n');
    assert.deepEqual(await port.readBytes('src/a.py', 6), Buffer.from('x = 1\n'));
    await assert.rejects(port.readBytes('src', 6), /regular file/);
  }),
);

test(
  'workspace filesystem port: an oversized read fails at maxBytes without loading the file',
  withWorkspace(async root => {
    const port = new WorkspaceFilesystemPort({ root });
    writeFileSync(join(root, 'src', 'big.py'), 'y' + 'z'.repeat(4096));

    await assert.rejects(() => port.readTextFile('src/big.py', 1024), /FILE_TOO_LARGE/, 'a file one byte over the limit must be refused');
    assert.equal(await port.readTextFile('src/big.py', 4097), 'y' + 'z'.repeat(4096), 'a file exactly at the limit must read');
  }),
);

test(
  'workspace filesystem port: a link out of the workspace resolves to an absolute path for containment to refuse',
  withWorkspace(async root => {
    const port = new WorkspaceFilesystemPort({ root });
    // A Windows junction needs no elevation; elsewhere a plain directory link.
    symlinkSync(join(root, '..'), join(root, 'src', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

    const resolved = await port.realpath('src/escape');
    assert.ok(resolved.startsWith('/') || /^[a-zA-Z]:/.test(resolved), `an escaping link must resolve absolutely, got '${resolved}'`);
    await assert.rejects(() => port.stat('../etc/passwd'), /WORKSPACE_ESCAPE/, 'a non-canonical path never reaches the filesystem');
  }),
);

test('workspace filesystem port: a symlinked root still resolves containment', async t => {
  const real = mkdtempSync(join(tmpdir(), 'uc03-fs-port-real-'));
  const link = join(mkdtempSync(join(tmpdir(), 'uc03-fs-port-link-')), 'root');
  try {
    mkdirSync(join(real, 'src'));
    writeFileSync(join(real, 'src', 'a.py'), 'x = 1\n');
    // A Windows junction needs no elevation; elsewhere a plain directory link.
    try {
      symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip(`cannot create a link without elevation: ${String(error)}`);
      throw error;
    }

    const port = new WorkspaceFilesystemPort({ root: link });
    assert.equal(await port.realpath('src/a.py'), 'src/a.py', 'the canonicalized root must contain its own files');
    assert.equal(await port.readTextFile('src/a.py'), 'x = 1\n');
  } finally {
    rmSync(link, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test('workspace filesystem port: the size probe keeps reading through short reads', async () => {
  const source = Buffer.from('0123456789');
  const fakeRead = async (buffer: Buffer, offset: number, length: number, position: number): Promise<number> => {
    const bytesRead = Math.min(length, 2, source.length - position);
    source.copy(buffer, offset, position, position + bytesRead);
    return bytesRead;
  };

  const probe = Buffer.alloc(8);
  assert.equal(await readProbe(probe, fakeRead), 8, 'short reads must accumulate to the full probe window');
  assert.equal(probe.toString('utf8'), '01234567');

  assert.equal(await readProbe(Buffer.alloc(12), fakeRead), 10, 'EOF stops the loop and reports the true length');
});

test(
  'workspace filesystem port: the revision digest is deterministic and content-bound',
  withWorkspace(async root => {
    const port = new WorkspaceFilesystemPort({ root });
    const first = await port.getCurrentRevisionDigest();
    assert.equal(await port.getCurrentRevisionDigest(), first, 'the same tree must digest identically');

    writeFileSync(join(root, 'src', 'a.py'), 'x = 2\n');
    assert.notEqual(await port.getCurrentRevisionDigest(), first, 'changed bytes must change the digest');
  }),
);

test(
  'workspace filesystem port: the revision digest honours the per-file bound without loading an oversized file',
  withWorkspace(async root => {
    const port = new WorkspaceFilesystemPort({ root });
    writeFileSync(join(root, 'src', 'big.py'), 'y' + 'z'.repeat(4096));

    await assert.rejects(() => port.getCurrentRevisionDigest(4096), /FILE_TOO_LARGE/, 'a file one byte over the bound must refuse the digest');
    assert.equal(await port.getCurrentRevisionDigest(4097), await port.getCurrentRevisionDigest(), 'a bound at or above the file must digest identically to the unbounded read');
  }),
);

test(
  'workspace filesystem port: bounded traversal uses canonical paths and preserves the tree digest',
  withWorkspace(async root => {
    const port = new WorkspaceFilesystemPort({ root });
    const control = { signal: new AbortController().signal, deadlineEpochMs: Date.now() + 5_000 };
    const entries = await port.readDirBounded('src', 1, control);
    assert.deepEqual(
      entries.map(entry => entry.name),
      ['a.py'],
    );
    const limits = { maxEntries: 2, maxFiles: 1, maxBytes: 256 };
    assert.equal(await port.getCurrentRevisionDigestBounded(limits, control), await port.getCurrentRevisionDigest());
  }),
);

test(
  'F-211-01: a parent link out of the workspace is refused with zero effects, and no directory is created',
  withWorkspace(async root => {
    const port = new WorkspaceFilesystemPort({ root });
    const outside = mkdtempSync(join(tmpdir(), 'uc03-fs-port-outside-'));
    try {
      symlinkSync(outside, join(root, 'parent'), process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(() => port.writeFile('parent/created/file.py', 'x', 1024), /WORKSPACE_ESCAPE/);
      assert.equal(existsSync(join(outside, 'created')), false, 'no directory may be created outside the workspace');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }),
);

test(
  'F-211-01: a final-component link is refused instead of followed to its target',
  withWorkspace(async root => {
    const port = new WorkspaceFilesystemPort({ root });
    const outside = join(mkdtempSync(join(tmpdir(), 'uc03-fs-port-target-')), 'outside.py');
    writeFileSync(outside, 'old\n');
    try {
      // A file symlink may need elevation on Windows; only a created link is exercised.
      try {
        symlinkSync(outside, join(root, 'link.py'), 'file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
        throw error;
      }
      await assert.rejects(() => port.writeFile('link.py', 'changed\n', 1024), /WORKSPACE_ESCAPE/);
      assert.equal(readFileSync(outside, 'utf8'), 'old\n', 'the link target outside the workspace is never written');
    } finally {
      rmSync(join(outside, '..'), { recursive: true, force: true });
    }
  }),
);

test(
  'F-211-01: a nested missing parent is created under the root, one contained level at a time',
  withWorkspace(async root => {
    const port = new WorkspaceFilesystemPort({ root });
    await port.writeFile('pkg/nested/new.py', 'value = 1\n', 1024);
    assert.equal(readFileSync(join(root, 'pkg/nested/new.py'), 'utf8'), 'value = 1\n');
    assert.equal(existsSync(join(root, 'pkg/nested')), true);
  }),
);

test(
  'F-211-02: removeFile undoes a created file and refuses a directory target',
  withWorkspace(async root => {
    const port = new WorkspaceFilesystemPort({ root });
    await port.writeFile('undo/created.py', 'x\n', 1024);
    await port.removeFile('undo/created.py');
    assert.equal(existsSync(join(root, 'undo/created.py')), false);
    await assert.rejects(() => port.removeFile('src'), /WORKSPACE_ESCAPE/);
  }),
);
