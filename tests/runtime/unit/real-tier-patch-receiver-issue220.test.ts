/**
 * Regression tests for GitHub issue #220 (real-tier patch receiver and filesystem port failure windows):
 * - Item 3: revision measurement inside rollback boundary; failure restores targets or throws explicit recovery-required
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ApplyPatchAction } from '../../../src/contracts/foundation/uc03.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import { applyAdmittedPatch } from '../../../src/runtime/real-tier-patch-receiver.ts';

const REVISION = `sha256:${'a'.repeat(64)}`;

function patchAction(targetPaths: readonly string[], patchContent: string): ApplyPatchAction {
  return { actionId: 'item3-patch', kind: 'apply_patch', targetPaths, baseRevisionDigest: REVISION, patchContent };
}

test('Item 3: applyAdmittedPatch restores committed targets when getCurrentRevisionDigest fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uc03-patch-reg-'));
  try {
    writeFileSync(join(root, 'target1.py'), 'orig1\n');
    writeFileSync(join(root, 'target2.py'), 'orig2\n');

    class FailingMeasurementPort extends WorkspaceFilesystemPort {
      override async getCurrentRevisionDigest(): Promise<string> {
        throw new Error('SIMULATED_MEASUREMENT_FAILURE');
      }
    }

    const fs = new FailingMeasurementPort({ root });
    const diff = '--- a/target1.py\n+++ b/target1.py\n@@ -1 +1 @@\n-orig1\n+MOD1\n' + '--- a/target2.py\n+++ b/target2.py\n@@ -1 +1 @@\n-orig2\n+MOD2\n';

    await assert.rejects(() => applyAdmittedPatch(fs, patchAction(['target1.py', 'target2.py'], diff), 1024), /SIMULATED_MEASUREMENT_FAILURE/);

    // Both files must be restored to original bytes!
    assert.equal(readFileSync(join(root, 'target1.py'), 'utf8'), 'orig1\n', 'target1.py must be restored');
    assert.equal(readFileSync(join(root, 'target2.py'), 'utf8'), 'orig2\n', 'target2.py must be restored');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Item 3: applyAdmittedPatch throws explicit PATCH_RECOVERY_REQUIRED when restoration fails after measurement failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uc03-patch-reg-'));
  try {
    writeFileSync(join(root, 'target1.py'), 'orig1\n');
    writeFileSync(join(root, 'target2.py'), 'orig2\n');

    class FailingMeasurementAndRollbackPort extends WorkspaceFilesystemPort {
      private rollbackAttempt = false;

      override async getCurrentRevisionDigest(): Promise<string> {
        this.rollbackAttempt = true;
        throw new Error('SIMULATED_MEASUREMENT_FAILURE');
      }

      override async writeFile(path: string, content: string, maxBytes: number): Promise<void> {
        if (this.rollbackAttempt && path === 'target2.py') {
          throw new Error('SIMULATED_ROLLBACK_FAILURE');
        }
        return super.writeFile(path, content, maxBytes);
      }
    }

    const fs = new FailingMeasurementAndRollbackPort({ root });
    const diff = '--- a/target1.py\n+++ b/target1.py\n@@ -1 +1 @@\n-orig1\n+MOD1\n' + '--- a/target2.py\n+++ b/target2.py\n@@ -1 +1 @@\n-orig2\n+MOD2\n';

    let caught: unknown;
    try {
      await applyAdmittedPatch(fs, patchAction(['target1.py', 'target2.py'], diff), 1024);
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof Error);
    assert.match(caught.message, /PATCH_RECOVERY_REQUIRED/);
    const typed = caught as { recoveryRequired?: boolean; unrecoveredPaths?: readonly string[] };
    assert.equal(typed.recoveryRequired, true, 'recoveryRequired must be true');
    assert.deepEqual(typed.unrecoveredPaths, ['target2.py'], 'unrecoveredPaths must record target2.py');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
