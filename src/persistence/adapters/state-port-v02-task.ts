/**
 * Task-state operations for the durable UC-03 v0.2 state port: compare-and-swap transitions,
 * checkpoints and recovery.
 */
import { validateStateTransition, validateTaskState } from '../../contracts/foundation/uc03.ts';
import type { TaskState } from '../../contracts/foundation/uc03.ts';
import { isSafeStorageId } from '../store.ts';
import type { StatePortStore } from './state-port-v02-storage.ts';
import { equal } from './state-port-v02-admission.ts';
import { readDecisionBindings, rollbackDecisionBindings } from './state-port-v02-verification-records.ts';

export interface TaskOperationOptions {
  readonly store: StatePortStore;
  /** Host-supplied trusted facts keyed by the candidate state version; the owner may stage one. */
  readonly trustedTransitions: Record<number, NonNullable<Parameters<typeof validateStateTransition>[2]>['trusted']>;
  /** The owner's own AwaitPlan→Patch approval, derived from the recorded human decision; absent, no patch transition. */
  readonly trustedApproval?: ((taskId: string) => Promise<NonNullable<Parameters<typeof validateStateTransition>[2]>['trusted'] | undefined>) | undefined;
  /** Persists the issued plan decision binding on an accepted AwaitPlan→Patch transition. */
  readonly commitApproval?: ((taskId: string) => Promise<boolean>) | undefined;
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
  const trusted = options.trustedTransitions[state.stateVersion] ?? (await derivedTrusted(options, state, prior));
  const result = validateStateTransition(prior, state, { allowSameNode: false, ...(trusted !== undefined ? { trusted } : {}) });
  if (!result.ok) throw new Error(`State transition validation failed: ${result.errors.map(error => `${error.path}: ${error.message}`).join(', ')}`);
  if (state.runId !== prior.runId) throw new Error('Run changes are unsupported');
  const saved: TaskState = { ...result.value, budgetLedgers: prior.budgetLedgers ?? [] };

  if (prior.node === 'AwaitPlan' && result.value.node === 'Patch' && options.commitApproval) {
    const priorBindings = readDecisionBindings(store, state.taskId);
    let bound = false;
    try {
      bound = await options.commitApproval(state.taskId);
      if (!bound) throw new Error('Failed to bind issued plan approval decision');
      await store.writeTask(state.taskId, saved);
    } catch (err) {
      if (bound) {
        try {
          await rollbackDecisionBindings(store, state.taskId, priorBindings);
        } catch (rollbackErr) {
          const writeErr: Error & { recoveryRequired?: boolean; taskId?: string; rollbackError?: unknown } = err instanceof Error ? err : new Error(String(err));
          Object.assign(writeErr, { recoveryRequired: true, taskId: state.taskId, rollbackError: rollbackErr });
          if (!writeErr.message.startsWith('PATCH_RECOVERY_REQUIRED:')) {
            writeErr.message = `PATCH_RECOVERY_REQUIRED: ${writeErr.message}`;
          }
          throw writeErr;
        }
      }
      throw err;
    }
    return structuredClone(saved);
  }

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

/**
 * The owner-derived trusted facts for a transition the caller supplied none for. Only the
 * AwaitPlan→Patch approval is derivable from durable owner state; every other edge stays as before.
 */
async function derivedTrusted(options: TaskOperationOptions, state: TaskState, prior: TaskState): Promise<NonNullable<Parameters<typeof validateStateTransition>[2]>['trusted'] | undefined> {
  if (!options.trustedApproval || prior.node !== 'AwaitPlan' || state.node !== 'Patch') return undefined;
  return options.trustedApproval(prior.taskId);
}
