/**
 * Storage primitives for the durable UC-03 v0.2 state port: the on-disk layout, atomic JSON
 * reads/writes, the per-task lock, and the per-record accessors.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateTaskState } from '../../contracts/foundation/uc03.ts';
import type { AttemptOutcomeReceiptV02, AttemptReconciliationReceiptV02, TaskState } from '../../contracts/foundation/uc03.ts';
import { atomicWrite, isSafeStorageId, type DurableStore } from '../store.ts';
import type { ControlRecordV02, FenceProofV02, RecoveryEvidenceV02, StoredAttemptV02, StoredClaimV02 } from './state-port-v02-types.ts';

export class StatePortStore {
  readonly store: DurableStore;

  constructor(store: DurableStore) {
    this.store = store;
  }

  taskDir(taskId: string): string {
    return dirname(this.store.getClaimPath(taskId, 'task'));
  }

  statePath(taskId: string, name: string): string {
    return join(this.taskDir(taskId), 'v02', name);
  }

  async readJson<T>(path: string): Promise<T | null> {
    const data = await readFile(path, 'utf8').catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    });
    return data === null ? null : (JSON.parse(data) as T);
  }

  async writeJson(path: string, value: unknown): Promise<void> {
    await atomicWrite(path, JSON.stringify(value, null, 2));
  }

  locked<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    return this.store.withLock(`uc03v02-${taskId}`, operation);
  }

  async readControl(taskId: string, fallback: ControlRecordV02): Promise<ControlRecordV02> {
    return (await this.readJson<ControlRecordV02>(this.statePath(taskId, 'control.json'))) ?? fallback;
  }

  async readTask(taskId: string): Promise<TaskState | null> {
    const task = await this.readJson<TaskState>(this.statePath(taskId, 'task.json'));
    if (!task) return null;
    const validated = validateTaskState(task);
    if (!validated.ok) throw new Error(`Corrupted UC-03 task state: ${validated.errors.map(error => error.message).join(', ')}`);
    return validated.value;
  }

  async readClaim(taskId: string, claimId: string): Promise<StoredClaimV02 | null> {
    if (!isSafeStorageId(claimId)) return null;
    return this.readJson<StoredClaimV02>(this.store.getClaimPath(taskId, claimId));
  }

  async readAttempt(taskId: string, attemptId: string): Promise<StoredAttemptV02 | null> {
    if (!isSafeStorageId(attemptId)) return null;
    return this.readJson<StoredAttemptV02>(this.statePath(taskId, `attempt-${attemptId}.json`));
  }

  async readOutcome(taskId: string, receiptId: string): Promise<AttemptOutcomeReceiptV02 | null> {
    if (!isSafeStorageId(receiptId)) return null;
    return this.readJson<AttemptOutcomeReceiptV02>(this.statePath(taskId, `outcome-${receiptId}.json`));
  }

  async readReconciliation(taskId: string, reconciliationId: string): Promise<AttemptReconciliationReceiptV02 | null> {
    if (!isSafeStorageId(reconciliationId)) return null;
    return this.readJson<AttemptReconciliationReceiptV02>(this.statePath(taskId, `recon-${reconciliationId}.json`));
  }

  async readFence(taskId: string, claimId: string): Promise<FenceProofV02 | null> {
    if (!isSafeStorageId(claimId)) return null;
    return this.readJson<FenceProofV02>(this.statePath(taskId, `fence-${claimId}.json`));
  }

  async readRecovery(taskId: string, predecessorReceiptId: string): Promise<RecoveryEvidenceV02 | null> {
    if (!isSafeStorageId(predecessorReceiptId)) return null;
    return this.readJson<RecoveryEvidenceV02>(this.statePath(taskId, `recovery-${predecessorReceiptId}.json`));
  }

  async writeClaim(taskId: string, claim: StoredClaimV02): Promise<void> {
    await this.writeJson(this.store.getClaimPath(taskId, claim.receipt.claimId), claim);
  }

  async writeControl(taskId: string, control: ControlRecordV02): Promise<void> {
    await this.writeJson(this.statePath(taskId, 'control.json'), control);
  }

  async writeTask(taskId: string, task: TaskState): Promise<void> {
    await this.writeJson(this.statePath(taskId, 'task.json'), task);
  }

  /** Resolves the owning task of a claim without a taskId argument (begin/record/reconcile). */
  async findClaimTask(claimId: string): Promise<{ readonly taskId: string; readonly claim: StoredClaimV02 } | null> {
    if (!isSafeStorageId(claimId)) return null;
    let taskIds: string[];
    try {
      taskIds = await readdir(this.store.claimDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    for (const taskId of taskIds) {
      if (!isSafeStorageId(taskId)) continue;
      const claim = await this.readClaim(taskId, claimId);
      if (claim) return { taskId, claim };
    }
    return null;
  }
}
