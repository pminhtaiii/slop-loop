/**
 * T040 read fencing: the owner side of `GuardedReadOwnerPort` over the durable v0.2 control head.
 *
 * `observeReadControl` projects the persisted head for one bound task; `fenceReadControl` re-reads
 * that head under the same per-task lock the journal writers take and returns a receipt only when
 * every observed field still matches. Drift (pause, hold, epoch or policy change) therefore refuses
 * the read before its closure runs. It writes nothing and creates no read authority of its own.
 */
import { journalSnapshotV02 } from '../../approvals/control-v02.ts';
import type { JournalSnapshotV02 } from '../../approvals/control-v02.ts';
import { computeCanonicalSha256 } from '../../contracts/foundation/uc03.ts';
import type { PolicyAuthorityRefV02 } from '../../contracts/foundation/uc03.ts';
import type { GuardedReadControlObservation, GuardedReadFenceReceipt, GuardedReadOwnerPort } from '../../foundation/guarded-read-capability.ts';
import { isSafeStorageId } from '../store.ts';
import type { DurableStatePortV02 } from './state-port-v02.ts';

export interface StateReadFenceBinding {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
}

/** Canonical read-policy identity: the persisted authority ref, scoped to the task it was issued for. */
export function stateReadPolicyDigest(taskId: string, authorityRef: PolicyAuthorityRefV02): string {
  return computeCanonicalSha256({ schemaVersion: 'uc04-read-policy/0.2-draft', taskId, authorityRef });
}

/** The projected control head, or null when no validated head with a published policy authority exists. */
function headOf(port: DurableStatePortV02, taskId: string): { snapshot: JournalSnapshotV02; policyDigest: string } | null {
  const snapshot = journalSnapshotV02(port.getJournalSnapshot(taskId));
  const authorityRef = snapshot?.activeAuthorityRef;
  return snapshot && authorityRef ? { snapshot, policyDigest: stateReadPolicyDigest(taskId, authorityRef) } : null;
}

/** The store's fencing counter: its epoch, raised to the highest persisted fence generation. */
function fencingGenerationOf(snapshot: JournalSnapshotV02): number {
  return Math.max(snapshot.epoch, ...snapshot.fenceProofs.map(proof => proof.fencingGeneration));
}

/** Reads the persisted identity, revision and control head for the bound task; null when no head is usable. */
async function readObservation(port: DurableStatePortV02, binding: StateReadFenceBinding): Promise<GuardedReadControlObservation | null> {
  const { taskId, workspaceId, repositoryId } = binding;
  const task = await port.loadTask(taskId);
  if (!task) return null;
  // A persisted task whose ownership differs from the binding is a binding error, never drift.
  if (task.workspaceId !== workspaceId || task.repositoryId !== repositoryId) {
    throw new Error(`STATE_READ_FENCE_FOREIGN: task ${taskId} belongs to another workspace or repository`);
  }
  const head = headOf(port, taskId);
  if (!head) return null;
  return {
    taskId,
    workspaceId,
    repositoryId,
    revisionDigest: task.repositoryRevisionDigest,
    controlVersion: head.snapshot.controlVersion,
    mode: head.snapshot.mode,
    holdRef: head.snapshot.holdRef,
    fencingGeneration: fencingGenerationOf(head.snapshot),
    policyDigest: head.policyDigest,
    readAllowed: head.snapshot.mode === 'runnable' && head.snapshot.holdRef === null,
  };
}

function sameObservation(left: GuardedReadControlObservation, right: GuardedReadControlObservation): boolean {
  return (
    left.taskId === right.taskId &&
    left.workspaceId === right.workspaceId &&
    left.repositoryId === right.repositoryId &&
    left.revisionDigest === right.revisionDigest &&
    left.controlVersion === right.controlVersion &&
    left.mode === right.mode &&
    left.holdRef === right.holdRef &&
    left.fencingGeneration === right.fencingGeneration &&
    left.policyDigest === right.policyDigest &&
    left.readAllowed === right.readAllowed
  );
}

/**
 * Builds the owner read-fencing protocol for one bound task/workspace/repository. A task with no
 * persisted head, no published policy authority or no task record refuses observation; any drift
 * between observation and fence returns null so no read closure runs.
 */
export function createStateReadFence(port: DurableStatePortV02, binding: StateReadFenceBinding): GuardedReadOwnerPort {
  const { taskId, workspaceId, repositoryId } = binding;
  if (!isSafeStorageId(taskId) || !isSafeStorageId(workspaceId) || !isSafeStorageId(repositoryId)) {
    throw new Error('MISSING_READ_FENCE_BINDING: task, workspace and repository ids must be safe ids');
  }

  return {
    async observeReadControl(): Promise<GuardedReadControlObservation> {
      const observation = await readObservation(port, binding);
      if (!observation) throw new Error(`STATE_READ_FENCE_UNAVAILABLE: no readable control head is persisted for ${taskId}`);
      return observation;
    },

    fenceReadControl(observation: GuardedReadControlObservation): Promise<GuardedReadFenceReceipt | null> {
      // Re-read under the writers' task lock: no control write can land between the read and the receipt.
      return port.store.withLockRetry(`uc03v02-${taskId}`, async () => {
        // A head that no longer projects (paused with no persisted epoch, say) is drift, not a match.
        const current = await readObservation(port, binding);
        if (!current || !current.readAllowed || !observation || !sameObservation(current, observation)) return null;
        return {
          receiptId: `read-fence-${computeCanonicalSha256({ ...current }).slice(7, 27)}`,
          taskId,
          workspaceId,
          repositoryId,
          revisionDigest: current.revisionDigest,
          controlVersion: current.controlVersion,
          fencingGeneration: current.fencingGeneration,
          policyDigest: current.policyDigest,
        };
      });
    },
  };
}
