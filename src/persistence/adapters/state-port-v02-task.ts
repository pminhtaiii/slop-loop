/**
 * Task-state operations for the durable UC-03 v0.2 state port: compare-and-swap transitions,
 * checkpoints and recovery.
 */
import { validateStateTransition, validateTaskState } from '../../contracts/foundation/uc03.ts';
import type { TaskState } from '../../contracts/foundation/uc03.ts';
import { isSafeStorageId } from '../store.ts';
import type { StatePortStore } from './state-port-v02-storage.ts';
import { equal } from './state-port-v02-admission.ts';

export interface TaskOperationOptions {
  readonly store: StatePortStore;
  readonly trustedTransitions: Readonly<Record<number, NonNullable<Parameters<typeof validateStateTransition>[2]>['trusted']>>;
}

export async function loadTask(options: TaskOperationOptions, taskId: string): Promise<TaskState | null> {
  if (!isSafeStorageId(taskId)) return null;
  return options.store.readTask(taskId);
}

export async function transition(options: TaskOperationOptions, state: TaskState, expectedVersion: number): Promise<TaskState> {
  let snapshot: TaskState;
  try {
    snapshot = structuredClone(state);
  } catch {
    throw new Error('Invalid transition state: not cloneable');
  }
  const validated = validateTaskState(snapshot);
  if (!validated.ok) throw new Error(`Invalid transition state: ${validated.errors.map(error => error.message).join(', ')}`);
  if (!isSafeStorageId(snapshot.taskId)) throw new Error('Invalid transition task id');
  const taskId = snapshot.taskId;
  return options.store.locked(taskId, async () => applyTransition(options, validated.value, expectedVersion));
}

/**
 * Writes the next task version. `expectedVersion` is the version the caller read; the stored value
 * is authoritative, so a concurrent write turns this into a CAS conflict rather than a lost update.
 */
export async function applyTransition(options: TaskOperationOptions, state: TaskState, expectedVersion: number): Promise<TaskState> {
  const { store } = options;
  const prior = await store.readTask(state.taskId);
  if (!prior) {
    if (expectedVersion !== 0 || state.stateVersion !== 1) throw new Error(`Task ${state.taskId} not found`);
    const ledgers = structuredClone(state.budgetLedgers ?? []);
    const saved: TaskState = { ...state, budgetLedgers: ledgers };
    await store.writeTask(state.taskId, saved);
    await store.writeJson(store.statePath(state.taskId, 'checkpoint.json'), saved);
    return structuredClone(saved);
  }
  if (expectedVersion !== prior.stateVersion || state.stateVersion !== expectedVersion + 1) {
    throw new Error(`CAS conflict: expected stateVersion ${prior.stateVersion + 1}, got ${state.stateVersion} (expectedVersion: ${expectedVersion})`);
  }
  if (!equal(state.budgetLedgers, prior.budgetLedgers)) throw new Error('Transition must retain current authoritative accounting');
  const trusted = options.trustedTransitions[state.stateVersion];
  const result = validateStateTransition(prior, state, { allowSameNode: false, ...(trusted !== undefined ? { trusted } : {}) });
  if (!result.ok) throw new Error(`State transition validation failed: ${result.errors.map(error => `${error.path}: ${error.message}`).join(', ')}`);
  if (state.runId !== prior.runId) throw new Error('Run changes are unsupported');
  const saved: TaskState = { ...result.value, budgetLedgers: prior.budgetLedgers ?? [] };
  await store.writeTask(state.taskId, saved);
  return structuredClone(saved);
}

export async function checkpoint(options: TaskOperationOptions, state: TaskState): Promise<void> {
  const { store } = options;
  let snapshot: TaskState;
  try {
    snapshot = structuredClone(state);
  } catch {
    throw new Error('Invalid checkpoint state: not cloneable');
  }
  const validated = validateTaskState(snapshot);
  if (!validated.ok) throw new Error(`Invalid checkpoint state: ${validated.errors.map(error => error.message).join(', ')}`);
  if (!isSafeStorageId(snapshot.taskId)) throw new Error('Invalid checkpoint task id');
  const taskId = snapshot.taskId;
  return store.locked(taskId, async () => {
    const prior = await store.readTask(taskId);
    if (!prior) throw new Error('Checkpoint requires an existing task');
    if (!equal(snapshot.budgetLedgers, prior.budgetLedgers)) throw new Error('Stale checkpoint accounting');
    if (snapshot.stateVersion === prior.stateVersion) {
      if (!equal(snapshot, prior)) throw new Error('Conflicting same-version checkpoint');
      await store.writeJson(store.statePath(taskId, 'checkpoint.json'), prior);
      return;
    }
    const saved = await applyTransition(options, validated.value, prior.stateVersion);
    await store.writeJson(store.statePath(taskId, 'checkpoint.json'), saved);
  });
}

export async function recover(options: TaskOperationOptions, taskId: string): Promise<TaskState> {
  const { store } = options;
  if (!isSafeStorageId(taskId)) throw new Error('Invalid recovery task id');
  const checkpointState = await store.readJson<TaskState>(store.statePath(taskId, 'checkpoint.json'));
  if (!checkpointState) throw new Error(`No checkpoint found for task ${taskId}`);
  const current = await store.readTask(taskId);
  const recovered: TaskState = { ...checkpointState, ...(current?.budgetLedgers?.length ? { budgetLedgers: current.budgetLedgers } : {}) };
  const validated = validateTaskState(recovered);
  if (!validated.ok) throw new Error(`Recovered task state invalid: ${validated.errors.map(error => error.message).join(', ')}`);
  return structuredClone(validated.value);
}
