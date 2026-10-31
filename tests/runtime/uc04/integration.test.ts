import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableStore } from '../../../src/persistence/store.ts';
import { FeatureWorkflowEngine } from '../support/uc04/workflow-engine.ts';
import {
  UC04_SCHEMA_VERSION,
  type TaskState,
  type WorkspaceBaseline,
  type ApprovalRequestBinding,
} from '../../../src/persistence/contracts.ts';

describe('UC-04: Multi-Step Workflow & Crash Recovery Simulation (Level 1, local controlled)', () => {
  let tempDir: string;
  let store: DurableStore;

  const baseline: WorkspaceBaseline = {
    commitHash: 'commit-e2e-11111111111111111111111111111111',
    branch: 'feat/e2e',
    isClean: true,
    trackedFilesHash: 'hash-baseline',
  };

  const initialTask: TaskState = {
    schemaVersion: UC04_SCHEMA_VERSION,
    taskId: 'task-e2e-01',
    runId: 'run-1',
    repositoryId: 'repo-01',
    workspaceId: 'ws-01',
    taskType: 'feature',
    goal: 'Build multi-step feature with crash and resume',
    acceptanceCriteria: ['All 3 steps pass', 'Zero duplicate work'],
    constraints: ['No unconstrained shell'],
    plan: [
      { id: 'step-1', title: 'Write interfaces', description: 'Types and contracts', status: 'todo', predecessorIds: [] },
      { id: 'step-2', title: 'Implement logic', description: 'Core algorithm', status: 'todo', predecessorIds: ['step-1'] },
      { id: 'step-3', title: 'Verify and delivery', description: 'Run test suite', status: 'todo', predecessorIds: ['step-2'] },
    ],
    currentStepIndex: 0,
    changedFiles: [],
    openRisks: [],
    nextAction: 'Start step-1',
    status: 'pending',
    stateVersion: 1,
    budgetLedgers: [
      {
        scope: 'task',
        kind: 'tokens',
        limit: 50000,
        consumed: 0,
        reservations: [],
        configurationId: 'cfg-default',
        version: 1,
      },
      {
        scope: 'task',
        kind: 'cost',
        limit: 10.0,
        consumed: 0,
        reservations: [],
        configurationId: 'cfg-default',
        version: 1,
      },
    ],
    workspaceBaseline: baseline,
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'slop-e2e-test-'));
    store = new DurableStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('runs step 1, survives simulated crash, and resumes step 2 & 3 without duplicate execution', async () => {
    const engine1 = new FeatureWorkflowEngine(store);
    await engine1.initTask(initialTask);

    const executedSteps: string[] = [];

    // Phase 1: Engine 1 starts task, completes step 1, then crashes before step 2
    try {
      await engine1.executeWorkflow(
        initialTask.taskId,
        async (step) => {
          executedSteps.push(step.id);
          if (step.id === 'step-1') {
            return {
              changedFiles: ['src/types.ts'],
              usage: { inputTokens: 500, outputTokens: 200, costUsd: 0.05 },
            };
          }
          if (step.id === 'step-2') {
            const crash = new Error('SIMULATED CRASH (SIGKILL)');
            (crash as unknown as { isAbruptCrash: boolean }).isAbruptCrash = true;
            throw crash;
          }
          return {};
        },
        { gitInspector: async () => ({ ...baseline }) }
      );
    } catch {
      // simulated crash
    }

    assert.deepEqual(executedSteps, ['step-1', 'step-2']);

    // Inspect checkpoint on disk after crash
    const checkpointAfterCrash = await store.loadLatestCheckpoint(initialTask.taskId);
    assert.ok(checkpointAfterCrash);
    assert.equal(checkpointAfterCrash.state.plan[0]?.status, 'done');
    assert.equal(checkpointAfterCrash.state.plan[1]?.status, 'doing');

    // Phase 2: Start a brand-new engine instance (representing process restart)
    const engine2 = new FeatureWorkflowEngine(new DurableStore(tempDir));
    const resumedSteps: string[] = [];

    const finalState = await engine2.executeWorkflow(
      initialTask.taskId,
      async (step) => {
        resumedSteps.push(step.id);
        if (step.id === 'step-2') {
          return {
            changedFiles: ['src/logic.ts'],
            usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.1 },
          };
        }
        if (step.id === 'step-3') {
          return {
            changedFiles: ['tests/logic.test.ts'],
            verificationRef: 'pytest-pass',
            usage: { inputTokens: 800, outputTokens: 300, costUsd: 0.08 },
          };
        }
        return {};
      },
      {
        gitInspector: async () => ({ ...baseline }),
        verification: async () => ({
          status: 'verified',
          evidenceRefs: ['tests:all'],
          checkedAt: new Date().toISOString(),
        }),
      }
    );

    // CRITICAL ASSERTION: Step 1 was NEVER re-executed!
    assert.deepEqual(resumedSteps, ['step-2', 'step-3']);
    assert.equal(finalState.status, 'completed');
    assert.equal(finalState.plan.every((s) => s.status === 'done'), true);
    assert.deepEqual(finalState.changedFiles, ['src/types.ts', 'src/logic.ts', 'tests/logic.test.ts']);

    // Verify cumulative budget accounting across restarts
    const tokenLedger = finalState.budgetLedgers.find((l) => l.kind === 'tokens');
    assert.ok(tokenLedger);
    // 700 (step 1) + 1500 (step 2) + 1100 (step 3) = 3300 consumed
    assert.equal(tokenLedger.consumed, 3300);
  });

  it('pauses for human approval during multi-step flow, persists state, and resumes to completion after approval', async () => {
    const engine = new FeatureWorkflowEngine(store);
    await engine.initTask(initialTask);

    const approvalReq: ApprovalRequestBinding = {
      requestId: 'app-req-mig',
      actionType: 'database_migration',
      targetFiles: ['migrations/001.sql'],
      normalizedActionDigest: 'sha256-migration-action',
      repoCommit: baseline.commitHash,
      policyVersion: 'v1.0.0',
      createdAt: new Date().toISOString(),
    };

    // Run until Step 2 demands approval
    const pausedState = await engine.executeWorkflow(
      initialTask.taskId,
      async (step) => {
        if (step.id === 'step-1') {
          return { changedFiles: ['src/types.ts'] };
        }
        if (step.id === 'step-2') {
          return { requiresApproval: approvalReq };
        }
        return {};
      },
      { gitInspector: async () => ({ ...baseline }) }
    );

    assert.equal(pausedState.status, 'waiting_approval');
    assert.equal(pausedState.pendingApproval?.requestId, 'app-req-mig');

    // Simulate Human approves the action
    await engine.resumeWithApproval(
      initialTask.taskId,
      {
        requestId: 'app-req-mig',
        decision: 'approved',
        approvedBy: 'senior-architect',
      },
      {
        currentCommit: baseline.commitHash,
        policyVersion: 'v1.0.0',
      }
    );

    // Continue workflow
    const finishedState = await engine.executeWorkflow(
      initialTask.taskId,
      async (step) => {
        if (step.id === 'step-2') {
          return { changedFiles: ['migrations/001.sql'] };
        }
        if (step.id === 'step-3') {
          return { verificationRef: 'tests-ok' };
        }
        return {};
      },
      {
        gitInspector: async () => ({ ...baseline }),
        verification: async () => ({
          status: 'verified',
          evidenceRefs: ['tests:all'],
          checkedAt: new Date().toISOString(),
        }),
      }
    );

    assert.equal(finishedState.status, 'completed');
    assert.equal(finishedState.plan[1]?.status, 'done');
    assert.equal(finishedState.plan[2]?.status, 'done');
  });
});
