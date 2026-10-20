import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from './durable-store.ts';

interface StoredCheckpointFile {
  readonly checkpoint: Checkpoint;
  readonly metadata: CheckpointMetadata;
  readonly parentCheckpointId?: string | undefined;
}

export class DurableFileCheckpointer extends BaseCheckpointSaver {
  readonly baseDir: string;
  private storage = new Map<string, Map<string, Map<string, [Checkpoint, CheckpointMetadata, string | undefined]>>>();
  private writes = new Map<string, [string, unknown, string | undefined]>();

  constructor(baseDir: string, serde?: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super(serde as any);
    this.baseDir = baseDir;
  }

  private getThreadDir(threadId: string, checkpointNs = ''): string {
    return join(this.baseDir, 'threads', threadId, checkpointNs || '_default_');
  }

  private getFilePath(threadId: string, checkpointNs: string, checkpointId: string): string {
    return join(this.getThreadDir(threadId, checkpointNs), `${checkpointId}.json`);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string | undefined;
    const checkpointNs = (config.configurable?.checkpoint_ns as string | undefined) ?? '';
    const checkpointId = config.configurable?.checkpoint_id as string | undefined;

    if (!threadId) return undefined;

    // Check memory cache first
    const threadStorage = this.storage.get(threadId);
    const nsStorage = threadStorage ? threadStorage.get(checkpointNs) : undefined;
    if (checkpointId && nsStorage) {
      const saved = nsStorage.get(checkpointId);
      if (saved) {
        const [checkpoint, metadata, parentId] = saved;
        const tuple: CheckpointTuple = {
          config,
          checkpoint,
          metadata,
          ...(parentId
            ? { parentConfig: { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: parentId } } }
            : {}),
        };
        return tuple;
      }
    }

    // Try reading from disk
    const threadDir = this.getThreadDir(threadId, checkpointNs);
    try {
      const files = await readdir(threadDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json')).sort();
      if (jsonFiles.length === 0) return undefined;

      const targetFile = checkpointId ? `${checkpointId}.json` : jsonFiles[jsonFiles.length - 1];
      if (!targetFile || !jsonFiles.includes(targetFile)) return undefined;

      const content = await readFile(join(threadDir, targetFile), 'utf8');
      const parsed: StoredCheckpointFile = JSON.parse(content);

      // Populate memory cache
      if (!this.storage.has(threadId)) {
        this.storage.set(threadId, new Map());
      }
      const threadMap = this.storage.get(threadId);
      if (threadMap && !threadMap.has(checkpointNs)) {
        threadMap.set(checkpointNs, new Map());
      }
      const nsMap = threadMap ? threadMap.get(checkpointNs) : undefined;
      if (nsMap) {
        nsMap.set(parsed.checkpoint.id, [parsed.checkpoint, parsed.metadata, parsed.parentCheckpointId]);
      }

      const tuple: CheckpointTuple = {
        config: {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: checkpointNs,
            checkpoint_id: parsed.checkpoint.id,
          },
        },
        checkpoint: parsed.checkpoint,
        metadata: parsed.metadata,
        ...(parsed.parentCheckpointId
          ? {
              parentConfig: {
                configurable: {
                  thread_id: threadId,
                  checkpoint_ns: checkpointNs,
                  checkpoint_id: parsed.parentCheckpointId,
                },
              },
            }
          : {}),
      };
      return tuple;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async *list(config: RunnableConfig, _options?: unknown): AsyncGenerator<CheckpointTuple> {
    void _options;
    const threadId = config.configurable?.thread_id as string | undefined;
    const checkpointNs = (config.configurable?.checkpoint_ns as string | undefined) ?? '';
    if (!threadId) return;

    const threadDir = this.getThreadDir(threadId, checkpointNs);
    try {
      const files = await readdir(threadDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json')).sort().reverse();
      for (const file of jsonFiles) {
        const id = file.replace('.json', '');
        const tuple = await this.getTuple({
          configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: id },
        });
        if (tuple) yield tuple;
      }
    } catch {
      return;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: Record<string, number | string>
  ): Promise<RunnableConfig> {
    void _newVersions;
    const threadId = config.configurable?.thread_id as string | undefined;
    const checkpointNs = (config.configurable?.checkpoint_ns as string | undefined) ?? '';
    const parentCheckpointId = config.configurable?.checkpoint_id as string | undefined;

    if (!threadId) throw new Error('RunnableConfig is missing thread_id');

    if (!this.storage.has(threadId)) {
      this.storage.set(threadId, new Map());
    }
    const threadMap = this.storage.get(threadId);
    if (threadMap && !threadMap.has(checkpointNs)) {
      threadMap.set(checkpointNs, new Map());
    }
    const nsMap = threadMap ? threadMap.get(checkpointNs) : undefined;
    if (nsMap) {
      nsMap.set(checkpoint.id, [checkpoint, metadata, parentCheckpointId]);
    }

    // Flush to disk atomically
    const threadDir = this.getThreadDir(threadId, checkpointNs);
    await mkdir(threadDir, { recursive: true });

    const storedFile: StoredCheckpointFile = {
      checkpoint,
      metadata,
      parentCheckpointId,
    };

    const filePath = this.getFilePath(threadId, checkpointNs, checkpoint.id);
    await atomicWrite(filePath, JSON.stringify(storedFile, null, 2));

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: [string, unknown][],
    taskId: string,
    taskPath?: string
  ): Promise<void> {
    const threadId = config.configurable?.thread_id as string | undefined;
    const checkpointNs = (config.configurable?.checkpoint_ns as string | undefined) ?? '';
    const checkpointId = config.configurable?.checkpoint_id as string | undefined;

    if (!threadId || !checkpointId) return;

    for (let idx = 0; idx < writes.length; idx++) {
      const write = writes[idx];
      if (!write) continue;
      const [channel, value] = write;
      const key = `${threadId}:${checkpointNs}:${checkpointId}:${taskId}:${idx}`;
      this.writes.set(key, [channel, value, taskPath]);
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    this.storage.delete(threadId);
    const prefix = `${threadId}:`;
    for (const key of Array.from(this.writes.keys())) {
      if (key.startsWith(prefix)) {
        this.writes.delete(key);
      }
    }
    const threadDir = join(this.baseDir, 'threads', threadId);
    await rm(threadDir, { recursive: true, force: true });
  }
}
