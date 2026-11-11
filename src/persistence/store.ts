import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { TaskState, CheckpointRecord, DeliberatePauseRecord, BudgetJournalRecord, DispatchClaimRecord } from './contracts.ts';
import { validateTaskState, validateCheckpointRecord, validateDeliberatePauseRecord, validateBudgetJournalRecord, validateDispatchClaimRecord } from './contracts.ts';
import { requireSafeId, executeWithLock, executeWithLockRetry, getJournalLockId } from './lock.ts';

export { isSafeStorageId, getJournalLockId } from './lock.ts';

export function computeStateChecksum(val: unknown): string {
  const json = JSON.stringify(val);
  return createHash('sha256').update(json).digest('hex');
}

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tempPath = join(dir, `.tmp-${randomUUID()}`);
  const handle = await open(tempPath, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    let renamed = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        await rename(tempPath, filePath);
        renamed = true;
        break;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EBUSY') {
          await new Promise(r => setTimeout(r, 10));
          continue;
        }
        throw err;
      }
    }
    if (!renamed) {
      throw new Error(`Failed to atomically rename ${tempPath} to ${filePath} after 15 attempts.`);
    }
  } finally {
    await unlink(tempPath).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
  }
}

export class DurableStore {
  readonly baseDir: string;
  readonly stateDir: string;
  readonly checkpointDir: string;
  readonly pauseDir: string;
  readonly lockDir: string;
  readonly journalDir: string;
  readonly claimDir: string;

  constructor(baseDir = './.slop-loop/store') {
    this.baseDir = resolve(baseDir);
    this.stateDir = join(this.baseDir, 'tasks');
    this.checkpointDir = join(this.baseDir, 'checkpoints');
    this.pauseDir = join(this.baseDir, 'pauses');
    this.lockDir = join(this.baseDir, 'locks');
    this.journalDir = join(this.baseDir, 'journals');
    this.claimDir = join(this.baseDir, 'claims');
  }

  async init(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await mkdir(this.checkpointDir, { recursive: true });
    await mkdir(this.pauseDir, { recursive: true });
    await mkdir(this.lockDir, { recursive: true });
    await mkdir(this.journalDir, { recursive: true });
    await mkdir(this.claimDir, { recursive: true });
    await this.assertContained();
  }

  private async assertContainedIn(dir: string, base: string): Promise<void> {
    const real = await realpath(dir);
    if (real !== base && !real.startsWith(base + sep)) {
      throw new Error(`Storage directory escapes base directory: ${dir}`);
    }
  }

  private async assertContained(): Promise<void> {
    const base = await realpath(this.baseDir);
    for (const dir of [this.stateDir, this.checkpointDir, this.pauseDir, this.lockDir, this.journalDir, this.claimDir]) {
      await this.assertContainedIn(dir, base);
    }
  }

  private async requireContainedParent(filePath: string): Promise<void> {
    await this.assertContainedIn(dirname(filePath), await realpath(this.baseDir));
  }

  private async readContained(filePath: string): Promise<string | null> {
    try {
      await this.requireContainedParent(filePath);
      return await readFile(filePath, 'utf8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return null;
    }
  }

  async withLock<T>(resourceId: string, operation: () => Promise<T>): Promise<T> {
    return executeWithLock(this.lockDir, resourceId, operation, p => this.requireContainedParent(p));
  }

  async withLockRetry<T>(
    resourceId: string,
    operation: () => Promise<T>,
    options?: {
      retries?: number;
      delayMs?: number;
      maxRetries?: number;
      retryDelayMs?: number;
      staleThresholdMs?: number;
    },
  ): Promise<T> {
    return executeWithLockRetry(this.lockDir, resourceId, operation, options, p => this.requireContainedParent(p));
  }

  getTaskPath(taskId: string): string {
    return join(this.stateDir, `${requireSafeId(taskId, 'task id')}.json`);
  }

  getCheckpointDir(taskId: string): string {
    return join(this.checkpointDir, requireSafeId(taskId, 'task id'));
  }

  getCheckpointPath(taskId: string, checkpointId: string): string {
    return join(this.getCheckpointDir(taskId), `${requireSafeId(checkpointId, 'checkpoint id')}.json`);
  }

  getPauseRecordPath(taskId: string): string {
    return join(this.pauseDir, `${requireSafeId(taskId, 'task id')}.json`);
  }

  getBudgetJournalPath(taskId: string): string {
    return join(this.journalDir, `${requireSafeId(taskId, 'task id')}.json`);
  }

  getClaimPath(taskId: string, claimId: string): string {
    return join(this.claimDir, requireSafeId(taskId, 'task id'), `${requireSafeId(claimId, 'claim id')}.json`);
  }

  async saveTask(task: TaskState): Promise<void> {
    const val = validateTaskState(task);
    if (!val.ok) {
      throw new Error(`Invalid TaskState: ${val.errors.map(e => e.message).join(', ')}`);
    }
    await this.init();
    const taskPath = this.getTaskPath(task.taskId);
    await this.requireContainedParent(taskPath);
    await atomicWrite(taskPath, JSON.stringify(task, null, 2));
  }

  async loadTask(taskId: string): Promise<TaskState | null> {
    const data = await this.readContained(this.getTaskPath(taskId));
    if (data === null) return null;
    const val = validateTaskState(JSON.parse(data) as unknown);
    if (!val.ok) throw new Error(`Corrupted TaskState: ${val.errors.map(e => e.message).join(', ')}`);
    if (val.value.taskId !== taskId) throw new Error(`Task record mismatch: expected ${taskId}, found ${val.value.taskId}`);
    return val.value;
  }

  async saveTaskState(task: TaskState): Promise<void> {
    return this.saveTask(task);
  }

  async loadTaskState(taskId: string): Promise<TaskState | null> {
    return this.loadTask(taskId);
  }

  async saveCheckpoint(task: TaskState): Promise<CheckpointRecord> {
    const val = validateTaskState(task);
    if (!val.ok) {
      throw new Error(`Cannot checkpoint invalid task: ${val.errors.map(e => e.message).join(', ')}`);
    }

    const latest = await this.loadLatestCheckpoint(task.taskId);
    if (latest && task.stateVersion <= latest.stateVersion) {
      throw new Error(`Non-monotonic stateVersion: task version ${task.stateVersion} is <= latest checkpoint version ${latest.stateVersion}`);
    }

    await this.init();
    const cpDir = this.getCheckpointDir(task.taskId);
    await mkdir(cpDir, { recursive: true });

    const checkpointId = `cp-${Date.now()}-v${task.stateVersion}`;
    const timestamp = new Date().toISOString();
    const checksum = computeStateChecksum(task);

    const record: CheckpointRecord = {
      checkpointId,
      taskId: task.taskId,
      runId: task.runId,
      stepIndex: task.currentStepIndex,
      stateVersion: task.stateVersion,
      timestamp,
      state: task,
      checksum,
    };

    const recordVal = validateCheckpointRecord(record);
    if (!recordVal.ok) {
      throw new Error(`Invalid checkpoint record generated: ${recordVal.errors.map(e => e.message).join(', ')}`);
    }

    const cpPath = this.getCheckpointPath(task.taskId, checkpointId);
    await this.requireContainedParent(cpPath);
    await atomicWrite(cpPath, JSON.stringify(record, null, 2));
    await this.saveTask({
      ...task,
      lastCheckpointId: checkpointId,
    });

    return record;
  }

  async loadCheckpoint(taskId: string, checkpointId: string): Promise<CheckpointRecord> {
    const data = await this.readContained(this.getCheckpointPath(taskId, checkpointId));
    if (data === null) throw new Error(`Checkpoint not found: ${checkpointId}`);
    const record = JSON.parse(data) as CheckpointRecord;

    const val = validateCheckpointRecord(record);
    if (!val.ok) {
      throw new Error(`Corrupted checkpoint record: ${val.errors.map(e => e.message).join(', ')}`);
    }
    if (val.value.taskId !== taskId) {
      throw new Error(`Checkpoint mismatch: expected ${taskId}, found ${val.value.taskId}`);
    }

    const expectedChecksum = computeStateChecksum(record.state);
    if (expectedChecksum !== record.checksum) {
      throw new Error(`Checkpoint integrity failure: checksum mismatch for ${checkpointId}`);
    }

    return record;
  }

  async loadLatestCheckpoint(taskId: string): Promise<CheckpointRecord | null> {
    const cpDir = this.getCheckpointDir(taskId);
    try {
      const files = await readdir(cpDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      if (jsonFiles.length === 0) return null;

      const parsedFiles = jsonFiles.map(file => {
        const match = file.match(/^cp-(\d+)-v(\d+)\.json$/);
        const timestamp = match && match[1] ? Number(match[1]) : 0;
        const version = match && match[2] ? Number(match[2]) : 0;
        return { file, timestamp, version };
      });
      parsedFiles.sort((a, b) => {
        if (a.version !== b.version) return a.version - b.version;
        return a.timestamp - b.timestamp;
      });
      const latest = parsedFiles[parsedFiles.length - 1];
      if (!latest) return null;
      const checkpointId = latest.file.replace('.json', '');
      return await this.loadCheckpoint(taskId, checkpointId);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async savePauseRecord(record: DeliberatePauseRecord): Promise<void> {
    const val = validateDeliberatePauseRecord(record);
    if (!val.ok) {
      throw new Error(`Invalid DeliberatePauseRecord: ${val.errors.map(e => e.message).join(', ')}`);
    }
    await this.init();
    const pausePath = this.getPauseRecordPath(record.taskId);
    await this.requireContainedParent(pausePath);
    await atomicWrite(pausePath, JSON.stringify(record, null, 2));
  }

  async loadPauseRecord(taskId: string): Promise<DeliberatePauseRecord | null> {
    const data = await this.readContained(this.getPauseRecordPath(taskId));
    if (data === null) return null;
    const val = validateDeliberatePauseRecord(JSON.parse(data) as unknown);
    if (!val.ok) throw new Error(`Corrupted DeliberatePauseRecord: ${val.errors.map(e => e.message).join(', ')}`);
    if (val.value.taskId !== taskId) throw new Error(`Pause record mismatch: expected ${taskId}, found ${val.value.taskId}`);
    return val.value;
  }

  async saveBudgetJournal(record: BudgetJournalRecord): Promise<void> {
    const val = validateBudgetJournalRecord(record);
    if (!val.ok) {
      throw new Error(`Invalid BudgetJournalRecord: ${val.errors.map(e => e.message).join(', ')}`);
    }
    await this.init();
    const journalPath = this.getBudgetJournalPath(record.taskId);
    await this.requireContainedParent(journalPath);
    await atomicWrite(journalPath, JSON.stringify(record, null, 2));
  }

  async loadBudgetJournal(taskId: string): Promise<BudgetJournalRecord | null> {
    const data = await this.readContained(this.getBudgetJournalPath(taskId));
    if (data === null) return null;
    const val = validateBudgetJournalRecord(JSON.parse(data) as unknown);
    if (!val.ok) throw new Error(`Corrupted BudgetJournalRecord: ${val.errors.map(e => e.message).join(', ')}`);
    if (val.value.taskId !== taskId) throw new Error(`Budget journal mismatch: expected ${taskId}, found ${val.value.taskId}`);
    return val.value;
  }

  async mutateBudgetJournal(
    taskId: string,
    mutator: (current: BudgetJournalRecord | null) => Promise<BudgetJournalRecord> | BudgetJournalRecord,
    options?: { retries?: number; delayMs?: number; maxRetries?: number; retryDelayMs?: number },
  ): Promise<BudgetJournalRecord> {
    requireSafeId(taskId, 'task id');
    return this.withLockRetry(
      getJournalLockId(taskId),
      async () => {
        const current = await this.loadBudgetJournal(taskId);
        const updated = await mutator(current);
        if (updated.taskId !== taskId) {
          throw new Error(`mutateBudgetJournal: mutator returned mismatched taskId: expected ${taskId}, got ${updated.taskId}`);
        }
        await this.saveBudgetJournal(updated);
        return updated;
      },
      options,
    );
  }

  async saveDispatchClaim(record: DispatchClaimRecord): Promise<void> {
    const val = validateDispatchClaimRecord(record);
    if (!val.ok) {
      throw new Error(`Invalid DispatchClaimRecord: ${val.errors.map(e => e.message).join(', ')}`);
    }
    await this.init();
    const claimPath = this.getClaimPath(record.taskId, record.claimId);
    await mkdir(dirname(claimPath), { recursive: true });
    await this.requireContainedParent(claimPath);
    await atomicWrite(claimPath, JSON.stringify(record, null, 2));
  }

  async loadDispatchClaims(taskId: string): Promise<DispatchClaimRecord[]> {
    const claimDir = join(this.claimDir, requireSafeId(taskId, 'task id'));
    let files: string[];
    try {
      files = await readdir(claimDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    await this.requireContainedParent(join(claimDir, 'x'));
    const records: DispatchClaimRecord[] = [];
    for (const file of files.filter(f => f.endsWith('.json')).sort()) {
      const data = await this.readContained(join(claimDir, file));
      if (data === null) continue;
      const val = validateDispatchClaimRecord(JSON.parse(data) as unknown);
      if (!val.ok) throw new Error(`Corrupted DispatchClaimRecord: ${val.errors.map(e => e.message).join(', ')}`);
      if (val.value.taskId !== taskId) {
        throw new Error(`Dispatch claim mismatch: expected ${taskId}, found ${val.value.taskId}`);
      }
      records.push(val.value);
    }
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.claimId.localeCompare(b.claimId));
    return records;
  }
}
