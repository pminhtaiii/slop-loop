/** Reload and confirm owner state before effects and after transitions. */
import { computeCanonicalSha256, validateTaskState, type BugTask, type StatePort, type TaskState } from '../contracts/foundation/uc03.ts';
import { samePersistedTransition, taskStateMatchesTask } from './graph-validation.ts';

function samePersistedState(left: TaskState, right: TaskState, allowAccountingChange = false): boolean {
  try {
    const comparable = (state: TaskState) => {
      const { budgetLedgers, ...taskState } = state;
      return allowAccountingChange ? taskState : { ...taskState, budgetLedgers: budgetLedgers ?? [] };
    };
    const leftComparable = comparable(left);
    const rightComparable = comparable(right);
    return computeCanonicalSha256(leftComparable) === computeCanonicalSha256(rightComparable);
  } catch {
    return false;
  }
}

export async function reloadAuthoritativeState(
  expected: TaskState,
  statePort: StatePort,
  options: { readonly allowAccountingChange?: boolean | undefined } = {},
): Promise<{ readonly ok: true; readonly state: TaskState } | { readonly ok: false; readonly reason: string }> {
  let current: TaskState | null;
  try {
    current = await statePort.loadTask(expected.taskId);
  } catch {
    return { ok: false, reason: 'Authoritative task state could not be reloaded' };
  }
  if (!current || !validateTaskState(current).ok || !samePersistedState(current, expected, options.allowAccountingChange ?? false)) {
    return { ok: false, reason: 'Task state changed or is invalid before the next workflow effect' };
  }
  return { ok: true, state: current };
}

export async function loadCurrentOwnerState(
  task: BugTask,
  statePort: StatePort,
): Promise<{ readonly ok: true; readonly state: TaskState } | { readonly ok: false; readonly reason: string }> {
  let current: TaskState | null;
  try {
    current = await statePort.loadTask(task.taskId);
  } catch {
    return { ok: false, reason: 'Authoritative task state could not be loaded after an uncertain effect' };
  }
  if (!current || !validateTaskState(current).ok || !taskStateMatchesTask(current, task)) {
    return { ok: false, reason: 'Owner state after an uncertain effect is missing, invalid, or belongs to another task' };
  }
  return { ok: true, state: current };
}

export async function transitionState(port: StatePort, next: TaskState, previousVersion: number): Promise<TaskState> {
  if (next.stateVersion !== previousVersion + 1) throw new Error('State transition version does not follow the expected owner version');
  const returned = await port.transition(next, previousVersion);
  const reloaded = await reloadAuthoritativeState(returned, port);
  if (!reloaded.ok) throw new Error(reloaded.reason);
  const persisted = reloaded.state;
  if (!samePersistedTransition(persisted, next)) {
    throw new Error('StatePort returned a transition that differs from its persisted owner state');
  }
  return persisted;
}

