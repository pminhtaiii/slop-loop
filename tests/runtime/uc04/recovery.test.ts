import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DurableStore } from '../../../src/persistence/store.ts';
import {
  StepStateMachine,
  WorkspaceDriftError,
  DependencyNotMetError,
  reconcileAndResume,
  captureWorkspaceBaseline,
} from '../../../src/persistence/recovery.ts';
import {
  UC04_SCHEMA_VERSION,
  type TaskState,
  type WorkspaceBaseline,
  type VerificationRecord,
} from '../../../src/persistence/contracts.ts';

describe('UC-04: StepStateMachine & Recovery Reconciliation', () => {
  let tempDir: string;
  let store: DurableStore;

  const baseline: WorkspaceBaseline = {
    commitHash: 'abcdef1234567890abcdef1234567890abcdef12',
    branch: 'main',
    isClean: true,
    trackedFilesHash: 'files-hash-123',
  };

  const sampleTask: TaskState = {
    schemaVersion: UC04_SCHEMA_VERSION,
    taskId: 'task-recovery-01',
    runId: 'run-1',
    repositoryId: 'repo-01',
    workspaceId: 'ws-01',
    taskType: 'feature',
    goal: 'Resume feature from interrupted step',
    acceptanceCriteria: ['All steps pass'],
    constraints: [],
    plan: [
      {
        id: 'step-1',
        title: 'Step 1',
        description: 'Completed step',
        status: 'done',
        completedAt: new Date().toISOString(),
        changedFiles: ['file1.ts'],
        evidenceRefs: ['changed:file1.ts'],
        predecessorIds: [],
      },
      {
        id: 'step-2',
        title: 'Step 2',
        description: 'Interrupted step',
        status: 'todo',
        predecessorIds: ['step-1'],
      },
      {
        id: 'step-3',
        title: 'Step 3',
        description: 'Subsequent step',
        status: 'todo',
        predecessorIds: ['step-2'],
      },
    ],
    currentStepIndex: 1,
    changedFiles: ['file1.ts'],
    openRisks: [],
    nextAction: 'Resume step 2',
    status: 'running',
    stateVersion: 2,
    budgetLedgers: [
      {
        scope: 'task',
        kind: 'tokens',
        limit: 10000,
        consumed: 2000,
        reservations: [],
        configurationId: 'cfg-1',
        version: 2,
      },
    ],
    workspaceBaseline: baseline,
  };

  const withReservation = (stateVersion: number, taskId = sampleTask.taskId): TaskState => ({
    ...sampleTask,
    taskId,
    stateVersion,
    budgetLedgers: [
      {
        scope: 'task',
        kind: 'tokens',
        limit: 10000,
        consumed: 2000,
        reservations: [{ reservationId: 'res-1', keyedId: 'req-interrupted', amount: 1000 }],
        configurationId: 'cfg-1',
        version: 2,
      },
    ],
  });

  const finalStepTask: TaskState = {
    ...sampleTask,
    stateVersion: 4,
    currentStepIndex: 2,
    status: 'running',
    plan: [
      { id: 'a', title: 'A', description: 'A', status: 'done', completedAt: new Date().toISOString(), predecessorIds: [], evidenceRefs: ['changed:a'] },
      { id: 'b', title: 'B', description: 'B', status: 'done', completedAt: new Date().toISOString(), predecessorIds: ['a'], evidenceRefs: ['changed:b'] },
      { id: 'c', title: 'C', description: 'C', status: 'todo', predecessorIds: ['b'] },
    ],
  };

  const allDoneTask: TaskState = {
    ...finalStepTask,
    plan: finalStepTask.plan.map((s) =>
      s.id === 'c' ? { ...s, status: 'done' as const, evidenceRefs: ['changed:c'] } : s
    ),
  };

  const verified: VerificationRecord = {
    status: 'verified',
    evidenceRefs: ['tests:pass'],
    checkedAt: new Date().toISOString(),
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'slop-rec-test-'));
    store = new DurableStore(tempDir);
    await store.saveCheckpoint(sampleTask);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('StepStateMachine', () => {
    const machine = new StepStateMachine();

    it('starts step when predecessors are satisfied with evidence', () => {
      const started = machine.startStep(sampleTask, 'step-2');
      assert.equal(started.plan[1]?.status, 'doing');
      assert.equal(started.status, 'running');
      assert.equal(started.stateVersion, 3);
    });

    it('rejects starting step if predecessor is not done', () => {
      assert.throws(
        () => machine.startStep(sampleTask, 'step-3'),
        (err: unknown) => err instanceof DependencyNotMetError && (err as DependencyNotMetError).missingPredecessors.includes('step-2')
      );
    });

    it('refuses a dependent when the done predecessor has no evidence', () => {
      const unevidenced: TaskState = {
        ...sampleTask,
        plan: sampleTask.plan.map((s) => (s.id === 'step-1' ? { ...s, evidenceRefs: undefined } : s)),
      };
      assert.throws(
        () => machine.startStep(unevidenced, 'step-2'),
        (err: unknown) => err instanceof DependencyNotMetError && (err as DependencyNotMetError).missingPredecessors.includes('step-1')
      );
    });

    it('refuses a dependent when the predecessor omits a required evidence id', () => {
      const incomplete: TaskState = {
        ...sampleTask,
        plan: sampleTask.plan.map((s) =>
          s.id === 'step-1' ? { ...s, evidenceRefs: ['changed:file1.ts'], requiredEvidenceRefs: ['tests:unit'] } : s
        ),
      };
      assert.throws(
        () => machine.startStep(incomplete, 'step-2'),
        (err: unknown) => err instanceof DependencyNotMetError && (err as DependencyNotMetError).missingPredecessors.includes('step-1')
      );
    });

    it('completes step and advances currentStepIndex', () => {
      const started = machine.startStep(sampleTask, 'step-2');
      const completed = machine.completeStep(started, 'step-2', {
        changedFiles: ['file2.ts'],
        evidenceRefs: ['changed:file2.ts'],
      });

      assert.equal(completed.plan[1]?.status, 'done');
      assert.deepEqual(completed.changedFiles, ['file1.ts', 'file2.ts']);
      assert.equal(completed.currentStepIndex, 2);
      assert.equal(completed.status, 'running');
    });

    it('withholds completed status from the final step without verification', () => {
      const machine2 = new StepStateMachine();
      let state = machine2.startStep(finalStepTask, 'c');
      state = machine.completeStep(state, 'c', { evidenceRefs: ['changed:c'] });
      assert.equal(state.plan.every((s) => s.status === 'done'), true);
      assert.notEqual(state.status, 'completed');
      assert.match(state.nextAction, /verification/i);
    });

    it('grants completed status when the final step is verified', () => {
      const state = machine.completeStep(machine.startStep(finalStepTask, 'c'), 'c', {
        evidenceRefs: ['changed:c'],
        verification: verified,
      });
      assert.equal(state.status, 'completed');
      assert.deepEqual(state.verification, verified);
    });

    it('fails step and records error in openRisks', () => {
      const started = machine.startStep(sampleTask, 'step-2');
      const failed = machine.failStep(started, 'step-2', 'Compilation failed');

      assert.equal(failed.plan[1]?.status, 'failed');
      assert.equal(failed.status, 'failed');
      assert.ok(failed.openRisks.some((r) => r.includes('Compilation failed')));
    });
  });

  describe('reconcileAndResume', () => {
    const matchingInspector = async (): Promise<WorkspaceBaseline> => ({ ...baseline });

    it('resumes task from latest checkpoint and identifies next step without re-executing completed step', async () => {
      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: matchingInspector,
      });

      assert.equal(resumed.taskId, sampleTask.taskId);
      const step0 = resumed.plan[0];
      assert.ok(step0);
      assert.equal(step0.status, 'done');
      assert.equal(resumed.currentStepIndex, 1);
      const step1 = resumed.plan[1];
      assert.ok(step1);
      assert.equal(step1.id, 'step-2');
      assert.equal(resumed.status, 'running');
    });

    it('preserves waiting_approval status and nextAction during resumption', async () => {
      const waitingTask: TaskState = {
        ...sampleTask,
        status: 'waiting_approval',
        stateVersion: 5,
        nextAction: 'Awaiting human decision for migration',
      };
      await store.saveCheckpoint(waitingTask);

      const resumed = await reconcileAndResume(waitingTask.taskId, store, {
        gitInspector: matchingInspector,
      });

      assert.equal(resumed.status, 'waiting_approval');
      assert.equal(resumed.nextAction, 'Awaiting human decision for migration');
      assert.equal(resumed.stateVersion, 6);
    });

    it('prefers a newer persisted task over an older checkpoint snapshot', async () => {
      const newerTask: TaskState = {
        ...sampleTask,
        stateVersion: 3,
        currentStepIndex: 2,
        changedFiles: ['file1.ts', 'file2.ts'],
        budgetLedgers: [
          {
            scope: 'task',
            kind: 'tokens',
            limit: 10000,
            consumed: 2500,
            reservations: [],
            configurationId: 'cfg-1',
            version: 3,
          },
        ],
        plan: sampleTask.plan.map((s) =>
          s.id === 'step-2'
            ? { ...s, status: 'done' as const, completedAt: new Date().toISOString(), evidenceRefs: ['changed:file2.ts'] }
            : s
        ),
      };
      await store.saveTask(newerTask);

      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: matchingInspector,
      });

      assert.deepEqual(resumed.changedFiles, ['file1.ts', 'file2.ts']);
      assert.equal(resumed.plan[1]?.status, 'done');
      assert.equal(resumed.currentStepIndex, 2);
      assert.equal(resumed.stateVersion, 4);
      const tokenLedger = resumed.budgetLedgers.find((l) => l.kind === 'tokens');
      assert.equal(tokenLedger?.consumed, 2500);
    });

    it('rejects resumption when workspace commit hash drifts', async () => {
      await assert.rejects(
        async () => {
          await reconcileAndResume(sampleTask.taskId, store, {
            gitInspector: async () => ({ ...baseline, commitHash: 'different-commit-hash-000000000000000000' }),
          });
        },
        (err: unknown) =>
          err instanceof WorkspaceDriftError &&
          /workspace drift.*commit mismatch/i.test((err as Error).message)
      );
    });

    it('rejects resumption when a dirty workspace changes content to different dirty content', async () => {
      await store.saveCheckpoint({
        ...withReservation(3),
        workspaceBaseline: { ...baseline, isClean: false, trackedFilesHash: 'dirty-a' },
      });

      await assert.rejects(
        async () => {
          await reconcileAndResume(sampleTask.taskId, store, {
            gitInspector: async () => ({ ...baseline, isClean: false, trackedFilesHash: 'dirty-b' }),
          });
        },
        (err: unknown) => err instanceof WorkspaceDriftError && /tracked file content mismatch/i.test((err as Error).message)
      );
    });

    it('rejects resumption when the branch drifts', async () => {
      await assert.rejects(
        async () => {
          await reconcileAndResume(sampleTask.taskId, store, {
            gitInspector: async () => ({ ...baseline, branch: 'other-branch' }),
          });
        },
        (err: unknown) => err instanceof WorkspaceDriftError && /branch mismatch/i.test((err as Error).message)
      );
    });

    it('suspends instead of resuming while a reservation has no outcome evidence', async () => {
      await store.saveCheckpoint(withReservation(3));

      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: matchingInspector,
      });

      assert.notEqual(resumed.status, 'running');
      const tokenLedger = resumed.budgetLedgers.find((l) => l.kind === 'tokens');
      assert.ok(tokenLedger);
      assert.equal(tokenLedger.reservations.length, 1);
      assert.equal(tokenLedger.reservations[0]?.keyedId, 'req-interrupted');

      const claims = await store.loadDispatchClaims(sampleTask.taskId);
      assert.ok(claims.length > 0);
      assert.equal(claims.some((c) => c.phase === 'uncertain'), true);
    });

    it('keeps a reservation held when charge_as_consumed has no positive evidence', async () => {
      await store.saveCheckpoint(withReservation(3));

      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: matchingInspector,
        unresolvedReservationAction: 'charge_as_consumed',
      });

      assert.notEqual(resumed.status, 'running');
      const tokenLedger = resumed.budgetLedgers.find((l) => l.kind === 'tokens');
      assert.equal(tokenLedger?.consumed, 2000);
      assert.equal(tokenLedger?.reservations.length, 1);
    });

    it('releases a reservation when the effect is confirmed not dispatched', async () => {
      await store.saveCheckpoint(withReservation(3));

      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: matchingInspector,
        confirmedOutcomes: [{ requestId: 'req-interrupted', outcome: 'not_dispatched', evidenceRef: 'receipt:none' }],
      });

      assert.equal(resumed.status, 'running');
      const tokenLedger = resumed.budgetLedgers.find((l) => l.kind === 'tokens');
      assert.equal(tokenLedger?.consumed, 2000);
      assert.equal(tokenLedger?.reservations.length, 0);
    });

    it('charges an observed effect as consumed under charge_as_consumed', async () => {
      await store.saveCheckpoint(withReservation(3));

      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: matchingInspector,
        unresolvedReservationAction: 'charge_as_consumed',
        confirmedOutcomes: [{ requestId: 'req-interrupted', outcome: 'effect_observed', evidenceRef: 'receipt:usage' }],
      });

      assert.equal(resumed.status, 'running');
      const tokenLedger = resumed.budgetLedgers.find((l) => l.kind === 'tokens');
      assert.equal(tokenLedger?.consumed, 3000);
      assert.equal(tokenLedger?.reservations.length, 0);
    });

    for (const mode of ['unresolved-reservation', 'unsettled-claim', 'normal'] as const) {
      it(`reconciles only fully resolved claims on the ${mode} path`, async () => {
        const state = withReservation(3);
        const extra = { reservationId: 'res-2', keyedId: 'req-other', amount: 100 };
        await store.saveCheckpoint({ ...state, budgetLedgers: state.budgetLedgers.map((l) => ({
          ...l, reservations: mode === 'unresolved-reservation' ? [...l.reservations, extra] : l.reservations,
        })) });
        const claim = {
          taskId: sampleTask.taskId, runId: sampleTask.runId, stepId: 'step-2', actionId: 'req-interrupted',
          epoch: 1, stateVersion: 3, phase: 'dispatched' as const, createdAt: new Date().toISOString(),
        };
        await store.saveDispatchClaim({ ...claim, claimId: 'resolved-claim', reservationRefs: ['res-1'] });
        if (mode !== 'normal') {
          await store.saveDispatchClaim({ ...claim, claimId: 'partial-claim', reservationRefs: ['res-1', 'res-2'] });
        }
        const resumed = await reconcileAndResume(sampleTask.taskId, store, {
          gitInspector: matchingInspector,
          confirmedOutcomes: [{ requestId: 'req-interrupted', outcome: 'not_dispatched', evidenceRef: 'receipt:none' }],
        });
        assert.equal(resumed.status, mode === 'normal' ? 'running' : 'paused');
        const claims = await store.loadDispatchClaims(sampleTask.taskId);
        assert.equal(claims.find((c) => c.claimId === 'resolved-claim')?.phase, 'reconciled');
        if (mode !== 'normal') assert.equal(claims.find((c) => c.claimId === 'partial-claim')?.phase, 'dispatched');
      });
    }

    it('refuses to resume when a dispatch claim state version is ahead', async () => {
      await store.saveDispatchClaim({
        claimId: 'claim-ahead',
        taskId: sampleTask.taskId,
        runId: sampleTask.runId,
        stepId: 'step-2',
        actionId: 'req-ahead',
        epoch: 1,
        stateVersion: 999,
        phase: 'uncertain',
        reservationRefs: [],
        createdAt: new Date().toISOString(),
      });

      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: matchingInspector,
      });

      assert.notEqual(resumed.status, 'running');
      assert.match(resumed.nextAction, /mismatch/i);
    });

    it('withholds completed status when verification is unavailable', async () => {
      await store.saveCheckpoint(allDoneTask);

      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: matchingInspector,
      });

      assert.notEqual(resumed.status, 'completed');
      assert.equal(resumed.plan.every((s) => s.status === 'done'), true);
      assert.match(resumed.nextAction, /verification/i);
    });

    it('withholds completed status when verification failed', async () => {
      await store.saveCheckpoint(allDoneTask);

      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: matchingInspector,
        verification: async () => ({ status: 'failed', evidenceRefs: ['tests:fail'], checkedAt: new Date().toISOString() }),
      });

      assert.notEqual(resumed.status, 'completed');
      assert.equal(resumed.verification?.status, 'failed');
      assert.match(resumed.nextAction, /verification/i);
    });

    it('grants completed status only when verification is verified with evidence', async () => {
      await store.saveCheckpoint(allDoneTask);

      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: matchingInspector,
        verification: async () => verified,
      });

      assert.equal(resumed.status, 'completed');
      assert.deepEqual(resumed.verification, verified);
    });

    it('merges reservations that exist only in the budget journal before deciding to resume', async () => {
      await store.saveCheckpoint({ ...sampleTask, stateVersion: 3 });
      await store.saveBudgetJournal({
        schemaVersion: UC04_SCHEMA_VERSION,
        taskId: sampleTask.taskId,
        runId: sampleTask.runId,
        ledgers: [
          {
            scope: 'task',
            kind: 'tokens',
            limit: 10000,
            consumed: 2000,
            reservations: [{ reservationId: 'res-journal', keyedId: 'req-journal', amount: 700 }],
            configurationId: 'cfg-1',
            version: 4,
          },
        ],
        replanCount: 2,
        updatedAt: new Date().toISOString(),
      });

      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: matchingInspector,
      });

      assert.notEqual(resumed.status, 'running');
      const tokenLedger = resumed.budgetLedgers.find((l) => l.kind === 'tokens');
      assert.equal(tokenLedger?.reservations.length, 1);
      assert.equal(tokenLedger?.reservations[0]?.keyedId, 'req-journal');
      assert.equal(tokenLedger?.version, 4);
      const journal = await store.loadBudgetJournal(sampleTask.taskId);
      assert.equal(journal?.replanCount, 2);
    });

    it('persists reconciled ledgers back to the budget journal', async () => {
      await store.saveBudgetJournal({
        schemaVersion: UC04_SCHEMA_VERSION,
        taskId: sampleTask.taskId,
        runId: sampleTask.runId,
        ledgers: [
          {
            scope: 'task',
            kind: 'tokens',
            limit: 10000,
            consumed: 2000,
            reservations: [{ reservationId: 'res-journal', keyedId: 'req-journal', amount: 700 }],
            configurationId: 'cfg-1',
            version: 3,
          },
        ],
        replanCount: 1,
        updatedAt: new Date().toISOString(),
      });

      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: matchingInspector,
        confirmedOutcomes: [{ requestId: 'req-journal', outcome: 'not_dispatched', evidenceRef: 'receipt:none' }],
      });

      assert.equal(resumed.status, 'running');
      const journal = await store.loadBudgetJournal(sampleTask.taskId);
      const tokenLedger = journal?.ledgers.find((l) => l.kind === 'tokens');
      assert.equal(tokenLedger?.reservations.length, 0);
      assert.equal(tokenLedger?.consumed, 2000);
      assert.equal(journal?.runId, sampleTask.runId);
      assert.equal(journal?.replanCount, 1);
    });

    it('persists the suspended state as the latest checkpoint', async () => {
      await store.saveCheckpoint(withReservation(3));

      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: matchingInspector,
      });

      assert.equal(resumed.status, 'paused');
      assert.equal(resumed.stateVersion, 4);
      const latest = await store.loadLatestCheckpoint(sampleTask.taskId);
      assert.equal(latest?.state.status, 'paused');
      assert.equal(latest?.stateVersion, resumed.stateVersion);
    });

    it('consults the supplied verification capability before a persisted verified record', async () => {
      await store.saveCheckpoint({ ...allDoneTask, verification: verified });

      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: matchingInspector,
        verification: async () => ({ status: 'failed', evidenceRefs: ['tests:fail'], checkedAt: new Date().toISOString() }),
      });

      assert.notEqual(resumed.status, 'completed');
      assert.equal(resumed.verification?.status, 'failed');
      assert.match(resumed.nextAction, /verification/i);
    });

    it('ignores confirmed outcomes that bind to no known claim or reservation', async () => {
      await store.saveCheckpoint(withReservation(3));

      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: matchingInspector,
        confirmedOutcomes: [{ requestId: 'req-ghost', outcome: 'not_dispatched', evidenceRef: 'receipt:ghost' }],
      });

      assert.notEqual(resumed.status, 'running');
      const tokenLedger = resumed.budgetLedgers.find((l) => l.kind === 'tokens');
      assert.equal(tokenLedger?.reservations.length, 1);
      assert.equal(tokenLedger?.consumed, 2000);
    });

    it('binds a confirmed outcome through a dispatch claim reservation reference', async () => {
      await store.saveCheckpoint(withReservation(3));
      await store.saveDispatchClaim({
        claimId: 'claim-bound',
        taskId: sampleTask.taskId,
        runId: sampleTask.runId,
        stepId: 'step-2',
        actionId: 'req-interrupted',
        epoch: 1,
        stateVersion: 3,
        phase: 'dispatched',
        reservationRefs: ['res-1'],
        createdAt: new Date().toISOString(),
      });

      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: matchingInspector,
        confirmedOutcomes: [{ requestId: 'res-1', outcome: 'not_dispatched', evidenceRef: 'receipt:none' }],
      });

      assert.equal(resumed.status, 'running');
      const tokenLedger = resumed.budgetLedgers.find((l) => l.kind === 'tokens');
      assert.equal(tokenLedger?.reservations.length, 0);
    });

    it('suspends instead of reporting resume when the chosen step is blocked with no ready alternative', async () => {
      await store.saveCheckpoint({
        ...sampleTask,
        stateVersion: 3,
        plan: sampleTask.plan.map((s) => (s.id === 'step-1' ? { ...s, requiredEvidenceRefs: ['tests:unit'] } : s)),
      });

      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: matchingInspector,
      });

      assert.equal(resumed.status, 'paused');
      assert.match(resumed.nextAction, /Recovery blocked: step step-2 requires predecessor evidence from step-1/);
      const latest = await store.loadLatestCheckpoint(sampleTask.taskId);
      assert.equal(latest?.state.status, 'paused');
    });

    it('revalidates predecessor evidence against restored state', async () => {
      await store.saveCheckpoint({
        ...sampleTask,
        stateVersion: 3,
        plan: sampleTask.plan.map((s) =>
          s.id === 'step-1'
            ? { ...s, evidenceRefs: ['changed:file1.ts'], requiredEvidenceRefs: ['tests:unit'] }
            : s
        ),
      });

      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: matchingInspector,
      });

      assert.throws(
        () => new StepStateMachine().startStep(resumed, 'step-2'),
        (err: unknown) =>
          err instanceof DependencyNotMetError && (err as DependencyNotMetError).missingPredecessors.includes('step-1')
      );
    });

    it('fails closed when captureWorkspaceBaseline encounters non-zero git exit code', async () => {
      await assert.rejects(
        async () => {
          await captureWorkspaceBaseline(tempDir);
        },
        /Failed to get git/
      );
    });
  });

  describe('captureWorkspaceBaseline content hashing', () => {
    it('hashes real content for non-ASCII paths and rename targets', async () => {
      const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
      if (!gitAvailable) return;

      const repo = await mkdtemp(join(tmpdir(), 'slop-rec-git-'));
      try {
        const git = (args: string[]): void => {
          const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
          assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
        };
        git(['init', '-q']);
        git(['config', 'user.email', 'test@example.com']);
        git(['config', 'user.name', 'Test']);
        git(['config', 'core.precomposeunicode', 'false']);
        await writeFile(join(repo, 'naïve-文件.txt'), 'first\n', 'utf8');
        await writeFile(join(repo, 'a.txt'), 'first\n', 'utf8');
        git(['add', '.']);
        git(['commit', '-q', '-m', 'init']);

        await writeFile(join(repo, 'naïve-文件.txt'), 'dirty-one\n', 'utf8');
        const first = await captureWorkspaceBaseline(repo);
        await writeFile(join(repo, 'naïve-文件.txt'), 'dirty-two\n', 'utf8');
        const second = await captureWorkspaceBaseline(repo);
        assert.notEqual(first.trackedFilesHash, second.trackedFilesHash);

        git(['checkout', '--', 'naïve-文件.txt']);
        git(['mv', 'a.txt', 'réna med.txt']);
        await writeFile(join(repo, 'réna med.txt'), 'renamed-one\n', 'utf8');
        const renamedFirst = await captureWorkspaceBaseline(repo);
        await writeFile(join(repo, 'réna med.txt'), 'renamed-two\n', 'utf8');
        const renamedSecond = await captureWorkspaceBaseline(repo);
        assert.notEqual(renamedFirst.trackedFilesHash, renamedSecond.trackedFilesHash);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it('distinguishes different contents of an already-modified tracked file', async () => {
      const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
      if (!gitAvailable) return;

      const repo = await mkdtemp(join(tmpdir(), 'slop-rec-git-'));
      try {
        const git = (args: string[]): void => {
          const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
          assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
        };
        git(['init', '-q']);
        git(['config', 'user.email', 'test@example.com']);
        git(['config', 'user.name', 'Test']);
        await writeFile(join(repo, 'a.txt'), 'first\n', 'utf8');
        git(['add', 'a.txt']);
        git(['commit', '-q', '-m', 'init']);

        await writeFile(join(repo, 'a.txt'), 'dirty-one\n', 'utf8');
        const first = await captureWorkspaceBaseline(repo);
        await writeFile(join(repo, 'a.txt'), 'dirty-two\n', 'utf8');
        const second = await captureWorkspaceBaseline(repo);

        assert.equal(first.isClean, false);
        assert.equal(second.isClean, false);
        assert.notEqual(first.trackedFilesHash, second.trackedFilesHash);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });
  });
});
