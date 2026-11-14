import { Buffer } from 'node:buffer';
import type { DirectoryEntryV1, DirectoryPageV1 } from '../contracts/questions/contracts.ts';
import type { QuestionRepositoryOperationControl, QuestionRepositoryReadLimits } from './repository-types.ts';
import { validateDirectoryPage } from '../contracts/questions/validation.ts';
import {
  activeControl,
  commitOutputBytes,
  createCursorId,
  failure,
  isFailure,
  remainingOutputBytes,
  type AdmittedSnapshot,
  type CursorState,
  type DirectoryCursor,
  type ReturnedByteCounter,
} from './question-repository-primitives.ts';
import type { QuestionRepositorySnapshotReader } from './question-repository-snapshot.ts';

export interface DirectoryOperationContext {
  readonly limits: QuestionRepositoryReadLimits;
  readonly snapshotReader: QuestionRepositorySnapshotReader;
  readonly cursors: Map<string, CursorState>;
  readonly returnedBytes: ReturnedByteCounter;
}

export async function listDirectoryGuarded(
  context: DirectoryOperationContext,
  request: { readonly path: string; readonly cursor: DirectoryCursor | undefined },
  control: QuestionRepositoryOperationControl,
): Promise<DirectoryPageV1> {
  const before = activeControl(control);
  if (before) return before;
  const bindingFailure = await context.snapshotReader.checkBinding(control);
  if (bindingFailure) return bindingFailure;
  const admitted = await context.snapshotReader.ensureSnapshot(control);
  if (isFailure(admitted)) return admitted;
  const cursor = request.cursor;
  if (cursor && !matchesSnapshot(cursor, admitted)) return failure('invalid', 'invalid-cursor');
  const built = admitted.directoryChildren.get(request.path);
  if (!built) return failure('denied', 'outside-scope');
  const pathCheck = await context.snapshotReader.checkDirectoryPath(request.path, control);
  if (pathCheck) return pathCheck;

  const entries = cursor?.entries ?? built;
  let offset = cursor?.offset ?? 0;

  const page: DirectoryEntryV1[] = [];
  let outputBytes = 0;
  let scanLimited = false;
  while (offset < entries.length && page.length < context.limits.maxPageEntries) {
    const entry = entries[offset];
    if (!entry) break;
    const pathBytes = Buffer.byteLength(entry.path, 'utf8');
    if (control.work && !control.work.charge({ scannedBytes: pathBytes })) {
      scanLimited = true;
      break;
    }
    const size = pathBytes + 24;
    if (outputBytes + size > remainingOutputBytes(context.returnedBytes, context.limits, control)) break;
    page.push(entry);
    outputBytes += size;
    offset += 1;
  }
  if (page.length === 0 && offset < entries.length) return failure('exhausted', scanLimited ? 'scan-limit' : 'output-limit');
  const more = offset < entries.length;
  const after = await context.snapshotReader.checkBinding(control);
  if (after) return after;
  const resumable = more && !scanLimited;
  if (resumable && context.cursors.size >= context.limits.maxCursors) return failure('exhausted', 'output-limit');
  const nextCursor = resumable ? createCursorId() : undefined;
  const result = {
    status: 'ok',
    path: request.path,
    entries: page,
    coverage: more ? 'partial' : 'complete',
    omissionReasons: scanLimited ? ['scan-limit'] : [],
    ...(nextCursor === undefined ? {} : { nextCursor }),
  } as const;
  const validated = validateDirectoryPage(result, context.limits);
  if (!validated.ok) return failure('unavailable', 'unsupported-adapter');
  if (!commitOutputBytes(outputBytes, context.returnedBytes, context.limits, control)) return failure('exhausted', 'output-limit');
  if (nextCursor !== undefined) {
    context.cursors.set(nextCursor, {
      kind: 'directory',
      path: request.path,
      bindingDigest: admitted.bindingDigest,
      snapshotId: admitted.snapshot.snapshotId,
      manifestDigest: admitted.snapshot.manifestDigest,
      entries,
      offset,
      expiresAt: Date.now() + admitted.snapshot.admissionLimits.maxElapsedMs,
    });
  }
  return validated.value;
}

function matchesSnapshot(state: DirectoryCursor, admitted: AdmittedSnapshot): boolean {
  return state.bindingDigest === admitted.bindingDigest && state.snapshotId === admitted.snapshot.snapshotId && state.manifestDigest === admitted.snapshot.manifestDigest;
}
