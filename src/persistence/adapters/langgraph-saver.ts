import { MemorySaver, type Checkpoint, type CheckpointMetadata, type CheckpointTuple } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { lstat, mkdir, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DurableStore, atomicWrite } from '../store.ts';
import { encodeStorageData, decodeStorageData, sanitizeKey, encodeSegment, getThreadLockId, getThreadDir, migrateLegacyThreadFile } from './langgraph-serde.ts';

export interface DurableCheckpointSaverOptions {
  baseDir?: string;
  store?: DurableStore;
}

/**
 * DurableCheckpointSaver integrates LangGraph's BaseCheckpointSaver contract
 * with UC-04 DurableStore storage, persisting LangGraph checkpoints, metadata,
 * and pending writes across process lifecycles and multiple saver instances.
 */
export class DurableCheckpointSaver extends MemorySaver {
  private readonly storageDir: string;
  private readonly storeInstance: DurableStore;
  private restoredThreads = new Set<string>();
  private threadGenerations = new Map<string, number>();
  private threadQueues = new Map<string, Promise<void>>();

  constructor(target?: DurableStore | string | DurableCheckpointSaverOptions) {
    super();
    if (target instanceof DurableStore) {
      this.storeInstance = target;
      this.storageDir = join(target.baseDir, 'langgraph');
    } else if (typeof target === 'string') {
      this.storageDir = resolve(target);
      this.storeInstance = new DurableStore(resolve(target, '..'));
    } else if (target && typeof target === 'object') {
      if (target.store) {
        this.storeInstance = target.store;
        this.storageDir = join(target.store.baseDir, 'langgraph');
      } else if (target.baseDir) {
        this.storageDir = resolve(target.baseDir);
        this.storeInstance = new DurableStore(resolve(target.baseDir, '..'));
      } else {
        this.storageDir = resolve('./.slop-loop/store/langgraph');
        this.storeInstance = new DurableStore('./.slop-loop/store');
      }
    } else {
      this.storageDir = resolve('./.slop-loop/store/langgraph');
      this.storeInstance = new DurableStore('./.slop-loop/store');
    }
  }

  public getStorageDir(): string {
    return this.storageDir;
  }

  public getStore(): DurableStore {
    return this.storeInstance;
  }

  private getThreadDir(threadId: string): string {
    return getThreadDir(this.storageDir, threadId);
  }

  private enqueueThreadOp<T>(threadId: string, op: () => Promise<T>): Promise<T> {
    const prev = this.threadQueues.get(threadId) ?? Promise.resolve();
    const task = prev.catch(() => undefined).then(op);
    this.threadQueues.set(
      threadId,
      task.then(
        () => undefined,
        () => undefined,
      ),
    );
    return task;
  }

  private async bumpGeneration(threadDir: string, threadId: string): Promise<number> {
    const genPath = join(threadDir, 'generation.json');
    let currentOnDisk = 0;
    try {
      const raw = await readFile(genPath, 'utf8');
      const parsed = JSON.parse(raw) as { version?: number };
      if (typeof parsed.version === 'number') {
        currentOnDisk = parsed.version;
      }
    } catch {
      // file might not exist yet
    }
    const nextGen = Math.max(Date.now(), currentOnDisk + 1);
    await atomicWrite(genPath, JSON.stringify({ version: nextGen, updatedAt: new Date().toISOString() }));
    this.threadGenerations.set(threadId, nextGen);
    return nextGen;
  }

  private async persistCheckpointIncrement(threadId: string, checkpointNs: string, checkpointId: string): Promise<void> {
    const threadDir = this.getThreadDir(threadId);
    const checkpointsDir = join(threadDir, 'checkpoints');
    await mkdir(checkpointsDir, { recursive: true, mode: 0o700 });

    const tupleData = this.storage[threadId]?.[checkpointNs]?.[checkpointId];
    if (!tupleData) return;

    const metaPath = join(threadDir, 'meta.json');
    await atomicWrite(metaPath, JSON.stringify({ threadId }, null, 2));

    const cpFileName = `cp_${encodeSegment(checkpointNs)}_${encodeSegment(checkpointId)}.json`;
    const cpFilePath = join(checkpointsDir, cpFileName);
    const payload = {
      threadId,
      checkpointNs,
      checkpointId,
      parentCheckpointId: tupleData[2] ?? undefined,
      tuple: tupleData,
      updatedAt: new Date().toISOString(),
    };
    await atomicWrite(cpFilePath, JSON.stringify(encodeStorageData(payload), null, 2));
    await this.bumpGeneration(threadDir, threadId);
  }

  private async persistWritesIncrement(threadId: string, checkpointNs: string, checkpointId: string, taskId: string): Promise<void> {
    const threadDir = this.getThreadDir(threadId);
    const writesDir = join(threadDir, 'writes');
    await mkdir(writesDir, { recursive: true, mode: 0o700 });

    const checkpointKey = JSON.stringify([threadId, checkpointNs, checkpointId]);
    const currentInner = (this.writes[checkpointKey] ?? {}) as Record<string, unknown>;

    const taskWrites: Record<string, unknown> = {};
    for (const [innerKey, val] of Object.entries(currentInner)) {
      if (innerKey.startsWith(`${taskId},`) || (Array.isArray(val) && val[0] === taskId)) {
        taskWrites[innerKey] = val;
      }
    }

    const metaPath = join(threadDir, 'meta.json');
    await atomicWrite(metaPath, JSON.stringify({ threadId }, null, 2));

    const timestamp = Date.now();
    const writeFileName = `wr_${encodeSegment(checkpointNs)}_${encodeSegment(checkpointId)}_${encodeSegment(taskId)}.json`;
    const writeFilePath = join(writesDir, writeFileName);
    const payload = {
      threadId,
      checkpointNs,
      checkpointId,
      taskId,
      checkpointKey,
      taskWrites,
      timestamp,
      updatedAt: new Date(timestamp).toISOString(),
    };
    await atomicWrite(writeFilePath, JSON.stringify(encodeStorageData(payload), null, 2));
    await this.bumpGeneration(threadDir, threadId);
  }

  private async reloadThreadFromDisk(threadId: string): Promise<void> {
    const legacyPath = resolve(this.storageDir, `${sanitizeKey(threadId)}.json`);
    const migrated = await migrateLegacyThreadFile(this.storageDir, threadId, legacyPath);
    const threadDir = this.getThreadDir(threadId);
    if (migrated) {
      await this.bumpGeneration(threadDir, threadId);
    }
    let dirStat: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      dirStat = await lstat(threadDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.restoredThreads.delete(threadId);
        this.threadGenerations.delete(threadId);
        Reflect.deleteProperty(this.storage, threadId);
        const memorySaverPrefix = `[${JSON.stringify(threadId)},`;
        for (const k of Object.keys(this.writes)) {
          if (k.startsWith(`${threadId}$$$`) || k.startsWith(memorySaverPrefix)) {
            Reflect.deleteProperty(this.writes, k);
          }
        }
        return;
      }
      throw err;
    }

    if (!dirStat.isDirectory()) {
      this.restoredThreads.delete(threadId);
      this.threadGenerations.delete(threadId);
      return;
    }

    const genPath = join(threadDir, 'generation.json');
    let diskGen: number | null = null;
    try {
      const raw = await readFile(genPath, 'utf8');
      const parsed = JSON.parse(raw) as { version?: number };
      if (typeof parsed.version === 'number') {
        diskGen = parsed.version;
      }
    } catch {
      // generation file may not exist yet
    }

    if (diskGen !== null && this.restoredThreads.has(threadId) && this.threadGenerations.get(threadId) === diskGen) {
      return;
    }

    // Clear cached data for this thread before loading fresh snapshot
    Reflect.deleteProperty(this.storage, threadId);
    const memorySaverPrefix = `[${JSON.stringify(threadId)},`;
    for (const k of Object.keys(this.writes)) {
      if (k.startsWith(`${threadId}$$$`) || k.startsWith(memorySaverPrefix)) {
        Reflect.deleteProperty(this.writes, k);
      }
    }

    const checkpointsDir = join(threadDir, 'checkpoints');
    const writesDir = join(threadDir, 'writes');

    let cpFiles: string[] = [];
    try {
      cpFiles = await readdir(checkpointsDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    for (const file of cpFiles) {
      if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
      const content = await readFile(join(checkpointsDir, file), 'utf8');
      try {
        const parsed = decodeStorageData(JSON.parse(content)) as {
          checkpointNs?: string;
          checkpointId?: string;
          parentCheckpointId?: string;
          tuple?: [Uint8Array, Uint8Array, string | undefined];
        };
        if (parsed.checkpointNs !== undefined && parsed.checkpointId && parsed.tuple) {
          // Normalize root/empty parent to undefined (JSON deserializes undefined to null)
          if (parsed.parentCheckpointId !== undefined) {
            parsed.tuple[2] = parsed.parentCheckpointId;
          } else if (parsed.tuple[2] === null) {
            parsed.tuple[2] = undefined;
          }
          const threadStorage = (this.storage[threadId] ??= {});
          const nsStorage = (threadStorage[parsed.checkpointNs] ??= {});
          nsStorage[parsed.checkpointId] = parsed.tuple;
        }
      } catch {
        // ignore malformed checkpoint entry
      }
    }

    let writeFiles: string[] = [];
    try {
      writeFiles = await readdir(writesDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    interface LoadedWriteFile {
      checkpointKey?: string | undefined;
      taskWrites?: Record<string, unknown> | undefined;
      writes?: Record<string, unknown> | undefined;
      timestamp: number;
    }
    const loadedWrites: LoadedWriteFile[] = [];

    for (const file of writeFiles) {
      if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
      const content = await readFile(join(writesDir, file), 'utf8');
      try {
        const parsed = decodeStorageData(JSON.parse(content)) as {
          checkpointKey?: string;
          taskWrites?: Record<string, unknown>;
          writes?: Record<string, unknown>;
          timestamp?: number;
          updatedAt?: string;
        };
        const fileTimestamp = parsed.timestamp ?? (parsed.updatedAt ? new Date(parsed.updatedAt).getTime() : 0);
        loadedWrites.push({
          checkpointKey: parsed.checkpointKey,
          taskWrites: parsed.taskWrites,
          writes: parsed.writes,
          timestamp: fileTimestamp,
        });
      } catch {
        // ignore malformed write file
      }
    }

    // Apply writes in chronological order to preserve latest values
    loadedWrites.sort((a, b) => a.timestamp - b.timestamp);
    for (const item of loadedWrites) {
      if (item.checkpointKey && item.taskWrites) {
        const inner = ((this.writes[item.checkpointKey] as Record<string, unknown>) ??= {});
        for (const [k, v] of Object.entries(item.taskWrites)) {
          inner[k] = v;
        }
      } else if (item.writes) {
        for (const [k, v] of Object.entries(item.writes)) {
          this.writes[k] = v as unknown as Record<string, [string, string, Uint8Array, string]>;
        }
      }
    }

    this.restoredThreads.add(threadId);
    if (diskGen !== null) {
      this.threadGenerations.set(threadId, diskGen);
    } else {
      this.threadGenerations.delete(threadId);
    }
  }

  private async restoreAllThreads(): Promise<void> {
    try {
      await mkdir(this.storageDir, { recursive: true });
      const entries = await readdir(this.storageDir, { withFileTypes: true });
      const diskThreadIds = new Set<string>();
      const safeDecode = (s: string): string | undefined => {
        try {
          return decodeURIComponent(s);
        } catch {
          return undefined;
        }
      };

      for (const entry of entries) {
        let threadId: string | undefined;
        if (entry.isDirectory()) {
          const metaPath = join(this.storageDir, entry.name, 'meta.json');
          try {
            const rawMeta = await readFile(metaPath, 'utf8');
            const parsed = JSON.parse(rawMeta) as { threadId?: string };
            if (typeof parsed.threadId === 'string') {
              threadId = parsed.threadId;
            }
          } catch {
            if (!entry.name.startsWith('th_')) {
              threadId = safeDecode(entry.name);
            }
          }
        } else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.tmp')) {
          threadId = safeDecode(entry.name.slice(0, -5));
        }
        if (threadId) {
          diskThreadIds.add(threadId);
          await this.storeInstance.withLockRetry(getThreadLockId(threadId), async () => {
            await this.reloadThreadFromDisk(threadId);
          });
        }
      }

      // Remove cached threads whose disk representation was deleted
      for (const cachedThreadId of Object.keys(this.storage)) {
        if (!diskThreadIds.has(cachedThreadId)) {
          Reflect.deleteProperty(this.storage, cachedThreadId);
          const memorySaverPrefix = `[${JSON.stringify(cachedThreadId)},`;
          for (const k of Object.keys(this.writes)) {
            if (k.startsWith(`${cachedThreadId}$$$`) || k.startsWith(memorySaverPrefix)) {
              Reflect.deleteProperty(this.writes, k);
            }
          }
          this.restoredThreads.delete(cachedThreadId);
          this.threadGenerations.delete(cachedThreadId);
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
    if (!threadId) {
      return super.put(config, checkpoint, metadata);
    }
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    return this.enqueueThreadOp(threadId, async () => {
      return this.storeInstance.withLockRetry(getThreadLockId(threadId), async () => {
        await this.reloadThreadFromDisk(threadId);
        try {
          const result = await super.put(config, checkpoint, metadata);
          await this.persistCheckpointIncrement(threadId, checkpointNs, checkpoint.id);
          return result;
        } catch (err) {
          this.restoredThreads.delete(threadId);
          this.threadGenerations.delete(threadId);
          throw err;
        }
      });
    });
  }

  public override async putWrites(config: RunnableConfig, writes: [string, unknown][], taskId: string, taskPath?: string): Promise<void> {
    const threadId = config.configurable?.thread_id;
    if (!threadId) {
      return super.putWrites(config, writes, taskId, taskPath);
    }
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    const checkpointId = config.configurable?.checkpoint_id ?? '';
    return this.enqueueThreadOp(threadId, async () => {
      return this.storeInstance.withLockRetry(getThreadLockId(threadId), async () => {
        await this.reloadThreadFromDisk(threadId);
        try {
          await super.putWrites(config, writes, taskId, taskPath);
          await this.persistWritesIncrement(threadId, checkpointNs, checkpointId, taskId);
        } catch (err) {
          this.restoredThreads.delete(threadId);
          this.threadGenerations.delete(threadId);
          throw err;
        }
      });
    });
  }

  public override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id;
    if (!threadId) {
      return super.getTuple(config);
    }
    return this.enqueueThreadOp(threadId, async () => {
      return this.storeInstance.withLockRetry(getThreadLockId(threadId), async () => {
        await this.reloadThreadFromDisk(threadId);
        return super.getTuple(config);
      });
    });
  }

  public override async *list(config: RunnableConfig, options?: { before?: RunnableConfig; limit?: number; filter?: Record<string, unknown> }): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id;
    if (threadId) {
      await this.storeInstance.withLockRetry(getThreadLockId(threadId), async () => {
        await this.reloadThreadFromDisk(threadId);
      });
    } else {
      await this.restoreAllThreads();
    }
    yield* super.list(config, options);
  }

  public override async deleteThread(threadId: string): Promise<void> {
    return this.enqueueThreadOp(threadId, async () => {
      return this.storeInstance.withLockRetry(getThreadLockId(threadId), async () => {
        await super.deleteThread(threadId);
        this.restoredThreads.delete(threadId);
        this.threadGenerations.delete(threadId);

        const threadDir = this.getThreadDir(threadId);
        await rm(threadDir, { recursive: true, force: true }).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err;
        });

        const legacyName = sanitizeKey(threadId);
        const legacyDir = resolve(this.storageDir, legacyName);
        const isHashedDir = /^th_[0-9a-f]{32}$/i.test(legacyName);
        if (legacyDir !== threadDir && !isHashedDir) {
          try {
            const meta = await readFile(join(legacyDir, 'meta.json'), 'utf8')
              .then(r => JSON.parse(r) as { threadId?: string })
              .catch(() => null);
            if (meta?.threadId === undefined || meta.threadId === threadId) {
              await rm(legacyDir, { recursive: true, force: true }).catch((err: NodeJS.ErrnoException) => {
                if (err.code !== 'ENOENT' && err.code !== 'ENAMETOOLONG') throw err;
              });
            }
          } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENAMETOOLONG') throw err;
          }
        }

        const legacyPath = resolve(this.storageDir, `${sanitizeKey(threadId)}.json`);
        await unlink(legacyPath).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT' && err.code !== 'ENAMETOOLONG') throw err;
        });
      });
    });
  }
}
