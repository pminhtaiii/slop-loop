/**
 * The real-tier patch receiver's refusal and atomicity rows (issue #211 merger findings).
 *
 * Each row drives `applyAdmittedPatch` against a real host tree through the real
 * `WorkspaceFilesystemPort`: a deletion, a malformed section, a content-excluded target and an
 * oversized target are each refused before any effect, and a failure midway restores what was
 * already written. No real Docker, endpoint or credential is involved.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import { applyAdmittedPatch } from '../../../src/runtime/real-tier-patch-receiver.ts';
import type { ApplyPatchAction } from '../../../src/contracts/foundation/uc03.ts';

const BASE = `sha256:${'a'.repeat(64)}`;

function patch(targetPaths: readonly string[], patchContent: string): ApplyPatchAction {
  return { actionId: 'receiver-row', kind: 'apply_patch', targetPaths, baseRevisionDigest: BASE, patchContent };
}

function withTree(files: Readonly<Record<string, string>>, run: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc03-receiver-'));
    try {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), content);
      }
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  'F-211-08: a no-newline marker after the last hunk line is accepted',
  withTree({ 'mark.py': 'old\n' }, async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    await applyAdmittedPatch(filesystem, patch(['mark.py'], '--- a/mark.py\n+++ b/mark.py\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n'), 1024);
    assert.match(readFileSync(join(root, 'mark.py'), 'utf8'), /^new/);
  }),
);

test(
  'F-211-09: a backslash line that is not the exact no-newline marker is refused',
  withTree({ 'mark.py': 'old\n' }, async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    for (const diff of ['--- a/mark.py\n+++ b/mark.py\n@@ -1 +1 @@\n-old\n+new\n\\ arbitrary malformed content\n', '--- a/mark.py\n+++ b/mark.py\n@@ -1,2 +1,2 @@\n-old\n\\ arbitrary\n+new\n']) {
      await assert.rejects(() => applyAdmittedPatch(filesystem, patch(['mark.py'], diff), 1024), /PATCH_UNPARSEABLE/);
    }
    assert.equal(readFileSync(join(root, 'mark.py'), 'utf8'), 'old\n');
  }),
);

test(
  'F-211-03: a /dev/null destination is a deletion and is refused with the original bytes kept',
  withTree({ 'delete.py': 'old\n' }, async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    await assert.rejects(() => applyAdmittedPatch(filesystem, patch(['delete.py'], '--- a/delete.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n'), 1024), /PATCH_DELETION_REFUSED/);
    assert.equal(readFileSync(join(root, 'delete.py'), 'utf8'), 'old\n');
  }),
);

test(
  'F-211-02: a malformed section refuses the whole patch before the first write',
  withTree({ 'second.py': 'old\n' }, async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    // The first section creates new.py with no hunk; the second is a valid edit. Nothing may land.
    const diff = '--- /dev/null\n+++ b/new.py\n--- a/second.py\n+++ b/second.py\n@@ -1 +1 @@\n-old\n+changed\n';
    await assert.rejects(() => applyAdmittedPatch(filesystem, patch(['new.py', 'second.py'], diff), 1024), /PATCH_UNPARSEABLE/);
    assert.equal(existsSync(join(root, 'new.py')), false, 'the first file must not be created');
    assert.equal(readFileSync(join(root, 'second.py'), 'utf8'), 'old\n', 'the second file must be unchanged');
  }),
);

test(
  'F-211-02: an oversized later target leaves no earlier write behind',
  withTree({ 'second.py': 'old\n' }, async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    // new.py is a new file over the byte bound; second.py is a valid edit that must not survive.
    const diff = '--- /dev/null\n+++ b/new.py\n@@ -0,0 +1 @@\n+' + 'x'.repeat(64) + '\n--- a/second.py\n+++ b/second.py\n@@ -1 +1 @@\n-old\n+changed\n';
    await assert.rejects(() => applyAdmittedPatch(filesystem, patch(['new.py', 'second.py'], diff), 32), /FILE_TOO_LARGE/);
    assert.equal(existsSync(join(root, 'new.py')), false, 'the oversized target is never created');
    assert.equal(readFileSync(join(root, 'second.py'), 'utf8'), 'old\n');
  }),
);

test(
  'F-211-04: a content-excluded target is refused before its bytes are rewritten',
  withTree({ 'excluded.py': 'MARKER_SECRET_SYNTHETIC_ONLY\n' }, async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    const source = 'MARKER_SECRET_SYNTHETIC_ONLY\n';
    await assert.rejects(() => applyAdmittedPatch(filesystem, patch(['excluded.py'], `--- a/excluded.py\n+++ b/excluded.py\n@@ -1 +1 @@\n-${source}+ordinary\n`), 1024), /PATCH_PATH_REFUSED/);
    assert.equal(readFileSync(join(root, 'excluded.py'), 'utf8'), source, 'the excluded file is untouched');
  }),
);

test(
  'F-211-01: an in-workspace junction to an outside directory receives no created file',
  withTree({ 'keep.py': 'x\n' }, async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    const outside = mkdtempSync(join(tmpdir(), 'uc03-receiver-outside-'));
    try {
      symlinkSync(outside, join(root, 'parent'), process.platform === 'win32' ? 'junction' : 'dir');
      const diff = '--- /dev/null\n+++ b/parent/created/file.py\n@@ -0,0 +1 @@\n+value\n';
      await assert.rejects(() => applyAdmittedPatch(filesystem, patch(['parent/created/file.py'], diff), 1024), /WORKSPACE_ESCAPE/);
      assert.equal(existsSync(join(outside, 'created')), false, 'zero effects outside the workspace');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }),
);

test(
  'F-211-02: a failure during commit restores the files already written',
  withTree({ 'first.py': 'one\n', 'second.py': 'two\n' }, async root => {
    // A fee-drive that fails the second write: the first write must be rolled back to its original bytes.
    class FailingSecondWrite extends WorkspaceFilesystemPort {
      private writes = 0;
      override async writeFile(path: string, content: string, maxBytes: number): Promise<void> {
        this.writes += 1;
        if (this.writes === 2) throw new Error('SIMULATED_IO_FAILURE');
        return super.writeFile(path, content, maxBytes);
      }
    }
    const filesystem = new FailingSecondWrite({ root });
    const diff = '--- a/first.py\n+++ b/first.py\n@@ -1 +1 @@\n-one\n+ONE\n--- a/second.py\n+++ b/second.py\n@@ -1 +1 @@\n-two\n+TWO\n';
    await assert.rejects(() => applyAdmittedPatch(filesystem, patch(['first.py', 'second.py'], diff), 1024), /SIMULATED_IO_FAILURE/);
    assert.equal(readFileSync(join(root, 'first.py'), 'utf8'), 'one\n', 'the earlier write is restored');
    assert.equal(readFileSync(join(root, 'second.py'), 'utf8'), 'two\n', 'the failed file is untouched');
  }),
);
