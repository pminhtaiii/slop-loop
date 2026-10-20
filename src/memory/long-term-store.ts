import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../state/durable-store.ts';

export interface MemoryEntry {
  readonly key: string;
  readonly value: string;
  readonly updatedAt: string;
  readonly advisoryOnly: true;
}

export interface ResolvedMemoryFact {
  readonly key: string;
  readonly memoryValue?: string | undefined;
  readonly repoFactValue: string;
  readonly effectiveValue: string;
  readonly isOverridden: boolean;
}

export class LongTermMemoryStore {
  readonly memoryDir: string;
  readonly memoryFilePath: string;
  private cache = new Map<string, MemoryEntry>();

  constructor(baseDir: string) {
    this.memoryDir = join(baseDir, 'memory');
    this.memoryFilePath = join(this.memoryDir, 'repo-memory.json');
  }

  private async load(): Promise<void> {
    try {
      const data = await readFile(this.memoryFilePath, 'utf8');
      const parsed: Record<string, MemoryEntry> = JSON.parse(data);
      this.cache.clear();
      for (const [k, v] of Object.entries(parsed)) {
        this.cache.set(k, v);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache.clear();
        return;
      }
      throw err;
    }
  }

  private async persist(): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true });
    const obj: Record<string, MemoryEntry> = {};
    for (const [k, v] of this.cache.entries()) {
      obj[k] = v;
    }
    await atomicWrite(this.memoryFilePath, JSON.stringify(obj, null, 2));
  }

  async get(key: string): Promise<string | null> {
    await this.load();
    return this.cache.get(key)?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.load();
    this.cache.set(key, {
      key,
      value,
      updatedAt: new Date().toISOString(),
      advisoryOnly: true,
    });
    await this.persist();
  }

  async delete(key: string): Promise<void> {
    await this.load();
    if (this.cache.delete(key)) {
      await this.persist();
    }
  }

  async list(): Promise<MemoryEntry[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  resolveWithFact(key: string, repoFactValue: string): ResolvedMemoryFact {
    const memoryValue = this.cache.get(key)?.value;
    const isOverridden = memoryValue !== undefined && memoryValue !== repoFactValue;
    return {
      key,
      memoryValue,
      repoFactValue,
      effectiveValue: repoFactValue, // Code facts always win!
      isOverridden,
    };
  }

  async clear(): Promise<void> {
    this.cache.clear();
    await rm(this.memoryFilePath, { force: true });
  }
}
