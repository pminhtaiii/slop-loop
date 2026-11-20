/**
 * T062 contract test: disposable Docker grader executor (real-tier contract §(f) T062; rows 2, 5, 6).
 *
 * Every test runs the real host authority, final-tree port and executor over a fake spawn: no daemon.
 * It checks exact admission before any spawn, the isolated read-only copy, payload validation, forced
 * container removal, drift turning into not-run, and sanitized results.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { EvaluationGraderExecutionRequest, EvaluationGradingAdmission, EvaluationGradingProfile } from '../../../eval/uc03/types.ts';
import { parseWorkflowFinalTree, type FinalTreeBinding } from '../../../eval/uc03/workflow-evidence-facts.ts';
import { buildDockerGraderArgv } from '../../../src/foundation/docker-grader-executor.ts';
import type { StructuredSpawn, StructuredSpawnResult } from '../../../src/foundation/docker-controller.ts';
import { createRealTierGraderCapability } from '../../../src/runtime/real-tier-grader.ts';

const CHECK_ID = 'hidden-check-c01';
const EXECUTOR_ID = 'docker-grader-executor';
const IMAGE = { imageId: `sha256:${'b'.repeat(64)}`, platform: 'linux/amd64', user: '1000:1000' };
const PROFILE: EvaluationGradingProfile = {
  profileId: 'grading-profile-v1',
  digest: `sha256:${'c'.repeat(64)}`,
  bounds: { timeoutMs: 15_000, maxCpuMs: 10_000, maxOutputBytes: 65_536, maxMemoryBytes: 536_870_912, maxProcesses: 16 },
};
const BINDING: FinalTreeBinding = {
  taskId: 'task-1',
  runId: 'run-1',
  workspaceId: 'ws-1',
  repositoryId: 'repo-1',
  initialRevisionDigest: `sha256:${'1'.repeat(64)}`,
  finalRevisionDigest: `sha256:${'f'.repeat(64)}`,
};
const PAYLOAD = { files: { 'test_grade.py': 'PRIVATE_HIDDEN_BODY_MARKER' }, argv: ['pytest', '-q', '/grader/test_grade.py'] };

interface Calls {
  readonly runs: string[][];
  readonly removals: string[][];
  readonly copyFiles: string[];
  readonly graderFiles: string[];
}

function fakeSpawn(
  calls: Calls,
  result: Partial<StructuredSpawnResult> = {},
  during?: (mounts: { copy: string; grader: string }) => void,
  removal: Partial<StructuredSpawnResult> = {},
): StructuredSpawn {
  return async (_command, args) => {
    if (args[0] === 'rm') {
      calls.removals.push([...args]);
      return { exitCode: removal.exitCode ?? 0, stdout: '', stderr: removal.stderr ?? '', timedOut: removal.timedOut ?? false };
    }
    calls.runs.push([...args]);
    const copy = mountSource(args, '/workspace/repo');
    const grader = mountSource(args, '/grader');
    calls.copyFiles.push(readFileSync(join(copy, 'file1.txt'), 'utf8'));
    calls.graderFiles.push(readFileSync(join(grader, 'test_grade.py'), 'utf8'));
    during?.({ copy, grader });
    return { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? '1 passed in 0.42s', stderr: result.stderr ?? '', timedOut: result.timedOut ?? false };
  };
}

function mountSource(args: readonly string[], target: string): string {
  const mount = args.find(arg => arg.endsWith(`,target=${target},readonly`));
  assert.ok(mount, `read-only mount for ${target}`);
  return /source=(.*),target=/u.exec(mount)?.[1] ?? '';
}

function setup(spawnOptions: { result?: Partial<StructuredSpawnResult>; during?: (mounts: { copy: string; grader: string }) => void; removal?: Partial<StructuredSpawnResult> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 't062-exec-'));
  writeFileSync(join(root, 'file1.txt'), 'content 1');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'file2.txt'), 'content 2');
  const calls: Calls = { runs: [], removals: [], copyFiles: [], graderFiles: [] };
  const capability = createRealTierGraderCapability({ executorId: EXECUTOR_ID, spawn: fakeSpawn(calls, spawnOptions.result, spawnOptions.during, spawnOptions.removal) });
  capability.bindCase({ taskId: BINDING.taskId, repositoryRoot: root, profile: PROFILE, image: IMAGE });
  const parsed = parseWorkflowFinalTree(capability.finalTree.freezeFinalTree(BINDING), BINDING);
  assert.ok(parsed);
  const snapshot = parsed.snapshot;
  const admit = (): EvaluationGradingAdmission => {
    const admission = capability.isolationAuthority.admit({ checkId: CHECK_ID, finalSnapshot: snapshot, profile: PROFILE, executorId: EXECUTOR_ID });
    assert.ok(admission);
    return admission;
  };
  const execution = (admission: unknown, overrides: Partial<EvaluationGraderExecutionRequest> = {}): EvaluationGraderExecutionRequest => ({
    checkId: CHECK_ID,
    finalSnapshot: snapshot,
    profile: PROFILE,
    executorId: EXECUTOR_ID,
    admission: admission as EvaluationGradingAdmission,
    executor: capability.executor,
    graderPayload: PAYLOAD,
    ...overrides,
  });
  return {
    root,
    calls,
    capability,
    snapshot,
    admit,
    execution,
    run: (request: EvaluationGraderExecutionRequest) => capability.executor.execute(request),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('buildDockerGraderArgv sets network=none, read-only, cap-drop, mounts and resource bounds', () => {
  const argv = buildDockerGraderArgv({
    containerName: 'test-grader-123',
    imageId: IMAGE.imageId,
    snapshotMountPath: '/host/snapshot',
    graderMountPath: '/host/grader',
    bounds: PROFILE.bounds,
    command: ['pytest', '-q', '/grader/test.py'],
    workingDirectory: '/workspace/repo',
    platform: IMAGE.platform,
    user: IMAGE.user,
  });
  for (const expected of [
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--memory=${PROFILE.bounds.maxMemoryBytes}`,
    `--pids-limit=${PROFILE.bounds.maxProcesses}`,
    '--name=test-grader-123',
    '--user=1000:1000',
    '--platform=linux/amd64',
    IMAGE.imageId,
  ]) {
    assert.ok(argv.includes(expected), expected);
  }
  assert.ok(argv.includes('--mount=type=bind,source=/host/snapshot,target=/workspace/repo,readonly'));
  assert.ok(argv.includes('--mount=type=bind,source=/host/grader,target=/grader,readonly'));
});

test('Row (2): wrong check, snapshot, profile, bounds or executor refuse before any spawn', async () => {
  const s = setup();
  try {
    const admission = s.admit();
    const wrongs: Partial<EvaluationGraderExecutionRequest>[] = [
      { checkId: 'wrong-check-id' },
      { finalSnapshot: { snapshotId: 'wrong-id', digest: s.snapshot.digest } },
      { finalSnapshot: { snapshotId: s.snapshot.snapshotId, digest: `sha256:${'9'.repeat(64)}` } },
      { profile: { ...PROFILE, profileId: 'other-profile' } },
      { profile: { ...PROFILE, bounds: { ...PROFILE.bounds, timeoutMs: 99_999 } } },
      { executorId: 'other-executor-id' },
    ];
    for (const wrong of wrongs) assert.equal(await s.run(s.execution(admission, wrong)), undefined, JSON.stringify(Object.keys(wrong)));
    assert.equal(s.calls.runs.length + s.calls.removals.length, 0, 'no spawn of any kind');
  } finally {
    s.done();
  }
});

test('Row (2): stale, structurally copied and hand-built admissions refuse; one current admission dispatches exactly once', async () => {
  const s = setup();
  try {
    const first = s.admit();
    const second = s.admit();
    assert.equal(await s.run(s.execution(first)), undefined, 'stale');
    assert.equal(await s.run(s.execution({ ...second })), undefined, 'copied');
    assert.equal(
      await s.run(s.execution({ kind: 'host-isolation-admission', admissionId: 'adm-forged-1234', checkId: CHECK_ID, finalSnapshot: s.snapshot, profile: PROFILE, executorId: EXECUTOR_ID })),
      undefined,
      'hand-built',
    );
    assert.equal(s.calls.runs.length, 0);
    const valid = await s.run(s.execution(second));
    assert.equal(valid?.status, 'pass');
    assert.equal(s.calls.runs.length, 1, 'dispatched exactly once');
    assert.equal(await s.run(s.execution(second)), undefined, 'a settled admission is reused');
    assert.equal(s.calls.runs.length, 1);
  } finally {
    s.done();
  }
});

test('F4: an executor over a capability with nothing bound never runs', async () => {
  const s = setup();
  try {
    const admission = s.admit();
    s.capability.bindCase({ taskId: 'task-other', repositoryRoot: s.root, profile: PROFILE, image: IMAGE });
    assert.equal(await s.run(s.execution(admission)), undefined, 'the rebind made the admission stale');
    assert.equal(s.calls.runs.length, 0);
  } finally {
    s.done();
  }
});

test('F5: the container sees an isolated read-only copy, not the bound root, and everything is removed afterwards', async () => {
  const s = setup();
  try {
    const result = await s.run(s.execution(s.admit()));
    assert.equal(result?.status, 'pass');
    const args = s.calls.runs[0] as string[];
    const copy = mountSource(args, '/workspace/repo');
    const grader = mountSource(args, '/grader');
    assert.notEqual(copy, s.root);
    assert.notEqual(copy, grader);
    assert.ok(args.includes('--network=none'));
    assert.deepEqual(s.calls.copyFiles, ['content 1']);
    assert.deepEqual(s.calls.graderFiles, ['PRIVATE_HIDDEN_BODY_MARKER']);
    assert.deepEqual(args.slice(-3), PAYLOAD.argv, 'the payload argv is what runs');
    assert.ok(args.includes(IMAGE.imageId) && args.includes(`--platform=${IMAGE.platform}`) && args.includes(`--user=${IMAGE.user}`), 'image, platform and user come from the pins');
    assert.equal(existsSync(copy) || existsSync(grader), false, 'both temporary directories are removed');
    assert.equal(s.calls.removals.length, 1);
    assert.deepEqual(s.calls.removals[0], ['rm', '-f', (args.find(arg => arg.startsWith('--name=')) as string).slice('--name='.length)]);
  } finally {
    s.done();
  }
});

test('F5: an invalid grader payload is not-run with zero spawns', async () => {
  const s = setup();
  try {
    const bad: unknown[] = [
      null,
      { files: {}, argv: [] },
      { files: { '../escape.py': 'x' }, argv: ['pytest'] },
      { files: { '/abs.py': 'x' }, argv: ['pytest'] },
      { files: { 'a/../b.py': 'x' }, argv: ['pytest'] },
      { files: { 'ok.py': 1 }, argv: ['pytest'] },
      { files: { 'ok.py': 'x' }, argv: [1] },
    ];
    for (const payload of bad) assert.equal(await s.run(s.execution(s.admit(), { graderPayload: payload })), undefined, JSON.stringify(payload));
    assert.equal(s.calls.runs.length + s.calls.removals.length, 0);
  } finally {
    s.done();
  }
});

test('F5: docker rm -f is issued even when docker run reports a timeout, and a failed removal is not-run', async () => {
  const timedOut = setup({ result: { timedOut: true, exitCode: 124 } });
  try {
    const result = await timedOut.run(timedOut.execution(timedOut.admit()));
    assert.equal(result?.exitReason, 'timeout');
    assert.equal(timedOut.calls.removals.length, 1, 'the container is force-removed');
  } finally {
    timedOut.done();
  }
  const stuck = setup({ removal: { exitCode: 1, stderr: 'Error: removal in progress' } });
  try {
    assert.equal(await stuck.run(stuck.execution(stuck.admit())), undefined, 'a cleanup failure is not-run, not a grade');
    assert.equal(stuck.calls.runs.length, 1);
  } finally {
    stuck.done();
  }
});

test('Row (5): live-tree mutation before or during the attempt turns the grade into not-run', async () => {
  const before = setup();
  try {
    const admission = before.admit();
    writeFileSync(join(before.root, 'file1.txt'), 'mutated before');
    assert.equal(await before.run(before.execution(admission)), undefined);
    assert.equal(before.calls.runs.length, 0, 'refused before the spawn');
  } finally {
    before.done();
  }
  let live = '';
  const during = setup({ during: () => writeFileSync(join(live, 'file1.txt'), 'mutated during') });
  live = during.root;
  try {
    assert.equal(await during.run(during.execution(during.admit())), undefined);
    assert.equal(during.calls.runs.length, 1);
    assert.equal(during.calls.removals.length, 1);
  } finally {
    during.done();
  }
});

test('Row (5): a mutation of the isolated copy during the attempt turns the grade into not-run', async () => {
  const s = setup({ during: ({ copy }) => writeFileSync(join(copy, 'file1.txt'), 'tampered copy') });
  try {
    assert.equal(await s.run(s.execution(s.admit())), undefined);
    assert.equal(s.calls.runs.length, 1);
    assert.equal(s.calls.removals.length, 1);
  } finally {
    s.done();
  }
});

test('Row (6): exit and kill reasons are sanitized and no private grader bytes reach the result', async () => {
  const cases: { result: Partial<StructuredSpawnResult>; status: string; exit: string; kill: string | undefined }[] = [
    { result: { exitCode: 0 }, status: 'pass', exit: 'clean-exit', kill: undefined },
    { result: { exitCode: 1, stderr: 'AssertionError: PRIVATE_HIDDEN_BODY_MARKER' }, status: 'fail', exit: 'exit-1', kill: 'failed-check' },
    { result: { exitCode: 137 }, status: 'fail', exit: 'exit-137', kill: 'oom-or-sigkill' },
    { result: { timedOut: true, exitCode: 124 }, status: 'fail', exit: 'timeout', kill: 'timeout' },
  ];
  for (const expected of cases) {
    const s = setup({ result: expected.result });
    try {
      const result = await s.run(s.execution(s.admit()));
      assert.equal(result?.status, expected.status);
      assert.equal(result?.exitReason, expected.exit);
      assert.equal(result?.killReason, expected.kill);
      assert.ok(!JSON.stringify(result).includes('PRIVATE_HIDDEN'), 'no private grader bytes in the result');
    } finally {
      s.done();
    }
  }
});
