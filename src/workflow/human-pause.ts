import type { TaskState, ApprovalRequestBinding } from '../state/types.ts';
import type { DurableStore } from '../state/durable-store.ts';
import { validateTaskState, validateApprovalRequestBinding } from '../contracts/uc04.ts';

export class StaleApprovalBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleApprovalBindingError';
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
}

export async function resumeFromApproval(
  taskId: string,
  decision: HumanDecision,
  store: DurableStore,
  options: ResumeApprovalOptions = {}
): Promise<TaskState> {
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

  // Cryptographic & environment binding check
  if (options.currentCommit && options.currentCommit !== pending.repoCommit) {
    throw new StaleApprovalBindingError(
      `Stale approval: git commit mismatch. Approved at ${pending.repoCommit}, current commit is ${options.currentCommit}`
    );
  }

  if (options.policyVersion && options.policyVersion !== pending.policyVersion) {
    throw new StaleApprovalBindingError(
      `Stale approval: policy version mismatch. Approved under ${pending.policyVersion}, current policy is ${options.policyVersion}`
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

  // Approved
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
}
