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
import { applyAdmittedPatch, countPatchEdits } from '../../../src/runtime/real-tier-patch-receiver.ts';
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
    assert.equal(readFileSync(join(root, 'mark.py'), 'utf8'), 'new');
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

test(
  'CR-4652881427: a truncated final hunk is rejected with PATCH_UNPARSEABLE, while complete hunk passes with or without newline',
  withTree({ 'trunc.py': 'line1\nline2\n' }, async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    // Truncated: declares 2 lines in hunk but only supplies 1
    const truncated = '--- a/trunc.py\n+++ b/trunc.py\n@@ -1,2 +1,2 @@\n-line1\n+mod1';
    await assert.rejects(() => applyAdmittedPatch(filesystem, patch(['trunc.py'], truncated), 1024), /PATCH_UNPARSEABLE/);
    const truncatedWithNl = '--- a/trunc.py\n+++ b/trunc.py\n@@ -1,2 +1,2 @@\n-line1\n+mod1\n';
    await assert.rejects(() => applyAdmittedPatch(filesystem, patch(['trunc.py'], truncatedWithNl), 1024), /PATCH_UNPARSEABLE/);

    // Complete without trailing newline passes
    const completeNoNl = '--- a/trunc.py\n+++ b/trunc.py\n@@ -1,2 +1,2 @@\n-line1\n-line2\n+new1\n+new2';
    await applyAdmittedPatch(filesystem, patch(['trunc.py'], completeNoNl), 1024);
    assert.equal(readFileSync(join(root, 'trunc.py'), 'utf8'), 'new1\nnew2\n');
  }),
);

test(
  'CR-4652881423: no-newline marker on old side removes EOF marker, and context line marker affects both sides',
  withTree({ 'old_nonl.py': 'old', 'context.py': 'context' }, async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    // Old file had no newline; patch replaces it with new that has a newline
    const diff1 = '--- a/old_nonl.py\n+++ b/old_nonl.py\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n';
    await applyAdmittedPatch(filesystem, patch(['old_nonl.py'], diff1), 1024);
    assert.equal(readFileSync(join(root, 'old_nonl.py'), 'utf8'), 'new\n');

    // Context line with no newline marker preserves no trailing newline
    const diff2 = '--- a/context.py\n+++ b/context.py\n@@ -1 +1 @@\n context\n\\ No newline at end of file\n';
    await applyAdmittedPatch(filesystem, patch(['context.py'], diff2), 1024);
    assert.equal(readFileSync(join(root, 'context.py'), 'utf8'), 'context');
  }),
);

test(
  'CR-4652881439: rollback attempts every restore even if one fails and attaches unrecovered paths to original error',
  withTree({ 'first.py': 'one\n', 'second.py': 'two\n', 'third.py': 'three\n' }, async root => {
    class FailingRollbackPort extends WorkspaceFilesystemPort {
      private writes = 0;
      override async writeFile(path: string, content: string, maxBytes: number): Promise<void> {
        this.writes += 1;
        // Writes 1 and 2 succeed; write 3 fails (commit error)
        if (this.writes === 3) throw new Error('COMMIT_WRITE_3_FAILED');
        // During rollback, second.py restore fails
        if (this.writes > 3 && path === 'second.py') throw new Error('RESTORE_SECOND_FAILED');
        return super.writeFile(path, content, maxBytes);
      }
    }
    const filesystem = new FailingRollbackPort({ root });
    const diff =
      '--- a/first.py\n+++ b/first.py\n@@ -1 +1 @@\n-one\n+ONE\n' + '--- a/second.py\n+++ b/second.py\n@@ -1 +1 @@\n-two\n+TWO\n' + '--- a/third.py\n+++ b/third.py\n@@ -1 +1 @@\n-three\n+THREE\n';
    let caught: unknown;
    try {
      await applyAdmittedPatch(filesystem, patch(['first.py', 'second.py', 'third.py'], diff), 1024);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error);
    assert.match(caught.message, /COMMIT_WRITE_3_FAILED/);
    assert.match(caught.message, /second\.py/);
    const withUnrecovered = caught as { unrecoveredPaths?: readonly string[] };
    assert.deepEqual(withUnrecovered.unrecoveredPaths, ['second.py']);
    // first.py restore was still attempted and succeeded!
    assert.equal(readFileSync(join(root, 'first.py'), 'utf8'), 'one\n');
  }),
);

test(
  'CR-4652881433: non-UTF-8 target is refused with PATCH_UNPARSEABLE before any write',
  withTree({ 'valid.py': 'valid\n' }, async root => {
    // Write invalid UTF-8 bytes to nonutf8.py
    writeFileSync(join(root, 'nonutf8.py'), Buffer.from([0xff, 0xfe, 0x80, 0x81]));
    const filesystem = new WorkspaceFilesystemPort({ root });
    const diff = '--- a/valid.py\n+++ b/valid.py\n@@ -1 +1 @@\n-valid\n+VALID\n' + '--- a/nonutf8.py\n+++ b/nonutf8.py\n@@ -1 +1 @@\n-x\n+y\n';
    await assert.rejects(() => applyAdmittedPatch(filesystem, patch(['valid.py', 'nonutf8.py'], diff), 1024), /PATCH_UNPARSEABLE/);
    // valid.py was never written
    assert.equal(readFileSync(join(root, 'valid.py'), 'utf8'), 'valid\n');
  }),
);

test('CR-4652881417: countPatchEdits counts added and deleted lines from hunks and returns null for unparseable diff', () => {
  const valid = '--- a/x.py\n+++ b/x.py\n@@ -1,2 +1,3 @@\n-a\n-b\n+c\n+d\n+e\n';
  assert.equal(countPatchEdits(valid), 5);

  const contextOnly = '--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n c\n';
  assert.equal(countPatchEdits(contextOnly), 0);

  const unparseable = 'not a valid diff';
  assert.equal(countPatchEdits(unparseable), null);

  const truncated = '--- a/x.py\n+++ b/x.py\n@@ -1,2 +1,2 @@\n-a\n';
  assert.equal(countPatchEdits(truncated), null);
});

test(
  'CR-4653752280: pure insertion hunk with oldCount 0 uses oldStart as insertion offset',
  withTree({ 'insert.py': 'a\nb\n' }, async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    // Inserting after line 1 ('a') using @@ -1,0 +2 @@
    const diff = '--- a/insert.py\n+++ b/insert.py\n@@ -1,0 +2 @@\n+inserted\n';
    await applyAdmittedPatch(filesystem, patch(['insert.py'], diff), 1024);
    assert.equal(readFileSync(join(root, 'insert.py'), 'utf8'), 'a\ninserted\nb\n');
  }),
);

test(
  'CR-4653752286: planWrites validates oldPath and newPath, refusing renames and creation over existing file',
  withTree({ 'source.py': 'x = 1\n', 'dest.py': 'y = 2\n' }, async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });

    // 1. Rename (different oldPath and newPath) is refused with PATCH_PATH_REFUSED
    const renameDiff = '--- a/source.py\n+++ b/dest.py\n@@ -1 +1 @@\n-x = 1\n+x = 2\n';
    await assert.rejects(() => applyAdmittedPatch(filesystem, patch(['dest.py'], renameDiff), 1024), /PATCH_PATH_REFUSED/, 'rename section must be refused with PATCH_PATH_REFUSED');

    // 2. Creation from /dev/null where destination already exists is refused with PATCH_PATH_REFUSED
    const createExistingDiff = '--- /dev/null\n+++ b/dest.py\n@@ -0,0 +1 @@\n+new content\n';
    await assert.rejects(
      () => applyAdmittedPatch(filesystem, patch(['dest.py'], createExistingDiff), 1024),
      /PATCH_PATH_REFUSED/,
      'creation over existing file must be refused with PATCH_PATH_REFUSED',
    );

    // Verify neither file was modified
    assert.equal(readFileSync(join(root, 'source.py'), 'utf8'), 'x = 1\n');
    assert.equal(readFileSync(join(root, 'dest.py'), 'utf8'), 'y = 2\n');
  }),
);

test(
  'issue #237: CRLF file + LF diff applies, keeping CRLF on all lines and no bare LF',
  withTree({ 'crlf.py': 'line1\r\nline2\r\n' }, async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    const diff = '--- a/crlf.py\n+++ b/crlf.py\n@@ -1,2 +1,3 @@\n line1\n-line2\n+newline2\n+newline3\n';
    await applyAdmittedPatch(filesystem, patch(['crlf.py'], diff), 1024);
    const content = readFileSync(join(root, 'crlf.py'), 'utf8');
    assert.equal(content, 'line1\r\nnewline2\r\nnewline3\r\n');
    assert.equal(content.includes('\r\n'), true);
    assert.equal(/(?<!\r)\n/.test(content), false, 'output must contain no bare \\n');
  }),
);

test(
  'issue #237: CRLF file + diff whose context line differs in content is refused with PATCH_CONTEXT_MISMATCH',
  withTree({ 'crlf.py': 'line1\r\nline2\r\n' }, async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    const diff = '--- a/crlf.py\n+++ b/crlf.py\n@@ -1,2 +1,2 @@\n wrong_context\n-line2\n+newline2\n';
    await assert.rejects(() => applyAdmittedPatch(filesystem, patch(['crlf.py'], diff), 1024), /PATCH_CONTEXT_MISMATCH/);
    assert.equal(readFileSync(join(root, 'crlf.py'), 'utf8'), 'line1\r\nline2\r\n');
  }),
);

test(
  'issue #237: mixed-ending file is still handled as before and refused on CRLF context line against LF diff',
  withTree({ 'mixed.py': 'crlf_line\r\nlf_line\n' }, async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    const diff = '--- a/mixed.py\n+++ b/mixed.py\n@@ -1,2 +1,2 @@\n crlf_line\n-lf_line\n+newline\n';
    await assert.rejects(() => applyAdmittedPatch(filesystem, patch(['mixed.py'], diff), 1024), /PATCH_CONTEXT_MISMATCH/);
    assert.equal(readFileSync(join(root, 'mixed.py'), 'utf8'), 'crlf_line\r\nlf_line\n');
  }),
);

test(
  'issue #237: CRLF file + CRLF hunk lines diff applies, keeping exact CRLF bytes',
  withTree({ 'crlf.py': 'line1\r\nline2\r\n' }, async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    const diff = '--- a/crlf.py\r\n+++ b/crlf.py\r\n@@ -1,2 +1,2 @@\r\n line1\r\n-line2\r\n+newline2\r\n';
    await applyAdmittedPatch(filesystem, patch(['crlf.py'], diff), 1024);
    const content = readFileSync(join(root, 'crlf.py'), 'utf8');
    assert.equal(content, 'line1\r\nnewline2\r\n');
  }),
);

test(
  'issue #237: CRLF file + CRLF-bearing pure-addition hunk at EOF applies with no double CR',
  withTree({ 'crlf.py': 'line1\r\nline2\r\n' }, async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    const diff = '--- a/crlf.py\r\n+++ b/crlf.py\r\n@@ -2,0 +3 @@\r\n+line3\r\n';
    await applyAdmittedPatch(filesystem, patch(['crlf.py'], diff), 1024);
    const content = readFileSync(join(root, 'crlf.py'), 'utf8');
    assert.equal(content, 'line1\r\nline2\r\nline3\r\n');
    assert.equal(content.includes('\r\r'), false, 'output must contain no doubled \\r');
  }),
);
