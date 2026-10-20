import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { TaskState, WorkspaceBaseline } from './types.ts';
import type { DurableStore } from './durable-store.ts';
import { BudgetTracker } from './budget-tracker.ts';
import { validateTaskState } from '../contracts/uc04.ts';

export class WorkspaceDriftError extends Error {
  readonly current: WorkspaceBaseline;
  readonly expected: WorkspaceBaseline;

  constructor(message: string, current: WorkspaceBaseline, expected: WorkspaceBaseline) {
    super(message);
    this.name = 'WorkspaceDriftError';
    this.current = current;
    this.expected = expected;
  }
}

export async function captureWorkspaceBaseline(repoRoot: string): Promise<WorkspaceBaseline> {
  const revParse = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  if (revParse.status !== 0) {
    throw new Error(`Failed to get git commit: ${revParse.stderr}`);
  }
  const commitHash = revParse.stdout.trim();

  const branchRes = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  const branch = branchRes.status === 0 ? branchRes.stdout.trim() : 'HEAD';

  const statusRes = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
  const statusOutput = statusRes.stdout.trim();
  const isClean = statusOutput.length === 0;

  const filesHash = createHash('sha256').update(statusOutput || commitHash).digest('hex');

  return {
    commitHash,
    branch,
    isClean,
    trackedFilesHash: filesHash,
  };
}

export interface ReconcileOptions {
  readonly repoRoot?: string;
  readonly gitInspector?: (repoRoot: string) => Promise<WorkspaceBaseline>;
  readonly unresolvedReservationAction?: 'charge_as_consumed' | 'retain_as_uncertain';
}

export async function reconcileAndResume(
  taskId: string,
  store: DurableStore,
  options: ReconcileOptions = {}
): Promise<TaskState> {
  const latestCheckpoint = await store.loadLatestCheckpoint(taskId);
  if (!latestCheckpoint) {
    throw new Error(`No valid checkpoint found to resume task: ${taskId}`);
  }

  const savedState = latestCheckpoint.state;

  // 1. Inspect and validate workspace assumptions
  const inspector = options.gitInspector ?? captureWorkspaceBaseline;
  const currentWorkspace = await inspector(options.repoRoot ?? process.cwd());

  if (currentWorkspace.commitHash !== savedState.workspaceBaseline.commitHash) {
    throw new WorkspaceDriftError(
      `Workspace drift detected: commit mismatch. Expected ${savedState.workspaceBaseline.commitHash}, got ${currentWorkspace.commitHash}`,
      currentWorkspace,
      savedState.workspaceBaseline
    );
  }

  if (savedState.workspaceBaseline.isClean && !currentWorkspace.isClean) {
    throw new WorkspaceDriftError(
      'Workspace drift detected: repository was clean when checkpointed but is now dirty',
      currentWorkspace,
      savedState.workspaceBaseline
    );
  }

  // 2. Reconcile budget reservations
  const tracker = new BudgetTracker(savedState.budgetLedgers);
  if (options.unresolvedReservationAction === 'charge_as_consumed') {
    for (const ledger of savedState.budgetLedgers) {
      for (const res of ledger.reservations) {
        tracker.settle(res.keyedId, { amount: res.amount });
      }
    }
  }

  // 3. Find next actionable step
  let nextStepIdx = savedState.plan.findIndex((s) => s.status !== 'done');
  if (nextStepIdx === -1) {
    nextStepIdx = Math.max(0, savedState.plan.length - 1);
  }

  const resumedState: TaskState = {
    ...savedState,
    currentStepIndex: nextStepIdx,
    budgetLedgers: tracker.getLedgers(),
    status: savedState.plan.every((s) => s.status === 'done') ? 'completed' : 'running',
    stateVersion: savedState.stateVersion + 1,
  };

  const val = validateTaskState(resumedState);
  if (!val.ok) {
    throw new Error(`Resumed state validation failed: ${val.errors.map((e) => e.message).join(', ')}`);
  }

  await store.saveCheckpoint(resumedState);
  return resumedState;
}
