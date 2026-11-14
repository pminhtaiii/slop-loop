import { Buffer } from 'node:buffer';
import type { DirectoryEntryV1, DirectoryPageV1 } from '../contracts/questions/contracts.ts';
import type { QuestionRepositoryOperationControl, QuestionRepositoryReadLimits } from './repository-types.ts';
import { validateDirectoryPage } from '../contracts/questions/validation.ts';
import { activeControl, createCursorId, failure, isFailure, type AdmittedSnapshot, type CursorState, type DirectoryCursor, type ReturnedByteCounter } from './question-repository-primitives.ts';
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
  while (offset < entries.length && page.length < context.limits.maxPageEntries) {
    const entry = entries[offset];
    if (!entry) break;
    const size = Buffer.byteLength(entry.path, 'utf8') + 24;
    if (context.returnedBytes.value + outputBytes + size > context.limits.maxReturnedBytes) break;
    page.push(entry);
    outputBytes += size;
    offset += 1;
  }
  if (page.length === 0 && offset < entries.length) return failure('exhausted', 'output-limit');
  const more = offset < entries.length;
  let nextCursor: string | undefined;
  if (more) {
    if (context.cursors.size >= context.limits.maxCursors) return failure('exhausted', 'output-limit');
    const id = createCursorId();
    context.cursors.set(id, {
      kind: 'directory',
      path: request.path,
      bindingDigest: admitted.bindingDigest,
      snapshotId: admitted.snapshot.snapshotId,
      manifestDigest: admitted.snapshot.manifestDigest,
      entries,
      offset,
      expiresAt: Date.now() + admitted.snapshot.admissionLimits.maxElapsedMs,
    });
    nextCursor = id;
  }
  context.returnedBytes.value += outputBytes;
  const after = await context.snapshotReader.checkBinding(control);
  if (after) return after;
  const result = {
    status: 'ok',
    path: request.path,
    entries: page,
    coverage: more ? 'partial' : 'complete',
    omissionReasons: [],
    ...(nextCursor === undefined ? {} : { nextCursor }),
  } as const;
  const validated = validateDirectoryPage(result, context.limits);
  return validated.ok ? validated.value : failure('unavailable', 'unsupported-adapter');
}

function matchesSnapshot(state: DirectoryCursor, admitted: AdmittedSnapshot): boolean {
  return state.bindingDigest === admitted.bindingDigest && state.snapshotId === admitted.snapshot.snapshotId && state.manifestDigest === admitted.snapshot.manifestDigest;
}
