/**
 * T051 — UC-03 T024 real containment probe (real-tier contract §(f) T024 row; UC-03 T024).
 *
 * Runs C06–C11 in disposable containers through the production assembly: the operator profile, the
 * Docker lifecycle controller, the command-view builder and the structured executor all come from
 * `createHostAssembly()`. Nothing here is mocked: no operator profile, credential, image or daemon
 * means `not-run` with a nonzero exit, never a pass.
 *
 * Not a `*.test.ts` file on purpose: the CI globs never run it, so no CI lane needs Docker.
 *
 * Exit codes: 0 pass, 1 fail, 3 not-run. Output is one JSON record on stdout (and `--out <path>`),
 * carrying the image ID, the pinned base, the platform, the delivery revision, argv, exit codes and
 * each sentinel result. The endpoint URL never appears: only its digest, from `metadata`.
 *
 * `--self-check` scores a deliberately failed row through the same reporting path and exits 1, which
 * is how the red path is demonstrated without a profile.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { computeFileDigest, computeWorkspaceVolumeIds, validateDockerProfile } from '../../../src/foundation/docker-workspace-policy.ts';
import { structuredSpawn } from '../../../src/foundation/docker-spawn.ts';
import { isSupportedSnapshotPlatform } from '../../../src/runtime/trusted-host-snapshot.ts';
import { createHostAssembly, type RealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import type { ExecutionLimits } from '../../../src/contracts/foundation/uc03.ts';
import { isCanonicalRelativePath } from '../../../src/contracts/foundation/uc03.ts';

const TASK_ID = 'task-t024';
const WORKSPACE_ID = 'ws-t024';

interface Row {
  readonly case: string;
  readonly ok: boolean;
  readonly detail?: unknown;
}

const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const outPath = outIndex >= 0 ? argv[outIndex + 1] : undefined;
const selfCheck = argv.includes('--self-check');

function emit(status: 'pass' | 'fail' | 'not-run', payload: Record<string, unknown>): void {
  const text = JSON.stringify({ task: 'T051', status, ...payload }, null, 2);
  if (outPath !== undefined && outPath !== '') {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${text}\n`, 'utf8');
  }
  console.log(text);
}

/** One scorer for real rows and the self-check row: a failed row is a fail with exit 1. */
function report(rows: readonly Row[], evidence: Record<string, unknown>): void {
  const failed = rows.filter(row => !row.ok).map(row => row.case);
  if (failed.length === 0) {
    emit('pass', { rows, failed, ...evidence });
    process.exit(0);
  }
  emit('fail', { rows, failed, ...evidence });
  process.exit(1);
}

function row(caseName: string, ok: boolean, detail?: unknown): Row {
  return { case: caseName, ok, detail };
}

/** Runs one assertion as a row; the refusal text is the row detail, never a stack or a payload. */
async function refusalRow(caseName: string, pattern: RegExp, operation: () => Promise<unknown>): Promise<Row> {
  try {
    await operation();
    return row(caseName, false, 'operation was admitted');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return row(caseName, pattern.test(message), message.slice(0, 300));
  }
}

if (selfCheck) {
  // The same `report` path a real failed row takes: this must exit nonzero, which is the red proof.
  report([row('SELF-CHECK deliberate red row', false, 'a failed row must never pass')], { selfCheck: true });
}

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
        sock.connect(('192.0.2.1', 443))
    sock.close()

def test_runs_as_non_root_with_zero_capabilities():
    assert os.getuid() == 1000 and os.getgid() == 1000
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

const CANONICAL: Readonly<Record<string, string>> = {
  'tests/test_malicious.py': MALICIOUS_TEST,
  'src/calculator.py': 'class Calculator:\n    def divide(self, a, b):\n        return a / b\n',
  'tests/test_calculator.py': 'from src.calculator import Calculator\n\n\ndef test_divide():\n    assert Calculator().divide(10, 2) == 5\n',
  '.env': 'API_TOKEN="ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n',
  'secrets/server.pem': '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
  'src/leaky.py': 'TOKEN = "sk-abcdefghijklmnopqrstuvwxyz012345"\n',
};

const FORBIDDEN_IN_VIEW = ['.env', 'secrets/server.pem', 'src/leaky.py'] as const;

function canonicalRevisionDigest(files: Readonly<Record<string, string>>): string {
  const lines = Object.keys(files)
    .sort()
    .map(path => `${path}\0${computeFileDigest(Buffer.from(files[path] ?? '', 'utf8'))}\n`);
  return `sha256:${createHash('sha256').update(lines.join('')).digest('hex')}`;
}

function imageReference(assembly: RealTierAssembly): string {
  return assembly.metadata.imageId;
}

/** Fixture plumbing only: seed and read the canonical volume the production controller created. */
async function runHelper(assembly: RealTierAssembly, tail: readonly string[], mountTail: readonly string[], stdin?: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const profile = assembly.profile;
  const result = await structuredSpawn(
    'docker',
    [
      'run',
      '--rm',
      ...(stdin === undefined ? [] : ['--interactive']),
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      `--platform=${profile.image.platform}`,
      `--user=${profile.image.user}`,
      ...mountTail,
      imageReference(assembly),
      ...tail,
    ],
    { timeoutMs: 60_000, maxOutputBytes: 256 * 1024, ...(stdin === undefined ? {} : { stdin }) },
  );
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

async function seedRepoVolume(assembly: RealTierAssembly, volume: string): Promise<void> {
  const payload = JSON.stringify({ files: Object.entries(CANONICAL).map(([path, content]) => ({ path, b64: Buffer.from(content, 'utf8').toString('base64') })) });
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
  const result = await runHelper(assembly, ['python3', '-c', script], [`--mount=type=volume,source=${volume},target=/workspace/repo`], payload);
  assert.equal(result.exitCode, 0, `seed failed: ${result.stderr.slice(0, 200)}`);
}

async function readVolume(assembly: RealTierAssembly, volume: string, target = '/workspace/repo'): Promise<Record<string, string>> {
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
  const result = await runHelper(assembly, ['python3', '-c', script], [`--mount=type=volume,source=${volume},target=${target},readonly`]);
  assert.equal(result.exitCode, 0, `read-back failed: ${result.stderr.slice(0, 200)}`);
  return JSON.parse(result.stdout) as Record<string, string>;
}

interface ProbeOutcome {
  readonly rows: readonly Row[];
  readonly evidence: Record<string, unknown>;
}

async function runContainment(assembly: RealTierAssembly): Promise<ProbeOutcome> {
  // The pinned Docker profile the production controller and executor validate.
  const profile = assembly.profile;
  const dockerProfile = validateDockerProfile({
    profileId: profile.image.label,
    image: profile.image.base,
    imageDigest: profile.image.imageId,
    user: profile.image.user,
    readOnlyRootFilesystem: true,
    network: 'none',
    limits: {
      timeoutMs: profile.limits.commandTimeoutMs,
      maxMemoryBytes: profile.limits.memoryBytes,
      maxCpuCores: profile.limits.cpus,
      maxPids: profile.limits.processes,
      maxOutputBytes: profile.limits.outputBytes,
    },
    mounts: [],
  });
  assert.ok(dockerProfile.ok, 'the operator profile must yield a valid Docker profile');
  const trusted = dockerProfile.value;

  const revision = canonicalRevisionDigest(CANONICAL);
  const { repoVolumeId, scratchVolumeId } = computeWorkspaceVolumeIds(TASK_ID, WORKSPACE_ID);
  const rows: Row[] = [];
  const evidence: Record<string, unknown> = {
    imageId: profile.image.imageId,
    imageBase: profile.image.base,
    platform: profile.image.platform,
    deliveryRevision: assembly.revision,
    profileDigest: assembly.metadata.profileDigest,
    endpointDigest: assembly.metadata.endpointDigest,
    endpointScheme: assembly.metadata.endpointScheme,
    model: assembly.metadata.model,
    canonicalRevisionDigest: revision,
    repoVolumeId,
    scratchVolumeId,
    hostileTest: 'tests/test_malicious.py',
  };

  const manager = assembly.workspaceManager;
  const controller = assembly.controller;
  const executor = assembly.executor;
  let viewVolumeId: string | undefined;

  try {
    await manager.createWorkspace({ taskId: TASK_ID, workspaceId: WORKSPACE_ID, initialRevisionDigest: revision, profile: trusted });
    await seedRepoVolume(assembly, repoVolumeId);

    const view = await manager.admitCommandView({ workspaceId: WORKSPACE_ID, requiredFiles: ['src/calculator.py', 'tests/test_calculator.py'] });
    viewVolumeId = view.viewId;
    evidence['viewId'] = view.viewId;
    evidence['viewDigest'] = view.viewDigest;
    evidence['admittedFiles'] = view.admittedFiles.map(file => file.path);
    rows.push(row('C06 view mounts the canonical view read-only with a separate writable scratch', view.mountedReadOnly === true && view.scratchIdentity === scratchVolumeId));

    // §9 issuance: the same measurement built through the owner-bound entry point must be accepted.
    const measured = await manager.admitMeasuredCommandView({
      workspaceId: WORKSPACE_ID,
      requiredFiles: ['src/calculator.py', 'tests/test_calculator.py'],
      trustedIsolationProfileRef: profile.image.label,
      ownerView: {
        canonicalRevision: view.canonicalRevisionDigest,
        exclusionsPolicyVersion: view.exclusionsPolicyVersion,
        scratchIdentity: view.scratchIdentity,
        admittedFiles: view.admittedFiles,
        mountedReadOnly: true,
        isolationProfileRef: profile.image.label,
      },
    });
    rows.push(row('T025 §9 owner-bound view build issues a measured isolation record', measured.measured !== undefined && measured.measured.viewId === measured.view.viewId));

    rows.push(
      await refusalRow('C08 required secret-bearing source refuses before execution', /REQUIRED_FILE_CONTAINS_PROTECTED_CONTENT/u, () =>
        manager.admitCommandView({ workspaceId: WORKSPACE_ID, requiredFiles: ['src/leaky.py'] }),
      ),
    );
    rows.push(
      await refusalRow('C07 required protected path refuses before execution', /PROTECTED_PATH_FORBIDDEN/u, () => manager.admitCommandView({ workspaceId: WORKSPACE_ID, requiredFiles: ['.env'] })),
    );
    for (const forbidden of FORBIDDEN_IN_VIEW) assert.ok(!view.admittedFiles.some(file => file.path === forbidden), `${forbidden} must be excluded before view creation`);

    const escapePaths = ['../../outside_marker.txt', '../escape.py', '/etc/shadow', '/root/.ssh/id_rsa', 'C:/Windows/win.ini', 'src/../../escape.py'];
    for (const escapePath of escapePaths) assert.equal(isCanonicalRelativePath(escapePath), false, `${escapePath} must not be a canonical relative path`);
    const escapeViewId = 'view-ws-t024-c07';
    // The file-set size must match the view, so the traversal path replaces one admitted entry:
    // otherwise VIEW_FILE_SET_MISMATCH would decide the row and UNSAFE_VIEW_PATH would go unproven.
    const [, ...restAdmitted] = view.admittedFiles;
    const traversal = await refusalRow('C07 traversal path refuses before the view volume is created', /UNSAFE_VIEW_PATH/u, () =>
      controller.materializeView({
        view: { ...view, viewId: escapeViewId },
        files: { ...permittedViewFiles(restAdmitted), '../../outside_marker.txt': 'MALICIOUS_TRAVERSAL_PAYLOAD\n' },
      }),
    );
    rows.push(row(traversal.case, traversal.ok && !(await controller.hasVolume(escapeViewId)), traversal.detail));

    const viewVolumeFiles = await readVolume(assembly, view.viewId);
    evidence['viewVolumeFiles'] = Object.keys(viewVolumeFiles).sort();
    const forbiddenAbsent = FORBIDDEN_IN_VIEW.every(forbidden => !(forbidden in viewVolumeFiles));
    const bytesMatch = view.admittedFiles.every(file => viewVolumeFiles[file.path] === computeFileDigest(Buffer.from(CANONICAL[file.path] ?? '', 'utf8')));
    rows.push(row('C08 forbidden content never enters the view volume', forbiddenAbsent));
    rows.push(row('C08 permitted source bytes match the canonical digests', bytesMatch));

    const limits: ExecutionLimits = {
      timeoutMs: Math.min(profile.limits.commandTimeoutMs, 60_000),
      maxMemoryBytes: Math.min(profile.limits.memoryBytes, 256 * 1024 * 1024),
      maxCpuCores: 1,
      maxPids: Math.min(profile.limits.processes, 64),
      maxOutputBytes: Math.min(profile.limits.outputBytes, 256 * 1024),
    };

    rows.push(
      await refusalRow('C09 shell metacharacters refuse before dispatch', /FORBIDDEN_SHELL_CHARACTERS/u, () =>
        executor.execute({ workspaceId: WORKSPACE_ID, executable: 'pytest', argv: ['-q', 'tests/test_calculator.py; id'], limits }),
      ),
    );
    rows.push(
      await refusalRow('C09 disallowed executable refuses before dispatch', /DISALLOWED_EXECUTABLE/u, () =>
        executor.execute({ workspaceId: WORKSPACE_ID, executable: 'sh', argv: ['-c', 'id'], limits }),
      ),
    );
    rows.push(
      await refusalRow('C07 working directory outside the workspace refuses before dispatch', /INVALID_WORKING_DIRECTORY/u, () =>
        executor.execute({ workspaceId: WORKSPACE_ID, executable: 'pytest', argv: ['-q'], workingDirectory: '/etc', limits }),
      ),
    );
    rows.push(
      await refusalRow('C10 limits above the profile ceiling refuse before any container runs', /RESOURCE_LIMIT_EXCEEDS_PROFILE_CEILING/u, () =>
        executor.execute({ workspaceId: WORKSPACE_ID, executable: 'pytest', argv: ['-q'], limits: { ...limits, maxMemoryBytes: profile.limits.memoryBytes + 1 } }),
      ),
    );

    const hostile = await executor.execute({ workspaceId: WORKSPACE_ID, executable: 'pytest', argv: ['-q', 'tests/test_calculator.py', 'tests/test_malicious.py'], limits });
    evidence['hostileRun'] = { argv: ['pytest', '-q', 'tests/test_calculator.py', 'tests/test_malicious.py'], exitCode: hostile.exitCode, sample: hostile.stdout.slice(-1_500) };
    rows.push(row('C06–C09/C11 hostile pytest passes inside the container', hostile.exitCode === 0, hostile.stderr.slice(-500)));
    rows.push(row('C11 no shell parses the execution argv', hostile.plan.executable === 'pytest' && hostile.plan.argv.every(argument => !/[;&|><`$\r\n]/u.test(argument)), hostile.plan.argv));
    rows.push(
      row(
        'C11 the canonical repository volume is never mounted for execution',
        hostile.plan.mounts.every(mount => mount.source !== repoVolumeId),
        hostile.plan.mounts,
      ),
    );

    const oom = await executor.execute({ workspaceId: WORKSPACE_ID, executable: 'python3', argv: ['-c', 'x=bytearray(2*1024**3)'], limits: { ...limits, maxMemoryBytes: 64 * 1024 * 1024 } });
    evidence['memoryBound'] = { exitCode: oom.exitCode, timedOut: oom.timedOut };
    rows.push(row('C10 memory over the admitted ceiling is killed', oom.exitCode !== 0 || oom.timedOut, evidence['memoryBound']));

    const timeout = await executor.execute({ workspaceId: WORKSPACE_ID, executable: 'python3', argv: ['-c', 'import time; time.sleep(30)'], limits: { ...limits, timeoutMs: 2_000 } });
    evidence['timeoutBound'] = { exitCode: timeout.exitCode, timedOut: timeout.timedOut };
    rows.push(row('C10 a command past its admitted timeout is killed', timeout.timedOut || timeout.exitCode !== 0, evidence['timeoutBound']));

    const canonicalAfter = await readVolume(assembly, repoVolumeId);
    const expectedCanonical = Object.fromEntries(Object.entries(CANONICAL).map(([path, content]) => [path, computeFileDigest(Buffer.from(content, 'utf8'))]));
    rows.push(row('C06 execution cannot mutate the canonical repository volume', JSON.stringify(canonicalAfter) === JSON.stringify(expectedCanonical)));
    const viewAfter = await readVolume(assembly, view.viewId);
    rows.push(row('C06 execution cannot mutate the admitted view', JSON.stringify(viewAfter) === JSON.stringify(viewVolumeFiles)));
    const scratchAfter = await readVolume(assembly, scratchVolumeId, '/workspace/scratch');
    evidence['scratchFiles'] = Object.keys(scratchAfter).sort();
    rows.push(row('C06 scratch output stays in the scratch volume', Object.keys(scratchAfter).join(',') === 'out.txt' && !('out.txt' in canonicalAfter)));

    // C11 fresh-task state separation: invalidating the view removes execution authority.
    manager.invalidateViews(WORKSPACE_ID);
    rows.push(
      await refusalRow('C11 a workspace with no active view cannot execute', /COMMAND_VIEW_REQUIRED/u, () =>
        executor.execute({ workspaceId: WORKSPACE_ID, executable: 'pytest', argv: ['-q'], limits }),
      ),
    );
  } finally {
    await controller.cleanup().catch(() => undefined);
    for (const volume of [repoVolumeId, scratchVolumeId, ...(viewVolumeId === undefined ? [] : [viewVolumeId])]) {
      await structuredSpawn('docker', ['volume', 'rm', '-f', volume], { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 });
    }
  }
  return { rows, evidence };
}

/** The admitted bytes, as the materializer requires them. */
function permittedViewFiles(admitted: readonly { readonly path: string }[]): Record<string, string> {
  return Object.fromEntries(admitted.map(file => [file.path, CANONICAL[file.path] ?? '']));
}

async function main(): Promise<void> {
  const fetchCalls = { count: 0 };
  const created = createHostAssembly({
    fetch: (async () => {
      fetchCalls.count += 1;
      throw new Error('the T024 containment probe makes no model calls');
    }) as typeof globalThis.fetch,
  });
  if (!('host' in created)) {
    emit('not-run', { reason: created.reasonCode, path: created.path, detail: 'operator profile unavailable; see real-tier contract §(d)' });
    process.exit(3);
  }
  const { assembly, metadata, preflight } = created;

  if (!isSupportedSnapshotPlatform(process.platform)) {
    emit('not-run', { reason: 'host-platform-unsupported', platform: process.platform, imageId: metadata.imageId });
    process.exit(3);
  }
  const ready = await preflight();
  if (!ready.ok) {
    emit('not-run', { reason: ready.reasonCode, imageId: metadata.imageId, detail: 'Docker daemon or pinned image unavailable' });
    process.exit(3);
  }

  let outcome: ProbeOutcome;
  try {
    outcome = await runContainment(assembly);
  } catch (error) {
    // A probe that cannot complete is not a containment pass; the message is bounded, never a stack.
    emit('fail', { failed: ['probe'], detail: error instanceof Error ? error.message.slice(0, 400) : 'probe failed' });
    process.exit(1);
  }
  assert.equal(fetchCalls.count, 0, 'the T024 containment probe must make zero model calls');
  report(outcome.rows, { ...outcome.evidence, dockerServerVersion: ready.dockerServerVersion, fetches: fetchCalls.count });
}

await main();
