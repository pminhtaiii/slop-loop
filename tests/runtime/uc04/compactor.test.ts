import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compactContext, type CompactedSummary } from '../../../src/memory/compactor.ts';
import type { TaskState } from '../../../src/state/types.ts';

describe('UC-04 Ticket 08: Context Compactor', () => {
  const verboseTask: TaskState = {
    taskId: 'task-long-run-01',
    runId: 'run-4',
    taskType: 'feature',
    goal: 'Build deep auth module',
    acceptanceCriteria: ['AC1: Hash passwords', 'AC2: JWT tokens'],
    constraints: ['Zero plain text passwords', 'Max 2 retries'],
    plan: [
      { id: 's-1', title: 'DB Schema', description: 'Create tables', status: 'done', changedFiles: ['schema.sql'] },
      { id: 's-2', title: 'Password Hasher', description: 'Bcrypt wrapper', status: 'done', changedFiles: ['hasher.ts'] },
      { id: 's-3', title: 'JWT Service', description: 'Generate tokens', status: 'doing' },
      { id: 's-4', title: 'Integration Test', description: 'Test endpoint', status: 'todo' },
    ],
    currentStepIndex: 2,
    changedFiles: ['schema.sql', 'hasher.ts'],
    status: 'running',
    stateVersion: 10,
    budgetLedgers: [],
    workspaceBaseline: {
      commitHash: 'commit-1234567890123456789012345678901234',
      branch: 'main',
      isClean: true,
      trackedFilesHash: 'hash-1',
    },
    openRisks: ['JWT secret must be injected via env'],
    nextAction: 'Implement sign and verify methods in jwt.ts',
  };

  it('compacts context while strictly retaining the 6 mandatory fields', () => {
    const summary: CompactedSummary = compactContext(verboseTask);

    assert.equal(summary.goal, 'Build deep auth module');
    assert.deepEqual(summary.constraints, ['Zero plain text passwords', 'Max 2 retries']);
    assert.equal(summary.completedWork.length, 2);
    assert.ok(summary.completedWork.some((w) => w.includes('DB Schema')));
    assert.ok(summary.completedWork.some((w) => w.includes('Password Hasher')));
    assert.equal(summary.currentState.status, 'running');
    assert.equal(summary.currentState.activeStepTitle, 'JWT Service');
    assert.deepEqual(summary.openRisks, ['JWT secret must be injected via env']);
    assert.equal(summary.nextAction, 'Implement sign and verify methods in jwt.ts');
  });

  it('formats compacted summary as structured markdown prompt block', () => {
    const summary = compactContext(verboseTask);
    const md = summary.toMarkdown();

    assert.ok(md.includes('## Goal'));
    assert.ok(md.includes('Build deep auth module'));
    assert.ok(md.includes('## Completed Work'));
    assert.ok(md.includes('## Open Risks'));
    assert.ok(md.includes('## Next Action'));
  });
});
