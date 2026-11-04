/**
 * The observed-action registry is the host's own record: registration measures the current
 * revision, observation re-measures it, and every refusal is code-tagged with no fabricated fact.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createRealContextProvider } from '../../../src/approvals/real-context-provider.ts';
import type { PolicyFacts } from '../../../src/approvals/policy.ts';
import { computeActionDigest } from '../../../src/contracts/foundation/uc03.ts';
import type { NormalizedAction } from '../../../src/contracts/foundation/uc03.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import { DurableApprovalStore } from '../../../src/persistence/adapters/approval-store-adapter.ts';
import { DEFAULT_POLICY_PROFILE } from '../../../src/persistence/adapters/approval-types.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { UC04_SCHEMA_VERSION } from '../../../src/persistence/contracts.ts';
import type { TaskState } from '../../../src/persistence/contracts.ts';
import { createHostActionContext } from '../../../src/runtime/host-action-context.ts';

const TASK_ID = 'task-1';
const WORKSPACE_ID = 'workspace-1';
const REPOSITORY_ID = 'repo-1';
const ACTION: NormalizedAction = { actionId: 'action-1', kind: 'run_command', executable: 'pytest', argv: ['-q', 'tests/x.py'], workingDirectory: '/workspace/repo' };
const ELEMENTS = { action: 'Run tests', necessity: 'Verify', targets: ['tests/x.py'], consequences: 'Runs tests', verificationStatus: 'Not executed' };

const taskState: TaskState = {
  schemaVersion: UC04_SCHEMA_VERSION,
  taskId: TASK_ID,
  runId: 'run-1',
  repositoryId: REPOSITORY_ID,
  workspaceId: WORKSPACE_ID,
  taskType: 'feature',
  goal: 'g',
  acceptanceCriteria: ['c'],
  constraints: [],
  plan: [{ id: 's-1', title: 'Step', description: 'First', status: 'todo' }],
  currentStepIndex: 0,
  status: 'pending',
  stateVersion: 1,
  budgetLedgers: [],
  workspaceBaseline: { commitHash: 'abcdef1234567890', branch: 'feature', isClean: true, trackedFilesHash: 'hash' },
  changedFiles: [],
  openRisks: [],
  nextAction: 'start',
};

/** A disposable measured workspace; the same root also hosts durable task/approval stores. */
function workspace(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'uc03-host-action-'));
  writeFileSync(join(root, 'app.py'), 'print("hi")\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function facts(revision: string, overrides: Partial<PolicyFacts> = {}): PolicyFacts {
  return {
    taskId: TASK_ID,
    workspaceId: WORKSPACE_ID,
    repositoryId: REPOSITORY_ID,
    repositoryRevisionDigest: revision,
    policyIdentity: DEFAULT_POLICY_PROFILE.policyIdentity,
    registeredActionDigest: computeActionDigest(ACTION),
    continuationRef: 'continuation-1',
    role: 'coder',
    safety: {
      workspaceContained: true,
      protectedContentAbsent: true,
      hiddenGradingAbsent: true,
      policyBypassAbsent: true,
      testsPreserved: true,
      commandSourceWritesAbsent: true,
      isolated: true,
    },
    patch: null,
    command: {
      executableRef: 'pytest',
      resolvedExecutable: 'pytest',
      workingDirectoryRef: 'repository-root',
      workingDirectory: '/workspace/repo',
      constrainedCapability: null,
    },
    plan: null,
    ...overrides,
  };
}

function hostContext(filesystem: WorkspaceFilesystemPort, overrides: Partial<Parameters<typeof createHostActionContext>[0]> = {}) {
  return createHostActionContext({
    filesystem,
    workspaceId: WORKSPACE_ID,
    repositoryId: REPOSITORY_ID,
    policyIdentity: DEFAULT_POLICY_PROFILE.policyIdentity,
    ttlMs: 60_000,
    ...overrides,
  });
}

const refusalCode = (run: () => Promise<unknown>): Promise<string | undefined> =>
  run().then(
    () => undefined,
    (error: Error) => (error as { code?: string }).code,
  );

test('host registration feeds the existing real context provider end to end', async t => {
  const root = workspace(t);
  // Durable task/approval state lives outside the measured workspace, so saving it cannot drift the tree.
  const state = workspace(t);
  const filesystem = new WorkspaceFilesystemPort({ root });
  const source = hostContext(filesystem);
  const revision = await filesystem.getCurrentRevisionDigest();
  await source.register({ action: ACTION, facts: facts(revision), elements: ELEMENTS });

  const durable = new DurableStore(state);
  await durable.saveTask(taskState);
  const approvals = new DurableApprovalStore({ storageDir: join(state, 'approvals'), durableStore: durable, provenance: 'real' });
  const provider = createRealContextProvider({ durable, approvals, source });

  const loaded = (await provider.loadForAction(TASK_ID, ACTION.actionId)) as {
    action: NormalizedAction;
    elements: unknown;
    freshness: { currentRepositoryRevisionDigest: string; currentNormalizedActionDigest: string };
  };
  assert.deepEqual(loaded.action, ACTION);
  assert.deepEqual(loaded.elements, ELEMENTS);
  assert.equal(loaded.freshness.currentRepositoryRevisionDigest, revision);
  assert.equal(loaded.freshness.currentNormalizedActionDigest, computeActionDigest(ACTION));
});

test('unknown, cross-task and replaced actions observe as unavailable', async t => {
  const filesystem = new WorkspaceFilesystemPort({ root: workspace(t) });
  const source = hostContext(filesystem);
  const revision = await filesystem.getCurrentRevisionDigest();

  assert.equal(await refusalCode(() => hostContext(filesystem).observe(TASK_ID, 'never-registered')), 'UNKNOWN_ACTION');

  await source.register({ action: ACTION, facts: facts(revision), elements: ELEMENTS });
  assert.equal(await refusalCode(() => source.observe('other-task', ACTION.actionId)), 'CROSS_TASK');

  const changed: NormalizedAction = { actionId: ACTION.actionId, kind: 'run_command', executable: 'pytest', argv: ['-q', 'tests/y.py'], workingDirectory: '/workspace/repo' };
  await assert.rejects(source.register({ action: changed, facts: facts(revision, { registeredActionDigest: computeActionDigest(changed) }), elements: ELEMENTS }), /REPLACED_ACTION/);
  // The swapped action is not silently usable: an earlier observation cannot stand in for the new action.
  await assert.rejects(source.observe(TASK_ID, ACTION.actionId), /REPLACED_ACTION/);
});

test('revision drift between registration and observation refuses, and continuation re-observes', async t => {
  const root = workspace(t);
  const filesystem = new WorkspaceFilesystemPort({ root });
  const source = hostContext(filesystem);
  await source.register({ action: ACTION, facts: facts(await filesystem.getCurrentRevisionDigest()), elements: ELEMENTS });

  assert.deepEqual((await source.observe(TASK_ID, ACTION.actionId)).action, ACTION);

  writeFileSync(join(root, 'app.py'), 'print("changed")\n');
  await assert.rejects(source.observe(TASK_ID, ACTION.actionId), /REVISION_DRIFT/);
});

test('expired registration authority refuses', async t => {
  const filesystem = new WorkspaceFilesystemPort({ root: workspace(t) });
  let clock = 1_000;
  const source = hostContext(filesystem, { ttlMs: 100, now: () => clock });
  const { expiresAtEpochMs } = await source.register({ action: ACTION, facts: facts(await filesystem.getCurrentRevisionDigest()), elements: ELEMENTS });
  assert.equal(expiresAtEpochMs, 1_100);
  assert.deepEqual((await source.observe(TASK_ID, ACTION.actionId)).action, ACTION);

  clock = 1_100;
  await assert.rejects(source.observe(TASK_ID, ACTION.actionId), /EXPIRED_AUTHORITY/);
});

test('caller-supplied facts the host did not measure are refused, with no registry entry', async t => {
  const filesystem = new WorkspaceFilesystemPort({ root: workspace(t) });
  const source = hostContext(filesystem);
  const revision = await filesystem.getCurrentRevisionDigest();

  await assert.rejects(source.register({ action: ACTION, facts: facts(`sha256:${'f'.repeat(64)}`), elements: ELEMENTS }), /FABRICATED_FACTS/);
  await assert.rejects(source.register({ action: changingArgv(), facts: facts(revision), elements: ELEMENTS }), /FABRICATED_FACTS/);
  await assert.rejects(source.register({ action: ACTION, facts: facts(revision, { workspaceId: 'other-workspace' }), elements: ELEMENTS }), /IDENTITY_MISMATCH/);
  await assert.rejects(source.register({ action: ACTION, facts: facts(revision), elements: { ...ELEMENTS, targets: [] } }), /INVALID_REGISTRATION/);
  await assert.rejects(source.observe(TASK_ID, ACTION.actionId), /UNKNOWN_ACTION/);
});

/** Same id as ACTION, different content, but facts still carry ACTION's digest. */
function changingArgv(): NormalizedAction {
  return { actionId: ACTION.actionId, kind: 'run_command', executable: 'pytest', argv: ['-q', 'tests/z.py'], workingDirectory: '/workspace/repo' };
}
