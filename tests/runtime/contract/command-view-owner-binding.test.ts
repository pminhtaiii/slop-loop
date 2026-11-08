/**
 * T025 — command views bound to accepted owner measurements.
 *
 * Host-composition §5: the owner admission measurement and the Docker view must describe the same
 * measured snapshot. These are controlled-tier contract tests: they prove the *binding* refuses a
 * disagreeing owner measurement before any materialization or publish, and that §9's isolation
 * record is issued only by an accepted measurement and refuses when replayed onto another view.
 * They are not G-ISOLATION evidence and involve no container.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDockerCommandView, isMeasuredCommandViewIsolation } from '../../../src/foundation/docker-view-builder.ts';
import type { IssuedCommandView, MeasuredCommandViewIsolation, OwnerCommandViewMeasurementV02 } from '../../../src/foundation/docker-view-builder.ts';
import { admissionCommandView, commandExecutionLimits } from '../../../src/foundation/repository-admission.ts';
import type { RepositoryCommandResourcePolicy } from '../../../src/foundation/repository-admission.ts';
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
import type { CommandViewV02, RepositoryAdmissionContextV02 } from '../../../src/contracts/foundation/uc03/v02/ports.ts';

const REVISION = `sha256:${'a'.repeat(64)}`;
const WORKSPACE_ID = 'ws-t025';
const PROFILE_REF = 'profile-t025';
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

const POLICY: RepositoryCommandResourcePolicy = {
  isolationProfileRef: PROFILE_REF,
  limits: { timeoutMs: 60_000, maxOutputBytes: 1_048_576, maxCpuCores: 4, maxMemoryBytes: 1_073_741_824, maxPids: 64 },
};

function limitsContext(view: CommandViewV02): RepositoryAdmissionContextV02 {
  return {
    finiteBounds: { timeoutMs: 30_000, maxOutputBytes: 65_536, maxCpuSeconds: 120, maxMemoryBytes: 536_870_912, maxProcessCount: 5, isolationProfileRef: view.isolationProfileRef },
    commandView: view,
  } as unknown as RepositoryAdmissionContextV02;
}

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

interface Harness {
  readonly workspaceId: string;
  readonly operations: Parameters<typeof buildDockerCommandView>[2];
  readonly published: () => CommandView | null;
  readonly counts: { invalidated: number; published: number };
}

function harness(workspaceId = WORKSPACE_ID, workspace: TaskWorkspace = WORKSPACE): Harness {
  let published: CommandView | null = null;
  const counts = { invalidated: 0, published: 0 };
  return {
    workspaceId,
    operations: {
      getWorkspace: () => workspace,
      getCanonicalRevision: () => workspace.expectedRepoState,
      acquireReadLease: async () => ({ release: () => undefined }) as never,
      invalidateViews: () => {
        counts.invalidated += 1;
        published = null;
      },
      publishView: (_id, view) => {
        counts.published += 1;
        published = view;
      },
    },
    published: () => published,
    counts,
  };
}

/** Build effects so far, so a refusal can be shown to leave them untouched. */
async function build(controller: RecordingController, ownerView?: OwnerCommandViewMeasurementV02, ops: Harness = harness()): Promise<IssuedCommandView> {
  return buildDockerCommandView({ workspaceId: ops.workspaceId, ...(ownerView !== undefined ? { ownerView } : {}) }, controller, ops.operations);
}

/** Read the measured facts from a legitimate admission, then perturb one per test. */
async function honest(controller: RecordingController, ops: Harness = harness()): Promise<OwnerCommandViewMeasurementV02> {
  const { view } = await build(controller, undefined, ops);
  return {
    canonicalRevision: view.canonicalRevisionDigest,
    exclusionsPolicyVersion: view.exclusionsPolicyVersion,
    scratchIdentity: view.scratchIdentity,
    admittedFiles: view.admittedFiles,
    mountedReadOnly: true,
    isolationProfileRef: PROFILE_REF,
  };
}

test('a matching owner measurement is accepted and round-trips every field', async () => {
  const controller = new RecordingController();
  const ownerView = await honest(controller);
  const { view } = await build(controller, ownerView);
  assert.equal(view.canonicalRevisionDigest, ownerView.canonicalRevision);
  assert.equal(view.exclusionsPolicyVersion, ownerView.exclusionsPolicyVersion);
  assert.equal(view.scratchIdentity, ownerView.scratchIdentity);
  assert.deepEqual(view.admittedFiles, ownerView.admittedFiles);
  assert.equal(view.mountedReadOnly, true);
});

test('omitting the owner measurement keeps legacy callers working', async () => {
  const controller = new RecordingController();
  const { view } = await build(controller);
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
  const { view } = await buildDockerCommandView({ workspaceId: WORKSPACE_ID, ownerView, trustedIsolationProfileRef }, controller, operations);
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
  const { view: withoutTrusted } = await build(controller, ownerView);
  assert.equal(withoutTrusted.mountedReadOnly, true);

  const { operations } = harness();
  const { view: withoutOwner } = await buildDockerCommandView({ workspaceId: WORKSPACE_ID }, controller, operations);
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
  const { view } = await build(controller);
  assert.equal(view.exclusionsPolicyVersion, '2026.11-candidate');

  const { view: roundTripped } = await build(controller, {
    canonicalRevision: view.canonicalRevisionDigest,
    exclusionsPolicyVersion: '2026.11-candidate',
    scratchIdentity: view.scratchIdentity,
    admittedFiles: view.admittedFiles,
    mountedReadOnly: true,
    isolationProfileRef: PROFILE_REF,
  });
  assert.equal(roundTripped.exclusionsPolicyVersion, '2026.11-candidate');
  assert.equal(roundTripped.scratchIdentity, WORKSPACE.scratchVolumeId);
});

// §9 hand-off: the record is a build output bound to the published view, so it lifts only onto that view.
test('an accepted owner measurement yields a record that lifts its isolation reference into v0.2', async () => {
  const controller = new RecordingController();
  const ownerView = await honest(controller);
  const { view, measured } = await build(controller, ownerView);
  assert.ok(isMeasuredCommandViewIsolation(measured), 'an accepted measurement must issue a record');
  assert.equal(measured.viewId, view.viewId);
  assert.equal(measured.viewDigest, view.viewDigest, 'the record carries the published v0.1 digest verbatim');

  const v02 = admissionCommandView(view, measured);
  assert.equal(v02.isolationProfileRef, ownerView.isolationProfileRef);
  assert.equal(v02.viewId, view.viewId);
  const limits = commandExecutionLimits(limitsContext(v02), POLICY);
  assert.deepEqual(limits, { timeoutMs: 30_000, maxOutputBytes: 65_536, maxCpuCores: 4, maxMemoryBytes: 536_870_912, maxPids: 5 });
});

test('a policy isolation reference that differs from the measured one refuses the command limits', async () => {
  const controller = new RecordingController();
  const { view, measured } = await build(controller, await honest(controller));
  assert.ok(isMeasuredCommandViewIsolation(measured));
  const context = limitsContext(admissionCommandView(view, measured));
  // Only the policy moves; bounds and view stay equal, so the policy term is the one that fires.
  assert.throws(() => commandExecutionLimits(context, { ...POLICY, isolationProfileRef: 'profile-u025' }), /COMMAND_RESOURCE_POLICY_MISMATCH/u);
});

test('a build with no owner measurement issues no record, so lifting refuses instead of defaulting', async () => {
  const controller = new RecordingController();
  const ops = harness();
  const { view, measured } = await build(controller, undefined, ops);
  assert.equal(measured, undefined);
  assert.equal(isMeasuredCommandViewIsolation(measured), false);
  assert.throws(() => admissionCommandView(view, PROFILE_REF as unknown as MeasuredCommandViewIsolation), /ISOLATION_RECORD_UNMEASURED/u);
});

test('a fabricated isolation record refuses', async () => {
  const controller = new RecordingController();
  const ops = harness();
  const { view } = await build(controller, await honest(controller, ops), ops);
  const fabricated = { viewId: view.viewId, viewDigest: view.viewDigest, isolationProfileRef: PROFILE_REF };
  assert.equal(isMeasuredCommandViewIsolation(fabricated), false);
  assert.throws(() => admissionCommandView(view, fabricated), /ISOLATION_RECORD_UNMEASURED/u);
});

test('a record borrowed from another view refuses', async () => {
  const controller = new RecordingController();
  const otherId = 'ws-t025-b';
  const other = harness(otherId, { ...WORKSPACE, workspaceId: otherId } as unknown as TaskWorkspace);
  const { measured: otherRecord } = await build(controller, await honest(controller, other), other);
  assert.ok(isMeasuredCommandViewIsolation(otherRecord));

  const ops = harness();
  const { view } = await build(controller, await honest(controller, ops), ops);
  assert.notEqual(otherRecord.viewId, view.viewId);
  assert.throws(() => admissionCommandView(view, otherRecord), /ISOLATION_RECORD_VIEW_MISMATCH/u);
});

test('a genuine record paired with a mutated view refuses', async () => {
  const controller = new RecordingController();
  const ops = harness();
  const { view, measured } = await build(controller, await honest(controller, ops), ops);
  assert.ok(isMeasuredCommandViewIsolation(measured));
  // Same viewId, same declared digest string — only the hashed content moved.
  const mutated = { ...view, scratchIdentity: 'scratch-someone-else' } as CommandView;
  assert.equal(mutated.viewId, view.viewId);
  assert.equal(mutated.viewDigest, view.viewDigest);
  assert.throws(() => admissionCommandView(mutated, measured), /ISOLATION_RECORD_VIEW_UNHASHED/u);
});
