/**
 * Repository view bridge: the v0.1 view the Docker workspace manager publishes must survive
 * a lift to v0.2 and project back unchanged, with a digest computed for each key set.
 *
 * Host-composition §9 also lives here: the lift takes the host-issued isolation record instead of a
 * caller-supplied string, so this file carries the record construction (a local controller and
 * operations double) and the ordered refusals. Controlled tier only — no container runs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { computeCommandViewDigest } from '../../../src/contracts/foundation/uc03.ts';
import type { CommandView } from '../../../src/contracts/foundation/uc03/v01/types.ts';
import type { TaskWorkspace } from '../../../src/contracts/foundation/uc03.ts';
import { validateRepositoryAdmissionV02 } from '../../../src/contracts/foundation/uc03/v02/admission.ts';
import type { CommandViewV02, RepositoryAdmissionContextV02 } from '../../../src/contracts/foundation/uc03/v02/ports.ts';
import { buildDockerCommandView, isMeasuredCommandViewIsolation } from '../../../src/foundation/docker-view-builder.ts';
import type { MeasuredCommandViewIsolation, OwnerCommandViewMeasurementV02 } from '../../../src/foundation/docker-view-builder.ts';
import { admissionCommandView, commandExecutionLimits, dockerCommandView } from '../../../src/foundation/repository-admission.ts';
import type { RepositoryCommandResourcePolicy } from '../../../src/foundation/repository-admission.ts';
import { DockerWorkspaceManager, computeFileDigest } from '../../../src/foundation/docker-workspace.ts';
import type { CanonicalRepositorySnapshot, CanonicalSnapshotEntry, DockerLifecycleController, DockerProfile, MaterializeViewParams } from '../../../src/foundation/docker-workspace-types.ts';
import { createTestRepositoryAdmissionTrustedContextV02, createTestRepositoryCommandAdmissionContextV02 } from '../support/uc03/state-fixtures.ts';

const TASK_ID = 'task-calc-001';
const WORKSPACE_ID = 'workspace-001';
const REVISION = `sha256:${'0123456789abcdef'.repeat(4)}`;
const EXCLUSIONS = 'exclusions-v1';
/** Derived scratch volume ids are opaque, so the v0.2 trust fixture's fixed identity is declared here. */
const SCRATCH = 'scratch-admission-v02';
const PROFILE_REF = 'profile-docker-isolated';
const FILES: Record<string, string> = {
  'src/calculator.py': 'class Calculator:\n    def divide(self, a, b):\n        return a / b\n',
  'tests/test_calculator.py': 'def test_divide():\n    assert True\n',
};

function entry(path: string, content: string): CanonicalSnapshotEntry {
  return { path, kind: 'regular', content, digest: computeFileDigest(content) };
}

function snapshot(files: Record<string, string> = FILES): CanonicalRepositorySnapshot {
  return { canonicalRevisionDigest: REVISION, entries: Object.entries(files).map(([path, content]) => entry(path, content)), exclusionsPolicyVersion: EXCLUSIONS };
}

class BridgeController implements DockerLifecycleController {
  readonly provenance = 'mock' as const;
  snapshotToReturn: CanonicalRepositorySnapshot = snapshot();
  readonly volumes: string[] = [];
  readonly materialized: CommandView[] = [];

  async createVolume(volumeId: string): Promise<void> {
    this.volumes.push(volumeId);
  }
  async hasVolume(volumeId: string): Promise<boolean> {
    return this.volumes.includes(volumeId);
  }
  async removeVolume(volumeId: string): Promise<void> {
    this.volumes.splice(this.volumes.indexOf(volumeId), 1);
  }
  async getCanonicalSnapshot(): Promise<CanonicalRepositorySnapshot> {
    return this.snapshotToReturn;
  }
  async materializeView(params: MaterializeViewParams): Promise<void> {
    this.materialized.push(params.view);
  }
}

function workspace(overrides: Partial<TaskWorkspace> = {}): TaskWorkspace {
  return {
    taskId: TASK_ID,
    workspaceId: WORKSPACE_ID,
    containerImageDigest: `sha256:${'d'.repeat(64)}`,
    repoVolumeId: 'vol-repo',
    scratchVolumeId: SCRATCH,
    expectedRepoState: REVISION,
    ...overrides,
  };
}

/** The builder's operations port, without the manager: the lift needs a genuine build, not a manager. */
function operations(ws: TaskWorkspace = workspace()) {
  let published: CommandView | null = null;
  const ops: Parameters<typeof buildDockerCommandView>[2] = {
    getWorkspace: () => ws,
    getCanonicalRevision: () => ws.expectedRepoState,
    acquireReadLease: async () => ({ release: () => undefined }) as never,
    invalidateViews: () => {
      published = null;
    },
    publishView: (_id, view) => {
      published = view;
    },
  };
  return { ops, published: () => published };
}

async function build(
  controller: BridgeController,
  params: { ownerView?: OwnerCommandViewMeasurementV02; workspace?: TaskWorkspace } = {},
): Promise<{ view: CommandView; measured?: MeasuredCommandViewIsolation }> {
  const { ops } = operations(params.workspace);
  const { view, measured } = await buildDockerCommandView(
    { workspaceId: (params.workspace ?? workspace()).workspaceId, ...(params.ownerView !== undefined ? { ownerView: params.ownerView } : {}) },
    controller,
    ops,
  );
  return measured === undefined ? { view } : { view, measured };
}

/** The accepted owner measurement is read off a legitimate build, never guessed. */
async function honest(controller: BridgeController, ws: TaskWorkspace = workspace()): Promise<OwnerCommandViewMeasurementV02> {
  const { view } = await build(controller, { workspace: ws });
  return {
    canonicalRevision: view.canonicalRevisionDigest,
    exclusionsPolicyVersion: view.exclusionsPolicyVersion,
    scratchIdentity: view.scratchIdentity,
    admittedFiles: view.admittedFiles,
    mountedReadOnly: true,
    isolationProfileRef: PROFILE_REF,
  };
}

async function measuredBuild(ws: TaskWorkspace = workspace()): Promise<{ view: CommandView; measured: MeasuredCommandViewIsolation; controller: BridgeController }> {
  const controller = new BridgeController();
  const ownerView = await honest(controller, ws);
  const { view, measured } = await build(controller, { ownerView, workspace: ws });
  assert.ok(isMeasuredCommandViewIsolation(measured), 'an accepted owner measurement must issue a record');
  return { view, measured, controller };
}

function limitsContext(view: CommandViewV02): RepositoryAdmissionContextV02 {
  return {
    finiteBounds: { timeoutMs: 30_000, maxOutputBytes: 65_536, maxCpuSeconds: 120, maxMemoryBytes: 536_870_912, maxProcessCount: 5, isolationProfileRef: view.isolationProfileRef },
    commandView: view,
  } as unknown as RepositoryAdmissionContextV02;
}

const POLICY: RepositoryCommandResourcePolicy = {
  isolationProfileRef: PROFILE_REF,
  limits: { timeoutMs: 60_000, maxOutputBytes: 1_048_576, maxCpuCores: 4, maxMemoryBytes: 1_073_741_824, maxPids: 64 },
};

test('v0.1 -> v0.2 -> v0.1 round trip preserves the published view and its digest', async () => {
  const { view, measured } = await measuredBuild();
  const v02 = admissionCommandView(view, measured);
  assert.equal(v02.canonicalRevision, view.canonicalRevisionDigest);
  assert.equal(v02.isolationProfileRef, PROFILE_REF);
  assert.deepEqual(v02.admittedFiles, view.admittedFiles);

  const projected = dockerCommandView({ commandView: v02 } as RepositoryAdmissionContextV02);
  assert.deepEqual(projected, view);
  assert.equal(projected.viewDigest, view.viewDigest);
});

test('a measured build, lifted and re-admitted, satisfies v0.2 admission', async () => {
  const admitted = createTestRepositoryCommandAdmissionContextV02();
  const built = await measuredBuild();
  // Start from what the Docker layer publishes for that admission, then lift it back the way a
  // real guard-composed run would have to hand the view to v0.2 admission.
  const published = dockerCommandView(admitted);
  const relifted = admissionCommandView(built.view, built.measured);
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

test('each shape hashes its own key set and is self-consistent', async () => {
  const { view, measured } = await measuredBuild();
  const v02 = admissionCommandView(view, measured);
  assert.notEqual(v02.viewDigest, view.viewDigest);
  assert.equal(v02.viewDigest, computeCommandViewDigest(v02 as unknown as CommandView));
  assert.equal(view.viewDigest, computeCommandViewDigest(view));
});

test('the measured isolation reference satisfies the command limits, by value', async () => {
  const { view, measured } = await measuredBuild();
  const limits = commandExecutionLimits(limitsContext(admissionCommandView(view, measured)), POLICY);
  assert.deepEqual(limits, { timeoutMs: 30_000, maxOutputBytes: 65_536, maxCpuCores: 4, maxMemoryBytes: 536_870_912, maxPids: 5 });
});

test('a policy reference that differs from the measured one refuses the command limits', async () => {
  const { view, measured } = await measuredBuild();
  const context = limitsContext(admissionCommandView(view, measured));
  // Only the policy moves: bounds and view stay equal, so the policy term is the one that fires.
  assert.throws(() => commandExecutionLimits(context, { ...POLICY, isolationProfileRef: 'profile-u025' }), /COMMAND_RESOURCE_POLICY_MISMATCH/u);
});

// The four §9 codes in reachable form. Each fixture throws one code; none of them proves precedence.
test('an unmeasured record refuses', async () => {
  const { view } = await measuredBuild();
  assert.throws(() => admissionCommandView(view, { viewId: view.viewId, viewDigest: view.viewDigest, isolationProfileRef: PROFILE_REF }), /ISOLATION_RECORD_UNMEASURED/u);
});

test('a record issued for another view refuses on view identity', async () => {
  const other = workspace({ workspaceId: 'workspace-002' });
  const { measured: foreign } = await measuredBuild(other);
  const { view } = await measuredBuild();
  assert.notEqual(foreign.viewId, view.viewId);
  // Also a digest mismatch, so this fixture orders identity ahead of the digest: a swapped
  // implementation would report ISOLATION_RECORD_DIGEST_MISMATCH here instead.
  assert.notEqual(foreign.viewDigest, view.viewDigest);
  assert.throws(() => admissionCommandView(view, foreign), /ISOLATION_RECORD_VIEW_MISMATCH/u);
});

test('a record issued for an earlier build of the same view refuses on the digest', async () => {
  // Same workspace, same revision: viewId is content-insensitive, so only a second build differs.
  const controller = new BridgeController();
  const ownerView = await honest(controller);
  const { measured: earlier } = await build(controller, { ownerView });
  assert.ok(isMeasuredCommandViewIsolation(earlier));

  controller.snapshotToReturn = snapshot({ ...FILES, 'README.md': '# Calculator Service, revised\n' });
  const revisedOwner = await honest(controller);
  const { view: revised } = await build(controller, { ownerView: revisedOwner });

  assert.equal(revised.viewId, earlier.viewId, 'a same-revision rebuild keeps the view id');
  assert.notEqual(revised.viewDigest, earlier.viewDigest);
  assert.throws(() => admissionCommandView(revised, earlier), /ISOLATION_RECORD_DIGEST_MISMATCH/u);

  // Same fixture, but no longer hashing to its own declared digest either: this orders the record
  // comparison ahead of the self-digest check, which a swapped implementation would invert.
  const unhashed = { ...revised, scratchIdentity: 'scratch-someone-else' } as CommandView;
  assert.notEqual(computeCommandViewDigest(unhashed), unhashed.viewDigest);
  assert.throws(() => admissionCommandView(unhashed, earlier), /ISOLATION_RECORD_DIGEST_MISMATCH/u);
});

test('a genuine record paired with a view edited after measurement refuses as unhashed', async () => {
  const { view, measured } = await measuredBuild();
  const mutated = { ...view, admittedFiles: [{ path: 'src/calculator.py', digest: `sha256:${'e'.repeat(64)}` }] } as CommandView;
  assert.equal(mutated.viewId, measured.viewId);
  assert.equal(mutated.viewDigest, measured.viewDigest);
  assert.throws(() => admissionCommandView(mutated, measured), /ISOLATION_RECORD_VIEW_UNHASHED/u);
});

test('a fixture violating every rule refuses as unmeasured, proving the order', async () => {
  const { view } = await measuredBuild();
  const foreign = { viewId: 'view-workspace-999-ffffffffffff', viewDigest: view.viewDigest, isolationProfileRef: PROFILE_REF };
  const mutated = { ...view, scratchIdentity: 'scratch-someone-else' } as CommandView;
  assert.throws(() => admissionCommandView(mutated, foreign), /ISOLATION_RECORD_UNMEASURED/u);
});

const PROFILE: DockerProfile = {
  profileId: 'profile-bridge',
  image: 'python:3.12-slim',
  imageDigest: `sha256:${'f'.repeat(64)}`,
  user: '1000:1000',
  readOnlyRootFilesystem: true,
  network: 'none',
  limits: { timeoutMs: 30_000, maxMemoryBytes: 536_870_912, maxCpuCores: 2, maxPids: 64 },
  mounts: [
    { source: 'vol-repo', target: '/workspace/repo', readOnly: true },
    { source: 'vol-scratch', target: '/workspace/scratch', readOnly: false },
  ],
};

test('the manager hands back both the view and the record it issued', async () => {
  const controller = new BridgeController();
  const manager = new DockerWorkspaceManager({ controller });
  const registered = await manager.createWorkspace({ taskId: TASK_ID, workspaceId: WORKSPACE_ID, initialRevisionDigest: REVISION, profile: PROFILE });
  assert.equal(controller.volumes.length, 2, 'a workspace allocates its repo and scratch volumes');

  const measuredView = await manager.admitCommandView({ workspaceId: WORKSPACE_ID });
  const ownerView: OwnerCommandViewMeasurementV02 = {
    canonicalRevision: measuredView.canonicalRevisionDigest,
    exclusionsPolicyVersion: measuredView.exclusionsPolicyVersion,
    scratchIdentity: measuredView.scratchIdentity,
    admittedFiles: measuredView.admittedFiles,
    mountedReadOnly: true,
    isolationProfileRef: PROFILE_REF,
  };

  const { view, measured } = await manager.admitMeasuredCommandView({ workspaceId: WORKSPACE_ID, ownerView });
  assert.ok(isMeasuredCommandViewIsolation(measured), 'the manager must return the issued record, not drop it');
  assert.equal(measured.isolationProfileRef, ownerView.isolationProfileRef);
  assert.equal(measured.viewId, view.viewId);
  assert.equal(view.scratchIdentity, registered.scratchVolumeId);
  assert.equal(manager.getActiveCommandView(WORKSPACE_ID)?.viewDigest, view.viewDigest);
});
