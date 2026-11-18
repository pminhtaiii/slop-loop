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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { computeFileDigest, computeWorkspaceVolumeIds, validateDockerProfile } from '../../../src/foundation/docker-workspace-policy.ts';
import { structuredSpawn } from '../../../src/foundation/docker-spawn.ts';
import { createExecutionGuardV02 } from '../../../src/foundation/execution-guard.ts';
import { createRepositoryReceiverV02 } from '../../../src/foundation/repository-tools.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import { createDurableAttemptStartRecoveryHandoff, createDurableUnattemptedClaimClosureHandoff, createRefusingPatchRecoveryHandoff } from '../../../src/foundation/durable-recovery-handoffs.ts';
import { computeActionDigest, computeCanonicalSha256, computeCheckSetDigest, computeCommandViewDigest } from '../../../src/contracts/foundation/uc03.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { seedTaskState } from '../../../src/runtime/real-tier-task-seed.ts';
import { executionProfileOf } from '../../../src/runtime/real-tier-execution-profile.ts';
import { isSupportedSnapshotPlatform, createTrustedHostSnapshot } from '../../../src/runtime/trusted-host-snapshot.ts';
import { createHostAssembly, type RealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import type { BugTask, ExecutionLimits, RepositoryAdmissionContextV02, RunCommandAction, TaskState, validateStateTransition } from '../../../src/contracts/foundation/uc03.ts';
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

if (argv.includes('--red-proof')) {
  // The memory predicate's behavioral red witness. The witness row is the pre-fix false positive — a
  // generic error that the old predicate certified as memory enforcement — scored by the shipped
  // predicate: it must come back false, so the row fails and this run exits nonzero by design. The
  // supporting rows prove the other false positives are rejected too. Loosening the predicate back to
  // any-error / any-null-exit flips the witness row to green and this red-proof stops failing.
  const genericError = { exitCode: null, timedOut: false, outcome: 'error', durationMs: 30 };
  const nullWithTimeout = { exitCode: null, timedOut: true, outcome: 'failure', durationMs: 2_100 };
  const startupFailure = { exitCode: 125, timedOut: false, outcome: 'failure', durationMs: 20 };
  report(
    [
      row('RED-PROOF WITNESS a generic error must not score as a memory kill (this row must fail)', resourceKilled(genericError, 'memory'), genericError),
      row('RED-PROOF a null exit with a timeout verdict is rejected (must pass)', !resourceKilled(nullWithTimeout, 'memory'), nullWithTimeout),
      row('RED-PROOF a Docker startup failure is rejected (must pass)', !resourceKilled(startupFailure, 'memory'), startupFailure),
    ],
    { redProof: true, note: 'exits nonzero by design: the witness row shows the shipped predicate rejects the old false positive' },
  );
}

if (argv.includes('--helper-check')) {
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
      row('HELPER-CHECK an import error is not a timeout kill (must pass)', !resourceKilled(importError, 'timeout')),
      row('HELPER-CHECK an observed timeout is a timeout kill (must pass)', resourceKilled(observedTimeout, 'timeout', 2_000)),
      row('HELPER-CHECK and OOM kill (SIGKILL) is a memory kill (must pass)', resourceKilled(oomKill, 'memory')),
      row('HELPER-CHECK an import error is not a memory kill (must pass)', !resourceKilled(importError, 'memory')),
      row('HELPER-CHECK a generic error is not a memory kill (must pass)', !resourceKilled(genericError, 'memory')),
      row('HELPER-CHECK a null exit with a timeout verdict is not a memory kill (must pass)', !resourceKilled(nullWithTimeout, 'memory')),
      row('HELPER-CHECK a Docker launch failure (125) is not a memory kill (must pass)', !resourceKilled(launchFailure, 'memory')),
      row('HELPER-CHECK a timeout settled past its deadline is not an enforced timeout (must pass)', !resourceKilled(lateTimeout, 'timeout', 2_000)),
    ],
    { helperCheck: true },
  );
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

/** Path→digest equality that ignores directory-enumeration order, which is not a mutation. */
function sameDigests(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

/**
 * Whether an execution was ended by the admitted resource bound rather than by an unrelated command
 * failure. The production controller reports only `{ exitCode, timedOut, durationMs }`:
 * - a timeout kill is an observed timeout verdict, settled within the admitted deadline plus grace;
 * - a memory kill is a non-timeout SIGKILL (137 = 128+9), the one kill signal the controller surfaces.
 * A launch error (125), an ordinary failure (1), a generic `error` outcome or a null exit never count.
 * A Docker `OOMKilled` observation is asserted beside this predicate as the independent witness.
 */
function resourceKilled(result: { readonly exitCode: number | null; readonly timedOut: boolean; readonly outcome: string; readonly durationMs?: number }, kind: 'timeout' | 'memory', admittedTimeoutMs?: number): boolean {
  if (kind === 'timeout') {
    if (!result.timedOut || result.outcome !== 'timeout') return false;
    // The kill must be bounded by the admitted deadline plus the spawner's own 2 s SIGKILL grace, so
    // a runaway that only settled later cannot read as an enforced timeout.
    return admittedTimeoutMs === undefined || result.durationMs === undefined || result.durationMs <= admittedTimeoutMs + 15_000;
  }
  return result.timedOut === false && result.outcome === 'failure' && result.exitCode === 137;
}

/**
 * The independent memory witness: the same allocation in a raw disposable container the executor does
 * not own, kept only long enough for `docker inspect` to report `OOMKilled`. Fixture plumbing, never a
 * pass on its own — the row pairs it with the executor's own exit code, so neither alone decides.
 */
async function dockerOomKilled(assembly: RealTierAssembly, memoryBytes: number): Promise<{ oomKilled: boolean; exitCode: number | null } | { error: string }> {
  const profile = assembly.profile;
  const name = `oom-witness-${createHash('sha256').update(`${Date.now()}${Math.random()}`).digest('hex').slice(0, 12)}`;
  try {
    await structuredSpawn(
      'docker',
      [
        'run',
        '--name',
        name,
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        `--platform=${profile.image.platform}`,
        `--user=${profile.image.user}`,
        `--memory=${memoryBytes}`,
        '--pull=never',
        imageReference(assembly),
        'python3',
        '-c',
        'x=bytearray(2*1024**3)',
      ],
      { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 },
    );
    const inspect = await structuredSpawn('docker', ['inspect', '--format', '{{.State.OOMKilled}} {{.State.ExitCode}}', name], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
    const [oomFlag = '', exitText = ''] = inspect.stdout.trim().split(/\s+/u);
    return { oomKilled: oomFlag === 'true', exitCode: exitText === '' ? null : Number.parseInt(exitText, 10) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    await structuredSpawn('docker', ['rm', '-f', name], { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 });
  }
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
      return row('C07 a link or junction out of the workspace refuses the snapshot', false, `link could not be created, so containment is unproven: ${error instanceof Error ? error.message : String(error)}`);
    }
    const filesystem = new WorkspaceFilesystemPort({ root });
    const checks = [{ checkId: 'check-1', executable: 'pytest', argv: ['-q', 'tests/'], purpose: 'reproduction' as const, workingDirectory: 'tests', timeoutMs: 30_000, maxOutputBytes: 1_048_576 }];
    const criteria = ['the hostile test is contained'];
    const inventory = ['tests/test_a.py', 'tests/test_b.py'];
    const snapshot = createTrustedHostSnapshot({ filesystem, workspaceId: 'ws-t024-link', repositoryId: 'repo-t024-link', acceptanceCriteria: criteria, requiredChecks: checks, expectedTestFiles: inventory, maxFileBytes: 4096 });
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

const GUARDED_TASK_ID = 'task-t024-guarded';
const GUARDED_WORKSPACE_ID = 'ws-t024-guarded';
const GUARDED_RUN_ID = 'run-t024-guarded';
const CONFIG_POLICY = { policyId: 'config-t024', policyVersion: '1.0.0', configId: 'config-t024', configVersion: '1.0.0' };
const AUTHORITY = { ...CONFIG_POLICY, issuerKeyRef: 'host-config-t024', decisionAuthorityGeneration: 1 };

/**
 * C06–C11 refusal rows through the production guard/receiver: the guard admits only a complete
 * admission context, and every refusal (stale revision, forbidden receipt, no admitted view) is
 * produced by production code with zero receiver dispatch and no task-state change. A state-version
 * counter proves a refused admission never claims, begins an attempt or dispatches.
 */
async function guardedContainmentRows(assembly: RealTierAssembly, revision: string): Promise<{ rows: Row[]; guardedHostile: Record<string, unknown> }> {
  const rows: Row[] = [];
  const guardedEvidence: Record<string, unknown> = {};
  const root = mkdtempSync(join(tmpdir(), 'uc03-t024-guarded-'));
  const repositoryRoot = join(root, 'repository');
  mkdirSync(join(repositoryRoot, 'src'), { recursive: true });
  mkdirSync(join(repositoryRoot, 'tests'), { recursive: true });
  for (const [path, content] of Object.entries(CANONICAL)) writeFileSync(join(repositoryRoot, path), content, 'utf8');
  const filesystem = new WorkspaceFilesystemPort({ root: repositoryRoot });
  const store = new DurableStore(join(root, 'store'));
  // The owner-issued Patch transition the state port needs to reach the edit node, supplied at
  // construction (the port's public `trustedTransitions` option), not patched in afterwards.
  const trustedTransitions: Record<number, NonNullable<Parameters<typeof validateStateTransition>[2]>['trusted']> = {};
  const statePort = new DurableStatePortV02({
    store,
    taskId: GUARDED_TASK_ID,
    initialControl: { controlVersion: 1, epoch: 1, mode: 'runnable', activeAuthorityRef: AUTHORITY },
    trustedTransitions,
    // The owner-held profile the bound task's port carries: the workspace's own scratch, the builder's
    // exclusions version and the task's limits. Without it the port's synthetic constants refuse every
    // real view, so a guard row would pass on that unrelated refusal instead of its own (STD-W5-105).
    executionProfile: (taskId, workspaceId) => executionProfileOf(task, assembly.profile.image.label, { taskId, workspaceId }),
  });
  const requiredChecks = [{ checkId: 'check-1', executable: 'pytest', argv: ['-q', 'tests/test_calculator.py'], purpose: 'reproduction' as const, workingDirectory: 'tests', timeoutMs: 30_000, maxOutputBytes: 1_048_576 }];
  const task: BugTask = {
    taskId: GUARDED_TASK_ID,
    repositoryId: 'repo-t024-guarded',
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
  const strategy = 'Guard the divisor';
  const plan = {
    planVersion: 1,
    diagnosis: 'The divisor is not guarded',
    suspectedCauseLocations: ['src/calculator.py:1'],
    evidenceRefs: ['evidence-t024'],
    strategy,
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: computeCheckSetDigest(requiredChecks),
    baselineRef: revision,
    strategyDigest: computeCanonicalSha256(strategy),
    decisionRef: 'dec-plan-t024',
  };
  const planBindingDigest = computeCanonicalSha256({ taskId: GUARDED_TASK_ID, planVersion: 1, strategyDigest: plan.strategyDigest, baselineRef: revision, evidenceRefs: plan.evidenceRefs, criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria), checkSetDigest: plan.checkSetDigest, decisionRef: plan.decisionRef });
  const binding = {
    decisionId: plan.decisionRef,
    actionKind: 'fix_plan' as const,
    normalizedActionDigest: computeCanonicalSha256({ actionId: plan.decisionRef, kind: 'approve_fix_plan', planVersion: 1, strategyDigest: plan.strategyDigest, diagnosisEvidenceRefs: plan.evidenceRefs, checkSetDigest: plan.checkSetDigest }),
    taskId: GUARDED_TASK_ID,
    workspaceId: GUARDED_WORKSPACE_ID,
    repositoryRevisionDigest: revision,
    policyId: CONFIG_POLICY.policyId,
    policyVersion: CONFIG_POLICY.policyVersion,
    planVersion: 1,
    strategyDigest: plan.strategyDigest,
    baselineRef: revision,
    evidenceRefs: plan.evidenceRefs,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: plan.checkSetDigest,
    status: 'approved' as const,
  };
  const freshness = {
    currentTaskId: GUARDED_TASK_ID,
    currentWorkspaceId: GUARDED_WORKSPACE_ID,
    currentRepositoryRevisionDigest: revision,
    currentPolicyId: CONFIG_POLICY.policyId,
    currentPolicyVersion: CONFIG_POLICY.policyVersion,
    currentNormalizedActionDigest: binding.normalizedActionDigest,
    currentPlanVersion: 1,
    currentStrategyDigest: plan.strategyDigest,
    currentBaselineRef: revision,
    currentEvidenceRefs: plan.evidenceRefs,
    currentCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    currentCheckSetDigest: plan.checkSetDigest,
  };
  try {
    await statePort.transition(seedTaskState(task, { taskId: GUARDED_TASK_ID, runId: GUARDED_RUN_ID, workspaceId: GUARDED_WORKSPACE_ID }), 0);
    await statePort.transition({ ...((await statePort.loadTask(GUARDED_TASK_ID)) as TaskState), stateVersion: 2, node: 'Investigate', nextAction: 'investigate' }, 1);
    await statePort.transition({ ...((await statePort.loadTask(GUARDED_TASK_ID)) as TaskState), stateVersion: 3, node: 'AwaitPlan', planVersion: 1, plan, activeDecisionId: plan.decisionRef, nextAction: 'approve-fix-plan' }, 2);
    trustedTransitions[4] = { approval: { binding, freshness } };
    await statePort.transition({ ...((await statePort.loadTask(GUARDED_TASK_ID)) as TaskState), stateVersion: 4, node: 'Patch', nextAction: 'apply-patch' }, 3);

    const manager = assembly.workspaceManager;
    await manager.createWorkspace({
      taskId: GUARDED_TASK_ID,
      workspaceId: GUARDED_WORKSPACE_ID,
      initialRevisionDigest: revision,
      profile: {
        profileId: assembly.profile.image.label,
        image: assembly.profile.image.base,
        imageDigest: assembly.profile.image.imageId,
        user: assembly.profile.image.user,
        readOnlyRootFilesystem: true,
        network: 'none',
        limits: { timeoutMs: 30_000, maxMemoryBytes: assembly.profile.limits.memoryBytes, maxCpuCores: assembly.profile.limits.cpus, maxPids: assembly.profile.limits.processes, maxOutputBytes: assembly.profile.limits.outputBytes },
        mounts: [],
      },
    });
    await seedRepoVolume(assembly, computeWorkspaceVolumeIds(GUARDED_TASK_ID, GUARDED_WORKSPACE_ID).repoVolumeId);
    const guardedView = await manager.admitCommandView({ workspaceId: GUARDED_WORKSPACE_ID, requiredFiles: ['src/calculator.py', 'tests/test_calculator.py'] });

    const command = (actionId: string): RunCommandAction => ({ actionId, kind: 'run_command', executable: 'pytest', argv: ['-q', 'tests/test_calculator.py', 'tests/test_malicious.py'], workingDirectory: '/workspace/repo' });
    const admissionFor = (action: RunCommandAction, overrides: (base: Record<string, unknown>) => Record<string, unknown> = base => base): RepositoryAdmissionContextV02 => {
      const view02 = { viewId: guardedView.viewId, taskId: GUARDED_TASK_ID, workspaceId: GUARDED_WORKSPACE_ID, canonicalRevisionDigest: revision, admittedFiles: guardedView.admittedFiles, exclusionsPolicyVersion: guardedView.exclusionsPolicyVersion, scratchIdentity: guardedView.scratchIdentity, mountedReadOnly: true as const, isolationProfileRef: assembly.profile.image.label };
      const viewDigest = computeCommandViewDigest(view02);
      const commandView = { ...view02, viewId: guardedView.viewId, canonicalRevision: revision, viewDigest };
      const base = {
        schemaVersion: '0.2.0',
        subjectKind: 'repository-action',
        planApplicability: 'approved-plan',
        taskStateSchemaVersion: '0.2.0',
        expectedTaskStateVersion: 4,
        controlSchemaVersion: '0.2.0',
        expectedControlVersion: 1,
        expectedEpoch: 1,
        taskId: GUARDED_TASK_ID,
        runId: GUARDED_RUN_ID,
        workspaceId: GUARDED_WORKSPACE_ID,
        repositoryId: task.repositoryId,
        runnableNode: 'Patch',
        canonicalRevision: revision,
        executionProfileId: assembly.profile.image.label,
        action,
        actionDigest: computeActionDigest(action),
        policyAuthorityRef: AUTHORITY,
        policyEvaluationReceipt: {
          receiptId: `receipt-eval-${action.actionId}`,
          receiptDigest: computeCanonicalSha256({ receiptId: `receipt-eval-${action.actionId}` }),
          actionDigest: computeActionDigest(action),
          freshnessContextDigest: computeCanonicalSha256({ freshness: action.actionId }),
          policyId: CONFIG_POLICY.policyId,
          policyVersion: CONFIG_POLICY.policyVersion,
          configId: CONFIG_POLICY.configId,
          configVersion: CONFIG_POLICY.configVersion,
          decisionAuthorityGeneration: 1,
          result: 'APPROVAL_REQUIRED' as const,
        },
        actionDecisionReceipt: {
          decisionId: `dec-action-${action.actionId}`,
          decisionDigest: computeCanonicalSha256({ decisionId: `dec-action-${action.actionId}` }),
          actionDigest: computeActionDigest(action),
          evaluationReceiptRef: `receipt-eval-${action.actionId}`,
          decisionAuthorityGeneration: 1,
          status: 'approved' as const,
        },
        planBindingDigest,
        planDecisionRef: plan.decisionRef,
        commandView,
        finiteBounds: { timeoutMs: 30_000, maxOutputBytes: 1_048_576, maxCpuSeconds: 120, maxMemoryBytes: 536_870_912, maxProcessCount: 64, isolationProfileRef: assembly.profile.image.label },
        reservationRefs: [`res-${action.actionId}-timeout`, `res-${action.actionId}-out`, `res-${action.actionId}-cpu`, `res-${action.actionId}-mem`, `res-${action.actionId}-proc`],
      };
      return overrides(base) as unknown as RepositoryAdmissionContextV02;
    };

    let receiverCalls = 0;
    const receiver = createRepositoryReceiverV02({
      guardCapability: { provenance: 'real', capabilityId: `read-${GUARDED_TASK_ID}`, workspaceId: GUARDED_WORKSPACE_ID, taskId: GUARDED_TASK_ID, mediateRead: async operation => await operation.execute() },
      fsPort: filesystem,
      limits: { maxExcerptBytes: 65_536, maxResultCount: 32 },
      expectedRevisionDigest: revision,
      provenance: 'real',
      workspaceRoot: repositoryRoot,
      statePort,
      commandExecutor: assembly.executor,
      workspaceManager: manager,
      trustedCommandResourcePolicy: { isolationProfileRef: assembly.profile.image.label, limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576, maxCpuCores: 1, maxMemoryBytes: 536_870_912, maxPids: 64 } },
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
    /** A claim/attempt count from the durable journal: a refused admission must add neither. */
    const journalCounts = (): { claims: number; attempts: number } => {
      const journal = statePort.getJournalSnapshot(GUARDED_TASK_ID) as { claims?: readonly unknown[]; attempts?: readonly unknown[] } | null;
      return { claims: journal?.claims?.length ?? 0, attempts: journal?.attempts?.length ?? 0 };
    };
    const dispatch = async (action: RunCommandAction, context: RepositoryAdmissionContextV02) => {
      const before = (await statePort.loadTask(GUARDED_TASK_ID)) as TaskState;
      const beforeJournal = journalCounts();
      const beforeCalls = receiverCalls;
      const result = await guard.validateAndExecute(action, before, context).catch((error: unknown) => ({ outcome: 'denied' as const, reason: error instanceof Error ? error.message : String(error) }));
      const after = (await statePort.loadTask(GUARDED_TASK_ID)) as TaskState;
      return { result, changed: after.stateVersion !== before.stateVersion, receiverCalls: receiverCalls - beforeCalls, journal: journalCounts(), beforeJournal };
    };
    const reasonHas = (result: { readonly reason?: string | undefined }, code: string): boolean => typeof result.reason === 'string' && result.reason.includes(code);

    // Each refusal is asserted by its own production reason code, so removing one guard cannot leave the
    // row green on an unrelated refusal (STD-W5-105).
    const stale = await dispatch(command('act-guarded-stale'), admissionFor(command('act-guarded-stale'), base => ({ ...base, canonicalRevision: `sha256:${'0'.repeat(64)}`, commandView: { ...(base['commandView'] as Record<string, unknown>), canonicalRevision: `sha256:${'0'.repeat(64)}` } })));
    rows.push(row('C06–C11 the production guard refuses a stale admission (STATE_CONTEXT_MISMATCH) with zero receiver dispatch', reasonHas(stale.result, 'STATE_CONTEXT_MISMATCH') && stale.receiverCalls === 0 && !stale.changed, stale.result));

    const forbidden = await dispatch(
      command('act-guarded-forbidden'),
      admissionFor(command('act-guarded-forbidden'), base => ({ ...base, policyEvaluationReceipt: { ...(base['policyEvaluationReceipt'] as Record<string, unknown>), result: 'FORBIDDEN' }, actionDecisionReceipt: undefined })),
    );
    rows.push(row('C06–C11 the production guard refuses a FORBIDDEN admission (POLICY_FORBIDDEN) with zero receiver dispatch', reasonHas(forbidden.result, 'POLICY_FORBIDDEN') && forbidden.receiverCalls === 0 && !forbidden.changed, forbidden.result));

    const noView = await dispatch(
      command('act-guarded-no-view'),
      admissionFor(command('act-guarded-no-view'), base => {
        const rest = { ...base };
        delete rest['commandView'];
        return rest;
      }),
    );
    rows.push(row('C11 the production guard refuses a command with no admitted view (MISSING_COMMAND_VIEW) and zero receiver dispatch', reasonHas(noView.result, 'MISSING_COMMAND_VIEW') && noView.receiverCalls === 0 && !noView.changed, noView.result));

    const noBounds = await dispatch(
      command('act-guarded-no-bounds'),
      admissionFor(command('act-guarded-no-bounds'), base => {
        const rest = { ...base };
        delete rest['finiteBounds'];
        return rest;
      }),
    );
    rows.push(row('C10 the production guard refuses a command with missing bounds (MISSING_FINITE_BOUNDS) before any effect', reasonHas(noBounds.result, 'MISSING_FINITE_BOUNDS') && noBounds.receiverCalls === 0 && !noBounds.changed, noBounds.result));

    // An isolation profile the owner did not admit refuses at the claim, before any claim/attempt exists,
    // and the receiver reports it rather than settling a command.
    const isolation = await dispatch(command('act-guarded-isolation'), admissionFor(command('act-guarded-isolation'), base => ({ ...base, commandView: { ...(base['commandView'] as Record<string, unknown>), isolationProfileRef: 'another-isolation-profile' } })));
    rows.push(
      row(
        'C06 the owner profile refuses a foreign isolation view before any claim, attempt or executor effect',
        !isolation.changed && isolation.journal.claims === isolation.beforeJournal.claims && isolation.journal.attempts === isolation.beforeJournal.attempts && isolation.result.outcome !== 'success',
        isolation.result,
      ),
    );

    // SPEC-W5-107: an admitted hostile command through the *same* production guard, receiver and
    // executor. Only this row proves a valid admission is not refused by the negative rows above, and
    // the hostile pytest must pass inside the container with the canonical view mounted read-only.
    const positiveAction = command('act-guarded-hostile');
    // The seeded ledgers carry one task and one run row per resource bound; `repositoryResourceSpecs`
    // requires exactly those ten refs, in task-first, configured-kind order.
    const resourceKinds = ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'] as const;
    const guardedProfile = executionProfileOf(task, assembly.profile.image.label, { taskId: GUARDED_TASK_ID, workspaceId: GUARDED_WORKSPACE_ID });
    const positiveAdmission = admissionFor(positiveAction, base => ({
      ...base,
      commandView: { ...(base['commandView'] as Record<string, unknown>), exclusionsPolicyVersion: guardedProfile.exclusionsPolicyVersion, scratchIdentity: guardedProfile.scratchIdentity, viewDigest: computeCommandViewDigest({ ...(base['commandView'] as Record<string, unknown>), exclusionsPolicyVersion: guardedProfile.exclusionsPolicyVersion, scratchIdentity: guardedProfile.scratchIdentity } as never) },
      finiteBounds: { ...guardedProfile.commandBounds, isolationProfileRef: assembly.profile.image.label },
      reservationRefs: (['task', 'run'] as const).flatMap(scope => resourceKinds.map(kind => `${scope}-${kind}-${positiveAction.actionId}`)),
    }));
    const admitted = await dispatch(positiveAction, positiveAdmission);
    const hostileResult = admitted.result as { readonly outcome: string; readonly result?: { readonly exitCode?: number | null; readonly stdout?: string; readonly plan?: { readonly executable?: string; readonly argv?: readonly string[] } } };
    const hostileExit = hostileResult.result?.exitCode;
    guardedEvidence['guardedHostile'] = {
      outcome: admitted.result.outcome,
      exitCode: hostileExit,
      argv: hostileResult.result?.plan?.argv,
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
  } finally {
    await assembly.controller.cleanup().catch(() => undefined);
    for (const volume of [computeWorkspaceVolumeIds(GUARDED_TASK_ID, GUARDED_WORKSPACE_ID).repoVolumeId, computeWorkspaceVolumeIds(GUARDED_TASK_ID, GUARDED_WORKSPACE_ID).scratchVolumeId]) {
      await structuredSpawn('docker', ['volume', 'rm', '-f', volume], { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 });
    }
    rmSync(root, { recursive: true, force: true });
  }
  return { rows, guardedHostile: guardedEvidence };
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
  const secondVolumes: string[] = [];

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
    // Injected environment never reaches the container: a credential-shaped key and an interpreter
    // loader hook are both refused by the production plan builder before any container is launched.
    rows.push(
      await refusalRow('C09 a credential-shaped environment variable refuses before dispatch', /FORBIDDEN_ENVIRONMENT_VARIABLE/u, () =>
        executor.execute({ workspaceId: WORKSPACE_ID, executable: 'pytest', argv: ['-q'], limits, env: { GITHUB_TOKEN: 'sentinel-not-a-real-token' } }),
      ),
    );
    rows.push(
      await refusalRow('C09 an interpreter loader hook refuses before dispatch', /LOADER_HOOK_FORBIDDEN/u, () =>
        executor.execute({ workspaceId: WORKSPACE_ID, executable: 'python3', argv: ['-V'], limits, env: { PYTHONSTARTUP: '/workspace/repo/src/leaky.py' } }),
      ),
    );
    rows.push(await linkEscapeRow());

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

    const memoryBytes = 64 * 1024 * 1024;
    const oom = await executor.execute({ workspaceId: WORKSPACE_ID, executable: 'python3', argv: ['-c', 'x=bytearray(2*1024**3)'], limits: { ...limits, maxMemoryBytes: memoryBytes } });
    const oomWitness = await dockerOomKilled(assembly, memoryBytes);
    evidence['memoryBound'] = { exitCode: oom.exitCode, timedOut: oom.timedOut, outcome: oom.outcome, durationMs: oom.durationMs, witness: oomWitness };
    // Two independent signals, both required: the controller's SIGKILL exit through the production
    // executor, and Docker's own `OOMKilled` observation. A generic error, a null exit or a launch
    // failure scores neither, so no infrastructure failure can read as memory enforcement.
    rows.push(
      row(
        'C10 memory over the admitted ceiling is killed by the kernel OOM killer',
        resourceKilled(oom, 'memory') && 'oomKilled' in oomWitness && oomWitness.oomKilled === true,
        evidence['memoryBound'],
      ),
    );

    const timeout = await executor.execute({ workspaceId: WORKSPACE_ID, executable: 'python3', argv: ['-c', 'import time; time.sleep(30)'], limits: { ...limits, timeoutMs: 2_000 } });
    evidence['timeoutBound'] = { exitCode: timeout.exitCode, timedOut: timeout.timedOut, outcome: timeout.outcome, durationMs: timeout.durationMs };
    // The timeout row requires an observed timeout verdict bounded by the admitted deadline, not merely
    // a nonzero exit or any null code.
    rows.push(row('C10 a command past its admitted timeout is killed within its deadline', resourceKilled(timeout, 'timeout', 2_000), evidence['timeoutBound']));

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
    const secondTaskId = 'task-t024-alt';
    const secondWorkspaceId = 'ws-t024-alt';
    const secondIds = computeWorkspaceVolumeIds(secondTaskId, secondWorkspaceId);
    secondVolumes.push(secondIds.repoVolumeId, secondIds.scratchVolumeId);
    await manager.createWorkspace({ taskId: secondTaskId, workspaceId: secondWorkspaceId, initialRevisionDigest: revision, profile: trusted });
    rows.push(
      await refusalRow('C11 a distinct task/workspace owns separate state and refuses its own absent view', /COMMAND_VIEW_REQUIRED/u, () =>
        executor.execute({ workspaceId: secondWorkspaceId, executable: 'pytest', argv: ['-q'], limits }),
      ),
    );
    rows.push(row('C11 the two tasks share no volume identity', secondIds.repoVolumeId !== repoVolumeId && secondIds.scratchVolumeId !== scratchVolumeId));

    // C11 invalidating the view removes execution authority for the first workspace.
    manager.invalidateViews(WORKSPACE_ID);
    rows.push(
      await refusalRow('C11 a workspace with no active view cannot execute', /COMMAND_VIEW_REQUIRED/u, () =>
        executor.execute({ workspaceId: WORKSPACE_ID, executable: 'pytest', argv: ['-q'], limits }),
      ),
    );
  } finally {
    await controller.cleanup().catch(() => undefined);
    for (const volume of [repoVolumeId, scratchVolumeId, ...(viewVolumeId === undefined ? [] : [viewVolumeId]), ...secondVolumes]) {
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
