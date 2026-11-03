/**
 * Repository view bridge: the v0.1 view the Docker workspace manager publishes must survive
 * a lift to v0.2 and project back unchanged, with a digest computed for each key set.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { computeCommandViewDigest } from '../../../src/contracts/foundation/uc03.ts';
import type { CommandView } from '../../../src/contracts/foundation/uc03/v01/types.ts';
import { validateRepositoryAdmissionV02 } from '../../../src/contracts/foundation/uc03/v02/admission.ts';
import type { RepositoryAdmissionContextV02 } from '../../../src/contracts/foundation/uc03/v02/ports.ts';
import { admissionCommandView, dockerCommandView } from '../../../src/foundation/repository-admission.ts';
import { createTestRepositoryAdmissionTrustedContextV02, createTestRepositoryCommandAdmissionContextV02 } from '../support/uc03/state-fixtures.ts';

const partialView: Omit<CommandView, 'viewDigest'> = {
  viewId: 'view-ws-1-0123456789ab',
  taskId: 'task-1',
  workspaceId: 'ws-1',
  canonicalRevisionDigest: `sha256:${'a'.repeat(64)}`,
  admittedFiles: [
    { path: 'src/index.ts', digest: `sha256:${'b'.repeat(64)}` },
    { path: 'src/util.ts', digest: `sha256:${'c'.repeat(64)}` },
  ],
  exclusionsPolicyVersion: '0.1.0',
  scratchIdentity: 'scratch-ws-1',
  mountedReadOnly: true,
};
const v01: CommandView = { ...partialView, viewDigest: computeCommandViewDigest(partialView) };
const profileRef = 'profile-standard-v1';

test('v0.1 -> v0.2 -> v0.1 round trip preserves the published view and its digest', () => {
  const v02 = admissionCommandView(v01, profileRef);
  assert.equal(v02.canonicalRevision, v01.canonicalRevisionDigest);
  assert.equal(v02.isolationProfileRef, profileRef);
  assert.deepEqual(v02.admittedFiles, v01.admittedFiles);

  const projected = dockerCommandView({ commandView: v02 } as RepositoryAdmissionContextV02);
  assert.deepEqual(projected, v01);
  assert.equal(projected.viewDigest, v01.viewDigest);
});

test('a builder-published view, lifted and re-admitted, satisfies v0.2 admission', () => {
  const admitted = createTestRepositoryCommandAdmissionContextV02();
  // Start from what the Docker layer publishes for that admission, then lift it back the way a
  // real guard-composed run would have to hand the view to v0.2 admission.
  const published = dockerCommandView(admitted);
  const relifted = admissionCommandView(published, admitted.executionProfileId);
  const trust = createTestRepositoryAdmissionTrustedContextV02({ ...admitted, commandView: relifted });

  assert.equal(relifted.isolationProfileRef, trust.executionProfile.isolationProfileRef);
  assert.equal(relifted.viewDigest, trust.commandViewDigest);

  const accepted = validateRepositoryAdmissionV02({ ...admitted, commandView: relifted }, trust);
  assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.errors.map(e => `${e.code}:${e.path}`).join('\n'));

  // The defect this bridge closes: copying the published digest rather than recomputing it.
  const copied = validateRepositoryAdmissionV02({ ...admitted, commandView: { ...relifted, viewDigest: published.viewDigest } }, trust);
  assert.equal(copied.ok, false, 'a copied v0.1 digest must not be accepted as a v0.2 view digest');
  assert.ok(!copied.ok && copied.errors.some(e => e.code === 'COMMAND_VIEW_DIGEST_MISMATCH'));
});

test('each shape hashes its own key set and is self-consistent', () => {
  const v02 = admissionCommandView(v01, profileRef);
  assert.notEqual(v02.viewDigest, v01.viewDigest);
  assert.equal(v02.viewDigest, computeCommandViewDigest(v02 as unknown as CommandView));
  assert.equal(v01.viewDigest, computeCommandViewDigest(v01));
});
