import fsPromises from 'node:fs/promises';
import { constants } from 'node:fs';

const sameFile = (left, right) => left.dev !== 0n && left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;

export async function readBoundedEvidence(path, observed, limit) {
  let handle;
  try {
    handle = await fsPromises.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.size > BigInt(limit) || !sameFile(observed, opened)) return undefined;
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFile(opened, after) || after.size !== opened.size || after.size !== BigInt(length) || length > limit) return undefined;
    return bytes.subarray(0, length);
  } finally {
    await handle?.close();
  }
}
