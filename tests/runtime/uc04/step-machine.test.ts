import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StepStateMachine } from '../../../src/state/step-machine.ts';
import type { TaskState } from '../../../src/state/types.ts';

describe('UC-04 Ticket 03: StepStateMachine', () => {
  const initialTask: TaskState = {
    taskId: 'task-step-test',
    runId: 'run-1',
    taskType: 'feature',
    goal: 'Test step machine',
    acceptanceCriteria: ['All steps pass'],
    constraints: [],
    plan: [
      { id: 's-1', title: 'Step 1', description: 'First step', status: 'todo' },
      { id: 's-2', title: 'Step 2', description: 'Second step', status: 'todo' },
      { id: 's-3', title: 'Step 3', description: 'Third step', status: 'todo' },
    ],
    currentStepIndex: 0,
    changedFiles: [],
    status: 'pending',
    stateVersion: 1,
    budgetLedgers: [],
    workspaceBaseline: {
      commitHash: '1234567890abcdef1234567890abcdef12345678',
      branch: 'feature',
      isClean: true,
      trackedFilesHash: 'hash-1',
    },
  };

  it('transitions first step from todo to doing and increments stateVersion', () => {
    const machine = new StepStateMachine();
    const updated = machine.startStep(initialTask, 's-1');

    assert.equal(updated.status, 'running');
    assert.equal(updated.stateVersion, 2);
    assert.equal(updated.currentStepIndex, 0);
    const step0 = updated.plan[0];
    assert.ok(step0);
    assert.equal(step0.status, 'doing');
    assert.ok(step0.startedAt);
  });

  it('rejects starting a step out of order', () => {
    const machine = new StepStateMachine();
    assert.throws(() => machine.startStep(initialTask, 's-2'), {
      message: /cannot start step s-2; expected s-1/i,
    });
  });

  it('completes step and advances currentStepIndex', () => {
    const machine = new StepStateMachine();
    const started = machine.startStep(initialTask, 's-1');
    const completed = machine.completeStep(started, 's-1', {
      changedFiles: ['src/index.ts'],
      verificationRef: 'test-pass-01',
    });

    const step0 = completed.plan[0];
    assert.ok(step0);
    assert.equal(step0.status, 'done');
    assert.deepEqual(step0.changedFiles, ['src/index.ts']);
    assert.equal(step0.verificationRef, 'test-pass-01');
    assert.equal(completed.currentStepIndex, 1);
    assert.equal(completed.stateVersion, 3);
    assert.equal(completed.status, 'running');
  });

  it('marks task completed when the final step completes', () => {
    const machine = new StepStateMachine();
    let task = machine.startStep(initialTask, 's-1');
    task = machine.completeStep(task, 's-1', { changedFiles: ['file1.ts'] });

    task = machine.startStep(task, 's-2');
    task = machine.completeStep(task, 's-2', { changedFiles: ['file2.ts'] });

    task = machine.startStep(task, 's-3');
    task = machine.completeStep(task, 's-3', { changedFiles: ['file3.ts'] });

    assert.equal(task.status, 'completed');
    assert.equal(task.plan.every((s) => s.status === 'done'), true);
    assert.deepEqual(task.changedFiles, ['file1.ts', 'file2.ts', 'file3.ts']);
  });

  it('handles step failure cleanly without corrupting state', () => {
    const machine = new StepStateMachine();
    const started = machine.startStep(initialTask, 's-1');
    const failed = machine.failStep(started, 's-1', 'Build error in step 1');

    assert.equal(failed.status, 'failed');
    const step0 = failed.plan[0];
    assert.ok(step0);
    assert.equal(step0.status, 'failed');
    assert.equal(step0.error, 'Build error in step 1');
    assert.equal(failed.stateVersion, 3);
  });

  it('strictly forbids invalid backwards transitions (e.g. done -> todo)', () => {
    const machine = new StepStateMachine();
    let task = machine.startStep(initialTask, 's-1');
    task = machine.completeStep(task, 's-1');

    assert.throws(() => machine.startStep(task, 's-1'), {
      message: /cannot start step/i,
    });
  });
});
