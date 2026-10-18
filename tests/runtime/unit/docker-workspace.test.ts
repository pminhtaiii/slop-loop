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
} from '../../../src/foundation/docker-workspace.ts';
import {
  type CommandView,
  validateCommandView,
  validateTaskWorkspace,
} from '../../../src/contracts/uc03.ts';

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
    provenance: 'mock',
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
