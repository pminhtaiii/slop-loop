import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type {
  AdmittedSpanV1,
  DirectoryEntryV1,
  QuestionIdentityV1,
  RepositoryBindingV1,
  RepositoryOmissionReasonV1,
  SourceManifestEntryV1,
  SourceSnapshotV1,
} from '../contracts/questions/contracts.ts';
import { computeCanonicalSha256, isCanonicalRelativePath } from '../contracts/foundation/uc03.ts';
import { validateAdmittedSpan } from '../contracts/questions/validation.ts';
import { computeFileDigest } from './docker-workspace-policy.ts';
import type { QuestionRepositoryOperationControl, QuestionRepositoryReadLimits, TrustedQuestionRepositorySnapshotLease } from './repository-types.ts';

export type ToolFailure =
  | { readonly status: 'denied'; readonly reasonCode: 'protected' | 'outside-scope' | 'read-not-authorized' }
  | { readonly status: 'stale'; readonly reasonCode: 'binding-mismatch' | 'source-mismatch' }
  | { readonly status: 'invalid'; readonly reasonCode: 'invalid-request' | 'invalid-cursor' | 'out-of-range' | 'line-too-large' }
  | { readonly status: 'unavailable'; readonly reasonCode: 'unreadable' | 'binary' | 'oversized' | 'unsupported-adapter' }
  | { readonly status: 'exhausted'; readonly reasonCode: 'scan-limit' | 'output-limit' | 'deadline' }
  | { readonly status: 'cancelled'; readonly reasonCode: 'cancelled' };

export interface SnapshotFileRead {
  readonly status: 'ok';
  readonly bytes: Uint8Array;
  readonly scannedBytes: number;
}

export interface SnapshotFileReadFailure {
  readonly status: 'unreadable' | 'oversized';
  readonly scannedBytes: number;
}

export interface AdmittedSnapshot {
  readonly snapshot: SourceSnapshotV1;
  readonly readFile: TrustedQuestionRepositorySnapshotLease['readFile'];
  readonly manifestByPath: ReadonlyMap<string, SourceManifestEntryV1>;
  readonly pathIndex: readonly string[];
  readonly directoryChildren: ReadonlyMap<string, readonly DirectoryEntryV1[]>;
  readonly bindingDigest: string;
}

export interface DirectoryCursor {
  readonly kind: 'directory';
  readonly path: string;
  readonly bindingDigest: string;
  readonly snapshotId: string;
  readonly manifestDigest: string;
  readonly entries: readonly DirectoryEntryV1[];
  readonly offset: number;
  readonly expiresAt: number;
}

export interface SearchFileCursor {
  readonly path: string;
  readonly digest: string;
  readonly lines: readonly string[];
  readonly nextLineIndex: number;
}

export interface SearchCursor {
  readonly kind: 'search';
  readonly query: string;
  readonly pathPrefix: string | undefined;
  readonly bindingDigest: string;
  readonly snapshotId: string;
  readonly manifestDigest: string;
  readonly nextManifestIndex: number;
  readonly currentFile: SearchFileCursor | undefined;
  readonly omissionReasons: readonly RepositoryOmissionReasonV1[];
  readonly expiresAt: number;
}

export type CursorState = DirectoryCursor | SearchCursor;
export interface ReturnedByteCounter {
  value: number;
}

const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function validateLimits(input: QuestionRepositoryReadLimits | undefined): input is QuestionRepositoryReadLimits {
  if (!input || typeof input !== 'object') return false;
  const positive = [
    input.maxFileBytes,
    input.maxSpanBytes,
    input.maxSpanLines,
    input.maxPageEntries,
    input.maxSearchHits,
    input.maxQueryBytes,
    input.maxPathBytes,
    input.maxScannedFiles,
    input.maxScannedBytes,
    input.maxReturnedBytes,
    input.maxCursors,
  ];
  return (
    positive.every(isPositiveSafeInteger) && input.maxFileBytes < Number.MAX_SAFE_INTEGER && isNonNegativeSafeInteger(input.contextLinesBefore) && isNonNegativeSafeInteger(input.contextLinesAfter)
  );
}

export function sameBinding(left: RepositoryBindingV1, right: RepositoryBindingV1): boolean {
  return left.repositoryId === right.repositoryId && left.workspaceId === right.workspaceId && left.revisionDigest === right.revisionDigest && left.policyDigest === right.policyDigest;
}

export function canonicalManifest(manifest: readonly SourceManifestEntryV1[]): string {
  return computeCanonicalSha256(manifest.map(entry => [entry.path, entry.originalByteDigest]));
}

export function computeSourceManifestDigest(manifest: readonly SourceManifestEntryV1[]): string {
  return canonicalManifest(manifest);
}

export function failure(status: ToolFailure['status'], reasonCode: ToolFailure['reasonCode']): ToolFailure {
  return { status, reasonCode } as ToolFailure;
}

export function safeExceptionFailure(error: unknown): ToolFailure {
  if (error instanceof Error) {
    const code = error.message.split(':', 1)[0];
    if (code === 'PROTECTED_PATH_FORBIDDEN' || code === 'FORBIDDEN_LINK_TARGET' || code === 'PROTECTED_PATH') return failure('denied', 'protected');
    if (code === 'WORKSPACE_ESCAPE' || code === 'INVALID_PATH') return failure('denied', 'outside-scope');
    if (code === 'TASK_CONTROL_REQUIRED' || code === 'INVALID_TASK_CONTROL_SNAPSHOT' || code === 'TASK_PAUSED_OR_HELD' || code === 'CLAIM_OPEN_READ_DENIED')
      return failure('denied', 'read-not-authorized');
    if (code === 'FILE_TOO_LARGE') return failure('unavailable', 'oversized');
    if (code === 'ABORT_ERR' || code === 'CANCELLED') return failure('cancelled', 'cancelled');
    if (code === 'DEADLINE_EXCEEDED') return failure('exhausted', 'deadline');
  }
  return failure('unavailable', 'unreadable');
}

export function activeControl(control: QuestionRepositoryOperationControl): ToolFailure | undefined {
  if (control.signal.aborted) return failure('cancelled', 'cancelled');
  if (Date.now() >= control.deadlineEpochMs) return failure('exhausted', 'deadline');
  return undefined;
}

export function validPath(path: unknown, limits: QuestionRepositoryReadLimits): path is string {
  return typeof path === 'string' && (path === '.' || isCanonicalRelativePath(path)) && Buffer.byteLength(path, 'utf8') <= limits.maxPathBytes;
}

export function validReadFileResult(input: unknown): input is SnapshotFileRead | SnapshotFileReadFailure {
  if (!isRecord(input)) return false;
  const { status, scannedBytes } = input;
  if (!isNonNegativeSafeInteger(scannedBytes)) return false;
  if (status === 'ok') return input['bytes'] instanceof Uint8Array && input['bytes'].byteLength === scannedBytes;
  return status === 'unreadable' || status === 'oversized';
}

export function decodeFile(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return textDecoder.decode(bytes);
  } catch {
    return undefined;
  }
}

export function lineArray(normalized: string): string[] {
  if (normalized.length === 0) return [];
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) lines.pop();
  return lines;
}

export function addOmission(reasons: RepositoryOmissionReasonV1[], reason: RepositoryOmissionReasonV1): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

export function pathWithinPrefix(path: string, prefix: string | undefined): boolean {
  if (prefix === undefined || prefix === '.') return true;
  return path.startsWith(`${prefix}/`);
}

export function createCursorId(): string {
  return `cursor-${randomUUID()}`;
}

export function cursorIsValid(input: unknown): input is string {
  return typeof input === 'string' && input.length >= 8 && input.length <= 512 && /^[A-Za-z0-9._~-]+$/u.test(input);
}

export function isFailure(value: unknown): value is ToolFailure {
  return isRecord(value) && typeof value['status'] === 'string' && value['status'] !== 'ok';
}

export function createAdmittedSpan(input: {
  readonly identity: QuestionIdentityV1;
  readonly limits: QuestionRepositoryReadLimits;
  readonly admitted: AdmittedSnapshot;
  readonly counter: ReturnedByteCounter;
  readonly path: string;
  readonly lines: readonly string[];
  readonly startLine: number;
  readonly endLine: number;
  readonly originalByteDigest: string;
  readonly truncated: boolean;
  readonly countOutput?: boolean;
}): AdmittedSpanV1 | ToolFailure {
  const excerpt = input.lines.slice(input.startLine - 1, input.endLine).join('\n');
  const outputCost = Buffer.byteLength(excerpt, 'utf8') + Buffer.byteLength(input.path, 'utf8') + 128;
  if (input.counter.value + outputCost > input.limits.maxReturnedBytes) return failure('exhausted', 'output-limit');
  const raw = {
    identity: input.identity,
    evidenceId: `evidence-${randomUUID()}`,
    snapshotId: input.admitted.snapshot.snapshotId,
    manifestDigest: input.admitted.snapshot.manifestDigest,
    path: input.path,
    range: { startLine: input.startLine, endLine: input.endLine },
    excerpt,
    excerptDigest: computeFileDigest(Buffer.from(excerpt, 'utf8')),
    originalByteDigest: input.originalByteDigest,
    truncation: input.truncated ? { kind: 'truncated' as const, nextLine: input.endLine + 1 } : { kind: 'none' as const },
  };
  const validated = validateAdmittedSpan(raw, input.limits);
  if (!validated.ok) return failure('unavailable', 'unsupported-adapter');
  if (input.countOutput !== false) input.counter.value += outputCost;
  return validated.value;
}
