import { createHash } from 'node:crypto';
import type {
  TaskState,
  PlanStep,
  WorkspaceBaseline,
  VerificationRecord,
  BudgetLedger,
  BudgetReservationItem,
} from './contracts.ts';
import type { DurableStore } from './store.ts';
import { BudgetTracker } from './accounting.ts';
import { validateTaskState, UC04_SCHEMA_VERSION } from './contracts.ts';
import { captureWorkspaceBaseline } from './workspace-baseline.ts';
import { attemptStepId, findOutcome, ledgerDigest, mergeLedgers, suspendedState } from './recovery-ledgers.ts';

export { captureWorkspaceBaseline };

const errorText = (errors: readonly { readonly message: string }[]): string => errors.map((e) => e.message).join(', ');

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
    if (!val.ok) throw new Error(`Invalid transition: ${errorText(val.errors)}`);
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
    if (!val.ok) throw new Error(`Invalid transition: ${errorText(val.errors)}`);
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
    if (!val.ok) throw new Error(`Invalid transition: ${errorText(val.errors)}`);
    return val.value;
  }
}

export interface ReconcileOptions {
  readonly repoRoot?: string;
  readonly gitInspector?: (repoRoot: string) => Promise<WorkspaceBaseline>;
  readonly unresolvedReservationAction?: 'charge_as_consumed' | 'retain_as_uncertain';
  readonly verification?: VerificationCapability;
  readonly confirmedOutcomes?: readonly ConfirmedOutcome[];
}

async function resolveVerification(
  state: TaskState,
  capability: VerificationCapability | undefined
): Promise<VerificationRecord> {
  if (capability) return await capability(state);
  const persisted = state.verification;
  if (persisted?.status === 'verified' && persisted.evidenceRefs.length > 0) return persisted;
  return { status: 'unavailable', evidenceRefs: [], checkedAt: new Date().toISOString() };
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
    if (pauseRecord?.active) {
      const pausedState: TaskState = {
        ...savedState,
        status: 'paused',
        nextAction: `Task is deliberately paused by operator (${pauseRecord.operatorRef}). Explicit resume required.`,
      };
      return pausedState;
    }

    const journal = await store.loadBudgetJournal(taskId);
    const baseLedgers = mergeLedgers(journal?.ledgers ?? [], savedState.budgetLedgers);
    const journalDigest = ledgerDigest(journal?.ledgers ?? []);
    const persistJournal = async (ledgers: readonly BudgetLedger[]): Promise<void> => {
      if (ledgerDigest(ledgers) === journalDigest) return;
      await store.saveBudgetJournal({
        schemaVersion: UC04_SCHEMA_VERSION,
        taskId,
        runId: journal?.runId ?? savedState.runId,
        ledgers,
        replanCount: journal?.replanCount ?? 0,
        updatedAt: new Date().toISOString(),
      });
    };
    const suspend = async (ledgers: readonly BudgetLedger[], reason: string): Promise<TaskState> => {
      const suspended = suspendedState(savedState, ledgers, reason);
      const val = validateTaskState(suspended);
      if (!val.ok) throw new Error(`Suspended state validation failed: ${errorText(val.errors)}`);
      await store.saveCheckpoint(suspended);
      return suspended;
    };

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
      return await suspend(
        baseLedgers,
        `Recovery refused: dispatch claim epoch or state version mismatch (${mismatchedClaims
          .map((c) => c.claimId)
          .join(', ')}); explicit reconciliation required`
      );
    }

    const outcomeByRequest = new Map<string, ConfirmedOutcome>();
    for (const outcome of options.confirmedOutcomes ?? []) {
      if (outcome.evidenceRef.trim()) outcomeByRequest.set(outcome.requestId, outcome);
    }

    const outcomeFor = (reservation: BudgetReservationItem): ConfirmedOutcome | undefined =>
      findOutcome(reservation, outcomeByRequest);

    const tracker = new BudgetTracker(baseLedgers);
    const released = new Set<string>();
    const resolvedReservationIds = new Set<string>();

    for (const ledger of baseLedgers) {
      for (const reservation of ledger.reservations) {
        const outcome = outcomeFor(reservation);
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
      await persistJournal(ledgers);
      return await suspend(
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
      await persistJournal(ledgers);
      return await suspend(
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
    let blocked: { readonly id: string; readonly missing: readonly string[] } | undefined;
    if (nextStepIdx === -1) {
      nextStepIdx = Math.max(0, savedState.plan.length - 1);
    } else {
      const step = savedState.plan[nextStepIdx];
      const check = step ? machine.checkPredecessors(savedState, step) : { ready: true, unsatisfied: [] };
      if (step && !check.ready) {
        const readyIdx = savedState.plan.findIndex(
          (s) => s.status === 'todo' && machine.checkPredecessors(savedState, s).ready
        );
        if (readyIdx !== -1) nextStepIdx = readyIdx;
        else blocked = { id: step.id, missing: check.unsatisfied };
      }
    }

    const isTerminalOrBlocked =
      savedState.status === 'waiting_approval' || savedState.status === 'failed';

    if (blocked && !isTerminalOrBlocked) {
      await persistJournal(ledgers);
      return await suspend(
        ledgers,
        `Recovery blocked: step ${blocked.id} requires predecessor evidence from ${blocked.missing.join(', ')}`
      );
    }

    const nextStep = savedState.plan[nextStepIdx];
    const isAllDone = savedState.plan.every((s) => s.status === 'done');

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
      throw new Error(`Resumed state validation failed: ${errorText(val.errors)}`);
    }

    await store.saveCheckpoint(resumedState);
    await persistJournal(ledgers);
    return resumedState;
  });
}
