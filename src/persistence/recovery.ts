import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  TaskState,
  PlanStep,
  WorkspaceBaseline,
  VerificationRecord,
  BudgetLedger,
} from './contracts.ts';
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
  readonly verification?: VerificationRecord | undefined;
}

export type VerificationCapability = (state: TaskState) => VerificationRecord | Promise<VerificationRecord>;

export interface ConfirmedOutcome {
  readonly requestId: string;
  readonly outcome: 'effect_observed' | 'not_dispatched';
  readonly evidenceRef: string;
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
        continue;
      }
      const evidence = predStep.evidenceRefs ?? [];
      const required = predStep.requiredEvidenceRefs ?? [];
      if (evidence.length === 0 || !required.every((id) => evidence.includes(id))) {
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

    const verification = options.verification;
    const isVerified = verification?.status === 'verified' && verification.evidenceRefs.length > 0;
    const isAllDone = newPlan.every((s) => s.status === 'done');

    let nextStepIndex = stepIdx;
    if (!isAllDone) {
      const nextIdx = newPlan.findIndex((s) => s.status === 'todo');
      if (nextIdx !== -1) nextStepIndex = nextIdx;
    }

    const nextStep = newPlan[nextStepIndex];
    const status: TaskState['status'] = isAllDone ? (isVerified ? 'completed' : 'paused') : 'running';
    const nextAction = isAllDone
      ? isVerified
        ? 'Task completed'
        : `Verification required before completion (status: ${verification?.status ?? 'unavailable'})`
      : nextStep
        ? `Proceed with step ${nextStep.title}`
        : 'Awaiting next action';

    const nextState: TaskState = {
      ...state,
      plan: newPlan,
      changedFiles: allChangedFiles,
      currentStepIndex: nextStepIndex,
      status,
      stateVersion: state.stateVersion + 1,
      nextAction,
      ...(verification ? { verification } : {}),
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

  const statusRes = spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: repoRoot, encoding: 'utf8' });
  if (statusRes.status !== 0) {
    throw new Error(`Failed to get git status: ${statusRes.stderr || 'non-zero exit code'}`);
  }
  const statusLines = statusRes.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  const isClean = statusLines.length === 0;

  const contentHash = createHash('sha256');
  if (isClean) {
    contentHash.update(commitHash);
  } else {
    for (const line of statusLines) {
      const code = line.slice(0, 2);
      const rawPath = line.slice(3);
      const targetPath = rawPath.includes(' -> ') ? rawPath.slice(rawPath.lastIndexOf(' -> ') + 4) : rawPath;
      const filePath = targetPath.startsWith('"') && targetPath.endsWith('"') ? targetPath.slice(1, -1) : targetPath;
      contentHash.update(code).update('\0').update(filePath).update('\0');
      try {
        contentHash.update(await readFile(join(repoRoot, filePath)));
      } catch {
        contentHash.update('<unreadable>');
      }
      contentHash.update('\0');
    }
  }

  return {
    commitHash,
    branch,
    isClean,
    trackedFilesHash: contentHash.digest('hex'),
  };
}

export interface ReconcileOptions {
  readonly repoRoot?: string;
  readonly gitInspector?: (repoRoot: string) => Promise<WorkspaceBaseline>;
  readonly unresolvedReservationAction?: 'charge_as_consumed' | 'retain_as_uncertain';
  readonly verification?: VerificationCapability;
  readonly confirmedOutcomes?: readonly ConfirmedOutcome[];
}

function attemptStepId(state: TaskState): string {
  const step =
    state.plan.find((s) => s.status === 'doing') ??
    state.plan.find((s) => s.status !== 'done') ??
    state.plan[0];
  return step?.id ?? 'unknown-step';
}

function suspendedState(state: TaskState, ledgers: readonly BudgetLedger[], reason: string): TaskState {
  return {
    ...state,
    budgetLedgers: [...ledgers],
    status: 'paused',
    nextAction: reason,
  };
}

async function resolveVerification(
  state: TaskState,
  capability: VerificationCapability | undefined
): Promise<VerificationRecord> {
  const persisted = state.verification;
  if (persisted && persisted.status === 'verified' && persisted.evidenceRefs.length > 0) {
    return persisted;
  }
  if (!capability) {
    return { status: 'unavailable', evidenceRefs: [], checkedAt: new Date().toISOString() };
  }
  return await capability(state);
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

    const persistedTask = await store.loadTask(taskId);
    const savedState =
      persistedTask && persistedTask.stateVersion > latestCheckpoint.state.stateVersion
        ? persistedTask
        : latestCheckpoint.state;

    const pauseRecord = await store.loadPauseRecord(taskId);
    if (pauseRecord?.active) {      const pausedState: TaskState = {
        ...savedState,
        status: 'paused',
        nextAction: `Task is deliberately paused by operator (${pauseRecord.operatorRef}). Explicit resume required.`,
      };
      return pausedState;
    }

    const inspector = options.gitInspector ?? captureWorkspaceBaseline;
    const currentWorkspace = await inspector(options.repoRoot ?? process.cwd());
    const expectedWorkspace = savedState.workspaceBaseline;

    if (currentWorkspace.commitHash !== expectedWorkspace.commitHash) {
      throw new WorkspaceDriftError(
        `Workspace drift detected: commit mismatch. Expected ${expectedWorkspace.commitHash}, got ${currentWorkspace.commitHash}`,
        currentWorkspace,
        expectedWorkspace
      );
    }

    if (currentWorkspace.branch !== expectedWorkspace.branch) {
      throw new WorkspaceDriftError(
        `Workspace drift detected: branch mismatch. Expected ${expectedWorkspace.branch}, got ${currentWorkspace.branch}`,
        currentWorkspace,
        expectedWorkspace
      );
    }

    if (expectedWorkspace.isClean && !currentWorkspace.isClean) {
      throw new WorkspaceDriftError(
        'Workspace drift detected: repository was clean when checkpointed but is now dirty',
        currentWorkspace,
        expectedWorkspace
      );
    }

    if (currentWorkspace.trackedFilesHash !== expectedWorkspace.trackedFilesHash) {
      throw new WorkspaceDriftError(
        'Workspace drift detected: tracked file content mismatch',
        currentWorkspace,
        expectedWorkspace
      );
    }

    const currentEpoch = pauseRecord?.epoch ?? 1;
    const existingClaims = await store.loadDispatchClaims(taskId);
    const unsettledClaims = existingClaims.filter((c) => c.phase !== 'reconciled');
    const mismatchedClaims = unsettledClaims.filter(
      (c) => c.epoch !== currentEpoch || c.stateVersion > savedState.stateVersion
    );

    if (mismatchedClaims.length > 0) {
      return suspendedState(
        savedState,
        savedState.budgetLedgers,
        `Recovery refused: dispatch claim epoch or state version mismatch (${mismatchedClaims
          .map((c) => c.claimId)
          .join(', ')}); explicit reconciliation required`
      );
    }

    const outcomeByRequest = new Map<string, ConfirmedOutcome>();
    for (const outcome of options.confirmedOutcomes ?? []) {
      if (outcome.evidenceRef.trim()) outcomeByRequest.set(outcome.requestId, outcome);
    }

    const tracker = new BudgetTracker(savedState.budgetLedgers);
    const released = new Set<string>();
    const resolvedReservationIds = new Set<string>();

    for (const ledger of savedState.budgetLedgers) {
      for (const reservation of ledger.reservations) {
        const outcome = outcomeByRequest.get(reservation.keyedId);
        if (!outcome) continue;
        if (outcome.outcome === 'not_dispatched') {
          released.add(reservation.reservationId);
          resolvedReservationIds.add(reservation.reservationId);
        } else if (options.unresolvedReservationAction === 'charge_as_consumed') {
          tracker.settleReservation(reservation.reservationId, reservation.amount);
          resolvedReservationIds.add(reservation.reservationId);
        }
      }
    }

    let ledgers = tracker.getLedgers();
    if (released.size > 0) {
      ledgers = ledgers.map((l) => ({
        ...l,
        reservations: l.reservations.filter((r) => !released.has(r.reservationId)),
      }));
    }

    const unresolved = ledgers.flatMap((l) => l.reservations);

    if (unresolved.length > 0) {
      const now = new Date().toISOString();
      const stepId = attemptStepId(savedState);
      for (const reservation of unresolved) {
        const claimId = `rec-${createHash('sha256').update(reservation.reservationId).digest('hex').slice(0, 16)}`;
        const alreadyClaimed = existingClaims.some(
          (c) => c.claimId === claimId || c.reservationRefs.includes(reservation.reservationId)
        );
        if (alreadyClaimed) continue;
        await store.saveDispatchClaim({
          claimId,
          taskId,
          runId: savedState.runId,
          stepId,
          actionId: reservation.keyedId,
          epoch: currentEpoch,
          stateVersion: savedState.stateVersion,
          phase: 'uncertain',
          reservationRefs: [reservation.reservationId],
          createdAt: now,
        });
      }
      return suspendedState(
        savedState,
        ledgers,
        `Recovery suspended: unresolved reservation(s) ${unresolved
          .map((r) => r.keyedId)
          .join(', ')} require outcome evidence before resuming`
      );
    }

    const remainingClaims = unsettledClaims.filter(
      (c) => !c.reservationRefs.some((ref) => resolvedReservationIds.has(ref))
    );

    if (remainingClaims.length > 0) {
      return suspendedState(
        savedState,
        ledgers,
        `Recovery suspended: unsettled dispatch claim(s) ${remainingClaims
          .map((c) => c.claimId)
          .join(', ')} require outcome evidence before resuming`
      );
    }

    for (const claim of unsettledClaims) {
      if (!claim.reservationRefs.some((ref) => resolvedReservationIds.has(ref))) continue;
      await store.saveDispatchClaim({ ...claim, phase: 'reconciled', settledAt: new Date().toISOString() });
    }

    const machine = new StepStateMachine();
    let nextStepIdx = savedState.plan.findIndex((s) => s.status !== 'done');
    if (nextStepIdx === -1) {
      nextStepIdx = Math.max(0, savedState.plan.length - 1);
    } else {
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

    let verification: VerificationRecord | undefined;
    let status: TaskState['status'];
    let nextAction: string;

    if (isTerminalOrBlocked) {
      status = savedState.status;
      nextAction = savedState.nextAction;
    } else if (isAllDone) {
      verification = await resolveVerification(savedState, options.verification);
      const isVerified = verification.status === 'verified' && verification.evidenceRefs.length > 0;
      status = isVerified ? 'completed' : 'paused';
      nextAction = isVerified
        ? 'Task completed'
        : `Verification required before completion (status: ${verification.status})`;
    } else {
      status = 'running';
      nextAction = nextStep ? `Resume from step ${nextStep.title}` : 'Awaiting next action';
    }

    const currentStepIndex = isTerminalOrBlocked ? savedState.currentStepIndex : nextStepIdx;

    const resumedState: TaskState = {
      ...savedState,
      currentStepIndex,
      budgetLedgers: ledgers,
      status,
      stateVersion: savedState.stateVersion + 1,
      nextAction,
      ...(verification ? { verification } : {}),
    };

    const val = validateTaskState(resumedState);
    if (!val.ok) {
      throw new Error(`Resumed state validation failed: ${val.errors.map((e) => e.message).join(', ')}`);
    }

    await store.saveCheckpoint(resumedState);
    return resumedState;
  });
}
