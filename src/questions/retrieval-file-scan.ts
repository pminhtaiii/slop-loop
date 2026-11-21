/** Checks one bounded exact-file page without broadening scope to a parent directory. */
import { validateSpanResult } from '../contracts/questions/validation.ts';
import { computeFileDigest } from '../foundation/docker-workspace-policy.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import { sameIdentity } from './retrieval-admission.ts';
import type { QuestionAbsenceResult, QuestionRetrievalOptions } from './retrieval-types.ts';

type FilePageResult = { readonly status: 'ok'; readonly nextLine?: number } | Exclude<QuestionAbsenceResult, { readonly status: 'ok' }>;

export async function scanExactFilePage(options: QuestionRetrievalOptions, path: string, startLine: number, control: QuestionRepositoryOperationControl): Promise<FilePageResult> {
  const endLine = startLine + options.repositoryLimits.maxSpanLines - 1;
  if (!Number.isSafeInteger(endLine)) return { status: 'exhausted', reasonCode: 'scan-limit' };
  const parsed = validateSpanResult(await options.repository.readSpan({ path, startLine, endLine }, control), options.repositoryLimits);
  if (!parsed.ok) return { status: 'unavailable', reasonCode: 'store-unavailable' };
  const expected = options.snapshot.manifest.find(file => file.path === path)?.originalByteDigest;
  const result = parsed.value;
  if (result.status !== 'ok') {
    // A short final page already proves EOF. A full page needs one exact-file EOF read.
    if (result.status === 'invalid' && result.reasonCode === 'out-of-range' && (startLine > 1 || expected === computeFileDigest(''))) return { status: 'ok' };
    if (result.status === 'stale') return { status: 'stale', reasonCode: 'binding-mismatch' };
    if (result.status === 'cancelled') return { status: 'cancelled', reasonCode: 'cancelled' };
    return { status: 'insufficient', reasonCode: 'incomplete-coverage' };
  }
  const { span } = result;
  if (
    !sameIdentity(span.identity, options.identity) ||
    span.snapshotId !== options.snapshot.snapshotId ||
    span.manifestDigest !== options.snapshot.manifestDigest ||
    span.path !== path ||
    span.originalByteDigest !== expected ||
    span.range.startLine !== startLine ||
    span.range.endLine > endLine ||
    computeFileDigest(span.excerpt) !== span.excerptDigest
  )
    return { status: 'stale', reasonCode: 'binding-mismatch' };
  if (span.excerpt.includes(options.staticLookup ?? '')) return { status: 'insufficient', reasonCode: 'matches-found' };
  return span.truncation.kind === 'truncated' ? { status: 'ok', nextLine: span.truncation.nextLine } : span.range.endLine < endLine ? { status: 'ok' } : { status: 'ok', nextLine: endLine + 1 };
}
