import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableStore } from '../../../src/persistence/store.ts';
import {
  compactContext,
  formatCompactSummaryMarkdown,
  inspectTaskStatus,
} from '../../../src/persistence/inspection.ts';
import {
  UC04_SCHEMA_VERSION,
  type TaskState,
} from '../../../src/persistence/contracts.ts';

describe('UC-04: Inspection & Safe Context Compaction', () => {
  let tempDir: string;
  let store: DurableStore;

  const sampleTask: TaskState = {
    schemaVersion: UC04_SCHEMA_VERSION,
    taskId: 'task-compact-01',
    runId: 'run-1',
    repositoryId: 'repo-01',
    workspaceId: 'ws-01',
    taskType: 'feature',
    goal: 'Test context compaction functionality',
    acceptanceCriteria: ['All 6 fields present'],
    constraints: ['Max 2000 tokens context'],
    plan: [
      {
        id: 'step-1',
        title: 'Draft Spec',
        description: 'Write spec.md',
        status: 'done',
        completedAt: '2026-10-21T10:00:00.000Z',
        changedFiles: ['spec.md'],
        evidenceRefs: ['changed:spec.md'],
        predecessorIds: [],
      },
      {
        id: 'step-2',
        title: 'Implement code',
        description: 'Code the feature',
        status: 'doing',
        startedAt: '2026-10-21T10:05:00.000Z',
        predecessorIds: ['step-1'],
      },
    ],
    currentStepIndex: 1,
    changedFiles: ['spec.md'],
    openRisks: ['Potential schema migration conflict'],
    nextAction: 'Finish implementing code',
    status: 'running',
    stateVersion: 3,
    budgetLedgers: [],
    workspaceBaseline: {
      commitHash: 'commit-hash-abcdef1234567890abcdef',
      branch: 'main',
      isClean: true,
      trackedFilesHash: 'files-hash-1',
    },
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'slop-inspect-test-'));
    store = new DurableStore(tempDir);
    await store.saveTask(sampleTask);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('generates compliant 6-field compact summary without mutating task state', () => {
    const summary = compactContext(sampleTask);

    assert.equal(summary.taskId, sampleTask.taskId);
    assert.equal(summary.sourceStateVersion, sampleTask.stateVersion);
    assert.equal(summary.goal, sampleTask.goal);
    assert.deepEqual(summary.constraints, sampleTask.constraints);
    assert.equal(summary.completedWork.length, 1);
    assert.ok(summary.completedWork[0]?.includes('Draft Spec'));
    assert.ok(summary.currentState.includes('step-2'));
    assert.deepEqual(summary.openRisks, ['Potential schema migration conflict']);
    assert.equal(summary.nextAction, 'Finish implementing code');
  });

  it('formats compact summary as clean structured markdown', () => {
    const summary = compactContext(sampleTask);
    const md = formatCompactSummaryMarkdown(summary);

    assert.ok(md.includes('## Goal'));
    assert.ok(md.includes('Test context compaction functionality'));
    assert.ok(md.includes('## Completed Work'));
    assert.ok(md.includes('Draft Spec'));
    assert.ok(md.includes('## Open Risks'));
    assert.ok(md.includes('Potential schema migration conflict'));
  });

  it('inspects task status and returns bounded report without mutating state', async () => {
    const report = await inspectTaskStatus(store, sampleTask.taskId);
    assert.ok(report);
    assert.equal(report.taskId, sampleTask.taskId);
    assert.equal(report.status, 'running');
    assert.equal(report.completedStepCount, 1);
    assert.equal(report.totalStepCount, 2);
    assert.equal(report.isDeliberatelyPaused, false);
  });
});
