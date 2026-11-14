import { Buffer } from 'node:buffer';
import type { AdmittedSpanV1, QuestionIdentityV1, SearchHitV1, SearchPageV1 } from '../contracts/questions/contracts.ts';
import type { QuestionRepositoryOperationControl, QuestionRepositoryReadLimits } from './repository-types.ts';
import { validateSearchPage } from '../contracts/questions/validation.ts';
import { isProtectedPath } from '../contracts/foundation/uc03.ts';
import { containsProtectedContent } from './docker-workspace-policy.ts';
import {
  activeControl,
  addOmission,
  commitOutputBytes,
  createAdmittedSpan,
  createCursorId,
  decodeFile,
  failure,
  isFailure,
  lineArray,
  pathWithinPrefix,
  remainingOutputBytes,
  type AdmittedSnapshot,
  type CursorState,
  type ReturnedByteCounter,
  type SearchCursor,
  type SearchFileCursor,
} from './question-repository-primitives.ts';
import type { QuestionRepositorySnapshotReader } from './question-repository-snapshot.ts';

export interface SearchOperationContext {
  readonly identity: QuestionIdentityV1;
  readonly limits: QuestionRepositoryReadLimits;
  readonly snapshotReader: QuestionRepositorySnapshotReader;
  readonly cursors: Map<string, CursorState>;
  readonly returnedBytes: ReturnedByteCounter;
}

export async function searchLiteralGuarded(
  context: SearchOperationContext,
  request: { readonly query: string; readonly pathPrefix: string | undefined; readonly cursor: SearchCursor | undefined },
  control: QuestionRepositoryOperationControl,
): Promise<SearchPageV1> {
  const bindingFailure = await context.snapshotReader.checkBinding(control);
  if (bindingFailure) return bindingFailure;
  const admitted = await context.snapshotReader.ensureSnapshot(control);
  if (isFailure(admitted)) return admitted;
  const { pathPrefix: prefix, cursor } = request;
  if (cursor && !matchesSnapshot(cursor, admitted)) return failure('invalid', 'invalid-cursor');
  if (prefix !== undefined && !admitted.directoryChildren.has(prefix)) return failure('denied', 'outside-scope');
  const pathCheck = prefix === undefined ? undefined : await context.snapshotReader.checkDirectoryPath(prefix, control);
  if (pathCheck) return pathCheck;

  const hits: SearchHitV1[] = [];
  const omissions = cursor ? [...cursor.omissionReasons] : [];
  let fileState = cursor?.currentFile;
  let manifestIndex = cursor?.nextManifestIndex ?? firstManifestIndex(admitted, prefix);
  let outputBytes = 0;
  let stopped: ReturnType<typeof failure> | undefined;

  while (hits.length < context.limits.maxSearchHits) {
    const active = activeControl(control);
    if (active) {
      stopped = active;
      break;
    }
    if (fileState) {
      let lineIndex = fileState.nextLineIndex;
      while (lineIndex < fileState.lines.length && hits.length < context.limits.maxSearchHits) {
        const lineControl = activeControl(control);
        if (lineControl) {
          stopped = lineControl;
          break;
        }
        const line = fileState.lines[lineIndex];
        if (line === undefined) {
          lineIndex += 1;
          continue;
        }
        const columnIndex = line.indexOf(request.query);
        if (columnIndex >= 0) {
          const span = searchContextSpan(context, admitted, fileState, lineIndex);
          if (isFailure(span)) {
            if (span.status === 'invalid' && span.reasonCode === 'line-too-large') addOmission(omissions, 'line-too-large');
            else {
              stopped = span;
              break;
            }
          } else {
            const hit: SearchHitV1 = Object.freeze({ span, line: lineIndex + 1, column: columnIndex + 1, matchLength: request.query.length });
            const byteCost = Buffer.byteLength(span.excerpt, 'utf8') + Buffer.byteLength(span.path, 'utf8') + 64;
            if (outputBytes + byteCost > remainingOutputBytes(context.returnedBytes, context.limits, control)) {
              stopped = failure('exhausted', 'output-limit');
              break;
            }
            hits.push(hit);
            outputBytes += byteCost;
          }
        }
        lineIndex += 1;
      }
      if (stopped) {
        fileState = { ...fileState, nextLineIndex: lineIndex };
        break;
      }
      if (lineIndex < fileState.lines.length) {
        fileState = { ...fileState, nextLineIndex: lineIndex };
        break;
      }
      fileState = undefined;
      continue;
    }

    const path = admitted.pathIndex[manifestIndex];
    if (path === undefined || (prefix !== undefined && !pathWithinPrefix(path, prefix))) break;
    manifestIndex += 1;
    if (isProtectedPath(path)) {
      addOmission(omissions, 'protected');
      continue;
    }
    const loaded = await context.snapshotReader.readSnapshotFile(path, admitted, control);
    if (isFailure(loaded)) {
      if (
        loaded.status === 'exhausted' ||
        loaded.status === 'cancelled' ||
        loaded.status === 'stale' ||
        loaded.status === 'denied' ||
        (loaded.status === 'unavailable' && loaded.reasonCode === 'unsupported-adapter')
      ) {
        stopped = loaded;
        break;
      }
      if (loaded.reasonCode === 'oversized') addOmission(omissions, 'oversized');
      else addOmission(omissions, 'unreadable');
      continue;
    }
    const decoded = decodeFile(loaded.bytes);
    if (decoded === undefined) {
      addOmission(omissions, 'binary');
      continue;
    }
    if (containsProtectedContent(decoded)) {
      addOmission(omissions, 'protected');
      continue;
    }
    fileState = { path, digest: loaded.digest, lines: lineArray(decoded.replace(/\r\n/gu, '\n')), nextLineIndex: 0 };
  }

  if (stopped?.status === 'cancelled' || stopped?.status === 'stale' || stopped?.status === 'denied' || stopped?.status === 'unavailable' || stopped?.reasonCode === 'deadline') return stopped;
  if (stopped?.status === 'exhausted' && hits.length === 0) return stopped;
  if (stopped?.status === 'exhausted') addOmission(omissions, stopped.reasonCode === 'output-limit' ? 'output-limit' : 'scan-limit');

  const hasMore = fileState !== undefined || (admitted.pathIndex[manifestIndex] !== undefined && (prefix === undefined || pathWithinPrefix(admitted.pathIndex[manifestIndex] ?? '', prefix)));
  const after = await context.snapshotReader.checkBinding(control);
  if (after) return after;
  let nextCursor: string | undefined;
  if (hasMore && !stopped && !omissions.includes('scan-limit') && !omissions.includes('output-limit')) {
    if (context.cursors.size >= context.limits.maxCursors) {
      if (hits.length === 0) return failure('exhausted', 'output-limit');
      addOmission(omissions, 'output-limit');
    } else {
      nextCursor = createCursorId();
    }
  }
  const complete = !hasMore && omissions.length === 0;
  const result = {
    status: 'ok',
    hits,
    coverage: complete ? 'complete' : 'partial',
    omissionReasons: omissions,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  } as const;
  const validated = validateSearchPage(result, context.limits);
  if (!validated.ok) return failure('unavailable', 'unsupported-adapter');
  if (!commitOutputBytes(outputBytes, context.returnedBytes, context.limits, control)) return failure('exhausted', 'output-limit');
  if (nextCursor !== undefined) {
    context.cursors.set(nextCursor, {
      kind: 'search',
      query: request.query,
      pathPrefix: prefix,
      bindingDigest: admitted.bindingDigest,
      snapshotId: admitted.snapshot.snapshotId,
      manifestDigest: admitted.snapshot.manifestDigest,
      nextManifestIndex: manifestIndex,
      currentFile: fileState,
      omissionReasons: Object.freeze([...omissions]),
      expiresAt: Date.now() + admitted.snapshot.admissionLimits.maxElapsedMs,
    });
  }
  return validated.value;
}

function firstManifestIndex(admitted: AdmittedSnapshot, prefix: string | undefined): number {
  if (prefix === undefined || prefix === '.') return 0;
  const target = prefix + '/';
  let low = 0;
  let high = admitted.pathIndex.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((admitted.pathIndex[middle] ?? '') < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function matchesSnapshot(state: SearchCursor, admitted: AdmittedSnapshot): boolean {
  return state.bindingDigest === admitted.bindingDigest && state.snapshotId === admitted.snapshot.snapshotId && state.manifestDigest === admitted.snapshot.manifestDigest;
}

function searchContextSpan(context: SearchOperationContext, admitted: AdmittedSnapshot, file: SearchFileCursor, lineIndex: number): AdmittedSpanV1 | ReturnType<typeof failure> {
  const limits = context.limits;
  const targetLine = lineIndex + 1;
  const before = Math.min(limits.contextLinesBefore, targetLine - 1, Math.floor((limits.maxSpanLines - 1) / 2));
  const after = Math.min(limits.contextLinesAfter, file.lines.length - targetLine, limits.maxSpanLines - before - 1);
  let startLine = targetLine - before;
  let endLine = targetLine + after;
  const bytesFor = (start: number, end: number): number => Buffer.byteLength(file.lines.slice(start - 1, end).join('\n'), 'utf8');
  while (startLine < targetLine && bytesFor(startLine, endLine) > limits.maxSpanBytes) startLine += 1;
  while (endLine > targetLine && bytesFor(startLine, endLine) > limits.maxSpanBytes) endLine -= 1;
  if (bytesFor(startLine, endLine) > limits.maxSpanBytes) return failure('invalid', 'line-too-large');
  return createAdmittedSpan({
    identity: context.identity,
    limits,
    admitted,
    path: file.path,
    lines: file.lines,
    startLine,
    endLine,
    originalByteDigest: file.digest,
    truncated: false,
  });
}
