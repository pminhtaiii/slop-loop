import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { structuredSpawn } from '../../../src/foundation/docker-spawn.ts';
import { DockerLifecycleController } from '../../../src/foundation/docker-controller.ts';
import { DockerWorkspaceManager } from '../../../src/foundation/docker-workspace-manager.ts';
import { computeFileDigest, computeWorkspaceVolumeIds, validateDockerProfile } from '../../../src/foundation/docker-workspace-policy.ts';
import type { ExecutionLimits } from '../../../src/contracts/foundation/uc03.ts';
import type { DockerProfile } from '../../../src/foundation/docker-workspace-types.ts';
import { isCanonicalRelativePath } from '../../../src/contracts/foundation/uc03.ts';

const PLATFORM = 'linux/amd64';
const TASK_ID = 'task-t024';
const WORKSPACE_ID = 'ws-t024';

const rawProfile = JSON.parse(readFileSync('docker/uc03/profile.json', 'utf8')) as unknown;
const profileRes = validateDockerProfile(rawProfile);
assert.ok(profileRes.ok, `docker/uc03/profile.json must validate: ${profileRes.ok ? '' : JSON.stringify(profileRes.errors)}`);
const PROFILE: DockerProfile = profileRes.value;

const MALICIOUS_TEST = `
import pathlib
import os
import pytest
import socket

REPO = pathlib.Path('/workspace/repo')
SCRATCH = pathlib.Path('/workspace/scratch')


def _write_expect_denied(target, marker):
    original = target.read_bytes()
    with pytest.raises(OSError):
        target.write_bytes(marker)
    assert target.read_bytes() == original


def test_cannot_write_source():
    _write_expect_denied(REPO / 'src' / 'calculator.py', b'PWNED')


def test_cannot_write_existing_tests():
    _write_expect_denied(REPO / 'tests' / 'test_calculator.py', b'PWNED')


def test_excluded_files_absent():
    for rel in ('.env', 'secrets/server.pem', 'src/leaky.py'):
        assert not (REPO / rel).exists(), rel


def test_scratch_is_writable():
    SCRATCH.joinpath('out.txt').write_text('scratch-ok')
    assert SCRATCH.joinpath('out.txt').read_text() == 'scratch-ok'


def test_no_docker_socket():
    assert not pathlib.Path('/var/run/docker.sock').exists()


def test_network_unreachable():
    sock = socket.socket()
    sock.settimeout(2)
    with pytest.raises(OSError):
        sock.connect(('1.1.1.1', 443))
    sock.close()


def test_runs_as_non_root_with_zero_capabilities():
    assert os.getuid() == 1000 and os.getgid() == 1000
    # CapEff all-zero means every capability was dropped.
    for line in open('/proc/self/status'):
        if line.startswith('CapEff:'):
            assert int(line.split()[1], 16) == 0, line
            break
    else:
        raise AssertionError('CapEff not reported')


def test_root_filesystem_is_read_only():
    with pytest.raises(OSError):
        pathlib.Path('/etc/pwned').write_text('x')
    assert not pathlib.Path('/etc/pwned').exists()
`.trim();

const CANONICAL: Record<string, string> = {
  'tests/test_malicious.py': MALICIOUS_TEST,
  'src/calculator.py': 'class Calculator:\n    def divide(self, a, b):\n        return a / b\n',
  'tests/test_calculator.py': 'from src.calculator import Calculator\n\n\ndef test_divide():\n    assert Calculator().divide(10, 2) == 5\n',
  '.env': 'API_TOKEN="ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n',
  'secrets/server.pem': '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
  'src/leaky.py': 'TOKEN = "sk-abcdefghijklmnopqrstuvwxyz012345"\n',
};

const LIMITS: ExecutionLimits = {
  timeoutMs: 60_000,
  maxMemoryBytes: 256 * 1024 * 1024,
  maxCpuCores: 1,
  maxPids: 64,
  maxOutputBytes: 256 * 1024,
};

function canonicalRevisionDigest(files: Record<string, string>): string {
  const lines = Object.keys(files)
    .sort()
    .map(path => `${path}\0${computeFileDigest(Buffer.from(files[path] ?? '', 'utf8'))}\n`);
  return `sha256:${createHash('sha256').update(lines.join('')).digest('hex')}`;
}

async function seedRepoVolume(volume: string, files: Record<string, string>): Promise<void> {
  const payload = JSON.stringify({ files: Object.entries(files).map(([path, content]) => ({ path, b64: Buffer.from(content, 'utf8').toString('base64') })) });
  const script = [
    'import base64,json,os,sys',
    "root='/workspace/repo'",
    'payload=json.load(sys.stdin)',
    "for item in payload['files']:",
    "  full=os.path.join(root,item['path'])",
    '  os.makedirs(os.path.dirname(full),exist_ok=True)',
    "  open(full,'wb').write(base64.b64decode(item['b64']))",
    'print(len(payload["files"]))',
  ].join('\n');
  const result = await structuredSpawn(
    'docker',
    [
      'run',
      '--rm',
      '--interactive',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      `--platform=${PLATFORM}`,
      `--user=${PROFILE.user}`,
      `--mount=type=volume,source=${volume},target=/workspace/repo`,
      `${PROFILE.image}@${PROFILE.imageDigest}`,
      'python3',
      '-c',
      script,
    ],
    { timeoutMs: 60_000, maxOutputBytes: 64 * 1024, stdin: payload },
  );
  assert.equal(result.exitCode, 0, `seed failed: ${result.stderr}`);
}

async function readVolume(volume: string, target = '/workspace/repo'): Promise<Record<string, string>> {
  const script = [
    'import base64,hashlib,json,os',
    `root='${target}'`,
    'out={}',
    'for base,_,files in os.walk(root):',
    '  for name in files:',
    '    full=os.path.join(base,name)',
    '    rel=os.path.relpath(full,root).replace(os.sep,"/")',
    '    out[rel]="sha256:"+hashlib.sha256(open(full,"rb").read()).hexdigest()',
    'print(json.dumps(out))',
  ].join('\n');
  const result = await structuredSpawn(
    'docker',
    [
      'run',
      '--rm',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      `--platform=${PLATFORM}`,
      `--user=${PROFILE.user}`,
      `--mount=type=volume,source=${volume},target=${target},readonly`,
      `${PROFILE.image}@${PROFILE.imageDigest}`,
      'python3',
      '-c',
      script,
    ],
    { timeoutMs: 60_000, maxOutputBytes: 256 * 1024 },
  );
  assert.equal(result.exitCode, 0, `read-back failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, string>;
}

async function main(): Promise<void> {
  const revision = canonicalRevisionDigest(CANONICAL);
  const { repoVolumeId, scratchVolumeId } = computeWorkspaceVolumeIds(TASK_ID, WORKSPACE_ID);

  const controller = new DockerLifecycleController({
    profile: PROFILE,
    platform: PLATFORM,
    spawn: structuredSpawn,
    resolveWorkspace: id => (id === WORKSPACE_ID ? { repoVolumeId, canonicalRevisionDigest: revision } : undefined),
  });
  const manager = new DockerWorkspaceManager({ controller });

  const evidence: Record<string, unknown> = {
    image: `${PROFILE.image}@${PROFILE.imageDigest}`,
    profile: PROFILE.profileId,
    platform: PLATFORM,
    canonicalRevisionDigest: revision,
    repoVolumeId,
    scratchVolumeId,
  };

  let viewVolumeId: string | undefined;
  try {
    await manager.createWorkspace({ taskId: TASK_ID, workspaceId: WORKSPACE_ID, initialRevisionDigest: revision, profile: PROFILE });
    await seedRepoVolume(repoVolumeId, CANONICAL);

    const view = await manager.admitCommandView({ workspaceId: WORKSPACE_ID, requiredFiles: ['src/calculator.py', 'tests/test_calculator.py'] });
    viewVolumeId = view.viewId;
    const admitted = view.admittedFiles.map(file => file.path).sort();
    evidence['admittedFiles'] = admitted;

    await assert.rejects(
      manager.admitCommandView({ workspaceId: WORKSPACE_ID, requiredFiles: ['src/leaky.py'] }),
      /REQUIRED_FILE_CONTAINS_PROTECTED_CONTENT/,
      'a required secret-bearing source must refuse before execution',
    );
    await assert.rejects(manager.admitCommandView({ workspaceId: WORKSPACE_ID, requiredFiles: ['.env'] }), /PROTECTED_PATH_FORBIDDEN/, 'a required protected path must refuse before execution');
    evidence['requiredSecretRefusals'] = ['REQUIRED_FILE_CONTAINS_PROTECTED_CONTENT', 'PROTECTED_PATH_FORBIDDEN'];

    for (const forbidden of ['.env', 'secrets/server.pem', 'src/leaky.py']) {
      assert.ok(!admitted.includes(forbidden), `${forbidden} must be excluded before view creation`);
    }
    const escapePaths = ['../../outside_marker.txt', '../escape.py', '/etc/shadow', '/root/.ssh/id_rsa', 'C:/Windows/win.ini', 'src/../../escape.py'];
    for (const escapePath of escapePaths) assert.equal(isCanonicalRelativePath(escapePath), false, `${escapePath} must not be a canonical relative path`);

    const escapeViewId = 'view-ws-t024-c07';
    await assert.rejects(
      controller.materializeView({
        view: { ...view, viewId: escapeViewId },
        files: {
          'src/calculator.py': CANONICAL['src/calculator.py'] ?? '',
          'tests/test_calculator.py': CANONICAL['tests/test_calculator.py'] ?? '',
          '../../outside_marker.txt': 'MALICIOUS_TRAVERSAL_PAYLOAD\n',
        },
      }),
      /UNSAFE_VIEW_PATH/,
      'a traversal path must not reach the view volume',
    );
    assert.equal(await controller.hasVolume(escapeViewId), false, 'a refused materialization must not create the view volume');
    evidence['traversalRefusal'] = { paths: escapePaths, viewVolumeCreated: false };

    const viewVolumeFiles = await readVolume(view.viewId);
    evidence['viewVolumeFiles'] = Object.keys(viewVolumeFiles).sort();
    for (const forbidden of ['.env', 'secrets/server.pem', 'src/leaky.py']) {
      assert.ok(!(forbidden in viewVolumeFiles), `${forbidden} must not be materialized into the view volume`);
    }
    for (const rel of ['src/calculator.py', 'tests/test_calculator.py']) {
      assert.equal(viewVolumeFiles[rel], computeFileDigest(Buffer.from(CANONICAL[rel] ?? '', 'utf8')), `${rel} must be byte-identical in the view`);
    }

    const executor = manager.createCommandExecutor(PROFILE);

    await assert.rejects(
      executor.execute({
        workspaceId: WORKSPACE_ID,
        executable: 'pytest',
        argv: ['-q', 'tests/test_calculator.py'],
        limits: { ...LIMITS, maxMemoryBytes: PROFILE.limits.maxMemoryBytes + 1 },
      }),
      /RESOURCE_LIMIT_EXCEEDS_PROFILE_CEILING/,
      'limits above the trusted ceiling must refuse before any container runs',
    );
    evidence['ceilingRefusal'] = 'RESOURCE_LIMIT_EXCEEDS_PROFILE_CEILING';

    const result = await executor.execute({
      workspaceId: WORKSPACE_ID,
      executable: 'pytest',
      argv: ['-q', 'tests/test_calculator.py', 'tests/test_malicious.py'],
      limits: LIMITS,
    });
    evidence['maliciousPytest'] = { exitCode: result.exitCode, stdout: result.stdout.slice(-2_000), stderr: result.stderr.slice(-2_000) };

    assert.equal(result.exitCode, 0, `malicious pytest must run and pass: ${result.stderr}`);

    for (const mount of result.plan.mounts) {
      assert.notEqual(mount.source, repoVolumeId, 'the canonical repository volume must never be mounted for execution');
    }
    evidence['executionMounts'] = result.plan.mounts;
    evidence['executionArgv'] = [result.plan.executable, ...result.plan.argv];

    const oom = await executor.execute({
      workspaceId: WORKSPACE_ID,
      executable: 'python3',
      argv: ['-c', 'x=bytearray(2*1024**3)'],
      limits: { ...LIMITS, maxMemoryBytes: 64 * 1024 * 1024 },
    });
    evidence['memoryBound'] = { exitCode: oom.exitCode, timedOut: oom.timedOut };
    assert.notEqual(oom.exitCode, 0, 'allocating 2 GiB under a 64 MiB ceiling must fail');

    const canonicalAfter = await readVolume(repoVolumeId);
    assert.deepEqual(
      canonicalAfter,
      Object.fromEntries(Object.entries(CANONICAL).map(([rel, content]) => [rel, computeFileDigest(Buffer.from(content, 'utf8'))])),
      'the canonical repository volume must be unchanged after execution',
    );
    const viewAfter = await readVolume(view.viewId);
    assert.deepEqual(viewAfter, viewVolumeFiles, 'the admitted view must be unchanged after execution');
    assert.ok(!('out.txt' in canonicalAfter), 'scratch output must not be promoted into canonical state');
    const scratchAfter = await readVolume(scratchVolumeId, '/workspace/scratch');
    evidence['scratchFiles'] = Object.keys(scratchAfter).sort();
    assert.deepEqual(Object.keys(scratchAfter), ['out.txt'], 'the scratch-only write must stay in the scratch volume');

    console.log(JSON.stringify({ ok: true, evidence }, null, 2));
  } finally {
    await controller.cleanup().catch(() => undefined);
    for (const volume of [repoVolumeId, scratchVolumeId, ...(viewVolumeId ? [viewVolumeId] : [])]) {
      await structuredSpawn('docker', ['volume', 'rm', '-f', volume], { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 });
    }
  }
}

await main();
