/**
 * Read-only adapter for question workflows. It exposes the guarded foundation
 * reader and the host's current-binding check without carrying repair tools.
 */
import type { DirectoryPageV1, RepositoryBindingV1, RepositoryToolFailureV1, SearchPageV1, SpanResultV1 } from '../contracts/questions/contracts.ts';
import { validateRepositoryBinding } from '../contracts/questions/validation.ts';
import type { QuestionRepositoryBindingPort, QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';

export interface QuestionRepositoryReadPort {
  listDirectory(request: { readonly path: string; readonly cursor?: string }, control: QuestionRepositoryOperationControl): Promise<DirectoryPageV1>;
  readSpan(request: { readonly path: string; readonly startLine: number; readonly endLine: number }, control: QuestionRepositoryOperationControl): Promise<SpanResultV1>;
  searchLiteral(request: { readonly query: string; readonly pathPrefix?: string; readonly cursor?: string }, control: QuestionRepositoryOperationControl): Promise<SearchPageV1>;
}

export type QuestionRepositoryBindingResultV1 = RepositoryToolFailureV1 | { readonly status: 'ok'; readonly binding: RepositoryBindingV1 };

/** The only repository operations available to a question workflow. */
export interface QuestionRepositoryPort {
  checkBinding(control: QuestionRepositoryOperationControl): Promise<QuestionRepositoryBindingResultV1>;
  listDirectory(request: { readonly path: string; readonly cursor?: string }, control: QuestionRepositoryOperationControl): Promise<DirectoryPageV1>;
  readSpan(request: { readonly path: string; readonly startLine: number; readonly endLine: number }, control: QuestionRepositoryOperationControl): Promise<SpanResultV1>;
  searchLiteral(request: { readonly query: string; readonly pathPrefix?: string; readonly cursor?: string }, control: QuestionRepositoryOperationControl): Promise<SearchPageV1>;
}

export interface CreateQuestionRepositoryPortOptions {
  readonly binding: RepositoryBindingV1;
  readonly reader: QuestionRepositoryReadPort;
  readonly bindingPort: QuestionRepositoryBindingPort;
}

/**
 * Captures a validated host binding and exposes only guarded read operations.
 * Cursor scope, root containment, path policy, and snapshot fencing remain in
 * the foundation reader; no workspace root or mutation/execution port is taken.
 */
export function createQuestionRepositoryPort(options: CreateQuestionRepositoryPortOptions): QuestionRepositoryPort {
  const checked = validateRepositoryBinding(options.binding);
  if (!checked.ok) throw new TypeError('Question repository binding is invalid');

  const expected = checked.value;
  const reader = options.reader;
  const bindingPort = options.bindingPort;
  const listDirectory: QuestionRepositoryPort['listDirectory'] = (request, control) => reader.listDirectory(request, control);
  const readSpan: QuestionRepositoryPort['readSpan'] = (request, control) => reader.readSpan(request, control);
  const searchLiteral: QuestionRepositoryPort['searchLiteral'] = (request, control) => reader.searchLiteral(request, control);

  async function checkBinding(control: QuestionRepositoryOperationControl): Promise<QuestionRepositoryBindingResultV1> {
    const stopped = activeFailure(control);
    if (stopped) return stopped;
    if (typeof bindingPort?.checkBinding !== 'function') return unavailable('unsupported-adapter');

    const safeControl = Object.freeze({ signal: control.signal, deadlineEpochMs: control.deadlineEpochMs });
    const work = control.work;
    if (work && typeof bindingPort.checkBindingBounded !== 'function') return unavailable('unsupported-adapter');
    if (work && (work.remaining('scannedFiles') <= 0 || work.remaining('scannedBytes') <= 0)) return Object.freeze({ status: 'exhausted', reasonCode: 'scan-limit' });
    let result: unknown;
    try {
      result = work ? await bindingPort.checkBindingBounded?.(expected, Object.freeze({ ...safeControl, work })) : await bindingPort.checkBinding(expected, safeControl);
    } catch {
      return unavailable('unreadable');
    }

    const stoppedAfterCheck = activeFailure(safeControl);
    if (stoppedAfterCheck) return stoppedAfterCheck;
    if (!isRecord(result) || typeof result['status'] !== 'string') return unavailable('unsupported-adapter');
    if (result['status'] === 'exhausted' && result['reasonCode'] === 'scan-limit') return Object.freeze({ status: 'exhausted', reasonCode: 'scan-limit' });
    if (result['status'] === 'stale') return staleBinding();
    if (result['status'] === 'denied') return deniedRead();
    if (result['status'] === 'unavailable') return unavailable('unsupported-adapter');
    if (result['status'] !== 'ok') return unavailable('unsupported-adapter');

    const current = validateRepositoryBinding(result['binding']);
    if (!current.ok) return unavailable('unsupported-adapter');
    if (!sameBinding(expected, current.value)) return staleBinding();
    return Object.freeze({ status: 'ok', binding: expected });
  }

  return Object.freeze({
    checkBinding,
    listDirectory,
    readSpan,
    searchLiteral,
  });
}

function activeFailure(control: unknown): RepositoryToolFailureV1 | undefined {
  if (!isRecord(control) || !isAbortSignal(control['signal']) || typeof control['deadlineEpochMs'] !== 'number' || !Number.isFinite(control['deadlineEpochMs']) || control['deadlineEpochMs'] <= 0) {
    return Object.freeze({ status: 'invalid', reasonCode: 'invalid-request' });
  }
  if (control['signal'].aborted) return Object.freeze({ status: 'cancelled', reasonCode: 'cancelled' });
  if (Date.now() >= control['deadlineEpochMs']) return Object.freeze({ status: 'exhausted', reasonCode: 'deadline' });
  return undefined;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'aborted' in value && typeof value.aborted === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameBinding(left: RepositoryBindingV1, right: RepositoryBindingV1): boolean {
  return left.repositoryId === right.repositoryId && left.workspaceId === right.workspaceId && left.revisionDigest === right.revisionDigest && left.policyDigest === right.policyDigest;
}

function deniedRead(): RepositoryToolFailureV1 {
  return Object.freeze({ status: 'denied', reasonCode: 'read-not-authorized' });
}

function staleBinding(): RepositoryToolFailureV1 {
  return Object.freeze({ status: 'stale', reasonCode: 'binding-mismatch' });
}

function unavailable(reasonCode: 'unreadable' | 'unsupported-adapter'): RepositoryToolFailureV1 {
  return Object.freeze({ status: 'unavailable', reasonCode });
}
