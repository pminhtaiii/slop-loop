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
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { computeFileDigest, computeWorkspaceVolumeIds, validateDockerProfile } from '../../../src/foundation/docker-workspace-policy.ts';
import { structuredSpawn } from '../../../src/foundation/docker-spawn.ts';
import { createExecutionGuardV02 } from '../../../src/foundation/execution-guard.ts';
import { createRepositoryReceiverV02 } from '../../../src/foundation/repository-tools.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import { createDurableAttemptStartRecoveryHandoff, createDurableUnattemptedClaimClosureHandoff, createRefusingPatchRecoveryHandoff } from '../../../src/foundation/durable-recovery-handoffs.ts';
import { computeCanonicalSha256, computeCheckSetDigest } from '../../../src/contracts/foundation/uc03.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { seedTaskState } from '../../../src/runtime/real-tier-task-seed.ts';
import { executionProfileOf } from '../../../src/runtime/real-tier-execution-profile.ts';
import { isSupportedSnapshotPlatform, createTrustedHostSnapshot } from '../../../src/runtime/trusted-host-snapshot.ts';
import { createHostAssembly, type RealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import type { BugTask, ExecutionLimits, RepositoryAdmissionContextV02, RunCommandAction, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { isCanonicalRelativePath } from '../../../src/contracts/foundation/uc03.ts';
import {
  createContainerTrap,
  type ContainerTrap,
  type InspectedContainer,
  hostileAdmission,
  hostileCommand,
  measuredAdmissionView,
  memoryKillWitnessed,
  parseInspected,
  REFUSAL_REASONS,
  refusalContexts,
  runDiagnosticWithCleanup,
  sigkilled,
  timeoutKilled,
} from './uc03-real-containment-evidence.ts';

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
    process.exitCode = 0;
    return;
  }
  emit('fail', { rows, failed, ...evidence });
  process.exitCode = 1;
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
} else if (argv.includes('--red-proof')) {
  // The memory predicate's behavioral red witness. The witness row is the pre-fix false positive: the
  // executor command was SIGKILLed for an unrelated reason (exit 137, no OOM in its own container) while
  // a different container did OOM. The shipped predicate must score it false, so the row fails and this
  // run exits nonzero by design. The supporting rows show the other false positives are rejected and a
  // genuine kill of the same container passes. Loosening the predicate to ignore which container was
  // inspected, or to accept a bare exit 137, flips the witness row green and this stops failing.
  const killed = { exitCode: 137, timedOut: false, outcome: 'failure', durationMs: 400 };
  const sigkillNoOom = { name: 'ctr-executor', oomKilled: false, exitCode: 137 };
  const otherContainerOom = { name: 'oom-witness-calibration', oomKilled: true, exitCode: 137 };
  const genericError = { exitCode: null, timedOut: false, outcome: 'error', durationMs: 30 };
  const startupFailure = { exitCode: 125, timedOut: false, outcome: 'failure', durationMs: 20 };
  const ownOom = { name: 'ctr-executor', oomKilled: true, exitCode: 137 };
  report(
    [
      row(
        'RED-PROOF WITNESS an unrelated SIGKILL beside a separate OOM container must not score as a memory kill (this row must fail)',
        memoryKillWitnessed(killed, 'ctr-executor', otherContainerOom, 60_000),
        { executed: killed, inspected: otherContainerOom },
      ),
      row('RED-PROOF a SIGKILL with no OOM in its own container is rejected (must pass)', !memoryKillWitnessed(killed, 'ctr-executor', sigkillNoOom, 60_000), sigkillNoOom),
      row('RED-PROOF a generic error is rejected (must pass)', !memoryKillWitnessed(genericError, 'ctr-executor', ownOom, 60_000), genericError),
      row('RED-PROOF a Docker startup failure is rejected (must pass)', !memoryKillWitnessed(startupFailure, 'ctr-executor', ownOom, 60_000), startupFailure),
      row('RED-PROOF the executor container reported OOMKilled with the same exit code is accepted (must pass)', memoryKillWitnessed(killed, 'ctr-executor', ownOom, 60_000), ownOom),
    ],
    { redProof: true, note: 'exits nonzero by design: the witness row shows the shipped predicate rejects a SIGKILL whose own container was not OOM-killed' },
  );
} else if (argv.includes('--helper-check')) {
  // Independent behavioral checks for the row predicates that previously mis-scored evidence.
  // Order must not decide a mutation verdict: the same mapping in a different order is still equal.
  const a = { 'tests/test_malicious.py': 'sha256:1', 'src/calculator.py': 'sha256:2', '.env': 'sha256:3' };
  const b = { '.env': 'sha256:3', 'src/calculator.py': 'sha256:2', 'tests/test_malicious.py': 'sha256:1' };
  // An unrelated command failure (import error, exit 1, not timed out) is not resource enforcement.
  const importError = { exitCode: 1, timedOut: false, outcome: 'failure', durationMs: 200 };
  const oomKill = { exitCode: 137, timedOut: false, outcome: 'failure', durationMs: 400 };
  const observedTimeout = { exitCode: null, timedOut: true, outcome: 'timeout', durationMs: 2_100 };
  // The false positives SPEC-W5-108 / STD-W5-103 name: a generic error, a null exit with a timeout
  // verdict but no timeout outcome, and a Docker launch failure (exit 125) all once scored as kills.
  const genericError = { exitCode: null, timedOut: false, outcome: 'error', durationMs: 30 };
  const nullWithTimeout = { exitCode: null, timedOut: true, outcome: 'failure', durationMs: 2_100 };
  const launchFailure = { exitCode: 125, timedOut: false, outcome: 'failure', durationMs: 20 };
  const lateTimeout = { exitCode: null, timedOut: true, outcome: 'timeout', durationMs: 120_000 };
  report(
    [
      row('HELPER-CHECK same digests in different order compare equal (must pass)', sameDigests(a, b)),
      row('HELPER-CHECK a changed digest fails (must pass)', !sameDigests(a, { ...b, 'src/calculator.py': 'sha256:X' })),
      row('HELPER-CHECK an import error is not a timeout kill (must pass)', !timeoutKilled(importError)),
      row('HELPER-CHECK an observed timeout is a timeout kill (must pass)', timeoutKilled(observedTimeout, 2_000)),
      row('HELPER-CHECK an OOM-killed executor container is a memory kill (must pass)', memoryKillWitnessed(oomKill, 'ctr-a', { name: 'ctr-a', oomKilled: true, exitCode: 137 }, 60_000)),
      row('HELPER-CHECK a bare SIGKILL exit is not by itself a memory kill (must pass)', sigkilled(oomKill) && !memoryKillWitnessed(oomKill, 'ctr-a', undefined, 60_000)),
      row('HELPER-CHECK an import error is not a memory kill (must pass)', !memoryKillWitnessed(importError, 'ctr-a', { name: 'ctr-a', oomKilled: true, exitCode: 1 }, 60_000)),
      row('HELPER-CHECK a generic error is not a memory kill (must pass)', !sigkilled(genericError)),
      row('HELPER-CHECK a null exit with a timeout verdict is not a memory kill (must pass)', !sigkilled(nullWithTimeout)),
      row('HELPER-CHECK a Docker launch failure (125) is not a memory kill (must pass)', !sigkilled(launchFailure)),
      row('HELPER-CHECK a timeout settled past its deadline is not an enforced timeout (must pass)', !timeoutKilled(lateTimeout, 2_000)),
      row(
        'HELPER-CHECK an inspect line parses and a missing container does not (must pass)',
        parseInspected('ctr-a', 'true 137')?.oomKilled === true && parseInspected('ctr-a', 'Error: No such container') === undefined,
      ),
    ],
    { helperCheck: true },
  );
} else {
  await main();
}

const MALICIOUS_TEST = `
import pathlib
import os
import pytest

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
    assert set(os.listdir('/sys/class/net')) == {'lo'}

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

/** Path→digest equality that ignores directory-enumeration order, which is not a mutation. */
function sameDigests(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

const OOM_SCRIPT = 'x=bytearray(2*1024**3)';

/** Docker's own account of one container's end; absent when it cannot be inspected. */
async function inspectContainer(name: string): Promise<InspectedContainer | undefined> {
  const result = await structuredSpawn('docker', ['inspect', '--format', '{{.State.OOMKilled}} {{.State.ExitCode}}', name], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
  return result.exitCode === 0 ? parseInspected(name, result.stdout) : undefined;
}

/**
 * A real link/junction on this host, measured by the production trusted snapshot: the test inventory
 * must not resolve through a link to a path outside the approved workspace. A host where the link
 * cannot be created fails the row; an unverified platform is never a pass.
 */
async function linkEscapeRow(): Promise<Row> {
  const root = mkdtempSync(join(tmpdir(), 'uc03-t024-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'uc03-t024-outside-'));
  try {
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'tests/test_a.py'), 'def test_a():\n    assert True\n', 'utf8');
    writeFileSync(join(outside, 'test_b.py'), 'def test_b():\n    assert True\n', 'utf8');
    const target = join(root, 'tests/test_b.py');
    try {
      // A junction needs no elevation on Windows; a file symlink may. Either is the production input.
      if (process.platform === 'win32') symlinkSync(outside, target, 'junction');
      else symlinkSync(join(outside, 'test_b.py'), target, 'file');
    } catch (error) {
      return row(
        'C07 a link or junction out of the workspace refuses the snapshot',
        false,
        `link could not be created, so containment is unproven: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const filesystem = new WorkspaceFilesystemPort({ root });
    const checks = [{ checkId: 'check-1', executable: 'pytest', argv: ['-q', 'tests/'], purpose: 'reproduction' as const, workingDirectory: 'tests', timeoutMs: 30_000, maxOutputBytes: 1_048_576 }];
    const criteria = ['the hostile test is contained'];
    const inventory = ['tests/test_a.py', 'tests/test_b.py'];
    const snapshot = createTrustedHostSnapshot({
      filesystem,
      workspaceId: 'ws-t024-link',
      repositoryId: 'repo-t024-link',
      acceptanceCriteria: criteria,
      requiredChecks: checks,
      expectedTestFiles: inventory,
      maxFileBytes: 4096,
    });
    const request = {
      taskId: 'task-t024-link',
      workspaceId: 'ws-t024-link',
      repositoryId: 'repo-t024-link',
      expectedRevisionDigest: await filesystem.getCurrentRevisionDigest(),
      expectedCriteriaDigest: computeCanonicalSha256(criteria),
      expectedCheckSetDigest: computeCheckSetDigest(checks),
      expectedTestFiles: inventory,
    };
    return await refusalRow('C07 a link or junction out of the workspace refuses the snapshot', /LINKED_ESCAPE/u, async () => await snapshot.loadSnapshot(request));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

interface ProbeOutcome {
  readonly rows: readonly Row[];
  readonly evidence: Record<string, unknown>;
}

const CONFIG_POLICY = { policyId: 'config-t024', policyVersion: '1.0.0', configId: 'config-t024', configVersion: '1.0.0' };
const AUTHORITY = { ...CONFIG_POLICY, issuerKeyRef: 'host-config-t024', decisionAuthorityGeneration: 1 };

/** Attempts removal of owned volumes, verifying absent status and returning any unresolvable volume IDs. */
async function removeOwnedVolumes(volumes: readonly string[]): Promise<string[]> {
  const removalFailures: string[] = [];
  for (const volume of volumes) {
    try {
      const rm = await structuredSpawn('docker', ['volume', 'rm', '-f', volume], { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 });
      if (rm.exitCode !== 0) {
        const inspect = await structuredSpawn('docker', ['volume', 'inspect', volume], { timeoutMs: 10_000, maxOutputBytes: 16 * 1024 });
        if (inspect.exitCode === 0) {
          removalFailures.push(volume);
        }
      }
    } catch {
      removalFailures.push(volume);
    }
  }
  return removalFailures;
}

/**
 * C06–C11 rows through the production guard/receiver. The port is built the way the bound task's own
 * port is (`real-tier-owners.ts`): a published authority head and the owner execution profile. The
 * admission comes from `uc03-real-containment-evidence.ts`, which lifts the view the production builder
 * issued and digests the whole policy receipt, so the admitted row really claims. Every refusal is
 * asserted by the text the guard returns, with zero receiver dispatch and the complete task and journal
 * unchanged.
 */
async function guardedContainmentRows(assembly: RealTierAssembly, revision: string): Promise<{ rows: Row[]; guardedHostile: Record<string, unknown> }> {
  const rows: Row[] = [];
  const guardedEvidence: Record<string, unknown> = {};
  const guardedTaskId = `task-t024-guarded-${randomUUID()}`;
  const guardedWorkspaceId = `ws-t024-guarded-${randomUUID()}`;
  const guardedRunId = `run-t024-guarded-${randomUUID()}`;
  const ids = { taskId: guardedTaskId, workspaceId: guardedWorkspaceId };
  const root = mkdtempSync(join(tmpdir(), 'uc03-t024-guarded-'));
  const acquiredVolumes: string[] = [];
  let primaryError: unknown;

  try {
    const repositoryRoot = join(root, 'repository');
    for (const [path, content] of Object.entries(CANONICAL)) {
      const full = join(repositoryRoot, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    const filesystem = new WorkspaceFilesystemPort({ root: repositoryRoot });
    const store = new DurableStore(join(root, 'store'));
    const label = assembly.profile.image.label;
    const requiredChecks = [
      {
        checkId: 'check-1',
        executable: 'pytest',
        argv: ['-q', 'tests/test_calculator.py', 'tests/test_malicious.py'],
        purpose: 'reproduction' as const,
        workingDirectory: 'tests',
        timeoutMs: 30_000,
        maxOutputBytes: 1_048_576,
      },
    ];
    const task: BugTask = {
      taskId: guardedTaskId,
      repositoryId: `repo-${guardedTaskId}`,
      initialRevisionDigest: revision,
      goal: 'Contain the hostile test command',
      observedBehavior: 'A hostile test could escape',
      expectedBehavior: 'The hostile test is contained',
      reproduction: 'pytest -q tests/test_malicious.py',
      acceptanceCriteria: ['the hostile test is contained'],
      constraints: [],
      requiredChecks,
      limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576, maxCpuCores: 1, maxMemoryBytes: 536_870_912, maxPids: 64 },
      budgetLimits: { maxReplanCount: 3, maxTokens: 100_000, maxCostUsd: 5, maxRepairAttempts: 2, maxReviewIterations: 2 },
      configId: CONFIG_POLICY.configId,
      configVersion: CONFIG_POLICY.configVersion,
    };
    const statePort = new DurableStatePortV02({
      store,
      taskId: guardedTaskId,
      initialControl: { controlVersion: 1, epoch: 1, mode: 'runnable', activeAuthorityRef: AUTHORITY },
      // The owner-held profile the bound task's port carries: the workspace's own scratch, the builder's
      // exclusions version and the task's limits. Without it the port's synthetic constants refuse every
      // real view, so a guard row would pass on that unrelated refusal instead of its own.
      executionProfile: (taskId, workspaceId) => executionProfileOf(task, label, { taskId, workspaceId }),
    });

    await statePort.transition(seedTaskState(task, { ...ids, runId: guardedRunId }), 0);
    await statePort.transition({ ...((await statePort.loadTask(guardedTaskId)) as TaskState), stateVersion: 2, node: 'Investigate', nextAction: 'propose-fix-plan' }, 1);

    const manager = assembly.workspaceManager;
    await manager.createWorkspace({
      taskId: guardedTaskId,
      workspaceId: guardedWorkspaceId,
      initialRevisionDigest: revision,
      profile: {
        profileId: label,
        image: assembly.profile.image.base,
        imageDigest: assembly.profile.image.imageId,
        user: assembly.profile.image.user,
        readOnlyRootFilesystem: true,
        network: 'none',
        limits: {
          timeoutMs: 30_000,
          maxMemoryBytes: assembly.profile.limits.memoryBytes,
          maxCpuCores: assembly.profile.limits.cpus,
          maxPids: assembly.profile.limits.processes,
          maxOutputBytes: assembly.profile.limits.outputBytes,
        },
        mounts: [],
      },
    });
    const guardedVolumes = computeWorkspaceVolumeIds(guardedTaskId, guardedWorkspaceId);
    acquiredVolumes.push(guardedVolumes.repoVolumeId, guardedVolumes.scratchVolumeId);

    await seedRepoVolume(assembly, guardedVolumes.repoVolumeId);
    const view = await measuredAdmissionView(params => manager.admitMeasuredCommandView(params), guardedWorkspaceId, ['src/calculator.py', 'tests/test_calculator.py'], label);
    const state = (await statePort.loadTask(guardedTaskId)) as TaskState;
    const input = { state, view, profile: executionProfileOf(task, label, ids), authority: AUTHORITY, checks: requiredChecks };

    let receiverCalls = 0;
    const receiver = createRepositoryReceiverV02({
      guardCapability: {
        provenance: 'real',
        capabilityId: `read-${guardedTaskId}`,
        workspaceId: guardedWorkspaceId,
        taskId: guardedTaskId,
        mediateRead: async operation => await operation.execute(),
      },
      fsPort: filesystem,
      limits: { maxExcerptBytes: 65_536, maxResultCount: 32 },
      expectedRevisionDigest: revision,
      provenance: 'real',
      workspaceRoot: repositoryRoot,
      statePort,
      commandExecutor: assembly.executor,
      workspaceManager: manager,
      trustedCommandResourcePolicy: { isolationProfileRef: label, limits: task.limits },
      adapterIdentity: assembly.executor.getAdapterIdentity(),
      processIncarnation: assembly.executor.getProcessIncarnation(),
      fencingGeneration: assembly.executor.getFencingGeneration() || 1,
      unattemptedClaimClosureHandoff: createDurableUnattemptedClaimClosureHandoff(statePort),
      attemptStartRecoveryHandoff: createDurableAttemptStartRecoveryHandoff(statePort),
      patchRecoveryHandoff: createRefusingPatchRecoveryHandoff(),
    });
    const guardedReceiver = {
      ...receiver,
      runCommand: (action: RunCommandAction, context: RepositoryAdmissionContextV02) => {
        receiverCalls += 1;
        return receiver.runCommand(action, context);
      },
    };
    const guard = createExecutionGuardV02({ ports: { statePort, repositoryPort: guardedReceiver }, config: { provenance: 'real' } });
    /** Claim and attempt counts from the durable journal, for the evidence record. */
    const journalCounts = (): { claims: number; attempts: number } => {
      const journal = statePort.getJournalSnapshot(guardedTaskId) as { claims?: readonly unknown[]; attempts?: readonly unknown[] } | null;
      return { claims: journal?.claims?.length ?? 0, attempts: journal?.attempts?.length ?? 0 };
    };
    /** The whole task record and journal: a refusal that rewrote either with equal content is still a change. */
    const fingerprint = async (): Promise<string> => computeCanonicalSha256({ task: await statePort.loadTask(guardedTaskId), journal: statePort.getJournalSnapshot(guardedTaskId) });
    const dispatch = async (context: RepositoryAdmissionContextV02) => {
      const before = (await statePort.loadTask(guardedTaskId)) as TaskState;
      const beforePrint = await fingerprint();
      const beforeCalls = receiverCalls;
      const result = await guard
        .validateAndExecute(context.action, before, context)
        .catch((error: unknown) => ({ outcome: 'denied' as const, reason: error instanceof Error ? error.message : String(error) }));
      return { result, unchanged: beforePrint === (await fingerprint()), receiverCalls: receiverCalls - beforeCalls, journal: journalCounts() };
    };
    const reasonHas = (result: { readonly reason?: string | undefined }, text: string): boolean => typeof result.reason === 'string' && result.reason.includes(text);

    // Each refusal is asserted by the text the guard actually returns for it, so removing one guard
    // cannot leave its row green on an unrelated refusal.
    const refusals = refusalContexts(input);
    const refusalRows = [
      ['stale', 'C06–C11 the production guard refuses a stale admission (STATE_CONTEXT_MISMATCH) with zero receiver dispatch'],
      ['forbidden', 'C06–C11 the production guard refuses a FORBIDDEN admission ("FORBIDDEN result never admits") with zero receiver dispatch'],
      ['noView', 'C11 the production guard refuses a command with no admitted view ("commandView required") and zero receiver dispatch'],
      ['noBounds', 'C10 the production guard refuses a command with missing bounds ("finiteBounds required") before any effect'],
    ] as const;
    for (const [name, title] of refusalRows) {
      const refused = await dispatch(refusals[name]);
      rows.push(row(title, refused.result.outcome === 'denied' && reasonHas(refused.result, REFUSAL_REASONS[name]) && refused.receiverCalls === 0 && refused.unchanged, refused.result));
    }

    // A view naming an isolation profile the owner did not admit passes the guard and is refused inside
    // the receiver's resource-policy step, before any claim or attempt exists.
    const isolation = await dispatch(refusals.foreignIsolation);
    rows.push(
      row(
        'C06 a foreign isolation view is refused inside the receiver before any claim, attempt or executor effect',
        isolation.result.outcome === 'uncertain-effect' && isolation.receiverCalls === 1 && isolation.unchanged,
        isolation.result,
      ),
    );

    // The admitted row: the same state the refusals left untouched, a view from the production builder
    // and a receipt digested over its whole body. It must claim, dispatch once and pass the hostile test.
    const admitted = await dispatch(hostileAdmission({ ...input, action: hostileCommand('act-guarded-hostile') }));
    const hostileResult = admitted.result as {
      readonly outcome: string;
      readonly result?: { readonly exitCode?: number | null; readonly stdout?: string; readonly plan?: { readonly argv?: readonly string[] } };
    };
    const hostileExit = hostileResult.result?.exitCode;
    guardedEvidence['guardedHostile'] = {
      outcome: admitted.result.outcome,
      exitCode: hostileExit,
      argv: hostileResult.result?.plan?.argv,
      viewDigest: view.viewDigest,
      receiverCalls: admitted.receiverCalls,
      journal: admitted.journal,
      sample: (hostileResult.result?.stdout ?? '').slice(-1_500),
    };
    rows.push(
      row(
        'C06–C11 an admitted hostile pytest dispatches exactly once through the production guard and receiver and exits 0',
        admitted.result.outcome === 'success' && admitted.receiverCalls === 1 && hostileExit === 0 && admitted.journal.claims === 1 && admitted.journal.attempts === 1,
        guardedEvidence['guardedHostile'],
      ),
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await assembly.controller.cleanup().catch(() => undefined);
    const removalFailures = await removeOwnedVolumes(acquiredVolumes);
    rmSync(root, { recursive: true, force: true });
    if (removalFailures.length > 0 && primaryError === undefined) {
      throw new Error(`GUARDED_VOLUME_REMOVAL_FAILED: Failed to remove volumes: ${removalFailures.join(', ')}`);
    }
  }
  return { rows, guardedHostile: guardedEvidence };
}

async function runContainment(assembly: RealTierAssembly, trap: ContainerTrap): Promise<ProbeOutcome> {
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
  const taskId = `task-t024-${randomUUID()}`;
  const workspaceId = `ws-t024-${randomUUID()}`;
  const { repoVolumeId, scratchVolumeId } = computeWorkspaceVolumeIds(taskId, workspaceId);
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
  const acquiredVolumes: string[] = [];
  let primaryError: unknown;

  try {
    await manager.createWorkspace({ taskId, workspaceId, initialRevisionDigest: revision, profile: trusted });
    acquiredVolumes.push(repoVolumeId, scratchVolumeId);
    await seedRepoVolume(assembly, repoVolumeId);

    const view = await manager.admitCommandView({ workspaceId, requiredFiles: ['src/calculator.py', 'tests/test_calculator.py'] });
    acquiredVolumes.push(view.viewId);
    evidence['viewId'] = view.viewId;
    evidence['viewDigest'] = view.viewDigest;
    evidence['admittedFiles'] = view.admittedFiles.map(file => file.path);
    rows.push(row('C06 view mounts the canonical view read-only with a separate writable scratch', view.mountedReadOnly === true && view.scratchIdentity === scratchVolumeId));

    // §9 issuance: the same measurement built through the owner-bound entry point must be accepted.
    const measured = await manager.admitMeasuredCommandView({
      workspaceId,
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
        manager.admitCommandView({ workspaceId, requiredFiles: ['src/leaky.py'] }),
      ),
    );
    rows.push(await refusalRow('C07 required protected path refuses before execution', /PROTECTED_PATH_FORBIDDEN/u, () => manager.admitCommandView({ workspaceId, requiredFiles: ['.env'] })));
    for (const forbidden of FORBIDDEN_IN_VIEW) assert.ok(!view.admittedFiles.some(file => file.path === forbidden), `${forbidden} must be excluded before view creation`);

    const escapePaths = ['../../outside_marker.txt', '../escape.py', '/etc/shadow', '/root/.ssh/id_rsa', 'C:/Windows/win.ini', 'src/../../escape.py'];
    for (const escapePath of escapePaths) assert.equal(isCanonicalRelativePath(escapePath), false, `${escapePath} must not be a canonical relative path`);
    const escapeViewId = `view-${workspaceId}-c07`;
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

    // C06–C11 through the production execution guard and receiver, not only the raw executor: the
    // hostile command is admitted (or refused with zero downstream dispatch) by the real guard.
    const guarded = await guardedContainmentRows(assembly, revision);
    rows.push(...guarded.rows);
    Object.assign(evidence, guarded.guardedHostile);

    const limits: ExecutionLimits = {
      timeoutMs: Math.min(profile.limits.commandTimeoutMs, 60_000),
      maxMemoryBytes: Math.min(profile.limits.memoryBytes, 256 * 1024 * 1024),
      maxCpuCores: 1,
      maxPids: Math.min(profile.limits.processes, 64),
      maxOutputBytes: Math.min(profile.limits.outputBytes, 256 * 1024),
    };

    rows.push(
      await refusalRow('C09 shell metacharacters refuse before dispatch', /FORBIDDEN_SHELL_CHARACTERS/u, () =>
        executor.execute({ workspaceId, executable: 'pytest', argv: ['-q', 'tests/test_calculator.py; id'], limits }),
      ),
    );
    rows.push(await refusalRow('C09 disallowed executable refuses before dispatch', /DISALLOWED_EXECUTABLE/u, () => executor.execute({ workspaceId, executable: 'sh', argv: ['-c', 'id'], limits })));
    rows.push(
      await refusalRow('C07 working directory outside the workspace refuses before dispatch', /INVALID_WORKING_DIRECTORY/u, () =>
        executor.execute({ workspaceId, executable: 'pytest', argv: ['-q'], workingDirectory: '/etc', limits }),
      ),
    );
    rows.push(
      await refusalRow('C10 limits above the profile ceiling refuse before any container runs', /RESOURCE_LIMIT_EXCEEDS_PROFILE_CEILING/u, () =>
        executor.execute({ workspaceId, executable: 'pytest', argv: ['-q'], limits: { ...limits, maxMemoryBytes: profile.limits.memoryBytes + 1 } }),
      ),
    );
    // Injected environment never reaches the container: a credential-shaped key and an interpreter
    // loader hook are both refused by the production plan builder before any container is launched.
    rows.push(
      await refusalRow('C09 a credential-shaped environment variable refuses before dispatch', /FORBIDDEN_ENVIRONMENT_VARIABLE/u, () =>
        executor.execute({ workspaceId, executable: 'pytest', argv: ['-q'], limits, env: { GITHUB_TOKEN: 'sentinel-not-a-real-token' } }),
      ),
    );
    rows.push(
      await refusalRow('C09 an interpreter loader hook refuses before dispatch', /LOADER_HOOK_FORBIDDEN/u, () =>
        executor.execute({ workspaceId, executable: 'python3', argv: ['-V'], limits, env: { PYTHONSTARTUP: '/workspace/repo/src/leaky.py' } }),
      ),
    );
    rows.push(await linkEscapeRow());

    const hostile = await executor.execute({ workspaceId, executable: 'pytest', argv: ['-q', 'tests/test_calculator.py', 'tests/test_malicious.py'], limits });
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

    const memoryBytes = 64 * 1024 * 1024;
    // The trap keeps the one container this execution starts (it drops only `--rm`), so Docker can say
    // why exactly that container died. A SIGKILL with no OOM there, or an OOM elsewhere, is not a pass.
    const diagnostic = await runDiagnosticWithCleanup({
      trap,
      marker: OOM_SCRIPT,
      execute: () => executor.execute({ workspaceId, executable: 'python3', argv: ['-c', OOM_SCRIPT], limits: { ...limits, maxMemoryBytes: memoryBytes } }),
      inspect: inspectContainer,
      remove: name => structuredSpawn('docker', ['rm', '-f', name], { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 }),
    });
    const { outcome: oom, ranName, inspected } = diagnostic;
    evidence['memoryBound'] = { exitCode: oom.exitCode, timedOut: oom.timedOut, outcome: oom.outcome, durationMs: oom.durationMs, container: inspected, removalDisabledForInspection: true };
    rows.push(
      row(
        'C10 memory over the admitted ceiling is OOM-killed in its own executor container, within its timeout',
        memoryKillWitnessed(oom, ranName, inspected, limits.timeoutMs),
        evidence['memoryBound'],
      ),
    );

    const timeout = await executor.execute({ workspaceId, executable: 'python3', argv: ['-c', '__import__("time").sleep(30)'], limits: { ...limits, timeoutMs: 2_000 } });
    evidence['timeoutBound'] = { exitCode: timeout.exitCode, timedOut: timeout.timedOut, outcome: timeout.outcome, durationMs: timeout.durationMs };
    // The timeout row requires an observed timeout verdict bounded by the admitted deadline, not merely
    // a nonzero exit or any null code.
    rows.push(row('C10 a command past its admitted timeout is killed within its deadline', timeoutKilled(timeout, 2_000), evidence['timeoutBound']));

    const canonicalAfter = await readVolume(assembly, repoVolumeId);
    const expectedCanonical = Object.fromEntries(Object.entries(CANONICAL).map(([path, content]) => [path, computeFileDigest(Buffer.from(content, 'utf8'))]));
    rows.push(row('C06 execution cannot mutate the canonical repository volume', sameDigests(canonicalAfter, expectedCanonical)));
    const viewAfter = await readVolume(assembly, view.viewId);
    rows.push(row('C06 execution cannot mutate the admitted view', sameDigests(viewAfter, viewVolumeFiles)));
    const scratchAfter = await readVolume(assembly, scratchVolumeId, '/workspace/scratch');
    evidence['scratchFiles'] = Object.keys(scratchAfter).sort();
    rows.push(row('C06 scratch output stays in the scratch volume', Object.keys(scratchAfter).join(',') === 'out.txt' && !('out.txt' in canonicalAfter)));

    // C11 fresh-task state separation: a second, distinct task/workspace is created independently; an
    // attempted execution against the first task's workspace id from the second's context is refused.
    const secondTaskId = `task-t024-alt-${randomUUID()}`;
    const secondWorkspaceId = `ws-t024-alt-${randomUUID()}`;
    const secondIds = computeWorkspaceVolumeIds(secondTaskId, secondWorkspaceId);
    await manager.createWorkspace({ taskId: secondTaskId, workspaceId: secondWorkspaceId, initialRevisionDigest: revision, profile: trusted });
    acquiredVolumes.push(secondIds.repoVolumeId, secondIds.scratchVolumeId);
    rows.push(
      await refusalRow('C11 a distinct task/workspace owns separate state and refuses its own absent view', /COMMAND_VIEW_REQUIRED/u, () =>
        executor.execute({ workspaceId: secondWorkspaceId, executable: 'pytest', argv: ['-q'], limits }),
      ),
    );
    rows.push(row('C11 the two tasks share no volume identity', secondIds.repoVolumeId !== repoVolumeId && secondIds.scratchVolumeId !== scratchVolumeId));

    // C11 invalidating the view removes execution authority for the first workspace.
    manager.invalidateViews(workspaceId);
    rows.push(await refusalRow('C11 a workspace with no active view cannot execute', /COMMAND_VIEW_REQUIRED/u, () => executor.execute({ workspaceId, executable: 'pytest', argv: ['-q'], limits })));
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await controller.cleanup().catch(() => undefined);
    const removalFailures = await removeOwnedVolumes(acquiredVolumes);
    if (removalFailures.length > 0 && primaryError === undefined) {
      throw new Error(`CONTAINMENT_VOLUME_REMOVAL_FAILED: Failed to remove volumes: ${removalFailures.join(', ')}`);
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
  const trap = createContainerTrap(structuredSpawn);
  const created = createHostAssembly({
    spawn: trap.spawn,
    fetch: (async () => {
      fetchCalls.count += 1;
      throw new Error('the T024 containment probe makes no model calls');
    }) as typeof globalThis.fetch,
  });
  if (!('host' in created)) {
    emit('not-run', { reason: created.reasonCode, path: created.path, detail: 'operator profile unavailable; see real-tier contract §(d)' });
    process.exitCode = 3;
    return;
  }
  const { assembly, metadata, preflight } = created;

  if (!isSupportedSnapshotPlatform(process.platform)) {
    emit('not-run', { reason: 'host-platform-unsupported', platform: process.platform, imageId: metadata.imageId });
    process.exitCode = 3;
    return;
  }
  const ready = await preflight();
  if (!ready.ok) {
    emit('not-run', { reason: ready.reasonCode, imageId: metadata.imageId, detail: 'Docker daemon or pinned image unavailable' });
    process.exitCode = 3;
    return;
  }

  let outcome: ProbeOutcome;
  try {
    outcome = await runContainment(assembly, trap);
  } catch (error) {
    // A probe that cannot complete is not a containment pass; the message is bounded, never a stack.
    emit('fail', { failed: ['probe'], detail: error instanceof Error ? error.message.slice(0, 400) : 'probe failed' });
    process.exitCode = 1;
    return;
  }
  assert.equal(fetchCalls.count, 0, 'the T024 containment probe must make zero model calls');
  report(outcome.rows, { ...outcome.evidence, dockerServerVersion: ready.dockerServerVersion, fetches: fetchCalls.count });
}
