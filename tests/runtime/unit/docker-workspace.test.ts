import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type DockerProfile,
  type DockerMountConfig,
  type DockerResourceLimits,
  validateDockerProfile,
  FakeDockerLifecycleController,
  DockerWorkspaceManager,
  computeFileDigest,
  containsProtectedContent,
} from '../../../src/foundation/docker-workspace.ts';
import {
  validateCommandView,
  validateTaskWorkspace,
} from '../../../src/contracts/uc03.ts';

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

test('DockerWorkspaceManager: createWorkspace validates profile, allocates volumes, returns TaskWorkspace', async () => {
  const controller = new FakeDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const profile = createValidProfile();

  const workspace = await manager.createWorkspace({
    taskId: 'task-uc03-101',
    workspaceId: 'ws-uc03-101',
    initialRevisionDigest: 'sha256:initrev1234567890abcdef1234567890abcdef1234567890abcdef12345678',
    profile,
  });

  assert.equal(workspace.taskId, 'task-uc03-101');
  assert.equal(workspace.workspaceId, 'ws-uc03-101');
  assert.equal(workspace.containerImageDigest, profile.imageDigest);
  assert.equal(workspace.expectedRepoState, 'sha256:initrev1234567890abcdef1234567890abcdef1234567890abcdef12345678');
  assert.ok(workspace.repoVolumeId.includes('task-uc03-101'));
  assert.ok(workspace.scratchVolumeId.includes('task-uc03-101'));

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
    initialRevisionDigest: 'sha256:initrev1234567890abcdef1234567890abcdef1234567890abcdef12345678',
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

test('DockerWorkspaceManager: changed canonical revision invalidates active command views', async () => {
  const manager = new DockerWorkspaceManager();
  const profile = createValidProfile();

  const rev1 = 'sha256:rev111111111111111111111111111111111111111111111111111111111111';
  const rev2 = 'sha256:rev222222222222222222222222222222222222222222222222222222222222';

  const ws = await manager.createWorkspace({
    taskId: 'task-uc03-103',
    workspaceId: 'ws-uc03-103',
    initialRevisionDigest: rev1,
    profile,
  });

  const canonicalFiles = {
    'src/calculator.py': 'def add(a, b): return a + b\n',
    'tests/test_calculator.py': 'def test_add(): assert add(1, 2) == 3\n',
  };

  const view = await manager.admitCommandView({
    workspaceId: ws.workspaceId,
    canonicalRevisionDigest: rev1,
    canonicalFiles,
  });

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
        canonicalFiles,
      });
    },
    { message: /STALE_COMMAND_VIEW/ }
  );
});

test('DockerWorkspaceManager: command-view admission excludes protected paths and unrequired embedded secrets before copying', async () => {
  const manager = new DockerWorkspaceManager();
  const profile = createValidProfile();
  const rev = 'sha256:rev333333333333333333333333333333333333333333333333333333333333';

  const ws = await manager.createWorkspace({
    taskId: 'task-uc03-104',
    workspaceId: 'ws-uc03-104',
    initialRevisionDigest: rev,
    profile,
  });

  const canonicalFiles = {
    'src/calculator.py': 'def add(a, b): return a + b\n',
    'tests/test_calculator.py': 'def test_add(): assert add(1, 2) == 3\n',
    '.env': 'DATABASE_PASSWORD=secret123\n',
    'keys/id_rsa': '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n',
    '.git/config': '[core]\nrepositoryformatversion = 0\n',
    '.agents/skills/tdd/SKILL.md': '# TDD Skill\n',
    'config/unrequired_credentials.txt': 'api_key: MARKER_SECRET_UNREQUIRED_01\n',
  };

  const view = await manager.admitCommandView({
    workspaceId: ws.workspaceId,
    canonicalRevisionDigest: rev,
    canonicalFiles,
  });

  // Verify byte-identical admitted files
  assert.equal(view.admittedFiles.length, 2);
  const admittedPaths = view.admittedFiles.map((f) => f.path);
  assert.deepEqual(admittedPaths.sort(), ['src/calculator.py', 'tests/test_calculator.py']);
  assert.equal(
    view.admittedFiles.find((f) => f.path === 'src/calculator.py')?.digest,
    computeFileDigest(canonicalFiles['src/calculator.py'])
  );
  assert.equal(
    view.admittedFiles.find((f) => f.path === 'tests/test_calculator.py')?.digest,
    computeFileDigest(canonicalFiles['tests/test_calculator.py'])
  );

  // Invariants: mountedReadOnly true, scratchIdentity matches scratch volume
  assert.equal(view.mountedReadOnly, true);
  assert.equal(view.scratchIdentity, ws.scratchVolumeId);

  // Passes canonical validateCommandView
  const valid = validateCommandView(view);
  assert.equal(valid.ok, true);
});

test('DockerWorkspaceManager: rejects admission when required file is a protected path (no silent redaction)', async () => {
  const manager = new DockerWorkspaceManager();
  const profile = createValidProfile();
  const rev = 'sha256:rev444444444444444444444444444444444444444444444444444444444444';

  const ws = await manager.createWorkspace({
    taskId: 'task-uc03-105',
    workspaceId: 'ws-uc03-105',
    initialRevisionDigest: rev,
    profile,
  });

  const canonicalFiles = {
    'src/calculator.py': 'def add(a, b): return a + b\n',
    '.env': 'SECRET=true\n',
  };

  await assert.rejects(
    async () => {
      await manager.admitCommandView({
        workspaceId: ws.workspaceId,
        canonicalRevisionDigest: rev,
        canonicalFiles,
        requiredFiles: ['.env', 'src/calculator.py'],
      });
    },
    { message: /PROTECTED_PATH_FORBIDDEN/ }
  );
});

test('DockerWorkspaceManager: rejects admission when required file contains embedded secret (no silent redaction)', async () => {
  const manager = new DockerWorkspaceManager();
  const profile = createValidProfile();
  const rev = 'sha256:rev555555555555555555555555555555555555555555555555555555555555';

  const ws = await manager.createWorkspace({
    taskId: 'task-uc03-106',
    workspaceId: 'ws-uc03-106',
    initialRevisionDigest: rev,
    profile,
  });

  const canonicalFiles = {
    'src/auth.py': 'TOKEN = "MARKER_SECRET_REQUIRED_TOKEN_99"\ndef login(): pass\n',
  };

  await assert.rejects(
    async () => {
      await manager.admitCommandView({
        workspaceId: ws.workspaceId,
        canonicalRevisionDigest: rev,
        canonicalFiles,
        requiredFiles: ['src/auth.py'],
      });
    },
    { message: /REQUIRED_FILE_CONTAINS_PROTECTED_CONTENT/ }
  );
});

test('DockerWorkspaceManager: rejects escaping paths in canonicalFiles', async () => {
  const manager = new DockerWorkspaceManager();
  const profile = createValidProfile();
  const rev = 'sha256:rev666666666666666666666666666666666666666666666666666666666666';

  const ws = await manager.createWorkspace({
    taskId: 'task-uc03-107',
    workspaceId: 'ws-uc03-107',
    initialRevisionDigest: rev,
    profile,
  });

  const canonicalFiles = {
    '../escaping.py': 'x = 1\n',
  };

  await assert.rejects(
    async () => {
      await manager.admitCommandView({
        workspaceId: ws.workspaceId,
        canonicalRevisionDigest: rev,
        canonicalFiles,
      });
    },
    { message: /WORKSPACE_ESCAPE/ }
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
