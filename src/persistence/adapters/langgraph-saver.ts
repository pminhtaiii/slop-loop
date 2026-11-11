import { MemorySaver, type Checkpoint, type CheckpointMetadata, type CheckpointTuple } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { mkdir, readFile, readdir, unlink, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DurableStore } from '../store.ts';

export interface DurableCheckpointSaverOptions {
  baseDir?: string;
  store?: DurableStore;
}

function encodeStorageData(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __b64__: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) {
    return value.map(encodeStorageData);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = encodeStorageData(v);
    }
    return out;
  }
  return value;
}

function decodeStorageData(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    if ('__b64__' in (value as Record<string, unknown>) && typeof (value as Record<string, unknown>).__b64__ === 'string') {
      return new Uint8Array(Buffer.from((value as { __b64__: string }).__b64__, 'base64'));
    }
    if (Array.isArray(value)) {
      return value.map(decodeStorageData);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = decodeStorageData(v);
    }
    return out;
  }
  return value;
}

function sanitizeKey(key: string): string {
  return encodeURIComponent(key).replace(/\./g, '%2E').replace(/[*]/g, '_');
}

/**
 * DurableCheckpointSaver integrates LangGraph's BaseCheckpointSaver contract
 * with UC-04 DurableStore storage, persisting LangGraph checkpoints, metadata,
 * and pending writes across process lifecycles.
 */
export class DurableCheckpointSaver extends MemorySaver {
  private readonly storageDir: string;
  private restoredThreads = new Set<string>();
  private threadQueues = new Map<string, Promise<void>>();

  constructor(target?: DurableStore | string | DurableCheckpointSaverOptions) {
    super();
    if (target instanceof DurableStore) {
      this.storageDir = join(target.baseDir, 'langgraph');
    } else if (typeof target === 'string') {
      this.storageDir = resolve(target);
    } else if (target && typeof target === 'object') {
      if (target.store) {
        this.storageDir = join(target.store.baseDir, 'langgraph');
      } else if (target.baseDir) {
        this.storageDir = resolve(target.baseDir);
      } else {
        this.storageDir = resolve('./.slop-loop/store/langgraph');
      }
    } else {
      this.storageDir = resolve('./.slop-loop/store/langgraph');
    }
  }

  public getStorageDir(): string {
    return this.storageDir;
  }

  private getThreadFilePath(threadId: string): string {
    const filePath = resolve(this.storageDir, `${sanitizeKey(threadId)}.json`);
    if (!filePath.startsWith(resolve(this.storageDir))) {
      throw new Error(`Unsafe threadId escapes storageDir: ${threadId}`);
    }
    return filePath;
  }

  private async persistThread(threadId: string): Promise<void> {
    const prev = this.threadQueues.get(threadId) ?? Promise.resolve();
    const task = prev.then(async () => {
      await mkdir(this.storageDir, { recursive: true });
      const filePath = this.getThreadFilePath(threadId);
      const tmpPath = `${filePath}.${randomUUID()}.tmp`;

      // Extract writes belonging to this threadId
      const threadWrites: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(this.writes)) {
        if (k.startsWith(`${threadId}$$$`)) {
          threadWrites[k] = v;
        }
      }

      const payload = {
        threadId,
        storage: this.storage[threadId] ?? {},
        writes: threadWrites,
        updatedAt: new Date().toISOString(),
      };

      const encoded = JSON.stringify(encodeStorageData(payload), null, 2);
      try {
        await writeFile(tmpPath, encoded, 'utf8');

        let renamed = false;
        for (let attempt = 0; attempt < 15; attempt++) {
          try {
            await rename(tmpPath, filePath);
            renamed = true;
            break;
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === 'EPERM' || (err as NodeJS.ErrnoException).code === 'EBUSY') {
              await new Promise(r => setTimeout(r, 10));
              continue;
            }
            throw err;
          }
        }
        if (!renamed) {
          await unlink(filePath).catch(() => undefined);
          await rename(tmpPath, filePath);
        }
      } finally {
        await unlink(tmpPath).catch((err: unknown) => {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        });
      }
    });

    this.threadQueues.set(threadId, task);
    await task;
  }

  private async restoreThread(threadId: string): Promise<void> {
    if (this.restoredThreads.has(threadId)) return;
    const filePath = this.getThreadFilePath(threadId);
    try {
      const data = await readFile(filePath, 'utf8');
      const parsed = decodeStorageData(JSON.parse(data)) as {
        storage?: Record<string, Record<string, unknown>>;
        writes?: Record<string, unknown>;
      };
      if (parsed.storage) {
        this.storage[threadId] = {
          ...(this.storage[threadId] ?? {}),
          ...(parsed.storage as unknown as Record<string, Record<string, [Uint8Array, Uint8Array, string | undefined]>>),
        };
      }
      if (parsed.writes) {
        for (const [k, v] of Object.entries(parsed.writes)) {
          this.writes[k] = v as unknown as Record<string, [string, string, Uint8Array, string]>;
        }
      }
      this.restoredThreads.add(threadId);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      this.restoredThreads.add(threadId);
    }
  }

  private async restoreAllThreads(): Promise<void> {
    try {
      await mkdir(this.storageDir, { recursive: true });
      const entries = await readdir(this.storageDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.tmp')) {
          const rawName = entry.name.slice(0, -5);
          const threadId = decodeURIComponent(rawName);
          await this.restoreThread(threadId);
        }
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  public override async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id;
    if (threadId) {
      await this.restoreThread(threadId);
    }
    const result = await super.put(config, checkpoint, metadata);
    if (threadId) {
      await this.persistThread(threadId);
    }
    return result;
  }

  public override async putWrites(config: RunnableConfig, writes: [string, unknown][], taskId: string, taskPath?: string): Promise<void> {
    const threadId = config.configurable?.thread_id;
    if (threadId) {
      await this.restoreThread(threadId);
    }
    await super.putWrites(config, writes, taskId, taskPath);
    if (threadId) {
      await this.persistThread(threadId);
    }
  }

  public override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id;
    if (threadId) {
      await this.restoreThread(threadId);
    }
    return super.getTuple(config);
  }

  public override async *list(config: RunnableConfig, options?: { before?: RunnableConfig; limit?: number; filter?: Record<string, unknown> }): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id;
    if (threadId) {
      await this.restoreThread(threadId);
    } else {
      await this.restoreAllThreads();
    }
    yield* super.list(config, options);
  }

  public override async deleteThread(threadId: string): Promise<void> {
    await super.deleteThread(threadId);
    this.restoredThreads.delete(threadId);
    const filePath = this.getThreadFilePath(threadId);
    await unlink(filePath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
}
