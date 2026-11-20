/**
 * T062 row (3): the real Docker grading probe (real-tier contract §(d), §(f)).
 *
 * `node dist/tests/runtime/security/uc03-real-grader-probe.js` with `UC03_REAL_TIER_PROFILE` set grades a
 * small temp final tree through the production route (`executeMockPrivateGrading` with the real-tier
 * authority and Docker executor). Exit 0 only when every row passes; 1 on a failed row; 3 for not-run
 * (no profile, no daemon, no local image). It makes zero model calls and never pulls an image.
 * `--self-check` scores a deliberately failed row through the same report path and exits 1.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { executeMockPrivateGrading } from '../../../eval/uc03/grading.ts';
import type { EvaluationGradingBounds, EvaluationGradingProfile, SafeEvaluationGradingResult } from '../../../eval/uc03/types.ts';
import { parseWorkflowFinalTree, type FinalTreeBinding } from '../../../eval/uc03/workflow-evidence-facts.ts';
import { computeCpus } from '../../../src/foundation/docker-grader-executor.ts';
import { structuredSpawn } from '../../../src/foundation/docker-spawn.ts';
import type { StructuredSpawn } from '../../../src/foundation/docker-controller.ts';
import { loadRealTierProfile } from '../../../src/runtime/real-tier-profile.ts';
import { createRealTierGraderCapability } from '../../../src/runtime/real-tier-grader.ts';

interface Row {
  readonly case: string;
  readonly ok: boolean;
  readonly detail?: unknown;
}

interface Image {
  readonly imageId: string;
  readonly platform: string;
  readonly user: string;
}

const selfCheck = process.argv.includes('--self-check');
let probeFile: string | undefined;

function emit(status: 'pass' | 'fail' | 'not-run', payload: Record<string, unknown>): void {
  const text = JSON.stringify({ task: 'T062', status, ...payload }, null, 2);
  if (probeFile !== undefined) writeFileSync(probeFile, `${text}\n`, 'utf8');
  console.log(text);
}

/** One scorer for real rows and the self-check row: a failed row is a fail with exit 1. */
function report(rows: readonly Row[], evidence: Record<string, unknown>): void {
  const failed = rows.filter(r => !r.ok).map(r => r.case);
  emit(failed.length === 0 ? 'pass' : 'fail', { rows, failed, ...evidence });
  process.exitCode = failed.length === 0 ? 0 : 1;
}

const row = (caseName: string, ok: boolean, detail?: unknown): Row => ({ case: caseName, ok, detail });
const sha = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const quick = { timeoutMs: 30_000, maxOutputBytes: 4096 } as const;

/** Wraps the real spawn and records every docker call; the executor's `docker rm` calls count as spawns. */
function recorder(): { readonly spawn: StructuredSpawn; readonly calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    spawn: (command, args, options) => {
      calls.push([...args]);
      return structuredSpawn(command, args, options);
    },
  };
}

const TASK: FinalTreeBinding = {
  taskId: 't062-probe',
  runId: 'run-t062-probe',
  workspaceId: 'ws-t062-probe',
  repositoryId: 'repo-t062-probe',
  initialRevisionDigest: `sha256:${'1'.repeat(64)}`,
  finalRevisionDigest: `sha256:${'2'.repeat(64)}`,
};
const CALC = 'def add(a, b):\n    return a + b\n';
const TREE: Record<string, string> = { 'calc.py': CALC, 'tests/test_calc.py': 'from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n' };
const PYTEST = ['python3', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--rootdir=/grader', '/grader/test_hidden.py'];

const HEAD = 'import os, socket, time\nimport pytest\nfrom calc import add\n\n\n';
const WALK = "sorted(os.path.relpath(os.path.join(d, f), '/workspace/repo') for d, _, fs in os.walk('/workspace/repo') for f in fs if '__pycache__' not in d)";

function hiddenChecks(hostTree: string): Record<string, string> {
  return {
    pass: `${HEAD}def test_add():\n    assert add(2, 3) == 5\n`,
    fail: `${HEAD}def test_wrong():\n    assert add(2, 3) == 6\n`,
    snapshot:
      `${HEAD}def test_only_snapshot():\n    assert ${WALK} == ['calc.py', 'tests/test_calc.py']\n` +
      `    assert [f for f in os.listdir('/grader') if f != '__pycache__'] == ['test_hidden.py']\n` +
      `    assert not os.path.exists('/workspace/repo/.git')\n    assert not os.path.exists(${JSON.stringify(hostTree)})\n`,
    network: `${HEAD}def test_no_network():\n    with pytest.raises(OSError):\n        socket.create_connection(('192.0.2.1', 80), timeout=3)\n`,
    readonly:
      `${HEAD}def test_read_only():\n    for target in ('/workspace/repo/new.txt', '/workspace/repo/calc.py', '/grader/new.txt', '/etc/new.txt'):\n` +
      `        with pytest.raises(OSError):\n            open(target, 'w')\n`,
    timeout: `${HEAD}def test_sleeps():\n    time.sleep(120)\n`,
  };
}

interface Attempt {
  readonly result: SafeEvaluationGradingResult | undefined;
  readonly spawns: number;
  readonly runArgv: readonly string[][];
  readonly container: string | undefined;
  readonly mountDirs: readonly string[];
}

/** Grades `source` through the production route; `bind` false is the unbound refusal, `drift` mutates the tree after the freeze. */
async function attempt(options: {
  readonly bind: boolean;
  readonly drift?: boolean;
  readonly source: string;
  readonly treeDir: string;
  readonly profile: EvaluationGradingProfile;
  readonly image: Image;
}): Promise<Attempt> {
  const rec = recorder();
  const capability = createRealTierGraderCapability({ spawn: rec.spawn });
  let snapshot = { snapshotId: 'snapshot-unbound', digest: `sha256:${'0'.repeat(64)}` };
  if (options.bind) {
    capability.bindCase({ taskId: TASK.taskId, repositoryRoot: options.treeDir, profile: options.profile, image: options.image });
    const parsed = parseWorkflowFinalTree(capability.finalTree.freezeFinalTree(TASK), TASK);
    assert.ok(parsed, 'the temp tree must freeze');
    snapshot = parsed.snapshot;
  }
  if (options.drift) appendFileSync(join(options.treeDir, 'calc.py'), '# drift\n');
  const result = await executeMockPrivateGrading({
    checkId: 'hidden-check',
    finalSnapshot: snapshot,
    profile: options.profile,
    graderPayload: { files: { 'test_hidden.py': options.source }, argv: PYTEST },
    isolationAuthority: capability.isolationAuthority,
    executor: capability.executor,
  });
  const run = rec.calls.find(args => args[0] === 'run') ?? [];
  return {
    result,
    spawns: rec.calls.length,
    runArgv: rec.calls.filter(args => args[0] === 'run'),
    container: run.find(a => a.startsWith('--name='))?.slice('--name='.length),
    mountDirs: run.filter(a => a.startsWith('--mount=')).map(a => /source=([^,]+),/u.exec(a)?.[1] ?? ''),
  };
}

/** Argv with the temp mount paths replaced by placeholders. */
function redact(argv: readonly string[], mountDirs: readonly string[]): string[] {
  const names = ['<snapshot-copy>', '<grader-private>'];
  return argv.map(a => mountDirs.reduce((text, dir, i) => (dir === '' ? text : text.replace(dir, names[i] ?? '<dir>')), a));
}

async function containerGone(name: string | undefined): Promise<boolean> {
  if (name === undefined) return false;
  const ps = await structuredSpawn('docker', ['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}'], quick);
  return ps.exitCode === 0 && ps.stdout.trim() === '';
}

const expectedFlags = (bounds: EvaluationGradingBounds): string[] => [
  '--network=none',
  '--read-only',
  '--cap-drop=ALL',
  `--memory=${bounds.maxMemoryBytes}`,
  `--cpus=${computeCpus(bounds).cpusArg}`,
  `--pids-limit=${bounds.maxProcesses}`,
];

async function runRows(profile: EvaluationGradingProfile, image: Image, treeDir: string): Promise<{ rows: Row[]; hashes: Record<string, string> }> {
  const rows: Row[] = [];
  const checks = hiddenChecks(treeDir);
  const hashes = Object.fromEntries(Object.entries(checks).map(([name, source]) => [name, sha(source)]));
  const shortBounds: EvaluationGradingBounds = { ...profile.bounds, timeoutMs: 5000, maxCpuMs: 5000 };
  const shortProfile: EvaluationGradingProfile = { profileId: 't062-probe-short', digest: sha(JSON.stringify(shortBounds)), bounds: shortBounds };

  const container = async (name: string, expected: 'pass' | 'fail', extra: (a: Attempt) => boolean = () => true, using = profile): Promise<Attempt> => {
    const a = await attempt({ bind: true, source: checks[name] ?? '', treeDir, profile: using, image });
    const gone = await containerGone(a.container);
    const dirsGone = a.mountDirs.length === 2 && a.mountDirs.every(dir => !existsSync(dir));
    const ok = a.result?.status === expected && a.runArgv.length === 1 && gone && dirsGone && extra(a);
    rows.push(
      row(name, ok, {
        status: a.result?.status,
        exitReason: a.result?.exitReason,
        killReason: a.result?.killReason,
        durationMs: a.result?.durationMs,
        admissionKind: a.result?.admissionKind,
        admissionId: a.result?.admissionId,
        argv: redact(a.runArgv[0] ?? [], a.mountDirs),
        cleanup: { containerRemoved: gone, mountDirsRemoved: dirsGone },
        checkSha256: hashes[name],
      }),
    );
    return a;
  };

  const passed = await container('pass', 'pass', a => a.result?.admissionKind === 'host-isolation-admission' && /^adm-/u.test(a.result.admissionId ?? '') && a.result.exitReason === 'clean-exit');
  await container('fail', 'fail', a => a.result?.exitReason === 'exit-1');
  await container('snapshot', 'pass');
  await container('network', 'pass');
  await container('readonly', 'pass');
  // The recorded argv is the finite-resource evidence: every flag present, with the admitted bounds as values.
  const missing = expectedFlags(profile.bounds).filter(f => !(passed.runArgv[0] ?? []).includes(f));
  rows.push(row('finite-resources', missing.length === 0 && Object.values(profile.bounds).every(Number.isFinite), { missing, bounds: profile.bounds }));
  await container('timeout', 'fail', a => a.result?.exitReason === 'timeout' && a.result.killReason === 'timeout', shortProfile);

  const unbound = await attempt({ bind: false, source: checks['pass'] ?? '', treeDir, profile, image });
  rows.push(row('refusal-unbound', unbound.result === undefined && unbound.spawns === 0, { spawns: unbound.spawns }));
  const drifted = await attempt({ bind: true, drift: true, source: checks['pass'] ?? '', treeDir, profile, image });
  writeFileSync(join(treeDir, 'calc.py'), CALC);
  rows.push(row('refusal-drift', drifted.result === undefined && drifted.spawns === 0, { spawns: drifted.spawns }));
  return { rows, hashes };
}

async function main(): Promise<void> {
  const fetchCalls = { count: 0 };
  globalThis.fetch = (async () => {
    fetchCalls.count += 1;
    throw new Error('the T062 grader probe makes no model calls');
  }) as typeof globalThis.fetch;
  // A loader refusal, including a missing credential, is not-run; the credential is never read here.
  const loaded = loadRealTierProfile(process.env);
  if (!loaded.ok) {
    emit('not-run', { reason: loaded.reasonCode, path: loaded.path, detail: 'operator profile unavailable; see real-tier contract §(d)' });
    process.exitCode = 3;
    return;
  }
  const { image, limits } = loaded.value;
  const notRun = (reason: string): void => {
    emit('not-run', { reason, imageId: image.imageId, detail: 'Docker daemon or pinned image unavailable; never a pass' });
    process.exitCode = 3;
  };
  const daemon = await structuredSpawn('docker', ['version', '--format', '{{.Server.Version}}'], quick).catch(() => undefined);
  if (daemon === undefined || daemon.exitCode !== 0) return notRun('docker-daemon-unavailable');
  const present = await structuredSpawn('docker', ['image', 'inspect', '--format', '{{.Id}}', image.imageId], quick);
  if (present.exitCode !== 0) return notRun('pinned-image-absent');

  const timeoutMs = Math.min(limits.commandTimeoutMs, 120_000);
  const bounds: EvaluationGradingBounds = {
    timeoutMs,
    // shortcut: one CPU of quota; the profile's cpu count would exceed the grading ceiling, upgrade with the grading profile.
    maxCpuMs: timeoutMs,
    maxOutputBytes: Math.min(limits.outputBytes, 1_048_576),
    maxMemoryBytes: Math.min(limits.memoryBytes, 1_073_741_824),
    maxProcesses: Math.min(limits.processes, 32),
  };
  const profile: EvaluationGradingProfile = { profileId: 't062-probe-profile', digest: sha(JSON.stringify(bounds)), bounds };

  const treeDir = mkdtempSync(join(tmpdir(), 't062-probe-tree-'));
  let outcome: { rows: Row[]; hashes: Record<string, string> };
  try {
    for (const [path, body] of Object.entries(TREE)) {
      mkdirSync(dirname(join(treeDir, path)), { recursive: true });
      writeFileSync(join(treeDir, path), body, { mode: 0o600 });
    }
    const dir = join(process.cwd(), '.agent-work', new Date().toISOString().slice(0, 10), 'uc03-real-tier', 'evidence', 'T062');
    const ignored = await structuredSpawn('git', ['check-ignore', '-q', dir], quick);
    assert.equal(ignored.exitCode, 0, 'the evidence directory must be gitignored');
    mkdirSync(dir, { recursive: true });
    probeFile = join(dir, 'probe.json');
    outcome = await runRows(profile, image, treeDir);
  } catch (error) {
    emit('fail', { failed: ['probe'], detail: error instanceof Error ? error.message.slice(0, 400) : 'probe failed' });
    process.exitCode = 1;
    return;
  } finally {
    rmSync(treeDir, { recursive: true, force: true });
  }
  report([...outcome.rows, row('zero-fetches', fetchCalls.count === 0, { fetches: fetchCalls.count })], {
    imageId: image.imageId,
    platform: image.platform,
    user: image.user,
    dockerServerVersion: daemon.stdout.trim(),
    fetches: fetchCalls.count,
    checkSha256: outcome.hashes,
  });
}

if (selfCheck) {
  report([row('SELF-CHECK deliberate red row', false, 'a failed row must never pass')], { selfCheck: true });
} else {
  await main();
}
