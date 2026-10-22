import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { TaskState, PlanStep, WorkspaceBaseline } from './contracts.ts';
import type { DurableStore } from './store.ts';
import { BudgetTracker } from './accounting.ts';
import { validateTaskState } from './contracts.ts';

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

export class DependencyNotMetError extends Error {
  readonly stepId: string;
  readonly missingPredecessors: readonly string[];

  constructor(stepId: string, missingPredecessors: readonly string[]) {
    super(`Step ${stepId} cannot start because predecessors are not done: ${missingPredecessors.join(', ')}`);
    this.name = 'DependencyNotMetError';
    this.stepId = stepId;
    this.missingPredecessors = missingPredecessors;
  }
}

export interface StepCompletionOptions {
  readonly changedFiles?: readonly string[] | undefined;
  readonly evidenceRefs?: readonly string[] | undefined;
}

export class StepStateMachine {
  checkPredecessors(state: TaskState, step: PlanStep): { ready: boolean; unsatisfied: string[] } {
    if (!step.predecessorIds || step.predecessorIds.length === 0) {
      return { ready: true, unsatisfied: [] };
    }
    const unsatisfied: string[] = [];
    for (const predId of step.predecessorIds) {
      const predStep = state.plan.find((s) => s.id === predId);
      if (!predStep || predStep.status !== 'done') {
        unsatisfied.push(predId);
      }
    }
    return { ready: unsatisfied.length === 0, unsatisfied };
  }

  startStep(state: TaskState, stepId: string): TaskState {
    const stepIdx = state.plan.findIndex((s) => s.id === stepId);
    if (stepIdx === -1) {
      throw new Error(`Step not found in plan: ${stepId}`);
    }

    const currentStep = state.plan[stepIdx];
    if (!currentStep) {
      throw new Error(`Step ${stepId} is missing`);
    }

    if (currentStep.status === 'done') {
      throw new Error(`Cannot start step ${stepId} with status done`);
    }

    // Check DAG predecessor readiness
    const depCheck = this.checkPredecessors(state, currentStep);
    if (!depCheck.ready) {
      throw new DependencyNotMetError(stepId, depCheck.unsatisfied);
    }

    const updatedStep: PlanStep = {
      ...currentStep,
      status: 'doing',
      startedAt: new Date().toISOString(),
    };

    const newPlan = [...state.plan];
    newPlan[stepIdx] = updatedStep;

    const nextState: TaskState = {
      ...state,
      plan: newPlan,
      currentStepIndex: stepIdx,
      status: 'running',
      stateVersion: state.stateVersion + 1,
      nextAction: `Executing step ${currentStep.title}`,
    };

    const val = validateTaskState(nextState);
    if (!val.ok) throw new Error(`Invalid transition: ${val.errors.map((e) => e.message).join(', ')}`);
    return val.value;
  }

  completeStep(state: TaskState, stepId: string, options: StepCompletionOptions = {}): TaskState {
    const stepIdx = state.plan.findIndex((s) => s.id === stepId);
    if (stepIdx === -1) {
      throw new Error(`Step not found in plan: ${stepId}`);
    }

    const currentStep = state.plan[stepIdx];
    if (!currentStep) {
      throw new Error(`Step ${stepId} is missing`);
    }

    if (currentStep.status !== 'doing') {
      throw new Error(`Cannot complete step ${stepId} with status ${currentStep.status}`);
    }

    const updatedStep: PlanStep = {
      ...currentStep,
      status: 'done',
      completedAt: new Date().toISOString(),
      ...(options.changedFiles ? { changedFiles: options.changedFiles } : {}),
      ...(options.evidenceRefs ? { evidenceRefs: options.evidenceRefs } : {}),
    };

    const newPlan = [...state.plan];
    newPlan[stepIdx] = updatedStep;

    const allChangedFiles = Array.from(
      new Set([...state.changedFiles, ...(options.changedFiles ?? [])])
    );

    const isAllDone = newPlan.every((s) => s.status === 'done');
    let nextStepIndex = stepIdx;
    if (!isAllDone) {
      const nextIdx = newPlan.findIndex((s) => s.status === 'todo');
      if (nextIdx !== -1) nextStepIndex = nextIdx;
    }

    const nextStep = newPlan[nextStepIndex];
    const nextAction = isAllDone
      ? 'Task completed'
      : nextStep
        ? `Proceed with step ${nextStep.title}`
        : 'Awaiting next action';

    const nextState: TaskState = {
      ...state,
      plan: newPlan,
      changedFiles: allChangedFiles,
      currentStepIndex: nextStepIndex,
      status: isAllDone ? 'completed' : 'running',
      stateVersion: state.stateVersion + 1,
      nextAction,
    };

    const val = validateTaskState(nextState);
    if (!val.ok) throw new Error(`Invalid transition: ${val.errors.map((e) => e.message).join(', ')}`);
    return val.value;
  }

  failStep(state: TaskState, stepId: string, errorMessage: string): TaskState {
    const stepIdx = state.plan.findIndex((s) => s.id === stepId);
    if (stepIdx === -1) {
      throw new Error(`Step not found in plan: ${stepId}`);
    }

    const currentStep = state.plan[stepIdx];
    if (!currentStep) {
      throw new Error(`Step ${stepId} is missing`);
    }

    const updatedStep: PlanStep = {
      ...currentStep,
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: errorMessage,
    };

    const newPlan = [...state.plan];
    newPlan[stepIdx] = updatedStep;

    const nextState: TaskState = {
      ...state,
      plan: newPlan,
      status: 'failed',
      stateVersion: state.stateVersion + 1,
      openRisks: [...(state.openRisks ?? []), `Step ${stepId} failed: ${errorMessage}`],
      nextAction: `Halted due to failure in step ${stepId}: ${errorMessage}`,
    };

    const val = validateTaskState(nextState);
    if (!val.ok) throw new Error(`Invalid transition: ${val.errors.map((e) => e.message).join(', ')}`);
    return val.value;
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
  if (statusRes.status !== 0) {
    throw new Error(`Failed to get git status: ${statusRes.stderr || 'non-zero exit code'}`);
  }
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
  return await store.withLock(`pause-${taskId}`, async () => {
  const latestCheckpoint = await store.loadLatestCheckpoint(taskId);
  if (!latestCheckpoint) {
    throw new Error(`No valid checkpoint found to resume task: ${taskId}`);
  }

  const savedState = latestCheckpoint.state;

  // 1. Check if deliberately paused
  const pauseRecord = await store.loadPauseRecord(taskId);
  if (pauseRecord?.active) {
    const pausedState: TaskState = {
      ...savedState,
      status: 'paused',
      nextAction: `Task is deliberately paused by operator (${pauseRecord.operatorRef}). Explicit resume required.`,
    };
    return pausedState;
  }

  // 2. Inspect and validate workspace assumptions
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

  // 3. Reconcile budget reservations
  const tracker = new BudgetTracker(savedState.budgetLedgers);
  if (options.unresolvedReservationAction === 'charge_as_consumed') {
    for (const ledger of savedState.budgetLedgers) {
      for (const res of ledger.reservations) {
        tracker.settleReservation(res.reservationId, res.amount);
      }
    }
  }

  // 4. Find next actionable step respecting DAG dependencies
  const machine = new StepStateMachine();
  let nextStepIdx = savedState.plan.findIndex((s) => s.status !== 'done');
  if (nextStepIdx === -1) {
    nextStepIdx = Math.max(0, savedState.plan.length - 1);
  } else {
    // If the found step has unmet predecessors, check if another step is eligible
    const step = savedState.plan[nextStepIdx];
    if (step && !machine.checkPredecessors(savedState, step).ready) {
      const readyIdx = savedState.plan.findIndex(
        (s) => s.status === 'todo' && machine.checkPredecessors(savedState, s).ready
      );
      if (readyIdx !== -1) nextStepIdx = readyIdx;
    }
  }

  const nextStep = savedState.plan[nextStepIdx];
  const isAllDone = savedState.plan.every((s) => s.status === 'done');
  const isTerminalOrBlocked =
    savedState.status === 'waiting_approval' || savedState.status === 'failed';

  const status = isTerminalOrBlocked
    ? savedState.status
    : isAllDone
      ? 'completed'
      : 'running';

  const nextAction = isTerminalOrBlocked
    ? savedState.nextAction
    : isAllDone
      ? 'Task completed'
      : nextStep
        ? `Resume from step ${nextStep.title}`
        : 'Awaiting next action';

  const currentStepIndex = isTerminalOrBlocked
    ? savedState.currentStepIndex
    : nextStepIdx;

  const resumedState: TaskState = {
    ...savedState,
    currentStepIndex,
    budgetLedgers: tracker.getLedgers(),
    status,
    stateVersion: savedState.stateVersion + 1,
    nextAction,
  };

  const val = validateTaskState(resumedState);
  if (!val.ok) {
    throw new Error(`Resumed state validation failed: ${val.errors.map((e) => e.message).join(', ')}`);
  }

  await store.saveCheckpoint(resumedState);
  return resumedState;
  });
}
