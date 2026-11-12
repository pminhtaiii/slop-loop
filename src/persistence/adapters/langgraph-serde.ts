import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicWrite } from '../store.ts';

export function encodeStorageData(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __b64__: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) {
    return value.map(encodeStorageData);
  }
  if (value !== null && typeof value === 'object') {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value)) {
      Object.defineProperty(out, k, {
        value: encodeStorageData(v),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

export function decodeStorageData(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    if ('__b64__' in (value as Record<string, unknown>) && typeof (value as Record<string, unknown>).__b64__ === 'string') {
      return new Uint8Array(Buffer.from((value as { __b64__: string }).__b64__, 'base64'));
    }
    if (Array.isArray(value)) {
      return value.map(decodeStorageData);
    }
    const out = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value)) {
      Object.defineProperty(out, k, {
        value: decodeStorageData(v),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

export function sanitizeKey(key: string): string {
  return encodeURIComponent(key).replace(/\./g, '%2E').replace(/[*]/g, '%2A');
}

export function encodeSegment(str: string): string {
  return createHash('sha256').update(str, 'utf8').digest('hex').slice(0, 32);
}

export function getThreadLockId(threadId: string): string {
  const hash = createHash('sha256').update(threadId).digest('hex');
  return `lg-thread-${hash.slice(0, 32)}`;
}

export function getThreadDir(storageDir: string, threadId: string): string {
  const hash = createHash('sha256').update(threadId, 'utf8').digest('hex').slice(0, 32);
  return resolve(storageDir, `th_${hash}`);
}

async function mergeLegacyDir(legacyDir: string, threadDir: string): Promise<void> {
  for (const sub of ['checkpoints', 'writes'] as const) {
    const srcSub = join(legacyDir, sub);
    const destSub = join(threadDir, sub);
    let files: string[] = [];
    try {
      files = await readdir(srcSub);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw err;
    }
    await mkdir(destSub, { recursive: true, mode: 0o700 });
    for (const file of files) {
      const srcFile = join(srcSub, file);
      const destFile = join(destSub, file);
      const exists = await lstat(destFile).catch(() => null);
      if (!exists) {
        await rename(srcFile, destFile);
      }
    }
  }
  await rm(legacyDir, { recursive: true, force: true });
}

export async function migrateLegacyThreadFile(storageDir: string, threadId: string, legacyPath: string): Promise<boolean> {
  const threadDir = getThreadDir(storageDir, threadId);
  const legacyName = sanitizeKey(threadId);
  const legacyDir = resolve(storageDir, legacyName);
  const isHashedDir = /^th_[0-9a-f]{32}$/i.test(legacyName);
  if (legacyDir !== threadDir && !isHashedDir) {
    try {
      const legStat = await lstat(legacyDir);
      if (legStat.isDirectory()) {
        const meta = await readFile(join(legacyDir, 'meta.json'), 'utf8')
          .then(r => JSON.parse(r) as { threadId?: string })
          .catch(() => null);
        if (meta?.threadId === undefined || meta.threadId === threadId) {
          const thStat = await lstat(threadDir).catch(() => null);
          if (!thStat) {
            await rename(legacyDir, threadDir);
          } else {
            await mergeLegacyDir(legacyDir, threadDir);
          }
        }
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENAMETOOLONG') {
        throw err;
      }
    }
  }

  let legacyData: string | null = null;
  try {
    legacyData = await readFile(legacyPath, 'utf8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENAMETOOLONG') return false;
    throw err;
  }

  const parsed = decodeStorageData(JSON.parse(legacyData)) as {
    storage?: Record<string, Record<string, [Uint8Array, Uint8Array, string | undefined]>>;
    writes?: Record<string, unknown>;
  };

  const checkpointsDir = join(threadDir, 'checkpoints');
  await mkdir(checkpointsDir, { recursive: true, mode: 0o700 });

  if (parsed.storage) {
    for (const [ns, cps] of Object.entries(parsed.storage)) {
      for (const [cpId, tuple] of Object.entries(cps)) {
        const cpFileName = `cp_${encodeSegment(ns)}_${encodeSegment(cpId)}.json`;
        const cpFilePath = join(checkpointsDir, cpFileName);
        const exists = await lstat(cpFilePath).catch(() => null);
        if (!exists) {
          const payload = {
            threadId,
            checkpointNs: ns,
            checkpointId: cpId,
            tuple,
            updatedAt: new Date().toISOString(),
          };
          await atomicWrite(cpFilePath, JSON.stringify(encodeStorageData(payload), null, 2));
        }
      }
    }
  }

  if (parsed.writes) {
    const writesDir = join(threadDir, 'writes');
    await mkdir(writesDir, { recursive: true, mode: 0o700 });
    const writeFilePath = join(writesDir, 'wr_legacy.json');
    const exists = await lstat(writeFilePath).catch(() => null);
    if (!exists) {
      await atomicWrite(writeFilePath, JSON.stringify(encodeStorageData({ writes: parsed.writes }), null, 2));
    }
  }

  const metaPath = join(threadDir, 'meta.json');
  await atomicWrite(metaPath, JSON.stringify({ threadId }, null, 2));

  await unlink(legacyPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });

  return true;
}
