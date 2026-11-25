import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

const SAFE_STORAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface LockWaiter {
  notify: (() => void) | null;
  pendingWake: boolean;
}

interface InProcessLockState {
  held: boolean;
  releaseCount: number;
  readonly waiters: LockWaiter[];
}

// Per-process FIFO coordination avoids N-way polling storms and timer-race starvation
// while keeping the on-disk O_EXCL lock file as the cross-process mutual-exclusion authority.
const inProcessLocks = new Map<string, InProcessLockState>();

async function resolveLockKey(lockDir: string, resourceId: string): Promise<string> {
  const realLockDir = await realpath(lockDir);
  const canonicalPath = join(realLockDir, `${resourceId}.lock`);
  return process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
}

function getOrCreateLockState(lockKey: string): InProcessLockState {
  let state = inProcessLocks.get(lockKey);
  if (!state) {
    state = { held: false, releaseCount: 0, waiters: [] };
    inProcessLocks.set(lockKey, state);
  }
  return state;
}

function cleanupLockState(lockKey: string, state: InProcessLockState): void {
  if (!state.held && state.waiters.length === 0 && inProcessLocks.get(lockKey) === state) {
    inProcessLocks.delete(lockKey);
  }
}

function wakeHeadWaiter(state: InProcessLockState): void {
  const head = state.waiters[0];
  if (!head) return;
  if (head.notify) {
    const notify = head.notify;
    head.notify = null;
    notify();
  } else {
    head.pendingWake = true;
  }
}

function releaseInProcessLock(lockKey: string, state: InProcessLockState): void {
  state.held = false;
  state.releaseCount += 1;
  if (state.waiters.length > 0) {
    wakeHeadWaiter(state);
  } else {
    cleanupLockState(lockKey, state);
  }
}

function waitForTurnOrDelay(waiter: LockWaiter, delayMs: number): Promise<void> {
  if (waiter.pendingWake) {
    waiter.pendingWake = false;
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const finish = (): void => {
      clearTimeout(timer);
      waiter.notify = null;
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    waiter.notify = finish;
  });
}

export function isSafeStorageId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_STORAGE_ID.test(id) && !id.includes('..');
}

export function requireSafeId(id: unknown, label: string): string {
  if (!isSafeStorageId(id)) throw new Error(`Unsafe ${label}: ${String(id)}`);
  return id;
}

export function getJournalLockId(taskId: string): string {
  requireSafeId(taskId, 'task id');
  if (taskId.length <= 120) {
    return `jnl-${taskId}`;
  }
  const hash = createHash('sha256').update(taskId).digest('hex');
  return `jnl-${taskId.slice(0, 56)}-${hash}`;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

export interface LockRetryOptions {
  retries?: number;
  delayMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  staleThresholdMs?: number;
}

async function tryCleanStaleLock(lockPath: string, expectedToken?: string, expectedMtimeMs?: number, reapStaleMs = 5_000): Promise<boolean> {
  const reapPath = `${lockPath}.reap`;
  let reapHandle: FileHandle | null = null;
  try {
    reapHandle = await open(reapPath, 'wx', 0o600);
  } catch {
    const reapStat = await lstat(reapPath).catch(() => null);
    if (!reapStat || Date.now() - reapStat.mtimeMs <= reapStaleMs) return false;
    await unlink(reapPath).catch(() => undefined);
    try {
      reapHandle = await open(reapPath, 'wx', 0o600);
    } catch {
      return false;
    }
  }

  try {
    const content = await readFile(lockPath, 'utf8').catch(() => null);
    if (!content) {
      return true;
    }

    let isTargetStaleLock = false;
    if (expectedToken !== undefined) {
      try {
        const parsed = JSON.parse(content) as { token?: string };
        if (parsed.token === expectedToken) {
          isTargetStaleLock = true;
        }
      } catch {
        // not valid JSON
      }
    } else if (expectedMtimeMs !== undefined) {
      const lockStat = await lstat(lockPath).catch(() => null);
      if (lockStat && Math.abs(lockStat.mtimeMs - expectedMtimeMs) <= 1000) {
        isTargetStaleLock = true;
      }
    }

    if (isTargetStaleLock) {
      await unlink(lockPath).catch(() => undefined);
      return true;
    }
    return false;
  } finally {
    if (reapHandle) {
      await reapHandle.close().catch(() => undefined);
      await unlink(reapPath).catch(() => undefined);
    }
  }
}

export async function executeWithLock<T>(lockDir: string, resourceId: string, operation: () => Promise<T>, requireContainedParent?: (path: string) => Promise<void>): Promise<T> {
  requireSafeId(resourceId, 'lock resource id');
  await mkdir(lockDir, { recursive: true });
  const lockPath = join(lockDir, `${resourceId}.lock`);
  if (requireContainedParent) {
    await requireContainedParent(lockPath);
  }
  const lockKey = await resolveLockKey(lockDir, resourceId);
  if (inProcessLocks.get(lockKey)?.held) {
    throw new Error(`Resource ${resourceId} is busy / already locked.`);
  }
  const handle = await open(lockPath, 'wx', 0o600).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Resource ${resourceId} is busy / already locked.`);
    }
    throw err;
  });
  const lockState = getOrCreateLockState(lockKey);
  lockState.held = true;

  const lockToken = randomUUID();
  const lockPayload = JSON.stringify({
    pid: process.pid,
    token: lockToken,
    createdAt: Date.now(),
  });
  try {
    await handle.writeFile(lockPayload, 'utf8');
    await handle.sync();
  } catch {
    // ignore sync errors on handle initialization
  }

  let fileStat: { ino?: number; dev?: number } | null = null;
  try {
    fileStat = await handle.stat();
    return await operation();
  } finally {
    try {
      await handle.close();
      const currentContent = await readFile(lockPath, 'utf8').catch(() => null);
      let shouldUnlink = false;
      if (currentContent) {
        try {
          const parsed = JSON.parse(currentContent) as { token?: string };
          if (parsed.token === lockToken) {
            shouldUnlink = true;
          }
        } catch {
          if (fileStat) {
            const current = await lstat(lockPath).catch(() => null);
            if (current && current.ino === fileStat.ino && current.dev === fileStat.dev) {
              shouldUnlink = true;
            }
          }
        }
      }
      if (shouldUnlink) {
        await unlink(lockPath).catch(() => undefined);
      }
    } finally {
      releaseInProcessLock(lockKey, lockState);
    }
  }
}

export async function executeWithLockRetry<T>(
  lockDir: string,
  resourceId: string,
  operation: () => Promise<T>,
  options?: LockRetryOptions,
  requireContainedParent?: (path: string) => Promise<void>,
): Promise<T> {
  requireSafeId(resourceId, 'lock resource id');
  await mkdir(lockDir, { recursive: true });
  const lockPath = join(lockDir, `${resourceId}.lock`);
  if (requireContainedParent) {
    await requireContainedParent(lockPath);
  }
  const retries = options?.retries ?? options?.maxRetries ?? 50;
  const delayMs = options?.delayMs ?? options?.retryDelayMs ?? 20;
  const staleThresholdMs = options?.staleThresholdMs ?? 30_000;

  const lockKey = await resolveLockKey(lockDir, resourceId);
  const lockState = getOrCreateLockState(lockKey);
  const waiter: LockWaiter = { notify: null, pendingWake: false };
  lockState.waiters.push(waiter);

  let handle: FileHandle | null = null;
  let acquired = false;
  let lastReleaseCount = lockState.releaseCount;
  let attempt = 0;
  try {
    while (true) {
      if (lockState.releaseCount !== lastReleaseCount) {
        lastReleaseCount = lockState.releaseCount;
        attempt = 0;
      }
      waiter.pendingWake = false;
      const isHead = lockState.waiters[0] === waiter;
      if (isHead && !lockState.held) {
        try {
          handle = await open(lockPath, 'wx', 0o600);
          lockState.held = true;
          acquired = true;
          const idx = lockState.waiters.indexOf(waiter);
          if (idx !== -1) lockState.waiters.splice(idx, 1);
          break;
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'EEXIST' || code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
            const lockStat = await lstat(lockPath).catch(() => null);
            if (lockStat) {
              let isStale = false;
              let staleToken: string | undefined;
              const content = await readFile(lockPath, 'utf8').catch(() => null);
              if (content) {
                try {
                  const parsed = JSON.parse(content) as { pid?: number; token?: string; createdAt?: number };
                  staleToken = parsed.token;
                  if (typeof parsed.pid === 'number') {
                    if (!isProcessAlive(parsed.pid)) {
                      isStale = true;
                    }
                  } else if (parsed.createdAt && Date.now() - parsed.createdAt > staleThresholdMs) {
                    isStale = true;
                  }
                } catch {
                  if (Date.now() - lockStat.mtimeMs > staleThresholdMs) {
                    isStale = true;
                  }
                }
              } else if (Date.now() - lockStat.mtimeMs > staleThresholdMs) {
                isStale = true;
              }

              if (isStale) {
                await tryCleanStaleLock(lockPath, staleToken, lockStat.mtimeMs);
              }
            }
          } else {
            throw err;
          }
        }
      }

      if (attempt >= retries) {
        throw new Error(`Resource ${resourceId} is busy / already locked after ${retries} attempts.`);
      }
      attempt += 1;
      await waitForTurnOrDelay(waiter, delayMs);
    }
  } finally {
    if (!acquired) {
      const idx = lockState.waiters.indexOf(waiter);
      if (idx !== -1) lockState.waiters.splice(idx, 1);
      if (!lockState.held) {
        if (lockState.waiters.length > 0) {
          wakeHeadWaiter(lockState);
        } else {
          cleanupLockState(lockKey, lockState);
        }
      }
    }
  }

  if (!handle) {
    throw new Error(`Resource ${resourceId} is busy / already locked.`);
  }

  const lockToken = randomUUID();
  const lockPayload = JSON.stringify({
    pid: process.pid,
    token: lockToken,
    createdAt: Date.now(),
  });
  try {
    await handle.writeFile(lockPayload, 'utf8');
    await handle.sync();
  } catch {
    // ignore sync errors on handle initialization
  }

  let fileStat: { ino?: number; dev?: number } | null = null;
  try {
    fileStat = await handle.stat();
    return await operation();
  } finally {
    try {
      await handle.close();
      const currentContent = await readFile(lockPath, 'utf8').catch(() => null);
      let shouldUnlink = false;
      if (currentContent) {
        try {
          const parsed = JSON.parse(currentContent) as { token?: string };
          if (parsed.token === lockToken) {
            shouldUnlink = true;
          }
        } catch {
          if (fileStat) {
            const current = await lstat(lockPath).catch(() => null);
            if (current && current.ino === fileStat.ino && current.dev === fileStat.dev) {
              shouldUnlink = true;
            }
          }
        }
      }
      if (shouldUnlink) {
        await unlink(lockPath).catch(() => undefined);
      }
    } finally {
      releaseInProcessLock(lockKey, lockState);
    }
  }
}
