import { Buffer } from 'node:buffer';
import type { DirectoryPageV1, QuestionIdentityV1, SearchPageV1, SpanResultV1 } from '../contracts/questions/contracts.ts';
import { isProtectedPath } from '../contracts/foundation/uc03.ts';
import { containsProtectedContent } from './docker-workspace-policy.ts';
import {
  validateQuestionIdentity,
  validateSpanResult,
} from '../contracts/questions/validation.ts';
import type { ExecutionGuardReadCapability, QuestionRepositoryOperationControl, QuestionRepositoryReadLimits } from './repository-types.ts';
import type { QuestionRepositoryBindingPort, TrustedQuestionRepositorySnapshotPort } from './repository-types.ts';
import {
  activeControl, createAdmittedSpan, decodeFile, failure, isFailure, isPositiveSafeInteger, lineArray,
  safeExceptionFailure, validateLimits, validPath, isRecord, type CursorState, type ReturnedByteCounter,
} from './question-repository-primitives.ts';
import { QuestionRepositorySnapshotReader } from './question-repository-snapshot.ts';
import { listDirectoryGuarded } from './question-repository-directory.ts';
import { searchLiteralGuarded } from './question-repository-search.ts';

export { computeSourceManifestDigest } from './question-repository-primitives.ts';

export interface QuestionRepositoryReaderOptions {
  readonly guardCapability: ExecutionGuardReadCapability;
  readonly identity: QuestionIdentityV1 | undefined;
  readonly limits: QuestionRepositoryReadLimits | undefined;
  readonly bindingPort: QuestionRepositoryBindingPort | undefined;
  readonly snapshotPort: TrustedQuestionRepositorySnapshotPort | undefined;
  readonly checkReadHold: () => void;
  readonly checkPathContainment: (path: string, control: QuestionRepositoryOperationControl) => Promise<{ readonly resolvedPath: string }>;
}

export class QuestionRepositoryReader {
  private readonly guardCapability: ExecutionGuardReadCapability;
  private readonly identity: QuestionIdentityV1 | undefined;
  private readonly limits: QuestionRepositoryReadLimits | undefined;
  private readonly checkReadHold: () => void;
  private readonly bindingPort: QuestionRepositoryBindingPort | undefined;
  private readonly snapshotPort: TrustedQuestionRepositorySnapshotPort | undefined;
  private readonly snapshotReader: QuestionRepositorySnapshotReader;
  private readonly cursors = new Map<string, CursorState>();
  private readonly returnedBytes: ReturnedByteCounter = { value: 0 };

  constructor(options: QuestionRepositoryReaderOptions) {
    this.guardCapability = options.guardCapability;
    const identity = validateQuestionIdentity(options.identity);
    this.identity = identity?.ok ? identity.value : undefined;
    this.limits = validateLimits(options.limits) ? Object.freeze({ ...options.limits }) : undefined;
    this.checkReadHold = options.checkReadHold;
    this.bindingPort = options.bindingPort;
    this.snapshotPort = options.snapshotPort;
    this.snapshotReader = new QuestionRepositorySnapshotReader({
      identity: this.identity,
      limits: this.limits,
      bindingPort: options.bindingPort,
      snapshotPort: options.snapshotPort,
      checkReadHold: this.checkReadHold,
      checkPathContainment: options.checkPathContainment,
    });
  }

  async listDirectory(
    request: { readonly path: string; readonly cursor?: string },
    control: QuestionRepositoryOperationControl,
  ): Promise<DirectoryPageV1> {
    const limits = this.limits;
    if (!this.isConfigured() || !limits) return failure('unavailable', 'unsupported-adapter');
    if (!request || typeof request !== 'object' || !validPath(request.path, limits) ||
      (request.cursor !== undefined && !this.cursorIsValid(request.cursor)) || !this.isControl(control)) {
      return failure('invalid', 'invalid-request');
    }
    if (isProtectedPath(request.path)) return failure('denied', 'protected');
    const safeRequest = Object.freeze({ path: request.path, ...(request.cursor === undefined ? {} : { cursor: request.cursor }) });
    const safeControl = Object.freeze({ signal: control.signal, deadlineEpochMs: control.deadlineEpochMs });
    return await this.mediate('list', safeRequest.path, undefined, safeControl, async () => await listDirectoryGuarded({
      limits, snapshotReader: this.snapshotReader, cursors: this.cursors, returnedBytes: this.returnedBytes,
    }, safeRequest, safeControl));
  }

  async readSpan(
    request: { readonly path: string; readonly startLine: number; readonly endLine: number },
    control: QuestionRepositoryOperationControl,
  ): Promise<SpanResultV1> {
    const limits = this.limits;
    if (!this.isConfigured() || !limits) return failure('unavailable', 'unsupported-adapter');
    if (!request || typeof request !== 'object' || !validPath(request.path, limits) ||
      !isPositiveSafeInteger(request.startLine) || !isPositiveSafeInteger(request.endLine) || request.startLine > request.endLine || !this.isControl(control)) {
      return failure('invalid', 'invalid-request');
    }
    if (isProtectedPath(request.path)) return failure('denied', 'protected');
    const safeRequest = Object.freeze({ path: request.path, startLine: request.startLine, endLine: request.endLine });
    const safeControl = Object.freeze({ signal: control.signal, deadlineEpochMs: control.deadlineEpochMs });
    return await this.mediate('read', safeRequest.path, undefined, safeControl, async () => await this.readSpanGuarded(safeRequest, safeControl));
  }

  async searchLiteral(
    request: { readonly query: string; readonly pathPrefix?: string; readonly cursor?: string },
    control: QuestionRepositoryOperationControl,
  ): Promise<SearchPageV1> {
    const limits = this.limits;
    if (!this.isConfigured() || !limits) return failure('unavailable', 'unsupported-adapter');
    if (!request || typeof request !== 'object' || typeof request.query !== 'string' || request.query.length === 0 ||
      request.query.includes('\n') || request.query.includes('\r') || request.query.includes('\u0000') ||
      Buffer.byteLength(request.query, 'utf8') > limits.maxQueryBytes ||
      (request.pathPrefix !== undefined && !validPath(request.pathPrefix, limits)) ||
      (request.cursor !== undefined && !this.cursorIsValid(request.cursor)) || !this.isControl(control)) {
      return failure('invalid', 'invalid-request');
    }
    if (request.pathPrefix !== undefined && isProtectedPath(request.pathPrefix)) return failure('denied', 'protected');
    const safeRequest = Object.freeze({
      query: request.query,
      ...(request.pathPrefix === undefined ? {} : { pathPrefix: request.pathPrefix }),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    });
    const safeControl = Object.freeze({ signal: control.signal, deadlineEpochMs: control.deadlineEpochMs });
    return await this.mediate('search', safeRequest.pathPrefix, safeRequest.query, safeControl, async () => await searchLiteralGuarded({
      identity: this.identity as QuestionIdentityV1,
      limits,
      snapshotReader: this.snapshotReader,
      cursors: this.cursors,
      returnedBytes: this.returnedBytes,
    }, safeRequest, safeControl));
  }

  private async mediate<T extends DirectoryPageV1 | SpanResultV1 | SearchPageV1>(
    kind: 'list' | 'read' | 'search',
    targetPath: string | undefined,
    query: string | undefined,
    control: QuestionRepositoryOperationControl,
    execute: () => Promise<T>,
  ): Promise<T> {
    const stopped = activeControl(control);
    if (stopped) return stopped as T;
    try {
      this.checkReadHold();
      return await this.guardCapability.mediateRead({ kind, targetPath, query, execute });
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('GUARD_DENIED')) return failure('denied', 'read-not-authorized') as T;
      return safeExceptionFailure(error) as T;
    }
  }

  private async readSpanGuarded(
    request: { readonly path: string; readonly startLine: number; readonly endLine: number },
    control: QuestionRepositoryOperationControl,
  ): Promise<SpanResultV1> {
    const bindingFailure = await this.snapshotReader.checkBinding(control);
    if (bindingFailure) return bindingFailure;
    const admitted = await this.snapshotReader.ensureSnapshot(control);
    if (isFailure(admitted)) return admitted;
    if (!admitted.manifestByPath.has(request.path)) return failure('denied', 'outside-scope');
    const source = await this.snapshotReader.readSnapshotFile(request.path, admitted, control);
    if (isFailure(source)) return source;
    const decoded = decodeFile(source.bytes);
    if (decoded === undefined) return failure('unavailable', 'binary');
    if (containsProtectedContent(decoded)) return failure('denied', 'protected');
    const lines = lineArray(decoded.replace(/\r\n/gu, '\n'));
    if (request.startLine > lines.length) return failure('invalid', 'out-of-range');
    const requestedEnd = Math.min(request.endLine, lines.length);
    const startIndex = request.startLine - 1;
    let endIndex = Math.min(requestedEnd - 1, startIndex + (this.limits?.maxSpanLines ?? 1) - 1);
    let excerpt = '';
    for (let candidate = startIndex; candidate <= endIndex; candidate += 1) {
      const line = lines[candidate];
      if (line === undefined) break;
      const next = excerpt.length === 0 ? line : excerpt + '\n' + line;
      if (Buffer.byteLength(next, 'utf8') > (this.limits?.maxSpanBytes ?? 0)) {
        if (candidate === startIndex) return failure('invalid', 'line-too-large');
        endIndex = candidate - 1;
        break;
      }
      excerpt = next;
    }
    if (excerpt.length === 0) return failure('invalid', 'out-of-range');
    const actualEnd = endIndex + 1;
    const truncated = actualEnd < requestedEnd;
    const span = createAdmittedSpan({
      identity: this.identity as QuestionIdentityV1,
      limits: this.limits as QuestionRepositoryReadLimits,
      admitted,
      counter: this.returnedBytes,
      path: request.path,
      lines,
      startLine: request.startLine,
      endLine: actualEnd,
      originalByteDigest: source.digest,
      truncated,
    });
    if (isFailure(span)) return span;
    const result = validateSpanResult({ status: 'ok', span }, this.limits as QuestionRepositoryReadLimits);
    if (!result.ok) return failure('unavailable', 'unsupported-adapter');
    const after = await this.snapshotReader.checkBinding(control);
    if (after) return after;
    return result.value;
  }

  private isConfigured(): boolean {
    return validateLimits(this.limits) && this.identity !== undefined &&
      typeof this.guardCapability?.mediateRead === 'function' &&
      typeof this.bindingPort?.checkBinding === 'function' &&
      typeof this.snapshotPort?.acquireSnapshot === 'function';
  }

  private isControl(value: unknown): value is QuestionRepositoryOperationControl {
    if (!isRecord(value)) return false;
    const signal = value['signal'];
    return isRecord(signal) && typeof signal['aborted'] === 'boolean' && typeof value['deadlineEpochMs'] === 'number' &&
      Number.isFinite(value['deadlineEpochMs']) && value['deadlineEpochMs'] > 0;
  }

  private cursorIsValid(value: unknown): value is string {
    return typeof value === 'string' && value.length >= 8 && value.length <= 512 && /^[A-Za-z0-9._~-]+$/u.test(value);
  }
}
