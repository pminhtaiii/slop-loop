/**
 * T041 — the durable UC-04 baseline evidence store (real-tier contract §(b)2–3).
 *
 * Owns the bytes behind `createBaselineEvidenceAdapter`: one JSON record per
 * (taskId, workspaceId, repositoryId) binding under `<baseDir>/baseline-evidence/`, written as a
 * pending file plus an atomic rename. Nothing is cached, so every outcome comes from the files on
 * disk and a fresh instance reads the same answer. `lookupWrite` resolves an uncertain write by
 * prefix (`uc04-baseline:`) without rewriting anything; an unknown prefix is `unknown`.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalJsonStringify, computeCanonicalSha256 } from '../../contracts/foundation/uc03.ts';
import type { BaselineEvidenceCandidate } from '../../uc03/investigation-types.ts';
import type { DurableStore } from '../store.ts';

/** Owner prefix of a baseline-write operation ref (`real-tier.md` §(b)2). */
export const BASELINE_OPERATION_PREFIX = 'uc04-baseline:';

const ROOT = 'baseline-evidence';
const RECORD_FILE = 'record.json';
const PENDING_FILE = 'record.pending';
const SCHEMA_VERSION = 1;
const OPERATION_HASH = /^[0-9a-f]{64}$/;

export interface BaselineRecordPaths {
  readonly recordPath: string;
  readonly pendingPath: string;
}

/** Owner outcome for one write. Only `durable` may become an acknowledgement. */
export type BaselineWriteOutcome =
  | { readonly outcome: 'durable'; readonly acknowledgement: BaselineStoredAcknowledgement }
  | { readonly outcome: 'uncertain'; readonly operationRef: string }
  | { readonly outcome: 'denied'; readonly reason: string };

export interface BaselineLookup {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly evidenceId: string;
}

export type BaselineLoadOutcome =
  | { readonly outcome: 'found'; readonly content: BaselineEvidenceCandidate; readonly acknowledgement: BaselineStoredAcknowledgement }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'uncertain'; readonly reason: string };

/** Result of resolving an uncertain write; lookups never write or re-execute. */
export type BaselineWriteLookupResult = { readonly outcome: 'committed'; readonly acknowledgement: BaselineStoredAcknowledgement } | { readonly outcome: 'absent' } | { readonly outcome: 'unknown' };

export interface BaselineStoredAcknowledgement {
  readonly evidenceId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly contentDigest: string;
  readonly repositorySnapshotDigest: string;
  readonly criteriaDigest: string;
  readonly checkSetDigest: string;
  readonly testProtectionDigest: string;
  readonly reproductionCheckId: string;
  readonly expectedPassingCheckIds: readonly string[];
  readonly expectedTestFiles: readonly string[];
  readonly requiredCheckIds: readonly string[];
}

export interface BaselineEvidenceStore {
  readonly provenance: 'real';
  persist(request: { readonly content: BaselineEvidenceCandidate; readonly contentDigest: string }): Promise<BaselineWriteOutcome>;
  load(request: BaselineLookup): Promise<BaselineLoadOutcome>;
  lookupWrite(operationRef: string): Promise<BaselineWriteLookupResult>;
}

export interface BaselineEvidenceStoreOptions {
  readonly store: DurableStore;
  /** Test seam for the two filesystem outcomes a real run cannot force: a failed and a lost commit. */
  readonly commitRecord?: (paths: BaselineRecordPaths, text: string) => Promise<void>;
}

interface StoredRecord {
  readonly evidenceId: string;
  readonly operationRef: string;
  readonly contentDigest: string;
  readonly content: BaselineEvidenceCandidate;
}

function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonicalJsonStringify(value), 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Identity of one baseline: a task's evidence for a workspace and repository. */
function identityKey(content: { readonly taskId: string; readonly workspaceId: string; readonly repositoryId: string }): string {
  return sha256Hex({ taskId: content.taskId, workspaceId: content.workspaceId, repositoryId: content.repositoryId });
}

/** Derived from the binding, never random: a replay must acknowledge with the same identity. */
function evidenceIdOf(keyHash: string): string {
  return `uc04-baseline://${keyHash}`;
}

function operationRefOf(keyHash: string, contentDigest: string): string {
  return `${BASELINE_OPERATION_PREFIX}${sha256Hex({ evidenceId: evidenceIdOf(keyHash), contentDigest })}`;
}

function pathsOf(baseDir: string, keyHash: string): BaselineRecordPaths {
  const dir = join(baseDir, ROOT, keyHash);
  return { recordPath: join(dir, RECORD_FILE), pendingPath: join(dir, PENDING_FILE) };
}

/** A record read that separates "no such file" from "cannot be read"; only the former may mean absent. */
type RecordRead = { readonly state: 'absent' } | { readonly state: 'unreadable' } | { readonly state: 'text'; readonly text: string };

async function readText(path: string): Promise<RecordRead> {
  try {
    return { state: 'text', text: await readFile(path, 'utf8') };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    // Translated, not rethrown: the contract makes every non-absent read failure `unknown`/`uncertain`.
    return { state: 'unreadable' };
  }
}

/** Pending write plus atomic rename, retrying the Windows rename failures `atomicWrite` retries. */
async function commitRecord({ recordPath, pendingPath }: BaselineRecordPaths, text: string): Promise<void> {
  await mkdir(dirname(recordPath), { recursive: true });
  const handle = await open(pendingPath, 'w', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(pendingPath, recordPath);
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= 14) throw err;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

function parseRecord(text: string): StoredRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value['schemaVersion'] !== SCHEMA_VERSION) return null;
  const { evidenceId, operationRef, contentDigest, content } = value;
  if (typeof evidenceId !== 'string' || typeof operationRef !== 'string' || typeof contentDigest !== 'string' || !isRecord(content)) return null;
  if (typeof content['taskId'] !== 'string' || typeof content['workspaceId'] !== 'string' || typeof content['repositoryId'] !== 'string') return null;
  if (!Array.isArray(content['requiredChecks']) || !content['requiredChecks'].every(check => isRecord(check) && typeof check['checkId'] === 'string')) return null;
  // The remaining candidate fields are revalidated by the consumer adapter before any effect.
  return { evidenceId, operationRef, contentDigest, content: content as unknown as BaselineEvidenceCandidate };
}

function acknowledgementOf(content: BaselineEvidenceCandidate, evidenceId: string): BaselineStoredAcknowledgement {
  return {
    evidenceId,
    taskId: content.taskId,
    workspaceId: content.workspaceId,
    repositoryId: content.repositoryId,
    contentDigest: computeCanonicalSha256(content),
    repositorySnapshotDigest: content.repositorySnapshotDigest,
    criteriaDigest: content.criteriaDigest,
    checkSetDigest: content.checkSetDigest,
    testProtectionDigest: content.testProtectionDigest,
    reproductionCheckId: content.reproductionCheckId,
    expectedPassingCheckIds: [...content.expectedPassingCheckIds],
    expectedTestFiles: [...content.expectedTestFiles],
    requiredCheckIds: content.requiredChecks.map(check => check.checkId),
  };
}

export function createBaselineEvidenceStore(options: BaselineEvidenceStoreOptions): BaselineEvidenceStore {
  const { store } = options;
  const write = options.commitRecord ?? commitRecord;

  return {
    provenance: 'real',

    async persist(request): Promise<BaselineWriteOutcome> {
      // Snapshot before the first await: the caller keeps its nested arrays and could mutate them
      // while a filesystem step is pending, which would store content under the old digest.
      const content = structuredClone(request.content);
      const contentDigest = computeCanonicalSha256(content);
      if (request.contentDigest !== contentDigest) {
        return { outcome: 'denied', reason: 'the content digest does not match the canonical candidate' };
      }
      const keyHash = identityKey(content);
      const operationRef = operationRefOf(keyHash, contentDigest);
      const paths = pathsOf(store.baseDir, keyHash);
      await mkdir(dirname(paths.recordPath), { recursive: true });

      return store.withLock(`uc04-baseline-${keyHash}`, async (): Promise<BaselineWriteOutcome> => {
        const existing = await readText(paths.recordPath);
        if (existing.state === 'unreadable') return { outcome: 'uncertain', operationRef };
        if (existing.state === 'text') {
          const stored = parseRecord(existing.text);
          if (stored === null) return { outcome: 'uncertain', operationRef };
          if (stored.contentDigest !== contentDigest) {
            return { outcome: 'denied', reason: `evidence identity '${stored.evidenceId}' is already bound to different content` };
          }
          if (computeCanonicalSha256(stored.content) !== stored.contentDigest) return { outcome: 'uncertain', operationRef: stored.operationRef };
          return { outcome: 'durable', acknowledgement: acknowledgementOf(stored.content, stored.evidenceId) };
        }

        const text = JSON.stringify({ schemaVersion: SCHEMA_VERSION, evidenceId: evidenceIdOf(keyHash), operationRef, content, contentDigest }, null, 2);
        try {
          await write(paths, text);
        } catch {
          return { outcome: 'uncertain', operationRef };
        }
        return { outcome: 'durable', acknowledgement: acknowledgementOf(content, evidenceIdOf(keyHash)) };
      });
    },

    async load(request): Promise<BaselineLoadOutcome> {
      const paths = pathsOf(store.baseDir, identityKey(request));
      const text = await readText(paths.recordPath);
      if (text.state === 'unreadable') return { outcome: 'uncertain', reason: 'the stored baseline evidence record is unreadable' };
      if (text.state === 'absent') {
        const pending = await readText(paths.pendingPath);
        if (pending.state === 'text') return { outcome: 'uncertain', reason: 'an unsettled baseline evidence write is present' };
        return pending.state === 'unreadable' ? { outcome: 'uncertain', reason: 'an unsettled baseline evidence write may be present' } : { outcome: 'missing' };
      }
      const stored = parseRecord(text.text);
      if (stored === null) return { outcome: 'uncertain', reason: 'the stored baseline evidence record is unreadable' };
      const bound = stored.content;
      if (stored.evidenceId !== request.evidenceId || bound.taskId !== request.taskId || bound.workspaceId !== request.workspaceId || bound.repositoryId !== request.repositoryId) {
        return { outcome: 'missing' };
      }
      if (computeCanonicalSha256(bound) !== stored.contentDigest) return { outcome: 'uncertain', reason: 'the stored baseline evidence record does not match its digest' };
      return { outcome: 'found', content: bound, acknowledgement: acknowledgementOf(bound, stored.evidenceId) };
    },

    async lookupWrite(operationRef): Promise<BaselineWriteLookupResult> {
      const hash = operationRef.startsWith(BASELINE_OPERATION_PREFIX) ? operationRef.slice(BASELINE_OPERATION_PREFIX.length) : '';
      if (!OPERATION_HASH.test(hash)) return { outcome: 'unknown' };

      // shortcut: resolves by scanning records because the ref is a one-way hash; add a ref→key index only if baselines per store grow past a few hundred.
      const root = join(store.baseDir, ROOT);
      const entries = await readdir(root).catch((err: unknown) => ((err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null));
      // An unlistable root may hold a committed record, so it is unknown, not absent.
      if (entries === null) return { outcome: 'unknown' };

      let unreadable = false;
      for (const entry of entries) {
        const paths = pathsOf(store.baseDir, entry);
        const [text, pending] = await Promise.all([readText(paths.recordPath), readText(paths.pendingPath)]);
        // Anything we cannot read may be this write, so its state cannot be more precise than unknown.
        if (text.state === 'unreadable' || pending.state === 'unreadable') return { outcome: 'unknown' };
        // A pending file names its ref, so only this write's own debris, or debris we cannot attribute, is unknown.
        const pendingRef = pending.state === 'absent' ? undefined : parseRecord(pending.text)?.operationRef;
        if (pending.state === 'text' && (pendingRef === undefined || pendingRef === operationRef)) return { outcome: 'unknown' };
        if (text.state === 'absent') continue;
        const stored = parseRecord(text.text);
        if (stored === null) {
          unreadable = true;
          continue;
        }
        if (stored.operationRef !== operationRef) continue;
        if (computeCanonicalSha256(stored.content) !== stored.contentDigest) return { outcome: 'unknown' };
        return { outcome: 'committed', acknowledgement: acknowledgementOf(stored.content, stored.evidenceId) };
      }
      return unreadable ? { outcome: 'unknown' } : { outcome: 'absent' };
    },
  };
}
