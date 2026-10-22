import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { TaskState, CheckpointRecord, DeliberatePauseRecord } from './contracts.ts';
import {
  validateTaskState,
  validateCheckpointRecord,
  validateDeliberatePauseRecord,
} from './contracts.ts';

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
    await rename(tempPath, filePath);
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

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
    this.stateDir = join(this.baseDir, 'tasks');
    this.checkpointDir = join(this.baseDir, 'checkpoints');
    this.pauseDir = join(this.baseDir, 'pauses');
    this.lockDir = join(this.baseDir, 'locks');
  }

  async init(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await mkdir(this.checkpointDir, { recursive: true });
    await mkdir(this.pauseDir, { recursive: true });
    await mkdir(this.lockDir, { recursive: true });
  }

  async withLock<T>(resourceId: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.lockDir, { recursive: true });
    const lockPath = join(this.lockDir, `${resourceId}.lock`);
    const handle = await open(lockPath, 'wx').catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Resource ${resourceId} is busy / already locked.`);
      }
      throw err;
    });

    const fileStat = await handle.stat();
    try {
      return await operation();
    } finally {
      await handle.close();
      const current = await lstat(lockPath).catch(() => null);
      if (current && current.ino === fileStat.ino && current.dev === fileStat.dev) {
        await unlink(lockPath).catch(() => undefined);
      }
    }
  }

  getTaskPath(taskId: string): string {
    return join(this.stateDir, `${taskId}.json`);
  }

  getCheckpointDir(taskId: string): string {
    return join(this.checkpointDir, taskId);
  }

  getCheckpointPath(taskId: string, checkpointId: string): string {
    return join(this.getCheckpointDir(taskId), `${checkpointId}.json`);
  }

  getPauseRecordPath(taskId: string): string {
    return join(this.pauseDir, `${taskId}.json`);
  }

  async saveTask(task: TaskState): Promise<void> {
    const val = validateTaskState(task);
    if (!val.ok) {
      throw new Error(`Invalid TaskState: ${val.errors.map((e) => e.message).join(', ')}`);
    }
    await this.init();
    const taskPath = this.getTaskPath(task.taskId);
    await atomicWrite(taskPath, JSON.stringify(task, null, 2));
  }

  async loadTask(taskId: string): Promise<TaskState | null> {
    const taskPath = this.getTaskPath(taskId);
    try {
      const data = await readFile(taskPath, 'utf8');
      const parsed: unknown = JSON.parse(data);
      const val = validateTaskState(parsed);
      if (!val.ok) throw new Error(`Corrupted TaskState: ${val.errors.map((e) => e.message).join(', ')}`);
      return val.value;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async saveCheckpoint(task: TaskState): Promise<CheckpointRecord> {
    const val = validateTaskState(task);
    if (!val.ok) {
      throw new Error(`Cannot checkpoint invalid task: ${val.errors.map((e) => e.message).join(', ')}`);
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
      throw new Error(`Invalid checkpoint record generated: ${recordVal.errors.map((e) => e.message).join(', ')}`);
    }

    const cpPath = this.getCheckpointPath(task.taskId, checkpointId);
    await atomicWrite(cpPath, JSON.stringify(record, null, 2));
    await this.saveTask({
      ...task,
      lastCheckpointId: checkpointId,
    });

    return record;
  }

  async loadCheckpoint(taskId: string, checkpointId: string): Promise<CheckpointRecord> {
    const cpPath = this.getCheckpointPath(taskId, checkpointId);
    const data = await readFile(cpPath, 'utf8');
    const record = JSON.parse(data) as CheckpointRecord;

    const val = validateCheckpointRecord(record);
    if (!val.ok) {
      throw new Error(`Corrupted checkpoint record: ${val.errors.map((e) => e.message).join(', ')}`);
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
      const jsonFiles = files.filter((f) => f.endsWith('.json'));
      if (jsonFiles.length === 0) return null;

      const parsedFiles = jsonFiles.map((file) => {
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
      throw new Error(`Invalid DeliberatePauseRecord: ${val.errors.map((e) => e.message).join(', ')}`);
    }
    await this.init();
    const pausePath = this.getPauseRecordPath(record.taskId);
    await atomicWrite(pausePath, JSON.stringify(record, null, 2));
  }

  async loadPauseRecord(taskId: string): Promise<DeliberatePauseRecord | null> {
    const pausePath = this.getPauseRecordPath(taskId);
    try {
      const data = await readFile(pausePath, 'utf8');
      const parsed: unknown = JSON.parse(data);
      const val = validateDeliberatePauseRecord(parsed);
      if (!val.ok) throw new Error(`Corrupted DeliberatePauseRecord: ${val.errors.map((e) => e.message).join(', ')}`);
      return val.value;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}
