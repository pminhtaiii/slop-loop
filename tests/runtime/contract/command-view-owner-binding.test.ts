/**
 * T025 — command views bound to accepted owner measurements.
 *
 * Host-composition §5: the owner admission measurement and the Docker view must describe the same
 * measured snapshot. These are controlled-tier contract tests: they prove the *binding* refuses a
 * disagreeing owner measurement before any materialization or publish. They are not G-ISOLATION
 * evidence and involve no container.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDockerCommandView } from '../../../src/foundation/docker-view-builder.ts';
import type { OwnerCommandViewMeasurementV02 } from '../../../src/foundation/docker-view-builder.ts';
import { computeFileDigest } from '../../../src/foundation/docker-workspace.ts';
import type {
  CanonicalRepositorySnapshot,
  CanonicalSnapshotEntry,
  ContainerExecutionOutput,
  DockerContainerPlan,
  DockerLifecycleController,
  MaterializeViewParams,
} from '../../../src/foundation/docker-workspace-types.ts';
import type { CommandView, AdmittedFile, TaskWorkspace } from '../../../src/contracts/foundation/uc03.ts';

const REVISION = `sha256:${'a'.repeat(64)}`;
const WORKSPACE_ID = 'ws-t025';
const FILES: Record<string, string> = {
  'src/calculator.py': 'class Calculator:\n    def divide(self, a, b):\n        return a / b\n',
  'tests/test_calculator.py': 'def test_divide():\n    assert True\n',
  'README.md': '# Calculator Service\n',
};

const WORKSPACE = {
  taskId: 'task-t025',
  workspaceId: WORKSPACE_ID,
  runId: 'run-t025',
  repositoryId: 'repo-t025',
  expectedRepoState: REVISION,
  repoVolumeId: 'vol-repo',
  scratchVolumeId: 'vol-scratch-owner-measured',
  state: 'ready',
  createdAt: '2026-11-04T00:00:00.000Z',
} as unknown as TaskWorkspace;

function entry(path: string, content: string): CanonicalSnapshotEntry {
  return { path, kind: 'regular', content, digest: computeFileDigest(content) };
}

function snapshot(exclusionsPolicyVersion = '1.0.0'): CanonicalRepositorySnapshot {
  return {
    canonicalRevisionDigest: REVISION,
    entries: Object.entries(FILES).map(([path, content]) => entry(path, content)),
    requiredFiles: [],
    exclusionsPolicyVersion,
  };
}

/** Records what reached the controller, so "no effect" is asserted rather than assumed. */
class RecordingController implements DockerLifecycleController {
  readonly provenance = 'mock' as const;
  snapshotToReturn: CanonicalRepositorySnapshot = snapshot();
  private readonly volumes = new Set<string>();
  readonly materialized: CommandView[] = [];
  readonly executedPlans: DockerContainerPlan[] = [];
  cleanupCalls = 0;

  async createVolume(): Promise<void> {
    this.volumes.add('unused');
  }
  async hasVolume(): Promise<boolean> {
    return true;
  }
  async removeVolume(id: string): Promise<void> {
    this.volumes.delete(id);
  }
  async getCanonicalSnapshot(): Promise<CanonicalRepositorySnapshot> {
    return this.snapshotToReturn;
  }
  async materializeView(params: MaterializeViewParams): Promise<void> {
    this.materialized.push(params.view);
  }
  async executeContainer(plan: DockerContainerPlan): Promise<ContainerExecutionOutput> {
    this.executedPlans.push(plan);
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
  }
  async cleanup(): Promise<void> {
    this.cleanupCalls += 1;
  }
}

function harness(): { operations: Parameters<typeof buildDockerCommandView>[2]; published: () => CommandView | null } {
  let published: CommandView | null = null;
  let releaseCount = 0;
  void releaseCount;
  return {
    operations: {
      getWorkspace: () => WORKSPACE,
      getCanonicalRevision: () => REVISION,
      acquireReadLease: async () =>
        ({
          release: () => {
            releaseCount += 1;
          },
        }) as never,
      invalidateViews: () => {
        published = null;
      },
      publishView: (_id, view) => {
        published = view;
      },
    },
    published: () => published,
  };
}

async function build(controller: RecordingController, ownerView?: OwnerCommandViewMeasurementV02): Promise<CommandView> {
  const { operations } = harness();
  return buildDockerCommandView({ workspaceId: WORKSPACE_ID, ...(ownerView !== undefined ? { ownerView } : {}) }, controller, operations);
}

/** Read the measured facts from a legitimate admission, then perturb one per test. */
async function honest(controller: RecordingController): Promise<OwnerCommandViewMeasurementV02> {
  const view = await build(controller);
  return {
    canonicalRevision: view.canonicalRevisionDigest,
    exclusionsPolicyVersion: view.exclusionsPolicyVersion,
    scratchIdentity: view.scratchIdentity,
    admittedFiles: view.admittedFiles,
    mountedReadOnly: true,
    isolationProfileRef: 'profile-t025',
  };
}

test('a matching owner measurement is accepted and round-trips every field', async () => {
  const controller = new RecordingController();
  const ownerView = await honest(controller);
  const view = await build(controller, ownerView);
  assert.equal(view.canonicalRevisionDigest, ownerView.canonicalRevision);
  assert.equal(view.exclusionsPolicyVersion, ownerView.exclusionsPolicyVersion);
  assert.equal(view.scratchIdentity, ownerView.scratchIdentity);
  assert.deepEqual(view.admittedFiles, ownerView.admittedFiles);
  assert.equal(view.mountedReadOnly, true);
});

test('omitting the owner measurement keeps legacy callers working', async () => {
  const controller = new RecordingController();
  const view = await build(controller);
  assert.equal(view.mountedReadOnly, true);
});

test('each mismatching field refuses before materialization and publishes nothing', async () => {
  const cases: readonly ((owner: OwnerCommandViewMeasurementV02) => OwnerCommandViewMeasurementV02)[] = [
    owner => ({ ...owner, canonicalRevision: `sha256:${'b'.repeat(64)}` }),
    owner => ({ ...owner, exclusionsPolicyVersion: '9.9.9' }),
    owner => ({ ...owner, scratchIdentity: 'scratch-someone-else' }),
    owner => ({ ...owner, admittedFiles: owner.admittedFiles.slice(1) }),
    owner => ({ ...owner, admittedFiles: owner.admittedFiles.map((file, index) => (index === 0 ? { ...file, digest: 'b'.repeat(64) } : file)) }),
    // Same measured inventory, but the owner side repeats an entry: the Map would silently collapse it.
    owner => ({ ...owner, admittedFiles: [...owner.admittedFiles, ...owner.admittedFiles.slice(0, 1)] }),
    owner => ({ ...owner, admittedFiles: 'nope' as unknown as OwnerCommandViewMeasurementV02['admittedFiles'] }),
    owner => ({ ...owner, admittedFiles: [null as unknown as AdmittedFile] }),
  ];

  for (const perturb of cases) {
    const controller = new RecordingController();
    const ownerView = perturb(await honest(controller));
    const before = controller.materialized.length;
    const { operations, published } = harness();
    await assert.rejects(() => buildDockerCommandView({ workspaceId: WORKSPACE_ID, ownerView }, controller, operations), /OWNER_VIEW_MISMATCH/u);
    assert.equal(controller.materialized.length, before, 'a refused binding must not materialize a view');
    assert.equal(published(), null, 'a refused binding must not publish a view');
    assert.equal(controller.executedPlans.length, 0, 'a refused binding must not reach the executor');
  }
});

test('a measurement that does not declare read-only mounting is refused', async () => {
  const controller = new RecordingController();
  const ownerView = await honest(controller);
  const bad = { ...ownerView, mountedReadOnly: false } as unknown as OwnerCommandViewMeasurementV02;
  await assert.rejects(() => build(controller, bad), /OWNER_VIEW_MISMATCH: owner view must declare mountedReadOnly/u);
});

test('a legitimate non-literal isolation reference binds the owner measurement to the trusted profile', async () => {
  const controller = new RecordingController();
  const ownerView = { ...(await honest(controller)), isolationProfileRef: 'profile/t025 measured-2026.11' };
  const trustedIsolationProfileRef = 'profile/t025 measured-2026.11';
  const before = controller.materialized.length;
  const { operations, published } = harness();
  const view = await buildDockerCommandView({ workspaceId: WORKSPACE_ID, ownerView, trustedIsolationProfileRef }, controller, operations);
  assert.equal(controller.materialized.length, before + 1, 'an agreeing isolation reference must materialize the view');
  assert.equal(published(), view);
  assert.equal(view.mountedReadOnly, true);
});

test('a differing trusted isolation reference refuses before materialization and publishes nothing', async () => {
  const controller = new RecordingController();
  const ownerView = await honest(controller);
  const before = controller.materialized.length;
  const { operations, published } = harness();
  // Same length as the owner's reference: the refusal must compare by value, not by shape.
  await assert.rejects(
    () => buildDockerCommandView({ workspaceId: WORKSPACE_ID, ownerView, trustedIsolationProfileRef: 'profile-u025' }, controller, operations),
    /OWNER_VIEW_MISMATCH: owner isolationProfileRef/u,
  );
  assert.equal(controller.materialized.length, before, 'a refused isolation binding must not materialize a view');
  assert.equal(published(), null, 'a refused isolation binding must not publish a view');
  assert.equal(controller.executedPlans.length, 0, 'a refused isolation binding must not reach the executor');
});

test('an absent trusted reference or absent owner measurement keeps the previous behaviour', async () => {
  const controller = new RecordingController();
  const ownerView = await honest(controller);
  const withoutTrusted = await build(controller, ownerView);
  assert.equal(withoutTrusted.mountedReadOnly, true);

  const { operations } = harness();
  const withoutOwner = await buildDockerCommandView({ workspaceId: WORKSPACE_ID }, controller, operations);
  assert.equal(withoutOwner.viewId, withoutTrusted.viewId);
  assert.equal(withoutOwner.viewDigest, withoutTrusted.viewDigest);
});

// A trusted profile is only meaningful against a measurement; silently skipping the check would
// report success for a comparison that never happened.
test('a trusted reference with no owner measurement is refused, not silently skipped', async () => {
  const controller = new RecordingController();
  const { operations, published } = harness();
  await assert.rejects(
    buildDockerCommandView({ workspaceId: WORKSPACE_ID, trustedIsolationProfileRef: 'profile-u025' }, controller, operations),
    /OWNER_VIEW_MISMATCH: trustedIsolationProfileRef requires an owner view measurement/,
  );
  assert.equal(controller.materialized.length, 0, 'a refused binding must not materialize a view');
  assert.equal(published(), null, 'a refused binding must not publish a view');
  assert.equal(controller.executedPlans.length, 0, 'a refused binding must not reach the executor');
});

test('an absent or unbounded isolation reference is refused', async () => {
  const controller = new RecordingController();
  const ownerView = await honest(controller);
  for (const isolationProfileRef of ['', 'x'.repeat(257)]) {
    await assert.rejects(() => build(controller, { ...ownerView, isolationProfileRef }), /OWNER_VIEW_MISMATCH: owner isolationProfileRef/u);
  }
});

test('a legitimate nonliteral exclusions policy round-trips instead of being rewritten to the default', async () => {
  const controller = new RecordingController();
  controller.snapshotToReturn = snapshot('2026.11-candidate');
  const view = await build(controller);
  assert.equal(view.exclusionsPolicyVersion, '2026.11-candidate');

  const roundTripped = await build(controller, {
    canonicalRevision: view.canonicalRevisionDigest,
    exclusionsPolicyVersion: '2026.11-candidate',
    scratchIdentity: view.scratchIdentity,
    admittedFiles: view.admittedFiles,
    mountedReadOnly: true,
    isolationProfileRef: 'profile-t025',
  });
  assert.equal(roundTripped.exclusionsPolicyVersion, '2026.11-candidate');
  assert.equal(roundTripped.scratchIdentity, WORKSPACE.scratchVolumeId);
});
