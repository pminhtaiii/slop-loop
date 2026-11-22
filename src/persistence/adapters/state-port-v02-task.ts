/**
 * Task-state operations for the durable UC-03 v0.2 state port: compare-and-swap transitions,
 * checkpoints and recovery.
 */
import { computeCanonicalSha256, validateStateTransition, validateTaskState } from '../../contracts/foundation/uc03.ts';
import type { TaskState } from '../../contracts/foundation/uc03.ts';
import { isSafeStorageId } from '../store.ts';
import type { StatePortStore } from './state-port-v02-storage.ts';
import { equal } from './state-port-v02-admission.ts';
import type { ControlRecordV02 } from './state-port-v02-types.ts';
import { DEFAULT_CONTROL } from './state-port-v02-types.ts';

export interface StagedCompletionBinding {
  readonly candidateDigest?: string | undefined;
  readonly expectedReviewHead?: number | undefined;
  readonly controlVersion?: number | undefined;
  readonly decisionAuthorityGeneration?: number | undefined;
}

export interface TaskOperationOptions {
  readonly store: StatePortStore;
  /** Host-supplied trusted facts keyed by the candidate state version; the owner may stage one. */
  readonly trustedTransitions: Record<number, NonNullable<Parameters<typeof validateStateTransition>[2]>['trusted']>;
  /** The owner's own AwaitPlan→Patch approval, derived from the recorded human decision; absent, no patch transition. */
  readonly trustedApproval?: ((taskId: string) => Promise<NonNullable<Parameters<typeof validateStateTransition>[2]>['trusted'] | undefined>) | undefined;
  readonly controlSeed?: ControlRecordV02 | undefined;
  readonly stagedBindings?: Record<number, StagedCompletionBinding> | undefined;
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

  const stagedBinding = options.stagedBindings?.[state.stateVersion];
  if (stagedBinding) {
    if (stagedBinding.expectedReviewHead !== undefined && prior.stateVersion !== stagedBinding.expectedReviewHead) {
      throw new Error(`Staged completion receipt rejected: expected Review head ${stagedBinding.expectedReviewHead}, got ${prior.stateVersion}`);
    }
    if (stagedBinding.candidateDigest !== undefined) {
      const candidateDigest = computeCanonicalSha256(state);
      if (candidateDigest !== stagedBinding.candidateDigest) {
        throw new Error('Staged completion receipt rejected: delivery candidate digest mismatch');
      }
    }
    if (stagedBinding.controlVersion !== undefined || stagedBinding.decisionAuthorityGeneration !== undefined) {
      const controlHead = await store.readControl(state.taskId, options.controlSeed ?? DEFAULT_CONTROL);
      if (stagedBinding.controlVersion !== undefined && controlHead.controlVersion !== stagedBinding.controlVersion) {
        throw new Error(`Delivery commit refused: control head version mismatch (expected ${stagedBinding.controlVersion}, got ${controlHead.controlVersion})`);
      }
      if (stagedBinding.decisionAuthorityGeneration !== undefined && controlHead.activeAuthorityRef?.decisionAuthorityGeneration !== stagedBinding.decisionAuthorityGeneration) {
        throw new Error(
          `Delivery commit refused: decision authority generation mismatch (expected ${stagedBinding.decisionAuthorityGeneration}, got ${controlHead.activeAuthorityRef?.decisionAuthorityGeneration})`,
        );
      }
    }
  } else if (trusted?.completion) {
    const rawReview = (trusted.completion as Record<string, unknown>).review as Record<string, unknown> | undefined;
    const recordedGeneration = ((trusted.completion as Record<string, unknown>).decisionAuthorityGeneration as number | undefined) ?? (rawReview?.decisionAuthorityGeneration as number | undefined);
    const recordedControlVersion = (trusted.completion as Record<string, unknown>).controlVersion as number | undefined;

    if (recordedControlVersion !== undefined || recordedGeneration !== undefined) {
      const controlHead = await store.readControl(state.taskId, options.controlSeed ?? DEFAULT_CONTROL);
      if (recordedControlVersion !== undefined && controlHead.controlVersion !== recordedControlVersion) {
        throw new Error(`Delivery commit refused: control head version mismatch (expected ${recordedControlVersion}, got ${controlHead.controlVersion})`);
      }
      if (recordedGeneration !== undefined && controlHead.activeAuthorityRef?.decisionAuthorityGeneration !== recordedGeneration) {
        throw new Error(`Delivery commit refused: decision authority generation mismatch (expected ${recordedGeneration}, got ${controlHead.activeAuthorityRef?.decisionAuthorityGeneration})`);
      }
    }
  }

  const result = validateStateTransition(prior, state, { allowSameNode: false, ...(trusted !== undefined ? { trusted } : {}) });
  if (!result.ok) throw new Error(`State transition validation failed: ${result.errors.map(error => `${error.path}: ${error.message}`).join(', ')}`);
  if (state.runId !== prior.runId) throw new Error('Run changes are unsupported');

  const saved: TaskState = { ...result.value, budgetLedgers: prior.budgetLedgers ?? [] };
  await store.writeTask(state.taskId, saved);

  if (Object.prototype.hasOwnProperty.call(options.trustedTransitions, state.stateVersion)) {
    Reflect.deleteProperty(options.trustedTransitions, state.stateVersion);
  }
  if (options.stagedBindings && Object.prototype.hasOwnProperty.call(options.stagedBindings, state.stateVersion)) {
    Reflect.deleteProperty(options.stagedBindings, state.stateVersion);
  }
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
