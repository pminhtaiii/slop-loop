import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApprovalServiceCore } from '../../../src/approvals/service-v01.ts';
import { createRealContextProvider, type RealContextSource } from '../../../src/approvals/real-context-provider.ts';
import { DEFAULT_POLICY_PROFILE, decisionDir } from '../../../src/persistence/adapters/approval-types.ts';
import { DurableApprovalStore } from '../../../src/persistence/adapters/approval-store-adapter.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { UC04_SCHEMA_VERSION, type TaskState } from '../../../src/persistence/contracts.ts';
import { computeActionDigest } from '../../../src/contracts/foundation/uc03.ts';
import type { ApprovalStore } from '../../../src/approvals/service-data.ts';

const taskId = 'task-1';
const action = { actionId: 'action-1', kind: 'run_command' as const, executable: 'pytest', argv: ['-q', 'tests/x.py'], workingDirectory: '/workspace' };
const repositoryRevisionDigest = `sha256:${'a'.repeat(64)}`;

const taskState: TaskState = {
  schemaVersion: UC04_SCHEMA_VERSION,
  taskId,
  runId: 'run-1',
  repositoryId: 'repo-1',
  workspaceId: 'workspace-1',
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

const observed = {
  action,
  facts: {
    taskId,
    workspaceId: 'workspace-1',
    repositoryId: 'repo-1',
    repositoryRevisionDigest,
    policyIdentity: DEFAULT_POLICY_PROFILE.policyIdentity,
    registeredActionDigest: computeActionDigest(action),
  },
  elements: { action: 'Run tests', necessity: 'Verify', targets: ['tests/x.py'], consequences: 'Runs tests', verificationStatus: 'Not executed' },
};
const source: RealContextSource = { provenance: 'real', observe: (_taskId, actionId) => (actionId === action.actionId ? observed : null) };

const workspace = (): string => mkdtempSync(join(tmpdir(), 'uc05-real-provenance-'));

test('default construction keeps the mock path', async t => {
  const dir = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new DurableApprovalStore({ storageDir: dir });
  assert.equal(store.provenance, 'mock');
  const { service } = createApprovalServiceCore({ taskId, profile: DEFAULT_POLICY_PROFILE, context: { loadForAction: async () => null, loadForDecision: async () => null } });
  assert.equal(service.provenance, 'mock');
});

test('a real-configured service over a real-configured store reports real', async t => {
  const dir = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new DurableApprovalStore({ storageDir: dir, provenance: 'real' });
  const { service } = createApprovalServiceCore({
    taskId,
    profile: DEFAULT_POLICY_PROFILE,
    store: store as unknown as ApprovalStore,
    context: { loadForAction: async () => null, loadForDecision: async () => null },
    provenance: 'real',
  });
  assert.equal(service.provenance, 'real');
  assert.equal((await service.list(taskId)).control.taskId, taskId);
});

test('mismatched provenance still fails closed', async t => {
  const dir = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mockStore = new DurableApprovalStore({ storageDir: dir });
  const realStore = new DurableApprovalStore({ storageDir: dir, provenance: 'real' });
  const build = (store: DurableApprovalStore, provenance: 'mock' | 'real') =>
    createApprovalServiceCore({
      taskId,
      profile: DEFAULT_POLICY_PROFILE,
      store: store as unknown as ApprovalStore,
      context: { loadForAction: async () => null, loadForDecision: async () => null },
      provenance,
    }).service;

  await assert.rejects(build(realStore, 'mock').list(taskId), /approval-operation-denied/);
  await assert.rejects(build(mockStore, 'real').list(taskId), /approval-operation-denied/);
  assert.throws(() => new DurableApprovalStore({ storageDir: dir, provenance: 'trust-me' as 'real' }), /Invalid approval store provenance/);
});

test('the real context provider derives context from durable state and refuses unknown ids', async t => {
  const dir = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const durable = new DurableStore(dir);
  const approvals = new DurableApprovalStore({ storageDir: dir, durableStore: durable, provenance: 'real' });
  await durable.saveTask(taskState);

  const decisionId = 'decision-1';
  const requestPath = join(decisionDir(dir, decisionId), 'request.json');
  mkdirSync(join(decisionDir(dir, decisionId)), { recursive: true });
  writeFileSync(
    requestPath,
    JSON.stringify({
      schemaVersion: 'uc05-approval/0.1-draft',
      decisionId,
      taskId,
      repositoryId: 'repo-1',
      workspaceId: 'workspace-1',
      createdRunId: 'run-1',
      continuationRef: 'continuation-1',
      requestVersion: 1,
      policyId: DEFAULT_POLICY_PROFILE.policyIdentity.policyId,
      policyVersion: DEFAULT_POLICY_PROFILE.policyIdentity.policyVersion,
      configId: DEFAULT_POLICY_PROFILE.policyIdentity.configId,
      configVersion: DEFAULT_POLICY_PROFILE.policyIdentity.configVersion,
      actionRef: action.actionId,
      actionDigest: computeActionDigest(action),
      presentationDigest: `sha256:${'b'.repeat(64)}`,
      createdAt: '2026-11-03T00:00:00.000Z',
      submissionKey: 'submission-1',
      binding: {
        decisionId,
        actionKind: 'action',
        normalizedActionDigest: computeActionDigest(action),
        taskId,
        workspaceId: 'workspace-1',
        repositoryRevisionDigest,
        policyId: DEFAULT_POLICY_PROFILE.policyIdentity.policyId,
        policyVersion: DEFAULT_POLICY_PROFILE.policyIdentity.policyVersion,
        status: 'pending',
      },
    }),
  );

  const provider = createRealContextProvider({ durable, approvals, source });
  const context = (await provider.loadForAction(taskId, action.actionId)) as { runId: string; action: unknown; freshness: { currentTaskId: string } };
  assert.equal(context.runId, 'run-1');
  assert.deepEqual(context.action, action);
  assert.equal(context.freshness.currentTaskId, taskId);
  assert.equal(((await provider.loadForDecision(decisionId)) as { runId: string }).runId, 'run-1');

  await assert.rejects(provider.loadForAction('task-missing', action.actionId), /real-context-unknown-task/);
  await assert.rejects(provider.loadForAction(taskId, 'action-missing'), /real-context-unknown-action/);
  await assert.rejects(provider.loadForDecision('decision-missing'), /real-context-unknown-decision/);
  assert.throws(() => createRealContextProvider({ durable, approvals: new DurableApprovalStore({ storageDir: dir }), source }), /real-context-requires-real-sources/);
});
