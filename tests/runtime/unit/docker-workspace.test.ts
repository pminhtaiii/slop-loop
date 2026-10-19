import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type DockerProfile,
  type DockerMountConfig,
  type DockerResourceLimits,
  type DockerLifecycleController,
  type CanonicalRepositorySnapshot,
  type CanonicalSnapshotEntry,
  type MaterializeViewParams,
  type AdmitCommandViewParams,
  validateDockerProfile,
  computeWorkspaceVolumeIds,
  DockerWorkspaceManager,
  computeFileDigest,
  containsProtectedContent,
  type DockerContainerPlan,
  type ContainerExecutionOutput,
  StructuredCommandExecutor,
  DockerCommandExecutor,
  ALLOWED_EXECUTABLES,
  DEFAULT_CONTAINER_ENV,
  IMMUTABLE_CONTAINER_ENV_KEYS,
  truncateUtf8,
} from '../../../src/foundation/docker-workspace.ts';
import {
  type CommandView,
  type TaskWorkspace,
  type ExecutionLimits,
  validateCommandView,
  validateTaskWorkspace,
} from '../../../src/contracts/uc03.ts';

export const TEST_PROFILE_IMAGE_DIGEST = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' as const;

export const TEST_DOCKER_PROFILE: DockerProfile = Object.freeze({
  profileId: 'profile-uc03-test',
  image: 'ghcr.io/pminhtaiii/slop-loop-runtime:0.1.0-test',
  imageDigest: TEST_PROFILE_IMAGE_DIGEST,
  user: '1000:1000',
  readOnlyRootFilesystem: true,
  network: 'none',
  limits: {
    timeoutMs: 60000,
    maxMemoryBytes: 2147483648,
    maxCpuCores: 2,
    maxPids: 256,
  },
  mounts: [
    {
      source: 'vol-repo',
      target: '/workspace/repo',
      readOnly: true,
    },
    {
      source: 'vol-scratch',
      target: '/workspace/scratch',
      readOnly: false,
    },
  ],
});

export class FakeDockerLifecycleController implements DockerLifecycleController {
  readonly provenance = 'mock' as const;
  private readonly volumes = new Set<string>();
  readonly createdVolumes: string[] = [];
  readonly removedVolumes: string[] = [];

  snapshotToReturn?: CanonicalRepositorySnapshot;
  readonly materializedViews: {
    readonly view: CommandView;
    readonly files: Record<string, string | Uint8Array>;
  }[] = [];
  onMaterialize?: () => Promise<void> | void;

  async createVolume(id: string): Promise<void> {
    this.volumes.add(id);
    this.createdVolumes.push(id);
  }

  async hasVolume(id: string): Promise<boolean> {
    return this.volumes.has(id);
  }

  async removeVolume(id: string): Promise<void> {
    this.volumes.delete(id);
    this.removedVolumes.push(id);
  }

  async getCanonicalSnapshot(workspaceId: string): Promise<CanonicalRepositorySnapshot> {
    if (!this.snapshotToReturn) {
      throw new Error(`NO_SNAPSHOT_CONFIGURED: No snapshot configured for workspace ${workspaceId}`);
    }
    return this.snapshotToReturn;
  }

  async materializeView(params: MaterializeViewParams): Promise<void> {
    if (this.onMaterialize) {
      await this.onMaterialize();
    }
    this.materializedViews.push({
      view: params.view,
      files: { ...params.files },
    });
  }

  readonly executedPlans: DockerContainerPlan[] = [];
  outputToReturn?: Partial<ContainerExecutionOutput>;
  rawOutputToReturn?: unknown;
  hasRawOutputToReturn = false;
  cleanedUp = false;
  cleanupCalls = 0;
  async cleanup(): Promise<void> {
    this.cleanupCalls++;
    this.cleanedUp = true;
  }
  onExecute?: (plan: DockerContainerPlan) => Promise<void> | void;

  async executeContainer(plan: DockerContainerPlan): Promise<ContainerExecutionOutput> {
    this.executedPlans.push(plan);
    if (this.onExecute) {
      await this.onExecute(plan);
    }
    if (this.hasRawOutputToReturn) {
      return this.rawOutputToReturn as ContainerExecutionOutput;
    }
    return {
      exitCode: this.outputToReturn?.exitCode ?? 0,
      stdout: this.outputToReturn?.stdout ?? '',
      stderr: this.outputToReturn?.stderr ?? '',
      durationMs: this.outputToReturn?.durationMs ?? 50,
      timedOut: this.outputToReturn?.timedOut ?? false,
    };
  }
}

function createValidProfile(overrides?: Partial<DockerProfile>): DockerProfile {
  return {
    profileId: 'profile-uc03-standard',
    image: 'ghcr.io/pminhtaiii/slop-loop-runtime:0.1.0',
    imageDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    user: '1000:1000',
    readOnlyRootFilesystem: true,
    network: 'none',
    limits: {
      timeoutMs: 60000,
      maxMemoryBytes: 2147483648,
      maxCpuCores: 2,
      maxPids: 256,
    },
    mounts: [
      {
        source: 'vol-repo',
        target: '/workspace/repo',
        readOnly: true,
      },
      {
        source: 'vol-scratch',
        target: '/workspace/scratch',
        readOnly: false,
      },
    ],
    ...overrides,
  };
}

function createSnapshotEntry(
  path: string,
  content: string,
  options?: {
    readonly kind?: string;
    readonly digest?: string;
    readonly linkTarget?: string;
  }
): CanonicalSnapshotEntry {
  return {
    path,
    kind: options?.kind ?? 'regular',
    content,
    digest: options?.digest ?? computeFileDigest(content),
    ...(options?.linkTarget !== undefined ? { linkTarget: options.linkTarget } : {}),
  };
}

test('DockerProfile validation: accepts valid finite profile with read-only root and none network', () => {
  const profile = createValidProfile();
  const res = validateDockerProfile(profile);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.profileId, 'profile-uc03-standard');
    assert.equal(res.value.readOnlyRootFilesystem, true);
    assert.equal(res.value.network, 'none');
    assert.equal(res.value.user, '1000:1000');
  }
});

test('DockerProfile validation: rejects root user (root, 0, 0:0, empty)', () => {
  for (const forbiddenUser of ['root', '0', '0:0', '']) {
    const res = validateDockerProfile(createValidProfile({ user: forbiddenUser }));
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.ok(res.errors.some((e) => e.code === 'NON_ROOT_USER_REQUIRED'));
    }
  }
});

test('DockerProfile validation: rejects root UID variants (0:1000, 00:1000, root:1000, 1000:0, 1000:root)', () => {
  for (const rootVariant of ['0:1000', '00:1000', 'root:1000', '1000:0', '1000:root']) {
    const res = validateDockerProfile(createValidProfile({ user: rootVariant }));
    assert.equal(res.ok, false, `Expected ${rootVariant} to be rejected as root variant`);
    if (!res.ok) {
      assert.ok(res.errors.some((e) => e.code === 'NON_ROOT_USER_REQUIRED'), `Expected NON_ROOT_USER_REQUIRED for ${rootVariant}`);
    }
  }
});

test('DockerProfile validation: rejects malformed users (:1000, 1000:, 1000:1000:1000, -1:1000, 1000:-1, invalid chars, out of range)', () => {
  const malformed = [
    ':1000',
    '1000:',
    '1000:1000:1000',
    '-1:1000',
    '1000:-1',
    '1000:invalid@group',
    'invalid@user:1000',
    '99999999999999999999:1000',
  ];
  for (const badUser of malformed) {
    const res = validateDockerProfile(createValidProfile({ user: badUser }));
    assert.equal(res.ok, false, `Expected malformed user ${badUser} to be rejected`);
    if (!res.ok) {
      assert.ok(res.errors.some((e) => e.code === 'INVALID_USER'), `Expected INVALID_USER for ${badUser}`);
    }
  }
});

test('DockerProfile validation: accepts valid non-root user specifications', () => {
  for (const validUser of ['1000:1000', '1000', 'appuser:appgroup', 'appuser', 'user_01:group_01']) {
    const res = validateDockerProfile(createValidProfile({ user: validUser }));
    assert.equal(res.ok, true, `Expected user ${validUser} to be valid`);
  }
});

test('DockerProfile validation: rejects writable root filesystem', () => {
  const res = validateDockerProfile(createValidProfile({ readOnlyRootFilesystem: false }));
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'READONLY_ROOT_REQUIRED'));
  }
});

test('DockerProfile validation: rejects network modes other than none', () => {
  const res = validateDockerProfile(
    createValidProfile({ network: 'bridge' as unknown as 'none' })
  );
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'NETWORK_NONE_REQUIRED'));
  }
});

test('DockerProfile validation: rejects non-sha256 or mutable image digests', () => {
  for (const badDigest of ['latest', 'sha256:short', 'sha256:not-hex-characters-here', '']) {
    const res = validateDockerProfile(createValidProfile({ imageDigest: badDigest }));
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.ok(res.errors.some((e) => e.code === 'IMMUTABLE_IMAGE_DIGEST_REQUIRED'));
    }
  }
});

test('DockerProfile validation: rejects invalid or missing resource limits', () => {
  const badLimits: Partial<DockerResourceLimits>[] = [
    { timeoutMs: 0 },
    { timeoutMs: -100 },
    { maxMemoryBytes: -1 },
    { maxCpuCores: 0 },
    { maxPids: 0 },
    { timeoutMs: 1.5 },
    { maxMemoryBytes: Number.MAX_SAFE_INTEGER + 1000 },
    { timeoutMs: NaN },
    { timeoutMs: Infinity },
  ];
  for (const limitOverride of badLimits) {
    const res = validateDockerProfile(
      createValidProfile({
        limits: {
          ...createValidProfile().limits,
          ...limitOverride,
        },
      })
    );
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.ok(res.errors.some((e) => e.code === 'INVALID_LIMIT'));
    }
  }
});

test('DockerProfile validation: rejects dangerous mounts (docker socket, root, credentials, grader)', () => {
  const dangerousTargets = [
    '/var/run/docker.sock',
    '/run/docker.sock',
    '/',
    '/root/.ssh',
    '/home/user/.aws',
    'eval/uc03/private',
    'private/grading',
  ];
  for (const target of dangerousTargets) {
    const mounts: DockerMountConfig[] = [
      { source: 'host', target, readOnly: true },
    ];
    const res = validateDockerProfile(createValidProfile({ mounts }));
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.ok(res.errors.some((e) => e.code === 'DANGEROUS_MOUNT_FORBIDDEN'));
    }
  }
});

test('DockerProfile validation: rejects dangerous mount sources and writable canonical repository volumes', () => {
  // Dangerous sources
  for (const source of ['/var/run/docker.sock', '/run/docker.sock', '/etc/shadow', '.ssh', '.aws', '.env']) {
    const mounts: DockerMountConfig[] = [
      { source, target: '/safe', readOnly: true },
    ];
    const res = validateDockerProfile(createValidProfile({ mounts }));
    assert.equal(res.ok, false, `Expected dangerous source ${source} to be rejected`);
    if (!res.ok) {
      assert.ok(res.errors.some((e) => e.code === 'DANGEROUS_MOUNT_FORBIDDEN'));
    }
  }

  // Canonical repository volume mounted writable at alias
  const aliasMounts: DockerMountConfig[] = [
    { source: 'canonical-repo-volume', target: '/workspace/alias', readOnly: false },
  ];
  const resAlias = validateDockerProfile(createValidProfile({ mounts: aliasMounts }));
  assert.equal(resAlias.ok, false);
  if (!resAlias.ok) {
    assert.ok(resAlias.errors.some((e) => e.code === 'READONLY_REPO_MOUNT_REQUIRED'));
  }
});

test('DockerProfile validation: validates malformed mounts without throwing incidental TypeError', () => {
  const malformedMounts = [null as unknown as DockerMountConfig, 'string-mount' as unknown as DockerMountConfig, 123 as unknown as DockerMountConfig];
  const res = validateDockerProfile(createValidProfile({ mounts: malformedMounts }));
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'INVALID_MOUNT'));
  }
});

test('DockerProfile validation: rejects writable /workspace/repo mount', () => {
  const mounts: DockerMountConfig[] = [
    { source: 'vol-repo', target: '/workspace/repo', readOnly: false },
    { source: 'vol-scratch', target: '/workspace/scratch', readOnly: false },
  ];
  const res = validateDockerProfile(createValidProfile({ mounts }));
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'READONLY_REPO_MOUNT_REQUIRED'));
  }
});

test('FakeDockerLifecycleController: tracks volume operations and advertises mock provenance', async () => {
  const controller = new FakeDockerLifecycleController();
  assert.equal(controller.provenance, 'mock');
  assert.equal(await controller.hasVolume('vol-test'), false);

  await controller.createVolume('vol-test');
  assert.equal(await controller.hasVolume('vol-test'), true);
  assert.deepEqual(controller.createdVolumes, ['vol-test']);

  await controller.removeVolume('vol-test');
  assert.equal(await controller.hasVolume('vol-test'), false);
  assert.deepEqual(controller.removedVolumes, ['vol-test']);
});

test('DockerWorkspaceManager: requires injected DockerLifecycleController and fails if missing or invalid', () => {
  assert.throws(
    () => new (DockerWorkspaceManager as unknown as new () => DockerWorkspaceManager)(),
    { message: /CONTROLLER_REQUIRED/ }
  );
  assert.throws(
    () => new DockerWorkspaceManager({} as unknown as { readonly controller: DockerLifecycleController }),
    { message: /CONTROLLER_REQUIRED/ }
  );
  assert.throws(
    () => new DockerWorkspaceManager({ controller: null as unknown as DockerLifecycleController }),
    { message: /CONTROLLER_REQUIRED/ }
  );
});

test('DockerWorkspaceManager: validates task, workspace, and revision BEFORE volume effects (zero controller calls on invalid input)', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const profile = createValidProfile();
  const validRev = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  // Invalid taskId
  await assert.rejects(
    async () => {
      await manager.createWorkspace({
        taskId: '',
        workspaceId: 'ws-test',
        initialRevisionDigest: validRev,
        profile,
      });
    },
    { message: /INVALID_TASK_WORKSPACE/ }
  );
  assert.equal(controller.createdVolumes.length, 0, 'Zero volumes created on invalid taskId');

  // Invalid workspaceId
  await assert.rejects(
    async () => {
      await manager.createWorkspace({
        taskId: 'task-test',
        workspaceId: '',
        initialRevisionDigest: validRev,
        profile,
      });
    },
    { message: /INVALID_TASK_WORKSPACE/ }
  );
  assert.equal(controller.createdVolumes.length, 0, 'Zero volumes created on invalid workspaceId');

  // Invalid initialRevisionDigest
  await assert.rejects(
    async () => {
      await manager.createWorkspace({
        taskId: 'task-test',
        workspaceId: 'ws-test',
        initialRevisionDigest: 'bad',
        profile,
      });
    },
    { message: /INVALID_REVISION_DIGEST/ }
  );
  assert.equal(controller.createdVolumes.length, 0, 'Zero volumes created on invalid revision digest');

  // Invalid profile
  const badProfile = createValidProfile({ user: '0:1000' });
  await assert.rejects(
    async () => {
      await manager.createWorkspace({
        taskId: 'task-test',
        workspaceId: 'ws-test',
        initialRevisionDigest: validRev,
        profile: badProfile,
      });
    },
    { message: /INVALID_DOCKER_PROFILE/ }
  );
  assert.equal(controller.createdVolumes.length, 0, 'Zero volumes created on invalid profile');

  // Successful create
  const ws = await manager.createWorkspace({
    taskId: 'task-test',
    workspaceId: 'ws-test',
    initialRevisionDigest: validRev,
    profile,
  });
  assert.equal(ws.workspaceId, 'ws-test');
  assert.equal(controller.createdVolumes.length, 2);

  // Reject duplicate workspace creation without creating additional volumes
  await assert.rejects(
    async () => {
      await manager.createWorkspace({
        taskId: 'task-test',
        workspaceId: 'ws-test',
        initialRevisionDigest: validRev,
        profile,
      });
    },
    { message: /WORKSPACE_ALREADY_EXISTS/ }
  );
  assert.equal(controller.createdVolumes.length, 2, 'No new volumes created on duplicate create');
});

test('DockerWorkspaceManager: createWorkspace validates profile, allocates volumes, returns TaskWorkspace', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const profile = createValidProfile();

  const workspace = await manager.createWorkspace({
    taskId: 'task-uc03-101',
    workspaceId: 'ws-uc03-101',
    initialRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    profile,
  });

  assert.equal(workspace.taskId, 'task-uc03-101');
  assert.equal(workspace.workspaceId, 'ws-uc03-101');
  assert.equal(workspace.containerImageDigest, profile.imageDigest);
  assert.equal(workspace.expectedRepoState, 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  const expectedVolumeIds = computeWorkspaceVolumeIds('task-uc03-101', 'ws-uc03-101');
  assert.equal(workspace.repoVolumeId, expectedVolumeIds.repoVolumeId);
  assert.equal(workspace.scratchVolumeId, expectedVolumeIds.scratchVolumeId);
  assert.ok(workspace.repoVolumeId.startsWith('vol-repo-'));
  assert.ok(workspace.scratchVolumeId.startsWith('vol-scratch-'));
  assert.match(workspace.repoVolumeId, /^vol-repo-[0-9a-f]{64}$/);
  assert.match(workspace.scratchVolumeId, /^vol-scratch-[0-9a-f]{64}$/);

  // Validated by canonical validateTaskWorkspace
  const valid = validateTaskWorkspace(workspace);
  assert.equal(valid.ok, true);

  // Volumes exist in controller
  assert.equal(await controller.hasVolume(workspace.repoVolumeId), true);
  assert.equal(await controller.hasVolume(workspace.scratchVolumeId), true);
});

test('DockerWorkspaceManager: resumeWorkspace verifies stable volume identities and image match', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const profile = createValidProfile();

  const created = await manager.createWorkspace({
    taskId: 'task-uc03-102',
    workspaceId: 'ws-uc03-102',
    initialRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    profile,
  });

  // Successful resume with identical workspace and profile
  const resumed = await manager.resumeWorkspace({
    workspace: created,
    profile,
  });
  assert.equal(resumed.workspaceId, created.workspaceId);
  assert.equal(resumed.repoVolumeId, created.repoVolumeId);
  assert.equal(resumed.scratchVolumeId, created.scratchVolumeId);

  // Rejects resume if image digest mismatches
  const altProfile = createValidProfile({
    imageDigest: 'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
  });
  await assert.rejects(
    async () => {
      await manager.resumeWorkspace({ workspace: created, profile: altProfile });
    },
    { message: /IMAGE_DIGEST_MISMATCH/ }
  );

  // Rejects resume if volume identity drifted / hijacked
  const tamperedWorkspace = {
    ...created,
    repoVolumeId: 'vol-repo-hijacked',
  };
  await assert.rejects(
    async () => {
      await manager.resumeWorkspace({ workspace: tamperedWorkspace, profile });
    },
    { message: /VOLUME_IDENTITY_MISMATCH/ }
  );
});

test('DockerWorkspaceManager: admitCommandView fails closed when controller is missing getCanonicalSnapshot', async () => {
  const controllerWithoutSnapshot: DockerLifecycleController = {
    provenance: 'mock' as const,
    createVolume: () => Promise.resolve(),
    hasVolume: () => Promise.resolve(true),
    removeVolume: () => Promise.resolve(),
    materializeView: () => Promise.resolve(),
  };
  const manager = new DockerWorkspaceManager({ controller: controllerWithoutSnapshot });
  const ws = await manager.createWorkspace({
    taskId: 'task-snap-01',
    workspaceId: 'ws-snap-01',
    initialRevisionDigest: 'sha256:0111111111111111111111111111111111111111111111111111111111111111',
    profile: createValidProfile(),
  });

  await assert.rejects(
    async () => {
      await manager.admitCommandView({ workspaceId: ws.workspaceId });
    },
    { message: /CONTROLLER_SNAPSHOT_METHOD_REQUIRED/ }
  );
});

test('DockerWorkspaceManager: admitCommandView fails closed when controller is missing materializeView', async () => {
  const controllerWithoutMaterializer: DockerLifecycleController = {
    provenance: 'mock',
    createVolume: () => Promise.resolve(),
    hasVolume: () => Promise.resolve(true),
    removeVolume: () => Promise.resolve(),
    getCanonicalSnapshot: async () => ({
      canonicalRevisionDigest: 'sha256:0111111111111111111111111111111111111111111111111111111111111111',
      entries: [createSnapshotEntry('src/a.py', 'x = 1\n')],
    }),
  };
  const manager = new DockerWorkspaceManager({ controller: controllerWithoutMaterializer });
  const ws = await manager.createWorkspace({
    taskId: 'task-snap-02',
    workspaceId: 'ws-snap-02',
    initialRevisionDigest: 'sha256:0111111111111111111111111111111111111111111111111111111111111111',
    profile: createValidProfile(),
  });

  await assert.rejects(
    async () => {
      await manager.admitCommandView({ workspaceId: ws.workspaceId });
    },
    { message: /CONTROLLER_MATERIALIZE_METHOD_REQUIRED/ }
  );
});

test('DockerWorkspaceManager: admitCommandView rejects when controller returns stale or mismatching canonical revision', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const rev1 = 'sha256:0111111111111111111111111111111111111111111111111111111111111111';
  const staleRev = 'sha256:0999999999999999999999999999999999999999999999999999999999999999';

  const ws = await manager.createWorkspace({
    taskId: 'task-snap-03',
    workspaceId: 'ws-snap-03',
    initialRevisionDigest: rev1,
    profile: createValidProfile(),
  });

  controller.snapshotToReturn = {
    canonicalRevisionDigest: staleRev,
    entries: [createSnapshotEntry('src/calculator.py', 'def add(a, b): return a + b\n')],
  };

  await assert.rejects(
    async () => {
      await manager.admitCommandView({ workspaceId: ws.workspaceId });
    },
    { message: /STALE_COMMAND_VIEW/ }
  );
});

test('DockerWorkspaceManager: admitCommandView rejects caller self-authorized files and uses controller snapshot as sole authority', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const rev = 'sha256:0222222222222222222222222222222222222222222222222222222222222222';

  const ws = await manager.createWorkspace({
    taskId: 'task-snap-04',
    workspaceId: 'ws-snap-04',
    initialRevisionDigest: rev,
    profile: createValidProfile(),
  });

  const trustedFile = 'src/trusted.py';
  const trustedContent = 'def trusted(): return True\n';
  controller.snapshotToReturn = {
    canonicalRevisionDigest: rev,
    entries: [createSnapshotEntry(trustedFile, trustedContent)],
  };

  // Caller attempts to self-authorize an injected file
  const untrustedInput: AdmitCommandViewParams & { readonly canonicalFiles?: Record<string, string> } = {
    workspaceId: ws.workspaceId,
    canonicalFiles: {
      'src/injected_by_caller.py': 'def attack(): pass\n',
    },
  };

  const view = await manager.admitCommandView(untrustedInput);

  assert.equal(view.admittedFiles.length, 1);
  const admitted0 = view.admittedFiles[0];
  assert.ok(admitted0);
  assert.equal(admitted0.path, trustedFile);
  assert.equal(controller.materializedViews.length, 1);
  const mat0 = controller.materializedViews[0];
  assert.ok(mat0);
  assert.deepEqual(Object.keys(mat0.files), [trustedFile]);
  assert.equal(mat0.files[trustedFile], trustedContent);
  assert.equal('src/injected_by_caller.py' in mat0.files, false);
});

test('DockerWorkspaceManager: admitCommandView rejects invalid file digests that do not match entry content', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const rev = 'sha256:0333333333333333333333333333333333333333333333333333333333333333';

  const ws = await manager.createWorkspace({
    taskId: 'task-snap-05',
    workspaceId: 'ws-snap-05',
    initialRevisionDigest: rev,
    profile: createValidProfile(),
  });

  controller.snapshotToReturn = {
    canonicalRevisionDigest: rev,
    entries: [
      createSnapshotEntry('src/corrupt.py', 'def corrupt(): pass\n', {
        digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      }),
    ],
  };

  await assert.rejects(
    async () => {
      await manager.admitCommandView({ workspaceId: ws.workspaceId });
    },
    { message: /FILE_DIGEST_MISMATCH/ }
  );
  assert.equal(controller.materializedViews.length, 0);
});

test('DockerWorkspaceManager: admitCommandView rejects escaping canonical paths in snapshot entries', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const rev = 'sha256:0444444444444444444444444444444444444444444444444444444444444444';

  const ws = await manager.createWorkspace({
    taskId: 'task-snap-06',
    workspaceId: 'ws-snap-06',
    initialRevisionDigest: rev,
    profile: createValidProfile(),
  });

  controller.snapshotToReturn = {
    canonicalRevisionDigest: rev,
    entries: [
      createSnapshotEntry('../escape.py', 'x = 1\n'),
    ],
  };

  await assert.rejects(
    async () => {
      await manager.admitCommandView({ workspaceId: ws.workspaceId });
    },
    { message: /WORKSPACE_ESCAPE/ }
  );
  assert.equal(controller.materializedViews.length, 0);
});

test('DockerWorkspaceManager: admitCommandView rejects unknown file kinds before materialization', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const rev = 'sha256:0555555555555555555555555555555555555555555555555555555555555555';

  const ws = await manager.createWorkspace({
    taskId: 'task-snap-07',
    workspaceId: 'ws-snap-07',
    initialRevisionDigest: rev,
    profile: createValidProfile(),
  });

  controller.snapshotToReturn = {
    canonicalRevisionDigest: rev,
    entries: [
      createSnapshotEntry('src/pipe', '', { kind: 'fifo', digest: computeFileDigest('') }),
    ],
  };

  await assert.rejects(
    async () => {
      await manager.admitCommandView({ workspaceId: ws.workspaceId });
    },
    { message: /UNKNOWN_FILE_KIND/ }
  );
  assert.equal(controller.materializedViews.length, 0);
});

test('DockerWorkspaceManager: admitCommandView rejects symlink link targets (chained symlinks)', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const rev = 'sha256:0666666666666666666666666666666666666666666666666666666666666666';

  const ws = await manager.createWorkspace({
    taskId: 'task-snap-08',
    workspaceId: 'ws-snap-08',
    initialRevisionDigest: rev,
    profile: createValidProfile(),
  });

  controller.snapshotToReturn = {
    canonicalRevisionDigest: rev,
    entries: [
      createSnapshotEntry('src/target.py', 'def real(): pass\n'),
      createSnapshotEntry('src/link_b.py', '', {
        kind: 'symlink',
        linkTarget: 'src/target.py',
        digest: computeFileDigest('def real(): pass\n'),
      }),
      createSnapshotEntry('src/link_a.py', '', {
        kind: 'symlink',
        linkTarget: 'src/link_b.py', // Chained symlink (symlink link target)
        digest: computeFileDigest('def real(): pass\n'),
      }),
    ],
  };

  await assert.rejects(
    async () => {
      await manager.admitCommandView({ workspaceId: ws.workspaceId });
    },
    { message: /UNSAFE_LINK_TARGET/ }
  );
  assert.equal(controller.materializedViews.length, 0);
});

test('DockerWorkspaceManager: admitCommandView rejects outside link targets (/etc/shadow, ../outside)', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const rev = 'sha256:0777777777777777777777777777777777777777777777777777777777777777';

  const ws = await manager.createWorkspace({
    taskId: 'task-snap-09',
    workspaceId: 'ws-snap-09',
    initialRevisionDigest: rev,
    profile: createValidProfile(),
  });

  for (const outsideTarget of ['/etc/shadow', '../outside.py', '../../secret']) {
    controller.snapshotToReturn = {
      canonicalRevisionDigest: rev,
      entries: [
        createSnapshotEntry('src/escape_link.py', '', {
          kind: 'symlink',
          linkTarget: outsideTarget,
          digest: computeFileDigest(''),
        }),
      ],
    };

    await assert.rejects(
      async () => {
        await manager.admitCommandView({ workspaceId: ws.workspaceId });
      },
      { message: /UNSAFE_LINK_TARGET/ },
      `Expected outside link target ${outsideTarget} to be rejected`
    );
  }
  assert.equal(controller.materializedViews.length, 0);
});

test('DockerWorkspaceManager: admitCommandView rejects excluded link targets (.env, secret-bearing targets)', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const rev = 'sha256:0888888888888888888888888888888888888888888888888888888888888888';

  const ws = await manager.createWorkspace({
    taskId: 'task-snap-10',
    workspaceId: 'ws-snap-10',
    initialRevisionDigest: rev,
    profile: createValidProfile(),
  });

  // Link pointing to protected path .env
  controller.snapshotToReturn = {
    canonicalRevisionDigest: rev,
    entries: [
      createSnapshotEntry('.env', 'DATABASE_KEY=secret\n'),
      createSnapshotEntry('src/env_link.py', '', {
        kind: 'symlink',
        linkTarget: '.env',
        digest: computeFileDigest('DATABASE_KEY=secret\n'),
      }),
    ],
  };

  await assert.rejects(
    async () => {
      await manager.admitCommandView({ workspaceId: ws.workspaceId });
    },
    { message: /FORBIDDEN_LINK_TARGET/ }
  );

  // Link pointing to file containing embedded secret
  controller.snapshotToReturn = {
    canonicalRevisionDigest: rev,
    entries: [
      createSnapshotEntry('src/secret_source.py', 'API_KEY = "MARKER_SECRET_FORBIDDEN_01"\n'),
      createSnapshotEntry('src/secret_link.py', '', {
        kind: 'symlink',
        linkTarget: 'src/secret_source.py',
        digest: computeFileDigest('API_KEY = "MARKER_SECRET_FORBIDDEN_01"\n'),
      }),
    ],
  };

  await assert.rejects(
    async () => {
      await manager.admitCommandView({ workspaceId: ws.workspaceId });
    },
    { message: /FORBIDDEN_LINK_TARGET/ }
  );
  assert.equal(controller.materializedViews.length, 0);
});

test('DockerWorkspaceManager: admitCommandView excludes protected paths and unrequired embedded secrets before materialization', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const rev = 'sha256:0999999999999999999999999999999999999999999999999999999999999999';

  const ws = await manager.createWorkspace({
    taskId: 'task-snap-11',
    workspaceId: 'ws-snap-11',
    initialRevisionDigest: rev,
    profile: createValidProfile(),
  });

  const calcPy = 'def add(a, b): return a + b\n';
  const testPy = 'def test_add(): assert add(1, 2) == 3\n';

  controller.snapshotToReturn = {
    canonicalRevisionDigest: rev,
    entries: [
      createSnapshotEntry('src/calculator.py', calcPy),
      createSnapshotEntry('tests/test_calculator.py', testPy),
      createSnapshotEntry('.env', 'DATABASE_PASSWORD=secret123\n'),
      createSnapshotEntry('keys/id_rsa', '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n'),
      createSnapshotEntry('.git/config', '[core]\nrepositoryformatversion = 0\n'),
      createSnapshotEntry('.agents/skills/tdd/SKILL.md', '# TDD Skill\n'),
      createSnapshotEntry('config/unrequired_credentials.txt', 'api_key: MARKER_SECRET_UNREQUIRED_01\n'),
    ],
  };

  const view = await manager.admitCommandView({ workspaceId: ws.workspaceId });

  // Admitted view assertions
  assert.equal(view.admittedFiles.length, 2);
  const admittedPaths = view.admittedFiles.map((f) => f.path);
  assert.deepEqual(admittedPaths.sort(), ['src/calculator.py', 'tests/test_calculator.py']);
  assert.equal(
    view.admittedFiles.find((f) => f.path === 'src/calculator.py')?.digest,
    computeFileDigest(calcPy)
  );
  assert.equal(
    view.admittedFiles.find((f) => f.path === 'tests/test_calculator.py')?.digest,
    computeFileDigest(testPy)
  );
  assert.equal(view.mountedReadOnly, true);
  assert.equal(view.scratchIdentity, ws.scratchVolumeId);

  // Validate canonical command view
  const valid = validateCommandView(view);
  assert.equal(valid.ok, true);

  // Materialization spy assertions: receives permitted bytes ONLY and read-only view identity
  assert.equal(controller.materializedViews.length, 1);
  const materialized = controller.materializedViews[0];
  assert.ok(materialized);
  assert.equal(materialized.view.viewId, view.viewId);
  assert.equal(materialized.view.mountedReadOnly, true);
  assert.deepEqual(Object.keys(materialized.files).sort(), ['src/calculator.py', 'tests/test_calculator.py']);
  assert.equal(materialized.files['src/calculator.py'], calcPy);
  assert.equal(materialized.files['tests/test_calculator.py'], testPy);

  // Verify zero protected bytes sent to controller
  for (const forbiddenKey of ['.env', 'keys/id_rsa', '.git/config', '.agents/skills/tdd/SKILL.md', 'config/unrequired_credentials.txt']) {
    assert.equal(forbiddenKey in materialized.files, false, `Forbidden key ${forbiddenKey} must not be passed to materializeView`);
  }
});

test('DockerWorkspaceManager: admitCommandView fails closed when required file is a protected path (no silent redaction)', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const rev = 'sha256:0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  const ws = await manager.createWorkspace({
    taskId: 'task-snap-12',
    workspaceId: 'ws-snap-12',
    initialRevisionDigest: rev,
    profile: createValidProfile(),
  });

  controller.snapshotToReturn = {
    canonicalRevisionDigest: rev,
    entries: [
      createSnapshotEntry('src/calculator.py', 'def add(a, b): return a + b\n'),
      createSnapshotEntry('.env', 'SECRET=true\n'),
    ],
    requiredFiles: ['.env', 'src/calculator.py'],
  };

  await assert.rejects(
    async () => {
      await manager.admitCommandView({ workspaceId: ws.workspaceId });
    },
    { message: /PROTECTED_PATH_FORBIDDEN/ }
  );
  assert.equal(controller.materializedViews.length, 0);
});

test('DockerWorkspaceManager: admitCommandView fails closed when required file contains embedded secret (no silent redaction)', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const rev = 'sha256:0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  const ws = await manager.createWorkspace({
    taskId: 'task-snap-13',
    workspaceId: 'ws-snap-13',
    initialRevisionDigest: rev,
    profile: createValidProfile(),
  });

  controller.snapshotToReturn = {
    canonicalRevisionDigest: rev,
    entries: [
      createSnapshotEntry('src/auth.py', 'TOKEN = "MARKER_SECRET_REQUIRED_TOKEN_99"\ndef login(): pass\n'),
    ],
  };

  await assert.rejects(
    async () => {
      await manager.admitCommandView({
        workspaceId: ws.workspaceId,
        requiredFiles: ['src/auth.py'],
      });
    },
    { message: /REQUIRED_FILE_CONTAINS_PROTECTED_CONTENT/ }
  );
  assert.equal(controller.materializedViews.length, 0);
});

test('DockerWorkspaceManager: admitCommandView fails closed when required file is missing from snapshot', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const rev = 'sha256:0ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

  const ws = await manager.createWorkspace({
    taskId: 'task-snap-14',
    workspaceId: 'ws-snap-14',
    initialRevisionDigest: rev,
    profile: createValidProfile(),
  });

  controller.snapshotToReturn = {
    canonicalRevisionDigest: rev,
    entries: [
      createSnapshotEntry('src/calculator.py', 'def add(a, b): return a + b\n'),
    ],
    requiredFiles: ['src/calculator.py', 'tests/test_calculator.py'],
  };

  await assert.rejects(
    async () => {
      await manager.admitCommandView({ workspaceId: ws.workspaceId });
    },
    { message: /REQUIRED_FILE_EXCLUDED/ }
  );
  assert.equal(controller.materializedViews.length, 0);
});

test('DockerWorkspaceManager: admitCommandView accepts valid link target pointing to permitted regular file', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const rev = 'sha256:0ddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';

  const ws = await manager.createWorkspace({
    taskId: 'task-snap-15',
    workspaceId: 'ws-snap-15',
    initialRevisionDigest: rev,
    profile: createValidProfile(),
  });

  const calcContent = 'def add(a, b): return a + b\n';
  const calcDigest = computeFileDigest(calcContent);

  controller.snapshotToReturn = {
    canonicalRevisionDigest: rev,
    entries: [
      createSnapshotEntry('src/calculator.py', calcContent),
      createSnapshotEntry('src/calc_alias.py', '', {
        kind: 'symlink',
        linkTarget: 'src/calculator.py',
        digest: calcDigest,
      }),
    ],
  };

  const view = await manager.admitCommandView({ workspaceId: ws.workspaceId });
  assert.equal(view.admittedFiles.length, 2);
  assert.equal(controller.materializedViews.length, 1);
  const matLink = controller.materializedViews[0];
  assert.ok(matLink);
  assert.equal(matLink.files['src/calc_alias.py'], calcContent);
});

test('DockerWorkspaceManager: admitCommandView rejects view if canonical revision changed during snapshot/materialization', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const rev1 = 'sha256:0eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const rev2 = 'sha256:0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

  const ws = await manager.createWorkspace({
    taskId: 'task-snap-16',
    workspaceId: 'ws-snap-16',
    initialRevisionDigest: rev1,
    profile: createValidProfile(),
  });

  controller.snapshotToReturn = {
    canonicalRevisionDigest: rev1,
    entries: [
      createSnapshotEntry('src/calculator.py', 'def add(a, b): return a + b\n'),
    ],
  };

  // Simulate concurrent revision mutation during materialization
  controller.onMaterialize = () => {
    manager.setCanonicalRevision(ws.workspaceId, rev2);
  };

  await assert.rejects(
    async () => {
      await manager.admitCommandView({ workspaceId: ws.workspaceId });
    },
    { message: /CANONICAL_REVISION_CHANGED/ }
  );

  // Active view must not be stored on concurrent drift
  assert.equal(manager.getActiveCommandView(ws.workspaceId), null);
});

test('DockerWorkspaceManager: changed canonical revision invalidates active command views', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const profile = createValidProfile();

  const rev1 = 'sha256:0111111111111111111111111111111111111111111111111111111111111111';
  const rev2 = 'sha256:0222222222222222222222222222222222222222222222222222222222222222';

  const ws = await manager.createWorkspace({
    taskId: 'task-uc03-103',
    workspaceId: 'ws-uc03-103',
    initialRevisionDigest: rev1,
    profile,
  });

  controller.snapshotToReturn = {
    canonicalRevisionDigest: rev1,
    entries: [
      createSnapshotEntry('src/calculator.py', 'def add(a, b): return a + b\n'),
      createSnapshotEntry('tests/test_calculator.py', 'def test_add(): assert add(1, 2) == 3\n'),
    ],
  };

  const view = await manager.admitCommandView({ workspaceId: ws.workspaceId });

  assert.equal(view.canonicalRevisionDigest, rev1);
  assert.equal(manager.getActiveCommandView(ws.workspaceId)?.viewId, view.viewId);

  // Updating canonical revision invalidates the view
  manager.setCanonicalRevision(ws.workspaceId, rev2);
  assert.equal(manager.getActiveCommandView(ws.workspaceId), null);

  // Attempting to admit view with stale rev1 now fails
  await assert.rejects(
    async () => {
      await manager.admitCommandView({
        workspaceId: ws.workspaceId,
        canonicalRevisionDigest: rev1,
      });
    },
    { message: /STALE_COMMAND_VIEW/ }
  );
});

test('containsProtectedContent: detects marker secrets, private keys, bearer tokens, API tokens', () => {
  assert.equal(containsProtectedContent('def add(a, b): return a + b'), false);
  assert.equal(containsProtectedContent('TOKEN = "MARKER_SECRET_42"'), true);
  assert.equal(containsProtectedContent('token: marker-secret-123'), true);
  assert.equal(containsProtectedContent('-----BEGIN RSA PRIVATE KEY-----\nMIIE'), true);
  assert.equal(containsProtectedContent('Authorization: Bearer abcd1234efgh5678'), true);
  assert.equal(containsProtectedContent('api_key = "sk-123456789012345678901234"'), true);
  assert.equal(containsProtectedContent('github_token = "ghp_123456789012345678901234567890123456"'), true);
});

test('DockerWorkspaceManager: isolates volumes across delimiter-collision task/workspace tuples (probe)', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const profile = createValidProfile();
  const rev = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  // Hyphen collision probe: task 'a-b' / ws 'c' vs task 'a' / ws 'b-c'
  const ws1 = await manager.createWorkspace({
    taskId: 'a-b',
    workspaceId: 'c',
    initialRevisionDigest: rev,
    profile,
  });

  const ws2 = await manager.createWorkspace({
    taskId: 'a',
    workspaceId: 'b-c',
    initialRevisionDigest: rev,
    profile,
  });

  // Verify volume identities are strictly disjoint
  assert.notEqual(ws1.repoVolumeId, ws2.repoVolumeId, 'repoVolumeIds must not collide');
  assert.notEqual(ws1.scratchVolumeId, ws2.scratchVolumeId, 'scratchVolumeIds must not collide');
  assert.notEqual(ws1.repoVolumeId, ws1.scratchVolumeId, 'repo and scratch volume IDs must be role-distinct');
  assert.notEqual(ws2.repoVolumeId, ws2.scratchVolumeId, 'repo and scratch volume IDs must be role-distinct');

  // Verify all 4 created volumes in controller are unique
  assert.equal(controller.createdVolumes.length, 4);
  assert.equal(new Set(controller.createdVolumes).size, 4, 'Controller must create 4 distinct volumes');

  // Verify Docker volume naming safety: lowercase alphanumeric and hyphens, role-distinct prefixes, no colons
  const dockerVolumeRegex = /^vol-(?:repo|scratch)-[0-9a-f]{64}$/;
  for (const volId of controller.createdVolumes) {
    assert.match(volId, dockerVolumeRegex, `Volume ID '${volId}' must match Docker-safe format`);
    assert.equal(volId.includes(':'), false, `Volume ID '${volId}' must not contain colons`);
    assert.ok(volId.length <= 255, `Volume ID '${volId}' must be <= 255 characters`);
  }
});

test('DockerWorkspaceManager: stable resume preserves exact identities across multiple resumes', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const profile = createValidProfile();
  const rev = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  const ws = await manager.createWorkspace({
    taskId: 'task-stable-1',
    workspaceId: 'ws-stable-1',
    initialRevisionDigest: rev,
    profile,
  });

  const expectedVolumeIds = computeWorkspaceVolumeIds('task-stable-1', 'ws-stable-1');
  assert.equal(ws.repoVolumeId, expectedVolumeIds.repoVolumeId);
  assert.equal(ws.scratchVolumeId, expectedVolumeIds.scratchVolumeId);

  // First resume
  const resumed1 = await manager.resumeWorkspace({ workspace: ws, profile });
  assert.equal(resumed1.repoVolumeId, ws.repoVolumeId);
  assert.equal(resumed1.scratchVolumeId, ws.scratchVolumeId);
  assert.equal(resumed1.taskId, ws.taskId);
  assert.equal(resumed1.workspaceId, ws.workspaceId);

  // Second resume
  const resumed2 = await manager.resumeWorkspace({ workspace: ws, profile });
  assert.equal(resumed2.repoVolumeId, ws.repoVolumeId);
  assert.equal(resumed2.scratchVolumeId, ws.scratchVolumeId);

  // Zero new volumes created during resumes
  assert.equal(controller.createdVolumes.length, 2);
});

test('DockerWorkspaceManager: rejects cross-task resume identity drift and volume tampering', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const profile = createValidProfile();
  const rev = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  const ws = await manager.createWorkspace({
    taskId: 'task-drift-owner',
    workspaceId: 'ws-drift-target',
    initialRevisionDigest: rev,
    profile,
  });

  // Attempt cross-task resume with different taskId but reusing original volumes
  const crossTaskDrift = {
    ...ws,
    taskId: 'task-drift-hijacker',
  };
  await assert.rejects(
    async () => {
      await manager.resumeWorkspace({ workspace: crossTaskDrift, profile });
    },
    { message: /VOLUME_IDENTITY_MISMATCH/ }
  );

  // Attempt cross-task resume with recomputed volumes for the hijacker
  const hijackerVolumes = computeWorkspaceVolumeIds('task-drift-hijacker', 'ws-drift-target');
  const crossTaskWithNewVols = {
    ...ws,
    taskId: 'task-drift-hijacker',
    repoVolumeId: hijackerVolumes.repoVolumeId,
    scratchVolumeId: hijackerVolumes.scratchVolumeId,
  };
  await assert.rejects(
    async () => {
      await manager.resumeWorkspace({ workspace: crossTaskWithNewVols, profile });
    },
    { message: /VOLUME_IDENTITY_MISMATCH/ }
  );

  // Tampered repoVolumeId
  await assert.rejects(
    async () => {
      await manager.resumeWorkspace({
        workspace: { ...ws, repoVolumeId: 'vol-repo-tampered-12345' },
        profile,
      });
    },
    { message: /VOLUME_IDENTITY_MISMATCH/ }
  );

  // Tampered scratchVolumeId
  await assert.rejects(
    async () => {
      await manager.resumeWorkspace({
        workspace: { ...ws, scratchVolumeId: 'vol-scratch-tampered-12345' },
        profile,
      });
    },
    { message: /VOLUME_IDENTITY_MISMATCH/ }
  );
});

test('DockerWorkspaceManager: duplicate workspaceId fails before effects (zero additional volumes)', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const profile = createValidProfile();
  const rev = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  await manager.createWorkspace({
    taskId: 'task-dup-1',
    workspaceId: 'ws-unique-1',
    initialRevisionDigest: rev,
    profile,
  });
  assert.equal(controller.createdVolumes.length, 2);

  // Duplicate with same taskId
  await assert.rejects(
    async () => {
      await manager.createWorkspace({
        taskId: 'task-dup-1',
        workspaceId: 'ws-unique-1',
        initialRevisionDigest: rev,
        profile,
      });
    },
    { message: /WORKSPACE_ALREADY_EXISTS/ }
  );
  assert.equal(controller.createdVolumes.length, 2, 'No new volumes allocated on duplicate workspaceId');

  // Duplicate with different taskId
  await assert.rejects(
    async () => {
      await manager.createWorkspace({
        taskId: 'task-dup-2',
        workspaceId: 'ws-unique-1',
        initialRevisionDigest: rev,
        profile,
      });
    },
    { message: /WORKSPACE_ALREADY_EXISTS/ }
  );
  assert.equal(controller.createdVolumes.length, 2, 'No new volumes allocated on cross-task duplicate workspaceId');
});

test('DockerWorkspaceManager: invalid taskId or workspaceId variants fail before effects', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const profile = createValidProfile();
  const rev = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  const invalidInputs = [
    { taskId: '', workspaceId: 'ws-valid' },
    { taskId: '   ', workspaceId: 'ws-valid' },
    { taskId: 'task-valid', workspaceId: '' },
    { taskId: 'task-valid', workspaceId: '   ' },
    { taskId: 123 as unknown as string, workspaceId: 'ws-valid' },
    { taskId: 'task-valid', workspaceId: null as unknown as string },
  ];

  for (const inv of invalidInputs) {
    await assert.rejects(
      async () => {
        await manager.createWorkspace({
          taskId: inv.taskId,
          workspaceId: inv.workspaceId,
          initialRevisionDigest: rev,
          profile,
        });
      },
      { message: /INVALID_TASK_WORKSPACE/ }
    );
  }

  assert.equal(controller.createdVolumes.length, 0, 'Zero volumes created across all invalid ID attempts');
});

/* ------------------------------------------------------------------
 * T006-b Structured Command Executor & Plan Generation Tests
 * ------------------------------------------------------------------ */

function createValidLimits(overrides?: Partial<ExecutionLimits>): ExecutionLimits {
  return {
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
    maxCpuCores: 2,
    maxMemoryBytes: 2147483648,
    maxPids: 256,
    ...overrides,
  };
}

async function setupWorkspaceWithAdmittedView(
  manager: DockerWorkspaceManager,
  controller: FakeDockerLifecycleController,
  taskId = 'task-t006b',
  workspaceId = 'ws-t006b',
  revision = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
): Promise<{ ws: TaskWorkspace; view: CommandView; profile: DockerProfile }> {
  const profile = createValidProfile();
  const ws = await manager.createWorkspace({
    taskId,
    workspaceId,
    initialRevisionDigest: revision,
    profile,
  });
  controller.snapshotToReturn = {
    canonicalRevisionDigest: revision,
    entries: [
      createSnapshotEntry('src/solution.py', 'def solve(): return 42\n'),
      createSnapshotEntry('tests/test_solution.py', 'def test_solve(): pass\n'),
    ],
  };
  const view = await manager.admitCommandView({ workspaceId });
  return { ws, view, profile };
}

test('DockerProfile validation: rejects arbitrary mount targets, host bind mounts, and duplicate targets', () => {
  // Arbitrary target
  const badTargetMounts: DockerMountConfig[] = [
    { source: 'vol-repo', target: '/workspace/repo', readOnly: true },
    { source: 'vol-custom', target: '/workspace/custom', readOnly: true },
  ];
  const resTarget = validateDockerProfile(createValidProfile({ mounts: badTargetMounts }));
  assert.equal(resTarget.ok, false);
  if (!resTarget.ok) {
    assert.ok(resTarget.errors.some((e) => e.code === 'ARBITRARY_MOUNT_TARGET_FORBIDDEN'));
  }

  // Host bind mount sources (absolute, relative, windows)
  for (const hostSource of ['/var/lib/data', 'C:\\host\\data', '../outside', './relative']) {
    const hostMounts: DockerMountConfig[] = [
      { source: hostSource, target: '/workspace/repo', readOnly: true },
    ];
    const resHost = validateDockerProfile(createValidProfile({ mounts: hostMounts }));
    assert.equal(resHost.ok, false);
    if (!resHost.ok) {
      assert.ok(resHost.errors.some((e) => e.code === 'HOST_BIND_MOUNT_FORBIDDEN' || e.code === 'DANGEROUS_MOUNT_FORBIDDEN'));
    }
  }

  // Scratch mounted read-only
  const roScratchMounts: DockerMountConfig[] = [
    { source: 'vol-repo', target: '/workspace/repo', readOnly: true },
    { source: 'vol-scratch', target: '/workspace/scratch', readOnly: true },
  ];
  const resRoScratch = validateDockerProfile(createValidProfile({ mounts: roScratchMounts }));
  assert.equal(resRoScratch.ok, false);
  if (!resRoScratch.ok) {
    assert.ok(resRoScratch.errors.some((e) => e.code === 'WRITABLE_SCRATCH_MOUNT_REQUIRED'));
  }

  // Canonical repo volume mounted at scratch
  const repoAtScratchMounts: DockerMountConfig[] = [
    { source: 'vol-repo', target: '/workspace/scratch', readOnly: false },
  ];
  const resRepoScratch = validateDockerProfile(createValidProfile({ mounts: repoAtScratchMounts }));
  assert.equal(resRepoScratch.ok, false);
  if (!resRepoScratch.ok) {
    assert.ok(resRepoScratch.errors.some((e) => e.code === 'READONLY_REPO_MOUNT_REQUIRED'));
  }

  // Duplicate mount targets
  const dupMounts: DockerMountConfig[] = [
    { source: 'vol-repo-1', target: '/workspace/repo', readOnly: true },
    { source: 'vol-repo-2', target: '/workspace/repo', readOnly: true },
  ];
  const resDup = validateDockerProfile(createValidProfile({ mounts: dupMounts }));
  assert.equal(resDup.ok, false);
  if (!resDup.ok) {
    assert.ok(resDup.errors.some((e) => e.code === 'DUPLICATE_MOUNT_TARGET_FORBIDDEN'));
  }
});

test('StructuredCommandExecutor: requires manager and controller', () => {
  assert.throws(
    () => new StructuredCommandExecutor(null as unknown as { manager: DockerWorkspaceManager }),
    { message: /MANAGER_REQUIRED/ }
  );

  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const profile = createValidProfile();
  const executor = new StructuredCommandExecutor({ manager, controller, profile });
  assert.ok(executor);
});

test('StructuredCommandExecutor: generates exact narrow container plan and dispatches to controller spy', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, view, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-plan-01', 'ws-plan-01');

  const executor = new StructuredCommandExecutor({ manager, controller, profile });
  const limits = createValidLimits({ timeoutMs: 45000, maxOutputBytes: 65536 });

  controller.outputToReturn = {
    exitCode: 0,
    stdout: 'test passed in 0.12s\n',
    stderr: '',
    durationMs: 120,
    timedOut: false,
  };

  const result = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q', 'tests/test_solution.py'],
    limits,
  });

  // Verify controller dispatch count
  assert.equal(controller.executedPlans.length, 1, 'Controller spy must record exactly one dispatch');
  const plan = controller.executedPlans[0];
  assert.ok(plan);

  // Exact narrow container plan assertions
  assert.equal(plan.image, profile.image);
  assert.equal(plan.imageDigest, profile.imageDigest);
  assert.equal(plan.user, profile.user);
  assert.equal(plan.readOnlyRootFilesystem, true);
  assert.equal(plan.network, 'none');
  assert.deepEqual(plan.dropCapabilities, ['ALL']);
  assert.equal(plan.noNewPrivileges, true);

  // Exactly 2 mounts: view mounted RO at /workspace/repo, scratch only writable at /workspace/scratch
  assert.equal(plan.mounts.length, 2);
  assert.deepEqual(plan.mounts[0], {
    source: view.viewId,
    target: '/workspace/repo',
    readOnly: true,
  });
  assert.deepEqual(plan.mounts[1], {
    source: view.scratchIdentity,
    target: '/workspace/scratch',
    readOnly: false,
  });

  // Canonical repo volume NEVER accessible to execution container
  assert.notEqual(plan.mounts[0]?.source, ws.repoVolumeId);
  assert.notEqual(plan.mounts[1]?.source, ws.repoVolumeId);
  for (const m of plan.mounts) {
    assert.equal(m.source.includes('vol-repo'), false, 'Plan mount source must not be canonical repo volume');
  }

  // Executable, argv, working directory
  assert.equal(plan.executable, 'pytest');
  assert.deepEqual(plan.argv, ['-q', 'tests/test_solution.py']);
  assert.equal(plan.workingDirectory, '/workspace/repo');

  // Minimal configured env, zero host env inheritance
  assert.equal(plan.env['PYTHONPATH'], '/workspace/repo');
  assert.equal(plan.env['PYTHONDONTWRITEBYTECODE'], '1');
  assert.equal(plan.env['TMPDIR'], '/workspace/scratch');
  assert.equal(plan.env['HOME'], '/workspace/scratch');
  assert.notEqual(plan.env['PATH'], process.env['PATH']);

  // Limits match exact execution limits
  assert.deepEqual(plan.limits, limits);

  // Result matches typed execution result
  assert.equal(result.outcome, 'success');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'test passed in 0.12s\n');
  assert.equal(result.stderr, '');
  assert.equal(result.durationMs, 120);
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.plan, plan);
});

test('StructuredCommandExecutor: ZERO controller dispatch on missing or stale command view', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const profile = createValidProfile();
  const executor = new StructuredCommandExecutor({ manager, controller, profile });
  const limits = createValidLimits();

  // No active view exists for unknown workspace
  await assert.rejects(
    async () => {
      await executor.execute({
        workspaceId: 'ws-nonexistent',
        executable: 'pytest',
        argv: ['-q'],
        limits,
      });
    },
    { message: /COMMAND_VIEW_REQUIRED/ }
  );
  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch on missing view');

  // Active view exists, but canonical revision changes (view becomes stale)
  const { ws, view } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-stale-01', 'ws-stale-01');
  manager.setCanonicalRevision(ws.workspaceId, 'sha256:9999999999999999999999999999999999999999999999999999999999999999');

  await assert.rejects(
    async () => {
      await executor.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        argv: ['-q'],
        limits,
      });
    },
    { message: /COMMAND_VIEW_REQUIRED/ }
  );
  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch on invalidated view');

  // Caller supplies mismatching or stale view object
  const { ws: ws2 } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-stale-02', 'ws-stale-02');
  await assert.rejects(
    async () => {
      await executor.execute({
        workspaceId: ws2.workspaceId,
        executable: 'pytest',
        argv: ['-q'],
        limits,
        view: view, // Stale view from ws-stale-01
      });
    },
    { message: /STALE_COMMAND_VIEW/ }
  );
  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch on stale view object');
});

test('StructuredCommandExecutor: ZERO controller dispatch on missing or invalid execution limits', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-lim-01', 'ws-lim-01');
  const executor = new StructuredCommandExecutor({ manager, controller, profile });

  const invalidLimitsList = [
    null,
    undefined,
    {},
    { ...createValidLimits(), timeoutMs: 0 },
    { ...createValidLimits(), timeoutMs: -50 },
    { ...createValidLimits(), maxOutputBytes: 0 },
    { ...createValidLimits(), maxCpuCores: 0 },
    { ...createValidLimits(), maxMemoryBytes: 0 },
    { ...createValidLimits(), maxPids: 0 },
    { ...createValidLimits(), extraUnknownProp: 123 },
  ];

  for (const badLimits of invalidLimitsList) {
    await assert.rejects(
      async () => {
        await executor.execute({
          workspaceId: ws.workspaceId,
          executable: 'pytest',
          argv: ['-q'],
          limits: badLimits as unknown as ExecutionLimits,
        });
      },
      { message: /INVALID_EXECUTION_LIMITS/ }
    );
  }

  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch across all invalid limits');
});

test('StructuredCommandExecutor: ZERO controller dispatch on disallowed executable', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-exec-01', 'ws-exec-01');
  const executor = new StructuredCommandExecutor({ manager, controller, profile });
  const limits = createValidLimits();

  const disallowedExecutables = ['rm', '/bin/sh', 'bash', 'curl', 'wget', 'cat', 'node', 'chmod'];
  for (const badExec of disallowedExecutables) {
    await assert.rejects(
      async () => {
        await executor.execute({
          workspaceId: ws.workspaceId,
          executable: badExec,
          argv: ['-q'],
          limits,
        });
      },
      { message: /DISALLOWED_EXECUTABLE/ },
      'Expected disallowed executable ' + badExec + ' to be rejected'
    );
  }

  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch across all disallowed executables');
});

test('StructuredCommandExecutor: exported executable set mutations cannot change admission or diagnostics', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller);
  const executor = new StructuredCommandExecutor({ manager, controller, profile });
  const exportedExecutables = ALLOWED_EXECUTABLES as Set<string>;
  const originalExecutables = [...exportedExecutables];

  try {
    exportedExecutables.clear();
    exportedExecutables.add('sh');
    await assert.rejects(
      executor.execute({ workspaceId: ws.workspaceId, executable: 'sh', limits: createValidLimits() }),
      { message: "DISALLOWED_EXECUTABLE: Executable 'sh' is not in allowed executable set (pytest, python, python3)" }
    );
    assert.equal(controller.executedPlans.length, 0);

    for (const executable of ['pytest', 'python', 'python3']) {
      const result = await executor.execute({ workspaceId: ws.workspaceId, executable, limits: createValidLimits() });
      assert.equal(result.plan.executable, executable);
    }
    assert.equal(controller.executedPlans.length, 3);
  } finally {
    exportedExecutables.clear();
    for (const executable of originalExecutables) exportedExecutables.add(executable);
  }
});

test('StructuredCommandExecutor: ZERO controller dispatch on forbidden argv with shell metacharacters', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-shell-01', 'ws-shell-01');
  const executor = new StructuredCommandExecutor({ manager, controller, profile });
  const limits = createValidLimits();

  const forbiddenArgvs = [
    ['-q', '; rm -rf /'],
    ['-q', '| cat /etc/shadow'],
    ['-q', '&& echo pwned'],
    ['-q', String.fromCharCode(96) + 'whoami' + String.fromCharCode(96)],
    ['-q', '$(cat /tmp/secret)'],
    ['-q', '> /workspace/repo/hacked.py'],
    ['-q', '< /etc/passwd'],
    ['-q\nmalicious'],
    ['-q\rmalicious'],
  ];

  for (const badArgv of forbiddenArgvs) {
    await assert.rejects(
      async () => {
        await executor.execute({
          workspaceId: ws.workspaceId,
          executable: 'pytest',
          argv: badArgv,
          limits,
        });
      },
      { message: /FORBIDDEN_SHELL_CHARACTERS/ },
      'Expected argv ' + JSON.stringify(badArgv) + ' to be rejected'
    );
  }

  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch across all shell injection argvs');
});

test('StructuredCommandExecutor: ZERO controller dispatch on forbidden environment variables', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-env-01', 'ws-env-01');
  const executor = new StructuredCommandExecutor({ manager, controller, profile });
  const limits = createValidLimits();

  const forbiddenEnvs = [
    { AWS_SECRET_ACCESS_KEY: 'secret123' },
    { GITHUB_TOKEN: 'ghp_012345678901234567890123456789012345' },
    { OPENAI_API_KEY: 'sk-123456789012345678901234' },
    { ANTHROPIC_API_KEY: 'sk-ant-1234' },
    { GEMINI_API_KEY: 'gemini-key-1234' },
    { CUSTOM_VAR: 'MARKER_SECRET_FORBIDDEN_01' },
    { CUSTOM_KEY: 'Bearer eyJhbGciOi' },
    { PASSWORD: 'mypassword' },
  ];

  for (const badEnv of forbiddenEnvs) {
    await assert.rejects(
      async () => {
        await executor.execute({
          workspaceId: ws.workspaceId,
          executable: 'pytest',
          argv: ['-q'],
          env: badEnv,
          limits,
        });
      },
      { message: /FORBIDDEN_ENVIRONMENT_VARIABLE/ }
    );
  }

  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch across all forbidden env attempts');
});

test('StructuredCommandExecutor: ZERO controller dispatch on invalid working directory', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-wd-01', 'ws-wd-01');
  const executor = new StructuredCommandExecutor({ manager, controller, profile });
  const limits = createValidLimits();

  for (const badWd of ['/', '/etc', '/root', '../outside', '/var/log']) {
    await assert.rejects(
      async () => {
        await executor.execute({
          workspaceId: ws.workspaceId,
          action: {
            actionId: 'act-wd-bad',
            kind: 'run_command',
            executable: 'pytest',
            argv: ['-q'],
            workingDirectory: badWd,
          },
          limits,
        });
      },
      { message: /INVALID_WORKING_DIRECTORY/ }
    );
  }

  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch on invalid workingDirectory');
});

test('StructuredCommandExecutor: validates normalized working-directory containment and dispatches normalized paths', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller);
  const executor = new StructuredCommandExecutor({ manager, controller, profile });

  for (const workingDirectory of [
    '/workspace/repo/../../etc',
    '/workspace/scratch/../../etc',
    '/workspace/repo/subdir/../../../root',
    '/workspace/scratch/..',
    '/workspace/repository',
    '/workspace/scratch-other',
    'workspace/repo',
  ]) {
    await assert.rejects(
      executor.execute({ workspaceId: ws.workspaceId, executable: 'pytest', workingDirectory, limits: createValidLimits() }),
      { message: /INVALID_WORKING_DIRECTORY/ }
    );
  }
  assert.equal(controller.executedPlans.length, 0);

  for (const [workingDirectory, expected] of [
    ['/workspace/repo/tests/..', '/workspace/repo'],
    ['/workspace/scratch/tmp/..', '/workspace/scratch'],
    ['/workspace//repo/./tests', '/workspace/repo/tests'],
    ['/workspace/scratch/tmp/../cache', '/workspace/scratch/cache'],
    ['/workspace/repo/../scratch/tmp', '/workspace/scratch/tmp'],
  ] as const) {
    const result = await executor.execute({
      workspaceId: ws.workspaceId,
      action: { actionId: 'act-normalized-wd', kind: 'run_command', executable: 'pytest', argv: [], workingDirectory },
      limits: createValidLimits(),
    });
    assert.equal(result.plan.workingDirectory, expected);
    assert.equal(controller.executedPlans.at(-1)?.workingDirectory, expected);
  }
});

test('StructuredCommandExecutor: ZERO controller dispatch when controller lacks executeContainer method', async () => {
  const incompleteController = {
    provenance: 'mock' as const,
    createVolume: async () => { void 0; },
    hasVolume: async () => true,
    removeVolume: async () => { void 0; },
    getCanonicalSnapshot: async () => ({
      canonicalRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      entries: [createSnapshotEntry('src/solution.py', 'x = 1\n')],
    }),
    materializeView: async () => { void 0; },
  };

  const manager = new DockerWorkspaceManager({ controller: incompleteController });
  const profile = createValidProfile();
  const ws = await manager.createWorkspace({
    taskId: 'task-noexec-1',
    workspaceId: 'ws-noexec-1',
    initialRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    profile,
  });
  await manager.admitCommandView({ workspaceId: ws.workspaceId });

  const executor = new StructuredCommandExecutor({ manager, controller: incompleteController, profile });
  await assert.rejects(
    async () => {
      await executor.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        argv: ['-q'],
        limits: createValidLimits(),
      });
    },
    { message: /CONTROLLER_EXECUTE_METHOD_REQUIRED/ }
  );
});

test('StructuredCommandExecutor: output bounding preserves typed results and failure exitCode', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-bound-01', 'ws-bound-01');
  const executor = new StructuredCommandExecutor({ manager, controller, profile });
  const limits = createValidLimits({ maxOutputBytes: 20 });

  controller.outputToReturn = {
    exitCode: 1,
    stdout: 'A'.repeat(500),
    stderr: 'E'.repeat(500),
    durationMs: 200,
    timedOut: false,
  };

  const result = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.outcome, 'failure');
  assert.equal(result.stdout.length, 10);
  assert.equal(result.stdout, 'A'.repeat(10));
  assert.equal(result.stderr.length, 10);
  assert.equal(result.stderr, 'E'.repeat(10));
  assert.equal(Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8'), 20);
  assert.equal(result.truncated, true);
  assert.equal(result.durationMs, 200);
  assert.equal(result.timedOut, false);
});

test('StructuredCommandExecutor: handles timeout and preserves typed outcome (injected controller responsible for termination)', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-timeout-01', 'ws-timeout-01');
  const executor = new StructuredCommandExecutor({ manager, controller, profile });
  const limits = createValidLimits({ timeoutMs: 5000 });

  controller.outputToReturn = {
    exitCode: 124,
    stdout: 'running tests...\n',
    stderr: 'Process terminated: timeout reached\n',
    durationMs: 5001,
    timedOut: true,
  };

  const result = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.exitCode, 124);
  assert.equal(result.stdout, 'running tests...\n');
  assert.equal(result.stderr, 'Process terminated: timeout reached\n');
});

test('StructuredCommandExecutor: enforces command view freshness AGAIN AFTER await; invalidates cached views', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const rev1 = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const rev2 = 'sha256:0999999999999999999999999999999999999999999999999999999999999999';
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-drift-await', 'ws-drift-await', rev1);
  const executor = new StructuredCommandExecutor({ manager, controller, profile });

  // Simulate concurrent revision mutation during command execution in the controller
  controller.onExecute = () => {
    manager.setCanonicalRevision(ws.workspaceId, rev2);
  };

  await assert.rejects(
    async () => {
      await executor.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        argv: ['-q'],
        limits: createValidLimits(),
      });
    },
    { message: /CANONICAL_REVISION_CHANGED/ }
  );

  // Cached view must be invalidated
  assert.equal(manager.getActiveCommandView(ws.workspaceId), null);
});

test('DockerWorkspaceManager: createCommandExecutor host construction seam retained, executeCommand wrapper removed, DockerCommandExecutor alias', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-conv-01', 'ws-conv-01');

  controller.outputToReturn = {
    exitCode: 0,
    stdout: '1 passed\n',
    stderr: '',
    durationMs: 80,
    timedOut: false,
  };

  // Assert executeCommand wrapper entrypoint is removed from DockerWorkspaceManager
  assert.equal(
    typeof (manager as unknown as Record<string, unknown>)['executeCommand'],
    'undefined',
    'DockerWorkspaceManager.executeCommand convenience entrypoint must be removed'
  );
  assert.equal(
    'executeCommand' in DockerWorkspaceManager.prototype,
    false,
    'DockerWorkspaceManager.prototype must not expose executeCommand'
  );

  // Host construction seam createCommandExecutor(trustedProfile) executes successfully
  const executor = manager.createCommandExecutor(profile);
  const result = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'python3',
    argv: ['-m', 'pytest', '-q'],
    limits: createValidLimits(),
  });

  assert.equal(result.outcome, 'success');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '1 passed\n');
  assert.equal(controller.executedPlans.length, 1);
  assert.equal(controller.executedPlans[0]?.executable, 'python3');

  // Verify DockerCommandExecutor is exact alias of StructuredCommandExecutor
  assert.equal(DockerCommandExecutor, StructuredCommandExecutor);
  assert.ok(ALLOWED_EXECUTABLES.has("pytest"));
  assert.ok(DEFAULT_CONTAINER_ENV["PYTHONPATH"]);
});

test('StructuredCommandExecutor: ZERO controller dispatch when trusted profile is missing (no fallback)', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-prof-missing', 'ws-prof-missing');
  const limits = createValidLimits();

  // Neither constructor nor execute provides profile
  const executor = new StructuredCommandExecutor({ manager, controller });
  await assert.rejects(
    async () => {
      await executor.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        argv: ['-q'],
        limits,
      });
    },
    { message: /PROFILE_REQUIRED/ }
  );
  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch when profile missing');

  // Host construction seam without profile also fails closed on execute with PROFILE_REQUIRED
  const managerExecutor = manager.createCommandExecutor();
  await assert.rejects(
    async () => {
      await managerExecutor.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        argv: ['-q'],
        limits,
      });
    },
    { message: /PROFILE_REQUIRED/ }
  );
  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch on manager-created executor without profile');

  // Verify manager has no executeCommand entrypoint to bypass constructor authority
  assert.equal(
    (manager as unknown as Record<string, unknown>)['executeCommand'],
    undefined,
    'Zero dispatch and zero entrypoint for manager executeCommand'
  );

  // Absent constructor authority must deny even if command supplies a plausible profile
  const executorWithoutProfile = new StructuredCommandExecutor({ manager, controller });
  const plausibleProfile = createValidProfile();
  await assert.rejects(
    async () => {
      await executorWithoutProfile.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        argv: ['-q'],
        limits,
        profile: plausibleProfile,
      });
    },
    { message: /PROFILE_REQUIRED/ }
  );
  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch when constructor authority is missing even if command supplies profile');
});

test('StructuredCommandExecutor: ZERO controller dispatch on image digest drift from workspace identity', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-img-drift', 'ws-img-drift');
  const limits = createValidLimits();

  // Profile with mismatched imageDigest (even though profile itself is internally valid)
  const driftingProfile: DockerProfile = {
    ...profile,
    imageDigest: 'sha256:' + 'b'.repeat(64),
  };

  const executor = new StructuredCommandExecutor({ manager, controller, profile: driftingProfile });
  await assert.rejects(
    async () => {
      await executor.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        argv: ['-q'],
        limits,
      });
    },
    { message: /IMAGE_DIGEST_MISMATCH/ }
  );
  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch on profile image drift');

  // Command parameter attempting to provide drifting profile is rejected as forbidden override
  const validExecutor = new StructuredCommandExecutor({ manager, controller, profile });
  await assert.rejects(
    async () => {
      await validExecutor.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        argv: ['-q'],
        limits,
        profile: driftingProfile,
      });
    },
    { message: /COMMAND_PROFILE_OVERRIDE_FORBIDDEN/ }
  );
  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch on param profile override attempt');
});

test('StructuredCommandExecutor: enforces finite output ceilings with omitted and configured profile bounds', async () => {
  for (const maxOutputBytes of [undefined, 512, 2097152]) {
    const controller = new FakeDockerLifecycleController();
    const manager = new DockerWorkspaceManager({ controller });
    const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller);
    const profileWithOutputBound = {
      ...profile,
      limits: {
        ...profile.limits,
        ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
      },
    };
    const executor = new StructuredCommandExecutor({ manager, controller, profile: profileWithOutputBound });
    const ceiling = maxOutputBytes ?? 1048576;

    await assert.rejects(
      executor.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        limits: createValidLimits({ maxOutputBytes: ceiling + 1 }),
      }),
      { message: new RegExp(`RESOURCE_LIMIT_EXCEEDS_PROFILE_CEILING: Command maxOutputBytes .* exceeds profile ceiling \\(${ceiling}\\)`) }
    );
    assert.equal(controller.executedPlans.length, 0);

    const result = await executor.execute({
      workspaceId: ws.workspaceId,
      executable: 'pytest',
      limits: createValidLimits({ maxOutputBytes: ceiling }),
    });
    assert.equal(result.plan.limits.maxOutputBytes, ceiling);
    assert.equal(controller.executedPlans.length, 1);
  }
});

test('StructuredCommandExecutor: ZERO controller dispatch when any resource limit exceeds profile ceiling', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const profileWithOutputBound: DockerProfile = createValidProfile({
    limits: {
      timeoutMs: 60000,
      maxMemoryBytes: 2147483648,
      maxCpuCores: 2,
      maxPids: 256,
      maxOutputBytes: 1048576,
    },
  });

  const { ws } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-cap-ceil', 'ws-cap-ceil');
  const executor = new StructuredCommandExecutor({ manager, controller, profile: profileWithOutputBound });

  const ceilingViolations = [
    { label: 'CPU cores (probe counterexample: 999 vs 2)', limits: createValidLimits({ maxCpuCores: 999 }) },
    { label: 'CPU cores (3 vs 2)', limits: createValidLimits({ maxCpuCores: 3 }) },
    { label: 'memory bytes (4GB vs 2GB)', limits: createValidLimits({ maxMemoryBytes: 4294967296 }) },
    { label: 'PIDs (512 vs 256)', limits: createValidLimits({ maxPids: 512 }) },
    { label: 'timeout (120s vs 60s)', limits: createValidLimits({ timeoutMs: 120000 }) },
    { label: 'output bytes (2MB vs 1MB)', limits: createValidLimits({ maxOutputBytes: 2097152 }) },
  ];

  for (const { label, limits: badLimits } of ceilingViolations) {
    await assert.rejects(
      async () => {
        await executor.execute({
          workspaceId: ws.workspaceId,
          executable: 'pytest',
          argv: ['-q'],
          limits: badLimits,
        });
      },
      { message: /RESOURCE_LIMIT_EXCEEDS_PROFILE_CEILING/ },
      `Expected limit ceiling violation for ${label} to reject before dispatch`
    );
  }
  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch across all resource ceiling violations');
});

test('StructuredCommandExecutor: ZERO controller dispatch on command CPU or user override of trusted constructor profile', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const trustedProfile = createValidProfile({
    user: '1000:1000',
    limits: {
      timeoutMs: 30000,
      maxMemoryBytes: 1073741824,
      maxCpuCores: 2,
      maxPids: 128,
      maxOutputBytes: 524288,
    },
  });

  const ws = await manager.createWorkspace({
    taskId: 'task-override-repro',
    workspaceId: 'ws-override-repro',
    initialRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    profile: trustedProfile,
  });

  controller.snapshotToReturn = {
    canonicalRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    entries: [createSnapshotEntry('src/solution.py', 'def solve(): return 1\n')],
  };
  await manager.admitCommandView({ workspaceId: ws.workspaceId });

  const trustedExecutionLimits: ExecutionLimits = {
    timeoutMs: 30000,
    maxMemoryBytes: 1073741824,
    maxCpuCores: 2,
    maxPids: 128,
    maxOutputBytes: 524288,
  };

  const executor = new StructuredCommandExecutor({ manager, controller, profile: trustedProfile });

  // 1. Probe reproduction: Caller attempts to override constructor CPU 2 with CPU 999 via command profile and matching limits
  await assert.rejects(
    async () => {
      await executor.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        workingDirectory: '/workspace/repo',
        limits: { ...trustedExecutionLimits, maxCpuCores: 999 },
        profile: {
          ...trustedProfile,
          profileId: 'caller',
          user: '2000:2000',
          limits: { ...trustedProfile.limits, maxCpuCores: 999 },
        },
      });
    },
    { message: /COMMAND_PROFILE_OVERRIDE_FORBIDDEN/ }
  );
  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch on caller CPU/user override attempt');

  // 2. Caller attempts user override: constructor user '1000:1000' vs command profile '2000:2000'
  await assert.rejects(
    async () => {
      await executor.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        workingDirectory: '/workspace/repo',
        limits: trustedExecutionLimits,
        profile: {
          ...trustedProfile,
          profileId: 'caller-user-override',
          user: '2000:2000',
        },
      });
    },
    { message: /COMMAND_PROFILE_OVERRIDE_FORBIDDEN/ }
  );
  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch on caller user override attempt');

  // 3. Caller attempts CPU widening via command profile: constructor CPU 2 vs command profile CPU 4
  await assert.rejects(
    async () => {
      await executor.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        workingDirectory: '/workspace/repo',
        limits: trustedExecutionLimits,
        profile: {
          ...trustedProfile,
          limits: { ...trustedProfile.limits, maxCpuCores: 4 },
        },
      });
    },
    { message: /COMMAND_PROFILE_OVERRIDE_FORBIDDEN/ }
  );
  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch on caller CPU limit widening in profile');
});

test('StructuredCommandExecutor: accepts valid exact caps and dispatches matching container plan', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const profile: DockerProfile = createValidProfile({
    limits: {
      timeoutMs: 30000,
      maxMemoryBytes: 1073741824,
      maxCpuCores: 2,
      maxPids: 128,
      maxOutputBytes: 524288,
    },
  });

  const ws = await manager.createWorkspace({
    taskId: 'task-exact-caps',
    workspaceId: 'ws-exact-caps',
    initialRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    profile,
  });

  controller.snapshotToReturn = {
    canonicalRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    entries: [createSnapshotEntry('src/solution.py', 'def solve(): return 1\n')],
  };
  await manager.admitCommandView({ workspaceId: ws.workspaceId });

  const executor = new StructuredCommandExecutor({ manager, controller, profile });

  const exactLimits: ExecutionLimits = {
    timeoutMs: 30000,
    maxMemoryBytes: 1073741824,
    maxCpuCores: 2,
    maxPids: 128,
    maxOutputBytes: 524288,
  };

  controller.outputToReturn = {
    exitCode: 0,
    stdout: 'ok\n',
    stderr: '',
    durationMs: 50,
    timedOut: false,
  };

  const result = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits: exactLimits,
  });

  assert.equal(result.outcome, 'success');
  assert.equal(controller.executedPlans.length, 1);
  const plan = controller.executedPlans[0];
  assert.ok(plan);
  assert.equal(plan.imageDigest, profile.imageDigest);
  assert.equal(plan.imageDigest, ws.containerImageDigest);
  assert.deepEqual(plan.limits, exactLimits);

  // Mutation of profile object after construction does not widen plan limits or alter security policy
  const mutableProfile: DockerProfile = { ...profile, limits: { ...profile.limits } };
  const executorMut = new StructuredCommandExecutor({ manager, controller, profile: mutableProfile });
  (mutableProfile.limits as { maxCpuCores: number }).maxCpuCores = 999;
  (mutableProfile as { user: string }).user = '2000:2000';
  await assert.rejects(
    async () => {
      await executorMut.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        argv: ['-q'],
        limits: { ...exactLimits, maxCpuCores: 999 },
      });
    },
    { message: /RESOURCE_LIMIT_EXCEEDS_PROFILE_CEILING/ }
  );

  // Valid limits execution retains constructor snapshot user ('1000:1000'), immune to later caller mutation
  const validMutResult = await executorMut.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits: exactLimits,
  });
  assert.equal(validMutResult.plan.user, profile.user);
  assert.notEqual(validMutResult.plan.user, '2000:2000');
});

test('StructuredCommandExecutor: accepts host-configured explicit environment allowlist and dispatches approved variables', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-env-ok-01', 'ws-env-ok-01');

  const executor = new StructuredCommandExecutor({
    manager,
    controller,
    profile,
    allowedEnvKeys: ['APP_ENV', 'LOG_LEVEL'],
  });
  const limits = createValidLimits();

  controller.outputToReturn = {
    exitCode: 0,
    stdout: 'ok\n',
    stderr: '',
    durationMs: 40,
    timedOut: false,
  };

  const result = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    env: { APP_ENV: 'testing', LOG_LEVEL: 'debug' },
    limits,
  });

  assert.equal(result.outcome, 'success');
  assert.equal(controller.executedPlans.length, 1, 'Exactly one dispatch on approved variables');
  const plan = controller.executedPlans[0];
  assert.ok(plan);
  assert.equal(plan.env['APP_ENV'], 'testing');
  assert.equal(plan.env['LOG_LEVEL'], 'debug');
  // Minimal trusted runtime env preserved
  assert.equal(plan.env['PYTHONPATH'], '/workspace/repo');
  assert.equal(plan.env['PYTHONDONTWRITEBYTECODE'], '1');
  assert.equal(plan.env['PYTHONUNBUFFERED'], '1');
  assert.equal(plan.env['TMPDIR'], '/workspace/scratch');
  assert.equal(plan.env['HOME'], '/workspace/scratch');
});

test('StructuredCommandExecutor: ZERO controller dispatch on unknown or unallowlisted environment variables (no caller self-authorization)', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-env-unk-01', 'ws-env-unk-01');

  // Without host allowlist (default): cannot pass arbitrary env variables
  const defaultExecutor = new StructuredCommandExecutor({ manager, controller, profile });
  const limits = createValidLimits();

  await assert.rejects(
    async () => {
      await defaultExecutor.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        argv: ['-q'],
        env: { UNPERMITTED_VAR: 'val' },
        limits,
      });
    },
    { message: /DISALLOWED_ENVIRONMENT_VARIABLE/ }
  );

  // With explicit host allowlist: cannot pass unlisted variable
  const allowlistedExecutor = new StructuredCommandExecutor({
    manager,
    controller,
    profile,
    allowedEnvKeys: ['APP_ENV'],
  });

  await assert.rejects(
    async () => {
      await allowlistedExecutor.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        argv: ['-q'],
        env: { APP_ENV: 'test', OTHER_UNLISTED_VAR: 'val' },
        limits,
      });
    },
    { message: /DISALLOWED_ENVIRONMENT_VARIABLE/ }
  );

  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch on unallowlisted env variables');
});

test('StructuredCommandExecutor: ZERO controller dispatch on loader and interpreter hooks (LD_PRELOAD, PYTHONSTARTUP, NODE_OPTIONS)', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-env-ldr-01', 'ws-env-ldr-01');

  // Even if host allowlist attempts or caller supplies loader hooks, zero dispatch
  const executor = new StructuredCommandExecutor({
    manager,
    controller,
    profile,
    allowedEnvKeys: ['SAFE_VAR'],
  });
  const limits = createValidLimits();

  const loaderHooks = [
    { LD_PRELOAD: '/workspace/scratch/fixture.so' },
    { LD_LIBRARY_PATH: '/workspace/scratch' },
    { LD_AUDIT: '/workspace/scratch/audit.so' },
    { DYLD_INSERT_LIBRARIES: '/workspace/scratch/lib.dylib' },
    { PYTHONSTARTUP: '/workspace/scratch/init.py' },
    { PYTHONHOME: '/workspace/scratch' },
    { PYTHONUSERBASE: '/workspace/scratch' },
    { NODE_OPTIONS: '--require /workspace/scratch/hook.js' },
  ];

  for (const badHook of loaderHooks) {
    await assert.rejects(
      async () => {
        await executor.execute({
          workspaceId: ws.workspaceId,
          executable: 'pytest',
          argv: ['-q'],
          env: badHook,
          limits,
        });
      },
      { message: /LOADER_HOOK_FORBIDDEN/ }
    );
  }

  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch across all loader and interpreter hook attempts');
});

test('StructuredCommandExecutor: ZERO controller dispatch on attempts to override immutable runtime environment (PYTHONPATH, PATH, HOME, TMPDIR)', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-env-imm-01', 'ws-env-imm-01');

  const executor = new StructuredCommandExecutor({
    manager,
    controller,
    profile,
    allowedEnvKeys: ['SAFE_VAR'],
  });
  const limits = createValidLimits();

  const immutableOverrides = [
    { PYTHONPATH: '/workspace/scratch' },
    { PATH: '/usr/local/bin:/workspace/scratch' },
    { HOME: '/workspace/scratch/alt' },
    { TMPDIR: '/workspace/repo' },
    { PYTHONDONTWRITEBYTECODE: '0' },
    { PYTHONUNBUFFERED: '0' },
  ];

  for (const badEnv of immutableOverrides) {
    await assert.rejects(
      async () => {
        await executor.execute({
          workspaceId: ws.workspaceId,
          executable: 'pytest',
          argv: ['-q'],
          env: badEnv,
          limits,
        });
      },
      { message: /IMMUTABLE_ENVIRONMENT_OVERRIDE_FORBIDDEN/ }
    );
  }

  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch across all immutable runtime environment override attempts');
});

test('StructuredCommandExecutor: snapshots and freezes host environment policy at construction seam; immune to caller mutation', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-env-mut-01', 'ws-env-mut-01');
  const limits = createValidLimits();

  controller.outputToReturn = {
    exitCode: 0,
    stdout: 'ok\n',
    stderr: '',
    durationMs: 40,
    timedOut: false,
  };

  // Host supplies mutable array and object
  const mutableKeys = ['APPROVED_A'];
  const mutablePolicy = { allowedKeys: mutableKeys };
  const executor = new StructuredCommandExecutor({
    manager,
    controller,
    profile,
    environmentPolicy: mutablePolicy,
  });

  // Caller later mutates host policy array and object
  mutableKeys.push('MUTATED_INTRUDER');
  mutableKeys.push('LD_PRELOAD');
  mutablePolicy.allowedKeys = ['COMPLETELY_MUTATED'];

  // Mutated key is rejected with zero dispatch
  await assert.rejects(
    async () => {
      await executor.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        argv: ['-q'],
        env: { MUTATED_INTRUDER: 'attack' },
        limits,
      });
    },
    { message: /DISALLOWED_ENVIRONMENT_VARIABLE/ }
  );

  // Original snapshotted approved variable dispatches cleanly
  const res = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    env: { APPROVED_A: 'safe' },
    limits,
  });
  assert.equal(res.outcome, 'success');
  assert.equal(controller.executedPlans.length, 1);
  assert.equal(controller.executedPlans[0]?.env['APPROVED_A'], 'safe');

  // Construction fails closed if host policy tries to allowlist loader hooks or immutable keys
  assert.throws(
    () => {
      new StructuredCommandExecutor({
        manager,
        controller,
        profile,
        allowedEnvKeys: ['LD_PRELOAD'],
      });
    },
    { message: /INVALID_ENVIRONMENT_POLICY/ }
  );

  assert.throws(
    () => {
      new StructuredCommandExecutor({
        manager,
        controller,
        profile,
        allowedEnvKeys: ['PYTHONPATH'],
      });
    },
    { message: /INVALID_ENVIRONMENT_POLICY/ }
  );
});

test('DockerWorkspaceManager: createCommandExecutor forwards host environment policy and retains zero dispatch on env violations', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-env-mgr-01', 'ws-env-mgr-01');
  const limits = createValidLimits();

  controller.outputToReturn = {
    exitCode: 0,
    stdout: 'ok\n',
    stderr: '',
    durationMs: 40,
    timedOut: false,
  };

  // createCommandExecutor with host environment policy
  const executor = manager.createCommandExecutor(profile, {
    environmentPolicy: { allowedKeys: ['HOST_APPROVED'] },
  });

  // Rejects unallowlisted variable with zero dispatch
  await assert.rejects(
    async () => {
      await executor.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        argv: ['-q'],
        env: { UNKNOWN_VAR: 'val' },
        limits,
      });
    },
    { message: /DISALLOWED_ENVIRONMENT_VARIABLE/ }
  );

  // Rejects loader hook with zero dispatch
  await assert.rejects(
    async () => {
      await executor.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        argv: ['-q'],
        env: { LD_PRELOAD: '/workspace/scratch/fixture.so' },
        limits,
      });
    },
    { message: /LOADER_HOOK_FORBIDDEN/ }
  );

  assert.equal(controller.executedPlans.length, 0, 'Zero dispatch across manager-created executor rejections');

  // Succeeds on approved variable
  const res = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    env: { HOST_APPROVED: 'val' },
    limits,
  });
  assert.equal(res.outcome, 'success');
  assert.equal(controller.executedPlans.length, 1);
  assert.equal(controller.executedPlans[0]?.env['HOST_APPROVED'], 'val');
});

test('StructuredCommandExecutor: protected HOME, PATH, PYTHONPATH, TMPDIR cannot be overridden regardless of external Set mutation; safe LANG allowed and host snapshot preserved', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(
    manager,
    controller,
    'task-env-extmut-01',
    'ws-env-extmut-01'
  );
  const limits = createValidLimits();

  controller.outputToReturn = {
    exitCode: 0,
    stdout: 'ok\n',
    stderr: '',
    durationMs: 35,
    timedOut: false,
  };

  // Malicious / external caller mutates exported IMMUTABLE_CONTAINER_ENV_KEYS Set
  const mutableExportedSet = IMMUTABLE_CONTAINER_ENV_KEYS as Set<string>;
  const protectedKeys = ['HOME', 'PATH', 'PYTHONPATH', 'TMPDIR'] as const;
  for (const key of protectedKeys) {
    mutableExportedSet.delete(key);
  }

  // 1. Construction fails closed if host policy tries to allowlist mutated keys
  for (const key of protectedKeys) {
    assert.throws(
      () => {
        new StructuredCommandExecutor({
          manager,
          controller,
          profile,
          allowedEnvKeys: [key],
        });
      },
      { message: /INVALID_ENVIRONMENT_POLICY/ }
    );
  }

  // 2. Host policy allows safe key LANG
  const allowedKeys = ['LANG'];
  const executor = new StructuredCommandExecutor({
    manager,
    controller,
    profile,
    allowedEnvKeys: allowedKeys,
  });

  // Mutating allowedKeys afterwards does not affect executor (host config snapshot preserved)
  allowedKeys.push('MUTATED_AFTER_VAR');

  // 3. Execution rejects attempts to override protected keys regardless of exported Set mutation
  const bypassAttempts = [
    { HOME: '/workspace/repo' },
    { PATH: '/bin:/usr/bin' },
    { PYTHONPATH: '/workspace/scratch' },
    { TMPDIR: '/workspace/repo' },
  ];

  for (const envOverride of bypassAttempts) {
    await assert.rejects(
      async () => {
        await executor.execute({
          workspaceId: ws.workspaceId,
          executable: 'pytest',
          argv: ['-q'],
          env: envOverride,
          limits,
        });
      },
      { message: /IMMUTABLE_ENVIRONMENT_OVERRIDE_FORBIDDEN/ }
    );
  }

  // Attempt to use key added to caller array after construction is rejected
  await assert.rejects(
    async () => {
      await executor.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        argv: ['-q'],
        env: { MUTATED_AFTER_VAR: 'forbidden' },
        limits,
      });
    },
    { message: /DISALLOWED_ENVIRONMENT_VARIABLE/ }
  );

  // Zero controller dispatch across all rejected attempts
  assert.equal(controller.executedPlans.length, 0);

  // 4. Safe variable LANG still allowed and dispatches cleanly
  const res = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    env: { LANG: 'C.UTF-8' },
    limits,
  });
  assert.equal(res.outcome, 'success');
  assert.equal(controller.executedPlans.length, 1);
  const executedEnv = controller.executedPlans[0]?.env;
  assert.ok(executedEnv);
  assert.equal(executedEnv['LANG'], 'C.UTF-8');
  assert.equal(executedEnv['HOME'], '/workspace/scratch');
  assert.equal(executedEnv['PATH'], '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
  assert.equal(executedEnv['PYTHONPATH'], '/workspace/repo');
  assert.equal(executedEnv['TMPDIR'], '/workspace/scratch');
});

/* ------------------------------------------------------------------
 * Combined UTF-8 Output Bounding, Concrete Emoji, Boundary & Runtime Validation Tests
 * ------------------------------------------------------------------ */

test('StructuredCommandExecutor: probe reproduction - maxOutputBytes 2 with 4-byte emojis on both streams returns 0 bytes and does not cut codepoints', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-emoji-01', 'ws-emoji-01');
  const executor = new StructuredCommandExecutor({ manager, controller, profile });
  const limits = createValidLimits({ maxOutputBytes: 2 });

  controller.outputToReturn = {
    exitCode: 0,
    stdout: '\ud83d\ude80\ud83d\ude80',
    stderr: '\ud83d\ude80\ud83d\ude80',
    durationMs: 10,
    timedOut: false,
  };

  const result = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits,
  });

  const stdoutBytes = Buffer.byteLength(result.stdout, 'utf8');
  const stderrBytes = Buffer.byteLength(result.stderr, 'utf8');

  assert.equal(stdoutBytes, 0, 'stdout must be 0 bytes since 4-byte emoji cannot fit within maxOutputBytes 2');
  assert.equal(stderrBytes, 0, 'stderr must be 0 bytes since 4-byte emoji cannot fit within remaining budget');
  assert.equal(stdoutBytes + stderrBytes, 0);
  assert.ok(stdoutBytes + stderrBytes <= 2, 'combined bytes must not exceed maxOutputBytes 2');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.truncated, true, 'output must be marked truncated');
  assert.equal(result.outcome, 'success');
  assert.equal(result.exitCode, 0);
});

test('StructuredCommandExecutor: concrete emoji bounding never cuts codepoints and respects combined budget', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-emoji-02', 'ws-emoji-02');
  const executor = new StructuredCommandExecutor({ manager, controller, profile });

  // maxOutputBytes 4 fits exactly one 4-byte emoji on stdout
  const limits4 = createValidLimits({ maxOutputBytes: 4 });
  controller.outputToReturn = {
    exitCode: 0,
    stdout: '🚀🚀',
    stderr: '',
    durationMs: 10,
    timedOut: false,
  };
  const res4 = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits: limits4,
  });
  assert.equal(res4.stdout, '🚀');
  assert.equal(Buffer.byteLength(res4.stdout, 'utf8'), 4);
  assert.equal(res4.truncated, true);

  // maxOutputBytes 5 with two emojis: still only one emoji fits (4 bytes), 5th byte cannot cut second emoji
  const limits5 = createValidLimits({ maxOutputBytes: 5 });
  const res5 = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits: limits5,
  });
  assert.equal(res5.stdout, '🚀');
  assert.equal(Buffer.byteLength(res5.stdout, 'utf8'), 4);
  assert.equal(res5.truncated, true);

  // maxOutputBytes 7 with two emojis: still only one emoji fits (4 bytes), cannot cut at 7
  const limits7 = createValidLimits({ maxOutputBytes: 7 });
  const res7 = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits: limits7,
  });
  assert.equal(res7.stdout, '🚀');
  assert.equal(Buffer.byteLength(res7.stdout, 'utf8'), 4);
  assert.equal(res7.truncated, true);

  // maxOutputBytes 8 with two emojis: exactly fits both emojis (8 bytes)
  const limits8 = createValidLimits({ maxOutputBytes: 8 });
  const res8 = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits: limits8,
  });
  assert.equal(res8.stdout, '🚀🚀');
  assert.equal(Buffer.byteLength(res8.stdout, 'utf8'), 8);
  assert.equal(res8.truncated, false);
});

test('StructuredCommandExecutor: both streams competing for combined budget share output fairly without exceeding maxOutputBytes', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-both-01', 'ws-both-01');
  const executor = new StructuredCommandExecutor({ manager, controller, profile });
  const limits = createValidLimits({ maxOutputBytes: 20 });

  controller.outputToReturn = {
    exitCode: 0,
    stdout: 'A'.repeat(500),
    stderr: 'E'.repeat(500),
    durationMs: 15,
    timedOut: false,
  };

  const result = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits,
  });

  const stdoutBytes = Buffer.byteLength(result.stdout, 'utf8');
  const stderrBytes = Buffer.byteLength(result.stderr, 'utf8');
  assert.equal(stdoutBytes, 10);
  assert.equal(stderrBytes, 10);
  assert.equal(stdoutBytes + stderrBytes, 20);
  assert.equal(result.stdout, 'A'.repeat(10));
  assert.equal(result.stderr, 'E'.repeat(10));
  assert.equal(result.truncated, true);
});

test('StructuredCommandExecutor: asymmetric streams allow unused budget spillover between stdout and stderr', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-asym-01', 'ws-asym-01');
  const executor = new StructuredCommandExecutor({ manager, controller, profile });
  const limits = createValidLimits({ maxOutputBytes: 20 });

  // 1. stdout small (5 bytes), stderr large (500 bytes)
  controller.outputToReturn = {
    exitCode: 0,
    stdout: 'A'.repeat(5),
    stderr: 'E'.repeat(500),
    durationMs: 15,
    timedOut: false,
  };

  const res1 = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits,
  });

  assert.equal(res1.stdout, 'A'.repeat(5));
  assert.equal(res1.stderr, 'E'.repeat(15));
  assert.equal(Buffer.byteLength(res1.stdout, 'utf8') + Buffer.byteLength(res1.stderr, 'utf8'), 20);
  assert.equal(res1.truncated, true);

  // 2. stdout large (500 bytes), stderr small (3 bytes)
  controller.outputToReturn = {
    exitCode: 0,
    stdout: 'A'.repeat(500),
    stderr: 'E'.repeat(3),
    durationMs: 15,
    timedOut: false,
  };

  const res2 = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits,
  });

  assert.equal(res2.stderr, 'E'.repeat(3));
  assert.equal(res2.stdout, 'A'.repeat(17));
  assert.equal(Buffer.byteLength(res2.stdout, 'utf8') + Buffer.byteLength(res2.stderr, 'utf8'), 20);
  assert.equal(res2.truncated, true);
});

test('StructuredCommandExecutor: single stream with output utilizes full combined budget when other stream is empty', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-single-01', 'ws-single-01');
  const executor = new StructuredCommandExecutor({ manager, controller, profile });
  const limits = createValidLimits({ maxOutputBytes: 30 });

  // stdout only
  controller.outputToReturn = {
    exitCode: 0,
    stdout: 'X'.repeat(100),
    stderr: '',
    durationMs: 12,
    timedOut: false,
  };

  const resOut = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits,
  });
  assert.equal(resOut.stdout, 'X'.repeat(30));
  assert.equal(resOut.stderr, '');
  assert.equal(Buffer.byteLength(resOut.stdout, 'utf8'), 30);
  assert.equal(resOut.truncated, true);

  // stderr only
  controller.outputToReturn = {
    exitCode: 0,
    stdout: '',
    stderr: 'Y'.repeat(100),
    durationMs: 12,
    timedOut: false,
  };

  const resErr = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits,
  });
  assert.equal(resErr.stdout, '');
  assert.equal(resErr.stderr, 'Y'.repeat(30));
  assert.equal(Buffer.byteLength(resErr.stderr, 'utf8'), 30);
  assert.equal(resErr.truncated, true);
});

test('StructuredCommandExecutor: exact boundary condition without truncation when combined bytes equal maxOutputBytes', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-bound-exact', 'ws-bound-exact');
  const executor = new StructuredCommandExecutor({ manager, controller, profile });
  const limits = createValidLimits({ maxOutputBytes: 10 });

  controller.outputToReturn = {
    exitCode: 0,
    stdout: '12345',
    stderr: '67890',
    durationMs: 20,
    timedOut: false,
  };

  const res = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits,
  });

  assert.equal(res.stdout, '12345');
  assert.equal(res.stderr, '67890');
  assert.equal(Buffer.byteLength(res.stdout, 'utf8') + Buffer.byteLength(res.stderr, 'utf8'), 10);
  assert.equal(res.truncated, false);
});

test('StructuredCommandExecutor: multi-byte UTF-8 character boundaries (2-byte, 3-byte, 4-byte) never split mid-codepoint', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-mb-01', 'ws-mb-01');
  const executor = new StructuredCommandExecutor({ manager, controller, profile });

  // 2-byte Latin/Greek: café (é is 2 bytes: 0xC3 0xA9)
  // caf = 3 bytes; budget 4 cannot fit 2-byte é (3 + 2 = 5 > 4)
  controller.outputToReturn = {
    exitCode: 0,
    stdout: 'café',
    stderr: '',
    durationMs: 10,
    timedOut: false,
  };
  const res2 = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits: createValidLimits({ maxOutputBytes: 4 }),
  });
  assert.equal(res2.stdout, 'caf');
  assert.equal(Buffer.byteLength(res2.stdout, 'utf8'), 3);
  assert.equal(res2.truncated, true);

  // 3-byte CJK: 中文 (中 is 3 bytes, 文 is 3 bytes)
  // budget 5: 中 (3 bytes) fits; 文 (needs 3, total 6 > 5) omitted
  controller.outputToReturn = {
    exitCode: 0,
    stdout: '中文',
    stderr: '',
    durationMs: 10,
    timedOut: false,
  };
  const res3 = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits: createValidLimits({ maxOutputBytes: 5 }),
  });
  assert.equal(res3.stdout, '中');
  assert.equal(Buffer.byteLength(res3.stdout, 'utf8'), 3);
  assert.equal(res3.truncated, true);

  // 4-byte Emoji: A🚀 (A is 1 byte, 🚀 is 4 bytes)
  // budget 3: A (1 byte) fits; 🚀 (needs 4, total 5 > 3) omitted
  controller.outputToReturn = {
    exitCode: 0,
    stdout: 'A🚀',
    stderr: '',
    durationMs: 10,
    timedOut: false,
  };
  const res4 = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits: createValidLimits({ maxOutputBytes: 3 }),
  });
  assert.equal(res4.stdout, 'A');
  assert.equal(Buffer.byteLength(res4.stdout, 'utf8'), 1);
  assert.equal(res4.truncated, true);
});

test('StructuredCommandExecutor: malformed injected controller output fails closed (shape, timedOut, durationMs, stdout/stderr, exitCode)', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-malf-01', 'ws-malf-01');
  const executor = new StructuredCommandExecutor({ manager, controller, profile });
  const limits = createValidLimits();

  const malformedOutputs = [
    { label: 'null rawOutput', raw: null },
    { label: 'undefined rawOutput', raw: undefined },
    { label: 'primitive string rawOutput', raw: 'not an object' },
    { label: 'primitive number rawOutput', raw: 42 },
    { label: 'array rawOutput', raw: [] },
    // timedOut non-boolean
    { label: 'missing timedOut', raw: { exitCode: 0, stdout: '', stderr: '', durationMs: 10 } },
    { label: 'string timedOut', raw: { exitCode: 0, stdout: '', stderr: '', durationMs: 10, timedOut: 'false' } },
    { label: 'null timedOut', raw: { exitCode: 0, stdout: '', stderr: '', durationMs: 10, timedOut: null } },
    { label: 'number timedOut', raw: { exitCode: 0, stdout: '', stderr: '', durationMs: 10, timedOut: 1 } },
    // durationMs malformed
    { label: 'missing durationMs', raw: { exitCode: 0, stdout: '', stderr: '', timedOut: false } },
    { label: 'NaN durationMs', raw: { exitCode: 0, stdout: '', stderr: '', durationMs: NaN, timedOut: false } },
    { label: 'Infinity durationMs', raw: { exitCode: 0, stdout: '', stderr: '', durationMs: Infinity, timedOut: false } },
    { label: '-Infinity durationMs', raw: { exitCode: 0, stdout: '', stderr: '', durationMs: -Infinity, timedOut: false } },
    { label: 'negative durationMs', raw: { exitCode: 0, stdout: '', stderr: '', durationMs: -5, timedOut: false } },
    { label: 'string durationMs', raw: { exitCode: 0, stdout: '', stderr: '', durationMs: '100', timedOut: false } },
    { label: 'null durationMs', raw: { exitCode: 0, stdout: '', stderr: '', durationMs: null, timedOut: false } },
    // stdout/stderr malformed
    { label: 'missing stdout', raw: { exitCode: 0, stderr: '', durationMs: 10, timedOut: false } },
    { label: 'missing stderr', raw: { exitCode: 0, stdout: '', durationMs: 10, timedOut: false } },
    { label: 'null stdout', raw: { exitCode: 0, stdout: null, stderr: '', durationMs: 10, timedOut: false } },
    { label: 'null stderr', raw: { exitCode: 0, stdout: '', stderr: null, durationMs: 10, timedOut: false } },
    { label: 'number stdout', raw: { exitCode: 0, stdout: 123, stderr: '', durationMs: 10, timedOut: false } },
    { label: 'object stderr', raw: { exitCode: 0, stdout: '', stderr: {}, durationMs: 10, timedOut: false } },
    // exitCode malformed
    { label: 'missing exitCode on non-timeout', raw: { stdout: '', stderr: '', durationMs: 10, timedOut: false } },
    { label: 'null exitCode on non-timeout', raw: { exitCode: null, stdout: '', stderr: '', durationMs: 10, timedOut: false } },
    { label: 'NaN exitCode', raw: { exitCode: NaN, stdout: '', stderr: '', durationMs: 10, timedOut: false } },
    { label: 'Infinity exitCode', raw: { exitCode: Infinity, stdout: '', stderr: '', durationMs: 10, timedOut: false } },
    { label: 'float exitCode', raw: { exitCode: 1.5, stdout: '', stderr: '', durationMs: 10, timedOut: false } },
    { label: 'string exitCode', raw: { exitCode: '0', stdout: '', stderr: '', durationMs: 10, timedOut: false } },
  ];

  for (const { label, raw } of malformedOutputs) {
    controller.hasRawOutputToReturn = true;
    controller.rawOutputToReturn = raw;
    await assert.rejects(
      async () => {
        await executor.execute({
          workspaceId: ws.workspaceId,
          executable: 'pytest',
          argv: ['-q'],
          limits,
        });
      },
      { message: /INVALID_CONTROLLER_OUTPUT/ },
      `Expected malformed output "${label}" to fail closed with INVALID_CONTROLLER_OUTPUT`
    );
  }
});

test('StructuredCommandExecutor: accepts null exitCode on timeout and preserves non-zero exitCode on failure', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-null-exit-01', 'ws-null-exit-01');
  const executor = new StructuredCommandExecutor({ manager, controller, profile });
  const limits = createValidLimits({ timeoutMs: 5000 });

  // 1. null exitCode on timeout is accepted
  controller.hasRawOutputToReturn = true;
  controller.rawOutputToReturn = {
    exitCode: null,
    stdout: 'running tests...\n',
    stderr: 'Killed by SIGKILL after timeout\n',
    durationMs: 5001,
    timedOut: true,
  };

  const resTimeout = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits,
  });

  assert.equal(resTimeout.outcome, 'timeout');
  assert.equal(resTimeout.timedOut, true);
  assert.equal(resTimeout.exitCode, null);
  assert.equal(resTimeout.stdout, 'running tests...\n');
  assert.equal(resTimeout.stderr, 'Killed by SIGKILL after timeout\n');

  // 2. non-zero exit code (e.g. 2, 127) preserved with failure outcome
  controller.hasRawOutputToReturn = true;
  controller.rawOutputToReturn = {
    exitCode: 2,
    stdout: '',
    stderr: 'command syntax error\n',
    durationMs: 50,
    timedOut: false,
  };

  const resFail = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits,
  });

  assert.equal(resFail.outcome, 'failure');
  assert.equal(resFail.timedOut, false);
  assert.equal(resFail.exitCode, 2);
  assert.equal(resFail.stderr, 'command syntax error\n');
});

test('StructuredCommandExecutor: cleanup hook on controller is invoked in finally block when execution rejects', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(manager, controller, 'task-cleanup-01', 'ws-cleanup-01');
  const executor = new StructuredCommandExecutor({ manager, controller, profile });
  const limits = createValidLimits();

  // Simulate controller executeContainer throwing an error
  controller.onExecute = () => {
    throw new Error('SIMULATED_DOCKER_CRASH: Container daemon disconnected');
  };

  assert.equal(controller.cleanedUp, false);
  assert.equal(controller.cleanupCalls, 0);

  await assert.rejects(
    async () => {
      await executor.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        argv: ['-q'],
        limits,
      });
    },
    { message: /SIMULATED_DOCKER_CRASH/ }
  );

  assert.equal(controller.cleanedUp, true, 'Controller cleanup must be called in finally block on rejection');
  assert.equal(controller.cleanupCalls, 1, 'Controller cleanup must be called exactly once');
});

test('StructuredCommandExecutor: controller result fields are snapshotted ONCE into detached locals, preventing getter TOCTOU mutation', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(
    manager,
    controller,
    'task-getter-toctou-01',
    'ws-getter-toctou-01'
  );
  const executor = new StructuredCommandExecutor({ manager, controller, profile });
  const limits = createValidLimits();

  // 1. timedOut getter changes return value on second read (probe reproduction)
  let timedOutReads = 0;
  controller.hasRawOutputToReturn = true;
  controller.rawOutputToReturn = {
    exitCode: 0,
    stdout: 'test output\n',
    stderr: '',
    durationMs: 10,
    get timedOut() {
      return ++timedOutReads === 1 ? false : ('forged' as unknown as boolean);
    },
  };

  const res1 = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits,
  });

  assert.equal(timedOutReads, 1, 'timedOut getter must be read exactly once during snapshotting');
  assert.equal(typeof res1.timedOut, 'boolean', 'timedOut must be a strict boolean');
  assert.equal(res1.timedOut, false, 'timedOut must retain the initial snapshotted boolean value');
  assert.equal(res1.outcome, 'success', 'outcome must be success, not corrupted to timeout by second getter read');

  // 2. All controller fields with getters: verify every field is snapshotted exactly ONCE
  let durationReads = 0;
  let stdoutReads = 0;
  let stderrReads = 0;
  let exitCodeReads = 0;
  let timedOutReads2 = 0;

  controller.hasRawOutputToReturn = true;
  controller.rawOutputToReturn = {
    get timedOut() {
      timedOutReads2++;
      return false;
    },
    get durationMs() {
      return ++durationReads === 1 ? 50 : (NaN as unknown as number);
    },
    get stdout() {
      return ++stdoutReads === 1 ? 'initial stdout' : (123 as unknown as string);
    },
    get stderr() {
      return ++stderrReads === 1 ? 'initial stderr' : (null as unknown as string);
    },
    get exitCode() {
      return ++exitCodeReads === 1 ? 0 : ('forged_code' as unknown as number);
    },
  };

  const res2 = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits,
  });

  assert.equal(timedOutReads2, 1, 'timedOut must be read exactly once');
  assert.equal(durationReads, 1, 'durationMs must be read exactly once');
  assert.equal(stdoutReads, 1, 'stdout must be read exactly once');
  assert.equal(stderrReads, 1, 'stderr must be read exactly once');
  assert.equal(exitCodeReads, 1, 'exitCode must be read exactly once');

  assert.equal(res2.timedOut, false);
  assert.equal(res2.durationMs, 50);
  assert.equal(res2.stdout, 'initial stdout');
  assert.equal(res2.stderr, 'initial stderr');
  assert.equal(res2.exitCode, 0);
  assert.equal(res2.outcome, 'success');

  // 3. Getter returning invalid type on first read fails closed
  controller.hasRawOutputToReturn = true;
  controller.rawOutputToReturn = {
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 10,
    get timedOut() {
      return 'invalid' as unknown as boolean;
    },
  };

  await assert.rejects(
    async () => {
      await executor.execute({
        workspaceId: ws.workspaceId,
        executable: 'pytest',
        argv: ['-q'],
        limits,
      });
    },
    { message: /INVALID_CONTROLLER_OUTPUT: Controller output timedOut must be a boolean/ }
  );
});

test('StructuredCommandExecutor & truncateUtf8: lone high and low surrogates canonicalized to well-formed Unicode and explicit truncation honest', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const { ws, profile } = await setupWorkspaceWithAdmittedView(
    manager,
    controller,
    'task-surrogate-01',
    'ws-surrogate-01'
  );
  const executor = new StructuredCommandExecutor({ manager, controller, profile });

  // 1. truncateUtf8 unit tests for lone high and low surrogates
  const loneHigh = String.fromCharCode(0xd800);
  const loneLow = String.fromCharCode(0xdc00);

  // Lone high surrogate fits in budget 10: normalized to '\uFFFD', 3 bytes, truncated false
  const tHigh = truncateUtf8(loneHigh, 10);
  assert.equal(tHigh.text.isWellFormed(), true, 'truncateUtf8 text must be well-formed');
  assert.equal(tHigh.text, '\uFFFD');
  assert.equal(tHigh.byteLength, 3);
  assert.equal(tHigh.truncated, false, 'explicit truncation must be false when surrogate replacement fits in budget');

  // Lone low surrogate fits in budget 10: normalized to '\uFFFD', 3 bytes, truncated false
  const tLow = truncateUtf8(loneLow, 10);
  assert.equal(tLow.text.isWellFormed(), true, 'truncateUtf8 text must be well-formed');
  assert.equal(tLow.text, '\uFFFD');
  assert.equal(tLow.byteLength, 3);
  assert.equal(tLow.truncated, false);

  // Lone high surrogate with trailing characters exceeding budget: honest truncation
  // '\uFFFDxx' is 3 + 2 = 5 bytes; budget 3 -> only '\uFFFD' fits (3 bytes), truncated true
  const tTrunc = truncateUtf8(loneHigh + 'xx', 3);
  assert.equal(tTrunc.text.isWellFormed(), true);
  assert.equal(tTrunc.text, '\uFFFD');
  assert.equal(tTrunc.byteLength, 3);
  assert.equal(tTrunc.truncated, true, 'explicit truncation must be true when trailing chars omitted');

  // Lone low surrogate surrounded by chars: 'x' + loneLow + 'y' -> 'x\uFFFDy' (5 bytes)
  const tMid = truncateUtf8('x' + loneLow + 'y', 10);
  assert.equal(tMid.text.isWellFormed(), true);
  assert.equal(tMid.text, 'x\uFFFDy');
  assert.equal(tMid.byteLength, 5);
  assert.equal(tMid.truncated, false);

  // Valid emoji pair preserved intact without surrogate replacement
  const tEmoji = truncateUtf8('\uD83D\uDE80', 4);
  assert.equal(tEmoji.text.isWellFormed(), true);
  assert.equal(tEmoji.text, '\uD83D\uDE80');
  assert.equal(tEmoji.byteLength, 4);
  assert.equal(tEmoji.truncated, false);

  // 2. StructuredCommandExecutor: raw stdout with lone high surrogate
  controller.hasRawOutputToReturn = true;
  controller.rawOutputToReturn = {
    exitCode: 0,
    stdout: loneHigh,
    stderr: '',
    durationMs: 10,
    timedOut: false,
  };

  const resHigh = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits: createValidLimits({ maxOutputBytes: 100 }),
  });

  assert.equal(resHigh.stdout.isWellFormed(), true, 'stdout must be well-formed Unicode');
  assert.equal(resHigh.stdout, '\uFFFD');
  assert.equal(Buffer.byteLength(resHigh.stdout, 'utf8'), 3);
  assert.equal(resHigh.truncated, false, 'truncated must be false when surrogate fits in combined budget');

  // 3. StructuredCommandExecutor: raw stderr with lone low surrogate
  controller.rawOutputToReturn = {
    exitCode: 0,
    stdout: '',
    stderr: loneLow,
    durationMs: 10,
    timedOut: false,
  };

  const resLow = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits: createValidLimits({ maxOutputBytes: 100 }),
  });

  assert.equal(resLow.stderr.isWellFormed(), true, 'stderr must be well-formed Unicode');
  assert.equal(resLow.stderr, '\uFFFD');
  assert.equal(Buffer.byteLength(resLow.stderr, 'utf8'), 3);
  assert.equal(resLow.truncated, false);

  // 4. StructuredCommandExecutor: lone surrogate with truncation under tight budget
  // stdout: loneHigh + 'abc' (3 + 3 = 6 bytes), budget 4 -> stdout gets '\uFFFD' (3 bytes), truncated true
  controller.rawOutputToReturn = {
    exitCode: 0,
    stdout: loneHigh + 'abc',
    stderr: '',
    durationMs: 10,
    timedOut: false,
  };

  const resTight = await executor.execute({
    workspaceId: ws.workspaceId,
    executable: 'pytest',
    argv: ['-q'],
    limits: createValidLimits({ maxOutputBytes: 4 }),
  });

  assert.equal(resTight.stdout.isWellFormed(), true);
  assert.equal(resTight.stdout, '\uFFFDa');
  assert.equal(Buffer.byteLength(resTight.stdout, 'utf8'), 4);
  assert.equal(resTight.truncated, true);
});
