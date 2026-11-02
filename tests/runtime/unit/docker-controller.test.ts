import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerLifecycleController, type StructuredSpawn, type StructuredSpawnOptions, type StructuredSpawnResult } from '../../../src/foundation/docker-controller.ts';
import { computeFileDigest, normalizeDockerExecutionOutput } from '../../../src/foundation/docker-workspace-policy.ts';
import type { CanonicalRepositorySnapshot, DockerContainerPlan, DockerProfile, MaterializeViewParams } from '../../../src/foundation/docker-workspace-types.ts';
import type { CommandView } from '../../../src/contracts/foundation/uc03.ts';

const IMAGE_DIGEST = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const REVISION = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const PLATFORM = 'linux/amd64';
const REPO_VOLUME = 'vol-repo-aaa';
const SCRATCH_VOLUME = 'vol-scratch-bbb';

const PROFILE: DockerProfile = {
  profileId: 'profile-uc03-t004',
  image: 'ghcr.io/pminhtaiii/slop-loop-runtime',
  imageDigest: IMAGE_DIGEST,
  user: '1000:1000',
  readOnlyRootFilesystem: true,
  network: 'none',
  limits: { timeoutMs: 60_000, maxMemoryBytes: 2_147_483_648, maxCpuCores: 2, maxPids: 256, maxOutputBytes: 1_048_576 },
  mounts: [
    { source: REPO_VOLUME, target: '/workspace/repo', readOnly: true },
    { source: SCRATCH_VOLUME, target: '/workspace/scratch', readOnly: false },
  ],
};

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: StructuredSpawnOptions;
}

function recorder(handler?: (call: SpawnCall, index: number) => Partial<StructuredSpawnResult> | undefined) {
  const calls: SpawnCall[] = [];
  const spawn: StructuredSpawn = async (command, args, options) => {
    const call: SpawnCall = { command, args: [...args], options: { ...options } };
    calls.push(call);
    const override = handler?.(call, calls.length - 1) ?? {};
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...override };
  };
  return { calls, spawn };
}

function makeController(spawn: StructuredSpawn, overrides: { platform?: string; resolveWorkspace?: (id: string) => { repoVolumeId: string; canonicalRevisionDigest: string } | undefined } = {}) {
  return new DockerLifecycleController({
    profile: PROFILE,
    platform: overrides.platform ?? PLATFORM,
    spawn,
    resolveWorkspace: overrides.resolveWorkspace ?? (id => (id === 'ws-1' ? { repoVolumeId: REPO_VOLUME, canonicalRevisionDigest: REVISION } : undefined)),
  });
}

function plan(overrides: Partial<DockerContainerPlan> = {}): DockerContainerPlan {
  return {
    image: PROFILE.image,
    imageDigest: IMAGE_DIGEST,
    user: PROFILE.user,
    readOnlyRootFilesystem: true,
    network: 'none',
    dropCapabilities: ['ALL'],
    noNewPrivileges: true,
    mounts: [
      { source: 'view-ws1', target: '/workspace/repo', readOnly: true },
      { source: SCRATCH_VOLUME, target: '/workspace/scratch', readOnly: false },
    ],
    executable: 'pytest',
    argv: ['-q', 'tests/test_add.py'],
    workingDirectory: '/workspace/repo',
    env: { PYTHONPATH: '/workspace/repo', TMPDIR: '/workspace/scratch' },
    limits: { timeoutMs: 30_000, maxOutputBytes: 4_096, maxCpuCores: 1, maxMemoryBytes: 536_870_912, maxPids: 64 },
    ...overrides,
  };
}

function view(overrides: Partial<CommandView> = {}): CommandView {
  return {
    viewId: 'view-ws1',
    viewDigest: `sha256:${'2'.repeat(64)}`,
    taskId: 'task-1',
    workspaceId: 'ws-1',
    canonicalRevisionDigest: REVISION,
    admittedFiles: [{ path: 'app.py', digest: computeFileDigest('print(1)\n') }],
    exclusionsPolicyVersion: '0.1.0',
    scratchIdentity: SCRATCH_VOLUME,
    mountedReadOnly: true,
    ...overrides,
  };
}

function materializeParams(overrides: Partial<MaterializeViewParams> = {}): MaterializeViewParams {
  return { view: view(), files: { 'app.py': 'print(1)\n' }, ...overrides };
}

test('provenance is real and the constructor rejects unpinned or unsafe profiles', () => {
  const controller = makeController(recorder().spawn);
  assert.equal(controller.provenance, 'real');
  assert.equal(controller.platformPin, PLATFORM);

  assert.throws(() => makeController(recorder().spawn, { platform: 'latest' }), /INVALID_PLATFORM/);
  assert.throws(
    () => new DockerLifecycleController({ profile: { ...PROFILE, user: 'root' } as DockerProfile, platform: PLATFORM, spawn: recorder().spawn, resolveWorkspace: () => undefined }),
    /INVALID_DOCKER_PROFILE/,
  );
});

test('execution uses the exact structured argv: pinned image@digest, isolation flags, limits and verbatim argv', async () => {
  const { calls, spawn } = recorder();
  const controller = makeController(spawn);

  const out = await controller.executeContainer(plan());
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.command, 'docker');

  const name = call.args[11];
  assert.ok(name?.startsWith('--name=ctr-'));

  assert.deepEqual(call.args, [
    'run',
    '--rm',
    '--network=none',
    '--read-only',
    '--user=1000:1000',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--platform=${PLATFORM}`,
    '--memory=536870912',
    '--cpus=1',
    '--pids-limit=64',
    name,
    '-w',
    '/workspace/repo',
    '-e',
    'PYTHONPATH=/workspace/repo',
    '-e',
    'TMPDIR=/workspace/scratch',
    '--mount=type=volume,source=view-ws1,target=/workspace/repo,readonly',
    '--mount=type=volume,source=vol-scratch-bbb,target=/workspace/scratch',
    `${PROFILE.image}@${IMAGE_DIGEST}`,
    'pytest',
    '-q',
    'tests/test_add.py',
  ]);

  // Never a joined shell string, and no element carries shell metacharacters.
  for (const arg of call.args) assert.doesNotMatch(arg, /[;&|><`$\r\n]/);
  assert.equal(call.options.timeoutMs, 30_000);
  assert.equal(call.options.maxOutputBytes, 4_096);

  assert.deepEqual(out, { exitCode: 0, stdout: '', stderr: '', durationMs: out.durationMs, timedOut: false });
  assert.ok(Number.isFinite(out.durationMs) && out.durationMs >= 0);
});

test('a plan whose image digest does not match the pinned profile is refused before spawn', async () => {
  const { calls, spawn } = recorder();
  const controller = makeController(spawn);

  await assert.rejects(controller.executeContainer(plan({ imageDigest: `sha256:${'f'.repeat(64)}` })), /IMAGE_DIGEST_MISMATCH/);
  await assert.rejects(controller.executeContainer(plan({ image: 'ghcr.io/attacker/image' })), /IMAGE_DIGEST_MISMATCH/);
  assert.equal(calls.length, 0);
});

test('a plan escaping the isolation, mount, executable, argv or env boundaries is refused before spawn', async () => {
  const { calls, spawn } = recorder();
  const controller = makeController(spawn);

  await assert.rejects(controller.executeContainer(plan({ network: 'bridge' as 'none' })), /ISOLATION_PROFILE_MISMATCH/);
  await assert.rejects(controller.executeContainer(plan({ mounts: [{ source: 'view-ws1', target: '/workspace/repo', readOnly: false }] })), /INVALID_MOUNTS/);
  await assert.rejects(
    controller.executeContainer(
      plan({
        mounts: [
          { source: 'view-ws1', target: '/workspace/repo', readOnly: true },
          { source: 'v', target: '/var/run/docker.sock', readOnly: false },
        ],
      }),
    ),
    /ARBITRARY_MOUNT_TARGET_FORBIDDEN/,
  );
  await assert.rejects(
    controller.executeContainer(
      plan({
        mounts: [
          { source: 'view-ws1', target: '/workspace/repo', readOnly: false },
          { source: SCRATCH_VOLUME, target: '/workspace/scratch', readOnly: false },
        ],
      }),
    ),
    /MOUNT_READONLY_MISMATCH/,
  );
  await assert.rejects(controller.executeContainer(plan({ executable: 'sh' })), /DISALLOWED_EXECUTABLE/);
  await assert.rejects(controller.executeContainer(plan({ argv: ['-q', '-c; rm -rf /'] })), /FORBIDDEN_SHELL_CHARACTERS/);
  await assert.rejects(controller.executeContainer(plan({ workingDirectory: '/etc' })), /INVALID_WORKING_DIRECTORY/);
  await assert.rejects(controller.executeContainer(plan({ env: { GITHUB_TOKEN: 'abc' } })), /FORBIDDEN_ENVIRONMENT_VARIABLE/);
  await assert.rejects(controller.executeContainer(plan({ env: { PYTHONPATH: 'sk-abcdefghijklmnopqrstuvwx' } })), /FORBIDDEN_ENVIRONMENT_VARIABLE/);
  await assert.rejects(controller.executeContainer(plan({ env: { DOCKER_HOST: 'unix:///var/run/docker.sock' } })), /FORBIDDEN_ENVIRONMENT_VARIABLE/);
  await assert.rejects(controller.executeContainer(plan({ limits: { ...plan().limits, maxMemoryBytes: PROFILE.limits.maxMemoryBytes + 1 } })), /RESOURCE_LIMIT_EXCEEDS_PROFILE_CEILING/);
  assert.equal(calls.length, 0);
});

test('volumes are created per workspace, are idempotent and report existence', async () => {
  const { calls, spawn } = recorder(call => (call.args[1] === 'inspect' && call.args[2] === 'vol-missing' ? { exitCode: 1 } : undefined));
  const controller = makeController(spawn);

  await controller.createVolume('vol-repo-aaa');
  await controller.createVolume('vol-scratch-bbb');
  await controller.createVolume('vol-repo-aaa');

  assert.deepEqual(
    calls.filter(call => call.args[1] === 'create').map(call => call.args[2]),
    ['vol-repo-aaa', 'vol-scratch-bbb'],
  );

  assert.equal(await controller.hasVolume('vol-repo-aaa'), true);
  assert.equal(await controller.hasVolume('vol-missing'), false);

  await controller.removeVolume('vol-scratch-bbb');
  assert.deepEqual(calls.at(-1)?.args, ['volume', 'rm', 'vol-scratch-bbb']);

  await assert.rejects(controller.createVolume('../escape'), /INVALID_VOLUME_ID/);
});

test('materializeView writes only admitted bytes into the view volume, which execution mounts read-only', async () => {
  const { calls, spawn } = recorder();
  const controller = makeController(spawn);

  await controller.materializeView(materializeParams());

  const create = calls.find(call => call.args[1] === 'create');
  assert.deepEqual(create?.args, ['volume', 'create', 'view-ws1']);

  const write = calls.find(call => call.args[0] === 'run');
  assert.ok(write);
  assert.equal(write.options.stdin, JSON.stringify({ files: [{ path: 'app.py', b64: Buffer.from('print(1)\n').toString('base64') }] }));
  assert.ok(write.args.includes('-i'));
  assert.ok(write.args.includes('--mount=type=volume,source=view-ws1,target=/workspace/repo'));
  assert.equal(
    write.args.some(arg => arg.includes('readonly')),
    false,
  );

  // Re-materializing the same view replaces the volume so no earlier file survives.
  const beforeRematerialize = calls.length;
  await controller.materializeView(materializeParams());
  assert.deepEqual(
    calls
      .slice(beforeRematerialize)
      .map(call => call.args.slice(0, 3))
      .filter(args => args[0] === 'volume'),
    [
      ['volume', 'inspect', 'view-ws1'],
      ['volume', 'rm', 'view-ws1'],
      ['volume', 'create', 'view-ws1'],
    ],
  );

  // Bytes the view never admitted cannot reach the volume.
  await assert.rejects(controller.materializeView(materializeParams({ files: { 'app.py': 'print(2)\n' } })), /UNADMITTED_VIEW_FILE/);
  // Supplying fewer or more files than the view admits is not the admitted set.
  await assert.rejects(controller.materializeView(materializeParams({ files: {} })), /EMPTY_MATERIALIZE_FILES/);
  await assert.rejects(
    controller.materializeView(
      materializeParams({
        view: view({
          admittedFiles: [
            { path: 'app.py', digest: computeFileDigest('print(1)\n') },
            { path: 'lib.py', digest: computeFileDigest('x\n') },
          ],
        }),
      }),
    ),
    /VIEW_FILE_SET_MISMATCH/,
  );
  await assert.rejects(controller.materializeView(materializeParams({ files: { 'app.py': 'print(1)\n', 'extra.py': 'import os\n' } })), /VIEW_FILE_SET_MISMATCH/);
  await assert.rejects(controller.materializeView(materializeParams({ view: view({ mountedReadOnly: false as true }) })), /COMMAND_VIEW_NOT_READONLY/);
  await assert.rejects(
    controller.materializeView(materializeParams({ files: { '.env': 'x' }, view: view({ admittedFiles: [{ path: '.env', digest: computeFileDigest('x') }] }) })),
    /UNSAFE_VIEW_PATH/,
  );

  // The execution mount for the same view is read-only; scratch is the only writable target.
  await controller.executeContainer(plan());
  const execution = calls.filter(call => call.args[0] === 'run').at(-1);
  assert.ok(execution?.args.includes('--mount=type=volume,source=view-ws1,target=/workspace/repo,readonly'));
  assert.ok(execution?.args.includes('--mount=type=volume,source=vol-scratch-bbb,target=/workspace/scratch'));
});

test('output is bounded by the plan byte ceiling and results are accepted by normalizeDockerExecutionOutput', async () => {
  const { spawn } = recorder(() => ({ stdout: 'o'.repeat(3_000), stderr: 'e'.repeat(3_000) }));
  const controller = makeController(spawn);
  const containerPlan = plan();

  const raw = await controller.executeContainer(containerPlan);
  // stdout takes its 3,000 bytes; stderr is cut to the remaining budget.
  assert.equal(raw.stdout, 'o'.repeat(3_000));
  assert.equal(raw.stderr, 'e'.repeat(containerPlan.limits.maxOutputBytes - 3_000));
  assert.equal(Buffer.byteLength(raw.stdout + raw.stderr, 'utf8'), containerPlan.limits.maxOutputBytes);

  const normalized = normalizeDockerExecutionOutput(raw, containerPlan.limits, containerPlan);
  assert.equal(normalized.outcome, 'success');
  assert.equal(normalized.stdout, raw.stdout);
  assert.equal(normalized.stderr, raw.stderr);
});

test('a timed-out execution reports timedOut with a null exit code and preserves its evidence through cleanup', async () => {
  const { calls, spawn } = recorder(call => (call.args.includes('pytest') ? { exitCode: null, timedOut: true } : undefined));
  const controller = makeController(spawn);

  await controller.materializeView(materializeParams());
  const containerPlan = plan();
  const raw = await controller.executeContainer(containerPlan);
  assert.deepEqual(raw, { exitCode: null, stdout: '', stderr: '', durationMs: raw.durationMs, timedOut: true });
  assert.equal(normalizeDockerExecutionOutput(raw, containerPlan.limits, containerPlan).outcome, 'timeout');
  assert.deepEqual(controller.getUncertainWorkspaces(), ['ws-1']);

  const beforeCleanup = calls.length;
  await controller.cleanup();
  const removed = calls.slice(beforeCleanup).map(call => call.args);
  assert.deepEqual(
    removed.filter(args => args[0] === 'rm' && args[1] === '-f' && args[2]?.startsWith('ctr-')),
    [],
    'uncertain execution container must be preserved',
  );
});

test('an uncertain run with no resolvable workspace preserves superseded volumes rather than guessing their scope', async () => {
  const { calls, spawn } = recorder(call => (call.args.includes('pytest') ? { exitCode: null, timedOut: true } : undefined));
  const controller = makeController(spawn);

  // Two views for the same workspace: the first volume becomes superseded.
  await controller.materializeView(materializeParams());
  await controller.materializeView(materializeParams({ view: view({ viewId: 'view-ws1-b' }) }));

  // Executing a plan whose repo and scratch mounts were both never materialized gives the run no owner.
  await controller.executeContainer(
    plan({
      mounts: [
        { source: 'view-unattributed', target: '/workspace/repo', readOnly: true },
        { source: 'vol-scratch-unattributed', target: '/workspace/scratch', readOnly: false },
      ],
    }),
  );
  assert.deepEqual(controller.getUncertainWorkspaces(), []);

  const before = calls.length;
  await controller.cleanup();
  const removed = calls
    .slice(before)
    .map(call => call.args)
    .filter(args => args[1] === 'rm' && args[0] === 'volume');
  assert.deepEqual(removed, [], 'unknown effect scope must not delete the superseded view volume');
});

test('a re-activated view volume is not removed as superseded while it is current', async () => {
  const { calls, spawn } = recorder();
  const controller = makeController(spawn);

  // A → B → A: materializing B supersedes A, materializing A again makes A current.
  await controller.materializeView(materializeParams());
  await controller.materializeView(materializeParams({ view: view({ viewId: 'view-ws1-b' }) }));
  await controller.materializeView(materializeParams());

  const before = calls.length;
  await controller.cleanup();
  const removedVolumes = calls
    .slice(before)
    .map(call => call.args)
    .filter(args => args[0] === 'volume' && args[1] === 'rm');
  assert.deepEqual(removedVolumes, [['volume', 'rm', 'view-ws1-b']], 'only the superseded view volume may be removed');
});

test('cleanup keeps a container or volume whose removal fails so the next cleanup retries', async () => {
  const { calls, spawn } = recorder(call => (call.args[1] === 'inspect' || call.args[0] === 'rm' || call.args[1] === 'rm' ? { exitCode: 1, stderr: 'remove failed' } : undefined));
  const controller = makeController(spawn);

  await controller.materializeView(materializeParams());
  await controller.materializeView(materializeParams({ view: view({ viewId: 'view-ws1-b' }) }));
  await controller.executeContainer(plan());

  await controller.cleanup();
  const firstCleanup = calls.length;
  const firstRemovals = calls.slice(-3).map(call => call.args);
  assert.ok(
    firstRemovals.some(args => args[0] === 'rm' && args[2]?.startsWith('ctr-')),
    'container removal was attempted',
  );
  assert.ok(
    firstRemovals.some(args => args[0] === 'volume' && args[1] === 'rm' && args[2] === 'view-ws1'),
    'volume removal was attempted',
  );

  // Record survived, so a second cleanup retries both removals.
  await controller.cleanup();
  const retried = calls.slice(firstCleanup).map(call => call.args);
  assert.ok(
    retried.some(args => args[0] === 'rm' && args[2]?.startsWith('ctr-')),
    'failed container removal is retried',
  );
  assert.ok(
    retried.some(args => args[0] === 'volume' && args[1] === 'rm' && args[2] === 'view-ws1'),
    'failed volume removal is retried',
  );
});

test('cleanup removes containers it created after a clean run and preserves uncertain ones', async () => {
  const { calls, spawn } = recorder();
  const controller = makeController(spawn);

  await controller.executeContainer(plan());
  const ctrName = calls[0]?.args[11]?.replace('--name=', '');
  assert.ok(ctrName);

  const before = calls.length;
  await controller.cleanup();
  const cleanupCalls = calls.slice(before).map(call => call.args);
  assert.deepEqual(cleanupCalls, [['rm', '-f', ctrName]]);
  assert.deepEqual(controller.getUncertainWorkspaces(), []);
});

test('getCanonicalSnapshot computes real byte digests and refuses missing or empty workspaces', async () => {
  const { calls, spawn } = recorder(call => {
    if (call.args[0] === 'run' && call.args.includes('python3')) {
      return {
        stdout: JSON.stringify({
          entries: [
            { path: 'b.py', content: Buffer.from('B\n').toString('base64') },
            { path: 'a.py', content: Buffer.from('A\n').toString('base64') },
          ],
        }),
      };
    }
    return undefined;
  });
  const controller = makeController(spawn);

  const snapshot: CanonicalRepositorySnapshot = await controller.getCanonicalSnapshot('ws-1');
  assert.equal(snapshot.canonicalRevisionDigest, REVISION);
  assert.deepEqual(
    snapshot.entries.map(entry => [entry.path, entry.digest]),
    [
      ['a.py', computeFileDigest('A\n')],
      ['b.py', computeFileDigest('B\n')],
    ],
  );
  assert.ok(calls[0]?.args.includes('--mount=type=volume,source=vol-repo-aaa,target=/workspace/repo,readonly'));

  await assert.rejects(controller.getCanonicalSnapshot('ws-missing'), /WORKSPACE_NOT_FOUND/);

  const emptySpawn = recorder(() => ({ stdout: JSON.stringify({ entries: [] }) })).spawn;
  await assert.rejects(makeController(emptySpawn).getCanonicalSnapshot('ws-1'), /EMPTY_CANONICAL_SNAPSHOT/);

  const badRevision = makeController(recorder().spawn, { resolveWorkspace: () => ({ repoVolumeId: REPO_VOLUME, canonicalRevisionDigest: 'latest' }) });
  await assert.rejects(badRevision.getCanonicalSnapshot('ws-1'), /INVALID_REVISION_DIGEST/);
});

// These unit checks exercise an injected fake spawn only; they do not replace the UC-03 T024 containment proof.
