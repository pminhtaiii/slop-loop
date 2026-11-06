/**
 * WorkspaceFilesystemPort: the real TrustedFilesystemPort the guard-backed reader needs.
 * The overflow probe is the contract that keeps an oversized file from ever being loaded.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
