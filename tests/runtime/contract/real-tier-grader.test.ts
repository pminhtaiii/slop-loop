/**
 * T062 contract test: real-tier host authority and production final-tree port (real-tier contract §(f) T062).
 *
 * The authority fails closed until a case is bound, admits only the exact frozen snapshot, pinned profile
 * and bounds, executor and check, and a new bind makes earlier admissions stale. The final-tree port
 * freezes the bound root, reports drift, and records symlinks instead of following them.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { BugTask } from '../../../src/contracts/foundation/uc03.ts';
import type { RealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import type { UC03WorkflowResult } from '../../../src/uc03/graph-types.ts';
import { resolvePinnedGrader, type CaseGradeRequest } from '../integration/uc03-success-real-grader.ts';

import type { EvaluationGradingProfile, EvaluationSnapshotIdentity } from '../../../eval/uc03/types.ts';
import { isHostAdmission } from '../../../eval/uc03/grading.ts';
import { parseWorkflowFinalTree, type FinalTreeBinding } from '../../../eval/uc03/workflow-evidence-facts.ts';
import { createHostIsolationAuthority, createRealTierGraderCapability, type TreeDirent } from '../../../src/runtime/real-tier-grader.ts';

const CHECK_ID = 'hidden-c01-check';
const EXECUTOR_ID = 'docker-grader-exec-1';
const PROFILE: EvaluationGradingProfile = {
  profileId: 'grading-profile-v1',
  digest: `sha256:${'2'.repeat(64)}`,
  bounds: { timeoutMs: 10_000, maxCpuMs: 5_000, maxOutputBytes: 32_768, maxMemoryBytes: 268_435_456, maxProcesses: 8 },
};
const IMAGE = { imageId: `sha256:${'b'.repeat(64)}`, platform: 'linux/amd64', user: '1000:1000' };
// The pinned user is 1000:1000; a fixed host uid keeps success rows independent of the CI runner uid.
const PINNED_UID = (): number => 1000;
const BINDING: FinalTreeBinding = {
  taskId: 'task-1',
  runId: 'run-1',
  workspaceId: 'ws-1',
  repositoryId: 'repo-1',
  initialRevisionDigest: `sha256:${'1'.repeat(64)}`,
  finalRevisionDigest: `sha256:${'f'.repeat(64)}`,
};

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 't062-tree-'));
  writeFileSync(join(dir, 'file1.txt'), 'content 1');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'file2.txt'), 'content 2');
  return dir;
}

function bound(root: string) {
  const capability = createRealTierGraderCapability({ getuid: PINNED_UID, executorId: EXECUTOR_ID });
  capability.bindCase({ taskId: BINDING.taskId, repositoryRoot: root, profile: PROFILE, image: IMAGE });
  return capability;
}

function snapshotOf(tree: unknown): EvaluationSnapshotIdentity {
  const parsed = parseWorkflowFinalTree(tree, BINDING);
  assert.ok(parsed, 'the port returns a tree the grader can parse');
  return parsed.snapshot;
}

const request = (snapshot: EvaluationSnapshotIdentity, overrides: Record<string, unknown> = {}) => ({
  checkId: CHECK_ID,
  finalSnapshot: snapshot,
  profile: PROFILE,
  executorId: EXECUTOR_ID,
  ...overrides,
});

test('F2: an authority with nothing bound refuses every request', () => {
  const authority = createHostIsolationAuthority({ executorId: EXECUTOR_ID });
  const snapshot = { snapshotId: 'snap-1', digest: `sha256:${'1'.repeat(64)}` };
  assert.equal(authority.admit(request(snapshot)), undefined);
  // Bound, but no tree was frozen yet, so there is no snapshot to admit.
  authority.bind({ profile: PROFILE, finalSnapshot: () => undefined });
  assert.equal(authority.admit(request(snapshot)), undefined);
});

test('exact admission registers provenance; a structural copy is not the issued admission', () => {
  const root = makeRoot();
  try {
    const capability = bound(root);
    const snapshot = snapshotOf(capability.finalTree.freezeFinalTree(BINDING));
    const admission = capability.isolationAuthority.admit(request(snapshot));
    assert.ok(admission);
    assert.equal(admission.kind, 'host-isolation-admission');
    assert.ok(admission.admissionId.startsWith('adm-'));
    assert.equal(capability.isolationAuthority.isCurrentAdmission(admission), true);
    assert.equal(isHostAdmission(capability.isolationAuthority, admission), true);
    assert.equal(isHostAdmission(capability.isolationAuthority, { ...admission }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('F2: after bind the request must equal the frozen snapshot, pinned profile, bounds, executor and a safe check id', () => {
  const root = makeRoot();
  try {
    const capability = bound(root);
    const snapshot = snapshotOf(capability.finalTree.freezeFinalTree(BINDING));
    const admit = (overrides: Record<string, unknown>) => capability.isolationAuthority.admit(request(snapshot, overrides));
    assert.equal(admit({ finalSnapshot: { snapshotId: snapshot.snapshotId, digest: `sha256:${'9'.repeat(64)}` } }), undefined, 'a snapshot that is not the frozen tree');
    assert.equal(admit({ finalSnapshot: { snapshotId: 'other-id', digest: snapshot.digest } }), undefined, 'a snapshot id that is not the frozen tree');
    assert.equal(admit({ profile: { ...PROFILE, digest: `sha256:${'3'.repeat(64)}` } }), undefined, 'a profile digest that is not pinned');
    assert.equal(admit({ profile: { ...PROFILE, profileId: 'other-profile' } }), undefined);
    for (const key of Object.keys(PROFILE.bounds) as (keyof typeof PROFILE.bounds)[]) {
      assert.equal(admit({ profile: { ...PROFILE, bounds: { ...PROFILE.bounds, [key]: PROFILE.bounds[key] + 1 } } }), undefined, `a changed ${key} bound`);
    }
    assert.equal(admit({ executorId: 'other-exec' }), undefined);
    for (const checkId of ['../x', 'a/b', '', '.hidden', 'a'.repeat(65)]) assert.equal(admit({ checkId }), undefined, `check id ${JSON.stringify(checkId)}`);
    assert.ok(admit({}), 'the exact request is admitted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('F2: a second bind makes the first case admission stale and unfreezes the snapshot', () => {
  const root = makeRoot();
  try {
    const capability = bound(root);
    const snapshot = snapshotOf(capability.finalTree.freezeFinalTree(BINDING));
    const first = capability.isolationAuthority.admit(request(snapshot));
    assert.ok(first);
    capability.bindCase({ taskId: BINDING.taskId, repositoryRoot: root, profile: PROFILE, image: IMAGE });
    assert.equal(capability.isolationAuthority.isCurrentAdmission(first), false);
    assert.equal(capability.isolationAuthority.admit(request(snapshot)), undefined, 'nothing is frozen for the new case yet');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('F3: an unbound task or a missing root freezes to nothing', () => {
  const root = makeRoot();
  try {
    const capability = bound(root);
    assert.equal(capability.finalTree.freezeFinalTree({ ...BINDING, taskId: 'task-unbound' }), undefined);
    assert.equal(createRealTierGraderCapability().finalTree.freezeFinalTree(BINDING), undefined, 'nothing bound');
    capability.bindCase({ taskId: BINDING.taskId, repositoryRoot: join(root, 'absent'), profile: PROFILE, image: IMAGE });
    assert.equal(capability.finalTree.freezeFinalTree(BINDING), undefined);
    assert.equal(capability.finalTree.recheckCurrentFinalTree(BINDING, { snapshotId: 's', digest: 'd' }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the final-tree port freezes the bound root and a mutation changes the rechecked identity', () => {
  const root = makeRoot();
  try {
    const capability = bound(root);
    const frozen = capability.finalTree.freezeFinalTree(BINDING) as { files: { path: string }[] };
    assert.deepEqual(
      frozen.files.map(file => file.path),
      ['file1.txt', 'sub/file2.txt'],
    );
    const snapshot = snapshotOf(frozen);
    assert.deepEqual(snapshotOf(capability.finalTree.recheckCurrentFinalTree(BINDING, snapshot)), snapshot);
    writeFileSync(join(root, 'file1.txt'), 'mutated');
    assert.notEqual(snapshotOf(capability.finalTree.recheckCurrentFinalTree(BINDING, snapshot)).digest, snapshot.digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C4: a tree containing a symlink or non-file entry returns undefined on freeze and recheck', () => {
  const root = makeRoot();
  try {
    let injectEntry: 'symlink' | 'other' | 'none' = 'none';
    const capability = createRealTierGraderCapability({
      getuid: PINNED_UID,
      executorId: EXECUTOR_ID,
      readEntries: (dir: string) => {
        const entries: TreeDirent[] = [...readdirSync(dir, { withFileTypes: true })];
        if (dir === root && injectEntry !== 'none') {
          entries.push({
            name: injectEntry === 'symlink' ? 'link.txt' : 'fifo.pipe',
            isFile: () => false,
            isDirectory: () => false,
            isSymbolicLink: () => injectEntry === 'symlink',
          });
        }
        return entries;
      },
    });
    capability.bindCase({ taskId: BINDING.taskId, repositoryRoot: root, profile: PROFILE, image: IMAGE });

    // When freeze sees a symlink, it returns undefined
    injectEntry = 'symlink';
    assert.equal(capability.finalTree.freezeFinalTree(BINDING), undefined);

    // When freeze sees a non-file, non-directory entry, it returns undefined
    injectEntry = 'other';
    assert.equal(capability.finalTree.freezeFinalTree(BINDING), undefined);

    // Without special entries, freeze succeeds
    injectEntry = 'none';
    const frozen = capability.finalTree.freezeFinalTree(BINDING);
    assert.ok(frozen);
    const snapshot = snapshotOf(frozen);

    // If a symlink appears before recheck, recheck returns undefined
    injectEntry = 'symlink';
    assert.equal(capability.finalTree.recheckCurrentFinalTree(BINDING, snapshot), undefined);

    // If a non-file entry appears before recheck, recheck returns undefined
    injectEntry = 'other';
    assert.equal(capability.finalTree.recheckCurrentFinalTree(BINDING, snapshot), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C5: a tree containing an executable regular file returns undefined on POSIX', t => {
  if (process.platform === 'win32') {
    t.skip('executable permission bits are synthetic on Windows');
    return;
  }
  const root = makeRoot();
  try {
    const capability = bound(root);
    chmodSync(join(root, 'file1.txt'), 0o755);
    assert.equal(capability.finalTree.freezeFinalTree(BINDING), undefined);

    chmodSync(join(root, 'file1.txt'), 0o644);
    const frozen = capability.finalTree.freezeFinalTree(BINDING);
    assert.ok(frozen);
    const snapshot = snapshotOf(frozen);

    chmodSync(join(root, 'file1.txt'), 0o755);
    assert.equal(capability.finalTree.recheckCurrentFinalTree(BINDING, snapshot), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createRealTierGraderCapability bundles real-tier authority, executor and finalTree', () => {
  const capability = createRealTierGraderCapability({ getuid: PINNED_UID, executorId: EXECUTOR_ID });
  assert.equal(capability.tier, 'real-tier');
  assert.equal(capability.executor.executorId, EXECUTOR_ID);
  assert.ok(capability.isolationAuthority);
  assert.ok(capability.finalTree);
});

test('F3: resolvePinnedGrader binds the case, grades through the real authority and executor, and an unbound root is not-run', async () => {
  const root = makeRoot();
  const meta = mkdtempSync(join(tmpdir(), 't062-meta-'));
  try {
    const raw = JSON.stringify({
      criteria: { digest: PROFILE.digest, criteria: [{ criterionId: 'criterion-C01', caseId: 'C01', predicate: 'repair-success', hiddenCheckId: CHECK_ID }] },
      profile: PROFILE,
      graderPayload: { files: { 'test_grade.py': 'x' }, argv: ['pytest', '-q', '/grader/test_grade.py'] },
    });
    writeFileSync(join(meta, 'grader.json'), raw);
    const catalogPath = join(meta, 'catalog.json');
    writeFileSync(catalogPath, JSON.stringify({ catalog: [{ caseId: 'C01', grader: { path: join(meta, 'grader.json'), digest: `sha256:${sha256Text(raw)}` } }] }));
    const assembly = { profile: { catalog: { path: catalogPath }, image: { platform: IMAGE.platform, user: IMAGE.user } }, metadata: { imageId: IMAGE.imageId } } as unknown as RealTierAssembly;
    const runs: string[][] = [];
    const base = createRealTierGraderCapability({
      getuid: PINNED_UID,
      executorId: EXECUTOR_ID,
      spawn: async (_command, args) => {
        if (args[0] === 'run') runs.push([...args]);
        return { exitCode: 0, stdout: '1 passed', stderr: '', timedOut: false };
      },
    });
    const diff = `sha256:${'d'.repeat(64)}`;
    const capability = {
      ...base,
      deriveFacts: async (input: { finalTree: typeof base.finalTree }) => {
        const parsed = parseWorkflowFinalTree(await input.finalTree.freezeFinalTree(BINDING), BINDING);
        if (parsed === undefined) return undefined;
        return {
          snapshot: parsed.snapshot,
          evidence: {
            digest: `sha256:${sha256Text(parsed.snapshot.digest)}`,
            snapshotDigest: parsed.snapshot.digest,
            diffDigest: diff,
            baselineFailed: true,
            requiredChecksPassed: true,
            focusedCheckPassed: true,
            testsProtected: true,
            reviewAccepted: true,
            reviewedDiffDigest: diff,
            sentinelsUnchanged: true,
            speculativePatchApplied: false,
            stoppedBeforeEffect: false,
            completionWithheld: false,
          },
        };
      },
    };
    const resolution = resolvePinnedGrader(assembly, 'C01', capability);
    assert.equal(resolution.status, 'ready');
    if (resolution.status !== 'ready') return;
    const state = { taskId: BINDING.taskId, runId: BINDING.runId, workspaceId: BINDING.workspaceId, repositoryId: BINDING.repositoryId, repositoryRevisionDigest: BINDING.finalRevisionDigest };
    const gradeRequest = (repositoryRoot: string): CaseGradeRequest => ({
      caseId: 'C01',
      task: { taskId: BINDING.taskId, repositoryId: BINDING.repositoryId, initialRevisionDigest: BINDING.initialRevisionDigest } as unknown as BugTask,
      result: { outcome: 'COMPLETED', state, executionEvidence: { finalState: state } } as unknown as UC03WorkflowResult,
      ports: {} as CaseGradeRequest['ports'],
      model: 'model-1',
      repositoryRoot,
      requiresAdmission: true,
    });

    const unbound = await resolution.grade(gradeRequest(join(root, 'absent')));
    assert.deepEqual(unbound, { refusal: 'grade-input-unavailable' });
    assert.equal(runs.length, 0, 'no executor call without a bound root');

    const graded = await resolution.grade(gradeRequest(root));
    assert.ok(graded && !('refusal' in graded), JSON.stringify(graded));
    assert.equal(graded.grade.grade, 'pass');
    assert.equal(graded.binding.tier, 'real-tier');
    assert.equal(graded.binding.executorId, EXECUTOR_ID);
    assert.match(graded.binding.admissionId ?? '', /^adm-/u);
    assert.equal(runs.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(meta, { recursive: true, force: true });
  }
});
