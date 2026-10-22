import type {
  TaskState,
  ApprovalRequestBinding,
  DeliberatePauseRecord,
  PauseTaskInput,
  ResumeTaskInput,
} from './contracts.ts';
import type { DurableStore } from './store.ts';
import {
  UC04_SCHEMA_VERSION,
  validateTaskState,
  validateApprovalRequestBinding,
  validatePauseTaskInput,
  validateResumeTaskInput,
} from './contracts.ts';

export class StaleApprovalBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleApprovalBindingError';
  }
}

export class InFlightWorkPendingError extends Error {
  readonly outstandingAttemptRefs: readonly string[];

  constructor(message: string, outstandingAttemptRefs: readonly string[]) {
    super(message);
    this.name = 'InFlightWorkPendingError';
    this.outstandingAttemptRefs = outstandingAttemptRefs;
  }
}

export class StalePauseRevisionError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(message: string, expectedRevision: number, actualRevision: number) {
    super(message);
    this.name = 'StalePauseRevisionError';
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export interface HumanDecision {
  readonly requestId: string;
  readonly decision: 'approved' | 'rejected';
  readonly approvedBy: string;
  readonly reason?: string | undefined;
}

export interface ResumeApprovalOptions {
  readonly currentCommit?: string | undefined;
  readonly policyVersion?: string | undefined;
}

export async function pauseForApproval(
  state: TaskState,
  request: ApprovalRequestBinding,
  store: DurableStore
): Promise<TaskState> {
  const reqVal = validateApprovalRequestBinding(request);
  if (!reqVal.ok) {
    throw new Error(`Invalid approval request binding: ${reqVal.errors.map((e) => e.message).join(', ')}`);
  }

  return await store.withLock(`pause-${state.taskId}`, async () => {
    const latest = await store.loadLatestCheckpoint(state.taskId);
    if (latest && latest.stateVersion !== state.stateVersion) {
      throw new Error(
        `State version mismatch in pauseForApproval: current state has version ${state.stateVersion}, but latest checkpoint has version ${latest.stateVersion}`
      );
    }

    const pausedState: TaskState = {
      ...state,
      status: 'waiting_approval',
      pendingApproval: request,
      stateVersion: state.stateVersion + 1,
      nextAction: `Awaiting human decision for ${request.actionType} (${request.requestId})`,
    };

    const val = validateTaskState(pausedState);
    if (!val.ok) {
      throw new Error(`Invalid paused state: ${val.errors.map((e) => e.message).join(', ')}`);
    }

    await store.saveCheckpoint(pausedState);
    return pausedState;
  });
}

export async function resumeFromApproval(
  taskId: string,
  decision: HumanDecision,
  store: DurableStore,
  options: ResumeApprovalOptions = {}
): Promise<TaskState> {
  return await store.withLock(`pause-${taskId}`, async () => {
    const latestCp = await store.loadLatestCheckpoint(taskId);
    if (!latestCp) {
      throw new Error(`No checkpoint found for task: ${taskId}`);
    }

    const currentState = latestCp.state;
    if (currentState.status !== 'waiting_approval') {
      throw new Error(`Task ${taskId} is not awaiting approval (current status: ${currentState.status})`);
    }

    const pending = currentState.pendingApproval;
    if (!pending) {
      throw new Error(`Task ${taskId} has no pending approval record`);
    }

    if (pending.requestId !== decision.requestId) {
      throw new Error(`Approval request mismatch: expected ${pending.requestId}, got ${decision.requestId}`);
    }

    // Cryptographic & environment binding check (fail-closed)
    if (!options.currentCommit || options.currentCommit !== pending.repoCommit) {
      throw new StaleApprovalBindingError(
        `Stale approval: git commit mismatch. Approved at ${pending.repoCommit}, current commit is ${options.currentCommit ?? 'undefined'}`
      );
    }

    if (!options.policyVersion || options.policyVersion !== pending.policyVersion) {
      throw new StaleApprovalBindingError(
        `Stale approval: policy version mismatch. Approved under ${pending.policyVersion}, current policy is ${options.policyVersion ?? 'undefined'}`
      );
    }

    if (decision.decision === 'rejected') {
      const rejectionReason = decision.reason ?? 'Action rejected by human reviewer';
      const rejectedState: TaskState = {
        ...currentState,
        status: 'failed',
        stateVersion: currentState.stateVersion + 1,
        openRisks: [...(currentState.openRisks ?? []), `Approval rejected by ${decision.approvedBy}: ${rejectionReason}`],
        nextAction: 'Halt: Human approval was rejected',
      };

      const val = validateTaskState(rejectedState);
      if (!val.ok) throw new Error(`Invalid rejected state: ${val.errors.map((e) => e.message).join(', ')}`);
      await store.saveCheckpoint(rejectedState);
      return rejectedState;
    }

    // Approved: remove pendingApproval
    const { pendingApproval: _pending, ...rest } = currentState;
    void _pending;
    const resumedState: TaskState = {
      ...rest,
      status: 'running',
      stateVersion: currentState.stateVersion + 1,
      nextAction: `Execute approved action ${pending.actionType}`,
    };

    const val = validateTaskState(resumedState);
    if (!val.ok) throw new Error(`Invalid resumed state: ${val.errors.map((e) => e.message).join(', ')}`);
    await store.saveCheckpoint(resumedState);
    return resumedState;
  });
}

export async function pauseTask(
  store: DurableStore,
  input: PauseTaskInput,
  currentOutstandingAttempts: readonly string[] = []
): Promise<DeliberatePauseRecord> {
  const val = validatePauseTaskInput(input);
  if (!val.ok) {
    throw new Error(`Invalid PauseTaskInput: ${val.errors.map((e) => e.message).join(', ')}`);
  }

  return await store.withLock(`pause-${input.taskId}`, async () => {
    const existing = await store.loadPauseRecord(input.taskId);
    if (existing && existing.revision !== input.expectedRevision) {
      throw new StalePauseRevisionError(
        `Stale revision in pause request. Expected ${input.expectedRevision}, store has ${existing.revision}`,
        input.expectedRevision,
        existing.revision
      );
    }

    const nextRevision = (existing?.revision ?? 0) + 1;
    const nextEpoch = (existing?.epoch ?? 0) + 1;

    const record: DeliberatePauseRecord = {
      schemaVersion: UC04_SCHEMA_VERSION,
      taskId: input.taskId,
      active: true,
      pauseKey: input.pauseKey,
      operatorRef: input.operatorRef,
      acceptedAt: new Date().toISOString(),
      revision: nextRevision,
      epoch: nextEpoch,
      resumeKey: null,
      outstandingAttemptRefs: [...currentOutstandingAttempts],
    };

    await store.savePauseRecord(record);
    return record;
  });
}

export async function resumeTask(
  store: DurableStore,
  input: ResumeTaskInput
): Promise<DeliberatePauseRecord> {
  const val = validateResumeTaskInput(input);
  if (!val.ok) {
    throw new Error(`Invalid ResumeTaskInput: ${val.errors.map((e) => e.message).join(', ')}`);
  }

  return await store.withLock(`pause-${input.taskId}`, async () => {
    const existing = await store.loadPauseRecord(input.taskId);
    if (!existing || !existing.active) {
      throw new Error(`Task ${input.taskId} is not deliberately paused`);
    }

    if (existing.revision !== input.expectedRevision) {
      throw new StalePauseRevisionError(
        `Stale revision in resume request. Expected ${input.expectedRevision}, store has ${existing.revision}`,
        input.expectedRevision,
        existing.revision
      );
    }

    // Refuse early resume when outstanding in-flight attempts remain unsettled
    if (existing.outstandingAttemptRefs.length > 0) {
      throw new InFlightWorkPendingError(
        `Cannot resume task ${input.taskId}: in-flight attempts remain unsettled: ${existing.outstandingAttemptRefs.join(', ')}`,
        existing.outstandingAttemptRefs
      );
    }

    const updated: DeliberatePauseRecord = {
      ...existing,
      active: false,
      resumeKey: input.resumeKey,
      revision: existing.revision + 1,
    };

    await store.savePauseRecord(updated);
    return updated;
  });
}
